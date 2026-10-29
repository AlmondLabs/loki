import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DeskSummary, InboxRow, LanStatus, TailnetDevice } from "../core/frame-types.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { memoryRepos } from "../daemon/memory-sync.ts";
import { PAIRING_TTL_MS } from "../mod/pairing.ts";
import { startPeering, type PeerListener, type PeeringDeps } from "../mod/peering.ts";
import { SeenStore } from "../mod/seen.ts";

/** A Mac with nothing paired yet: its listener and its pushes recorded, the tailnet as given. */
function mac(opts: { tailnet?: TailnetDevice[]; desks?: DeskSummary[]; inbox?: InboxRow[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-peering-"));
  const pushed: object[] = [];
  const needed: boolean[] = [];
  const status = { port: 41415, tailscale: { running: true, name: "book.tail1234.ts.net" } } as LanStatus;
  const listener: PeerListener = {
    status: () => status,
    refresh: () => Promise.resolve(status),
    setPeersNeeded: (on) => Promise.resolve(needed.push(on)),
    closePeer: () => 0,
  };
  const peering = startPeering({
    macId: "aaaaaaaa-1111-4111-8111-111111111111",
    build: null,
    secrets: memorySecrets(),
    memory: memoryRepos,
    chats: { list: () => [] },
    // Nothing here moves a chat or hears another Mac's agents: no Mac is paired.
    chat: {} as PeeringDeps["chat"],
    seen: new SeenStore(join(dir, "attention.json")),
    desks: { forgetConversations: () => 0 },
    sockets: {
      push: (msg, o) => pushed.push({ ...msg, to: o?.to ?? "everyone" }),
      phoneListener: () => listener,
    },
    tailscale: { devices: () => opts.tailnet ?? [] },
    broadcast: (msg) => pushed.push({ ...msg, to: "everyone" }),
    local: { desks: () => opts.desks ?? [], inbox: () => opts.inbox ?? [] },
    dirs: { peers: join(dir, "peers.json"), state: dir, data: dir, widgets: join(dir, "widgets"), uploads: join(dir, "uploads") },
    moveTasks: () => Promise.resolve(),
  });
  return { peering, pushed, needed, done: () => (peering.stop(), rmSync(dir, { recursive: true, force: true })) };
}

afterEach(() => void vi.useRealTimers());

describe("the paired Macs, as the mod uses them (plan 052)", () => {
  test("a pairing code keeps the listener up for the Macs until it lapses, and shows this Mac's tailnet address", async () => {
    vi.useFakeTimers();
    const m = mac();
    try {
      m.peering.start();
      expect(m.needed).toEqual([]); // nothing paired: the listener need not stay up
      const code = await m.peering.frames.begin();
      expect(code.host).toBe("book.tail1234.ts.net:41415");
      expect(m.needed).toEqual([true]);
      vi.advanceTimersByTime(PAIRING_TTL_MS + 1000);
      expect(m.needed).toEqual([true, false]);
    } finally {
      m.done();
    }
  });

  test("Settings › Macs lists the tailnet's computers only, none paired", () => {
    const device = (name: string, os: string): TailnetDevice => ({ name, address: `${name}.tail1234.ts.net`, os, online: true });
    const m = mac({ tailnet: [device("mini", "macOS"), device("phone", "iOS"), device("box", "linux")] });
    try {
      const view = m.peering.frames.view();
      expect((view.tailnet ?? []).map((d) => [d.name, d.paired])).toEqual([
        ["mini", false],
        ["box", false],
      ]);
      expect(view.peers).toEqual([]);
    } finally {
      m.done();
    }
  });

  test("a push of the person's state tells the paired Macs once, naming Learn only when its cards changed", () => {
    vi.useFakeTimers();
    const m = mac();
    try {
      m.peering.pushed("seen");
      m.peering.pushed("recall_changed");
      m.peering.pushed("lists_changed"); // not the person's state
      vi.advanceTimersByTime(1000);
      expect(m.pushed).toEqual([{ type: "state_changed", folders: ["learn"], to: "macs" }]);
    } finally {
      m.done();
    }
  });

  test("with no Mac paired the lists are this Mac's, the inbox newest first, and nothing blocks a delete", () => {
    const row = (id: string, at: string) => ({ id, last_message_at: at }) as InboxRow;
    const m = mac({ inbox: [row("old", "2026-10-01T00:00:00Z"), row("new", "2026-10-28T00:00:00Z")] });
    try {
      expect(m.peering.inbox().map((r) => r.id)).toEqual(["new", "old"]);
      expect(m.peering.desks()).toEqual([]);
      expect(m.peering.agentDeleteBlocked("ada")).toBeNull();
    } finally {
      m.done();
    }
  });
});
