import { describe, expect, test } from "vitest";
import { ChatDirectory } from "../mod/chat-directory.ts";
import { ChatRouter, scopeOfFrame } from "../mod/chat-router.ts";
import { PeerRefusal } from "../mod/peer-link.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const THIRD = "cccccccc-3333-4333-8333-333333333333";

/** The MacBook's directory, holding no chat itself, with the mini's word that it holds `scopes`. */
function directory(scopes: string[] = ["conv-1"], ask: (mac: string) => { held: boolean; moved_to: string | null } = () => ({ held: false, moved_to: null })) {
  const d = new ChatDirectory({
    here: BOOK,
    holds: () => false,
    macs: () => [MINI, THIRD],
    reachable: () => true,
    ask: (mac) => Promise.resolve(ask(mac)),
    tell: () => {},
  });
  d.heard(MINI, { kind: "holds", scopes });
  return d;
}

/** A router where conv-1 (scope conv-1) lives on the mini, and everything else here. */
const router = () =>
  new ChatRouter({
    directory: directory(),
    link: () => null,
    name: () => "Mac mini",
    uploadsDir: "/nowhere",
    upload: () => Promise.resolve(null),
  });

describe("which frames go to another Mac", () => {
  test("a chat frame naming its chat, and a canvas frame naming its desk or widget, go to the Mac they live on", async () => {
    const r = router();
    expect(r.target({ type: "chat_send", conversation_id: "conv-1", agent_id: "a" })).toEqual({ mac: MINI, reachable: true });
    // A chat no Mac claimed is asked for; none holds it, so it is answered here.
    expect(await r.target({ type: "chat_send", conversation_id: "conv-2" })).toBeNull();
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
  test("a chat started there reads that Mac's chats again before the person is answered, so it is listed here at once", async () => {
    const order: string[] = [];
    const link = { request: (f: { type: string }) => (order.push(`sent ${f.type}`), Promise.resolve({ type: "chat_created" })) };
    const r = new ChatRouter({
      directory: directory(),
      link: () => link as never,
      name: () => "Mac mini",
      uploadsDir: "/nowhere",
      upload: () => Promise.resolve(null),
      relist: (mac) => (order.push(`relist ${mac}`), Promise.resolve()),
    });
    await r.forward({ mac: MINI, reachable: true }, { type: "chat_create", agent_id: "agent-ira", home: MINI }, "request");
    expect(order).toEqual(["sent chat_create", `relist ${MINI}`]);
  });

  test("a rename there reads that Mac's chats again before the person is answered; a message does not", async () => {
    const order: string[] = [];
    const link = { request: (f: { type: string }) => (order.push(`sent ${f.type}`), Promise.resolve({ type: "chat_done" })) };
    const r = new ChatRouter({
      directory: directory(),
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
  /** On the MacBook, with Ira living on the mini; `miniUp` says whether the mini is in reach. */
  const onBook = (miniUp: boolean) =>
    new ChatRouter({
      here: BOOK,
      peer: (id) => (id === MINI ? { mac: MINI, reachable: miniUp } : null),
      agentHome: (id) => (id === "agent-ira" ? MINI : id === "agent-friday" ? BOOK : null),
      directory: directory([]),
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
    const home = await r.target({ type: "chat_create", agent_id: "agent-ira", home: MINI });
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

describe("a chat that moved (addendum B)", () => {
  test("a chat just made on the mini is found by asking, and its frames go there", async () => {
    const r = new ChatRouter({
      directory: directory([], (mac) => ({ held: mac === MINI, moved_to: null })),
      link: () => null,
      name: () => "Mac mini",
      uploadsDir: "/nowhere",
      upload: () => Promise.resolve(null),
    });
    expect(await r.target({ type: "history_get", conversation_id: "conv-new", agent_id: "a" })).toEqual({ mac: MINI, reachable: true });
  });

  test("a redirect from the Mac the chat left is followed once, to where it went", async () => {
    const sent: string[] = [];
    const links: Record<string, unknown> = {
      [MINI]: { request: () => (sent.push(MINI), Promise.reject(new PeerRefusal({ type: "error", message: "moved", moved_to: THIRD }))) },
      [THIRD]: { request: () => (sent.push(THIRD), Promise.resolve({ type: "history", messages: [] })) },
    };
    const d = directory(["conv-1"], (mac) => ({ held: mac === THIRD, moved_to: null }));
    const r = new ChatRouter({
      directory: d,
      link: (mac) => (links[mac] ?? null) as never,
      name: () => "a Mac",
      uploadsDir: "/nowhere",
      upload: () => Promise.resolve(null),
    });
    const out = await r.forward({ mac: MINI, reachable: true }, { type: "history_get", conversation_id: "conv-1", agent_id: "a" }, "request");
    expect(out).toEqual({ ok: true, reply: { type: "history", messages: [] } });
    expect(sent).toEqual([MINI, THIRD]);
    expect(d.peek("conv-1")).toEqual({ at: "mac", mac: THIRD, reachable: true });
    // The new home's events are relayed now, the old home's are not.
    expect(r.relay(THIRD, { type: "chat_event", conversation_id: "conv-1", agent_id: "a", events: [] })).toEqual({});
    expect(r.relay(MINI, { type: "chat_event", conversation_id: "conv-1", agent_id: "a", events: [] })).toBe(false);
  });

  test("on the Mac a chat left, a paired Mac's frame for it is answered with where it went", () => {
    const here = new ChatDirectory({
      here: MINI,
      holds: () => true,
      macs: () => [],
      reachable: () => true,
      ask: () => Promise.reject(new Error("no")),
      tell: () => {},
    });
    const r = new ChatRouter({ directory: here, link: () => null, name: () => "the third Mac", uploadsDir: "/nowhere", upload: () => Promise.resolve(null) });
    expect(r.redirect({ type: "chat_send", conversation_id: "conv-1", agent_id: "a" })).toBeNull();
    const gone = new ChatDirectory({
      here: MINI,
      holds: () => false,
      macs: () => [],
      reachable: () => true,
      ask: () => Promise.reject(new Error("no")),
      tell: () => {},
    });
    gone.left({ agent_id: "a", conversation_id: "conv-1" }, THIRD);
    const r2 = new ChatRouter({ directory: gone, link: () => null, name: () => "the third Mac", uploadsDir: "/nowhere", upload: () => Promise.resolve(null) });
    expect(r2.redirect({ type: "chat_send", conversation_id: "conv-1", agent_id: "a" })).toEqual({
      message: "this chat moved to the third Mac",
      moved_to: THIRD,
    });
    expect(r2.redirect({ type: "peers_get" })).toBeNull();
  });
});
