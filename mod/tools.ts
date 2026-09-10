import type { Scope } from "../core/desk-core.ts";
import { KIT, SHARED_SCOPE, mergeData, scopeFor } from "../core/desk-core.ts";
import type { LettaMod } from "./letta-types.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import { scopeOfId } from "./bridge.ts";
import { log, withTimeout } from "./log.ts";
import type { TaskBoard } from "./tasks.ts";

/**
 * Two tools. Rendering and authoring are file writes, not tool calls — the
 * agent uses its own Write/Edit on <widgetsDir>/<desk>/. These exist for
 * reading back and for directing attention.
 */

export interface ToolDeps {
  store: DeskStore;
  widgets: WidgetsWatcher;
  gestures: GestureLog;
  widgetsDir: string;
  /** Fallback only: the last conversation that started a turn. Tool calls know their own conversation. */
  activeScope: () => Scope;
  /** Bind a conversation to its desk and return the scope. */
  remember?: (conversationId: string, agentId?: string | null) => Scope;
  broadcast(msg: object, scope?: Scope): void;
  /** The shared board (beads) and the folder a conversation works in, for the task stamp. */
  tasks?: TaskBoard;
  folderFor?: (agentId: string | null, conversationId: string | null) => string | null;
}

/**
 * The desk a tool call is about: the explicit `desk` argument, else the desk of
 * the conversation making the call, else the mod's active desk. Never the
 * active desk when the call's own conversation is known — other conversations
 * (schedules, subagents, another chat) move the active desk under our feet.
 */
export function scopeForCall(deps: ToolDeps, ctx: { args?: Record<string, unknown>; conversation?: { id: string | null } | null } | undefined): Scope {
  const desk = ctx?.args?.desk;
  if (typeof desk === "string" && desk) return scopeFor(desk);
  const conv = ctx?.conversation?.id;
  if (conv) return deps.remember ? deps.remember(conv) : scopeFor(conv);
  return deps.activeScope();
}

export function deskSnapshot(deps: ToolDeps, scope: Scope) {
  const state = deps.store.get(scope);
  return deps.widgets.entries(scope).map((w) => {
    const l = state.layout[w.id];
    return {
      id: w.id,
      file: `${deps.widgetsDir}/${w.file}`,
      kind: w.kind,
      ...(w.type ? { type: w.type } : {}),
      title: w.title,
      data: mergeData(w.data, state.overlay[w.id]),
      ...(l ? { position: l.position, ...(l.size ? { size: l.size } : {}), z: l.z, ...(l.hidden ? { minimisedByUser: true } : {}) } : {}),
      ...(w.error ? { error: w.error } : {}),
    };
  });
}

export function registerTools(letta: LettaMod, deps: ToolDeps): Array<(() => void) | void> {
  if (!letta.capabilities?.tools || !letta.tools) return [];
  const kitLine = Object.entries(KIT)
    .map(([t, k]) => `${t}: ${k.dataShape}`)
    .join("; ");

  const disposers: Array<(() => void) | void> = [];

  disposers.push(
    letta.tools.register({
      name: "desk_state",
      description:
        "Read the loki canvas (the user's browser widget desk). Returns the widgets on this conversation's desk " +
        "and on the shared desk: file, type, title, data (with the user's gesture edits applied), position, and any " +
        "build/runtime error. To ADD or CHANGE a widget, write a file — do not look for a render tool: " +
        `${deps.widgetsDir}/<desk>/<name>.json for a kit widget ({ "type", "title", "data" }; kit types — ${kitLine}) ` +
        `or <name>.tsx for a custom React component (export default function Widget({ data, onSet }); import kit pieces from "@loki/kit"). ` +
        "The result is for the conversation you are in (pass `desk` to look at another). Files appear on the canvas instantly; call this again to confirm they mounted without error. " +
        "User gestures are also attached automatically to your next turn.",
      parameters: {
        type: "object",
        properties: {
          desk: { type: "string", description: 'Desk id; omit for the active conversation. "shared" for the shared desk only.' },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      // Not parallelSafe: the parallel-safe scheduler is the one path v1 never exercised in Letta.
      parallelSafe: false,
      async run(ctx) {
        const args = ctx?.args ?? {};
        log("tool:desk_state:start", args);
        // A scan must never hold a turn hostage; the manifest is at most one scan stale.
        await withTimeout(deps.widgets.rescan(), 2000, "desk_state rescan", undefined);
        const scope = scopeForCall(deps, ctx);
        const out: Record<string, unknown> = {
          desk: scope,
          widgetsDir: `${deps.widgetsDir}/${scope}`,
          widgets: deskSnapshot(deps, scope),
        };
        if (scope !== SHARED_SCOPE) {
          out.sharedWidgetsDir = `${deps.widgetsDir}/${SHARED_SCOPE}`;
          out.shared = deskSnapshot(deps, SHARED_SCOPE);
        }
        const pending = [...deps.gestures.peek(scope), ...(scope !== SHARED_SCOPE ? deps.gestures.peek(SHARED_SCOPE) : [])];
        if (pending.length) out.pendingCanvasActivity = pending;
        log("tool:desk_state:done", { desk: scope, widgets: (out.widgets as unknown[]).length });
        return JSON.stringify(out, null, 2);
      },
    }),
  );

  disposers.push(
    letta.tools.register({
      name: "loki_camera",
      description:
        "Glide the user's canvas camera to one widget, or frame several together (eased zoom-to; the targets are " +
        "highlighted for a few seconds). Use it to direct attention after writing a widget or when referring to " +
        "widgets while you talk. `dwell` (ms, up to 8000) makes the call wait before returning, useful when " +
        "moving between several widgets. Ignored while the user is mid-interaction.",
      parameters: {
        type: "object",
        properties: {
          widgetId: { type: "string", description: 'One widget id as returned by desk_state, e.g. "shared/sleep"' },
          widgetIds: { type: "array", items: { type: "string" }, description: "Several widget ids to fit in view together" },
          dwell: { type: "number", description: "Milliseconds to hold before returning (0–8000)." },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      parallelSafe: false,
      async run(ctx) {
        const args = ctx?.args ?? {};
        const ids = Array.isArray(args.widgetIds)
          ? (args.widgetIds as unknown[]).filter((x): x is string => typeof x === "string")
          : typeof args.widgetId === "string" && args.widgetId
            ? [args.widgetId]
            : [];
        log("tool:loki_camera", { ids, dwell: args.dwell });
        if (ids.length === 0) return { status: "error", content: "give widgetId or widgetIds" };
        const missing = ids.filter((id) => !deps.widgets.get(id));
        if (missing.length) return { status: "error", content: `no widget ${missing.map((m) => `"${m}"`).join(", ")} — check desk_state` };
        const scopes = new Set(ids.map(scopeOfId));
        const scope = scopes.size === 1 ? [...scopes][0] : SHARED_SCOPE; // mixed desks: every tab may have them
        deps.broadcast({ type: "camera", widgetId: ids[0], widgetIds: ids }, scope === SHARED_SCOPE ? undefined : scope);
        const dwell = Math.max(0, Math.min(8000, Number(args.dwell) || 0));
        if (dwell) await new Promise((r) => setTimeout(r, dwell));
        return ids.length === 1
          ? `camera gliding to "${ids[0]}"${dwell ? `, held ${dwell}ms` : ""} (suppressed if the user is mid-interaction)`
          : `camera framing ${ids.length} widgets${dwell ? `, held ${dwell}ms` : ""}`;
      },
    }),
  );

  if (deps.tasks) {
    const board = deps.tasks;
    disposers.push(
      letta.tools.register({
        name: "loki_task",
        description:
          "The user's board of tasks for later (beads, shared by every agent and folder). Use it when the user asks to " +
          "note, park, or file something for later, or when you wrap up with explicit follow-ups — never on your own " +
          "initiative mid-task. `create` files a task (title, description, labels, priority 0–4; the source conversation, " +
          "desk and folder are stamped automatically) and returns its id: tell the user the id. `list` shows tasks assigned " +
          "to this conversation (or every open task with all:true). `comment` adds progress; `close` finishes one with a " +
          "reason. Tasks assigned to this conversation are also attached to the user's next message inside <loki-tasks>.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list", "comment", "close"], description: "What to do." },
            title: { type: "string", description: "create: one line, imperative (\"rotate the SSO creds before the audit\")." },
            description: { type: "string", description: "create: what, why, where to look. Enough for someone starting cold." },
            labels: { type: "array", items: { type: "string" }, description: "create: short tags (aws, security, docs). The project's folder name is added for you." },
            priority: { type: "number", description: "create: 0 (urgent) to 4 (someday); default 2." },
            id: { type: "string", description: "comment / close: the task id (lk-…)." },
            text: { type: "string", description: "comment: the progress note." },
            reason: { type: "string", description: "close: what was done, one line." },
            all: { type: "boolean", description: "list: every open task on the board, not just this conversation's." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        requiresApproval: false,
        parallelSafe: false,
        async run(ctx) {
          const args = ctx?.args ?? {};
          const action = String(args.action ?? "");
          const conversation = ctx?.conversation?.id ?? null;
          const agentId = ctx?.agent?.id ?? null;
          const agent = ctx?.agent?.name ?? null;
          log("tool:loki_task", { action, agent, conversation });
          try {
            if (action === "create") {
              const task = await board.create({
                title: String(args.title ?? ""),
                description: typeof args.description === "string" ? args.description : undefined,
                labels: Array.isArray(args.labels) ? (args.labels as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
                priority: typeof args.priority === "number" ? args.priority : undefined,
                stamp: { by: "agent", agent, agentId, conversation, desk: scopeForCall(deps, ctx), folder: deps.folderFor?.(agentId, conversation) ?? null },
              });
              deps.broadcast({ type: "tasks_changed" });
              return JSON.stringify({ filed: task.id, title: task.title, priority: task.priority, labels: task.labels });
            }
            if (action === "list") {
              const tasks = await board.list();
              const mine = args.all === true ? tasks : tasks.filter((t) => t.metadata.assignedTo === conversation || (t.metadata.conversation === conversation && !t.metadata.assignedTo));
              return JSON.stringify(mine.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, labels: t.labels, assignedTo: t.metadata.assignedTo ?? null, description: t.description })), null, 2);
            }
            if (action === "comment") {
              if (typeof args.id !== "string" || typeof args.text !== "string") return { status: "error", content: "comment needs id and text" };
              await board.comment(args.id, args.text);
              return `noted on ${args.id}`;
            }
            if (action === "close") {
              if (typeof args.id !== "string") return { status: "error", content: "close needs id" };
              await board.close([args.id], typeof args.reason === "string" ? args.reason : undefined);
              deps.broadcast({ type: "tasks_changed" });
              return `${args.id} closed`;
            }
            return { status: "error", content: `unknown action "${action}" — create, list, comment, close` };
          } catch (err) {
            return { status: "error", content: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );
  }

  return disposers;
}
