import { describe, expect, test } from "bun:test";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage } from "../app/src/agents/pages.ts";
import { firstAgentId, readingFor, shownShaOf, shownSkillOf } from "../app/src/agents/reading.ts";

/** The agent's pages (app/src/agents/pages.ts): five names down the desktop nav; the phone's headings are four of them. */
describe("agent pages", () => {
  test("five pages, in this order, each with a hint", () => {
    expect(AGENT_PAGES).toEqual(["profile", "memory", "changes", "reflection", "skills"]);
    for (const p of AGENT_PAGES) expect(AGENT_PAGE_HINT[p].length).toBeGreaterThan(0);
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
