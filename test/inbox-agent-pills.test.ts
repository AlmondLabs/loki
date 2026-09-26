import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPills, agentPills } from "../app/src/desk/CatchUpParts.tsx";
import { attentionItem } from "./fixtures/attention.ts";

/** The desktop Inbox's agent pills (CatchUpParts.tsx): All, then each agent with cards this pass. */

const of = (id: string, agentId: string, agentName: string) => attentionItem(id, { agentId, agentName });

describe("inbox agent pills", () => {
  test("one pill per waiting agent, busiest first, then by name", () => {
    const items = [of("a", "ag-2", "Scout"), of("b", "ag-1", "Atlas"), of("c", "ag-2", "Scout"), of("d", "ag-3", "Bard")];
    expect(agentPills(items, false).map((p) => [p.name, p.count])).toEqual([
      ["Scout", 2],
      ["Atlas", 1],
      ["Bard", 1],
    ]);
  });
  test("nothing waiting, no pill: a quiet conversation is not counted", () => {
    expect(agentPills([attentionItem("a", { agentId: "ag-1", status: "idle", unread: false })], false)).toEqual([]);
  });
  test("hidden with one agent; with two, All leads and says how many wait in all", () => {
    const html = (items: ReturnType<typeof of>[], agent: string | null = null) => renderToStaticMarkup(createElement(AgentPills, { items, showSnoozed: false, agent, onAgent: () => {} }));
    expect(html([of("a", "ag-1", "Atlas"), of("b", "ag-1", "Atlas")])).toBe("");
    const two = html([of("a", "ag-1", "Atlas"), of("b", "ag-2", "Scout")]);
    expect(two).toMatch(/All <span[^>]*>2<\/span>/);
    expect(two).toContain('aria-pressed="true"');
  });
  test("a pill that is on stays at 0 once its cards are cleared, so All is one click away", () => {
    const out = renderToStaticMarkup(createElement(AgentPills, { items: [of("a", "ag-1", "Atlas"), attentionItem("b", { agentId: "ag-2", agentName: "Scout", status: "idle", unread: false })], showSnoozed: false, agent: "ag-2", onAgent: () => {} }));
    expect(out).toMatch(/Scout <span[^>]*>0<\/span>/);
  });
});
