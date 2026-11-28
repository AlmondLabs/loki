import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_GOALS_SETTINGS, EMPTY_GOALS_PULSE } from "../core/goals.ts";
import { resolveDiscoverAgentId } from "../app/src/goals/views.ts";
import type { GoalsModel } from "../app/src/shell/use-goals.ts";

vi.mock("../app/src/ui/dialog.tsx", () => import("./fixtures/inline-dialog.ts"));
vi.mock("../app/src/shell/place-columns.tsx", () => ({
  PlaceColumns: ({ list, detail }: { list: ReactNode; detail: ReactNode }) => createElement("div", null, list, detail),
}));

const { GoalDiscoverSheet } = await import("../app/src/goals/goal-discover-sheet.tsx");
const { Goals } = await import("../app/src/goals/goals.tsx");

function emptyGoalsModel(partnerAgentId: string | null = null): GoalsModel {
  const no = () => Promise.resolve(false);
  return {
    snap: { goals: [], settings: { ...DEFAULT_GOALS_SETTINGS, partner_agent_id: partnerAgentId }, pulse: { ...EMPTY_GOALS_PULSE } },
    error: null,
    running: false,
    attentionCount: 0,
    refresh: () => Promise.resolve(),
    create: no,
    update: no,
    remove: no,
    addProgress: no,
    toggleHabit: no,
    setSettings: no,
    runPulse: () => Promise.resolve(null),
    startWork: () => Promise.resolve(null),
    startDiscover: () => Promise.resolve(null),
  };
}

describe("goal discovery agent selection", () => {
  const agents = [
    { id: "optimus", name: "optimus" },
    { id: "nova", name: "nova" },
  ];

  test("resolves explicit pick first, then partner setting, then first agent", () => {
    expect(resolveDiscoverAgentId(agents, "nova", "optimus")).toBe("nova");
    expect(resolveDiscoverAgentId(agents, null, "nova")).toBe("nova");
    expect(resolveDiscoverAgentId(agents, "missing", "nova")).toBe("nova");
    expect(resolveDiscoverAgentId(agents, null, null)).toBe("optimus");
    expect(resolveDiscoverAgentId([], "nova", "optimus")).toBeNull();
  });

  test("empty Goals pane offers agent selector instead of hardcoding first agent name", () => {
    const html = renderToStaticMarkup(
      createElement(Goals, {
        goals: emptyGoalsModel(),
        view: "active",
        onView: () => {},
        selectedId: null,
        onSelect: () => {},
        agents,
        editingNew: false,
        onCloseNew: () => {},
        onOpenNew: () => {},
        onOpenChat: () => {},
      }),
    );
    expect(html).not.toContain("Discover Goals with optimus");
    expect(html).toContain("Discover Goals");
    expect(html).toContain('aria-label="Discovery agent"');
    expect(html).toContain("optimus");

    const novaDefaultHtml = renderToStaticMarkup(
      createElement(Goals, {
        goals: emptyGoalsModel("nova"),
        view: "active",
        onView: () => {},
        selectedId: null,
        onSelect: () => {},
        agents,
        editingNew: false,
        onCloseNew: () => {},
        onOpenNew: () => {},
        onOpenChat: () => {},
      }),
    );
    expect(novaDefaultHtml).toContain('aria-label="Discovery agent"');
    expect(novaDefaultHtml).toContain("nova");
  });

  test("GoalDiscoverSheet lists every agent for picking", () => {
    const html = renderToStaticMarkup(
      createElement(GoalDiscoverSheet, {
        agents,
        initialAgentId: "nova",
        onStart: () => Promise.resolve(),
        onClose: () => {},
      }),
    );
    expect(html).toContain("optimus");
    expect(html).toContain("nova");
    expect(html).toContain("Default");
  });
});
