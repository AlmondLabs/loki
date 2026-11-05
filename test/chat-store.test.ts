import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatClient } from "../core/attention/chat-client.ts";
import { ChatStore, type ChatStoreHost } from "../core/attention/chat-store.ts";
import type { ChatEvent, ConversationInfo, Digest } from "../core/attention/model.ts";
import type { Runtime } from "../core/attention/protocol.ts";
import type { ChatEngineView } from "../core/models.ts";
import { call, piece } from "./fixtures/chat-events.ts";

const ADA: Runtime = { agent_id: "ada", conversation_id: "c1" };
const ENGINE: ChatEngineView = { agent: "claude", name: "Claude Code", model: "sonnet", modes: [], commands: [] };

const row = (id: string, at: string): ConversationInfo & Digest => ({
  id,
  agent_id: "ada",
  agent_name: "Ada",
  title: id,
  last_message_at: at,
  archived: false,
  last_role: "assistant",
  last_assistant_text: "",
  last_ask: null,
});

/** The daemon as the store meets it: what was sent and started recorded, events pushed by the test, answers as set. */
function daemon(rows: Array<ConversationInfo & Digest> = [row("c1", "2026-10-29T10:00:00Z")]) {
  let hear: (rt: Runtime, events: ChatEvent[]) => void = () => {};
  const sent: string[] = [];
  const started: string[] = [];
  const answers = { approval: true };
  const updates: Array<[string, Record<string, unknown>, string | undefined]> = [];
  const outside: Array<[string, string, string | null]> = [];
  const refuse = { outside: null as string | null };
  const handoffs: Array<[string, string, string | null, string | null]> = [];
  const moves: unknown[] = [];
  const replies: Array<[string, string, string, string, string | null]> = [];
  /** How the daemon answers a reply: refused before it was sent, or sent with the move's reason. */
  const replyAnswer = { refused: null as string | null, thenError: null as string | null };
  const client = {
    replyOutside: (accountId: string, threadId: string, text: string, then: string, home: string | null) => {
      if (replyAnswer.refused) return Promise.reject(new Error(replyAnswer.refused));
      replies.push([accountId, threadId, text, then, home]);
      const ended = then === "archive" && !replyAnswer.thenError;
      return Promise.resolve({
        sent: true,
        then_error: replyAnswer.thenError,
        change: replyAnswer.thenError ? null : { move: then === "later" ? "unread" : then, messages: [], ended, was_unread: true },
      });
    },
    moveOutside: (accountId: string, threadId: string, move: unknown, home: string | null) =>
      refuse.outside ? Promise.reject(new Error(refuse.outside)) : Promise.resolve(void moves.push([accountId, threadId, move, home])),
    handoffPropose: (accountId: string, threadId: string) =>
      Promise.resolve({ account_id: accountId, thread_id: threadId, owner_agent_id: "ada", proposed: { kind: "new", title: "hi" }, choices: [], note: null }),
    handoff: (accountId: string, threadId: string, conversationId: string | null, home: string | null) =>
      refuse.outside
        ? Promise.reject(new Error(refuse.outside))
        : Promise.resolve((handoffs.push([accountId, threadId, conversationId, home]), { agent_id: "ada", conversation_id: conversationId ?? "c-new" })),
    archiveOutside: (accountId: string, threadId: string, home: string | null) =>
      refuse.outside ? Promise.reject(new Error(refuse.outside)) : Promise.resolve(void outside.push([accountId, threadId, home])),
    updateConversation: (id: string, body: Record<string, unknown>, agentId?: string) => Promise.resolve(void updates.push([id, body, agentId])),
    onStatus: () => () => {},
    onChat: (fn: typeof hear) => ((hear = fn), () => {}),
    onListsStale: () => () => {},
    serverInfo: () => Promise.resolve({ version: "1", protocol: 1, commands: [] }),
    listAgents: () =>
      Promise.resolve([
        { id: "ada", name: "Ada" },
        { id: "pass", name: "pass", hidden: true },
      ]),
    isSubscribed: (rt: Runtime) => started.includes(rt.conversation_id),
    runtimeStart: (rt: Runtime) => Promise.resolve(void started.push(rt.conversation_id)),
    sendUserMessage: (_rt: Runtime, text: string) => Promise.resolve(void sent.push(text)),
    respondApproval: () => Promise.resolve(answers.approval),
    changeFolder: () => Promise.resolve(),
    labels: { get: () => Promise.resolve({ labels: [] }) },
    close: () => {},
  };
  const captured: string[] = [];
  const host: ChatStoreHost = {
    markSeen: () => {},
    listConversations: () => Promise.resolve(rows),
    capture: (event) => captured.push(event),
  };
  const store = new ChatStore(host);
  const stop = store.connect(client as unknown as ChatClient);
  const events = (...e: ChatEvent[]) => hear(ADA, e);
  return { store, stop, events, sent, started, answers, captured, updates, outside, refuse, handoffs, moves, replies, replyAnswer };
}

/** Let the store's awaits and its 150 ms flush run. */
const flush = () => vi.advanceTimersByTimeAsync(200);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("the chat store (plan 052)", () => {
  test("connecting reads the shown agents and the list newest first, and follows the newest chats", async () => {
    const d = daemon([row("old", "2026-10-01T00:00:00Z"), row("new", "2026-10-28T00:00:00Z")]);
    await flush();
    const snap = d.store.getSnapshot();
    expect(snap.agents.map((a) => a.id)).toEqual(["ada"]);
    expect(snap.agentsLoaded).toBe(true);
    expect(snap.conversations.map((c) => c.id)).toEqual(["new", "old"]);
    expect(d.started).toEqual(["new", "old"]);
    // The same list again changes nothing, so nothing redraws.
    d.store.reload();
    await flush();
    expect(d.store.getSnapshot()).toBe(snap);
    d.stop();
    expect(d.store.getSnapshot().status).toBe("off");
  });

  test("a message typed while an agent works waits for the turn's end, then goes out once", async () => {
    const d = daemon();
    await flush();
    d.events({ kind: "device", engine: ENGINE }, { kind: "loop", state: "running" });
    d.store.send(ADA, "and the tests");
    await flush();
    expect(d.sent).toEqual([]);
    d.events({ kind: "loop", state: "idle" });
    await flush();
    expect(d.sent).toEqual(["and the tests"]);
    d.events({ kind: "loop", state: "idle" });
    await flush();
    expect(d.sent).toEqual(["and the tests"]);
  });

  test("a new approval is reported once; deciding it clears the card, which comes back when the daemon refuses", async () => {
    const d = daemon();
    await flush();
    d.events({ kind: "approval", request_id: "r1", tool_name: "bash", input: {} });
    d.events({ kind: "step", step: piece("still thinking") });
    await flush();
    expect(d.captured.filter((e) => e === "approval_requested")).toHaveLength(1);
    const face = () => d.store.getSnapshot().live.get("ada/c1")?.pending?.requestId ?? null;
    expect(face()).toBe("r1");
    d.answers.approval = false;
    d.store.decide(ADA, "r1", "allow");
    expect(d.store.getSnapshot().live.get("ada/c1")?.pending).toBeNull();
    await flush();
    expect(face()).toBe("r1");
  });

  test("a call's input growing tells the threads on screen without moving the snapshot", async () => {
    const d = daemon();
    await flush();
    d.events({ kind: "loop", state: "running" }, { kind: "step", step: call("bash", "t1", { command: "ls" }) });
    await flush();
    const snap = d.store.getSnapshot();
    let told = 0;
    d.store.watchThreads(() => (told += 1));
    d.events({ kind: "step", step: call("bash", "t1", { command: "ls -la" }) });
    await flush();
    expect(told).toBe(1);
    expect(d.store.getSnapshot()).toBe(snap);
    expect(d.store.threadRows("ada", "c1")?.length).toBeGreaterThan(0);
  });

  test("a folder change resolves on the daemon's new folder, or with its refusal, leaving the chat's error alone", async () => {
    const d = daemon();
    await flush();
    const moved = d.store.changeFolder(ADA, "/work/b/");
    await flush();
    d.events({ kind: "device", cwd: "/work/b" });
    expect(await moved).toBeNull();
    const refused = d.store.changeFolder(ADA, "/nowhere");
    await flush();
    d.events({ kind: "error", message: "Not a directory: /nowhere" });
    expect(await refused).toBe("Not a directory: /nowhere");
    expect(d.store.getSnapshot().live.get("ada/c1")?.error ?? null).toBeNull();
  });

  test("an archive names the chat's agent to the daemon and takes the chat off the list", async () => {
    const d = daemon();
    await flush();
    expect(await d.store.archiveConversation("c1", true, "inbox", "ada")).toBeNull();
    expect(d.updates).toEqual([["c1", { archived: true }, "ada"]]);
    expect(d.store.getSnapshot().conversations).toEqual([]);
    expect(d.captured).toContain("chat_archived");
    d.stop();
  });

  test("while not connected each call says so, and nothing is sent", async () => {
    const store = new ChatStore({ markSeen: () => {}, listConversations: () => Promise.resolve([]) });
    expect(await store.renameConversation("c1", "x")).toBe("not connected to loki's daemon");
    expect(await store.createAgent({ name: "Bo" })).toEqual({ error: "not connected to loki's daemon" });
    expect(await store.updateModel(ADA, { id: "x", handle: "x" })).toEqual({ applied: null, error: "not connected to loki's daemon" });
    expect(await store.loadProviders()).toEqual([]);
  });

  test("an outside card is archived in its account on its home Mac, never as a chat, and is not opened as one; a refusal keeps it", async () => {
    const card: ConversationInfo & Digest = {
      ...row("t1#1", "2026-11-04T09:00:00Z"),
      kind: "outside",
      agent_id: "account:gmail:ada@acme.com",
      home: "mac-mini",
      outside: {
        account_id: "gmail:ada@acme.com",
        provider: "gmail",
        account_label: "ada@acme.com",
        thread_id: "t1",
        generation: 1,
        owner_agent_id: "ada",
        owner_name: "Ada",
        sender: "Grace",
        sender_address: "grace@acme.com",
        subject: "hi",
        lines: ["hi"],
        newest_message_id: "m1",
        newest_at: "2026-11-04T09:00:00Z",
        handoff_conversation_id: null,
        disconnected: null,
        unread_out_there: true,
      },
    };
    const d = daemon([row("c1", "2026-10-29T10:00:00Z"), card]);
    await flush();
    expect(d.started).toEqual(["c1"]);
    d.refuse.outside = "Gmail is out of reach";
    expect(await d.store.archiveOutside(card)).toBe("Gmail is out of reach");
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toContain("t1#1");
    d.refuse.outside = null;
    expect(await d.store.archiveOutside(card)).toBeNull();
    expect(d.outside).toEqual([["gmail:ada@acme.com", "t1", "mac-mini"]]);
    expect(d.updates).toEqual([]);
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toEqual(["c1"]);

    // A move on it goes to the ledger on the same Mac (plan 069); one that does not get there is let go quietly.
    d.store.moveOutside(card, { action: "archive", via: "key", dwell_ms: 900 });
    d.refuse.outside = "out of reach";
    d.store.moveOutside(card, { action: "next", via: "key", dwell_ms: 1 });
    await flush();
    expect(d.moves).toEqual([["gmail:ada@acme.com", "t1", { action: "archive", via: "key", dwell_ms: 900 }, "mac-mini"]]);
  });

  test("a reply on an outside card is sent with the key's move; archive ends the card, read and later keep it, a refused send says why", async () => {
    const card: ConversationInfo & Digest = {
      ...row("t1#1", "2026-11-04T09:00:00Z"),
      kind: "outside",
      agent_id: "account:gmail:ada@acme.com",
      home: "mac-mini",
      outside: {
        account_id: "gmail:ada@acme.com",
        provider: "gmail",
        account_label: "ada@acme.com",
        thread_id: "t1",
        generation: 1,
        owner_agent_id: "ada",
        owner_name: "Ada",
        sender: "Grace",
        sender_address: "grace@acme.com",
        subject: "hi",
        lines: ["hi"],
        newest_message_id: "m1",
        newest_at: "2026-11-04T09:00:00Z",
        handoff_conversation_id: null,
        disconnected: null,
        unread_out_there: true,
      },
    };
    const d = daemon([row("c1", "2026-10-29T10:00:00Z"), card]);
    await flush();
    const ids = () => d.store.getSnapshot().conversations.map((c) => c.id);
    d.replyAnswer.refused = "Gmail is out of reach";
    expect(await d.store.replyOutside(card, "hello", "archive")).toEqual({ sent: false, error: "Gmail is out of reach", change: null });
    expect(ids()).toContain("t1#1");
    d.replyAnswer.refused = null;
    expect(await d.store.replyOutside(card, "hello", "later")).toMatchObject({ sent: true, error: null, change: { move: "unread" } });
    expect(await d.store.replyOutside(card, "hello", "read")).toMatchObject({ sent: true, error: null, change: { move: "read" } });
    expect(ids()).toContain("t1#1");
    d.replyAnswer.thenError = "Gmail is out of reach";
    expect(await d.store.replyOutside(card, "hello", "archive")).toEqual({ sent: true, error: "Gmail is out of reach", change: null });
    expect(ids()).toContain("t1#1");
    d.replyAnswer.thenError = null;
    expect(await d.store.replyOutside(card, "hello", "archive")).toMatchObject({ sent: true, error: null, change: { ended: true } });
    expect(ids()).toEqual(["c1"]);
    expect(d.replies.map((r) => r[3])).toEqual(["later", "read", "archive", "archive"]);
    expect(d.replies[0]).toEqual(["gmail:ada@acme.com", "t1", "hello", "later", "mac-mini"]);
  });

  test("handing an outside card off asks the Mac its account lives on; done, the card leaves; refused, it stays with the reason", async () => {
    const card: ConversationInfo & Digest = {
      ...row("t1#1", "2026-11-04T09:00:00Z"),
      kind: "outside",
      agent_id: "account:gmail:ada@acme.com",
      home: "mac-mini",
      outside: {
        account_id: "gmail:ada@acme.com",
        provider: "gmail",
        account_label: "ada@acme.com",
        thread_id: "t1",
        generation: 1,
        owner_agent_id: "ada",
        owner_name: "Ada",
        sender: "Grace",
        sender_address: "grace@acme.com",
        subject: "hi",
        lines: ["hi"],
        newest_message_id: "m1",
        newest_at: "2026-11-04T09:00:00Z",
        handoff_conversation_id: null,
        disconnected: null,
        unread_out_there: true,
      },
    };
    const d = daemon([row("c1", "2026-10-29T10:00:00Z"), card]);
    await flush();
    expect(await d.store.handoffPropose(card)).toMatchObject({ proposed: { kind: "new", title: "hi" } });
    d.refuse.outside = "Gmail wants a new sign-in: Preferences › Accounts";
    expect(await d.store.handoff(card, null)).toBe("Gmail wants a new sign-in: Preferences › Accounts");
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toContain("t1#1");
    d.refuse.outside = null;
    expect(await d.store.handoff(card, "c1")).toBeNull();
    expect(d.handoffs).toEqual([["gmail:ada@acme.com", "t1", "c1", "mac-mini"]]);
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).not.toContain("t1#1");
  });
});
