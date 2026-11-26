import { SHARED_SCOPE, scopeOfId, type Scope } from "../../core/canvas-core.ts";
import type { Pushes } from "../../core/frames.ts";
import type { ChatMeta, ChatStatus, ChatSummary } from "../../core/frame-types.ts";
import type { CanvasStore } from "../canvas-store.ts";
import type { WidgetsWatcher } from "../widgets-fs.ts";
import type { FrameHandlers } from "./context.ts";

export interface CanvasDeps {
  store: CanvasStore;
  widgets: WidgetsWatcher;
  listChats?: () => ChatSummary[];
  chatMeta?: (scope: Scope) => ChatMeta;
  deleteWidgetFile?: (id: string) => string | null;
  setPin?: (agentId: string, conversationId: string, pinned: boolean) => boolean;
  recentModels?: { read: () => string[]; add: (handle: string) => string[] };
}

export function canvasFrame(deps: CanvasDeps, scope: Scope): { type: "canvas" } & Pushes["canvas"] {
  const info = deps.chatMeta?.(scope) ?? { title: null, status: "none" as ChatStatus, agent_name: null, agent_id: null, model: null, reasoning_effort: null };
  return {
    type: "canvas",
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

export function canvasFrames(deps: CanvasDeps): FrameHandlers {
  const { store, widgets } = deps;
  const chats = (): { type: "chats" } & Pushes["chats"] => ({ type: "chats", chats: deps.listChats?.() ?? [] });
  return {
    gesture: ({ gesture: g }, ctx) => {
      const wScope = scopeOfId(g.id);
      store.gesture(wScope, g);
      if (ctx.client.scope !== wScope) ctx.push({ type: "state", scope: wScope, state: store.get(wScope) });
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
      ctx.broadcast({ type: "camera", widget_id: ids[0], widget_ids: ids }, audience(scope));
    },
    trash: ({ id }) => {
      if (!deps.deleteWidgetFile) return;
      if (!deps.deleteWidgetFile(id)) throw new Error(`could not delete ${id}`);
      store.forget(scopeOfId(id), id);
    },
    widget_status: ({ id, error }, ctx) => {
      if (!widgets.setRuntimeError(id, error)) return;
      const scope = scopeOfId(id);
      ctx.broadcast({ type: "widgets", scope, widgets: widgets.entries(scope) }, audience(scope));
    },
    canvas_get: ({ scope }, ctx) => ctx.push(canvasFrame(deps, scope)),
    chats_list: (_, ctx) => ctx.push(chats()),
    pin_set: ({ agent_id: agentId, conversation_id: conversationId, pinned }, ctx) => {
      if (!deps.setPin) return;
      deps.setPin(agentId, conversationId, pinned);
      ctx.broadcast(chats());
    },
    models_recent_add: ({ handle }, ctx) => {
      if (!deps.recentModels) return;
      ctx.broadcast({ type: "models_recent", recent: deps.recentModels.add(handle) });
    },
  };
}

const STATUS_RANK: Record<ChatStatus, number> = { live: 0, none: 0, archived: 1, deleted: 2 };

export function sortChats(desks: ChatSummary[]): ChatSummary[] {
  return [...desks].sort((a, b) => {
    if (a.scope === SHARED_SCOPE) return -1;
    if (b.scope === SHARED_SCOPE) return 1;
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.last_active ?? "").localeCompare(a.last_active ?? "") || (a.title ?? a.scope).localeCompare(b.title ?? b.scope);
  });
}
