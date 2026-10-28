import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Suggestion } from "../core/frame-types.ts";
import { FRAMES } from "../core/frames.ts";
import type { Forwarded, RemoteHome, Target } from "../mod/chat-router.ts";
import { Suggestions, type CallOutcome, type ChatCall, type ChatKey } from "../mod/suggestions.ts";
import { moveTasks, type BdRunner } from "../mod/task-migration.ts";
import { must } from "./fixtures/must.ts";

const FRIDAY = "agent-local-friday";
const IRA = "agent-local-ira";
const ARCHIVED = { agent_id: FRIDAY, conversation_id: "conv-archived" };
const LIVE = { agent_id: FRIDAY, conversation_id: "conv-live" };
const ON_MINI = { agent_id: IRA, conversation_id: "conv-mini" };
const key = (c: ChatKey) => `${c.agent_id}/${c.conversation_id}`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A task as `bd list --json` prints it, from the chat it was filed in. */
const task = (id: string, chat: ChatKey, extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  description: `what ${id} needs`,
  status: "open",
  priority: 2,
  metadata: { by: "agent", agent: "Friday", agent_id: chat.agent_id, conversation: chat.conversation_id, folder: `/work/${id}`, ...metadata },
  ...extra,
});

/** One chat's record, as the Mac it lives on keeps it. */
interface Chat {
  suggestions: Suggestion[];
  archived: boolean;
}

/** The suggestions of one Mac: its chats' records in memory, and its chat_update answered by un-archiving. */
function mac(chats: Record<string, Chat>) {
  let n = 0;
  const s = new Suggestions({
    records: {
      read: (agentId, conversationId) => {
        const r = chats[`${agentId}/${conversationId}`] as Chat | undefined;
        return Promise.resolve(r ? { suggestions: structuredClone(r.suggestions), archived: r.archived } : null);
      },
      write: (agentId, conversationId, suggestions) => {
        must(chats[`${agentId}/${conversationId}`], "the chat written").suggestions = structuredClone(suggestions);
        return Promise.resolve();
      },
    },
    chat: () => null,
    agentExists: () => true,
    call: (f: ChatCall): Promise<CallOutcome> => {
      if (f.type === "chat_update" && f.archived === false) must(chats[key(f)], "the chat un-archived").archived = false;
      return Promise.resolve({ ok: true, reply: {} });
    },
    push: () => {},
    newId: () => `sugg-${++n}`,
  });
  return s;
}

/**
 * This Mac with an archived and a live chat, a paired Mac (the mini) holding Ira's chat, bd answering with `listed`
 * (or failing when it is null), and a router that sends the mini's chat there while `miniOn` holds.
 */
function world(listed: () => unknown[] | null) {
  const root = mkdtempSync(join(tmpdir(), "loki-task-migration-"));
  dirs.push(root);
  const stateFile = join(root, "state", "migrations.json");
  const here: Record<string, Chat> = { [key(ARCHIVED)]: { suggestions: [], archived: true }, [key(LIVE)]: { suggestions: [], archived: false } };
  const mini: Record<string, Chat> = { [key(ON_MINI)]: { suggestions: [], archived: false } };
  const miniSuggestions = mac(mini);
  const state = { miniOn: false, bdCalls: [] as string[][] };
  const reports: string[] = [];
  const run: BdRunner = (args) => {
    state.bdCalls.push(args);
    const out = listed();
    return out === null ? Promise.reject(new Error("bd (beads) is not installed")) : Promise.resolve(JSON.stringify(out));
  };
  const route = {
    target: (msg: Record<string, unknown>): Target => (msg.conversation_id === ON_MINI.conversation_id ? { mac: "mac-mini", reachable: state.miniOn } : null),
    forward: async (home: RemoteHome, msg: Record<string, unknown>): Promise<Forwarded> => {
      if (!home.reachable) return { ok: false, message: "waiting for mini: this chat lives there" };
      // The mini answers the frame as its table parses it.
      const p = FRAMES.suggestion_add.parse(msg);
      if (typeof p === "string") return { ok: false, message: p };
      const suggestion = await miniSuggestions.add(p, { title: p.title, text: p.text, target: p.target });
      return { ok: true, reply: { type: "suggestion_added", suggestion } };
    },
  };
  const deps = {
    run,
    stateFile,
    route,
    suggestions: mac(here),
    folderOf: (c: ChatKey) => (c.conversation_id === LIVE.conversation_id ? "/work/live-folder" : null),
    report: (m: string) => reports.push(m),
  };
  const recorded = (): unknown => JSON.parse(readFileSync(stateFile, "utf8"));
  return { root, stateFile, here, mini, state, reports, deps, recorded };
}

describe("open tasks become suggestions in the chats they were filed from (plan 047, U7)", () => {
  test("AE3: a task from an archived chat becomes a suggestion there, for a new chat of the same agent and folder, and the chat comes back", async () => {
    const w = world(() => [task("lk-1", ARCHIVED)]);
    await moveTasks(w.deps);
    const chat = must(w.here[key(ARCHIVED)], "the archived chat");
    expect(chat.archived).toBe(false);
    expect(chat.suggestions).toEqual([
      expect.objectContaining({
        title: "task lk-1",
        text: "task lk-1\n\nwhat lk-1 needs",
        target: { agent_id: FRIDAY, folder: "/work/lk-1" },
        status: "pending",
      }),
    ]);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-1"] });
    // Only read: the beads store is never written.
    expect(w.state.bdCalls.every((a) => a[0] === "list")).toBe(true);
  });

  test("a second start moves nothing new", async () => {
    const w = world(() => [task("lk-1", ARCHIVED), task("lk-2", LIVE)]);
    await moveTasks(w.deps);
    await moveTasks(w.deps);
    expect(must(w.here[key(ARCHIVED)], "archived").suggestions).toHaveLength(1);
    expect(must(w.here[key(LIVE)], "live").suggestions).toHaveLength(1);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-1", "lk-2"] });
  });

  test("with bd missing nothing is moved or recorded, and a later start with bd moves them all", async () => {
    let installed = false;
    const w = world(() => (installed ? [task("lk-1", ARCHIVED), task("lk-2", LIVE)] : null));
    await moveTasks(w.deps);
    expect(must(w.here[key(LIVE)], "live").suggestions).toEqual([]);
    expect(() => readFileSync(w.stateFile)).toThrow();
    expect(w.reports.join("\n")).toContain("bd (beads) is not installed");
    installed = true;
    await moveTasks(w.deps);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-1", "lk-2"] });
  });

  test("a task whose chat lives on a Mac that is off waits for the next start; the others move", async () => {
    const w = world(() => [task("lk-1", LIVE), task("lk-3", ON_MINI)]);
    await moveTasks(w.deps);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-1"] });
    expect(must(w.mini[key(ON_MINI)], "mini's chat").suggestions).toEqual([]);
    expect(w.reports.join("\n")).toContain("lk-3");
    w.state.miniOn = true;
    await moveTasks(w.deps);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-1", "lk-3"] });
    expect(must(w.mini[key(ON_MINI)], "mini's chat").suggestions).toEqual([
      expect.objectContaining({ title: "task lk-3", target: { agent_id: IRA, folder: "/work/lk-3" } }),
    ]);
    expect(must(w.here[key(LIVE)], "live").suggestions).toHaveLength(1);
  });

  test("a closed task is not moved", async () => {
    const w = world(() => [task("lk-1", LIVE, { status: "closed" }), task("lk-2", LIVE, { status: "in_progress" })]);
    await moveTasks(w.deps);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-2"] });
  });

  test("a task whose source chat is gone is reported and not recorded, so it stays in beads", async () => {
    const w = world(() => [task("lk-1", { agent_id: FRIDAY, conversation_id: "conv-deleted" }), task("lk-2", LIVE)]);
    await moveTasks(w.deps);
    expect(w.recorded()).toEqual({ tasks_moved: ["lk-2"] });
    expect(w.reports.join("\n")).toContain("lk-1");
  });

  test("a task without a folder of its own takes its source chat's; old camelCase metadata is read", async () => {
    const w = world(() => [task("lk-1", LIVE, {}, { folder: undefined, agent_id: undefined, agentId: FRIDAY })]);
    await moveTasks(w.deps);
    expect(must(w.here[key(LIVE)], "live").suggestions[0]?.target).toEqual({ agent_id: FRIDAY, folder: "/work/live-folder" });
  });

  test("the other keys in migrations.json survive, and earlier moves are kept", async () => {
    const w = world(() => [task("lk-2", LIVE)]);
    mkdirSync(join(w.root, "state"), { recursive: true });
    writeFileSync(w.stateFile, JSON.stringify({ agents: 1, tasks_moved: ["lk-0"] }));
    await moveTasks(w.deps);
    expect(w.recorded()).toEqual({ agents: 1, tasks_moved: ["lk-0", "lk-2"] });
  });
});
