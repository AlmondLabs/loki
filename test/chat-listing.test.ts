import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_SCOPE, backendName, type Scope } from "../core/desk-core.ts";
import type { ChatSource } from "../mod/chat-source.ts";
import type { LocalAgent } from "../core/frame-types.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ChatListing } from "../mod/chat-listing.ts";
import { DeskRegistry, type LocalConversationInfo, type LocalConversationRow } from "../mod/desks.ts";

const IRA = "agent-ira";
const HELPER = "agent-helper";
const GONE = "agent-gone";

type Chat = LocalConversationRow & { title: string | null };

let dir: string;
let rows: Chat[];
let desks: DeskRegistry;
let layouts: Scope[];
let canvases: Scope[];
let passChats: Set<string>;

/** An agent's record, and its memory folder unless `memory` is false. */
function agent(id: string, opts: { tags?: string[]; record?: boolean; memory?: boolean } = {}) {
  if (opts.record !== false)
    writeFileSync(
      join(dir, "agents", `${backendName(id)}.json`),
      JSON.stringify({ id, name: id.slice(6), model: "anthropic/claude-fable-5", tags: opts.tags ?? [] }),
    );
  if (opts.memory !== false) mkdirSync(join(dir, "memfs", id), { recursive: true });
}

function chat(conversationId: string, agentId: string, more: Partial<Chat> = {}): Chat {
  return { conversationId, agentId, archived: false, hidden: false, lastMessageAt: null, title: conversationId, ...more };
}

const source: ChatSource = {
  list: () => rows,
  info: (id, agentId): LocalConversationInfo | null => {
    const c = rows.find((r) => r.conversationId === id && (!agentId || r.agentId === agentId));
    return c
      ? {
          agentId: c.agentId,
          title: c.title,
          lastMessageAt: c.lastMessageAt,
          archived: c.archived,
          model: null,
          reasoningEffort: null,
          mode: "unrestricted",
          labels: [],
        }
      : null;
  },
  agentOf: (id) => rows.find((r) => r.conversationId === id)?.agentId ?? null,
  page: () => ({ rows: [], more: false, start: 0 }),
  step: () => null,
  since: () => ({ rows: [], lines: 0 }),
  digest: () => ({ last_role: null, last_assistant_text: null, last_ask: null }),
  folders: () => ({ recent: [], by_conversation: {}, by_agent: {} }),
};

const listing = (readAgent?: (agentId: string) => LocalAgent | null) =>
  new ChatListing({
    chats: source,
    desks,
    layouts: () => layouts,
    widgets: { entries: (scope) => canvases.filter((s) => scope === undefined || s === scope).map((s) => ({ scope: s })) },
    pins: () => new Set([`${IRA}/conv-pinned`]),
    passChats: () => (id) => passChats.has(id),
    activeScope: () => SHARED_SCOPE,
    backendDir: dir,
    readAgent,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-chat-listing-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  desks = new DeskRegistry(join(dir, "desks.json"), (id) => source.agentOf(id));
  rows = [];
  layouts = [];
  canvases = [];
  passChats = new Set();
  agent(IRA);
  agent(HELPER, { tags: ["role:subagent"] });
  agent(GONE, { record: false });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("which chats show", () => {
  test("both lists leave out hidden chats, the passes' chats, helper agents' and a deleted agent's", () => {
    rows = [chat("conv-1", IRA), chat("conv-hidden", IRA, { hidden: true }), chat("conv-pass", IRA), chat("conv-helper", HELPER), chat("conv-gone", GONE)];
    passChats.add("conv-pass");
    const l = listing();
    expect(l.desks().map((d) => d.scope)).toEqual([SHARED_SCOPE, "conv-1"]);
    expect(l.inbox().map((r) => r.id)).toEqual(["conv-1"]);
  });

  test("the chat list keeps archived chats and lessons; the inbox, open chats only, newest first", () => {
    rows = [
      chat("conv-old", IRA, { lastMessageAt: "2026-10-18T09:00:00Z" }),
      chat("conv-new", IRA, { lastMessageAt: "2026-10-19T09:00:00Z" }),
      chat("conv-archived", IRA, { archived: true }),
      chat("conv-lesson", IRA, { title: "[Learn] cron syntax" }),
    ];
    const l = listing();
    expect(l.desks().map((d) => [d.scope, d.status])).toEqual([
      [SHARED_SCOPE, "none"],
      ["conv-new", "live"],
      ["conv-old", "live"],
      ["conv-lesson", "live"],
      ["conv-archived", "archived"],
    ]);
    expect(l.inbox().map((r) => r.id)).toEqual(["conv-new", "conv-old"]);
  });

  test("a canvas left here by a chat that moved to another Mac stays out; a canvas of no chat shows", () => {
    rows = [chat("conv-moved", IRA, { hidden: true })];
    canvases = ["conv-moved", "scratch"];
    layouts = ["conv-moved"];
    const shown = listing().desks();
    expect(shown.map((d) => [d.scope, d.status, d.widgets])).toEqual([
      [SHARED_SCOPE, "none", 0],
      ["scratch", "none", 1],
    ]);
  });

  test("a pinned chat says so, with its agent's name and model", () => {
    rows = [chat("conv-pinned", IRA)];
    const [, row] = listing().desks();
    expect(row).toMatchObject({ scope: "conv-pinned", pinned: true, agent_name: "ira", agent_id: IRA, model: "anthropic/claude-fable-5" });
  });
});

describe("a list reads each agent once (plan 040)", () => {
  test("however many chats an agent has, in either list; a record changed between lists shows in the next", () => {
    rows = Array.from({ length: 30 }, (_, i) => chat(`conv-${i}`, i % 3 === 0 ? HELPER : IRA));
    for (const r of rows.slice(0, 10)) desks.remember(r.conversationId, r.agentId);
    const reads = new Map<string, number>();
    const l = listing((id) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return readLocalAgent(id, dir);
    });
    expect(l.desks()).toHaveLength(21);
    expect(Object.fromEntries(reads)).toEqual({ [IRA]: 1, [HELPER]: 1 });
    reads.clear();
    expect(l.inbox()).toHaveLength(20);
    expect(Object.fromEntries(reads)).toEqual({ [IRA]: 1, [HELPER]: 1 });

    writeFileSync(join(dir, "agents", `${backendName(IRA)}.json`), JSON.stringify({ id: IRA, name: "Ira two", model: "anthropic/claude-fable-5", tags: [] }));
    expect(new Set(l.desks().flatMap((d) => (d.agent_name ? [d.agent_name] : [])))).toEqual(new Set(["Ira two"]));
  });
});

describe("listing tidies the desks an older loki kept", () => {
  test("a helper agent's desk and a pass chat's desk are forgotten", () => {
    desks.remember("conv-helper", HELPER);
    desks.remember("conv-pass", IRA);
    passChats.add("conv-pass");
    expect(
      listing()
        .desks()
        .map((d) => d.scope),
    ).toEqual([SHARED_SCOPE]);
    expect(desks.all()).toEqual([]);
  });
});

describe("the desk_title push", () => {
  test("waits for a title, then carries what the chat list would say", () => {
    rows = [chat("conv-1", IRA, { title: null })];
    const l = listing();
    const scope = desks.remember("conv-1", IRA);
    expect(l.titleFrame(scope)).toBeNull();
    rows = [chat("conv-1", IRA, { title: "trip", archived: true })];
    expect(l.titleFrame(scope)).toEqual({
      type: "desk_title",
      scope,
      title: "trip",
      status: "archived",
      agent_name: "ira",
      model: "anthropic/claude-fable-5",
      reasoning_effort: null,
      mode: "unrestricted",
    });
  });
});
