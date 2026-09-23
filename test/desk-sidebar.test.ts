import { describe, expect, test } from "bun:test";
import { SIDEBAR_KEY, canArchive, canPin, deskRowState, loadSidebar, offscreenWaits, parseSidebar, saveSidebar, sidebarModel, toggleFold } from "../app/src/shell/sidebarModel.ts";
import type { DeskSummary } from "../app/src/desk/useDesk";
import type { AttentionItem } from "../core/attention/model.ts";

/**
 * The desk sidebar's model (app/src/shell/sidebarModel.ts, plan 013 U4): Pinned, then one section per agent
 * by recent activity, each live desk once, the agent's main chat first; the filter; the marks; the pin and
 * archive rules; the "needs you" pills; and what survives a reload.
 */

const desk = (scope: string, over: Partial<DeskSummary> = {}): DeskSummary =>
  ({ scope: scope as DeskSummary["scope"], title: scope, status: "live", agentName: "friday", agentId: "a1", conversationId: scope, model: null, reasoningEffort: null, pinned: false, widgets: 0, active: false, lastActive: "2026-09-08T10:00:00Z", ...over }) as DeskSummary;
const item = (agentId: string, id: string, status: AttentionItem["status"], over: Partial<AttentionItem> = {}): AttentionItem => ({ id, agentId, status, unread: false, snooze: null, ...over }) as unknown as AttentionItem;

const desks = [
  desk("default-a1", { conversationId: "default", title: "friday", lastActive: "2026-09-01T09:00:00Z" }),
  desk("jira", { lastActive: "2026-09-08T12:00:00Z" }),
  desk("email", { pinned: true, lastActive: "2026-09-07T09:00:00Z" }),
  desk("aws", { lastActive: "2026-09-08T11:00:00Z" }),
  desk("default-a2", { agentId: "a2", agentName: "ira", conversationId: "default", title: "ira", lastActive: "2026-09-09T08:00:00Z" }),
  desk("notes", { agentId: "a2", agentName: "ira", title: "Meeting notes", lastActive: "2026-09-02T08:00:00Z" }),
  desk("gone", { status: "archived", title: "Old spike" }),
  desk("dead", { status: "deleted", title: "Deleted one" }),
  desk("shared", { title: "shared sheet", agentId: null, agentName: null, conversationId: null }),
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
    const s = sidebarModel(desks, [], {}).sections.find((x) => x.id === "agent:a1")!;
    expect(s.rows[0].main).toBe(true);
    expect(s.rows.slice(1).every((r) => !r.main)).toBe(true);
  });
  test("no pinned desks: no Pinned section; an agent named only by the server list gets its name", () => {
    const m = sidebarModel([desk("x", { agentName: null, agentId: "a9" })], [], { agents: [{ id: "a9", name: "nova" }] });
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

describe("marks (scenario 3)", () => {
  test("waiting: a red badge of one, named by what it waits for", () => {
    const s = deskRowState(item("a1", "jira", "approval"), desk("jira"));
    expect(s).toMatchObject({ kind: "waits", badge: 1, badgeNoun: "needs approval", unread: true, live: false });
    expect(deskRowState(item("a1", "jira", "question"), desk("jira")).badgeNoun).toBe("asked you");
  });
  test("finished unread: bold, no badge", () => {
    expect(deskRowState(item("a1", "jira", "done", { unread: true }), desk("jira"))).toMatchObject({ kind: "finished", badge: null, unread: true, live: false });
  });
  test("running: the live dot", () => {
    expect(deskRowState(item("a1", "jira", "running"), desk("jira"))).toMatchObject({ kind: "running", badge: null, unread: false, live: true });
  });
  test("nothing known: plain", () => {
    expect(deskRowState(undefined, desk("jira"))).toMatchObject({ kind: "none", badge: null, unread: false, live: false });
  });
  test("the model looks each desk's item up by agent and conversation, and a section counts what waits", () => {
    const m = sidebarModel(desks, [item("a1", "jira", "approval"), item("a2", "jira", "running"), item("a1", "aws", "running")], {});
    const a1 = m.sections.find((s) => s.id === "agent:a1")!;
    expect(a1.rows.map((r) => [r.desk.scope, r.kind])).toEqual([
      ["default-a1", "none"],
      ["jira", "waits"],
      ["aws", "running"],
    ]);
    expect(a1.waiting).toBe(1);
    expect(m.sections.find((s) => s.id === "agent:a2")!.waiting).toBe(0);
  });
});

describe("pin and archive rules (scenario 4)", () => {
  test("the main chat cannot be archived; a deleted desk cannot be archived or restored", () => {
    expect(canArchive(desk("default-a1", { conversationId: "default" }))).toBe(false);
    expect(canArchive(desk("dead", { status: "deleted" }))).toBe(false);
    expect(canArchive(desk("jira"))).toBe(true);
    expect(canArchive(desk("gone", { status: "archived" }))).toBe(true);
    expect(canArchive(desk("x", { conversationId: null }))).toBe(false);
  });
  test("only live desks with an agent and a conversation can be pinned", () => {
    expect(canPin(desk("dead", { status: "deleted" }))).toBe(false);
    expect(canPin(desk("gone", { status: "archived" }))).toBe(false);
    expect(canPin(desk("x", { agentId: null }))).toBe(false);
    expect(canPin(desk("jira"))).toBe(true);
    expect(canPin(desk("default-a1", { conversationId: "default" }))).toBe(true);
  });
});

describe("the needs-you pills (scenario 5, AE4)", () => {
  const view = { top: 100, bottom: 400 };
  test("a waiting desk below the fold: the bottom pill, aimed at the nearest one below", () => {
    expect(offscreenWaits([{ id: "a", top: 150, bottom: 180 }, { id: "b", top: 600, bottom: 630 }, { id: "c", top: 450, bottom: 480 }], view)).toEqual({ up: null, down: "c" });
  });
  test("above the fold: the top pill, aimed at the nearest one above", () => {
    expect(offscreenWaits([{ id: "a", top: 10, bottom: 40 }, { id: "b", top: 50, bottom: 80 }], view)).toEqual({ up: "b", down: null });
  });
  test("in view or partly in view: no pill; both sides at once: both pills", () => {
    expect(offscreenWaits([{ id: "a", top: 390, bottom: 420 }, { id: "b", top: 80, bottom: 110 }], view)).toEqual({ up: null, down: null });
    expect(offscreenWaits([{ id: "a", top: 0, bottom: 30 }, { id: "b", top: 500, bottom: 530 }], view)).toEqual({ up: "a", down: "b" });
    expect(offscreenWaits([], view)).toEqual({ up: null, down: null });
  });
});

describe("what survives a reload (scenario 6)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  test("collapsed sections and scroll round-trip under loki.desktop.sidebar", () => {
    const store = memory();
    saveSidebar(store, { collapsed: ["agent:a1"], archivedOpen: true, scroll: 240 });
    expect(SIDEBAR_KEY).toBe("loki.desktop.sidebar");
    expect(store.m.has(SIDEBAR_KEY)).toBe(true);
    expect(loadSidebar(store)).toEqual({ collapsed: ["agent:a1"], archivedOpen: true, scroll: 240 });
  });
  test("missing or broken: the defaults (everything open, the archive folded, at the top)", () => {
    const fresh = { collapsed: [], archivedOpen: false, scroll: 0 };
    expect(parseSidebar(null)).toEqual(fresh);
    expect(parseSidebar("{not json")).toEqual(fresh);
    expect(parseSidebar(JSON.stringify({ collapsed: [1, "pinned"], archivedOpen: "yes", scroll: -5 }))).toEqual({ collapsed: ["pinned"], archivedOpen: false, scroll: 0 });
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
    expect(loadSidebar(blocked)).toEqual({ collapsed: [], archivedOpen: false, scroll: 0 });
    expect(() => saveSidebar(blocked, { collapsed: [], archivedOpen: false, scroll: 0 })).not.toThrow();
  });
  test("toggleFold folds and unfolds one section", () => {
    const p = { collapsed: ["pinned"], archivedOpen: false, scroll: 10 };
    expect(toggleFold(p, "agent:a1").collapsed).toEqual(["pinned", "agent:a1"]);
    expect(toggleFold(p, "pinned").collapsed).toEqual([]);
    expect(toggleFold(p, "pinned").scroll).toBe(10);
  });
});

describe("the sidebar, rendered", () => {
  test("Desks header with new desk and the filter; Pinned then agents; the waiting row's badge; the current row; archive folded", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DeskSidebar } = await import("../app/src/shell/DeskSidebar.tsx");
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(DeskSidebar, { desks, agents: [], items: [item("a1", "jira", "approval")], current: "aws", connected: false, onOpen: noop, onNew: noop, onPin: noop, onArchive: noop, avatar: () => null }));
    expect(html).toContain('aria-label="New desk"');
    expect(html).toContain('placeholder="Find a desk…"');
    expect(html.indexOf(">Pinned<")).toBeLessThan(html.indexOf(">ira<"));
    expect(html.indexOf(">ira<")).toBeLessThan(html.indexOf(">friday<"));
    expect(html).toContain('aria-label="New desk with friday"');
    expect(html).toContain("unread, 1 needs approval</span>");
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*aws/);
    // The archive is folded by default: its entry shows, its rows do not.
    expect(html).toContain(">Archived<");
    expect(html).not.toContain("Old spike");
    // Not connected: archive is there but disabled, with the reason.
    expect(html).toMatch(/aria-label="Archive"[^>]*disabled|disabled[^>]*aria-label="Archive"/);
    expect(html).toContain("Archiving needs the app-server");
  });
});
