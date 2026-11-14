import { describe, expect, test } from "vitest";
import {
  DESK_NAME_MAX,
  SIDEBAR_KEY,
  canArchive,
  canMove,
  canPin,
  canRename,
  cleanDeskName,
  deskRowState,
  doneAction,
  loadSidebar,
  offscreenWaits,
  parseSidebar,
  saveSidebar,
  sidebarModel,
  toggleFold,
  moveTargets,
  homeMark,
  chatSources,
  sourceRows,
  openIn,
  stepChat,
  sourceHolds,
} from "../app/src/shell/sidebar-model.ts";

import type { AttentionItem } from "../core/attention/model.ts";
import type { DeskSummary } from "../core/frame-types.ts";
import { must } from "./fixtures/must.ts";
import { outsideItem } from "./fixtures/outside-item.ts";

/**
 * The desk sidebar's model (app/src/shell/sidebar-model.ts, plan 013 U4): Pinned, then one section per agent
 * by recent activity, each live desk once, the agent's main chat first; the filter; the marks; the pin and
 * archive rules; the "needs you" pills; and what survives a reload. Since plan 2026-11-14-1330 (U3) the same rules
 * give Chats' sources in the sidebar and each source's rows in the list.
 */

const desk = (scope: string, over: Partial<DeskSummary> = {}): DeskSummary => ({
  scope,
  title: scope,
  status: "live",
  agent_name: "friday",
  agent_id: "a1",
  conversation_id: scope,
  model: null,
  reasoning_effort: null,
  pinned: false,
  widgets: 0,
  active: false,
  last_active: "2026-09-08T10:00:00Z",
  ...over,
});
const item = (agentId: string, id: string, status: AttentionItem["status"], over: Partial<AttentionItem> = {}): AttentionItem =>
  ({ id, agent_id: agentId, status, unread: false, ...over }) as unknown as AttentionItem;

const desks = [
  desk("default-a1", { conversation_id: "default", title: "friday", last_active: "2026-09-01T09:00:00Z" }),
  desk("jira", { last_active: "2026-09-08T12:00:00Z" }),
  desk("email", { pinned: true, last_active: "2026-09-07T09:00:00Z" }),
  desk("aws", { last_active: "2026-09-08T11:00:00Z" }),
  desk("default-a2", { agent_id: "a2", agent_name: "ira", conversation_id: "default", title: "ira", last_active: "2026-09-09T08:00:00Z" }),
  desk("notes", { agent_id: "a2", agent_name: "ira", title: "Meeting notes", last_active: "2026-09-02T08:00:00Z" }),
  desk("gone", { status: "archived", title: "Old spike" }),
  desk("dead", { status: "deleted", title: "Deleted one" }),
  desk("shared", { title: "shared sheet", agent_id: null, agent_name: null, conversation_id: null }),
];
const scopes = (rows: Array<{ desk: DeskSummary }>) => rows.map((r) => r.desk.scope);

describe("sections (scenario 1)", () => {
  test("Pinned first, then one section per agent by most recent activity; a pinned desk only under Pinned", () => {
    const m = sidebarModel(desks, [], {});
    expect(m.sections.map((s) => [s.id, s.title, scopes(s.rows)])).toEqual([
      ["pinned", "Pinned", ["email"]],
      ["agent:a2", "ira", ["default-a2", "notes"]], // ira's main chat is the most recent activity
      ["agent:a1", "friday", ["default-a1", "jira", "aws"]],
    ]);
  });
  test("every live desk appears once; the shared sheet and archived or deleted desks stay out of the live sections", () => {
    const m = sidebarModel(desks, [], {});
    const all = m.sections.flatMap((s) => scopes(s.rows));
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(["aws", "default-a1", "default-a2", "email", "jira", "notes"]);
    expect(scopes(m.archived)).toEqual(["gone", "dead"]);
  });
  test("the main chat leads its agent's section even when older, and is flagged as the main chat", () => {
    const s = must(
      sidebarModel(desks, [], {}).sections.find((x) => x.id === "agent:a1"),
      "the agent:a1 section",
    );
    expect(s.rows[0].main).toBe(true);
    expect(s.rows.slice(1).every((r) => !r.main)).toBe(true);
  });
  test("no pinned desks: no Pinned section; an agent named only by the server list gets its name", () => {
    const m = sidebarModel([desk("x", { agent_name: null, agent_id: "a9" })], [], { agents: [{ id: "a9", name: "nova" }] });
    expect(m.sections.map((s) => [s.id, s.title])).toEqual([["agent:a9", "nova"]]);
  });
  test("the current desk is marked", () => {
    const m = sidebarModel(desks, [], { current: "jira" });
    const rows = m.sections.flatMap((s) => s.rows);
    expect(rows.filter((r) => r.current).map((r) => r.desk.scope)).toEqual(["jira"]);
  });
});

describe("the filter (scenario 2)", () => {
  test("matches desk titles, case-insensitively", () => {
    const m = sidebarModel(desks, [], { query: "  MEETING " });
    expect(m.sections.map((s) => [s.id, scopes(s.rows)])).toEqual([["agent:a2", ["notes"]]]);
    expect(m.empty).toBe(false);
  });
  test("matches agent names: the whole agent's desks, pinned ones under Pinned", () => {
    const m = sidebarModel(desks, [], { query: "Friday" });
    expect(m.sections.map((s) => [s.id, scopes(s.rows)])).toEqual([
      ["pinned", ["email"]],
      ["agent:a1", ["default-a1", "jira", "aws"]],
    ]);
  });
  test("the filter reaches the archive too", () => {
    expect(scopes(sidebarModel(desks, [], { query: "spike" }).archived)).toEqual(["gone"]);
  });
  test("nothing matches: empty, so the sidebar shows its empty state with a clear action", () => {
    const m = sidebarModel(desks, [], { query: "zzz" });
    expect(m.sections).toEqual([]);
    expect(m.archived).toEqual([]);
    expect(m.empty).toBe(true);
  });
});

describe("Chats' sources in the sidebar (plan 2026-11-14-1330, R4)", () => {
  test("Pinned, then each agent with what waits on it, an agent with no chats too, then Archived", () => {
    const sources = chatSources(
      desks,
      [item("a1", "jira", "approval"), item("a1", "email", "question")],
      [
        { id: "a1", name: "friday" },
        { id: "a2", name: "ira" },
        { id: "a3", name: "nova" },
      ],
    );
    expect(sources.map((s) => [s.id, s.title, s.waiting])).toEqual([
      ["pinned", "Pinned", 1],
      ["agent:a2", "ira", 0],
      ["agent:a1", "friday", 1],
      ["agent:a3", "nova", 0],
      ["archived", "Archived", 0],
    ]);
    expect(sources.find((s) => s.id === "agent:a3")?.agentId).toBe("a3");
  });

  test("every chat lists under agent headings, Pinned first; one agent's chats have none and leave its pinned ones to Pinned", () => {
    const all = sourceRows(desks, [], { source: "all" });
    expect(all.map((r) => [r.section, r.desk.scope])).toEqual([
      ["Pinned", "email"],
      ["ira", "default-a2"],
      ["ira", "notes"],
      ["friday", "default-a1"],
      ["friday", "jira"],
      ["friday", "aws"],
    ]);
    const friday = sourceRows(desks, [], { source: "agent:a1" });
    expect(friday.map((r) => [r.section, r.desk.scope])).toEqual([
      [undefined, "default-a1"],
      [undefined, "jira"],
      [undefined, "aws"],
    ]);
    expect(scopes(sourceRows(desks, [], { source: "pinned" }))).toEqual(["email"]);
    expect(scopes(sourceRows(desks, [], { source: "archived" }))).toEqual(["gone", "dead"]);
    expect(scopes(sourceRows([...desks, desk("shared", { status: "none" })], [], { source: "archived" }))).toEqual(["gone", "dead"]);
    expect(sourceRows(desks, [], { source: "agent:a3" })).toEqual([]);
  });

  test("label:infra in Search filters the chosen source's rows only", () => {
    const labelled = [
      desk("deploy", { labels: ["infra"] }),
      desk("bill", { labels: ["billing"] }),
      desk("notes", { agent_id: "a2", agent_name: "ira", labels: ["infra"] }),
    ];
    expect(scopes(sourceRows(labelled, [], { source: "agent:a1", query: "label:infra" }))).toEqual(["deploy"]);
    expect(scopes(sourceRows(labelled, [], { source: "all", query: "label:infra" }))).toEqual(["deploy", "notes"]);
  });
});

describe("opening a chat from outside the list chooses its source (KTD8, R7)", () => {
  const at = (source: string, query = "") => ({ source, query });
  test("an unpinned chat of ira's opened while Pinned shows: the source becomes ira (AE3)", () => {
    expect(openIn({ scope: "notes", agent_id: "a2" }, at("pinned"), desks)).toEqual({ source: "agent:a2", query: "" });
  });
  test("an archived chat selects Archived; a pinned one while an agent shows selects Pinned", () => {
    expect(openIn({ scope: "gone", agent_id: "a1" }, at("agent:a1"), desks).source).toBe("archived");
    expect(openIn({ scope: "email", agent_id: "a1" }, at("agent:a1"), desks).source).toBe("pinned");
  });
  test("a source that holds the chat stays, every chat's included", () => {
    expect(openIn({ scope: "jira", agent_id: "a1" }, at("all"), desks).source).toBe("all");
    expect(openIn({ scope: "jira", agent_id: "a1" }, at("agent:a1"), desks).source).toBe("agent:a1");
  });
  test("a Search that hides the chat is cleared; one that shows it stays", () => {
    expect(openIn({ scope: "jira", agent_id: "a1" }, at("all", "aws"), desks)).toEqual({ source: "all", query: "" });
    expect(openIn({ scope: "aws", agent_id: "a1" }, at("all", "aws"), desks)).toEqual({ source: "all", query: "aws" });
  });
  test("a chat not listed yet, just made, goes under its agent", () => {
    expect(openIn({ scope: "fresh", agent_id: "a2" }, at("pinned"), desks).source).toBe("agent:a2");
  });
});

describe("choosing another source (KTD8)", () => {
  const jira = desks[1];
  test("a source that holds the open chat keeps it selected; one that does not leaves the detail with No Chat Selected", () => {
    expect(["all", "agent:a1"].map((x) => sourceHolds(x, jira))).toEqual([true, true]);
    expect(["pinned", "agent:a2", "archived"].map((x) => sourceHolds(x, jira))).toEqual([false, false, false]);
    expect(sourceHolds("archived", desks[6])).toBe(true);
    expect(sourceHolds("all", desks[6])).toBe(false);
    // The canvas's shared scope has no conversation: it is in no source, the archive included.
    expect(sourceHolds("archived", desk("shared", { status: "none", conversation_id: null }))).toBe(false);
  });
});

describe("⌘[ and ⌘] step the list's visible rows (R16)", () => {
  test("⌘] goes to the next row the list shows, skipping rows the Search hides, and wraps", () => {
    const chats = [
      desk("deploy", { labels: ["infra"], last_active: "2026-09-08T12:00:00Z" }),
      desk("bill", { last_active: "2026-09-08T11:00:00Z" }),
      desk("ops", { labels: ["infra"], last_active: "2026-09-08T10:00:00Z" }),
    ];
    const ids = scopes(sourceRows(chats, [], { source: "agent:a1", query: "label:infra" }));
    expect(ids).toEqual(["deploy", "ops"]);
    expect(stepChat(ids, "deploy", 1)).toBe("ops");
    expect(stepChat(ids, "ops", 1)).toBe("deploy");
    expect(stepChat(ids, "deploy", -1)).toBe("ops");
  });
  test("with nothing selected ⌘] takes the first row and ⌘[ the last; an empty list goes nowhere", () => {
    expect(stepChat(["x", "y", "z"], null, 1)).toBe("x");
    expect(stepChat(["x", "y", "z"], "gone", -1)).toBe("z");
    expect(stepChat([], null, 1)).toBeNull();
  });
});

describe("marks (scenario 3)", () => {
  test("waiting: a red badge of one, named by what it waits for", () => {
    const s = deskRowState(item("a1", "jira", "approval"), desk("jira"));
    expect(s).toMatchObject({ kind: "waits", badge: 1, badgeNoun: "needs approval", unread: true, live: false });
    expect(deskRowState(item("a1", "jira", "question"), desk("jira")).badgeNoun).toBe("asked you");
  });
  test("finished unread: bold, no badge", () => {
    expect(deskRowState(item("a1", "jira", "done", { unread: true }), desk("jira"))).toMatchObject({
      kind: "finished",
      badge: null,
      unread: true,
      live: false,
    });
  });
  test("finished, looked at since the last message: neither bold nor ringed, though the Inbox still holds it", () => {
    const fresh = deskRowState(
      item("a1", "jira", "done", { unread: true, last_message_at: "2026-09-08T10:00:00Z", viewedAt: "2026-09-08T09:00:00Z" }),
      desk("jira"),
    );
    expect(fresh).toMatchObject({ kind: "finished", unread: true, note: "new messages" });
    const looked = deskRowState(
      item("a1", "jira", "done", { unread: true, last_message_at: "2026-09-08T10:00:00Z", viewedAt: "2026-09-08T10:05:00Z" }),
      desk("jira"),
    );
    expect(looked).toMatchObject({ kind: "finished", badge: null, unread: false });
    expect(looked.note).toBeUndefined();
    // waiting stays bold with its badge whatever the look: it needs you to act
    expect(
      deskRowState(item("a1", "jira", "approval", { unread: true, last_message_at: "2026-09-08T10:00:00Z", viewedAt: "2026-09-08T10:05:00Z" }), desk("jira")),
    ).toMatchObject({ kind: "waits", badge: 1, unread: true });
    // done: neither
    expect(deskRowState(item("a1", "jira", "idle", { unread: false, last_message_at: "2026-09-08T10:00:00Z" }), desk("jira"))).toMatchObject({
      kind: "none",
      unread: false,
      note: undefined,
    });
  });
  test("doneAction: Mark as done while unread, Mark as not done once done with a reply, nothing for approvals or your own last word", () => {
    expect(doneAction(item("a1", "jira", "done", { unread: true }))).toBe("done");
    expect(doneAction(item("a1", "jira", "question", { unread: true }))).toBe("done");
    expect(doneAction(item("a1", "jira", "idle", { unread: false, lastRole: "assistant", last_message_at: "2026-09-08T10:00:00Z" }))).toBe("undone");
    expect(doneAction(item("a1", "jira", "idle", { unread: false, lastRole: "user", last_message_at: "2026-09-08T10:00:00Z" }))).toBeNull();
    expect(doneAction(item("a1", "jira", "approval", { unread: true, pendingApproval: { requestId: "r" } as AttentionItem["pendingApproval"] }))).toBeNull();
    expect(doneAction(undefined)).toBeNull();
  });
  test("running: the live dot", () => {
    expect(deskRowState(item("a1", "jira", "running"), desk("jira"))).toMatchObject({ kind: "running", badge: null, unread: false, live: true });
  });
  test("nothing known: plain", () => {
    expect(deskRowState(undefined, desk("jira"))).toMatchObject({ kind: "none", badge: null, unread: false, live: false });
  });
  test("the model looks each desk's item up by agent and conversation, and a section counts what waits", () => {
    const m = sidebarModel(desks, [item("a1", "jira", "approval"), item("a2", "jira", "running"), item("a1", "aws", "running")], {});
    const a1 = must(
      m.sections.find((s) => s.id === "agent:a1"),
      "the agent:a1 section",
    );
    expect(a1.rows.map((r) => [r.desk.scope, r.kind])).toEqual([
      ["default-a1", "none"],
      ["jira", "waits"],
      ["aws", "running"],
    ]);
    expect(a1.waiting).toBe(1);
    expect(
      must(
        m.sections.find((s) => s.id === "agent:a2"),
        "the agent:a2 section",
      ).waiting,
    ).toBe(0);
  });
  test("an email or Slack thread in the Inbox is not a chat: it adds no row and marks none, even the chat it was handed to", () => {
    const base = outsideItem("Quarterly numbers");
    const facts = must(base.outside, "the thread's facts");
    const thread = { ...base, outside: { ...facts, handoff_conversation_id: "jira" } };
    expect(sidebarModel(desks, [thread], {})).toEqual(sidebarModel(desks, [], {}));
  });
});

describe("pin and archive rules (scenario 4)", () => {
  test("the main chat cannot be archived; a deleted desk cannot be archived or restored", () => {
    expect(canArchive(desk("default-a1", { conversation_id: "default" }))).toBe(false);
    expect(canArchive(desk("dead", { status: "deleted" }))).toBe(false);
    expect(canArchive(desk("jira"))).toBe(true);
    expect(canArchive(desk("gone", { status: "archived" }))).toBe(true);
    expect(canArchive(desk("x", { conversation_id: null }))).toBe(false);
  });
  test("only live desks with an agent and a conversation can be pinned", () => {
    expect(canPin(desk("dead", { status: "deleted" }))).toBe(false);
    expect(canPin(desk("gone", { status: "archived" }))).toBe(false);
    expect(canPin(desk("x", { agent_id: null }))).toBe(false);
    expect(canPin(desk("jira"))).toBe(true);
    expect(canPin(desk("default-a1", { conversation_id: "default" }))).toBe(true);
  });
});

describe("change folder rules", () => {
  test("any desk with an agent and a conversation can move, the main chat and archived ones too; not a deleted desk or the shared sheet", () => {
    expect(canMove(desk("jira"))).toBe(true);
    expect(canMove(desk("default-a1", { conversation_id: "default" }))).toBe(true);
    expect(canMove(desk("gone", { status: "archived" }))).toBe(true);
    expect(canMove(desk("dead", { status: "deleted" }))).toBe(false);
    expect(canMove(desk("shared", { conversation_id: null }))).toBe(false);
    expect(canMove(desk("x", { agent_id: null }))).toBe(false);
  });
});

describe("rename rules", () => {
  test("any desk with its own conversation can be renamed, archived ones too; not the main chat, a deleted desk or the shared sheet", () => {
    expect(canRename(desk("jira"))).toBe(true);
    expect(canRename(desk("gone", { status: "archived" }))).toBe(true);
    expect(canRename(desk("default-a1", { conversation_id: "default" }))).toBe(false);
    expect(canRename(desk("dead", { status: "deleted" }))).toBe(false);
    expect(canRename(desk("shared", { conversation_id: null }))).toBe(false);
  });
  test("a name is trimmed, its runs of whitespace (a pasted newline) made one space, and capped; blank is no name", () => {
    expect(cleanDeskName("  Q3 plan  ")).toBe("Q3 plan");
    expect(cleanDeskName("Q3\n  plan\tdraft")).toBe("Q3 plan draft");
    expect(cleanDeskName("")).toBeNull();
    expect(cleanDeskName("   \n ")).toBeNull();
    const long = "x".repeat(DESK_NAME_MAX + 20);
    expect(cleanDeskName(long)).toBe("x".repeat(DESK_NAME_MAX));
    // Capping never leaves a trailing space behind.
    expect(cleanDeskName(`${"y".repeat(DESK_NAME_MAX - 1)} tail`)).toBe("y".repeat(DESK_NAME_MAX - 1));
  });
});

describe("the needs-you pills (scenario 5, AE4)", () => {
  const view = { top: 100, bottom: 400 };
  test("a waiting desk below the fold: the bottom pill, aimed at the nearest one below", () => {
    expect(
      offscreenWaits(
        [
          { id: "a", top: 150, bottom: 180 },
          { id: "b", top: 600, bottom: 630 },
          { id: "c", top: 450, bottom: 480 },
        ],
        view,
      ),
    ).toEqual({ up: null, down: "c" });
  });
  test("above the fold: the top pill, aimed at the nearest one above", () => {
    expect(
      offscreenWaits(
        [
          { id: "a", top: 10, bottom: 40 },
          { id: "b", top: 50, bottom: 80 },
        ],
        view,
      ),
    ).toEqual({ up: "b", down: null });
  });
  test("in view or partly in view: no pill; both sides at once: both pills", () => {
    expect(
      offscreenWaits(
        [
          { id: "a", top: 390, bottom: 420 },
          { id: "b", top: 80, bottom: 110 },
        ],
        view,
      ),
    ).toEqual({ up: null, down: null });
    expect(
      offscreenWaits(
        [
          { id: "a", top: 0, bottom: 30 },
          { id: "b", top: 500, bottom: 530 },
        ],
        view,
      ),
    ).toEqual({ up: "a", down: "b" });
    expect(offscreenWaits([], view)).toEqual({ up: null, down: null });
  });
});

describe("what survives a reload (scenario 6)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  test("the folded places round-trip under loki.desktop.sidebar; the list keeps its own scroll", () => {
    const store = memory();
    saveSidebar(store, { collapsed: ["desk"] });
    expect(SIDEBAR_KEY).toBe("loki.desktop.sidebar");
    expect(store.m.has(SIDEBAR_KEY)).toBe(true);
    expect(loadSidebar(store)).toEqual({ collapsed: ["desk"] });
  });
  test("missing or broken: everything open; an older save's archive fold and scroll are dropped", () => {
    const fresh = { collapsed: [] };
    expect(parseSidebar(null)).toEqual(fresh);
    expect(parseSidebar("{not json")).toEqual(fresh);
    expect(parseSidebar(JSON.stringify({ collapsed: [1, "pinned"], archivedOpen: true, scroll: 240 }))).toEqual({ collapsed: ["pinned"] });
  });
  test("a blocked store costs only the preference", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSidebar(blocked)).toEqual({ collapsed: [] });
    expect(() => saveSidebar(blocked, { collapsed: [] })).not.toThrow();
  });
  test("toggleFold folds and unfolds one place's sources", () => {
    const p = { collapsed: ["pinned"] };
    expect(toggleFold(p, "desk").collapsed).toEqual(["pinned", "desk"]);
    expect(toggleFold(p, "pinned").collapsed).toEqual([]);
  });
});

describe("the Chats list, rendered", () => {
  const render = async (over: Record<string, unknown>) => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ChatList } = await import("../app/src/shell/desk-sidebar.tsx");
    const noop = () => {};
    return renderToStaticMarkup(
      createElement(ChatList, {
        rows: sourceRows(desks, [item("a1", "jira", "approval")], { source: "all" }),
        source: { id: "all", title: "Chats", agentId: null },
        selected: "aws",
        shown: true,
        desks,
        items: [item("a1", "jira", "approval")],
        connected: false,
        onSelect: noop,
        onEnter: noop,
        onNew: noop,
        onPin: noop,
        onArchive: noop,
        onRename: () => Promise.resolve(null),
        query: "",
        onQuery: noop,
        ...over,
      }),
    );
  };

  test("the source's name over Search and New Chat; agent headings; the waiting row's badge; the open chat selected", async () => {
    const html = await render({});
    expect(html).toContain('aria-label="Chats"');
    expect(html).toContain('aria-label="New Chat"');
    expect(html).toContain('aria-label="Search Chats"');
    expect(html.indexOf(">Pinned<")).toBeLessThan(html.indexOf(">ira<"));
    expect(html.indexOf(">ira<")).toBeLessThan(html.indexOf(">friday<"));
    expect(html).toContain("unread, 1 needs approval</span>");
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*aws/);
    // Not connected: archive is there but disabled, with the reason.
    expect(html).toMatch(/aria-label="Archive"[^>]*disabled|disabled[^>]*aria-label="Archive"/);
    expect(html).toContain("Archiving needs loki&#x27;s daemon");
  });

  test("a chat being started leads the list as the selected New Chat row", async () => {
    const html = await render({ drafting: true });
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="New chat, not started yet"|aria-label="New chat, not started yet"[^>]*aria-current="page"/);
  });

  test("an empty source says so, with its New Chat", async () => {
    const html = await render({ rows: [], source: { id: "agent:a3", title: "nova", agentId: "a3" }, selected: null });
    expect(html).toContain("No chats with nova yet.");
    expect(html).toMatch(/<button[^>]*>New Chat<\/button>/);
  });
});

describe("the rename dialog, rendered", () => {
  test("titled Rename desk, the field holds the current name, Save waits for a change", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { RenameDesk } = await import("../app/src/desk/rename-desk.tsx");
    const html = renderToStaticMarkup(createElement(RenameDesk, { name: "Meeting notes", onClose: () => {}, onRename: () => Promise.resolve(null) }));
    expect(html).toContain('aria-label="Rename chat"');
    expect(html).toContain(">Rename chat<");
    expect(html).toContain('value="Meeting notes"');
    expect(html).toContain(`maxLength="${DESK_NAME_MAX}"`);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
  });
});

describe("moving a chat to another Mac (plan 023, addendum A1)", () => {
  const me = { mac_id: "book", name: "MacBook" };
  const macs = { me, peers: [{ mac_id: "mini", name: "Mac mini", reachable: true }] };
  const chat = { agent_id: "agent-1", conversation_id: "conv-1" };

  test("a chat here is offered to the other Macs, greyed while one is out of reach; one there, back to this Mac", () => {
    expect(moveTargets(chat, macs)).toEqual([{ mac_id: "mini", name: "Mac mini", reachable: true }]);
    expect(moveTargets(chat, { me, peers: [{ mac_id: "mini", name: "Mac mini", reachable: false }] })).toEqual([
      { mac_id: "mini", name: "Mac mini", reachable: false },
    ]);
    expect(moveTargets({ ...chat, home: "mini", reachable: true }, macs)).toEqual([{ mac_id: "book", name: "MacBook", reachable: true }]);
  });

  test("nothing to offer with no Mac paired, for a main chat, a row with no chat, or a chat whose Mac is out of reach", () => {
    expect(moveTargets(chat, { me, peers: [] })).toEqual([]);
    expect(moveTargets(chat, null)).toEqual([]);
    expect(moveTargets({ ...chat, conversation_id: "default" }, macs)).toEqual([]);
    expect(moveTargets({ agent_id: null, conversation_id: null }, macs)).toEqual([]);
    expect(moveTargets({ ...chat, home: "mini", reachable: false }, macs)).toEqual([]);
  });
});

describe("where a chat lives, in its row (plan 023)", () => {
  const BOOK = "book";
  const MINI = "mini";
  const on = (home?: string, reachable = true) => (home ? { home, home_name: home === MINI ? "Mac mini" : "MacBook", reachable } : {});

  test("a chat on its agent's Mac is not marked: its section says where the agent lives", () => {
    expect(homeMark(on(MINI), MINI, BOOK, "this Mac")).toBeNull();
    expect(homeMark(on(), BOOK, BOOK, "this Mac")).toBeNull();
  });

  test("a chat living away from its agent's Mac is, here or there; one whose Mac is asleep says so", () => {
    expect(homeMark(on(), MINI, BOOK, "this Mac")).toEqual({ kind: "away", note: "lives on this Mac, away from its agent's Mac" });
    expect(homeMark(on(MINI), BOOK, BOOK, "this Mac")).toEqual({ kind: "away", note: "lives on Mac mini, away from its agent's Mac" });
    expect(homeMark(on(MINI, false), MINI, BOOK, "this Mac")).toEqual({ kind: "asleep", note: "Mac mini is asleep or off: this chat waits for it" });
  });

  test("with no Mac paired nothing is marked; in a flat list every chat on another Mac is", () => {
    expect(homeMark(on(), undefined, undefined, "this Mac")).toBeNull();
    expect(homeMark(on(MINI), undefined, undefined, "this Mac")).toEqual({ kind: "away", note: "lives on Mac mini" });
  });
});
