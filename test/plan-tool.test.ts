import { describe, expect, test } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { planItems } from "../core/harness.ts";
import { PLAN_TOOL, planExtension } from "../daemon/plan.ts";
import { must } from "./fixtures/must.ts";

describe("the built-in plan tool", () => {
  const ext = planExtension();
  const tool = must(
    ext.tools?.find((t) => t.name === PLAN_TOOL),
    "plan tool",
  );

  test("validates steps and outputs checklist lines parsed by core/harness", async () => {
    const args = {
      steps: [
        { title: "Inspect existing config", status: "completed" },
        { title: "Update daemon wiring", status: "in_progress" },
        { title: "Verify tests", status: "pending" },
      ],
    };
    expect(validateToolArguments(tool, { type: "toolCall", id: "call-1", name: PLAN_TOOL, arguments: args })).toEqual(args);
    const result = (await tool.execute(args, {} as never, {} as never)) as { output: Array<{ text: string }> };
    const text = result.output.map((o) => o.text).join("");
    expect(text).toBe("[x] Inspect existing config\n[~] Update daemon wiring\n[ ] Verify tests");
    expect(planItems(text)).toEqual([
      { content: "Inspect existing config", status: "completed" },
      { content: "Update daemon wiring", status: "in_progress" },
      { content: "Verify tests", status: "pending" },
    ]);
  });

  test("rejects empty lists or blank titles", async () => {
    await expect(tool.execute({ steps: [] }, {} as never, {} as never)).rejects.toThrow("non-empty");
    await expect(tool.execute({ steps: [{ title: "   ", status: "pending" }] }, {} as never, {} as never)).rejects.toThrow("non-empty title");
  });
});
