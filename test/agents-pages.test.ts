import { describe, expect, test } from "bun:test";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage } from "../app/src/agents/pages.ts";

/** The agent's pages (app/src/agents/pages.ts): four names the desktop nav and the phone headings share. */
describe("agent pages", () => {
  test("four pages, in this order, each with a hint", () => {
    expect(AGENT_PAGES).toEqual(["profile", "memory", "changes", "skills"]);
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
