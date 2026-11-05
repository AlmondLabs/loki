import { describe, expect, test } from "vitest";
import { stampOf } from "../core/attention/queue.ts";
import { inboxCardSource } from "../core/analytics.ts";
import {
  applyChatEvent,
  buildItems,
  cancelQueued,
  emptyLive,
  faceOf,
  keyOf,
  senderKeyOf,
  sendMode,
  takeQueued,
  unviewed,
  viewStamp,
  type ConversationInfo,
  type ChatEvent,
  type Live,
} from "../core/attention/model.ts";
import { call, piece, push, user } from "./fixtures/chat-events.ts";
import { must } from "./fixtures/must.ts";

describe("attention model (browser)", () => {
  test("buildItems classifies approval / question / done / running / idle and orders by score", () => {
    const convs: ConversationInfo[] = [
      { id: "done", agent_id: "a", agent_name: "ira", title: "Done", last_message_at: "2026-09-05T08:00:00Z", archived: false },
      { id: "q", agent_id: "a", agent_name: "ira", title: "Q", last_message_at: "2026-09-05T07:00:00Z", archived: false },
      { id: "appr", agent_id: "a", agent_name: "ira", title: "Appr", last_message_at: "2026-09-05T06:00:00Z", archived: false },
      { id: "seen", agent_id: "a", agent_name: "ira", title: "Seen", last_message_at: "2026-09-05T05:00:00Z", archived: false },
      { id: "run", agent_id: "a", agent_name: "ira", title: "Run", last_message_at: "2026-09-05T04:00:00Z", archived: false },
    ];
    const digests = new Map([
      [keyOf("a", "done"), { last_role: "assistant" as const, last_assistant_text: "Finished.", last_ask: null }],
      [keyOf("a", "q"), { last_role: "assistant" as const, last_assistant_text: "Should I proceed?", last_ask: null }],
      [keyOf("a", "appr"), { last_role: "assistant" as const, last_assistant_text: "Running it.", last_ask: null }],
      [keyOf("a", "seen"), { last_role: "assistant" as const, last_assistant_text: "Old news.", last_ask: null }],
      [keyOf("a", "run"), { last_role: "user" as const, last_assistant_text: null, last_ask: null }],
    ]);
    const live = new Map<string, Live>();
    const appr = emptyLive();
    applyChatEvent(appr, { kind: "approval", request_id: "perm-1", tool_name: "Bash", input: { command: "ls" } }, "2026-09-05T09:30:00Z");
    live.set(keyOf("a", "appr"), appr);
    const run = emptyLive();
    applyChatEvent(run, { kind: "loop", state: "running" });
    live.set(keyOf("a", "run"), run);
    const items = buildItems(convs, digests, live, { [keyOf("a", "seen")]: "2026-09-05T09:00:00Z" }, new Date("2026-09-05T10:00:00Z").getTime());
    // by score (priority.ts): the two blocked cards first, the one waiting longest (the question, from 07:00) ahead; then the finished one; the rest by age
    expect(items.map((i) => `${i.id}:${i.status}`)).toEqual(["q:question", "appr:approval", "done:done", "seen:idle", "run:running"]);
    expect(
      must(
        items.find((i) => i.id === "appr"),
        "the approval card",
      ).pendingApproval,
    ).toMatchObject({ requestId: "perm-1", toolName: "Bash" });
  });

  test("applyChatEvent: streaming text lands on stop, user speaking resets and reports", () => {
    const l = emptyLive();
    push(l, piece("Hel"));
    push(l, piece("lo."));
    expect(l.lastAssistantText).toBeNull();
    applyChatEvent(l, { kind: "settle" });
    expect(l.lastAssistantText).toBe("Hello.");
    const r = push(l, user("thanks"));
    expect(r.userSpoke).toBe(true);
    expect(l.lastRole).toBe("user");
  });
});

describe("AskUserQuestion as a pending question", () => {
  test("a question becomes a pending question, not an approval, and clears when the loop moves on", () => {
    const l = emptyLive();
    applyChatEvent(l, {
      kind: "question",
      request_id: "perm-q1",
      input: { questions: [{ question: "Ship it?", options: [{ label: "yes" }, { label: "no" }] }] },
    });
    expect(l.pending).toBeNull();
    expect(l.pendingAsk?.requestId).toBe("perm-q1");
    expect(l.pendingAsk?.questions[0].options.map((o) => o.label)).toEqual(["yes", "no"]);
    const items = buildItems(
      [{ id: "c", agent_id: "a", agent_name: "ira", title: "t", last_message_at: "2026-09-06T00:00:00Z", archived: false }],
      new Map(),
      new Map([[keyOf("a", "c"), l]]),
      {},
    );
    expect(items[0].status).toBe("question");
    expect(items[0].pendingQuestion?.requestId).toBe("perm-q1");
    applyChatEvent(l, { kind: "loop", state: "running" });
    expect(l.pendingAsk).toBeNull();
  });
});

describe("a finished reply re-queues a decided card", () => {
  test("lastAssistantText updates when the loop goes idle before the reply settles or the turn ends, so the stamp changes", () => {
    const l = emptyLive();
    l.lastAssistantText = "earlier";
    applyChatEvent(l, { kind: "loop", state: "running" });
    push(l, piece("here is the answer"));
    applyChatEvent(l, { kind: "loop", state: "idle" });
    expect(l.lastAssistantText).toBe("here is the answer");
    expect(must(l.thread.rows(), "the thread's rows").at(-1)).toMatchObject({ role: "assistant", text: "here is the answer" });
    applyChatEvent(l, { kind: "turn_end" }); // arrives late, with nothing left to settle
    expect(l.lastAssistantText).toBe("here is the answer");
    expect(must(l.thread.rows(), "the thread's rows").length).toBe(1);
  });
});

describe("a turn that ends in a tool call still counts as new", () => {
  test("turns increments once per completed turn, on idle or turn end, never on streaming alone", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "loop", state: "running" });
    push(l, call("Write", "t1"));
    expect(l.turns).toBe(0);
    applyChatEvent(l, { kind: "loop", state: "idle" });
    expect(l.turns).toBe(1);
    applyChatEvent(l, { kind: "turn_end" }); // same turn, reported again: no double count
    expect(l.turns).toBe(1);
    applyChatEvent(l, { kind: "loop", state: "running" });
    applyChatEvent(l, { kind: "turn_end" });
    expect(l.turns).toBe(2);
  });
});

describe("messages typed mid-turn", () => {
  test("nothing leaves while the turn runs; one goes at each turn end, and its row stops being queued", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "loop", state: "running" });
    l.queued.push({ text: "first", images: [] }, { text: "second", images: [] });
    l.thread.queue({ role: "user", text: "first" });
    l.thread.queue({ role: "user", text: "second" });
    expect(takeQueued(l)).toBeNull();
    applyChatEvent(l, { kind: "loop", state: "idle" });
    expect(takeQueued(l)).toEqual({ text: "first", images: [] });
    expect(must(l.thread.rows(), "the thread's rows").map((r) => [r.text, r.queued === true])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    expect(l.queued.map((q) => q.text)).toEqual(["second"]);
    expect(takeQueued(l)).toEqual({ text: "second", images: [] }); // the caller marks inTurn again before the next; here the turn is over
    expect(takeQueued(l)).toBeNull();
  });
  test("on loki's own engine a message sent during a turn joins it; on an agent it waits for the turn's end", () => {
    const l = emptyLive();
    expect(sendMode(l)).toBe("now");
    l.inTurn = true;
    expect(sendMode(l)).toBe("steer");
    l.engine = { agent: "claude", name: "Claude Code", model: "default", modes: [], commands: [] };
    expect(sendMode(l)).toBe("queue");
  });
  test("cancel drops the message and its row; an unknown text changes nothing", () => {
    const l = emptyLive();
    l.inTurn = true;
    l.queued.push({ text: "oops", images: [] });
    l.thread.own({ role: "user", text: "kept" });
    l.thread.queue({ role: "user", text: "oops" });
    expect(cancelQueued(l, "nope")).toBe(false);
    expect(cancelQueued(l, "oops")).toBe(true);
    expect(l.queued).toEqual([]);
    expect(must(l.thread.rows(), "the thread's rows").map((r) => r.text)).toEqual(["kept"]);
  });
});

describe("viewed, apart from done", () => {
  const conv: ConversationInfo = { id: "c", agent_id: "a", agent_name: "ira", title: "C", last_message_at: "2026-09-05T08:00:00Z", archived: false };
  const digests = new Map([[keyOf("a", "c"), { last_role: "assistant" as const, last_assistant_text: "Finished.", last_ask: null }]]);
  const now = new Date("2026-09-05T10:00:00Z").getTime();

  test("buildItems carries the look; a look does not make the item read", () => {
    const [i] = buildItems([conv], digests, new Map(), {}, now, { [keyOf("a", "c")]: "2026-09-05T09:00:00Z" });
    expect(i.viewedAt).toBe("2026-09-05T09:00:00Z");
    expect(i.unread).toBe(true);
    expect(i.status).toBe("done");
    expect(buildItems([conv], digests, new Map(), {}, now)[0].viewedAt).toBeNull();
  });

  test("a card's stamp is the same on every device: a rest made on the phone holds on the Mac, and after a reload", () => {
    // The phone has followed the chat live through three turns; the Mac, or the phone after a reload, has not.
    const watched = { ...emptyLive(), turns: 3, lastAssistantText: "Finished.", lastRole: "assistant" as const };
    const [onPhone] = buildItems([conv], digests, new Map([[keyOf("a", "c"), watched]]), {}, now);
    const [onMac] = buildItems([conv], digests, new Map(), {}, now);
    expect(stampOf(onMac)).toBe(stampOf(onPhone));
  });

  test("unviewed: unread with something newer than the last look", () => {
    const base = { unread: true, last_message_at: "2026-09-05T08:00:00Z", viewedAt: null as string | null };
    expect(unviewed(base)).toBe(true);
    expect(unviewed({ ...base, viewedAt: "2026-09-05T07:59:59Z" })).toBe(true);
    expect(unviewed({ ...base, viewedAt: "2026-09-05T08:00:00Z" })).toBe(false);
    expect(unviewed({ ...base, viewedAt: "2026-09-05T08:00:00.000+00:00" })).toBe(false); // times compared as instants
    expect(unviewed({ ...base, unread: false })).toBe(false);
    expect(unviewed({ ...base, last_message_at: null, viewedAt: "2026-09-05T08:00:00Z" })).toBe(true); // nothing to compare: still new
  });

  test("viewStamp: one look per new last message, only while it is unread and unviewed", () => {
    const base = { agent_id: "a", id: "c", unread: true, last_message_at: "2026-09-05T08:00:00Z", viewedAt: null as string | null };
    expect(viewStamp(base)).toBe("a/c@2026-09-05T08:00:00Z");
    expect(viewStamp({ ...base, viewedAt: "2026-09-05T09:00:00Z" })).toBeNull();
    expect(viewStamp({ ...base, unread: false })).toBeNull();
    expect(viewStamp({ ...base, last_message_at: null })).toBeNull();
    expect(viewStamp(null)).toBeNull();
  });
});

describe("a loop status that repeats changes nothing", () => {
  const loop = (state: "running" | "idle"): ChatEvent => ({ kind: "loop", state });

  test("idle again, while idle, reports no change (nothing re-renders on it)", () => {
    const l = emptyLive();
    applyChatEvent(l, loop("running"));
    push(l, piece("Done."));
    expect(applyChatEvent(l, loop("idle")).changed).toBe(true); // the turn ends: the reply settles, the turn counts
    expect(l.turns).toBe(1);
    expect(applyChatEvent(l, loop("idle")).changed).toBe(false);
    expect(applyChatEvent(l, loop("idle")).changed).toBe(false);
    expect(l.turns).toBe(1);
  });

  test("the first status on a fresh conversation, a new status, and a repeat that still clears something all count", () => {
    const l = emptyLive();
    expect(applyChatEvent(l, loop("idle")).changed).toBe(true); // unknown → idle
    expect(applyChatEvent(l, loop("running")).changed).toBe(true);
    expect(applyChatEvent(l, loop("running")).changed).toBe(false);
    l.error = "the turn failed";
    expect(applyChatEvent(l, loop("running")).changed).toBe(true); // a running status clears the error
    expect(l.error).toBeNull();
  });
});

describe("a streaming reply moves its thread, not the list (plan 032)", () => {
  const piece = (text: string) => ({ kind: "step" as const, step: { kind: "assistant" as const, text, at: null, chunk: true } });

  test("the first piece moves the last-message time; the pieces after it leave the time and the face alone", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "loop", state: "running" }, "2026-10-25T09:00:00.000Z");
    applyChatEvent(l, piece("Let "), "2026-10-25T09:00:01.000Z");
    expect(l.lastMessageAt).toBe("2026-10-25T09:00:01.000Z");
    const face = faceOf(l);
    const revision = l.thread.revision;
    expect(applyChatEvent(l, piece("me "), "2026-10-25T09:00:02.000Z").changed).toBe(true);
    applyChatEvent(l, piece("look"), "2026-10-25T09:00:03.000Z");
    expect(l.lastMessageAt).toBe("2026-10-25T09:00:01.000Z");
    expect(faceOf(l)).toEqual(face);
    expect(l.thread.revision).toBeGreaterThan(revision);
  });

  test("the turn's end, a whole message and an approval move the face", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "loop", state: "running" }, "2026-10-25T09:00:00.000Z");
    applyChatEvent(l, piece("Done"), "2026-10-25T09:00:01.000Z");
    let face = faceOf(l);
    applyChatEvent(l, { kind: "turn_end" }, "2026-10-25T09:00:05.000Z");
    expect(l.lastMessageAt).toBe("2026-10-25T09:00:05.000Z");
    expect(faceOf(l)).not.toEqual(face);
    face = faceOf(l);
    applyChatEvent(l, { kind: "step", step: { kind: "assistant", text: "A note.", at: null } }, "2026-10-25T09:01:00.000Z");
    expect(l.lastMessageAt).toBe("2026-10-25T09:01:00.000Z");
    expect(faceOf(l)).not.toEqual(face);
    face = faceOf(l);
    applyChatEvent(l, { kind: "approval", request_id: "q1", tool_name: "bash", input: {} }, "2026-10-25T09:02:00.000Z");
    expect(faceOf(l)).not.toEqual(face);
  });

  test("a reply starting and settling moves the face, since the chat box shows streaming apart from thinking", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "loop", state: "running" }, "2026-10-25T09:00:00.000Z");
    const thinking = faceOf(l);
    applyChatEvent(l, piece("Hi"), "2026-10-25T09:00:01.000Z");
    const streaming = faceOf(l);
    expect(streaming).not.toEqual(thinking);
    applyChatEvent(l, { kind: "settle" }, "2026-10-25T09:00:02.000Z");
    expect(faceOf(l)).not.toEqual(streaming);
  });
});

describe("a reply that only reads like a question", () => {
  const at = "2026-10-19T09:00:00Z";
  const conv = [{ id: "c", agent_id: "a", agent_name: "friday", title: "FMOS", last_message_at: at, archived: false }];
  const digest = new Map([[keyOf("a", "c"), { last_role: "assistant" as const, last_assistant_text: "Shall I open the PR now?", last_ask: null }]]);

  test("waits on you until you look at it, then is a finished chat: still unread, so the Inbox keeps it", () => {
    expect(buildItems(conv, digest, new Map(), {})[0].status).toBe("question");
    const looked = buildItems(conv, digest, new Map(), {}, Date.parse(at), { [keyOf("a", "c")]: "2026-10-19T09:05:00Z" })[0];
    expect(looked.status).toBe("done");
    expect(looked.unread).toBe(true);
    // A look from before the reply does not count.
    expect(buildItems(conv, digest, new Map(), {}, Date.parse(at), { [keyOf("a", "c")]: "2026-10-19T08:00:00Z" })[0].status).toBe("question");
  });
});

describe("a chat's open suggestions (plan 049)", () => {
  const suggestion = {
    id: "sugg-1",
    title: "t",
    text: "x",
    target: { agent_id: "a", folder: "/w" },
    status: "pending" as const,
    created_at: "2026-10-29T10:00:00Z",
  };

  test("are folded into the chat's live state, which the list and chat box compare", () => {
    const l = emptyLive();
    expect(l.suggestions).toEqual([]);
    const before = faceOf(l);
    expect(applyChatEvent(l, { kind: "suggestions", suggestions: [suggestion] })).toEqual({ changed: true, userSpoke: false });
    expect(l.suggestions).toEqual([suggestion]);
    expect(faceOf(l)).not.toEqual(before);
    expect(applyChatEvent(l, { kind: "suggestions", suggestions: [] }).changed).toBe(true);
    expect(l.suggestions).toEqual([]);
  });
});

describe("a chat's reply proposals (plan 067, U10)", () => {
  const proposal = {
    id: "reply-1",
    account_id: "gmail:ada@acme.com",
    provider: "gmail" as const,
    account_label: "ada@acme.com",
    thread_id: "t1",
    subject: "Re: The plan",
    to: ["Grace <grace@acme.com>"],
    cc: [],
    place: null,
    text: "Friday works.",
    status: "pending" as const,
    reason: null,
    created_at: "2026-11-04T10:00:00Z",
  };
  const chat = (id: string, extra: Partial<ConversationInfo> = {}): ConversationInfo => ({
    id,
    agent_id: "a",
    agent_name: null,
    title: id,
    last_message_at: id === "fresh" ? "2026-11-04T11:00:00Z" : "2026-11-04T08:00:00Z",
    archived: false,
    ...extra,
  });
  const statuses = (convs: ConversationInfo[], live = new Map<string, Live>()) =>
    buildItems(convs, new Map(), live, {}, Date.parse("2026-11-04T12:00:00Z")).map((i) => `${i.id}:${i.status}`);

  test("a waiting one on the list's row makes the card an approval that ranks above a fresher chat", () => {
    expect(statuses([chat("fresh"), chat("asks", { reply_proposals: [proposal] })])).toEqual(["asks:approval", "fresh:idle"]);
    // One being drafted is decided already: it blocks no one.
    expect(statuses([chat("asks", { reply_proposals: [{ ...proposal, status: "drafting" }] })])).toEqual(["asks:idle"]);
  });

  test("heard live, they replace what the row said, and move the chat's face", () => {
    const l = emptyLive();
    const before = faceOf(l);
    expect(applyChatEvent(l, { kind: "reply_proposals", proposals: [proposal] })).toEqual({ changed: true, userSpoke: false });
    expect(faceOf(l)).not.toEqual(before);
    expect(statuses([chat("asks")], new Map([[keyOf("a", "asks"), l]]))).toEqual(["asks:approval"]);
    applyChatEvent(l, { kind: "reply_proposals", proposals: [] });
    expect(statuses([chat("asks", { reply_proposals: [proposal] })], new Map([[keyOf("a", "asks"), l]]))).toEqual(["asks:idle"]);
  });
});

describe("outside cards (plan 067, U3)", () => {
  const NOW = Date.parse("2026-11-04T10:00:00Z");
  const AT = "2026-11-04T09:00:00Z";
  /** An outside row as the mod lists it: one Gmail thread of the work agent's mailbox. */
  const outside = (
    more: { generation?: number; message?: string; at?: string; owner?: string; sender?: string; unreadOutThere?: boolean; provider?: "gmail" | "slack" } = {},
  ): ConversationInfo => ({
    kind: "outside",
    id: `t1#${String(more.generation ?? 1)}`,
    agent_id: "account:gmail:ada@acme.com",
    agent_name: "ada@acme.com",
    title: "Quarterly numbers",
    last_message_at: more.at ?? AT,
    archived: false,
    outside: {
      account_id: "gmail:ada@acme.com",
      provider: more.provider ?? "gmail",
      account_label: "ada@acme.com",
      thread_id: "t1",
      generation: more.generation ?? 1,
      owner_agent_id: more.owner ?? "agent-work",
      owner_name: "Work",
      sender: "Grace",
      sender_address: more.sender ?? "grace@acme.com",
      subject: "Quarterly numbers",
      lines: ["Can you look?"],
      newest_message_id: more.message ?? "m1",
      newest_at: more.at ?? AT,
      handoff_conversation_id: null,
      disconnected: null,
      unread_out_there: more.unreadOutThere ?? true,
    },
  });
  const chatRow = (id: string): ConversationInfo => ({ id, agent_id: "a", agent_name: "ira", title: id, last_message_at: AT, archived: false });
  const replied = (id: string) => [keyOf("a", id), { last_role: "assistant" as const, last_assistant_text: "Finished.", last_ask: null }] as const;
  const one = (c: ConversationInfo, opts: { seen?: Record<string, string>; focus?: Record<string, number>; rests?: Parameters<typeof buildItems>[7] } = {}) =>
    must(buildItems([c], new Map(), new Map(), opts.seen ?? {}, NOW, {}, opts.focus ?? {}, opts.rests ?? {})[0], "the card");

  test("an unread outside card scores exactly like a chat with a new reply", () => {
    const items = buildItems([outside(), chatRow("c")], new Map([replied("c")]), new Map(), {}, NOW);
    const card = must(
      items.find((i) => i.outside),
      "outside card",
    );
    const chat = must(
      items.find((i) => i.id === "c"),
      "chat card",
    );
    expect(card).toMatchObject({ unread: true, status: "done", reason: "new" });
    expect(card.score).toBe(chat.score);
  });

  test("a blocked agent's chat still ranks above every outside card", () => {
    const live = new Map<string, Live>();
    const asking = emptyLive();
    applyChatEvent(asking, { kind: "approval", request_id: "perm-1", tool_name: "Bash", input: {} }, AT);
    live.set(keyOf("a", "blocked"), asking);
    const items = buildItems([outside(), chatRow("blocked")], new Map(), live, {}, NOW);
    expect(items.map((i) => i.id)).toEqual(["blocked", "t1#1"]);
  });

  test("covers AE2: a newer message on an open thread is the same card, and it ends the card's rest", () => {
    const first = one(outside());
    const rests = { [keyOf(first.agent_id, first.id)]: { n: 1, until: "2026-11-05T00:00:00Z", stamp: stampOf(first), at: AT } };
    expect(one(outside(), { rests }).resting).toBe(true);
    const later = one(outside({ message: "m2", at: "2026-11-04T09:30:00Z" }), { rests });
    expect(keyOf(later.agent_id, later.id)).toBe(keyOf(first.agent_id, first.id));
    expect(later.resting).toBe(false);
  });

  test("a Slack card is seen until a newer message comes, by the card's own mark", () => {
    const key = keyOf("account:gmail:ada@acme.com", "t1#1");
    expect(one(outside({ provider: "slack" }), { seen: { [key]: "2026-11-04T09:10:00Z" } }).unread).toBe(false);
    expect(one(outside({ provider: "slack", message: "m2", at: "2026-11-04T09:30:00Z" }), { seen: { [key]: "2026-11-04T09:10:00Z" } }).unread).toBe(true);
  });

  test("an email card unread in Gmail shows unread even when loki's seen mark is newer (marked unread there)", () => {
    const key = keyOf("account:gmail:ada@acme.com", "t1#1");
    expect(one(outside({ unreadOutThere: true }), { seen: { [key]: "2026-11-04T09:10:00Z" } }).unread).toBe(true);
  });

  test("an email row from a paired Mac on an older loki, with no Gmail read state, shows unread", () => {
    const row = outside();
    const facts = must(row.outside, "outside");
    delete facts.unread_out_there;
    expect(one(row)).toMatchObject({ unread: true, status: "done" });
  });

  test("covers AE7: an email card read in Gmail shows as read with no mark of loki's; a Slack card goes by its mark only", () => {
    expect(one(outside({ unreadOutThere: false }))).toMatchObject({ unread: false, status: "idle" });
    expect(one(outside({ unreadOutThere: true })).unread).toBe(true);
    expect(one(outside({ provider: "slack", unreadOutThere: false })).unread).toBe(true);
  });

  test("after a hand-off the next message is the next generation's card, with none of the old card's marks", () => {
    const old = one(outside());
    const key = keyOf(old.agent_id, old.id);
    const marks = {
      seen: { [key]: "2026-11-04T09:40:00Z" },
      focus: { [key]: 0.5 },
      rests: { [key]: { n: 2, until: "2026-11-06T00:00:00Z", stamp: stampOf(old), at: AT } },
    };
    const next = one(outside({ generation: 2, message: "m2", at: "2026-11-04T09:30:00Z" }), marks);
    expect(next.id).toBe("t1#2");
    expect(next).toMatchObject({ unread: true, focus: 0 });
    expect(next.resting).toBeUndefined();
  });

  test("moving the account to another agent keeps the card's key, its rest and its focus", () => {
    const before = one(outside());
    const key = keyOf(before.agent_id, before.id);
    const marks = { focus: { [key]: 0.3 }, rests: { [key]: { n: 1, until: "2026-11-05T00:00:00Z", stamp: stampOf(before), at: AT } } };
    const moved = one(outside({ owner: "agent-home" }), marks);
    expect(keyOf(moved.agent_id, moved.id)).toBe(key);
    expect(moved).toMatchObject({ resting: true, focus: 0.3 });
    expect(moved.outside?.owner_agent_id).toBe("agent-home");
  });

  test("an email card gains the focus its sender has, on top of its own", () => {
    const sender = must(senderKeyOf(must(outside().outside, "outside")), "the sender's key");
    expect(sender).toEqual({ agentId: "account:gmail:ada@acme.com", conversationId: "sender:grace@acme.com" });
    const focus = { [keyOf(sender.agentId, sender.conversationId)]: 0.4 };
    expect(one(outside(), { focus }).focus).toBe(0.4);
    expect(one(outside({ sender: "someone@else.com" }), { focus }).focus).toBe(0);
  });
});

describe("an outside card in analytics (plan 067)", () => {
  test("says where it came from and whose it is, and nothing of its account, sender, subject or text", () => {
    const card = {
      agent_id: "account:gmail:ada@acme.com",
      id: "t1#1",
      title: "Quarterly numbers",
      outside: { provider: "gmail" as const, owner_agent_id: "agent-work", sender: "Grace", subject: "Quarterly numbers", lines: ["Can you look?"] },
    };
    const props = inboxCardSource(card);
    expect(props).toEqual({ source: "gmail", desk: null, agent: "agent-work" });
    expect(JSON.stringify(props)).not.toMatch(/ada@acme|Grace|Quarterly|look/);
    expect(inboxCardSource({ agent_id: "a", id: "c1" })).toMatchObject({ source: "chat", agent: "a" });
  });
});
