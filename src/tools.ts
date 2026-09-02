import type { DeskStore, Patch, WidgetState } from "./store.js";
import { KIT_TYPES as KIT_TYPE_LIST, kitDescription } from "./kit-types.js";

/**
 * Agent-facing tools (K9). Kit vocabulary lives in kit-types.ts, shared with
 * the web bundle. Tool-applied patches broadcast to all tabs via ws bridge.
 */
const KIT_TYPES = new Set(KIT_TYPE_LIST);

interface ToolApi {
  capabilities?: { tools?: boolean };
  tools?: {
    register(tool: {
      name: string;
      description: string;
      parameters: object;
      requiresApproval?: boolean;
      parallelSafe?: boolean;
      run(ctx: { args: Record<string, unknown> }): Promise<unknown> | unknown;
    }): (() => void) | void;
  };
}

export function registerTools(
  letta: ToolApi,
  store: DeskStore,
  broadcast: (msg: object) => void,
): Array<(() => void) | void> {
  if (!letta.capabilities?.tools || !letta.tools) return [];

  const apply = (patch: Patch) => {
    store.apply(patch);
    broadcast({ type: "patch", patch });
  };

  const disposers: Array<(() => void) | void> = [];

  disposers.push(
    letta.tools.register({
      name: "loci_render",
      description:
        "Place a widget on the loci canvas (the user's browser widget desk, opened with /canvas). " +
        `Kit types and data shapes — ${kitDescription()}. ` +
        "Controls (slider, list checkboxes) write user interactions back into widget data, " +
        "readable via loci_state. Use when the user asks to see something on the canvas/desk, " +
        "or when a visual answer beats prose.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...KIT_TYPES], description: "Kit widget type" },
          title: { type: "string", description: "Widget title bar text" },
          data: { type: "object", description: "Widget payload (shape depends on type)" },
          position: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            additionalProperties: false,
            description: "Canvas position; omit to auto-place",
          },
        },
        required: ["type", "title", "data"],
        additionalProperties: false,
      },
      requiresApproval: false,
      parallelSafe: false,
      run(ctx) {
        const type = String(ctx.args.type ?? "");
        const title = String(ctx.args.title ?? "").trim();
        const data = ctx.args.data;
        if (!KIT_TYPES.has(type)) {
          return { status: "error", content: `unknown kit type "${type}" — available: ${[...KIT_TYPES].join(", ")}` };
        }
        if (!title) return { status: "error", content: "title is required" };
        if (typeof data !== "object" || data === null) {
          return { status: "error", content: "data must be an object" };
        }

        const desk = store.get();
        const id = uniqueId(slug(title), desk.widgets);
        const count = Object.keys(desk.widgets).length;
        const position =
          (ctx.args.position as { x: number; y: number } | undefined) ??
          { x: 140 + (count % 6) * 60, y: 120 + (count % 6) * 48 };

        apply({ op: "add", widget: { id, type, title, position, data } });
        return `rendered widget "${id}" (${type}) at ${position.x},${position.y}. Desk now has ${count + 1} widget(s).`;
      },
    }),
  );

  disposers.push(
    letta.tools.register({
      name: "loci_state",
      description:
        "Read the current loci canvas state: widgets, their types, titles, positions, and data. " +
        "Use before modifying the desk or when the user refers to what's on their canvas.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      parallelSafe: true,
      run() {
        const desk = store.get();
        const widgets = Object.values(desk.widgets).map((w: WidgetState) => ({
          id: w.id,
          type: w.type,
          title: w.title,
          position: w.position,
          data: w.data,
        }));
        return JSON.stringify({ rev: desk.rev, widgets }, null, 2);
      },
    }),
  );

  return disposers;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "widget"
  );
}

function uniqueId(base: string, widgets: Record<string, unknown>): string {
  if (!widgets[base]) return base;
  let n = 2;
  while (widgets[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}
