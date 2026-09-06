import type { Gesture, Scope } from "../shared/desk-core.ts";
import { SHARED_SCOPE, mergeData, scopeFor } from "../shared/desk-core.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import { describeGesture } from "./gestures.ts";
import type { Client, WsHandlers } from "./server.ts";

/**
 * WS protocol v2 (socket-free so it is testable):
 *  server → client
 *    desk        { scope, title, status, state, widgets }   full sync for one scope (own desk + shared on connect)
 *    desk_title  { scope, title, status }    the conversation got (re)named or archived
 *    state       { scope, state }            geometry/overlay changed
 *    widgets     { scope, widgets }          files changed
 *    camera      { widgetId }
 *    switch_desk { scope }                   the active conversation changed; the tab follows
 *    desks       { desks }                   reply to list_desks (the ⌘K switcher)
 *  client → server
 *    gesture       { gesture }
 *    measure       { id, size }              rendered size of a widget (drives placement)
 *    arrange       {}                        tidy this desk into a grid
 *    trash         { id }                    delete the widget's file (the agent's work is gone for good)
 *    seen_list {} / seen_mark { agentId, conversationId } / seen_unmark { … }   reply/broadcast: seen { seen, snooze, appServer }
 *    snooze_set { agentId, conversationId, skips, until, stamp, at } / snooze_clear { agentId, conversationId }
 *    history_get { requestId, agentId, conversationId }   reply: history { requestId, agentId, conversationId, messages }
 *    tasks_list { requestId, all? }                          reply: tasks { requestId, tasks }
 *    task_create { requestId, title, description?, labels?, priority?, desk?, agentId?, agentName?, conversationId? }  reply: task_created { requestId, task }
 *    task_assign { requestId, ids, conversationId, desk, agentId?, agentName?, start? }  reply: tasks_updated { requestId, tasks }
 *    task_close { requestId, ids, reason? } / task_status { requestId, ids, status }        reply: tasks_updated; errors: task_error { requestId, message }
 *    (every board mutation also broadcasts tasks_changed {} so other tabs refetch)
 *    folders_get { requestId }                              reply: folders { requestId, byAgent, byConversation }
 *    folder_complete { requestId, prefix }                  reply: folder_matches { requestId, matches }
 *    folder_check { requestId, path }                       reply: folder_status { requestId, ok, path, branch, reason }
 *    folder_pick { requestId, defaultPath }                 reply: folder_picked { requestId, path }
 *  Catch Up itself talks to Letta's app-server through the /appserver tunnel (see server.ts).
 *    widget_status { id, error }             runtime/HMR error from the tab (null clears)
 *    list_desks    {}
 */

/** live: conversation exists. archived: Letta archived it. deleted: bound once, conversation gone. none: never bound (shared, orphan folder). */
export type DeskStatus = "live" | "archived" | "deleted" | "none";

export interface DeskInfo {
  title: string | null;
  status: DeskStatus;
  /** Which agent owns the conversation behind this desk. */
  agentName: string | null;
  agentId: string | null;
}

export interface DeskSummary extends DeskInfo {
  scope: Scope;
  conversationId: string | null;
  widgets: number;
  active: boolean;
  lastActive: string | null;
}

const STATUS_RANK: Record<DeskStatus, number> = { live: 0, none: 0, archived: 1, deleted: 2 };

/** shared first, then the active desk, then live desks by recency, then archived, then deleted. */
export function sortDesks(desks: DeskSummary[]): DeskSummary[] {
  return [...desks].sort((a, b) => {
    if (a.scope === SHARED_SCOPE) return -1;
    if (b.scope === SHARED_SCOPE) return 1;
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || (a.title ?? a.scope).localeCompare(b.title ?? b.scope);
  });
}

export interface BridgeDeps {
  store: DeskStore;
  widgets: WidgetsWatcher;
  gestures: GestureLog;
  /** Every desk the mod knows about, for the switcher. */
  listDesks?: () => DeskSummary[];
  /** Title and status of a desk's conversation. */
  deskInfo?: (scope: Scope) => DeskInfo;
  /** Delete a widget's file from disk. Returns the removed path, or null. */
  deleteWidgetFile?: (id: string) => string | null;
  /** Catch Up lives in the browser; the mod only brokers the app-server tunnel and keeps seen markers. */
  seen?: import("./seen.ts").SeenStore;
  appServerAvailable?: () => boolean;
  appServerUrl?: () => string | null;
  /** A conversation's transcript from the local backend log (survives compaction), for Catch Up threads. */
  transcript?: (agentId: string | null, conversationId: string) => import("./desks.ts").LocalTranscriptMessage[];
  /** Working folders for "new desk" (see mod/folders.ts). */
  folders?: {
    recent: () => import("./folders.ts").RecentFolders;
    complete: (prefix: string) => string[];
    check: (path: string) => import("./folders.ts").FolderCheck;
    pick: (defaultPath?: string) => Promise<string | null>;
  };
  /** The board (mod/tasks.ts) and the folder a conversation works in, for the task stamp. */
  tasks?: import("./tasks.ts").TaskBoard;
  folderFor?: (agentId: string | null, conversationId: string | null) => string | null;
  broadcast(msg: object, scope?: Scope): void;
}

export function scopeOfId(id: string): Scope {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : SHARED_SCOPE;
}

function isGesture(v: unknown): v is Gesture {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  if (typeof g.id !== "string" || !g.id) return false;
  switch (g.kind) {
    case "move":
      return isPoint(g.position);
    case "resize":
      return typeof g.size === "object" && g.size !== null && isNum((g.size as Record<string, unknown>).w) && isNum((g.size as Record<string, unknown>).h);
    case "focus":
    case "close":
    case "open":
      return true;
    case "set":
      return typeof g.path === "string" && g.path.length > 0;
    default:
      return false;
  }
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): boolean =>
  typeof v === "object" && v !== null && isNum((v as Record<string, unknown>).x) && isNum((v as Record<string, unknown>).y);

export function createBridge(deps: BridgeDeps): WsHandlers {
  const { store, widgets, gestures, broadcast, listDesks, deskInfo, deleteWidgetFile, seen, appServerAvailable, appServerUrl, transcript, folders } = deps;

  const deskFrame = (scope: Scope) => {
    const info = deskInfo?.(scope) ?? { title: null, status: "none" as DeskStatus, agentName: null, agentId: null };
    return { type: "desk", scope, title: info.title, status: info.status, agentName: info.agentName, agentId: info.agentId, state: store.get(scope), widgets: widgets.entries(scope) };
  };

  return {
    appServerUrl: () => appServerUrl?.() ?? null,
    onConnect(client: Client) {
      client.send({ type: "config", appServer: appServerAvailable?.() ?? false });
      client.send(deskFrame(client.scope));
      if (client.scope !== SHARED_SCOPE) client.send(deskFrame(SHARED_SCOPE));
    },

    onMessage(client: Client, msg: Record<string, unknown>) {
      switch (msg.type) {
        case "gesture": {
          const g = msg.gesture;
          if (!isGesture(g)) {
            client.send({ type: "error", message: "malformed gesture" });
            return;
          }
          const wScope = scopeOfId(g.id);
          const entry = widgets.get(g.id);
          const before = entry ? mergeData(entry.data, store.get(wScope).overlay[g.id]) : undefined;
          store.gesture(wScope, g); // store subscribers broadcast the new state
          const d = describeGesture(g, entry, before);
          if (d) gestures.record(client.scope, d.line, d.key);
          return;
        }
        case "measure": {
          const size = msg.size as { w?: unknown; h?: unknown } | undefined;
          if (typeof msg.id !== "string" || !size || !isNum(size.w) || !isNum(size.h)) return;
          store.measure(scopeOfId(msg.id), msg.id, { w: size.w, h: size.h });
          return;
        }
        case "arrange": {
          const before = store.get(client.scope);
          const after = store.arrange(client.scope);
          if (after !== before) {
            const ids = Object.entries(after.layout).filter(([, l]) => !l.hidden).map(([id]) => id);
            gestures.record(client.scope, `tidied the desk (auto-arranged ${ids.length} widget${ids.length === 1 ? "" : "s"})`, "arrange");
            broadcast({ type: "camera", widgetId: ids[0], widgetIds: ids }, client.scope === SHARED_SCOPE ? undefined : client.scope);
          }
          return;
        }
        case "seen_list": {
          client.send({ type: "seen", seen: seen?.all() ?? {}, snooze: seen?.snoozes() ?? {}, appServer: appServerAvailable?.() ?? false });
          return;
        }
        case "seen_mark":
          if (typeof msg.conversationId === "string") {
            seen?.mark(typeof msg.agentId === "string" ? msg.agentId : null, msg.conversationId);
            broadcast({ type: "seen", seen: seen?.all() ?? {}, snooze: seen?.snoozes() ?? {}, appServer: appServerAvailable?.() ?? false });
          }
          return;
        case "seen_unmark":
          if (typeof msg.conversationId === "string") {
            seen?.unmark(typeof msg.agentId === "string" ? msg.agentId : null, msg.conversationId);
            broadcast({ type: "seen", seen: seen?.all() ?? {}, snooze: seen?.snoozes() ?? {}, appServer: appServerAvailable?.() ?? false });
          }
          return;
        case "snooze_set": {
          const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
          const skips = Number(msg.skips);
          if (typeof msg.conversationId === "string" && Number.isFinite(skips) && typeof msg.until === "string" && typeof msg.stamp === "string" && typeof msg.at === "string") {
            seen?.setSnooze(agentId, msg.conversationId, { skips, until: msg.until, stamp: msg.stamp, at: msg.at });
            broadcast({ type: "seen", seen: seen?.all() ?? {}, snooze: seen?.snoozes() ?? {}, appServer: appServerAvailable?.() ?? false });
          }
          break;
        }
        case "snooze_clear":
          if (typeof msg.conversationId === "string") {
            seen?.clearSnooze(typeof msg.agentId === "string" ? msg.agentId : null, msg.conversationId);
            broadcast({ type: "seen", seen: seen?.all() ?? {}, snooze: seen?.snoozes() ?? {}, appServer: appServerAvailable?.() ?? false });
          }
          break;
        case "trash": {
          if (typeof msg.id !== "string" || !deleteWidgetFile) return;
          const entry = widgets.get(msg.id);
          const removed = deleteWidgetFile(msg.id);
          if (!removed) {
            client.send({ type: "error", message: `could not delete ${msg.id}` });
            return;
          }
          store.forget(scopeOfId(msg.id), msg.id);
          const name = entry ? `"${entry.title}" (${entry.id})` : `"${msg.id}"`;
          gestures.record(client.scope, `trashed ${name} — its file was deleted`, `trash:${msg.id}`);
          return;
        }
        case "widget_status": {
          if (typeof msg.id !== "string") return;
          const error = typeof msg.error === "string" && msg.error.trim() ? msg.error.trim() : null;
          if (!widgets.setRuntimeError(msg.id, error)) return;
          const scope = scopeOfId(msg.id);
          broadcast({ type: "widgets", scope, widgets: widgets.entries(scope) }, scope === SHARED_SCOPE ? undefined : scope);
          if (error) {
            const entry = widgets.get(msg.id);
            const name = entry ? `"${entry.title}" (${entry.id})` : `"${msg.id}"`;
            gestures.record(client.scope, `widget ${name} failed to render: ${error}`, `error:${msg.id}`);
          }
          return;
        }
        case "list_desks": {
          client.send({ type: "desks", desks: listDesks?.() ?? [] });
          return;
        }
        case "folders_get": {
          const r = folders?.recent() ?? { byAgent: {}, byConversation: {} };
          client.send({ type: "folders", requestId: msg.requestId, byAgent: r.byAgent, byConversation: r.byConversation });
          return;
        }
        case "folder_complete": {
          client.send({ type: "folder_matches", requestId: msg.requestId, matches: typeof msg.prefix === "string" ? folders?.complete(msg.prefix) ?? [] : [] });
          return;
        }
        case "folder_check": {
          const r = typeof msg.path === "string" && folders ? folders.check(msg.path) : { ok: false, path: String(msg.path ?? ""), branch: null, reason: "no path" };
          client.send({ type: "folder_status", requestId: msg.requestId, ...r });
          return;
        }
        case "folder_pick": {
          const requestId = msg.requestId;
          void (folders?.pick(typeof msg.defaultPath === "string" ? msg.defaultPath : undefined) ?? Promise.resolve(null)).then((path) => client.send({ type: "folder_picked", requestId, path }));
          return;
        }
        case "tasks_list":
        case "task_create":
        case "task_assign":
        case "task_close":
        case "task_status": {
          const requestId = msg.requestId;
          const board = deps.tasks;
          const fail = (err: unknown) => client.send({ type: "task_error", requestId, message: err instanceof Error ? err.message : String(err) });
          if (!board) return fail(new Error("the board is not available in this mod"));
          const ids = Array.isArray(msg.ids) ? (msg.ids as unknown[]).filter((x): x is string => typeof x === "string") : typeof msg.id === "string" ? [msg.id] : [];
          const done = (tasks: unknown) => {
            client.send({ type: "tasks_updated", requestId, tasks });
            deps.broadcast({ type: "tasks_changed" });
          };
          if (msg.type === "tasks_list") {
            void board.list({ all: msg.all === true }).then((tasks) => client.send({ type: "tasks", requestId, tasks })).catch(fail);
          } else if (msg.type === "task_create") {
            const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
            const conversation = typeof msg.conversationId === "string" ? msg.conversationId : null;
            void board
              .create({
                title: String(msg.title ?? ""),
                description: typeof msg.description === "string" ? msg.description : undefined,
                labels: Array.isArray(msg.labels) ? (msg.labels as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
                priority: typeof msg.priority === "number" ? msg.priority : undefined,
                stamp: { by: "you", agent: typeof msg.agentName === "string" ? msg.agentName : null, agentId, conversation, desk: typeof msg.desk === "string" ? msg.desk : null, folder: deps.folderFor?.(agentId, conversation) ?? null },
              })
              .then((task) => {
                client.send({ type: "task_created", requestId, task });
                deps.broadcast({ type: "tasks_changed" });
              })
              .catch(fail);
          } else if (msg.type === "task_assign") {
            if (typeof msg.conversationId !== "string" || typeof msg.desk !== "string") return fail(new Error("assign needs a conversation and a desk"));
            void board
              .assign(ids, { agent: typeof msg.agentName === "string" ? msg.agentName : null, agentId: typeof msg.agentId === "string" ? msg.agentId : null, conversation: msg.conversationId, desk: msg.desk }, msg.start === true ? "in_progress" : "open")
              .then(done)
              .catch(fail);
          } else if (msg.type === "task_close") {
            void board.close(ids, typeof msg.reason === "string" ? msg.reason : undefined).then(done).catch(fail);
          } else {
            const status = msg.status;
            if (status !== "open" && status !== "in_progress" && status !== "blocked" && status !== "deferred") return fail(new Error(`unknown status ${String(status)}`));
            void board.setStatus(ids, status).then(done).catch(fail);
          }
          return;
        }
        case "history_get": {
          if (typeof msg.conversationId !== "string") return;
          const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
          client.send({ type: "history", requestId: msg.requestId, agentId, conversationId: msg.conversationId, messages: transcript?.(agentId, msg.conversationId) ?? [] });
          return;
        }
        default:
          client.send({ type: "error", message: `unsupported message type: ${String(msg.type)}` });
      }
    },
  };
}
