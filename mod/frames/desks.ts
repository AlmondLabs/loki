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
  /** Every desk the mod knows about, for the switcher. */
  listDesks?: () => DeskSummary[];
  /** Title and status of a desk's conversation. */
  deskInfo?: (scope: Scope) => DeskInfo;
  /** Delete a widget's file from disk. Returns the removed path, or null. */
  deleteWidgetFile?: (id: string) => string | null;
  /** Pin / unpin a conversation in Letta's pinned-conversations.json. */
  setPin?: (agentId: string, conversationId: string, pinned: boolean) => boolean;
  /** The models used lately, for the picker's quick picks (mod/models.ts): loki's picks, then Letta Code's own. */
  recentModels?: { read: () => string[]; add: (handle: string) => string[] };
}

/** One desk in full: its conversation's title, status, agent and model, its geometry, and its widgets. */
export function deskFrame(deps: DesksDeps, scope: Scope): { type: "desk" } & Pushes["desk"] {
  const info = deps.deskInfo?.(scope) ?? { title: null, status: "none" as DeskStatus, agentName: null, agentId: null, model: null, reasoningEffort: null };
  return { type: "desk", scope, title: info.title, status: info.status, agentName: info.agentName, agentId: info.agentId, model: info.model, reasoningEffort: info.reasoningEffort, mode: info.mode ?? null, state: deps.store.get(scope), widgets: deps.widgets.entries(scope) };
}

/** A push to the tabs on one desk, or to every socket for the shared desk. */
const audience = (scope: Scope) => (scope === SHARED_SCOPE ? undefined : scope);

/** The canvas: gestures, sizes, tidying, deleting a widget, its runtime errors, other desks' state, the desk list, pins, and the recent models. */
export function desksFrames(deps: DesksDeps): FrameHandlers {
  const { store, widgets, gestures } = deps;
  const desks = (): { type: "desks" } & Pushes["desks"] => ({ type: "desks", desks: deps.listDesks?.() ?? [] });
  return {
    gesture: ({ gesture: g }, ctx) => {
      const wScope = scopeOfId(g.id);
      const entry = widgets.get(g.id);
      const before = entry ? mergeData(entry.data, store.get(wScope).overlay[g.id]) : undefined;
      store.gesture(wScope, g); // store subscribers broadcast the new state (to tabs on that desk)
      // A widget used inline in another chat's thread: that tab is on another desk, so it gets the state too.
      if (ctx.client.scope !== wScope) ctx.push({ type: "state", scope: wScope, state: store.get(wScope) });
      ctx.track("widget_gestured", { kind: g.kind });
      const d = describeGesture(g, entry, before);
      // The widget's own desk hears about it: that is the agent whose widget it is, whichever tab was used.
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
      const ids = Object.entries(after.layout).filter(([, l]) => !l.hidden).map(([id]) => id);
      gestures.record(scope, `tidied the canvas (auto-arranged ${ids.length} widget${ids.length === 1 ? "" : "s"})`, "arrange");
      ctx.track("desk_arranged");
      ctx.broadcast({ type: "camera", widgetId: ids[0], widgetIds: ids }, audience(scope));
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
    // Another desk's widgets and state, for a thread showing them inline (the Inbox, the phone); no switch.
    desk_get: ({ scope }, ctx) => ctx.push(deskFrame(deps, scope)),
    list_desks: (_, ctx) => ctx.push(desks()),
    pin_set: ({ agentId, conversationId, pinned }, ctx) => {
      if (!deps.setPin) return;
      deps.setPin(agentId, conversationId, pinned);
      ctx.track("desk_pinned", { pinned });
      ctx.broadcast(desks()); // every tab's tree follows
    },
    models_recent_add: ({ handle }, ctx) => {
      if (!deps.recentModels) return;
      ctx.broadcast({ type: "models_recent", recent: deps.recentModels.add(handle) }); // the Mac's windows and the phones pick from the same list
    },
  };
}

const STATUS_RANK: Record<DeskStatus, number> = { live: 0, none: 0, archived: 1, deleted: 2 };

/** shared first, then live desks (pinned, then the active one, then by recency), then archived, then deleted. */
export function sortDesks(desks: DeskSummary[]): DeskSummary[] {
  return [...desks].sort((a, b) => {
    if (a.scope === SHARED_SCOPE) return -1;
    if (b.scope === SHARED_SCOPE) return 1;
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || (a.title ?? a.scope).localeCompare(b.title ?? b.scope);
  });
}
