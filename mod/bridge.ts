import { clampTickMinutes, DEFAULT_TICK_MINUTES } from "./recall.ts";
import { DEFAULT_LADDER } from "../core/attention/ladder.ts";
import { USAGE_ACTION_RE } from "../core/usage.ts";
import type { Gesture, Scope } from "../core/desk-core.ts";
import type { ReasoningEffort } from "../core/models.ts";
import type { InboxRow } from "./desks.ts";
import { toAnkiTsv } from "../core/recall/model.ts";
import { SHARED_SCOPE, mergeData } from "../core/desk-core.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import { describeGesture } from "./gestures.ts";
import type { Client, WsHandlers } from "./server.ts";
import { isAgentId } from "./agents.ts";
import { isLanVia } from "./lan.ts";

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
 *    snooze_ladder { firstMinutes?, growth? }   how long "later" hides a card (core/attention/ladder.ts); broadcast: seen { …, ladder }
 *    history_get { requestId, agentId, conversationId }   reply: history { requestId, agentId, conversationId, messages }
 *    inbox_list { requestId }                reply: inbox { requestId, conversations } — every open conversation from disk, with who spoke last
 *    recall_list { requestId }               reply: recall { requestId, cards, rejected, worker } — the whole Recall section (mod/recall.ts)
 *    recall_grade { requestId, id, grade 1-4 } / recall_edit { requestId, id, front?, back?, tags? }   reply: recall_card { requestId, card }
 *    recall_reject { requestId, id } / recall_restore { requestId, id } / recall_forget { requestId, id }   reply: recall_card { requestId, card|null }
 *    recall_settings { requestId, enabled?, model?, dailyCap?, tickMinutes? }   reply: recall { … };  recall_run { requestId }  reply: recall_ran { requestId, note }
 *    recall_export { requestId }             reply: recall_export { requestId, tsv };  errors: recall_error { requestId, message }
 *    recall_lead_dismiss { requestId, id } / recall_lead_restore { requestId, id }   reply: recall { … }
 *    recall_lead_start { requestId, id }     the lead becomes a [Learn] conversation with an info card on its desk; reply: recall_lesson { requestId, agentId, conversationId } — the app then sends the brief
 *    (every change also broadcasts recall_changed {} so other tabs and phones refetch)
 *    tasks_list { requestId, all? }                          reply: tasks { requestId, tasks }
 *    task_create { requestId, title, description?, labels?, priority?, desk?, agentId?, agentName?, conversationId? }  reply: task_created { requestId, task }
 *    task_assign { requestId, ids, conversationId, desk, agentId?, agentName?, start? }  reply: tasks_updated { requestId, tasks }
 *    task_close { requestId, ids, reason? } / task_status { requestId, ids, status }        reply: tasks_updated; errors: task_error { requestId, message }
 *    (every board mutation also broadcasts tasks_changed {} so other tabs refetch)
 *    agent_get { requestId, agentId }        reply: agent { requestId, agent, files, skills, hasProfile, lastCommit }
 *    memory_read { requestId, agentId, path } reply: memory_file { requestId, agentId, path, content|null }
 *    memory_log { requestId, agentId, path?, limit? }  reply: memory_commits { requestId, agentId, commits }
 *    memory_diff { requestId, agentId, sha }  reply: memory_diff { requestId, agentId, sha, diff }; errors: agent_error
 *    reflection_state { requestId, agentId }  reply: reflection_state { requestId, agentId, conversations, lastCommit } (mod/reflection.ts)
 *    skills_global { requestId }             reply: skills_global { requestId, skills } (~/.letta/skills, mod/skills.ts)
 *    skill_install { requestId, agentId, source, force? }  reply: skill_installed { requestId, agentId, output }; errors: agent_error
 *    skill_refresh { requestId, agentId, name, source? }   reply: skill_refreshed { requestId, agentId, name, outcome: "current" | "replaced" | "reconcile", label, changed?, upstreamPath?, prompt? }
 *                                            (source, when given, is remembered for this agent's skill; errors: agent_error, e.g. "no known source")
 *  HTTP: GET /agents/<agentId>/profile.png?t=<token>  the agent's face from its memory filesystem
 *    folders_get { requestId }                              reply: folders { requestId, byAgent, byConversation }
 *    folder_complete { requestId, prefix }                  reply: folder_matches { requestId, matches }
 *    folder_check { requestId, path }                       reply: folder_status { requestId, ok, path, branch, reason }
 *    folder_pick { requestId, defaultPath }                 reply: folder_picked { requestId, path }
 *  Catch Up itself talks to Letta's app-server through the /appserver tunnel (see server.ts).
 *    widget_status { id, error }             runtime/HMR error from the tab (null clears)
 *    list_desks    {}
 *    pin_set       { agentId, conversationId, pinned }   → broadcast desks (pins live in ~/.letta/pinned-conversations.json)
 *  The phone listener (mod/lan.ts), controlled from Settings:
 *    lan_get {}                    reply: lan_status { enabled, address, addresses, host, port, appServed, error, via, tailscale }
 *                                  (re-reads Tailscale first; tailscale = { installed, running, ip, name, serveUrl, error } | null)
 *    lan_set { enabled }           reply: lan_status (persisted to state/lan.json first, then bind/close); also broadcast
 *    lan_via_set { via }           via: "tailscale" | "lan"; persisted; reply lan_status; also broadcast
 *    lan_serve_set { enabled }     `tailscale serve --bg --https=443 http://127.0.0.1:<port>` or off; reply lan_status
 *                                  (a CLI complaint lands in tailscale.error, never in an error frame)
 *    pair_begin {}                 reply: pair_code { code, url, expiresAt }   (url = <serveUrl | http://<tailnet name>:<port> | http://<host>:<port>>/?code=<code>)
 *    devices_list {}               reply: devices { devices: [{ id, name, createdAt, lastSeenAt, lastVia? }] }  (lastVia: "tailscale" | "lan", the route of the last request)
 *    device_forget { id }          broadcast devices (that device's sockets close)
 *    (lan_status is broadcast on enable/disable/bind error/via change/serve change/a tailnet change; devices on pair/forget/seen)
 */

/** live: conversation exists. archived: Letta archived it. deleted: bound once, conversation gone. none: never bound (shared, orphan folder). */
export type DeskStatus = "live" | "archived" | "deleted" | "none";

export interface DeskInfo {
  title: string | null;
  status: DeskStatus;
  /** Which agent owns the conversation behind this desk. */
  agentName: string | null;
  agentId: string | null;
  /** The model this conversation runs on: its own override, else the agent's. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** The permission mode Letta persisted for this conversation (default: unrestricted). */
  mode?: string | null;
}

export interface DeskSummary extends DeskInfo {
  scope: Scope;
  conversationId: string | null;
  /** Pinned in Letta's pinned-conversations.json (shared with Desktop). */
  pinned?: boolean;
  widgets: number;
  active: boolean;
  lastActive: string | null;
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

export interface BridgeDeps {
  store: DeskStore;
  widgets: WidgetsWatcher;
  gestures: GestureLog;
  /** Every desk the mod knows about, for the switcher. */
  listDesks?: () => DeskSummary[];
  /** Every open conversation of the user's own agents, with its digest, for the inbox (mod/desks.ts). */
  listInbox?: () => InboxRow[];
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
  /** The Agents page: the local record and the memory filesystem (mod/agents.ts), read-only. */
  agents?: {
    get: (agentId: string) => import("./agents.ts").LocalAgent | null;
    tree: (agentId: string) => import("./agents.ts").MemoryFile[];
    skills: (agentId: string) => import("./agents.ts").MemorySkill[];
    hasProfile: (agentId: string) => boolean;
    read: (agentId: string, path: string) => string | null;
    log: (agentId: string, opts: { path?: string; limit?: number }) => Promise<import("./agents.ts").MemoryCommit[]>;
    diff: (agentId: string, sha: string) => Promise<string>;
    /** Letta's reflection counters per conversation and the last pass that changed memory (mod/reflection.ts). */
    reflection?: (agentId: string) => Promise<import("./reflection.ts").ReflectionState>;
    /** Skills outside memory (mod/skills.ts). */
    globalSkills?: () => import("./skills.ts").GlobalSkill[];
    install?: (agentId: string, source: string, force: boolean) => Promise<string>;
    /** Memory skills with origin (self/other), edited, and source (mod/skill-sources.ts); agent_get prefers this over `skills`. */
    skillsInfo?: (agentId: string) => Promise<import("./skill-sources.ts").MemorySkillInfo[]>;
    /** Fetch an other skill's upstream and replace, stage for reconciliation, or report current. */
    refreshSkill?: (agentId: string, name: string, spec?: string) => Promise<import("./skill-sources.ts").RefreshOutcome>;
  };
  /** Pin / unpin a conversation in Letta's pinned-conversations.json. */
  setPin?: (agentId: string, conversationId: string, pinned: boolean) => boolean;
  /** Recall (mod/recall.ts, mod/recall-worker.ts): the cards on disk and a way to run the worker now. */
  recall?: {
    store: import("./recall.ts").RecallStore;
    run: () => Promise<{ note: string }>;
    /** The sweep timer follows the setting: called with the new interval when `tickMinutes` changes. */
    reschedule?: (minutes: number) => void;
    startLesson?: import("./recall-worker.ts").StartLesson;
    /** True while the lesson's conversation holds no message: the brief never arrived and the app offers to send it again. */
    lessonEmpty?: (lesson: import("../core/recall/model.ts").Lesson) => boolean;
  };
  /** The board (mod/tasks.ts) and the folder a conversation works in, for the task stamp. */
  tasks?: import("./tasks.ts").TaskBoard;
  folderFor?: (agentId: string | null, conversationId: string | null) => string | null;
  /** The phone listener (mod/lan.ts) and its paired devices, for Settings › phone. */
  lan?: {
    status: () => import("./lan.ts").LanStatus;
    /** status() after asking Tailscale again (what lan_get answers with). */
    refresh: () => Promise<import("./lan.ts").LanStatus>;
    setEnabled: (enabled: boolean) => Promise<import("./lan.ts").LanStatus>;
    /** Which route the QR encodes; persisted. */
    setVia: (via: import("./lan.ts").LanVia) => import("./lan.ts").LanStatus;
    /** `tailscale serve` on or off for the listener. */
    setServe: (enabled: boolean) => Promise<import("./lan.ts").LanStatus>;
    /** Mint a pairing code and the URL the QR carries. */
    pairBegin: () => { code: string; url: string; expiresAt: string };
    devices: () => import("./devices.ts").DeviceSummary[];
    /** Forget a device and close its sockets. */
    forget: (id: string) => boolean;
  };
  broadcast(msg: object, scope?: Scope): void;
  /** The usage log (mod/usage.ts): an action this client took, or a `usage` frame it sent about one the mod cannot see. */
  usage?: (client: Client, action: string, detail?: Record<string, unknown>) => void;
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

/**
 * The frames a paired phone may send over its /ws (mod/lan.ts); everything else answers `error`.
 * Reads and the user's own markers: desks, transcripts, seen/snooze, pins, recent folders, and the
 * read-only agent pages (record, memory tree and files, git log and diffs). Never gestures, the board,
 * skills, or the pairing and device frames.
 */
export const PHONE_FRAMES: ReadonlySet<string> = new Set(["usage", "list_desks", "seen_list", "seen_mark", "seen_unmark", "snooze_set", "snooze_clear", "history_get", "inbox_list", "pin_set", "folders_get", "agent_get", "memory_read", "memory_log", "memory_diff", "recall_list", "recall_grade", "recall_reject", "recall_restore", "recall_edit", "recall_export"]);

export function createBridge(deps: BridgeDeps): WsHandlers {
  const { store, widgets, gestures, broadcast, listDesks, deskInfo, deleteWidgetFile, seen, appServerAvailable, appServerUrl, transcript, folders } = deps;

  /** The seen markers, the deferrals and the "later" ladder, as one frame; sent on request and broadcast on every change. */
  const seenFrame = () => ({ type: "seen", seen: seen?.all() ?? {}, snooze: seen?.snoozes() ?? {}, ladder: seen?.ladder() ?? DEFAULT_LADDER, appServer: appServerAvailable?.() ?? false });

  const deskFrame = (scope: Scope) => {
    const info = deskInfo?.(scope) ?? { title: null, status: "none" as DeskStatus, agentName: null, agentId: null, model: null, reasoningEffort: null };
    return { type: "desk", scope, title: info.title, status: info.status, agentName: info.agentName, agentId: info.agentId, model: info.model, reasoningEffort: info.reasoningEffort, mode: info.mode ?? null, state: store.get(scope), widgets: widgets.entries(scope) };
  };

  return {
    appServerUrl: () => appServerUrl?.() ?? null,
    onConnect(client: Client) {
      client.send({ type: "config", appServer: appServerAvailable?.() ?? false });
      client.send(deskFrame(client.scope));
      if (client.scope !== SHARED_SCOPE) client.send(deskFrame(SHARED_SCOPE));
    },

    onMessage(client: Client, msg: Record<string, unknown>) {
      // A paired phone shares this bridge with the desktop but not its authority: it reads desks and
      // transcripts and keeps its seen/snooze markers, nothing else (no gestures, board, pins, folders,
      // skills, agents, and never the pairing and device frames that mint or evict phones).
      if (client.deviceId && !PHONE_FRAMES.has(String(msg.type))) {
        return client.send({ type: "error", requestId: msg.requestId, message: `${String(msg.type)} is not available on the phone` });
      }
      const note = (action: string, detail?: Record<string, unknown>) => deps.usage?.(client, action, detail);
      switch (msg.type) {
        case "usage": {
          // The app's own moves (views, desk switches, sends…): a plain lowercase action and an optional detail object.
          if (typeof msg.action !== "string" || !USAGE_ACTION_RE.test(msg.action)) {
            client.send({ type: "error", message: "malformed usage" });
            return;
          }
          note(msg.action, msg.detail && typeof msg.detail === "object" && !Array.isArray(msg.detail) ? (msg.detail as Record<string, unknown>) : undefined);
          return;
        }
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
          note("gesture", { kind: g.kind });
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
            note("arrange");
            broadcast({ type: "camera", widgetId: ids[0], widgetIds: ids }, client.scope === SHARED_SCOPE ? undefined : client.scope);
          }
          return;
        }
        case "seen_list": {
          client.send(seenFrame());
          return;
        }
        case "seen_mark":
          if (typeof msg.conversationId === "string") {
            seen?.mark(typeof msg.agentId === "string" ? msg.agentId : null, msg.conversationId);
            note("seen");
            broadcast(seenFrame());
          }
          return;
        case "seen_unmark":
          if (typeof msg.conversationId === "string") {
            seen?.unmark(typeof msg.agentId === "string" ? msg.agentId : null, msg.conversationId);
            note("unread");
            broadcast(seenFrame());
          }
          return;
        case "snooze_set": {
          const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
          const skips = Number(msg.skips);
          if (typeof msg.conversationId === "string" && Number.isFinite(skips) && typeof msg.until === "string" && typeof msg.stamp === "string" && typeof msg.at === "string") {
            seen?.setSnooze(agentId, msg.conversationId, { skips, until: msg.until, stamp: msg.stamp, at: msg.at });
            note("later", { skips });
            broadcast(seenFrame());
          }
          break;
        }
        case "snooze_clear":
          if (typeof msg.conversationId === "string") {
            seen?.clearSnooze(typeof msg.agentId === "string" ? msg.agentId : null, msg.conversationId);
            note("unsnooze");
            broadcast(seenFrame());
          }
          break;
        case "snooze_ladder": {
          seen?.setLadder({ firstMinutes: msg.firstMinutes, growth: msg.growth });
          broadcast(seenFrame());
          return;
        }
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
          note("trash");
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
        case "pin_set": {
          if (typeof msg.agentId !== "string" || typeof msg.conversationId !== "string" || !deps.setPin) return;
          deps.setPin(msg.agentId, msg.conversationId, msg.pinned === true);
          note("pin", { pinned: msg.pinned === true });
          deps.broadcast({ type: "desks", desks: listDesks?.() ?? [] }); // every tab's tree follows
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
        case "recall_list":
        case "recall_grade":
        case "recall_edit":
        case "recall_reject":
        case "recall_restore":
        case "recall_forget":
        case "recall_settings":
        case "recall_run":
        case "recall_lead_dismiss":
        case "recall_lead_restore":
        case "recall_lead_start":
        case "recall_export": {
          const requestId = msg.requestId;
          const recall = deps.recall;
          const fail = (message: string) => client.send({ type: "recall_error", requestId, message });
          if (!recall) return fail("recall is not available in this mod");
          const { store } = recall;
          const snapshot = () => ({ type: "recall", requestId, cards: store.cards(), rejected: store.rejected(), worker: store.status(), leads: store.leads(), dismissedLeads: store.dismissedLeads(), lessons: store.lessons().map((l) => ({ ...l, empty: recall.lessonEmpty?.(l) ?? false })) });
          const id = typeof msg.id === "string" ? msg.id : "";
          const changed = (card: unknown) => {
            client.send({ type: "recall_card", requestId, card });
            deps.broadcast({ type: "recall_changed" });
          };
          try {
            switch (msg.type) {
              case "recall_list":
                return client.send(snapshot());
              case "recall_grade": {
                const grade = msg.grade;
                if (grade !== 1 && grade !== 2 && grade !== 3 && grade !== 4) return fail("a grade is 1 (again) to 4 (easy)");
                if (!store.grade(id, grade)) return fail("no such card");
                return changed(store.card(id));
              }
              case "recall_edit": {
                const card = store.edit(id, { front: typeof msg.front === "string" ? msg.front : undefined, back: typeof msg.back === "string" ? msg.back : undefined, tags: Array.isArray(msg.tags) ? (msg.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined }, "you");
                if (!card) return fail("no such card");
                return changed(store.card(id));
              }
              case "recall_reject":
                if (!store.reject(id)) return fail("no such card");
                return changed(null);
              case "recall_restore": {
                const card = store.restore(id);
                if (!card) return fail("nothing to restore");
                return changed(store.card(id));
              }
              case "recall_forget":
                store.forget(id);
                return changed(null);
              case "recall_settings": {
                const update: Record<string, unknown> = {};
                if (typeof msg.enabled === "boolean") update.enabled = msg.enabled;
                if (msg.model === null || typeof msg.model === "string") update.model = msg.model || null;
                if (typeof msg.dailyCap === "number" && msg.dailyCap >= 0) update.dailyCap = Math.round(msg.dailyCap);
                if (typeof msg.tickMinutes === "number" && Number.isFinite(msg.tickMinutes)) update.tickMinutes = clampTickMinutes(msg.tickMinutes);
                const before = store.worker().tickMinutes ?? DEFAULT_TICK_MINUTES;
                store.saveWorker(update);
                if (typeof update.tickMinutes === "number" && update.tickMinutes !== before) deps.recall?.reschedule?.(update.tickMinutes);
                deps.broadcast({ type: "recall_changed" });
                return client.send(snapshot());
              }
              case "recall_lead_dismiss":
                if (!store.dismissLead(id)) return fail("no such lead");
                deps.broadcast({ type: "recall_changed" });
                return client.send(snapshot());
              case "recall_lead_restore":
                if (!store.restoreLead(id)) return fail("nothing to restore");
                deps.broadcast({ type: "recall_changed" });
                return client.send(snapshot());
              case "recall_lead_start":
                if (!recall.startLesson) return fail("lessons are not available in this mod");
                void recall
                  .startLesson(id)
                  .then((lesson) => {
                    client.send({ type: "recall_lesson", requestId, ...lesson }); // the tab opens the desk; the tree reads the new conversation from disk on its next list
                    deps.broadcast({ type: "recall_changed" });
                  })
                  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
                return;
              case "recall_run":
                void recall
                  .run()
                  .then((r) => {
                    client.send({ type: "recall_ran", requestId, note: r.note });
                    deps.broadcast({ type: "recall_changed" });
                  })
                  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
                return;
              default:
                return client.send({ type: "recall_export", requestId, tsv: toAnkiTsv(store.cards()) });
            }
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
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
        case "skills_global": {
          const ag = deps.agents;
          client.send({ type: "skills_global", requestId: msg.requestId, skills: ag?.globalSkills?.() ?? [] });
          return;
        }
        case "skill_refresh": {
          const requestId = msg.requestId;
          const fail = (err: unknown) => client.send({ type: "agent_error", requestId, message: err instanceof Error ? err.message : String(err) });
          const ag = deps.agents;
          if (!ag?.refreshSkill) return fail(new Error("skill refresh is not available in this mod"));
          if (!isAgentId(msg.agentId) || typeof msg.name !== "string") return fail(new Error("agentId and name required"));
          const agentId = msg.agentId;
          const name = msg.name;
          ag.refreshSkill(agentId, name, typeof msg.source === "string" ? msg.source : undefined).then((r) => client.send({ type: "skill_refreshed", requestId, agentId, name, ...r }), fail);
          return;
        }
        case "skill_install": {
          const requestId = msg.requestId;
          const fail = (err: unknown) => client.send({ type: "agent_error", requestId, message: err instanceof Error ? err.message : String(err) });
          const ag = deps.agents;
          if (!ag?.install) return fail(new Error("skill install is not available in this mod"));
          if (!isAgentId(msg.agentId) || typeof msg.source !== "string") return fail(new Error("agentId and source required"));
          const agentId = msg.agentId;
          ag.install(agentId, msg.source, msg.force === true).then((output) => client.send({ type: "skill_installed", requestId, agentId, output }), fail);
          return;
        }
        case "agent_get":
        case "memory_read":
        case "memory_log":
        case "memory_diff":
        case "reflection_state": {
          const requestId = msg.requestId;
          const ag = deps.agents;
          const fail = (err: unknown) => client.send({ type: "agent_error", requestId, message: err instanceof Error ? err.message : String(err) });
          if (!ag) return fail(new Error("agents are not available in this mod"));
          if (!isAgentId(msg.agentId)) return fail(new Error("agentId required"));
          const agentId = msg.agentId;
          if (msg.type === "agent_get") {
            const agent = ag.get(agentId);
            if (!agent) return fail(new Error("no local record for this agent"));
            void ag
              .log(agentId, { limit: 1 })
              .catch(() => [])
              .then(async (last) => client.send({ type: "agent", requestId, agent, files: ag.tree(agentId), skills: await (ag.skillsInfo ? ag.skillsInfo(agentId).catch(() => ag.skills(agentId)) : ag.skills(agentId)), hasProfile: ag.hasProfile(agentId), lastCommit: last[0] ?? null }));
          } else if (msg.type === "reflection_state") {
            if (!ag.reflection) return fail(new Error("reflection is not available in this mod"));
            void ag.reflection(agentId).then((state) => client.send({ type: "reflection_state", requestId, agentId, ...state }), fail);
          } else if (msg.type === "memory_read") {
            if (typeof msg.path !== "string") return fail(new Error("path required"));
            client.send({ type: "memory_file", requestId, agentId, path: msg.path, content: ag.read(agentId, msg.path) });
          } else if (msg.type === "memory_log") {
            void ag
              .log(agentId, { path: typeof msg.path === "string" ? msg.path : undefined, limit: typeof msg.limit === "number" ? msg.limit : undefined })
              .then((commits) => client.send({ type: "memory_commits", requestId, agentId, commits }))
              .catch(fail);
          } else {
            if (typeof msg.sha !== "string") return fail(new Error("sha required"));
            void ag
              .diff(agentId, msg.sha)
              .then((diff) => client.send({ type: "memory_diff", requestId, agentId, sha: msg.sha, diff }))
              .catch(fail);
          }
          return;
        }
        case "inbox_list": {
          client.send({ type: "inbox", requestId: msg.requestId, conversations: deps.listInbox?.() ?? [] });
          return;
        }
        case "history_get": {
          if (typeof msg.conversationId !== "string") return;
          const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
          client.send({ type: "history", requestId: msg.requestId, agentId, conversationId: msg.conversationId, messages: transcript?.(agentId, msg.conversationId) ?? [] });
          return;
        }
        case "lan_get":
        case "lan_set":
        case "lan_via_set":
        case "lan_serve_set":
        case "pair_begin":
        case "devices_list":
        case "device_forget": {
          const lan = deps.lan;
          if (!lan) return client.send({ type: "error", message: "the phone listener is not available in this mod" });
          const reply = (status: import("./lan.ts").LanStatus) => client.send({ type: "lan_status", ...status });
          if (msg.type === "lan_get") {
            // Settings just opened: ask Tailscale again (cached inside its ttl) before answering.
            void lan.refresh().then(reply);
            return;
          }
          if (msg.type === "lan_set") {
            // Persisted first, then bound or closed; the listener's own onChange broadcasts to every tab.
            void lan.setEnabled(msg.enabled === true).then(reply);
            return;
          }
          if (msg.type === "lan_via_set") {
            if (!isLanVia(msg.via)) return client.send({ type: "error", message: "via must be \"tailscale\" or \"lan\"" });
            return reply(lan.setVia(msg.via));
          }
          if (msg.type === "lan_serve_set") {
            // The CLI's complaint, if any, rides in tailscale.error: Settings shows it beside the switch.
            void lan.setServe(msg.enabled === true).then(reply);
            return;
          }
          if (msg.type === "pair_begin") return client.send({ type: "pair_code", ...lan.pairBegin() });
          if (msg.type === "devices_list") return client.send({ type: "devices", devices: lan.devices() });
          if (typeof msg.id === "string") lan.forget(msg.id);
          deps.broadcast({ type: "devices", devices: lan.devices() });
          return;
        }
        default:
          client.send({ type: "error", message: `unsupported message type: ${String(msg.type)}` });
      }
    },
  };
}
