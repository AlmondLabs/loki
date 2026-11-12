import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatClient } from "../core/attention/chat-client.ts";
import { ChatStore, type ChatStoreHost } from "../core/attention/chat-store.ts";
import { sentKey } from "../core/attention/sent-replies.ts";
import type { ChatEvent, ConversationInfo, Digest } from "../core/attention/model.ts";
import type { Runtime } from "../core/attention/protocol.ts";
import type { ChatEngineView } from "../core/models.ts";
import type { OutsideChange, OutsideWrite } from "../core/frame-types.ts";
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
  /** The socket came back after a drop and the followed chats are open again. */
  let reopened: () => void = () => {};
  const sent: string[] = [];
  const started: string[] = [];
  /** Each send-again and discard of a mail reply that did not go (plan 096). */
  const settled: string[][] = [];
  /** `fails`: every call to the daemon rejects with it, as when the socket closed under the request. `noList`: the list gets no answer. */
  const answers = { approval: true, fails: null as string | null, noList: false };
  const updates: Array<[string, Record<string, unknown>, string | undefined]> = [];
  const outside: Array<[string, string, string | null]> = [];
  const refuse = { outside: null as string | null };
  const handoffs: Array<[string, string, string | null, string | null]> = [];
  const moves: unknown[] = [];
  const replies: Array<[string, string, string, string, string | null]> = [];
  /** How the daemon answers a reply: refused before it was sent, or sent with the move's reason. */
  const replyAnswer = { refused: null as string | null, thenError: null as string | null };
  /** Each write-back and restore the daemon was asked for. */
  const writes: unknown[][] = [];
  /** Whether the daemon's read ends the card, as reading a Slack card does. */
  const readEnds = { value: false };
  const change = (move: OutsideWrite, ended: boolean): OutsideChange => ({
    move,
    messages: [{ message_id: "m1", labels_added: [], labels_removed: ["INBOX"] }],
    ended,
    was_unread: true,
  });
  const write = (move: OutsideWrite, accountId: string, threadId: string, home: string | null, labels?: string[]) => {
    if (refuse.outside) return Promise.reject(new Error(refuse.outside));
    writes.push([move, accountId, threadId, home, ...(labels ? [labels] : [])]);
    return Promise.resolve(change(move, move === "read" && readEnds.value));
  };
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
      refuse.outside ? Promise.reject(new Error(refuse.outside)) : (outside.push([accountId, threadId, home]), Promise.resolve(change("archive", true))),
    markReadOutside: (accountId: string, threadId: string, home: string | null) => write("read", accountId, threadId, home),
    markUnreadOutside: (accountId: string, threadId: string, home: string | null) => write("unread", accountId, threadId, home),
    labelOutside: (accountId: string, threadId: string, labels: string[], home: string | null) => write("label", accountId, threadId, home, labels),
    restoreOutside: (accountId: string, threadId: string, c: unknown, home: string | null) =>
      refuse.outside ? Promise.reject(new Error(refuse.outside)) : Promise.resolve(void writes.push(["restore", accountId, threadId, home, c])),
    labelsOutside: (accountId: string) =>
      refuse.outside ? Promise.reject(new Error(refuse.outside)) : Promise.resolve([{ id: `${accountId}:L1`, name: "Clients", type: "user" }]),
    updateConversation: (id: string, body: Record<string, unknown>, agentId?: string) => Promise.resolve(void updates.push([id, body, agentId])),
    onStatus: () => () => {},
    onChat: (fn: typeof hear) => ((hear = fn), () => {}),
    onListsStale: () => () => {},
    onReopened: (fn: () => void) => ((reopened = fn), () => {}),
    serverInfo: () => Promise.resolve({ version: "1", protocol: 1, commands: [] }),
    listAgents: () =>
      Promise.resolve([
        { id: "ada", name: "Ada" },
        { id: "pass", name: "pass", hidden: true },
      ]),
    isSubscribed: (rt: Runtime) => started.includes(rt.conversation_id),
    runtimeStart: (rt: Runtime) => Promise.resolve(void started.push(rt.conversation_id)),
    sendUserMessage: (_rt: Runtime, text: string) => (answers.fails ? Promise.reject(new Error(answers.fails)) : Promise.resolve(void sent.push(text))),
    resendOutside: (accountId: string, threadId: string, outboxId: string) =>
      answers.fails
        ? Promise.reject(new Error(answers.fails))
        : (settled.push(["resend", accountId, threadId, outboxId]), Promise.resolve({ sent: true, then_error: null, change: null })),
    discardOutside: (accountId: string, outboxId: string) => (settled.push(["discard", accountId, outboxId]), Promise.resolve(true)),
    respondApproval: () => (answers.fails ? Promise.reject(new Error(answers.fails)) : Promise.resolve(answers.approval)),
    changeFolder: () => Promise.resolve(),
    labels: { get: () => Promise.resolve({ labels: [] }) },
    close: () => {},
  };
  const captured: string[] = [];
  const host: ChatStoreHost = {
    markSeen: () => {},
    listConversations: () => Promise.resolve(answers.noList ? null : rows),
    capture: (event) => captured.push(event),
  };
  const store = new ChatStore(host);
  const stop = store.connect(client as unknown as ChatClient);
  const events = (...e: ChatEvent[]) => hear(ADA, e);
  return {
    store,
    stop,
    events,
    reopen: () => reopened(),
    host,
    settled,
    sent,
    started,
    answers,
    captured,
    updates,
    outside,
    refuse,
    handoffs,
    moves,
    replies,
    replyAnswer,
    writes,
    readEnds,
  };
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

  test("a decision whose request fails puts the card back: the agent still waits on it", async () => {
    const d = daemon();
    await flush();
    d.events({ kind: "approval", request_id: "r1", tool_name: "bash", input: {} });
    await flush();
    d.answers.fails = "the link to loki closed before it answered";
    d.store.decide(ADA, "r1", "allow");
    expect(d.store.getSnapshot().live.get("ada/c1")?.pending).toBeNull();
    await flush();
    expect(d.store.getSnapshot().live.get("ada/c1")?.pending?.requestId).toBe("r1");
  });

  test("a message whose send fails says so in its chat", async () => {
    const d = daemon();
    await flush();
    d.answers.fails = "no answer from the mod";
    d.store.send(ADA, "hello", []);
    await flush();
    expect(d.sent).toEqual([]);
    expect(d.store.getSnapshot().live.get("ada/c1")?.error).toBe("this message may not have been sent: no answer from the mod");
  });

  test("a list that gets no answer leaves the Inbox as it was, and is asked for again in a few seconds", async () => {
    const d = daemon();
    await flush();
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toEqual(["c1"]);
    d.answers.noList = true;
    d.store.reload();
    await flush();
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toEqual(["c1"]);
    expect(d.store.getSnapshot().listed).toBe(true);
    d.answers.noList = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toEqual(["c1"]);
  });

  test("after the socket comes back, a thread that was read is read again: what settled meanwhile shows without leaving the chat", async () => {
    const d = daemon();
    const pages: Array<Array<{ role: "user" | "assistant"; text: string; at: string }>> = [[{ role: "user", text: "hello", at: "2026-10-29T10:00:00Z" }]];
    let asked = 0;
    d.host.loadLocalHistory = () => Promise.resolve({ rows: pages[Math.min(asked++, pages.length - 1)] ?? [], start: 0, more: false });
    await flush();
    await d.store.loadThread(ADA);
    expect(d.store.threadRows("ada", "c1")?.map((r) => r.text)).toEqual(["hello"]);
    // The Mac slept through the agent's answer; the socket is back.
    pages.push([...(pages[0] ?? []), { role: "assistant", text: "hi, Ada here", at: "2026-10-29T10:00:05Z" }]);
    d.reopen();
    await flush();
    expect(asked).toBe(2);
    expect(d.store.threadRows("ada", "c1")?.map((r) => r.text)).toEqual(["hello", "hi, Ada here"]);
  });

  test("a mail reply that did not go is sent again or let go on its account's Mac, with why when that fails", async () => {
    const d = daemon();
    await flush();
    const card = { home: "mac-mini", outside: { account_id: "gmail:ada@acme.com", thread_id: "t1" } } as Pick<ConversationInfo, "outside" | "home">;
    expect(await d.store.settleUnsent(card, "o3-abcdefgh", "resend")).toBeNull();
    expect(await d.store.settleUnsent(card, "o3-abcdefgh", "discard")).toBeNull();
    expect(d.settled).toEqual([
      ["resend", "gmail:ada@acme.com", "t1", "o3-abcdefgh"],
      ["discard", "gmail:ada@acme.com", "o3-abcdefgh"],
    ]);
    d.answers.fails = "the link to loki closed before it answered";
    expect(await d.store.settleUnsent(card, "o3-abcdefgh", "resend")).toBe("the link to loki closed before it answered");
    expect(await d.store.settleUnsent({}, "o3-abcdefgh", "resend")).toBe("this card is not from an account");
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
    expect(await d.store.archiveOutside(card)).toEqual({ change: null, error: "Gmail is out of reach" });
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toContain("t1#1");
    d.refuse.outside = null;
    expect(await d.store.archiveOutside(card)).toMatchObject({ change: { move: "archive", ended: true }, error: null });
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
    // A reply with a move leaves with its card, so its thread keeps none of them (plan 086).
    const key = sentKey("gmail:ada@acme.com", "t1");
    expect(d.store.sent.get(key).replies).toEqual([]);
    // A reply sent alone shows on its card from the press, and is marked gone once it went.
    const going = d.store.replyOutside(card, " see you ", "stay");
    expect(d.store.sent.get(key).replies).toMatchObject([{ text: "see you", gone: false }]);
    await going;
    expect(d.store.sent.get(key)).toMatchObject({ went: 1, replies: [{ text: "see you", gone: true }] });
    // One that is refused goes from the thread as its words go back to the box.
    d.replyAnswer.refused = "Gmail is out of reach";
    await d.store.replyOutside(card, "again", "stay");
    expect(d.store.sent.get(key)).toMatchObject({ went: 1, replies: [{ text: "see you" }] });
    // One sent into a post's thread opened on the card shows in that thread, not the card's own view (plan 085).
    d.replyAnswer.refused = null;
    await d.store.replyOutside(card, "in there", "stay", { thread_ts: "1731.2" });
    expect(d.store.sent.get(sentKey("gmail:ada@acme.com", "t1", "1731.2")).replies).toMatchObject([{ text: "in there" }]);
    expect(d.store.sent.get(key).replies).toHaveLength(1);
  });

  test("read, unread and label are written back on the card's home Mac with what they changed; a read that ends the card drops it; restore brings it back", async () => {
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

    // A refused write says why and keeps the card.
    d.refuse.outside = "Gmail is out of reach";
    expect(await d.store.markReadOutside(card)).toEqual({ change: null, error: "Gmail is out of reach" });
    expect(await d.store.labelsOf(card)).toBe("Gmail is out of reach");
    expect(ids()).toContain("t1#1");
    d.refuse.outside = null;

    // An email read, put off or labelled stays in the list.
    const read = await d.store.markReadOutside(card);
    expect(read).toMatchObject({ change: { move: "read", ended: false }, error: null });
    expect(await d.store.markUnreadOutside(card)).toMatchObject({ change: { move: "unread" }, error: null });
    expect(await d.store.labelOutside(card, ["L1"])).toMatchObject({ change: { move: "label" }, error: null });
    expect(await d.store.labelsOf(card)).toEqual([{ id: "gmail:ada@acme.com:L1", name: "Clients", type: "user" }]);
    expect(ids()).toContain("t1#1");

    // A read that ends the card, as on Slack, drops it; restoring that change lists the card again.
    d.readEnds.value = true;
    const ended = await d.store.markReadOutside(card);
    expect(ids()).toEqual(["c1"]);
    if (!ended.change) throw new Error("the read wrote nothing");
    expect(await d.store.restoreOutside(card, ended.change)).toBeNull();
    await flush();
    expect(ids()).toContain("t1#1");
    expect(d.writes.map((w) => w[0])).toEqual(["read", "unread", "label", "read", "restore"]);
    expect(d.writes[2]).toEqual(["label", "gmail:ada@acme.com", "t1", "mac-mini", ["L1"]]);
    expect(d.writes[4]).toEqual(["restore", "gmail:ada@acme.com", "t1", "mac-mini", ended.change]);
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

  /** An open Jira card (plan 2026-11-10-1451) on the Mac its site lives on. */
  const ticket = (): ConversationInfo & Digest => ({
    ...row("10001#1", "2026-11-10T09:00:00Z"),
    kind: "outside",
    agent_id: "account:jira:acme.atlassian.net:acc-me",
    home: "mac-mini",
    outside: {
      account_id: "jira:acme.atlassian.net:acc-me",
      provider: "jira",
      account_label: "acme.atlassian.net",
      thread_id: "10001",
      generation: 1,
      owner_agent_id: "ada",
      owner_name: "Ada",
      sender: "Ada Lovelace",
      sender_address: null,
      subject: "Rotate the keys",
      place: "OPS-7",
      lines: ["Can you look?"],
      newest_message_id: "2026-11-10T09:00:00.000Z:c000000030001",
      newest_at: "2026-11-10T09:00:00Z",
      handoff_conversation_id: null,
      disconnected: null,
      unread_out_there: true,
    },
  });

  test("a Jira card is never archived: the store refuses before asking its Mac, and the card stays (R19, KTD12)", async () => {
    const card = ticket();
    const d = daemon([row("c1", "2026-10-29T10:00:00Z"), card]);
    await flush();
    expect(await d.store.archiveOutside(card)).toEqual({ change: null, error: "a jira card ends with read" });
    expect(d.outside).toEqual([]);
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toContain("10001#1");
  });

  test("a comment sent alone on a Jira card keeps it in the list (plan 2026-11-10-1451, U7)", async () => {
    const card = ticket();
    const d = daemon([row("c1", "2026-10-29T10:00:00Z"), card]);
    await flush();
    expect(await d.store.replyOutside(card, "On it", "stay")).toMatchObject({ sent: true, error: null });
    expect(d.replies).toEqual([["jira:acme.atlassian.net:acc-me", "10001", "On it", "stay", "mac-mini"]]);
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toContain("10001#1");
  });

  test("Covers AE8. a Jira card handed off stays in the list", async () => {
    const card = ticket();
    const d = daemon([row("c1", "2026-10-29T10:00:00Z"), card]);
    await flush();
    expect(await d.store.handoff(card, "c1")).toBeNull();
    expect(d.handoffs).toEqual([["jira:acme.atlassian.net:acc-me", "10001", "c1", "mac-mini"]]);
    expect(d.store.getSnapshot().conversations.map((c) => c.id)).toContain("10001#1");
  });
});
