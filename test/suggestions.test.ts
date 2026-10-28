import { describe, expect, test } from "vitest";
import type { ChatEvent } from "../core/attention/model.ts";
import type { Suggestion, SuggestionTarget } from "../core/frame-types.ts";
import { ChatDirectory } from "../mod/chat-directory.ts";
import { ChatRouter } from "../mod/chat-router.ts";
import { chatCaller, Suggestions, type CallOutcome, type ChatCall, type TargetChat } from "../mod/suggestions.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";
import { must } from "./fixtures/must.ts";

const FRIDAY = "agent-local-friday";
const IRA = "agent-local-ira";
const SOURCE = { agent_id: FRIDAY, conversation_id: "conv-source" };
const INFRA = { agent_id: FRIDAY, conversation_id: "conv-infra" };
const IRAS = { agent_id: IRA, conversation_id: "conv-ira" };
const NEW_FRIDAY: SuggestionTarget = { agent_id: FRIDAY, folder: "/work/loki" };
const NEW_IRA: SuggestionTarget = { agent_id: IRA, folder: "/work/site" };
const key = (c: { agent_id: string; conversation_id: string }) => `${c.agent_id}/${c.conversation_id}`;

/**
 * A Mac holding the source chat, with chats it can see (here or on paired Macs), the agents it knows, and a fake
 * that answers each chat frame the way the Mac it goes to would. `refuse` makes that frame fail with the message.
 */
function world(opts: { archived?: boolean; chats?: Record<string, TargetChat>; agents?: string[]; refuse?: (f: ChatCall) => string | null } = {}) {
  const records = new Map<string, { suggestions: Suggestion[]; archived: boolean }>([[key(SOURCE), { suggestions: [], archived: opts.archived ?? false }]]);
  const chats: Record<string, TargetChat> = {
    [key(SOURCE)]: { title: "suggestions plan", status: "live", has_draft: false },
    [key(INFRA)]: { title: "infra", status: "live", has_draft: false },
    [key(IRAS)]: { title: "site", status: "live", has_draft: false },
    ...opts.chats,
  };
  const agents = new Set(opts.agents ?? [FRIDAY, IRA]);
  const calls: ChatCall[] = [];
  const pushes: Array<{ chat: string; events: ChatEvent[] }> = [];
  const tracked: Array<{ event: string; properties: Record<string, unknown> }> = [];
  let made = 0;
  const call = (f: ChatCall): Promise<CallOutcome> => {
    calls.push(f);
    const refused = opts.refuse?.(f) ?? null;
    if (refused) return Promise.resolve({ ok: false, message: refused });
    if (f.type === "chat_create")
      return Promise.resolve({ ok: true, reply: { type: "chat_created", agent_id: f.agent_id, conversation_id: `conv-made-${++made}` } });
    if (f.type === "chat_send") return Promise.resolve({ ok: true, reply: { type: "chat_accepted", accepted: true } });
    if (f.archived === false) must(records.get(key(f)), "the chat un-archived").archived = false;
    return Promise.resolve({ ok: true, reply: { type: "chat_done" } });
  };
  let n = 0;
  const s = new Suggestions({
    records: {
      read: (agentId, conversationId) => {
        const r = records.get(`${agentId}/${conversationId}`);
        return Promise.resolve(r ? { suggestions: structuredClone(r.suggestions), archived: r.archived } : null);
      },
      write: (agentId, conversationId, suggestions) => {
        must(records.get(`${agentId}/${conversationId}`), "the chat written").suggestions = structuredClone(suggestions);
        return Promise.resolve();
      },
    },
    chat: (c) => chats[key(c)] ?? null,
    agentExists: (id) => agents.has(id),
    agentHome: (id) => (id === IRA ? "mac-mini" : null),
    call,
    push: (agentId, conversationId, events) => pushes.push({ chat: `${agentId}/${conversationId}`, events }),
    track: (event, properties) => tracked.push({ event, properties }),
    now: () => new Date("2026-10-29T10:00:00Z"),
    newId: () => `sugg-${++n}`,
  });
  const stored = () => must(records.get(key(SOURCE)), "the source chat").suggestions;
  return { s, records, chats, agents, calls, pushes, tracked, stored };
}

const suggest = (w: ReturnType<typeof world>, target: SuggestionTarget = INFRA) =>
  w.s.add(SOURCE, { title: "Fix the flaky lock test", text: "The lock test in /work/loki/test/lock.test.ts sleeps; wait on a condition.", target });

describe("making a suggestion", () => {
  test("it is kept on the source chat as pending, every client hears the chat's open suggestions, and it is counted", async () => {
    const w = world();
    const made = await suggest(w);
    expect(made).toMatchObject({ id: "sugg-1", status: "pending", target: INFRA, created_at: "2026-10-29T10:00:00.000Z" });
    expect(w.stored()).toEqual([made]);
    expect(w.pushes.at(-1)).toEqual({ chat: key(SOURCE), events: [{ kind: "suggestions", suggestions: [made] }] });
    expect(w.tracked).toEqual([{ event: "suggestion_made", properties: { agent: FRIDAY, target: "existing" } }]);
  });

  test("a suggestion needs a title, a text and a target", async () => {
    const w = world();
    await expect(w.s.add(SOURCE, { title: " ", text: "x", target: INFRA })).rejects.toThrow("a suggestion needs a title");
    await expect(w.s.add(SOURCE, { title: "t", text: "", target: INFRA })).rejects.toThrow("a suggestion needs a text");
    await expect(w.s.add({ agent_id: FRIDAY, conversation_id: "conv-none" }, { title: "t", text: "x", target: INFRA })).rejects.toThrow("no chat conv-none");
  });

  test("a suggestion added to an archived chat brings the chat back into the Inbox (R15)", async () => {
    const w = world({ archived: true });
    await suggest(w);
    expect(w.calls).toEqual([{ type: "chat_update", ...SOURCE, archived: false }]);
    expect(must(w.records.get(key(SOURCE)), "source").archived).toBe(false);
  });

  test("the chat's own suggestions are listed, and its open ones are what a client opening it replays", async () => {
    const w = world();
    const a = await suggest(w);
    const b = await suggest(w, NEW_FRIDAY);
    await w.s.decide(SOURCE, a.id, "reject", "desktop");
    expect((await w.s.list(SOURCE)).map((x) => [x.id, x.status])).toEqual([
      [a.id, "rejected"],
      [b.id, "pending"],
    ]);
    expect((await w.s.open(SOURCE)).map((x) => x.id)).toEqual([b.id]);
  });
});

describe("sending a suggestion", () => {
  test("covers AE1: it goes as the person's message without steer, so a chat mid-turn queues it; send_id is the suggestion's id", async () => {
    const w = world();
    const made = await suggest(w);
    const out = await w.s.decide(SOURCE, made.id, "send", "desktop");
    expect(out).toMatchObject({ done: true, message: null, suggestion: { status: "sent", decided_by: "desktop", decided_at: "2026-10-29T10:00:00.000Z" } });
    const sent = must(
      w.calls.find((c) => c.type === "chat_send"),
      "the send",
    );
    expect(sent).toEqual({
      type: "chat_send",
      ...INFRA,
      text: made.text,
      images: [],
      send_id: made.id,
      context: expect.stringContaining(`<loki-suggested from_agent="${FRIDAY}" from_chat="conv-source" title="Fix the flaky lock test"/>`) as unknown,
    });
    expect(sent).not.toHaveProperty("steer");
    expect((sent as { context: string }).context).toContain('a suggestion an agent made in the chat "suggestions plan"');
    expect(w.stored()[0].status).toBe("sent");
    // The card went from pending to sending to gone.
    expect(w.pushes.map((p) => (p.events[0] as { suggestions: Suggestion[] }).suggestions.map((x) => x.status))).toEqual([["pending"], ["sending"], []]);
  });

  test("covers AE2: re-pointed from a new chat to another agent's existing chat, it goes there", async () => {
    const w = world();
    const made = await suggest(w, NEW_FRIDAY);
    expect(await w.s.retarget(SOURCE, made.id, IRAS)).toMatchObject({ done: true, suggestion: { target: IRAS, status: "pending" } });
    await w.s.decide(SOURCE, made.id, "send", "desktop");
    expect(w.calls.map((c) => c.type)).toEqual(["chat_send"]);
    expect(w.calls[0]).toMatchObject(IRAS);
  });

  test("to a new chat it makes the chat on its agent's Mac, keeps its id on the suggestion, then sends there", async () => {
    const w = world();
    const made = await suggest(w, NEW_IRA);
    await w.s.decide(SOURCE, made.id, "send", "phone");
    expect(w.calls).toEqual([
      { type: "chat_create", agent_id: IRA, cwd: "/work/site", title: made.title, home: "mac-mini" },
      expect.objectContaining({ type: "chat_send", agent_id: IRA, conversation_id: "conv-made-1", send_id: made.id }) as unknown,
    ]);
    expect(w.stored()[0]).toMatchObject({ status: "sent", made_conversation_id: "conv-made-1", decided_by: "phone" });
  });

  test("covers AE4: a new chat whose agent's Mac is out of reach is not made, and the suggestion stays pending with why", async () => {
    const w = world({ refuse: (f) => (f.type === "chat_create" ? "Mac mini is out of reach: the chat was not started" : null) });
    const made = await suggest(w, NEW_IRA);
    const out = await w.s.decide(SOURCE, made.id, "send", "desktop");
    expect(out).toMatchObject({ done: false, message: "Mac mini is out of reach: the chat was not started" });
    expect(w.stored()[0]).toMatchObject({ status: "pending", reason: "Mac mini is out of reach: the chat was not started", made_conversation_id: null });
    expect(w.calls.map((c) => c.type)).toEqual(["chat_create"]);
  });

  test("to a chat on a Mac that does not answer, it stays pending with that reason", async () => {
    const w = world({ refuse: (f) => (f.type === "chat_send" ? "waiting for Mac mini: this chat lives there" : null) });
    const made = await suggest(w, IRAS);
    expect(await w.s.decide(SOURCE, made.id, "send", "desktop")).toMatchObject({ done: false, suggestion: { status: "pending" } });
    expect(w.stored()[0].reason).toBe("waiting for Mac mini: this chat lives there");
  });

  test("a retry after the chat was made but the send failed reuses the made chat and the same send_id", async () => {
    let fail = true;
    const w = world({ refuse: (f) => (f.type === "chat_send" && fail ? "waiting for Mac mini: this chat lives there" : null) });
    const made = await suggest(w, NEW_IRA);
    await w.s.decide(SOURCE, made.id, "send", "desktop");
    fail = false;
    expect(await w.s.decide(SOURCE, made.id, "send", "desktop")).toMatchObject({ done: true, suggestion: { status: "sent", reason: null } });
    expect(w.calls.map((c) => [c.type, "conversation_id" in c ? c.conversation_id : null, "send_id" in c ? c.send_id : null])).toEqual([
      ["chat_create", null, null],
      ["chat_send", "conv-made-1", made.id],
      ["chat_send", "conv-made-1", made.id],
    ]);
  });

  test("covers AE7: a target deleted since gives the pick-another-chat reason, and nothing is sent", async () => {
    const w = world({ chats: { [key(INFRA)]: { title: "infra", status: "deleted", has_draft: false } } });
    const made = await suggest(w);
    const out = await w.s.decide(SOURCE, made.id, "send", "desktop");
    expect(out).toMatchObject({ done: false, message: "the chat this was for is gone: pick another chat", suggestion: { status: "pending" } });
    expect(w.calls).toEqual([]);
  });

  test("covers R16: an archived target, or one whose agent is gone, asks for another chat too", async () => {
    const archived = world({ chats: { [key(INFRA)]: { title: "infra", status: "archived", has_draft: false } } });
    const a = await suggest(archived);
    expect((await archived.s.decide(SOURCE, a.id, "send", "desktop")).message).toBe("the chat this was for is archived: pick another chat");
    const noAgent = world({ agents: [FRIDAY] });
    const b = await suggest(noAgent, NEW_IRA);
    expect((await noAgent.s.decide(SOURCE, b.id, "send", "desktop")).message).toBe("the agent this was for is gone: pick another chat");
    expect([...archived.calls, ...noAgent.calls]).toEqual([]);
  });

  test("the first of two sends wins: the one that arrives while it is being sent is told so, and only one message goes", async () => {
    const w = world();
    const made = await suggest(w);
    const [first, second] = await Promise.all([w.s.decide(SOURCE, made.id, "send", "phone"), w.s.decide(SOURCE, made.id, "send", "desktop")]);
    expect(first.done).toBe(true);
    expect(second).toMatchObject({ done: false, message: "already being sent" });
    expect(w.calls.filter((c) => c.type === "chat_send")).toHaveLength(1);
  });
});

describe("the first action wins (R17)", () => {
  test("covers AE6: a reject after a send from the phone is told it was already sent from the phone, and nothing changes", async () => {
    const w = world();
    const made = await suggest(w);
    await w.s.decide(SOURCE, made.id, "send", "phone");
    const out = await w.s.decide(SOURCE, made.id, "reject", "desktop");
    expect(out).toMatchObject({ done: false, message: "already sent from the phone", suggestion: { status: "sent", decided_by: "phone" } });
    expect(w.stored()[0].status).toBe("sent");
  });

  test("a withdraw after sending began is refused", async () => {
    const w = world();
    const made = await suggest(w);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = new Suggestions({
      ...w.s["opts"],
      call: async (f) => (f.type === "chat_send" ? (await gate, { ok: true, reply: { accepted: true } }) : { ok: true, reply: {} }),
    });
    const sending = slow.decide(SOURCE, made.id, "send", "desktop");
    await settled();
    expect(await slow.withdraw(SOURCE, made.id)).toMatchObject({ done: false, message: "already being sent" });
    release();
    expect(await sending).toMatchObject({ done: true });
    expect(await slow.withdraw(SOURCE, made.id)).toMatchObject({ done: false, message: "already sent from the desktop" });
  });

  test("a pending suggestion its agent withdraws is withdrawn, and a decision after that is told so", async () => {
    const w = world();
    const made = await suggest(w);
    expect(await w.s.withdraw(SOURCE, made.id)).toMatchObject({ done: true, suggestion: { status: "withdrawn", decided_by: "agent" } });
    expect((await w.s.decide(SOURCE, made.id, "send", "desktop")).message).toBe("the agent took this suggestion back");
    expect(w.tracked.at(-1)).toEqual({ event: "suggestion_decided", properties: { action: "withdraw", outcome: "done", by: "agent" } });
  });

  test("a re-point is only for a pending suggestion", async () => {
    const w = world();
    const made = await suggest(w);
    await w.s.decide(SOURCE, made.id, "reject", "phone");
    expect(await w.s.retarget(SOURCE, made.id, IRAS)).toMatchObject({ done: false, message: "already rejected from the phone" });
  });

  test("an unknown suggestion is an error", async () => {
    const w = world();
    await expect(w.s.decide(SOURCE, "sugg-none", "reject", "desktop")).rejects.toThrow("no suggestion sugg-none in this chat");
  });
});

describe("saving a suggestion as a draft", () => {
  test("writes the target chat's saved draft and marks the suggestion drafted", async () => {
    const w = world();
    const made = await suggest(w);
    expect(await w.s.decide(SOURCE, made.id, "draft", "desktop")).toMatchObject({ done: true, suggestion: { status: "drafted" } });
    expect(w.calls).toEqual([{ type: "chat_update", ...INFRA, draft: { text: made.text, suggestion_id: made.id, source: SOURCE } }]);
  });

  test("onto a chat that already holds a saved draft is refused with that reason", async () => {
    const w = world({ chats: { [key(INFRA)]: { title: "infra", status: "live", has_draft: true } } });
    const made = await suggest(w);
    expect(await w.s.decide(SOURCE, made.id, "draft", "desktop")).toMatchObject({
      done: false,
      message: "that chat already holds a saved draft: send it there first, or pick another chat",
      suggestion: { status: "pending" },
    });
    expect(w.calls).toEqual([]);
  });

  test("for a new chat, makes the chat first and saves the draft there", async () => {
    const w = world();
    const made = await suggest(w, NEW_FRIDAY);
    await w.s.decide(SOURCE, made.id, "draft", "desktop");
    expect(w.calls.map((c) => c.type)).toEqual(["chat_create", "chat_update"]);
    expect(w.calls[1]).toMatchObject({ agent_id: FRIDAY, conversation_id: "conv-made-1" });
  });
});

describe("sending across three Macs (KTD3)", () => {
  const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
  const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

  /** This Mac's router and caller, with the target chat on the mini, whose link answers with `answer`. */
  const caller = (answer: (f: Record<string, unknown>) => Promise<Record<string, unknown>>, reachable = true) => {
    const directory = new ChatDirectory({
      here: BOOK,
      holds: (scope) => scope === "conv-source",
      macs: () => [MINI],
      reachable: () => reachable,
      ask: () => Promise.resolve({ held: false, moved_to: null }),
      tell: () => {},
    });
    directory.heard(MINI, { kind: "holds", scopes: ["conv-ira"] });
    const sent: Array<Record<string, unknown>> = [];
    const local: string[] = [];
    const router = new ChatRouter({
      here: BOOK,
      peer: (id) => (id === MINI ? { mac: MINI, reachable } : null),
      agentHome: () => MINI,
      directory,
      link: () => ({ request: (f: Record<string, unknown>) => (sent.push(f), answer(f)) }) as never,
      name: () => "Mac mini",
      uploadsDir: "/nowhere",
      upload: () => Promise.resolve(null),
    });
    const call = chatCaller({
      route: router,
      backend: {
        send: (p) => (local.push(`send ${p.conversation_id}`), Promise.resolve(true)),
        create: (agentId) => (local.push(`create ${agentId}`), Promise.resolve({ agentId, conversationId: "conv-here" })),
        update: (p) => (local.push(`update ${p.conversation_id}`), Promise.resolve()),
      },
    });
    return { call, sent, local };
  };

  test("a send to the mini is a request: the suggestion is sent only once the mini accepts it", async () => {
    const c = caller((f) => Promise.resolve(f.type === "chat_send" ? { type: "chat_accepted", accepted: true } : {}));
    const out = await c.call({ type: "chat_send", ...IRAS, text: "hi", images: [], send_id: "sugg-1", context: null });
    expect(out).toEqual({ ok: true, reply: { type: "chat_accepted", accepted: true } });
    expect(c.sent).toEqual([{ type: "chat_send", ...IRAS, text: "hi", images: [], send_id: "sugg-1", context: null }]);
    expect(c.local).toEqual([]);
  });

  test("a mini that does not answer is a failure the source Mac hears", async () => {
    const c = caller(() => Promise.reject(new Error("no answer from Mac mini")));
    expect(await c.call({ type: "chat_send", ...IRAS, text: "hi", images: [], send_id: "sugg-1", context: null })).toEqual({
      ok: false,
      message: "no answer from Mac mini",
    });
  });

  test("a new chat for an agent on a mini out of reach is not made here instead", async () => {
    const c = caller(() => Promise.resolve({}), false);
    expect(await c.call({ type: "chat_create", agent_id: IRA, cwd: "/work/site", title: "t", home: MINI })).toEqual({
      ok: false,
      message: "Mac mini is out of reach: the chat was not started",
    });
    expect(c.local).toEqual([]);
  });

  test("a chat on this Mac is answered by this Mac's backend", async () => {
    const c = caller(() => Promise.resolve({}));
    expect(await c.call({ type: "chat_update", ...SOURCE, archived: false })).toEqual({ ok: true, reply: {} });
    expect(c.local).toEqual(["update conv-source"]);
  });
});

describe("the suggestion frames", () => {
  test("a decision answers with the suggestion as it stands and who settled it, and records the decision", async () => {
    const w = world();
    const made = await suggest(w);
    const captured: Array<{ event: string; properties?: Record<string, unknown> }> = [];
    const { bridge } = bridgeWith({ suggestions: w.s, capture: (_c, event, properties) => captured.push({ event, properties }) });
    const phone = client("d1", "dev-1");
    bridge.onMessage(phone, { type: "suggestion_decide", request_id: "r1", ...SOURCE, suggestion_id: made.id, action: "send" });
    await settled();
    await settled();
    expect(phone.sent.at(-1)).toMatchObject({ type: "suggestion_decided", request_id: "r1", done: true, suggestion: { status: "sent", decided_by: "phone" } });
    const desktop = client("d1");
    bridge.onMessage(desktop, { type: "suggestion_decide", request_id: "r2", ...SOURCE, suggestion_id: made.id, action: "reject" });
    await settled();
    expect(desktop.sent.at(-1)).toMatchObject({ type: "suggestion_decided", request_id: "r2", done: false, message: "already sent from the phone" });
    expect(captured).toEqual([
      { event: "suggestion_decided", properties: { action: "send", outcome: "done", by: "phone" } },
      { event: "suggestion_decided", properties: { action: "reject", outcome: "refused", by: "desktop" } },
    ]);
  });

  test("a re-point frame changes the target", async () => {
    const w = world();
    const made = await suggest(w, NEW_FRIDAY);
    const { bridge } = bridgeWith({ suggestions: w.s });
    const c = client("d1");
    bridge.onMessage(c, { type: "suggestion_retarget", request_id: "r1", ...SOURCE, suggestion_id: made.id, target: IRAS });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "suggestion_decided", done: true, suggestion: { target: IRAS } });
  });

  test("without suggestions on this host, a decision is an error", async () => {
    const { bridge } = bridgeWith({});
    const c = client("d1");
    bridge.onMessage(c, { type: "suggestion_decide", request_id: "r1", ...SOURCE, suggestion_id: "sugg-1", action: "send" });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "error", request_id: "r1" });
  });
});
