import { describe, expect, test, vi } from "vitest";
import { SHARED_SCOPE } from "../core/desk-core.ts";
import type { DeskSummary, InboxRow } from "../core/frame-types.ts";
import { RemoteChats, peerChatsReply } from "../mod/remote-chats.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

const desk = (conversationId: string, title: string, agentId = "agent-ira"): DeskSummary => ({
  scope: conversationId,
  title,
  status: "live",
  agent_name: "Ira",
  agent_id: agentId,
  model: null,
  reasoning_effort: null,
  conversation_id: conversationId,
  widgets: 0,
  active: true,
  last_active: "2026-10-18T10:00:00Z",
});

const row = (id: string): InboxRow => ({
  id,
  agent_id: "agent-ira",
  agent_name: "Ira",
  title: "plan the week",
  last_message_at: "2026-10-18T10:00:00Z",
  archived: false,
  last_role: "assistant",
  last_assistant_text: "done",
  last_ask: null,
});

function fixture() {
  const state = {
    lists: { desks: [desk("conv-1", "plan the week"), desk(SHARED_SCOPE, "shared")], inbox: [row("conv-1")] },
    reachable: true,
    changes: 0,
    listed: [] as string[][],
  };
  const link = {
    request: () => (state.reachable ? Promise.resolve({ type: "peer_chats", ...state.lists }) : Promise.reject(new Error("that Mac is out of reach"))),
  };
  const remote = new RemoteChats({
    link: (id) => (id === MINI ? (link as never) : null),
    name: () => "Mac mini",
    onChange: () => state.changes++,
    onListed: (_mac, scopes) => state.listed.push(scopes),
    debounceMs: 5,
  });
  return { state, remote };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("another Mac's chats in this Mac's lists", () => {
  test("a reachable Mac's chats are listed with its name, its shared canvas left out", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    expect(remote.desks()).toEqual([{ ...desk("conv-1", "plan the week"), active: false, home: MINI, home_name: "Mac mini", reachable: true }]);
    expect(remote.inbox()).toEqual([{ ...row("conv-1"), home: MINI, home_name: "Mac mini", reachable: true }]);
    expect(state.changes).toBe(1);
  });

  test("a paired Mac's rows keep each chat's purpose, draft mark and folder (plan 049, U1)", async () => {
    const { remote, state } = fixture();
    const more = { purpose: "the website", has_draft: true, cwd: "/work/site" };
    state.lists = { desks: [{ ...desk("conv-1", "plan the week"), ...more }], inbox: [{ ...row("conv-1"), ...more }] };
    await remote.refresh(MINI);
    expect(remote.desks()[0]).toMatchObject(more);
    expect(remote.inbox()[0]).toMatchObject(more);
  });

  test("rows that are not objects, from a Mac on another version, are left out rather than thrown on", async () => {
    const { remote, state } = fixture();
    state.lists = { desks: [null, desk("conv-1", "plan the week"), 7] as never, inbox: [null, row("conv-1")] as never };
    await remote.refresh(MINI);
    expect(remote.desks().map((d) => d.scope)).toEqual(["conv-1"]);
    expect(remote.inbox().map((r) => r.id)).toEqual(["conv-1"]);
  });

  test("a Mac going out of reach keeps its chats, marked waiting, and its return brings them back", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    remote.setReachable(MINI, false);
    expect(remote.desks().map((d) => d.reachable)).toEqual([false]);
    state.lists.desks = [desk("conv-1", "plan the month")];
    remote.setReachable(MINI, true);
    await until(() => remote.desks()[0]?.reachable === true);
    expect(remote.desks()[0].title).toBe("plan the month");
  });

  test("a failed fetch marks the Mac out of reach", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    state.reachable = false;
    await remote.refresh(MINI);
    expect(remote.desks().map((d) => d.reachable)).toEqual([false]);
  });

  test("a failed fetch over a link that is still up keeps the chats in reach and tries again until it answers", async () => {
    const { remote, state } = fixture();
    const link = {
      status: "reachable",
      fails: 2,
      request: () =>
        link.fails-- > 0 ? Promise.reject(new Error("that Mac did not answer in time")) : Promise.resolve({ type: "peer_chats", ...state.lists }),
    };
    const retrying = new RemoteChats({ link: () => link as never, name: () => "Mac mini", onChange: () => state.changes++, debounceMs: 5, retryMs: 5 });
    try {
      retrying.setReachable(MINI, true);
      await until(() => retrying.desks().length === 1);
      expect(retrying.desks()[0].reachable).toBe(true);
      link.fails = 1;
      state.lists.desks = [desk("conv-1", "plan the month")];
      await retrying.refresh(MINI);
      expect(retrying.desks().map((d) => [d.title, d.reachable])).toEqual([["plan the week", true]]);
      await until(() => retrying.desks()[0]?.title === "plan the month");
    } finally {
      retrying.stop();
      remote.stop();
    }
  });

  test("a fetch that keeps failing over a link still up waits 1 s, doubling to 30 s, and stops when the Mac goes", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const link = {
        status: "reachable",
        request: () => {
          calls++;
          return Promise.reject(new Error("that Mac did not answer in time"));
        },
      };
      const remote = new RemoteChats({ link: () => link as never, name: () => "Mac mini", onChange: () => {} });
      remote.setReachable(MINI, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      for (const wait of [1000, 2000, 4000, 8000, 16000, 30_000, 30_000]) {
        const before = calls;
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(calls).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toBe(before + 1);
      }
      for (const going of [() => remote.setReachable(MINI, false), () => remote.sync([]), () => remote.stop()]) {
        remote.setReachable(MINI, true);
        await vi.advanceTimersByTimeAsync(0);
        const before = calls;
        going();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls).toBe(before);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("a list listener that throws during a fetch a returning Mac started leaves no unhandled rejection, and the fetch runs again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const escaped: unknown[] = [];
    const record = (error: unknown) => void escaped.push(error);
    process.on("unhandledRejection", record);
    let changes = 0;
    const link = { status: "reachable", request: () => Promise.resolve({ type: "peer_chats", desks: [desk("conv-1", "plan the week")], inbox: [] }) };
    const remote = new RemoteChats({
      link: () => link as never,
      name: () => "Mac mini",
      onChange: () => {
        if (++changes === 1) throw new Error("the list listener broke");
      },
      retryMs: 50,
    });
    try {
      remote.setReachable(MINI, true);
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(escaped).toEqual([]);
      await vi.advanceTimersByTimeAsync(50);
      expect(changes).toBe(2);
      expect(remote.desks().map((d) => d.title)).toEqual(["plan the week"]);
    } finally {
      remote.stop();
      process.off("unhandledRejection", record);
      vi.useRealTimers();
    }
  });

  test("a list listener that throws on every fetch is retried with a growing wait, not every second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fetches = 0;
    const link = {
      status: "reachable",
      request: () => {
        fetches++;
        return Promise.resolve({ type: "peer_chats", desks: [], inbox: [] });
      },
    };
    const remote = new RemoteChats({
      link: () => link as never,
      name: () => "Mac mini",
      onChange: () => {
        throw new Error("the list listener broke");
      },
      retryMs: 50,
    });
    try {
      remote.setReachable(MINI, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetches).toBe(1);
      for (const wait of [50, 100, 200]) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(fetches).toBe(wait === 50 ? 1 : wait === 100 ? 2 : 3);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(fetches).toBe(4);
    } finally {
      remote.stop();
      vi.useRealTimers();
    }
  });

  test("unpairing a Mac takes its chats off every list", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    const before = state.changes;
    remote.sync([]);
    expect(remote.desks()).toEqual([]);
    expect(remote.inbox()).toEqual([]);
    expect(state.changes).toBe(before + 1);
  });

  test("a push that may change the Mac's chats fetches them again; one that cannot, does not", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    state.lists.desks = [desk("conv-1", "renamed")];
    remote.heard(MINI, { type: "peers" });
    remote.heard(MINI, { type: "chat_event", events: [{ kind: "step", step: { kind: "assistant", text: "hel" } }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(remote.desks()[0].title).toBe("plan the week");
    remote.heard(MINI, { type: "chat_event", events: [{ kind: "turn_end" }] });
    await until(() => remote.desks()[0]?.title === "renamed");
  });

  test("each fetch hands the chat directory the chats that Mac holds, its shared canvas left out", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    expect(state.listed).toEqual([["conv-1"]]);
  });

  test("a desk whose chat is gone on that Mac is not listed, and frames for that chat stay here", async () => {
    const { remote, state } = fixture();
    state.lists = { desks: [desk("conv-1", "plan the week"), { ...desk("default", "Ira · main chat"), status: "deleted" }], inbox: [] };
    await remote.refresh(MINI);
    expect(remote.desks().map((d) => d.conversation_id)).toEqual(["conv-1"]);
    expect(state.listed).toEqual([["conv-1"]]);
  });

  test("an agent's chats on a Mac out of reach block its delete; a Mac out of reach without them does not", async () => {
    const { remote, state } = fixture();
    await remote.refresh(MINI);
    expect(remote.awayWith("agent-ira")).toBeNull();
    remote.setReachable(MINI, false);
    expect(remote.awayWith("agent-ira")).toBe(MINI);
    expect(remote.awayWith("agent-friday")).toBeNull();
    expect(state.changes).toBeGreaterThan(0);
  });
});

describe("outside cards between Macs (plan 067, R14)", () => {
  const thread: InboxRow = { ...row("t1#1"), kind: "outside", agent_id: "account:gmail:ada@acme.com", last_role: null, last_assistant_text: null };

  test("a Mac's outside cards travel apart from its chats and show on the paired Mac, marked with their home", async () => {
    const { remote, state } = fixture();
    state.lists = { ...peerChatsReply([], [row("conv-1"), thread]) };
    await remote.refresh(MINI);
    expect(remote.inbox().map((r) => [r.id, r.home])).toEqual([
      ["conv-1", MINI],
      ["t1#1", MINI],
    ]);
  });

  test("a Mac that reads only the chats, as a loki from before outside cards does, is sent none of them", () => {
    const reply = peerChatsReply([], [row("conv-1"), thread]);
    expect(reply.inbox.map((r) => r.id)).toEqual(["conv-1"]);
    expect(reply.outside.map((r) => r.id)).toEqual(["t1#1"]);
  });
});
