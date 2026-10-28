import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameModules, type ModuleDeps } from "../mod/frames/index.ts";
import type { FrameHandlers } from "../mod/frames/context.ts";
import { SeenStore } from "../mod/seen.ts";
import { RecallStore } from "../mod/recall.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import { bridgeOf, client, fakeWidgets, settled } from "./fixtures/frames.ts";
import {
  FRAMES,
  PEER_FRAMES,
  PHONE_FRAMES,
  frameEntry,
  peerMeaning,
  pushMeaning,
  type FrameName,
  type InputOf,
  type ReplyOf,
  type RequestName,
  type SendName,
} from "../core/frames.ts";

const names = Object.keys(FRAMES) as FrameName[];
const parsed = names.filter((n) => FRAMES[n].kind !== "push");

describe("the frame table", () => {
  test("a paired phone may send exactly the frames it could before the table, the daemon's chat frames, the usage page's read, the labels' list, and the decisions on a suggestion", () => {
    expect([...PHONE_FRAMES].sort() as string[]).toEqual(
      [
        "chat_open",
        "chat_approve",
        "chat_answer",
        "chat_command",
        "chat_create",
        "chat_send",
        "chat_abort",
        "chat_update",
        "chat_labels_get",
        "chat_folder",
        "chat_model",
        "chat_models",
        "chat_agents",
        "capture",
        "list_desks",
        "seen_list",
        "seen_mark",
        "seen_unmark",
        "viewed_mark",
        "history_get",
        "history_step_get",
        "inbox_list",
        "pin_set",
        "folders_get",
        "agent_get",
        "memory_read",
        "memory_log",
        "memory_diff",
        "recall_list",
        "usage_get",
        "recall_grade",
        "recall_reject",
        "recall_restore",
        "recall_edit",
        "recall_export",
        "recall_lead_start",
        "recall_lead_dismiss",
        "recall_lead_restore",
        "models_recent_add",
        "focus_add",
        "card_rest",
        "desk_get",
        "suggestion_decide",
        "suggestion_retarget",
      ].sort(),
    );
  });

  test("no frame of Tasks is left, for the phone or anyone (plan 047, U6)", () => {
    expect(names.filter((n) => /^tasks?_/.test(n))).toEqual([]);
    expect([...PHONE_FRAMES].filter((n) => /^tasks?_/.test(n))).toEqual([]);
  });

  test("every reply the app waited for is some request's reply", () => {
    const replies = new Set(names.flatMap((n) => (FRAMES[n].kind === "request" ? [(FRAMES[n] as { reply: string }).reply] : [])));
    for (const r of [
      "agent",
      "memory_file",
      "memory_commits",
      "memory_diff",
      "reflection_state",
      "history",
      "folders",
      "folder_matches",
      "folder_status",
      "folder_picked",
      "skills_global",
      "skill_installed",
      "skill_refreshed",
      "inbox",
      "recall",
      "recall_card",
      "recall_ran",
      "recall_export",
      "recall_lesson",
    ]) {
      expect([r, replies.has(r)]).toEqual([r, true]);
    }
  });

  test("an unknown or inherited name is no frame", () => {
    expect(frameEntry("no_such_frame")).toBeUndefined();
    expect(frameEntry("toString")).toBeUndefined();
    expect(frameEntry(undefined)).toBeUndefined();
    expect(frameEntry("history_get")?.kind).toBe("request");
  });

  test("every parser answers anything with a payload or a message, never a throw", () => {
    const junk: Array<Record<string, unknown>> = [
      {},
      { id: 7, agent_id: "../x", conversation_id: null, size: "big", gesture: [], grade: "3", ids: "a", properties: [1] },
      { id: null, scope: "", path: {}, event: "Not An Event" },
    ];
    for (const n of parsed) {
      const parse = (FRAMES[n] as { parse: (m: Record<string, unknown>) => unknown }).parse;
      for (const m of junk) {
        const r = parse(m);
        expect([n, typeof r === "string" || (typeof r === "object" && r !== null)]).toEqual([n, true]);
      }
    }
  });

  test("a message asks to join a running turn only when it says so", () => {
    const base = { agent_id: "agent-ira", conversation_id: "conv-1", text: "use pnpm" };
    expect(FRAMES.chat_send.parse({ ...base, steer: true })).toMatchObject({ steer: true });
    expect(FRAMES.chat_send.parse(base)).not.toHaveProperty("steer");
    expect(FRAMES.chat_send.parse({ ...base, steer: "yes" })).not.toHaveProperty("steer");
  });

  test("the background passes' settings: each part optional, wrong kinds refused", () => {
    expect(FRAMES.chat_passes_set.parse({ reflection: { enabled: false } })).toEqual({ reflection: { enabled: false } });
    expect(FRAMES.chat_passes_set.parse({ learn: { enabled: true, daily_cap: 3.7 } })).toEqual({ learn: { enabled: true, daily_cap: 3 } });
    expect(FRAMES.chat_passes_set.parse({})).toEqual({});
    expect(FRAMES.chat_passes_set.parse({ learn: { daily_cap: -1 } })).toBe("learn.daily_cap must be a number, 0 or more");
    expect(FRAMES.chat_passes_set.parse({ reflection: { enabled: "yes" } })).toBe("reflection.enabled must be true or false");
    expect(FRAMES.recall_settings.parse({ enabled: true, daily_cap: 3, model: "x", tickMinutes: 5 })).toEqual({ enabled: true, daily_cap: 3 });
  });

  test("a Learn id must be one: a phone cannot name a file outside the recall folder", () => {
    for (const name of [
      "recall_grade",
      "recall_edit",
      "recall_reject",
      "recall_restore",
      "recall_forget",
      "recall_lead_dismiss",
      "recall_lead_restore",
      "recall_lead_start",
    ] as const)
      for (const id of ["../../settings", "a/b", "..", "", "x".repeat(65), 7, undefined])
        expect(FRAMES[name].parse({ id, grade: 3 })).toBe("a card or lead id required");
    expect(FRAMES.recall_reject.parse({ id: "20261010-abc123" })).toEqual({ id: "20261010-abc123" });
    expect(FRAMES.recall_edit.parse({ id: "c_1", front: "f" })).toEqual({ id: "c_1", front: "f", back: undefined, tags: undefined });
  });

  test("parsers keep today's checks", () => {
    expect(FRAMES.recall_grade.parse({ id: "c1", grade: 5 })).toBe("a grade is 1 (again) to 4 (easy)");
    expect(FRAMES.recall_grade.parse({ id: "c1", grade: 3 })).toEqual({ id: "c1", grade: 3 });
    expect(FRAMES.history_get.parse({ agent_id: "a" })).toBe("conversation_id required");
    // A payload never names its own `request_id`: the app spreads it after the frame's, and its reply would go unmatched.
    const approve = { request_id: "frame-1", agent_id: "agent-local-a", conversation_id: "c", approval_id: "approval-t1", allow: true };
    expect(FRAMES.chat_approve.parse(approve)).toEqual({
      agent_id: "agent-local-a",
      conversation_id: "c",
      approval_id: "approval-t1",
      allow: true,
      message: null,
      always: false,
    });
    expect(FRAMES.chat_answer.parse({ request_id: "frame-2", agent_id: "agent-local-a", conversation_id: "c", question_id: "q1", input: {} })).toEqual({
      agent_id: "agent-local-a",
      conversation_id: "c",
      question_id: "q1",
      input: {},
    });
    expect(FRAMES.history_get.parse({ conversation_id: "c", limit: 99999 })).toEqual({ agent_id: null, conversation_id: "c", limit: 99999, before: null });
    expect(FRAMES.history_get.parse({ conversation_id: "c", before: 400 })).toEqual({ agent_id: null, conversation_id: "c", limit: null, before: 400 });
    expect(FRAMES.memory_read.parse({ agent_id: "../etc" })).toBe("agent_id required");
    expect(FRAMES.lan_via_set.parse({ via: "bluetooth" })).toBe('via must be "tailscale" or "lan"');
    expect(FRAMES.focus_add.parse({ conversation_id: "c", action: "open" })).toBe("action must be answer or decide");
    expect(FRAMES.capture.parse({ event: "desk_switched", properties: [1] })).toEqual({ event: "desk_switched", properties: undefined });
    expect(FRAMES.gesture.parse({ gesture: { id: "d/w", kind: "move", position: { x: 1, y: 2 } } })).toEqual({
      gesture: { id: "d/w", kind: "move", position: { x: 1, y: 2 } },
    });
    expect(FRAMES.folder_complete.parse({})).toEqual({ prefix: null, home: null });
  });
});

describe("the app's side is typed by the table", () => {
  // Compile-time checks: vitest runs them as no-ops, `npm run typecheck` holds them.
  const request = <N extends RequestName>(_type: N, _payload: InputOf<N>): ReplyOf<N> | null => null;
  const send = <N extends SendName>(_frame: { type: N } & InputOf<N>): boolean => true;
  test("a request without a required field, or a send of a wrong field, does not compile", () => {
    // @ts-expect-error a grade is required
    request("recall_grade", { id: "c1" });
    request("recall_grade", { id: "c1", grade: 3 });
    request("history_get", { conversation_id: "c" }); // agent_id and limit may be left out
    const more: boolean | undefined = request("history_get", { conversation_id: "c" })?.more;
    // @ts-expect-error a focus engagement the mod does not take from the app
    send({ type: "focus_add", conversation_id: "c", action: "open" });
    send({ type: "seen_mark", conversation_id: "c" });
    expect(more).toBeUndefined();
  });
});

/** The requests and sends no module answers: what the table promises and nothing serves (the b334e02 class). */
function unhandled(modules: FrameHandlers[]): FrameName[] {
  const served = new Set(modules.flatMap((m) => Object.keys(m)));
  return parsed.filter((n) => !served.has(n));
}

describe("every frame in the table, through the real router", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-frames-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const lanStatus = {
    enabled: false,
    address: null,
    addresses: [],
    host: null,
    port: 41415,
    app_served: false,
    error: null,
    via: "lan" as const,
    tailscale: null,
  };
  const deps: ModuleDeps = {
    store: new DeskStore(),
    widgets: fakeWidgets([]),
    gestures: new GestureLog(),
    seen: new SeenStore(join(dir, "attention.json"), { debounceMs: 0 }),
    listDesks: () => [],
    listInbox: () => [],
    deleteWidgetFile: () => "gone",
    setPin: () => true,
    recentModels: { read: () => [], add: (h) => [h] },
    transcript: () => ({ rows: [], more: false, start: 0 }),
    widgetLog: () => [],
    folders: {
      recent: () => ({ by_agent: {}, by_conversation: {} }),
      complete: () => [],
      check: (path) => ({ ok: true, path, branch: null }),
      pick: () => Promise.resolve(null),
    },
    recall: {
      store: new RecallStore(join(dir, "recall")),
      status: () => ({ enabled: false, daily_cap: 5, last_run_at: null, last_run_note: null, written_today: 0 }),
      setSettings: async () => {},
      run: () => Promise.resolve({ note: "ran" }),
      startLesson: () => Promise.resolve({ agent_id: "agent-1", conversation_id: "conv-1" }),
    },
    agents: {
      get: () => ({ id: "agent-1" }) as never,
      tree: () => [],
      skills: () => [],
      hasProfile: () => false,
      read: () => null,
      log: () => Promise.resolve([]),
      diff: () => Promise.resolve(""),
      reflection: () => Promise.resolve({ last_commit: null }),
      globalSkills: () => [],
      install: () => Promise.resolve("ok"),
      refreshSkill: () => Promise.resolve({ outcome: "current", label: "x" }),
    },
    lan: {
      status: () => lanStatus,
      refresh: () => Promise.resolve(lanStatus),
      setEnabled: () => Promise.resolve(lanStatus),
      setVia: () => lanStatus,
      setServe: () => Promise.resolve(lanStatus),
      pairBegin: () => ({ code: "K9HF6D", url: "http://mac.local:41415/?code=K9HF6D", expires_at: "" }),
      devices: () => [],
      forget: () => true,
    },
    peers: {
      view: () => ({ me: { mac_id: "mac-1", name: "MacBook", host: null }, peers: [] }),
      begin: () => Promise.resolve({ code: "K9HF6D", host: null, expires_at: "" }),
      join: () => Promise.reject(new Error("no Mac there")),
      forget: () => Promise.resolve(false),
      hello: () => ({ mac_id: "mac-1", name: "MacBook", build: null, protocol: 1 }),
      agents: () => ({ agents: [], tombstones: [] }),
      chats: () => ({ desks: [], inbox: [] }),
      state: () => ({ marks: {}, pins: {}, labels: {}, learn: {}, mcp: {}, mods: {} }),
      memory: (agentId) => Promise.resolve({ agent_id: agentId, bundle: null }),
    },
  };
  /** The smallest frame each entry accepts. */
  const sample: Partial<Record<FrameName, Record<string, unknown>>> = {
    gesture: { gesture: { id: "d1/w", kind: "focus" } },
    measure: { id: "d1/w", size: { w: 1, h: 1 } },
    trash: { id: "d1/w" },
    widget_status: { id: "d1/w", error: null },
    desk_get: { scope: "d1" },
    pin_set: { agent_id: "agent-1", conversation_id: "conv-1", pinned: true },
    models_recent_add: { handle: "m" },
    seen_mark: { conversation_id: "conv-1" },
    seen_unmark: { conversation_id: "conv-1" },
    viewed_mark: { conversation_id: "conv-1" },
    focus_add: { conversation_id: "conv-1", action: "answer" },
    card_rest: { conversation_id: "conv-1", rest: { n: 1, until: "2026-10-20T09:10:00Z", stamp: "s", at: "2026-10-20T09:00:00Z" } },
    capture: { event: "frames_walked" },
    history_get: { conversation_id: "conv-1" },
    recall_grade: { id: "k", grade: 3 },
    recall_edit: { id: "k" },
    recall_reject: { id: "k" },
    recall_restore: { id: "k" },
    recall_forget: { id: "k" },
    recall_lead_dismiss: { id: "l" },
    recall_lead_restore: { id: "l" },
    recall_lead_start: { id: "l" },
    agent_get: { agent_id: "agent-1" },
    memory_read: { agent_id: "agent-1", path: "a.md" },
    memory_log: { agent_id: "agent-1" },
    memory_diff: { agent_id: "agent-1", sha: "abc" },
    reflection_state: { agent_id: "agent-1" },
    skill_install: { agent_id: "agent-1", source: "x" },
    skill_refresh: { agent_id: "agent-1", name: "x" },
    lan_via_set: { via: "lan" },
    peer_pair_join: { host: "mini.tail1234.ts.net", code: "K9HF6D" },
    peer_forget: { mac_id: "mac-2" },
    suggestion_decide: { agent_id: "agent-local-a", conversation_id: "conv-1", suggestion_id: "sugg-1", action: "reject" },
    suggestion_retarget: { agent_id: "agent-local-a", conversation_id: "conv-1", suggestion_id: "sugg-1", target: { agent_id: "agent-local-a", folder: "/w" } },
    suggestion_add: { agent_id: "agent-local-a", conversation_id: "conv-1", title: "t", text: "x", target: { agent_id: "agent-local-a", folder: "/w" } },
  };

  test("every request and send is answered by exactly one module, and a missing one is caught", () => {
    const modules = frameModules(deps);
    expect(unhandled(modules)).toEqual([]);
    expect(() => bridgeOf({ ...deps, modules })).not.toThrow(); // the router refuses two handlers for one frame
    const withoutFolders = modules.filter((m) => !("folder_pick" in m));
    expect(unhandled(withoutFolders)).toEqual(["folders_get", "folder_complete", "folder_check", "folder_pick"]);
  });

  test("every request is answered with its request_id: its reply under the table's name, or error", async () => {
    const bridge = bridgeOf(deps);
    for (const n of parsed.filter((x) => FRAMES[x].kind === "request")) {
      const c = client("d1");
      bridge.onMessage(c, { type: n, request_id: `r-${n}`, ...sample[n] });
      await settled();
      const answer = c.sent.at(-1);
      expect([n, answer?.request_id, [(FRAMES[n] as { reply: string }).reply, "error"].includes(String(answer?.type))]).toEqual([n, `r-${n}`, true]);
    }
  });

  test("a send's smallest frame goes through without an error", async () => {
    const bridge = bridgeOf(deps);
    for (const n of parsed.filter((x) => FRAMES[x].kind === "send")) {
      const c = client("d1");
      bridge.onMessage(c, { type: n, ...sample[n] });
      await settled();
      expect([n, c.sent.some((f) => f.type === "error")]).toEqual([n, false]);
    }
  });

  test("a paired phone is refused every frame the table does not mark for it", () => {
    const bridge = bridgeOf(deps);
    for (const n of parsed.filter((x) => !PHONE_FRAMES.has(x))) {
      const phone = client("d1", "dev-1");
      bridge.onMessage(phone, { type: n, request_id: "p", ...sample[n] });
      expect([n, phone.sent.at(-1)]).toEqual([n, { type: "error", request_id: "p", message: `${n} is not available on the phone` }]);
    }
  });

  test("a paired Mac is refused every frame the table does not mark for Macs", () => {
    const bridge = bridgeOf(deps);
    for (const n of parsed.filter((x) => !PEER_FRAMES.has(x))) {
      const mac = client("d1", undefined, "mac-2");
      bridge.onMessage(mac, { type: n, request_id: "m", ...sample[n] });
      expect([n, mac.sent.at(-1)]).toEqual([n, { type: "error", request_id: "m", message: `${n} is not available to another Mac` }]);
    }
  });
});

describe("how the app reads a request's answer", () => {
  test("a reply is ok, an error frame carries the mod's message at once, and silence is a timeout", async () => {
    const { requestResult } = await import("../core/frames.ts");
    expect(requestResult({ type: "folder_matches", request_id: "r1", matches: ["/a"] })).toEqual({
      ok: true,
      reply: { type: "folder_matches", request_id: "r1", matches: ["/a"] } as never,
    });
    expect(requestResult({ type: "error", request_id: "r1", message: "skill_install is not available on the phone" })).toEqual({
      ok: false,
      error: "skill_install is not available on the phone",
      timed_out: false,
    });
    expect(requestResult({ type: "error", request_id: "r1" })).toEqual({ ok: false, error: "the mod refused", timed_out: false });
    expect(requestResult(null)).toEqual({ ok: false, error: "no answer from the mod", timed_out: true });
  });
});

describe("a parser that throws", () => {
  test("is answered like any failure: the request still gets error with its request_id", () => {
    const bridge = bridgeOf();
    const c = client("d1");
    // A field that throws when the parser reads it.
    const frame = Object.defineProperty({ type: "history_get", request_id: "r1" }, "conversation_id", {
      get: () => {
        throw new Error("a field that cannot be read");
      },
    });
    bridge.onMessage(c, frame);
    expect(c.sent.at(-1)).toMatchObject({ type: "error", request_id: "r1" });
  });
});

describe("frames: suggestions (plan 047)", () => {
  const parse = (name: keyof typeof FRAMES, m: Record<string, unknown>) =>
    (FRAMES[name] as unknown as { parse: (m: Record<string, unknown>) => unknown }).parse(m);
  const chat = { agent_id: "agent-local-a", conversation_id: "c" };

  test("a decision is send, draft or reject on one suggestion of the chat it names", () => {
    expect(parse("suggestion_decide", { ...chat, suggestion_id: "sugg-1", action: "draft" })).toEqual({ ...chat, suggestion_id: "sugg-1", action: "draft" });
    expect(parse("suggestion_decide", { ...chat, suggestion_id: "sugg-1", action: "archive" })).toBe("action must be send, draft or reject");
    expect(parse("suggestion_decide", { ...chat, action: "send" })).toBe("suggestion_id required");
  });

  test("a re-point names an existing chat, or an agent and a folder for a new one", () => {
    const existing = { agent_id: "agent-local-b", conversation_id: "conv-2" };
    expect(parse("suggestion_retarget", { ...chat, suggestion_id: "s", target: existing })).toEqual({ ...chat, suggestion_id: "s", target: existing });
    expect(parse("suggestion_retarget", { ...chat, suggestion_id: "s", target: { agent_id: "agent-local-b", folder: "/w", extra: 1 } })).toEqual({
      ...chat,
      suggestion_id: "s",
      target: { agent_id: "agent-local-b", folder: "/w" },
    });
    expect(parse("suggestion_retarget", { ...chat, suggestion_id: "s", target: { agent_id: "agent-local-b" } })).toBe(
      "target needs agent_id and a conversation_id or a folder",
    );
  });

  test("an add names the chat, a title, a text and a target; the phone may not send one", () => {
    const target = { agent_id: "agent-local-b", folder: "/w" };
    expect(parse("suggestion_add", { ...chat, title: "Fix it", text: "Fix the lock test", target })).toEqual({
      ...chat,
      title: "Fix it",
      text: "Fix the lock test",
      target,
    });
    expect(parse("suggestion_add", { ...chat, title: " ", text: "x", target })).toBe("title and text required");
    expect(parse("suggestion_add", { ...chat, title: "t", text: "x", target: {} })).toBe("target needs agent_id and a conversation_id or a folder");
    expect(FRAMES.suggestion_add.phone).toBe(false);
  });
});

describe("frames: approvals and MCP settings", () => {
  const parse = (name: keyof typeof FRAMES, m: Record<string, unknown>) =>
    (FRAMES[name] as unknown as { parse: (m: Record<string, unknown>) => unknown }).parse(m);
  const chat = { agent_id: "agent-local-a", conversation_id: "c" };

  test("an approval carries 'always' only when it says so", () => {
    expect(parse("chat_approve", { ...chat, approval_id: "approval-t1", allow: true, always: true })).toMatchObject({ allow: true, always: true });
    expect(parse("chat_approve", { ...chat, approval_id: "approval-t1", allow: true, always: "yes" })).toMatchObject({ always: false });
    expect(parse("chat_approvals_set", { tool: "bash", on: false })).toEqual({ tool: "bash", on: false });
    expect(parse("chat_approvals_set", { tool: "bash" })).toBe("tool and on required");
  });

  test("an MCP server edit is a local or a remote server, or null to remove; anything else is refused before the daemon", () => {
    expect(parse("chat_mcp_server", { entry: "gh", edit: { command: "x", args: ["a", 1], env: { T: "v" } } })).toEqual({
      entry: "gh",
      edit: { command: "x", args: ["a"], env: { T: "v" }, cwd: null },
      rename: null,
    });
    expect(parse("chat_mcp_server", { entry: "gh", edit: { url: "https://x", headers: { A: "1" } }, rename: "github" })).toEqual({
      entry: "gh",
      edit: { url: "https://x", headers: { A: "1" } },
      rename: "github",
    });
    expect(parse("chat_mcp_server", { entry: "gh", edit: null })).toEqual({ entry: "gh", edit: null, rename: null });
    expect(parse("chat_mcp_server", { entry: "gh", edit: { command: "x", env: { T: 1 } } })).toBe("env must map names to strings");
    expect(parse("chat_mcp_server", { entry: "gh", edit: {} })).toBe("a server needs a command or a url");
    expect(parse("chat_mcp_server", { entry: " ", edit: null })).toBe("entry required");
    expect(parse("chat_mcp_agent", { agent_id: "agent-local-a", server: "gh", on: true })).toEqual({ agent_id: "agent-local-a", server: "gh", on: true });
    expect(parse("chat_mcp_secret", { name: "gh.T", value: "" })).toBe("name and value required");
  });

  test("none of the MCP or always-allow frames reach a phone", () => {
    for (const n of ["chat_mcp_get", "chat_mcp_server", "chat_mcp_secret", "chat_mcp_agent", "chat_approvals_set"] as const)
      expect(PHONE_FRAMES.has(n)).toBe(false);
  });
});

describe("deleting an agent while a paired Mac is out of reach", () => {
  test("is refused with the reason, and the backend is never asked", async () => {
    const asked: string[] = [];
    const bridge = bridgeOf({
      chat: { deleteAgent: (id: string) => (asked.push(id), Promise.resolve()) } as never,
      agentDeleteBlocked: () => "Mac mini is out of reach: delete this agent once it is back, so its chats there go too",
    });
    const c = client("d1");
    bridge.onMessage(c, { type: "chat_agent_delete", request_id: "r1", agent_id: "agent-1" });
    await settled();
    expect(c.sent.at(-1)).toEqual({
      type: "error",
      request_id: "r1",
      message: "Mac mini is out of reach: delete this agent once it is back, so its chats there go too",
    });
    expect(asked).toEqual([]);
  });
});

describe("how each frame crosses between Macs (plan 023, addendum C)", () => {
  const by = (route: string | undefined) => names.filter((n) => peerMeaning(n) && peerMeaning(n)?.route === route).sort();

  test("the catalog: what is routed by chat, desk or home, what only Macs send each other, and what is relayed", () => {
    expect(by("chat")).toEqual([
      "chat_abort",
      "chat_answer",
      "chat_approve",
      "chat_folder",
      "chat_model",
      "chat_move",
      "chat_open",
      "chat_send",
      "chat_update",
      "history_get",
      "history_step_get",
      "suggestion_add",
      "suggestion_decide",
      "suggestion_retarget",
    ]);
    expect(by("scope")).toEqual(["desk_get", "gesture", "measure", "widget_status"]);
    expect(by("home")).toEqual(["chat_requirements", "folder_check", "folder_complete", "folders_get"]);
    expect(by("new-chat")).toEqual(["chat_create"]);
    expect(names.filter((n) => pushMeaning(n)?.relay === "chat")).toEqual(["chat_event"]);
    expect(names.filter((n) => pushMeaning(n)?.relay === "scope").sort()).toEqual(["desk", "state", "widget_change", "widgets"]);
  });

  test("a frame only Macs send each other is a peer_ frame; the rest of those are Settings' own, never a Mac's", () => {
    const settings = ["peer_forget", "peer_pair_begin", "peer_pair_join"];
    expect(by(undefined)).toEqual(names.filter((n) => n.startsWith("peer_") && FRAMES[n].kind !== "push" && !settings.includes(n)).sort());
    for (const n of settings) expect(peerMeaning(n), n).toBeNull();
  });

  test("a frame routed by its chat is refused without one, so it is never sent on to no Mac", () => {
    for (const n of by("chat")) {
      const entry = FRAMES[n];
      if (entry.kind === "push") continue;
      expect(typeof entry.parse({ type: n, agent_id: "agent-local-1", to: "mac" }), n).toBe("string");
    }
  });

  test("the pushes that change how chats are listed, and the chat events that do", () => {
    expect(names.filter((n) => pushMeaning(n)?.lists === true).sort()).toEqual(["agents_changed", "chat_left", "desks", "seen"]);
    expect(pushMeaning("chat_event")?.lists).toEqual(["loop", "turn_end", "approval", "question", "error", "device"]);
    expect(peerMeaning("chat_move")).toMatchObject({ relists: true, timeout_ms: 180_000 });
    expect(peerMeaning("peers_get")).toBeNull();
    expect(peerMeaning("nonsense")).toBeNull();
  });
});
