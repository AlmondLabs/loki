import type { Scope } from "../core/desk-core.ts";
import { KIT, SHARED_SCOPE, mergeData, scopeFor } from "../core/desk-core.ts";
import type { ModApi } from "../daemon/mods/api.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { log, withTimeout } from "./log.ts";
import type { TaskStore } from "./tasks.ts";
import type { Task } from "../core/frame-types.ts";

/**
 * Two canvas tools, and four task tools when Tasks is ready. Rendering and authoring are file writes, not tool calls — the
 * agent uses its own Write/Edit on <widgetsDir>/<desk>/. The desk tools exist for
 * reading back and for directing attention.
 */

/**
 * What the agent's tools need from the mod: the desk state, widget files and gestures, how to find a call's desk, the
 * broadcast, and Tasks when it is ready.
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
  /** The shared task list (beads) and the folder a conversation works in, for the task stamp. */
  tasks?: TaskStore;
  folderFor?: (agentId: string | null, conversationId: string | null) => string | null;
}

/** A conversation's own tasks, the ones it may comment on and close: assigned to it, or filed from it and assigned nowhere. */
export const ownTask = (t: Task, conversation: string | null): boolean =>
  !!conversation && (t.metadata.assigned_to === conversation || (t.metadata.conversation === conversation && !t.metadata.assigned_to));

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

/**
 * A desk's widgets as canvas_read answers: each one's file, kind, title and data with the person's edits merged in, its
 * place on the desk when it has one, and any error.
 */
export function deskSnapshot(deps: ToolDeps, scope: Scope) {
  const state = deps.store.get(scope);
  return deps.widgets.entries(scope).map((w) => {
    const l = Object.hasOwn(state.layout, w.id) ? state.layout[w.id] : undefined;
    return {
      id: w.id,
      file: `${deps.widgetsDir}/${w.file}`,
      kind: w.kind,
      ...(w.type ? { type: w.type } : {}),
      title: w.title,
      data: mergeData(w.data, state.overlay[w.id]),
      ...(l ? { position: l.position, ...(l.size ? { size: l.size } : {}), z: l.z, ...(l.hidden ? { minimised_by_user: true } : {}) } : {}),
      ...(w.error ? { error: w.error } : {}),
    };
  });
}

/** What a tool's body is told about its call: the arguments, and the chat and agent making it. */
interface Call {
  args: Record<string, unknown>;
  conversation: { id: string };
  agent: { id: string; name: string };
}
interface LokiTool {
  name: string;
  description: string;
  parameters: object;
  annotations?: { readOnly?: boolean };
  run(ctx: Call): unknown;
}

/** A tool argument as text: the model sends strings, and now and then a number; anything else is no text. */
const argText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/**
 * Registers the agent's tools with the daemon (canvas_read, canvas_focus, and task_create, task_list, task_comment and
 * task_close when Tasks is ready); returns the functions that unregister them.
 */
export function registerTools(api: ModApi, deps: ToolDeps): Array<() => void> {
  /** One tool through the mod API; a result of `{ status: "error", content }` is a failed call with that message. */
  const tools = {
    register: (tool: LokiTool) =>
      api.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        execute: async (args, c) => {
          const out = await tool.run({ args, conversation: { id: c.chatId }, agent: { id: c.agentId, name: c.agentName } });
          if (out && typeof out === "object" && (out as { status?: unknown }).status === "error") {
            const content = (out as { content?: unknown }).content;
            throw new Error(content === undefined || content === null ? "the tool failed" : typeof content === "string" ? content : JSON.stringify(content));
          }
          return out;
        },
      }),
  };
  const kitLine = Object.entries(KIT)
    .map(([t, k]) => `${t}: ${k.data_shape}`)
    .join("; ");

  const disposers: Array<() => void> = [];

  disposers.push(
    tools.register({
      name: "canvas_read",
      annotations: { readOnly: true },
      description:
        "Read the loki canvas (the user's widgets beside this chat). Returns the widgets on this conversation's canvas " +
        "and on the shared canvas: file, type, title, data (with the user's gesture edits applied), position, and any " +
        "build/runtime error. To ADD or CHANGE a widget, write a file — do not look for a render tool: " +
        `${deps.widgetsDir}/<desk>/<name>.json for a kit widget ({ "type", "title", "data" }; kit types — ${kitLine}) ` +
        `or <name>.tsx for a custom React component (export default function Widget({ data, onSet }); import kit pieces from "@loki/kit"). ` +
        "The result is for the conversation you are in (pass `desk` to look at another). Files appear on the canvas instantly; call this again to confirm they mounted without error. " +
        "User gestures are also attached automatically to your next turn.",
      parameters: {
        type: "object",
        properties: {
          desk: { type: "string", description: 'Canvas id (a conversation id); omit for the active conversation. "shared" for the shared canvas only.' },
        },
        additionalProperties: false,
      },
      async run(ctx) {
        const args = ctx.args;
        log("tool:canvas_read:start", args);
        // A scan must never hold a turn hostage; the manifest is at most one scan stale.
        await withTimeout(deps.widgets.rescan(), 2000, "canvas_read rescan", undefined);
        const scope = scopeForCall(deps, ctx);
        const out: Record<string, unknown> = {
          desk: scope,
          widgets_dir: `${deps.widgetsDir}/${scope}`,
          widgets: deskSnapshot(deps, scope),
        };
        if (scope !== SHARED_SCOPE) {
          out.shared_widgets_dir = `${deps.widgetsDir}/${SHARED_SCOPE}`;
          out.shared = deskSnapshot(deps, SHARED_SCOPE);
        }
        const pending = [...deps.gestures.peek(scope), ...(scope !== SHARED_SCOPE ? deps.gestures.peek(SHARED_SCOPE) : [])];
        if (pending.length) out.pending_canvas_activity = pending;
        log("tool:canvas_read:done", { desk: scope, widgets: (out.widgets as unknown[]).length });
        return JSON.stringify(out, null, 2);
      },
    }),
  );

  disposers.push(
    tools.register({
      name: "canvas_focus",
      annotations: { readOnly: true },
      description:
        "Glide the user's canvas camera to one widget, or frame several together (eased zoom-to; the targets are " +
        "highlighted for a few seconds). Use it to direct attention after writing a widget or when referring to " +
        "widgets while you talk. `dwell` (ms, up to 8000) makes the call wait before returning, useful when " +
        "moving between several widgets. Ignored while the user is mid-interaction.",
      parameters: {
        type: "object",
        properties: {
          widget_id: { type: "string", description: 'One widget id as returned by canvas_read, e.g. "shared/sleep"' },
          widget_ids: { type: "array", items: { type: "string" }, description: "Several widget ids to fit in view together" },
          dwell: { type: "number", description: "Milliseconds to hold before returning (0–8000)." },
        },
        additionalProperties: false,
      },
      async run(ctx) {
        const args = ctx.args;
        const ids = Array.isArray(args.widget_ids)
          ? (args.widget_ids as unknown[]).filter((x): x is string => typeof x === "string")
          : typeof args.widget_id === "string" && args.widget_id
            ? [args.widget_id]
            : [];
        log("tool:canvas_focus", { ids, dwell: args.dwell });
        if (ids.length === 0) return { status: "error", content: "give widget_id or widget_ids" };
        const missing = ids.filter((id) => !deps.widgets.get(id));
        if (missing.length) return { status: "error", content: `no widget ${missing.map((m) => `"${m}"`).join(", ")} — check canvas_read` };
        const scopes = new Set(ids.map(scopeOfId));
        const scope = scopes.size === 1 ? [...scopes][0] : SHARED_SCOPE; // mixed desks: every tab may have them
        deps.broadcast({ type: "camera", widget_id: ids[0], widget_ids: ids }, scope === SHARED_SCOPE ? undefined : scope);
        const dwell = Math.max(0, Math.min(8000, Number(args.dwell) || 0));
        if (dwell) await new Promise((r) => setTimeout(r, dwell));
        return ids.length === 1
          ? `camera gliding to "${ids[0]}"${dwell ? `, held ${dwell}ms` : ""} (suppressed if the user is mid-interaction)`
          : `camera framing ${ids.length} widgets${dwell ? `, held ${dwell}ms` : ""}`;
      },
    }),
  );

  if (deps.tasks) {
    const store = deps.tasks;
    /** The call's chat and agent, as a task's stamp and the ownership check read them. */
    const who = (ctx: Call) => ({ conversation: ctx.conversation.id, agentId: ctx.agent.id, agent: ctx.agent.name });
    /** A task of this conversation's, or the error that says why it is not one. */
    const ownOrError = async (
      id: unknown,
      conversation: string,
      doing: "task_comment" | "task_close",
    ): Promise<{ task: Task } | { error: { status: "error"; content: string } }> => {
      const error = (content: string) => ({ error: { status: "error" as const, content } });
      if (typeof id !== "string") return error(`${doing} needs id`);
      const task = await store.find(id);
      if (!task) return error(`no task ${id} in Tasks`);
      if (ownTask(task, conversation)) return { task };
      return error(
        `${id} is not this conversation's task${task.metadata.assigned_to ? " (it is assigned to another chat)" : ""} — only a task assigned to this conversation, or filed from it, can be ${doing === "task_close" ? "closed" : "commented on"} here`,
      );
    };
    /** A tool body's error as the agent reads it. */
    const failed = (err: unknown) => ({ status: "error", content: err instanceof Error ? err.message : String(err) });
    const idArg = { type: "string", description: "The task id (lk-…)." };

    disposers.push(
      tools.register({
        name: "task_create",
        description:
          "File a task in the user's Tasks: one task list shared by the user and every agent (beads). Use it when the user " +
          "asks to note, park, or file something for later, or when you wrap up with explicit follow-ups — never on your " +
          "own initiative mid-task. The source conversation, desk and folder are stamped automatically; it returns the " +
          "task's id: tell the user the id. When the tasks assigned to this conversation change, the new list is attached " +
          "to the user's next message inside <loki-tasks>.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: 'One line, imperative ("rotate the SSO creds before the audit").' },
            description: { type: "string", description: "What, why, where to look. Enough for someone starting cold." },
            labels: { type: "array", items: { type: "string" }, description: "Short tags (aws, security, docs). The project's folder name is added for you." },
            priority: { type: "number", description: "0 (urgent) to 4 (someday); default 2." },
          },
          required: ["title"],
          additionalProperties: false,
        },
        async run(ctx) {
          const { args } = ctx;
          const { conversation, agentId, agent } = who(ctx);
          log("tool:task_create", { agent, conversation });
          try {
            const task = await store.create({
              title: argText(args.title),
              description: typeof args.description === "string" ? args.description : undefined,
              labels: Array.isArray(args.labels) ? (args.labels as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
              priority: typeof args.priority === "number" ? args.priority : undefined,
              stamp: { by: "agent", agent, agentId, conversation, desk: scopeForCall(deps, ctx), folder: deps.folderFor?.(agentId, conversation) ?? null },
            });
            deps.broadcast({ type: "tasks_changed" });
            return JSON.stringify({ filed: task.id, title: task.title, priority: task.priority, labels: task.labels });
          } catch (err) {
            return failed(err);
          }
        },
      }),
    );

    disposers.push(
      tools.register({
        name: "task_list",
        annotations: { readOnly: true },
        description: "List this conversation's tasks in the user's Tasks: those assigned to it, or filed from it; with all:true, every open task.",
        parameters: {
          type: "object",
          properties: { all: { type: "boolean", description: "Every open task in Tasks, not just this conversation's." } },
          additionalProperties: false,
        },
        async run(ctx) {
          const { conversation } = who(ctx);
          log("tool:task_list", { conversation });
          try {
            const tasks = await store.list();
            const mine = ctx.args.all === true ? tasks : tasks.filter((t) => ownTask(t, conversation));
            return JSON.stringify(
              mine.map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                priority: t.priority,
                labels: t.labels,
                assigned_to: t.metadata.assigned_to ?? null,
                description: t.description,
              })),
              null,
              2,
            );
          } catch (err) {
            return failed(err);
          }
        },
      }),
    );

    disposers.push(
      tools.register({
        name: "task_comment",
        description:
          "Add a progress note to one of this conversation's tasks (assigned to it, or filed from it and not assigned elsewhere). Comment on small steps.",
        parameters: {
          type: "object",
          properties: { id: idArg, text: { type: "string", description: "The progress note." } },
          required: ["id", "text"],
          additionalProperties: false,
        },
        async run(ctx) {
          const { conversation } = who(ctx);
          log("tool:task_comment", { conversation });
          try {
            if (typeof ctx.args.text !== "string") return { status: "error", content: "task_comment needs id and text" };
            const own = await ownOrError(ctx.args.id, conversation, "task_comment");
            if ("error" in own) return own.error;
            await store.comment(own.task.id, ctx.args.text);
            // The note shows on the message the task came from (its chip), so other tabs refetch.
            deps.broadcast({ type: "tasks_changed" });
            return `noted on ${own.task.id}`;
          } catch (err) {
            return failed(err);
          }
        },
      }),
    );

    disposers.push(
      tools.register({
        name: "task_close",
        description:
          "Finish one of this conversation's tasks with a reason, only when the whole task is done. Only the user closes " +
          "a task the user filed: on one of those, this marks it done and waiting for the user to confirm, so say what you " +
          "did in the reason.",
        parameters: {
          type: "object",
          properties: { id: idArg, reason: { type: "string", description: "What was done, one line; the user reads it when confirming a task they filed." } },
          required: ["id"],
          additionalProperties: false,
        },
        async run(ctx) {
          const { conversation, agent } = who(ctx);
          log("tool:task_close", { agent, conversation });
          try {
            const own = await ownOrError(ctx.args.id, conversation, "task_close");
            if ("error" in own) return own.error;
            const task = own.task;
            if (task.status === "closed") return `${task.id} is already closed`;
            const reason = typeof ctx.args.reason === "string" ? ctx.args.reason : undefined;
            if (task.metadata.by === "you") {
              // The user's own task: done when the user says so (Tasks › Waiting for you).
              await store.askDone(task.id, { reason, by: agent });
              deps.broadcast({ type: "tasks_changed" });
              return `${task.id} was filed by the user: it is marked done and waits for the user to confirm (or reopen it). It stays open until then.`;
            }
            await store.close([task.id], reason, { actor: task.assignee ?? agent });
            deps.broadcast({ type: "tasks_changed" });
            return `${task.id} closed`;
          } catch (err) {
            return failed(err);
          }
        },
      }),
    );
  }

  return disposers;
}
