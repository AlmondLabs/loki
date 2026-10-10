import { afterAll, describe, expect, test } from "bun:test";
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
import { FRAMES, PHONE_FRAMES, frameEntry, type FrameName, type InputOf, type ReplyOf, type RequestName, type SendName } from "../core/frames.ts";

const names = Object.keys(FRAMES) as FrameName[];
const parsed = names.filter((n) => FRAMES[n].kind !== "push");

describe("the frame table", () => {
  test("a paired phone may send exactly the frames it could before the table, and the daemon's chat frames it used through the tunnel", () => {
    expect([...PHONE_FRAMES].sort() as string[]).toEqual(
      ["chat_open", "chat_approve", "chat_answer", "chat_command", "chat_create", "chat_send", "chat_abort", "chat_update", "chat_folder", "chat_model", "chat_models", "chat_agents", "capture", "list_desks", "seen_list", "seen_mark", "seen_unmark", "viewed_mark", "history_get", "inbox_list", "pin_set", "folders_get", "agent_get", "memory_read", "memory_log", "memory_diff", "recall_list", "recall_grade", "recall_reject", "recall_restore", "recall_edit", "recall_export", "recall_lead_start", "recall_lead_dismiss", "recall_lead_restore", "models_recent_add", "focus_add", "desk_get"].sort(),
    );
  });

  test("every reply the app waited for is some request's reply", () => {
    const replies = new Set(names.flatMap((n) => (FRAMES[n].kind === "request" ? [(FRAMES[n] as { reply: string }).reply] : [])));
    for (const r of ["agent", "memory_file", "memory_commits", "memory_diff", "reflection_state", "tasks", "task_created", "tasks_updated", "history", "folders", "folder_matches", "folder_status", "folder_picked", "skills_global", "skill_installed", "skill_refreshed", "inbox", "recall", "recall_card", "recall_ran", "recall_export", "recall_lesson"]) {
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
    const junk: Array<Record<string, unknown>> = [{}, { id: 7, agentId: "../x", conversationId: null, size: "big", gesture: [], grade: "3", ids: "a", properties: [1] }, { id: null, scope: "", path: {}, event: "Not An Event" }];
    for (const n of parsed) {
      const parse = (FRAMES[n] as { parse: (m: Record<string, unknown>) => unknown }).parse;
      for (const m of junk) {
        const r = parse(m);
        expect([n, typeof r === "string" || (typeof r === "object" && r !== null)]).toEqual([n, true]);
      }
    }
  });

  test("parsers keep today's checks", () => {
    expect(FRAMES.recall_grade.parse({ id: "c1", grade: 5 })).toBe("a grade is 1 (again) to 4 (easy)");
    expect(FRAMES.recall_grade.parse({ id: "c1", grade: 3 })).toEqual({ id: "c1", grade: 3 });
    expect(FRAMES.history_get.parse({ agentId: "a" })).toBe("conversationId required");
    // A payload never names its own `requestId`: the app spreads it after the frame's, and its reply would go unmatched.
    const approve = { requestId: "frame-1", agentId: "agent-local-a", conversationId: "c", approvalId: "approval-t1", allow: true };
    expect(FRAMES.chat_approve.parse(approve)).toEqual({ agentId: "agent-local-a", conversationId: "c", approvalId: "approval-t1", allow: true, message: null });
    expect(FRAMES.chat_answer.parse({ requestId: "frame-2", agentId: "agent-local-a", conversationId: "c", questionId: "q1", input: {} })).toEqual({ agentId: "agent-local-a", conversationId: "c", questionId: "q1", input: {} });
    expect(FRAMES.history_get.parse({ conversationId: "c", limit: 99999 })).toEqual({ agentId: null, conversationId: "c", limit: 99999 });
    expect(FRAMES.task_assign.parse({ ids: ["t1"], conversationId: "c" })).toBe("assign needs a conversation and a chat");
    expect(FRAMES.task_status.parse({ id: "t1", status: "open" })).toEqual({ ids: ["t1"], status: "open" });
    expect(FRAMES.task_status.parse({ id: "t1", status: "done" })).toBe("unknown status done");
    expect(FRAMES.memory_read.parse({ agentId: "../etc" })).toBe("agentId required");
    expect(FRAMES.lan_via_set.parse({ via: "bluetooth" })).toBe('via must be "tailscale" or "lan"');
    expect(FRAMES.focus_add.parse({ conversationId: "c", action: "open" })).toBe("action must be answer, decide or skip");
    expect(FRAMES.capture.parse({ event: "desk_switched", properties: [1] })).toEqual({ event: "desk_switched", properties: undefined });
    expect(FRAMES.gesture.parse({ gesture: { id: "d/w", kind: "move", position: { x: 1, y: 2 } } })).toEqual({ gesture: { id: "d/w", kind: "move", position: { x: 1, y: 2 } } });
    expect(FRAMES.folder_complete.parse({})).toEqual({ prefix: null });
  });
});

describe("the app's side is typed by the table", () => {
  // Compile-time checks: bun runs them as no-ops, `bun run typecheck` holds them.
  const request = <N extends RequestName>(_type: N, _payload: InputOf<N>): ReplyOf<N> | null => null;
  const send = <N extends SendName>(_frame: { type: N } & InputOf<N>): boolean => true;
  test("a request without a required field, or a send of a wrong field, does not compile", () => {
    // @ts-expect-error a grade is required
    request("recall_grade", { id: "c1" });
    request("recall_grade", { id: "c1", grade: 3 });
    request("history_get", { conversationId: "c" }); // agentId and limit may be left out
    const more: boolean | undefined = request("history_get", { conversationId: "c" })?.more;
    // @ts-expect-error a focus engagement the mod does not take from the app
    send({ type: "focus_add", conversationId: "c", action: "open" });
    send({ type: "seen_mark", conversationId: "c" });
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
  const lanStatus = { enabled: false, address: null, addresses: [], host: null, port: 41415, appServed: false, error: null, via: "lan" as const, tailscale: null };
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
    transcript: () => ({ rows: [], more: false }),
    widgetLog: () => [],
    folders: { recent: () => ({ byAgent: {}, byConversation: {} }), complete: () => [], check: (path) => ({ ok: true, path, branch: null }), pick: async () => null },
    recall: { store: new RecallStore(join(dir, "recall")), run: async () => ({ note: "ran" }), startLesson: async () => ({ agentId: "agent-1", conversationId: "conv-1" }) },
    tasks: { list: async () => [], create: async () => ({}), assign: async () => [], close: async () => [], setStatus: async () => [] } as never,
    agents: { get: () => ({ id: "agent-1" }) as never, tree: () => [], skills: () => [], hasProfile: () => false, read: () => null, log: async () => [], diff: async () => "", reflection: async () => ({ conversations: [], lastCommit: null }), globalSkills: () => [], install: async () => "ok", refreshSkill: async () => ({ outcome: "current", label: "x" }) },
    lan: { status: () => lanStatus, refresh: async () => lanStatus, setEnabled: async () => lanStatus, setVia: () => lanStatus, setServe: async () => lanStatus, pairBegin: () => ({ code: "K9HF6D", url: "http://mac.local:41415/?code=K9HF6D", expiresAt: "" }), devices: () => [], forget: () => true },
  };
  /** The smallest frame each entry accepts. */
  const sample: Partial<Record<FrameName, Record<string, unknown>>> = {
    gesture: { gesture: { id: "d1/w", kind: "focus" } }, measure: { id: "d1/w", size: { w: 1, h: 1 } }, trash: { id: "d1/w" }, widget_status: { id: "d1/w", error: null }, desk_get: { scope: "d1" },
    pin_set: { agentId: "agent-1", conversationId: "conv-1", pinned: true }, models_recent_add: { handle: "m" }, seen_mark: { conversationId: "conv-1" }, seen_unmark: { conversationId: "conv-1" },
    viewed_mark: { conversationId: "conv-1" }, focus_add: { conversationId: "conv-1", action: "answer" }, capture: { event: "frames_walked" }, history_get: { conversationId: "conv-1" },
    recall_grade: { id: "k", grade: 3 }, recall_edit: { id: "k" }, recall_reject: { id: "k" }, recall_restore: { id: "k" }, recall_forget: { id: "k" }, recall_lead_dismiss: { id: "l" }, recall_lead_restore: { id: "l" }, recall_lead_start: { id: "l" },
    task_assign: { ids: ["t"], conversationId: "conv-1", desk: "conv-1" }, task_status: { ids: ["t"], status: "open" }, agent_get: { agentId: "agent-1" }, memory_read: { agentId: "agent-1", path: "a.md" }, memory_log: { agentId: "agent-1" },
    memory_diff: { agentId: "agent-1", sha: "abc" }, reflection_state: { agentId: "agent-1" }, skill_install: { agentId: "agent-1", source: "x" }, skill_refresh: { agentId: "agent-1", name: "x" }, lan_via_set: { via: "lan" },
  };

  test("every request and send is answered by exactly one module, and a missing one is caught", () => {
    const modules = frameModules(deps);
    expect(unhandled(modules)).toEqual([]);
    expect(() => bridgeOf({ ...deps, modules })).not.toThrow(); // the router refuses two handlers for one frame
    const withoutFolders = modules.filter((m) => !("folder_pick" in m));
    expect(unhandled(withoutFolders)).toEqual(["folders_get", "folder_complete", "folder_check", "folder_pick"]);
  });

  test("every request is answered with its requestId: its reply under the table's name, or error", async () => {
    const bridge = bridgeOf(deps);
    for (const n of parsed.filter((x) => FRAMES[x].kind === "request")) {
      const c = client("d1");
      bridge.onMessage(c, { type: n, requestId: `r-${n}`, ...sample[n] });
      await settled();
      const answer = c.sent.at(-1);
      expect([n, answer?.requestId, [(FRAMES[n] as { reply: string }).reply, "error"].includes(String(answer?.type))]).toEqual([n, `r-${n}`, true]);
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
      bridge.onMessage(phone, { type: n, requestId: "p", ...sample[n] });
      expect([n, phone.sent.at(-1)]).toEqual([n, { type: "error", requestId: "p", message: `${n} is not available on the phone` }]);
    }
  });
});

describe("how the app reads a request's answer", () => {
  test("a reply is ok, an error frame carries the mod's message at once, and silence is a timeout", async () => {
    const { requestResult } = await import("../core/frames.ts");
    expect(requestResult({ type: "folder_matches", requestId: "r1", matches: ["/a"] })).toEqual({ ok: true, reply: { type: "folder_matches", requestId: "r1", matches: ["/a"] } as never });
    expect(requestResult({ type: "error", requestId: "r1", message: "task_create is not available on the phone" })).toEqual({ ok: false, error: "task_create is not available on the phone", timedOut: false });
    expect(requestResult({ type: "error", requestId: "r1" })).toEqual({ ok: false, error: "the mod refused", timedOut: false });
    expect(requestResult(null)).toEqual({ ok: false, error: "no answer from the mod", timedOut: true });
  });
});

describe("a parser that throws", () => {
  test("is answered like any failure: the request still gets error with its requestId", () => {
    const bridge = bridgeOf({ tasks: { list: async () => [] } as never });
    const c = client("d1");
    bridge.onMessage(c, { type: "task_status", requestId: "r1", ids: ["t"], status: { toString: 1 } });
    expect(c.sent.at(-1)).toMatchObject({ type: "error", requestId: "r1" });
  });
});
