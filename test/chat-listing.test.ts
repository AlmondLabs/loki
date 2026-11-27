import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_SCOPE, backendName, type Scope } from "../core/canvas-core.ts";
import type { ChatSource } from "../mod/chat-source.ts";
import type { FlowRow, LocalAgent } from "../core/frame-types.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { ChatListing } from "../mod/chat-listing.ts";
import { ChatRegistry, type LocalConversationInfo, type LocalConversationRow } from "../mod/chats.ts";

const IRA = "agent-ira";
const OTTO = "agent-otto";
const GONE = "agent-gone";

type Chat = LocalConversationRow & { title: string | null };

let dir: string;
let rows: Chat[];
let desks: ChatRegistry;
let layouts: Scope[];
let canvases: Scope[];
let passChats: Set<string>;
let modes: Map<string, string>;

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
          mode: modes.get(c.conversationId) ?? "unrestricted",
          labels: [],
          purpose: null,
          hasDraft: false,
          cwd: null,
        }
      : null;
  },
  agentOf: (id) => rows.find((r) => r.conversationId === id)?.agentId ?? null,
  page: () => ({ rows: [], more: false, start: 0 }),
  row: () => null,
  since: () => ({ rows: [], lines: 0 }),
  digest: () => ({ last_role: null, last_assistant_text: null, last_ask: null }),
  folders: () => ({ recent: [], by_conversation: {}, by_agent: {} }),
};

const listing = (readAgent?: (agentId: string) => LocalAgent | null, outside?: () => FlowRow[]) =>
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
    outside,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-chat-listing-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  desks = new ChatRegistry(join(dir, "chats.json"), (id) => source.agentOf(id));
  rows = [];
  layouts = [];
  canvases = [];
  passChats = new Set();
  modes = new Map();
  agent(IRA);
  agent(OTTO);
  agent(GONE, { record: false });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("which chats show", () => {
  test("both lists leave out hidden chats, the passes' chats and a deleted agent's", () => {
    rows = [chat("conv-1", IRA), chat("conv-hidden", IRA, { hidden: true }), chat("conv-pass", IRA), chat("conv-gone", GONE)];
    passChats.add("conv-pass");
    const l = listing();
    expect(l.summaries().map((d) => d.scope)).toEqual([SHARED_SCOPE, "conv-1"]);
    expect(l.flow().map((r) => r.id)).toEqual(["conv-1"]);
  });

  test("a chat's subagent chat stays out of the Chats list and Flow, even once a message to it remembered its scope", () => {
    rows = [chat("conv-1", IRA), chat("conv-1~subagent~kestrel", IRA, { hidden: true, lastMessageAt: "2026-11-22T10:00:00Z" })];
    desks.remember("conv-1~subagent~kestrel", IRA);
    const l = listing();
    expect(l.summaries().map((d) => d.scope)).toEqual([SHARED_SCOPE, "conv-1"]);
    expect(l.flow().map((r) => r.id)).toEqual(["conv-1"]);
  });

  test("the chat list keeps archived chats and lessons; the inbox, open chats only, newest first", () => {
    rows = [
      chat("conv-old", IRA, { lastMessageAt: "2026-10-18T09:00:00Z" }),
      chat("conv-new", IRA, { lastMessageAt: "2026-10-19T09:00:00Z" }),
      chat("conv-archived", IRA, { archived: true }),
      chat("conv-lesson", IRA, { title: "[Learn] cron syntax" }),
    ];
    const l = listing();
    expect(l.summaries().map((d) => [d.scope, d.status])).toEqual([
      [SHARED_SCOPE, "none"],
      ["conv-new", "live"],
      ["conv-old", "live"],
      ["conv-lesson", "live"],
      ["conv-archived", "archived"],
    ]);
    expect(l.flow().map((r) => r.id)).toEqual(["conv-new", "conv-old"]);
  });

  test("a canvas left here by a chat that moved to another Mac stays out; a canvas of no chat shows", () => {
    rows = [chat("conv-moved", IRA, { hidden: true })];
    canvases = ["conv-moved", "scratch"];
    layouts = ["conv-moved"];
    const shown = listing().summaries();
    expect(shown.map((d) => [d.scope, d.status, d.widgets])).toEqual([
      [SHARED_SCOPE, "none", 0],
      ["scratch", "none", 1],
    ]);
  });

  test("a pinned chat says so, with its agent's name and model", () => {
    rows = [chat("conv-pinned", IRA)];
    const [, row] = listing().summaries();
    expect(row).toMatchObject({ scope: "conv-pinned", pinned: true, agent_name: "ira", agent_id: IRA, model: "anthropic/claude-fable-5" });
  });
});

describe("outside cards in the inbox (plan 067)", () => {
  test("the inbox holds the accounts' open threads beside the chats, newest first; the chat list does not", () => {
    rows = [chat("conv-1", IRA, { lastMessageAt: "2026-11-04T08:00:00Z" })];
    const thread: FlowRow = {
      kind: "outside",
      id: "t1#1",
      agent_id: "account:gmail:ada@acme.com",
      agent_name: "ada@acme.com",
      title: "Quarterly numbers",
      last_message_at: "2026-11-04T09:00:00Z",
      archived: false,
      last_role: null,
      last_assistant_text: null,
      last_ask: null,
    };
    const l = listing(undefined, () => [thread]);
    expect(l.flow().map((r) => [r.kind ?? "chat", r.id])).toEqual([
      ["outside", "t1#1"],
      ["chat", "conv-1"],
    ]);
    expect(l.summaries().map((d) => d.scope)).toEqual([SHARED_SCOPE, "conv-1"]);
  });
});

describe("a list reads each agent once (plan 040)", () => {
  test("however many chats an agent has, in either list; a record changed between lists shows in the next", () => {
    rows = Array.from({ length: 30 }, (_, i) => chat(`conv-${i}`, i % 3 === 0 ? OTTO : IRA));
    for (const r of rows.slice(0, 10)) desks.remember(r.conversationId, r.agentId);
    const reads = new Map<string, number>();
    const l = listing((id) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return readLocalAgent(id, dir);
    });
    expect(l.summaries()).toHaveLength(31);
    expect(Object.fromEntries(reads)).toEqual({ [IRA]: 1, [OTTO]: 1 });
    reads.clear();
    expect(l.flow()).toHaveLength(30);
    expect(Object.fromEntries(reads)).toEqual({ [IRA]: 1, [OTTO]: 1 });

    writeFileSync(join(dir, "agents", `${backendName(IRA)}.json`), JSON.stringify({ id: IRA, name: "Ira two", model: "anthropic/claude-fable-5", tags: [] }));
    expect(new Set(l.summaries().flatMap((d) => (d.agent_name ? [d.agent_name] : [])))).toEqual(new Set(["Ira two", "otto"]));
  });
});

describe("listing tidies the desks an older loki kept", () => {
  test("a pass chat's desk is forgotten", () => {
    desks.remember("conv-pass", IRA);
    passChats.add("conv-pass");
    expect(
      listing()
        .summaries()
        .map((d) => d.scope),
    ).toEqual([SHARED_SCOPE]);
    expect(desks.all()).toEqual([]);
  });
});

describe("a chat's permission mode", () => {
  test("an ACP chat's own mode is listed as it is, not as loki's default", () => {
    rows = [chat("conv-acp", IRA)];
    modes.set("conv-acp", "plan");
    const scope = desks.remember("conv-acp", IRA);
    expect(listing().titleFrame(scope)?.mode).toBe("plan");
  });
});

describe("the chat_meta push", () => {
  test("waits for a title, then carries what the chat list would say", () => {
    rows = [chat("conv-1", IRA, { title: null })];
    const l = listing();
    const scope = desks.remember("conv-1", IRA);
    expect(l.titleFrame(scope)).toBeNull();
    rows = [chat("conv-1", IRA, { title: "trip", archived: true })];
    expect(l.titleFrame(scope)).toEqual({
      type: "chat_meta",
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
