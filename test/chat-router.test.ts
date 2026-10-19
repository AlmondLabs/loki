import { describe, expect, test } from "vitest";
import { ChatRouter, scopeOfFrame } from "../mod/chat-router.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const THIRD = "cccccccc-3333-4333-8333-333333333333";

/** A router where conv-1 (scope conv-1) lives on the mini, and everything else here. */
const router = () =>
  new ChatRouter({
    homeOf: (c) => (c === "conv-1" ? { mac: MINI, reachable: true } : null),
    homeOfScope: (s) => (s === "conv-1" ? { mac: MINI, reachable: true } : null),
    link: () => null,
    name: () => "Mac mini",
    uploadsDir: "/nowhere",
    upload: () => Promise.resolve(null),
  });

describe("which frames go to another Mac", () => {
  test("a chat frame naming its chat, and a canvas frame naming its desk or widget, go to the Mac they live on", () => {
    const r = router();
    expect(r.target({ type: "chat_send", conversation_id: "conv-1", agent_id: "a" })).toEqual({ mac: MINI, reachable: true });
    expect(r.target({ type: "chat_send", conversation_id: "conv-2" })).toBeNull();
    expect(r.target({ type: "gesture", gesture: { id: "conv-1/w", kind: "focus" } })).toEqual({ mac: MINI, reachable: true });
    expect(r.target({ type: "desk_get", scope: "conv-1" })).toEqual({ mac: MINI, reachable: true });
    expect(r.target({ type: "seen_mark", conversation_id: "conv-1" })).toBeNull();
  });

  test("the desk a canvas frame names", () => {
    expect(scopeOfFrame({ scope: "d1" })).toBe("d1");
    expect(scopeOfFrame({ id: "d1/w" })).toBe("d1");
    expect(scopeOfFrame({ gesture: { id: "d2/chart" } })).toBe("d2");
    expect(scopeOfFrame({ id: "no-slash" })).toBeNull();
  });

  test("an unreachable home is not asked: the client hears that the chat waits for it", async () => {
    expect(await router().forward({ mac: MINI, reachable: false }, { type: "chat_send" }, "request")).toEqual({
      ok: false,
      message: "waiting for Mac mini: this chat lives there",
    });
  });
});

describe("a change to another Mac's chat", () => {
  test("a rename there reads that Mac's chats again before the person is answered; a message does not", async () => {
    const order: string[] = [];
    const link = { request: (f: { type: string }) => (order.push(`sent ${f.type}`), Promise.resolve({ type: "chat_done" })) };
    const r = new ChatRouter({
      homeOf: () => ({ mac: MINI, reachable: true }),
      homeOfScope: () => null,
      link: () => link as never,
      name: () => "Mac mini",
      uploadsDir: "/nowhere",
      upload: () => Promise.resolve(null),
      relist: (mac) => (order.push(`relist ${mac}`), Promise.resolve()),
    });
    const home = { mac: MINI, reachable: true };
    expect(await r.forward(home, { type: "chat_update", conversation_id: "conv-1", agent_id: "a", title: "new name" }, "request")).toEqual({
      ok: true,
      reply: { type: "chat_done" },
    });
    await r.forward(home, { type: "chat_send", conversation_id: "conv-1", agent_id: "a", text: "hi" }, "request");
    expect(order).toEqual(["sent chat_update", `relist ${MINI}`, "sent chat_send"]);
  });
});

describe("which pushes from another Mac are passed on here", () => {
  test("only those about its own chats and desks, so three Macs never echo each other", () => {
    const r = router();
    expect(r.relay(MINI, { type: "chat_event", conversation_id: "conv-1", agent_id: "a", events: [] })).toEqual({});
    expect(r.relay(THIRD, { type: "chat_event", conversation_id: "conv-1", events: [] })).toBe(false);
    expect(r.relay(MINI, { type: "chat_event", conversation_id: "conv-2", events: [] })).toBe(false);
    expect(r.relay(MINI, { type: "state", scope: "conv-1", state: {} })).toEqual({ scope: "conv-1" });
    expect(r.relay(MINI, { type: "peers" })).toBe(false);
  });
});

describe("where a new chat lives", () => {
  const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
  /** On the MacBook, with Ira living on the mini; `miniUp` says whether the mini is in reach. */
  const onBook = (miniUp: boolean) =>
    new ChatRouter({
      here: BOOK,
      peer: (id) => (id === MINI ? { mac: MINI, reachable: miniUp } : null),
      agentHome: (id) => (id === "agent-ira" ? MINI : id === "agent-friday" ? BOOK : null),
      homeOf: () => null,
      homeOfScope: () => null,
      link: () => null,
      name: () => "Mac mini",
      uploadsDir: "/nowhere",
      upload: () => Promise.resolve(null),
    });

  test("with no Mac named, an agent's chat goes to its home while that Mac is in reach (AE1)", () => {
    expect(onBook(true).target({ type: "chat_create", agent_id: "agent-ira" })).toEqual({ mac: MINI, reachable: true });
    expect(onBook(true).target({ type: "chat_create", agent_id: "agent-friday" })).toBeNull();
    expect(onBook(true).target({ type: "chat_create", agent_id: "agent-other" })).toBeNull();
  });

  test("picking this Mac keeps it here (AE1)", () => {
    expect(onBook(true).target({ type: "chat_create", agent_id: "agent-ira", home: BOOK })).toBeNull();
  });

  test("with the agent's home out of reach, the default is this Mac", () => {
    expect(onBook(false).target({ type: "chat_create", agent_id: "agent-ira" })).toBeNull();
  });

  test("a Mac named outright is asked even out of reach, so the chat is made nowhere and the person hears why", async () => {
    const r = onBook(false);
    const home = r.target({ type: "chat_create", agent_id: "agent-ira", home: MINI });
    expect(home).toEqual({ mac: MINI, reachable: false });
    expect(home && (await r.forward(home, { type: "chat_create" }, "request"))).toEqual({
      ok: false,
      message: "Mac mini is out of reach: the chat was not started",
    });
  });

  test("the folders a new chat is offered come from the Mac it will live on", () => {
    expect(onBook(true).target({ type: "folders_get", home: MINI })).toEqual({ mac: MINI, reachable: true });
    expect(onBook(true).target({ type: "folder_check", path: "/x", home: BOOK })).toBeNull();
    expect(onBook(true).target({ type: "folders_get" })).toBeNull();
  });
});
