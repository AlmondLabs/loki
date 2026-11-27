import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { withKind } from "./tool-kinds.ts";

export const PLAN_TOOL = "plan";

type StepStatus = "pending" | "in_progress" | "completed";

interface PlanStep {
  title: string;
  status: StepStatus;
}

const MARKER: Readonly<Record<StepStatus, string>> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

const VALID_STATUSES = new Set<string>(Object.keys(MARKER));

function parseSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("plan requires a non-empty list of steps");
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`step ${index + 1} must be an object`);
    const entry = item as { title?: unknown; status?: unknown };
    const title = typeof entry.title === "string" ? entry.title.replace(/\s+/g, " ").trim() : "";
    if (!title) throw new Error(`step ${index + 1} needs a non-empty title`);
    if (typeof entry.status !== "string" || !VALID_STATUSES.has(entry.status)) {
      throw new Error(`step ${index + 1} has invalid status (expected pending, in_progress, or completed)`);
    }
    return { title, status: entry.status as StepStatus };
  });
}

export function formatPlanSteps(steps: readonly PlanStep[]): string {
  return steps.map((step) => `${MARKER[step.status]} ${step.title}`).join("\n");
}

export function planExtension(): Extension {
  return defineExtension({
    name: "loki.plan",
    tools: [
      withKind(
        "read",
        defineTool({
          name: PLAN_TOOL,
          description: "Update the step checklist for 3+ step tasks. Send the full ordered list each time.",
          parameters: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                  },
                  required: ["title", "status"],
                },
              },
            },
            required: ["steps"],
          } as never,
          replay: "safe",
          execute: (args) =>
            Promise.resolve().then(() => {
              const steps = parseSteps((args as { steps?: unknown }).steps);
              return { output: [{ type: "text", text: formatPlanSteps(steps) }] };
            }),
        }),
      ),
    ],
  });
}
