/**
 * An agent's memory on two paired Macs over a real peer link (plan 023, U7): `npm run test:node`. The far Mac answers
 * `peer_memory_get` from its repo; the near Mac clones it on first contact and pulls again when told it moved.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySecrets } from "../daemon/credentials.ts";
import { memoryHead } from "../daemon/memory-sync.ts";
import { createBridge } from "../mod/bridge.ts";
import { DeviceStore } from "../mod/devices.ts";
import { peersFrames } from "../mod/frames/peers.ts";
import { LanListener } from "../mod/lan.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PeerMemory } from "../mod/peer-memory.ts";
import { PeerLink } from "../mod/peer-link.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, mintPeerToken } from "../mod/peers.ts";

const FAR = "eeeeeeee-5555-4555-8555-555555555555";
const NEAR = "ffffffff-6666-4666-8666-666666666666";
const FRIDAY = "agent-local-22222222-2222-4222-8222-222222222222";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A note written into an agent's memory and committed, as a memory tool does. */
function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Friday", "-c", "user.email=f@loki.local", ...args]);
  git("add", "--", path);
  git("commit", "--quiet", "-m", `write ${path}`);
}

void test("a Mac without an agent's memory clones it, and a commit on the far Mac follows when it says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "loki-peer-memory-"));
  const farMemory = join(root, "far", "memfs", FRIDAY, "memory");
  const nearBackend = join(root, "near");
  mkdirSync(farMemory, { recursive: true });
  execFileSync("git", ["-C", farMemory, "init", "--quiet"]);
  write(farMemory, "system/persona.md", "I am Friday.\n");
  const port = await freePort();
  const token = mintPeerToken();
  const store = new PeerStore(join(root, "peers.json"));
  store.add({ mac_id: NEAR, name: "near", host: "near:41415", build: null, protocol: PEER_PROTOCOL }, token);
  const farSide = new PeerMemory({ backendDir: () => join(root, "far"), macId: FAR, link: () => null, homeOf: () => FAR, tell: () => {}, onCloned: () => {} });
  const peers = new Peers({
    store,
    keys: new PeerKeys(memorySecrets()),
    codes: new PairingCodes(),
    me: () => ({ mac_id: FAR, name: "far", host: `127.0.0.1:${port}`, build: null, protocol: PEER_PROTOCOL }),
  });
  let lan: LanListener | null = null;
  const bridge = createBridge({
    modules: [
      peersFrames({
        peers: {
          view: () => ({ me: { mac_id: FAR, name: "far", host: null }, peers: [] }),
          begin: () => ({ code: "x", host: null, expires_at: "" }),
          join: () => Promise.reject(new Error("no")),
          forget: () => Promise.resolve(false),
          hello: () => peers.hello(),
          agents: () => ({ agents: [], tombstones: [] }),
          chats: () => ({ desks: [], inbox: [] }),
          memory: (agentId, have) => farSide.bundle(agentId, have).then((bundle) => ({ agent_id: agentId, bundle })),
        },
      }),
    ],
    broadcast: (msg) => lan?.broadcast(msg),
  });
  lan = new LanListener({
    port,
    stateFile: join(root, "lan.json"),
    devices: new DeviceStore(join(root, "devices.json")),
    codes: new PairingCodes(),
    handlers: bridge,
    appDist: null,
    peers,
    via: () => "tailscale",
  });
  await lan.setPeersNeeded(true);
  const cloned: string[] = [];
  const holder: { memory: PeerMemory | null } = { memory: null };
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => Promise.resolve(token),
    protocol: PEER_PROTOCOL,
    onPush: (f) => {
      if (f.type === "memory_changed" && typeof f.agent_id === "string") void holder.memory?.pull(FAR, f.agent_id);
    },
    minBackoffMs: 20,
  });
  const near = new PeerMemory({
    backendDir: () => nearBackend,
    macId: NEAR,
    link: () => link,
    homeOf: () => FAR,
    tell: () => {},
    onCloned: (id) => cloned.push(id),
  });
  holder.memory = near;
  try {
    link.start();
    await until(() => link.status === "reachable");
    assert.equal(await near.pull(FAR, FRIDAY), "cloned");
    assert.deepEqual(cloned, [FRIDAY]);
    const nearMemory = join(nearBackend, "memfs", FRIDAY, "memory");
    assert.equal(readFileSync(join(nearMemory, "system", "persona.md"), "utf8"), "I am Friday.\n");
    write(farMemory, "notes/today.md", "met Ira\n");
    lan.broadcast({ type: "memory_changed", agent_id: FRIDAY });
    await until(() => existsSync(join(nearMemory, "notes", "today.md")));
    const [a, b] = await Promise.all([memoryHead(nearMemory), memoryHead(farMemory)]);
    assert.equal(a, b);
  } finally {
    link.stop();
    await lan.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
