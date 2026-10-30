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
  const client = {
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
  return { store, stop, events, sent, started, answers, captured };
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

  test("while not connected each call says so, and nothing is sent", async () => {
    const store = new ChatStore({ markSeen: () => {}, listConversations: () => Promise.resolve([]) });
    expect(await store.renameConversation("c1", "x")).toBe("not connected to loki's daemon");
    expect(await store.createAgent({ name: "Bo" })).toEqual({ error: "not connected to loki's daemon" });
    expect(await store.updateModel(ADA, { id: "x", handle: "x" })).toEqual({ applied: null, error: "not connected to loki's daemon" });
    expect(await store.loadProviders()).toEqual([]);
  });
});
