import { describe, expect, test } from "vitest";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_KEY, AGENT_PAGE_LABEL, DEFAULT_AGENT_PAGE, isAgentPage } from "../app/src/agents/pages.ts";
import { firstAgentId, readingFor, shownShaOf, shownSkillOf } from "../app/src/agents/reading.ts";
import type { MemorySkillInfo } from "../core/frame-types.ts";

describe("agent pages", () => {
  test("four pages, in this order, each with a hint", () => {
    expect(AGENT_PAGES).toEqual(["profile", "memory", "changes", "skills"]);
    for (const p of AGENT_PAGES) expect(AGENT_PAGE_HINT[p].length).toBeGreaterThan(0);
    expect(AGENT_PAGES.map((p) => AGENT_PAGE_LABEL[p])).toEqual(["Profile", "Memory", "Changes", "Skills"]);
  });
  test("a first visit lands on profile; the remembered page has its own key", () => {
    expect(DEFAULT_AGENT_PAGE).toBe("profile");
    expect(AGENT_PAGE_KEY).toBe("loki.agentsPage");
    expect(AGENT_PAGE_KEY).not.toBe("loki.settingsPage");
  });
  test("isAgentPage guards what sessionStorage hands back", () => {
    expect(isAgentPage("skills")).toBe(true);
    expect(isAgentPage("reflection")).toBe(false);
    expect(isAgentPage("global skills")).toBe(false);
    expect(isAgentPage(null)).toBe(false);
    expect(isAgentPage(3)).toBe(false);
  });
});

describe("agent reading pane", () => {
  const skills = [
    { name: "notes", path: "skills/notes/SKILL.md", origin: "self" as const },
    { name: "stocks", path: "skills/stocks/SKILL.md", origin: "other" as const },
  ] as unknown as MemorySkillInfo[];
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
    expect(shownSkillOf(null, "notes")).toBeNull();
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

describe("agents selection", () => {
  const memory = (seed: Record<string, string> = {}) => {
    const m = new Map(Object.entries(seed));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  test("the page and agent are kept for the window, so a section switch (or a remount) comes back to them", async () => {
    const { createAgentsSelection, AGENT_ID_KEY } = await import("../app/src/agents/selection.ts");
    const store = memory();
    const a = createAgentsSelection(store);
    expect(a.get()).toEqual({ agent: { kind: "none" }, page: "profile", creating: false });
    a.pickPage("skills");
    a.pickAgent("a2");
    expect(store.m.get(AGENT_PAGE_KEY)).toBe("skills");
    expect(store.m.get(AGENT_ID_KEY)).toBe("a2");
    expect(createAgentsSelection(store).get()).toMatchObject({ agent: { kind: "agent", id: "a2" }, page: "skills" });
    expect(AGENT_ID_KEY).not.toBe(AGENT_PAGE_KEY);
  });
  test("a deleted pick forgets the saved agent, so a reload starts with no pick", async () => {
    const { createAgentsSelection, AGENT_ID_KEY } = await import("../app/src/agents/selection.ts");
    const store = memory();
    const a = createAgentsSelection(store);
    a.pickAgent("a2");
    a.agentDeleted();
    expect(a.get().agent).toEqual({ kind: "deleted" });
    expect(store.m.has(AGENT_ID_KEY)).toBe(false);
    expect(createAgentsSelection(store).get().agent).toEqual({ kind: "none" });
  });
  test("legacy reflection page migrates to changes; junk falls back to profile; blocked storage works in memory", async () => {
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    expect(createAgentsSelection(memory({ [AGENT_PAGE_KEY]: "reflection" })).get().page).toBe("changes");
    expect(createAgentsSelection(memory({ [AGENT_PAGE_KEY]: "global skills" })).get().page).toBe("profile");
    const blocked = {
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {
        throw new Error("no");
      },
      removeItem: () => {
        throw new Error("no");
      },
    };
    const s = createAgentsSelection(blocked);
    s.pickPage("changes");
    expect(s.get().page).toBe("changes");
    expect(createAgentsSelection(null).get().page).toBe("profile");
  });
  test("subscribers hear every change; picking an agent ends the new-agent sheet", async () => {
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const s = createAgentsSelection(memory());
    let heard = 0;
    const off = s.subscribe(() => heard++);
    s.setCreating(true);
    expect(s.get().creating).toBe(true);
    s.pickAgent("a1");
    expect(s.get()).toMatchObject({ agent: { kind: "agent", id: "a1" }, creating: false });
    off();
    s.pickPage("memory");
    expect(heard).toBe(2);
  });
  test("the agent shown: the picked one, else the desk's agent before any pick, else the first", async () => {
    const { shownAgent } = await import("../app/src/agents/selection.ts");
    const agents = [{ id: "a1" }, { id: "a2" }];
    expect(shownAgent({ kind: "agent", id: "a2" }, "a1", agents)).toBe("a2");
    expect(shownAgent({ kind: "none" }, "a2", agents)).toBe("a2");
    expect(shownAgent({ kind: "none" }, null, agents)).toBe("a1");
    expect(shownAgent({ kind: "deleted" }, "a2", agents)).toBe("a1");
    expect(shownAgent({ kind: "deleted" }, null, [])).toBeNull();
  });
  test("a remembered pick that is no longer in the list (deleted elsewhere, then a reload) falls back; while the list loads it stands", async () => {
    const { shownAgent } = await import("../app/src/agents/selection.ts");
    const agents = [{ id: "a1" }, { id: "a2" }];
    const gone = { kind: "agent", id: "gone" } as const;
    expect(shownAgent(gone, "a2", agents)).toBe("a2");
    expect(shownAgent(gone, null, agents)).toBe("a1");
    expect(shownAgent(gone, "a2", [])).toBe("gone");
  });
});

describe("agents as sources", () => {
  const item = (agentId: string, id: string, status: string) => ({
    id,
    agent_id: agentId,
    status,
    lastAssistantText: null,
    last_message_at: null,
    archived: false,
  });
  const agents = [
    { id: "a1", name: "ira" },
    { id: "a2", name: "friday" },
  ];
  const desks = [
    { agent_id: "a1", status: "live" },
    { agent_id: "a2", status: "live" },
  ];
  const items = [item("a1", "c1", "approval"), item("a1", "c2", "question"), item("a2", "c3", "running")] as never;

  test("each agent a source in the daemon's order: its face, its name, the waiting count and the working dot", async () => {
    const { agentSources } = await import("../app/src/agents/agents-column.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    const sources = agentSources({ agents, desks, items, initialAgentId: null, state: selection.get(), selection, face: (id) => `face:${id}` });
    expect(sources.items.map((x) => [x.id, x.title, x.face, x.count, x.live])).toEqual([
      ["a1", "ira", "face:a1", 2, false],
      ["a2", "friday", "face:a2", 0, true],
    ]);
    expect(sources.selected).toBe("a1");
  });

  test("choosing an agent source selects it and keeps the page that was showing", async () => {
    const { agentSources } = await import("../app/src/agents/agents-column.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    selection.pickPage("skills");
    agentSources({ agents, desks, items, initialAgentId: null, state: selection.get(), selection, face: () => null }).onSelect("a2");
    expect(selection.get()).toMatchObject({ agent: { kind: "agent", id: "a2" }, page: "skills" });
    const after = agentSources({ agents, desks, items, initialAgentId: null, state: selection.get(), selection, face: () => null });
    expect(after.selected).toBe("a2");
  });

  test("deleting the selected agent selects the first remaining one", async () => {
    const { agentSources } = await import("../app/src/agents/agents-column.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    selection.pickAgent("a1");
    selection.agentDeleted();
    const left = [{ id: "a2", name: "friday" }];
    expect(agentSources({ agents: left, desks, items, initialAgentId: "a1", state: selection.get(), selection, face: () => null }).selected).toBe("a2");
  });

  test("while the new-agent sheet is open the selected agent stays highlighted and the sidebar carries New Agent", async () => {
    const { agentSources } = await import("../app/src/agents/agents-column.tsx");
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    selection.setCreating(true);
    let ran = 0;
    const sources = agentSources({
      agents,
      desks,
      items,
      initialAgentId: null,
      state: selection.get(),
      selection,
      face: () => null,
      onNewAgent: () => ran++,
    });
    expect(sources.selected).toBe("a1");
    expect(sources.action?.label).toBe("New Agent");
    sources.action?.onRun();
    expect(ran).toBe(1);
  });

  test("a source's working dot, count, and heading action in the sidebar", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Places } = await import("../app/src/shell/sidebar.tsx");
    const html = renderToStaticMarkup(
      createElement(Places, {
        segment: "agents",
        onSelect: () => {},
        waiting: 0,
        sources: {
          agents: {
            items: [{ id: "a2", title: "friday", count: 2, live: true }],
            selected: "a2",
            onSelect: () => {},
            action: { label: "New Agent", onRun: () => {} },
          },
        },
      }),
    );
    expect(html).toContain('aria-label="friday, working, 2 waiting"');
    expect(html).toContain("loki-list-row-live");
    expect(html).toContain('class="loki-place-action"');
    expect(html).toContain('aria-label="New Agent"');
  });
});

describe("agents list column", () => {
  test("the three-column layout stays consistent across all four pages and while creating", async () => {
    const { agentsHasList } = await import("../app/src/agents/selection.ts");
    for (const page of ["profile", "memory", "changes", "skills"] as const) {
      expect(agentsHasList({ agent: { kind: "agent", id: "a1" }, page, creating: false }, 2)).toBe(true);
    }
    expect(agentsHasList({ agent: { kind: "agent", id: "a1" }, page: "memory", creating: true }, 2)).toBe(true);
    expect(agentsHasList({ agent: { kind: "none" }, page: "profile", creating: false }, 0)).toBe(false);
  });
});

describe("agents page lists", () => {
  test("Profile lists the agent's live chats, filtered by query", async () => {
    const { chatRows } = await import("../app/src/agents/profile-page.tsx");
    const at = "2026-11-14T10:00:00Z";
    const desks = [
      { scope: "a1:default", agent_id: "a1", conversation_id: "default", status: "live", title: null, active: true, last_active: at },
      { scope: "a1:c2", agent_id: "a1", conversation_id: "c2", status: "live", title: "Deploy check", active: false, last_active: at },
      { scope: "a1:arch", agent_id: "a1", conversation_id: "arch", status: "archived", title: "Old chat", active: false, last_active: at },
      { scope: "a2:default", agent_id: "a2", conversation_id: "default", status: "live", title: "Other agent", active: false, last_active: at },
    ] as never;
    const rows = chatRows(desks, "a1");
    expect(rows.map((r) => [r.id, r.title, r.live])).toEqual([
      ["default", "Main chat", true],
      ["c2", "Deploy check", false],
    ]);
    expect(chatRows(desks, "a1", "deploy").map((r) => r.id)).toEqual(["c2"]);
  });

  test("Memory lists the agent's files, flat under their folders, skills and the face left out, and filters by query", async () => {
    const { memoryRows } = await import("../app/src/agents/memory-page.tsx");
    const at = "2026-11-14T10:00:00Z";
    const files = [
      { path: "system/persona.md", bytes: 10, modified_at: at },
      { path: "system/human.md", bytes: 10, modified_at: at },
      { path: "notes.md", bytes: 10, modified_at: at },
      { path: "skills/notes/SKILL.md", bytes: 10, modified_at: at },
      { path: "profile.png", bytes: 10, modified_at: at },
    ];
    const rows = memoryRows(files);
    expect(rows.map((r) => [r.id, r.title, r.section])).toEqual([
      ["system/persona.md", "persona.md", "system"],
      ["system/human.md", "human.md", "system"],
      ["notes.md", "notes.md", undefined],
    ]);
    expect(memoryRows(files, "human").map((r) => r.id)).toEqual(["system/human.md"]);
    expect(readingFor("memory", rows[1].id, null, null)).toEqual({ kind: "file", path: "system/human.md" });
  });

  test("Changes lists commits newest first, marks Reflection/Doctor passes, and filters by pass and query", async () => {
    const { changePills, changeRows, filterChanges } = await import("../app/src/agents/changes-page.tsx");
    const at = "2026-11-14T10:00:00Z";
    const log = [
      { sha: "c3", message: "learn the deploy", at, files: ["notes.md"], author: "Reflection Subagent" },
      { sha: "c2", message: "trim core notes", at, files: ["system/human.md"], author: "Doctor" },
      { sha: "c1", message: "fix a typo", at, files: ["a.md", "b.md"], author: "ira" },
    ];
    const rows = changeRows(log);
    expect(rows.map((r) => [r.id, r.title, r.preview])).toEqual([
      ["c3", "learn the deploy", "notes.md"],
      ["c2", "trim core notes", "system/human.md"],
      ["c1", "fix a typo", "2 files"],
    ]);
    expect(changePills(log, "all").map((p) => p.value)).toEqual(["all", "reflection", "doctor"]);
    expect(changePills([log[2]], "all").map((p) => p.value)).toEqual(["all"]);
    expect(filterChanges(log, "reflection").map((c) => c.sha)).toEqual(["c3"]);
    expect(filterChanges(log, "doctor").map((c) => c.sha)).toEqual(["c2"]);
    expect(filterChanges(log, "all", "typo").map((c) => c.sha)).toEqual(["c1"]);
  });

  test("Skills lists the agent's own under Self and installed under Installed, and filters by query", async () => {
    const { skillRows } = await import("../app/src/agents/skills-page.tsx");
    const skills = [
      { name: "stocks", path: "skills/stocks/SKILL.md", origin: "other", source: { label: "acme/skills" } },
      { name: "notes", path: "skills/notes/SKILL.md", origin: "self", description: "Keep notes" },
    ] as unknown as MemorySkillInfo[];
    expect(skillRows(skills as never).map((r) => [r.id, r.section, r.preview])).toEqual([
      ["notes", "Self", "Keep notes"],
      ["stocks", "Installed", "acme/skills"],
    ]);
    expect(skillRows(skills as never, "acme").map((r) => r.id)).toEqual(["stocks"]);
  });
});

describe("agents place", () => {
  const props = (agents: Array<{ id: string; name: string }>) => ({
    agents,
    api: { get: () => new Promise(() => {}), log: () => Promise.resolve([]) },
    avatar: () => "",
    desks: [],
    initialAgentId: null,
    onOpenChat: () => {},
    onAskToUpdate: () => {},
    onUpdateAgent: () => Promise.resolve(null),
    write: {},
    models: [],
    onLoadModels: () => {},
  });
  const render = async (p: object) => {
    const { createElement, Fragment } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { useAgentsPlace } = await import("../app/src/agents/agents.tsx");
    function Both(q: Parameters<typeof useAgentsPlace>[0]) {
      const { list, detail } = useAgentsPlace(q);
      return createElement(Fragment, null, createElement("div", { id: "list" }, list), createElement("div", { id: "detail" }, detail));
    }
    return renderToStaticMarkup(createElement(Both, p as never));
  };
  test("no agents: the invitation fills the detail, with no list", async () => {
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const html = await render({ ...props([]), selection: createAgentsSelection(null) });
    expect(html).toContain('<div id="list"></div>');
    expect(html).toContain("No agents yet<");
    expect(html).toContain(">New Agent</button>");
  });
  test("Profile keeps the Chats list with New Chat in its toolbar; Memory, Changes and Skills keep searchable lists", async () => {
    const { createAgentsSelection } = await import("../app/src/agents/selection.ts");
    const selection = createAgentsSelection(null);
    const profile = await render({ ...props([{ id: "a1", name: "ira" }]), selection });
    expect(profile).toContain("loki-content-list");
    expect(profile).toContain('aria-label="New Chat"');
    selection.pickPage("memory");
    const memory = await render({ ...props([{ id: "a1", name: "ira" }]), selection });
    expect(memory).toContain("loki-content-list");
    expect(memory).not.toContain('aria-label="New Agent"');
  });
});
