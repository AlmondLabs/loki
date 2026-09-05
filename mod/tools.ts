import type { Scope } from "../shared/desk-core.ts";
import { KIT, SHARED_SCOPE, mergeData, scopeFor } from "../shared/desk-core.ts";
import type { LettaMod } from "./letta-types.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import { scopeOfId } from "./bridge.ts";
import { log, withTimeout } from "./log.ts";

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
        "Read the loci canvas (the user's browser widget desk). Returns the widgets on this conversation's desk " +
        "and on the shared desk: file, type, title, data (with the user's gesture edits applied), position, and any " +
        "build/runtime error. To ADD or CHANGE a widget, write a file — do not look for a render tool: " +
        `${deps.widgetsDir}/<desk>/<name>.json for a kit widget ({ "type", "title", "data" }; kit types — ${kitLine}) ` +
        `or <name>.tsx for a custom React component (export default function Widget({ data, onSet }); import kit pieces from "@loci/kit"). ` +
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
      name: "loci_camera",
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
        log("tool:loci_camera", { ids, dwell: args.dwell });
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

  return disposers;
}
