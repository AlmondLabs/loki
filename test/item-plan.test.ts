import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { foldSteps } from "../core/attention/thread.ts";
import { leanPage, type TranscriptRow } from "../core/attention/transcript.ts";
import { planItems } from "../core/harness.ts";
import { Work } from "../app/src/item/work.tsx";

// Plan 097, U9: an ACP agent's plan, kept whole on its row and drawn as AI Elements' Plan.

const PLAN = "[x] read the signups table\n[~] group them by week\n[ ] draw the chart";
const planRows = (text = PLAN): TranscriptRow[] =>
  foldSteps([
    { kind: "call", name: "plan", args: {}, id: "plan-t1", at: "2026-11-12T09:00:00.000Z" },
    { kind: "result", id: "plan-t1", output: [{ type: "text", text }], failed: false },
  ]);

describe("the plan's entries", () => {
  test("are read from the plan step's text, each with its status", () => {
    expect(planItems(PLAN)).toEqual([
      { content: "read the signups table", status: "completed" },
      { content: "group them by week", status: "in_progress" },
      { content: "draw the chart", status: "pending" },
    ]);
  });

  test("a tool that is only named plan keeps its output as written", () => {
    expect(planItems("wrote plan.md")).toBeNull();
    expect(planRows("wrote plan.md")[0].tool?.plan).toBeUndefined();
  });

  test("ride the row, and a lean history page keeps them though it drops the output", () => {
    const [row] = planRows();
    expect(row.tool?.plan).toHaveLength(3);
    const [lean] = leanPage([row], 0);
    expect(lean.tool?.output).toBeUndefined();
    expect(lean.tool?.plan).toHaveLength(3);
  });
});

describe("Work with a plan", () => {
  test("draws the Plan with how far it is, and no plan step in the list", () => {
    const out = renderToStaticMarkup(createElement(Work, { rows: planRows(), running: false, arrived: false }));
    expect(out).toContain("data-plan");
    expect(out).toContain("1 of 3 done");
    // Closed, a stretch of steps shows its summary line; with only the plan in it there is none.
    expect(out).not.toMatch(/worked|1 tool/i);
  });

  test("a newer plan replaces the one before", () => {
    const older = planRows("[ ] read the signups table")[0];
    const newer = planRows("[x] read the signups table\n[x] draw the chart")[0];
    const out = renderToStaticMarkup(createElement(Work, { rows: [older, newer], running: false, arrived: false }));
    expect(out).toContain("2 of 2 done");
    expect(out).not.toContain("0 of 1 done");
  });
});
