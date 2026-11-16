import { SHARED_SCOPE, mergeData, scopeOfId, type Scope } from "../../core/desk-core.ts";
import type { Pushes } from "../../core/frames.ts";
import type { DeskInfo, DeskStatus, DeskSummary } from "../../core/frame-types.ts";
import type { DeskStore } from "../desk-store.ts";
import { describeGesture, type GestureLog } from "../gestures.ts";
import type { WidgetsWatcher } from "../widgets-fs.ts";
import type { FrameHandlers } from "./context.ts";

export interface DesksDeps {
  store: DeskStore;
  widgets: WidgetsWatcher;
  gestures: GestureLog;
  listDesks?: () => DeskSummary[];
  deskInfo?: (scope: Scope) => DeskInfo;
  deleteWidgetFile?: (id: string) => string | null;
  setPin?: (agentId: string, conversationId: string, pinned: boolean) => boolean;
  recentModels?: { read: () => string[]; add: (handle: string) => string[] };
}

export function deskFrame(deps: DesksDeps, scope: Scope): { type: "desk" } & Pushes["desk"] {
  const info = deps.deskInfo?.(scope) ?? { title: null, status: "none" as DeskStatus, agent_name: null, agent_id: null, model: null, reasoning_effort: null };
  return {
    type: "desk",
    scope,
    title: info.title,
    status: info.status,
    agent_name: info.agent_name,
    agent_id: info.agent_id,
    model: info.model,
    reasoning_effort: info.reasoning_effort,
    mode: info.mode ?? null,
    state: deps.store.get(scope),
    widgets: deps.widgets.entries(scope),
  };
}

const audience = (scope: Scope) => (scope === SHARED_SCOPE ? undefined : scope);

export function desksFrames(deps: DesksDeps): FrameHandlers {
  const { store, widgets, gestures } = deps;
  const desks = (): { type: "desks" } & Pushes["desks"] => ({ type: "desks", desks: deps.listDesks?.() ?? [] });
  return {
    gesture: ({ gesture: g }, ctx) => {
      const wScope = scopeOfId(g.id);
      const entry = widgets.get(g.id);
      const before = entry ? mergeData(entry.data, store.get(wScope).overlay[g.id]) : undefined;
      store.gesture(wScope, g);
      if (ctx.client.scope !== wScope) ctx.push({ type: "state", scope: wScope, state: store.get(wScope) });
      ctx.track("widget_gestured", { kind: g.kind });
      const d = describeGesture(g, entry, before);
      if (d) gestures.record(wScope, d.line, d.key);
    },
    measure: ({ id, size }) => {
      store.measure(scopeOfId(id), id, size);
    },
    arrange: (_, ctx) => {
      const scope = ctx.client.scope;
      const before = store.get(scope);
      const after = store.arrange(scope);
      if (after === before) return;
      const ids = Object.entries(after.layout)
        .filter(([, l]) => !l.hidden)
        .map(([id]) => id);
      gestures.record(scope, `tidied the canvas (auto-arranged ${ids.length} widget${ids.length === 1 ? "" : "s"})`, "arrange");
      ctx.track("desk_arranged");
      ctx.broadcast({ type: "camera", widget_id: ids[0], widget_ids: ids }, audience(scope));
    },
    trash: ({ id }, ctx) => {
      if (!deps.deleteWidgetFile) return;
      const entry = widgets.get(id);
      if (!deps.deleteWidgetFile(id)) throw new Error(`could not delete ${id}`);
      store.forget(scopeOfId(id), id);
      const name = entry ? `"${entry.title}" (${entry.id})` : `"${id}"`;
      gestures.record(ctx.client.scope, `trashed ${name} — its file was deleted`, `trash:${id}`);
      ctx.track("widget_trashed");
    },
    widget_status: ({ id, error }, ctx) => {
      if (!widgets.setRuntimeError(id, error)) return;
      const scope = scopeOfId(id);
      ctx.broadcast({ type: "widgets", scope, widgets: widgets.entries(scope) }, audience(scope));
      if (!error) return;
      const entry = widgets.get(id);
      const name = entry ? `"${entry.title}" (${entry.id})` : `"${id}"`;
      gestures.record(ctx.client.scope, `widget ${name} failed to render: ${error}`, `error:${id}`);
    },
    desk_get: ({ scope }, ctx) => ctx.push(deskFrame(deps, scope)),
    list_desks: (_, ctx) => ctx.push(desks()),
    pin_set: ({ agent_id: agentId, conversation_id: conversationId, pinned }, ctx) => {
      if (!deps.setPin) return;
      deps.setPin(agentId, conversationId, pinned);
      ctx.track("desk_pinned", { pinned });
      ctx.broadcast(desks());
    },
    models_recent_add: ({ handle }, ctx) => {
      if (!deps.recentModels) return;
      ctx.broadcast({ type: "models_recent", recent: deps.recentModels.add(handle) });
    },
  };
}

const STATUS_RANK: Record<DeskStatus, number> = { live: 0, none: 0, archived: 1, deleted: 2 };

export function sortDesks(desks: DeskSummary[]): DeskSummary[] {
  return [...desks].sort((a, b) => {
    if (a.scope === SHARED_SCOPE) return -1;
    if (b.scope === SHARED_SCOPE) return 1;
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.last_active ?? "").localeCompare(a.last_active ?? "") || (a.title ?? a.scope).localeCompare(b.title ?? b.scope);
  });
}
