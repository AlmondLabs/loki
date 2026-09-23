import { describe, expect, test } from "bun:test";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_KEY, AGENT_PAGE_LABEL, DEFAULT_AGENT_PAGE, isAgentPage } from "../app/src/agents/pages.ts";
import { firstAgentId, readingFor, shownShaOf, shownSkillOf } from "../app/src/agents/reading.ts";

/** The agent's pages (app/src/agents/pages.ts): five tabs under the desktop agent header; the phone's headings are four of them. */
describe("agent pages", () => {
  test("five pages, in this order, each with a hint", () => {
    expect(AGENT_PAGES).toEqual(["profile", "memory", "changes", "reflection", "skills"]);
    for (const p of AGENT_PAGES) expect(AGENT_PAGE_HINT[p].length).toBeGreaterThan(0);
    expect(AGENT_PAGES.map((p) => AGENT_PAGE_LABEL[p])).toEqual(["Profile", "Memory", "Changes", "Reflection", "Skills"]);
  });
  test("a first visit lands in memory; the remembered page has its own key", () => {
    expect(DEFAULT_AGENT_PAGE).toBe("memory");
    expect(AGENT_PAGE_KEY).toBe("loki.agentsPage");
    expect(AGENT_PAGE_KEY).not.toBe("loki.settingsPage");
  });
  test("isAgentPage guards what sessionStorage hands back", () => {
    expect(isAgentPage("skills")).toBe(true);
    expect(isAgentPage("global skills")).toBe(false);
    expect(isAgentPage(null)).toBe(false);
    expect(isAgentPage(3)).toBe(false);
  });
});

/** What the reading pane shows (app/src/agents/reading.ts): the picks, with their fallbacks, and the view by page. */
describe("agent reading pane", () => {
  const skills = [
    { name: "notes", path: "skills/notes/SKILL.md", origin: "self" as const },
    { name: "stocks", path: "skills/stocks/SKILL.md", origin: "other" as const },
  ] as unknown as import("../mod/skill-sources.ts").MemorySkillInfo[]; // the pure helpers only read name, path and origin
  const d = { skills } as unknown as Parameters<typeof shownSkillOf>[0];
  const log = [{ sha: "abc12345" }, { sha: "def67890" }] as Parameters<typeof shownShaOf>[1];

  test("the first agent shows with nothing picked; none with no agents", () => {
    expect(firstAgentId([{ id: "a1" }, { id: "a2" }])).toBe("a1");
    expect(firstAgentId([])).toBeNull();
  });
  test("the skill picked by name, else the first; null without an agent or skills", () => {
    expect(shownSkillOf(d, "stocks")?.name).toBe("stocks");
    expect(shownSkillOf(d, "gone")?.name).toBe("notes");
    expect(shownSkillOf(d, null)?.name).toBe("notes");
    expect(shownSkillOf(undefined, "notes")).toBeNull();
    expect(shownSkillOf({ skills: [] } as unknown as typeof d, null)).toBeNull();
  });
  test("the commit picked, else the newest; null with no commits", () => {
    expect(shownShaOf("def67890", log)).toBe("def67890");
    expect(shownShaOf(null, log)).toBe("abc12345");
    expect(shownShaOf(null, [])).toBeNull();
  });
  test("the view by page: memory reads the file, changes the commit, skills the SKILL.md, profile nothing", () => {
    expect(readingFor("memory", "system/persona.md", "abc12345", skills[0])).toEqual({ kind: "file", path: "system/persona.md" });
    expect(readingFor("changes", "system/persona.md", "abc12345", skills[0])).toEqual({ kind: "commit", sha: "abc12345" });
    expect(readingFor("changes", "system/persona.md", null, skills[0])).toBeNull();
    expect(readingFor("skills", "system/persona.md", "abc12345", skills[1])).toEqual({ kind: "file", path: "skills/stocks/SKILL.md" });
    expect(readingFor("skills", "system/persona.md", "abc12345", null)).toBeNull();
    expect(readingFor("profile", "system/persona.md", "abc12345", skills[0])).toBeNull();
  });
});

/** The chosen agent and page, shared by the Agents column and pane (app/src/agents/selection.ts, plan 013 U10). */
describe("agents selection", () => {
  const memory = (seed: Record<string, string> = {}) => {
    const m = new Map(Object.entries(seed));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  test("the page and agent are kept for the window, so a section switch (or a remount) comes back to them", async () => {
    const { createAgentsSelection, AGENT_ID_KEY } = await import("../app/src/agents/selection.ts");
    const store = memory();
    const a = createAgentsSelection(store);
    expect(a.get()).toEqual({ agent: undefined, page: "memory", creating: false });
    a.pickPage("skills");
    a.pickAgent("a2");
    expect(store.m.get(AGENT_PAGE_KEY)).toBe("skills");
    expect(store.m.get(AGENT_ID_KEY)).toBe("a2");
    expect(createAgentsSelection(store).get()).toMatchObject({ agent: "a2", page: "skills" });
    expect(AGENT_ID_KEY).not.toBe(AGENT_PAGE_KEY);
  });
  test("a junk page in storage falls back; a blocked storage still works in memory", async () => {
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    expect(createAgentsSelection(memory({ [AGENT_PAGE_KEY]: "global skills" })).get().page).toBe("memory");
    const blocked = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
    const s = createAgentsSelection(blocked);
    s.pickPage("changes");
    expect(s.get().page).toBe("changes");
    expect(createAgentsSelection(null).get().page).toBe("memory");
  });
  test("subscribers hear every change; picking an agent ends the new-agent form", async () => {
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const s = createAgentsSelection(memory());
    let heard = 0;
    const off = s.subscribe(() => heard++);
    s.setCreating(true);
    expect(s.get().creating).toBe(true);
    s.pickAgent("a1");
    expect(s.get()).toMatchObject({ agent: "a1", creating: false });
    off();
    s.pickPage("profile");
    expect(heard).toBe(2);
  });
  test("the agent shown: the picked one, else the desk's agent before any pick, else the first", async () => {
    const { shownAgent } = await import("../app/src/agents/selection.ts");
    const agents = [{ id: "a1" }, { id: "a2" }];
    expect(shownAgent("a2", "a1", agents)).toBe("a2");
    expect(shownAgent(undefined, "a2", agents)).toBe("a2");
    expect(shownAgent(undefined, null, agents)).toBe("a1");
    // deleted: picked null, so the first — not the desk's agent, which may be the one just deleted
    expect(shownAgent(null, "a2", agents)).toBe("a1");
    expect(shownAgent(null, null, [])).toBeNull();
  });
});

/** The Agents column as Slack DMs (app/src/agents/rows.ts, AgentsColumn). */
describe("agents column", () => {
  const item = (agentId: string, id: string, status: string, extra = {}) => ({ id, agentId, status, lastAssistantText: null, lastMessageAt: null, archived: false, snooze: null, ...extra });
  const agents = [{ id: "a1", name: "ira" }, { id: "a2", name: "friday" }];
  const desks = [{ agentId: "a1", status: "live" }, { agentId: "a2", status: "live" }, { agentId: "a2", status: "live" }];
  const items = [
    item("a1", "c1", "approval", { lastAssistantText: "Can I run the migration?\nIt drops a table.", lastMessageAt: "2026-09-23T10:00:00Z" }),
    item("a1", "c2", "question", { lastAssistantText: "older", lastMessageAt: "2026-09-22T10:00:00Z" }),
    item("a2", "c3", "running"),
  ] as never;

  test("each agent a row in the app-server's order: waiting count, running, and the newest reply's first line as the preview", async () => {
    const { agentDmRows } = await import("../app/src/agents/rows.ts");
    const rows = agentDmRows(agents, desks, items);
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(rows[0]).toMatchObject({ waiting: 2, running: false, preview: "Can I run the migration?" });
    // nothing said yet: the live desks stand in
    expect(rows[1]).toMatchObject({ waiting: 0, running: true, preview: "2 desks live" });
  });

  test("rows with faces, the waiting badge with its count in words, the shown agent current, and + new agent in the header", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AgentsColumn } = await import("../app/src/agents/AgentsColumn.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    selection.pickAgent("a2");
    const html = renderToStaticMarkup(createElement(AgentsColumn, { agents, desks, items, avatar: () => "", initialAgentId: null, selection } as never));
    expect(html).toContain(">Agents</h2>");
    expect(html).toContain('aria-label="New agent"');
    expect(html).toContain(">2 waiting</span>");
    expect(html).toContain("loki-list-badge");
    expect(html).toContain("working");
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*friday/);
    expect(html).not.toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*ira/);
  });

  test("while the new-agent form is open no row is current", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AgentsColumn } = await import("../app/src/agents/AgentsColumn.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    selection.setCreating(true);
    const html = renderToStaticMarkup(createElement(AgentsColumn, { agents, desks, items, avatar: () => "", initialAgentId: null, selection } as never));
    expect(html).not.toContain('aria-current="page"');
  });
});

/** The Agents pane (Agents.tsx) with its column outside, in the Shell's ListColumn. */
describe("agents pane", () => {
  const props = (agents: Array<{ id: string; name: string }>) => ({ agents, api: {}, avatar: () => "", desks: [], items: [], tasks: null, initialAgentId: null, onOpenDesk: () => {}, onAskToUpdate: () => {}, onUpdateAgent: async () => null, write: {}, reflect: {}, listModels: async () => [], onShowDesks: () => {}, onShowBoard: () => {} });
  test("no agents: the invitation, as an empty pane, with its new agent button", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Agents } = await import("../app/src/agents/Agents.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const html = renderToStaticMarkup(createElement(Agents, { ...props([]), columnOutside: true, selection: createAgentsSelection(null) } as never));
    expect(html).toContain("loki-empty-pane");
    expect(html).toContain("No agents yet.");
    expect(html).toContain(">new agent</button>");
    expect(html).not.toContain(">Agents</h2>");
  });
  test("with the column inside (no Shell column), the list sits beside the pane", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Agents } = await import("../app/src/agents/Agents.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const html = renderToStaticMarkup(createElement(Agents, { ...props([]), selection: createAgentsSelection(null) } as never));
    expect(html).toContain(">Agents</h2>");
    expect(html).toContain("No agents yet.");
  });
});
