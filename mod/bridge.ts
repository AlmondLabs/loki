import type { Scope } from "../core/desk-core.ts";
import { SHARED_SCOPE } from "../core/desk-core.ts";
import type { DeskStore } from "./desk-store.ts";
import type { WidgetsWatcher } from "./widgets-fs.ts";
import type { GestureLog } from "./gestures.ts";
import type { Client, WsHandlers } from "./server.ts";
import { PHONE_FRAMES, frameEntry, isAgentId, isLanVia, type FrameName } from "../core/frames.ts";
import { deskFrame, desksFrames } from "./frames/desks.ts";
import { seenFrames } from "./frames/seen.ts";
import { captureFrames } from "./frames/capture.ts";
import { historyFrames } from "./frames/history.ts";
import { foldersFrames } from "./frames/folders.ts";
import { recallFrames } from "./frames/recall.ts";
import { boardFrames } from "./frames/board.ts";
import { errorMessage, fail, type FrameContext, type FrameHandlers, type Outcome } from "./frames/context.ts";
import type { DeskInfo, DeskStatus, DeskSummary, DeviceSummary, FolderCheck, GlobalSkill, InboxRow, LanStatus, LanVia, LocalAgent, MemoryCommit, MemoryFile, MemorySkill, MemorySkillInfo, RecentFolders, ReflectionState, RefreshOutcome } from "../core/frame-types.ts";

/**
 * WS protocol v2 (socket-free so it is testable):
 *  server → client
 *    desk        { scope, title, status, state, widgets }   full sync for one scope (own desk + shared on connect)
 *    desk_title  { scope, title, status }    the conversation got (re)named or archived
 *    state       { scope, state }            geometry/overlay changed
 *    widgets     { scope, widgets }          files changed
 *    camera      { widgetId }
    widget_change { entry }                 the agent added/changed/removed a widget on any desk; sent to every socket (mod/widget-log.ts).
                                            A row with an id already seen replaces it (a repeat edit folded in); apps ignore it if unknown
 *    switch_desk { scope }                   the active conversation changed; the tab follows
 *    desks       { desks }                   reply to list_desks (the sidebar, ⌘K search)
 *  client → server
 *    gesture       { gesture }
 *    measure       { id, size }              rendered size of a widget (drives placement)
 *    arrange       {}                        tidy this desk into a grid
 *    trash         { id }                    delete the widget's file (the agent's work is gone for good)
 *    seen_list {} / seen_mark { agentId, conversationId } / seen_unmark { … }   reply/broadcast: seen { seen, viewed, focus, appServer }
 *      (a mark that moves nothing is not broadcast)
 *    viewed_mark { agentId, conversationId }   a look, not done (the sidebar's bold, the New line); broadcast: seen { … }
 *    focus_add { agentId, conversationId, action: "answer" | "decide" | "skip" }   an engagement the mod cannot see (it goes to the app-server); broadcast: seen { …, focus }
 *    desk_get { scope }                     reply: desk { scope, …, state, widgets } (another desk's, for widgets shown inline in a thread)
 *    history_get { requestId, agentId, conversationId, limit? }   reply: history { requestId, agentId, conversationId, messages, more, widgetLog }
                                            (widgetLog: that desk's widget change rows, oldest first, [] if none; core/desk-core.ts WidgetLogEntry)
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
 *    models_recent_add { handle }   a model picked in loki → broadcast models_recent { recent } (mod/models.ts);
 *                                   every connection also gets models_recent when it opens
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
  /** The frame handlers (mod/frames/*): each answers its feature's frames from the table (core/frames.ts). */
  modules?: FrameHandlers[];
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
  /** The last `limit` rows of a chat's log, and whether there are older ones. */
  transcript?: (agentId: string | null, conversationId: string, limit: number) => { rows: import("../core/attention/transcript.ts").TranscriptRow[]; more: boolean };
  /** That conversation's desk's widget change log (mod/widget-log.ts), served with its history. */
  widgetLog?: (agentId: string | null, conversationId: string) => import("../core/desk-core.ts").WidgetLogEntry[];
  /** Working folders for "new desk" (see mod/folders.ts). */
  folders?: {
    recent: () => RecentFolders;
    complete: (prefix: string) => string[];
    check: (path: string) => FolderCheck;
    pick: (defaultPath?: string) => Promise<string | null>;
  };
  /** The Agents page: the local record and the memory filesystem (mod/agents.ts), read-only. */
  agents?: {
    get: (agentId: string) => LocalAgent | null;
    tree: (agentId: string) => MemoryFile[];
    skills: (agentId: string) => MemorySkill[];
    hasProfile: (agentId: string) => boolean;
    read: (agentId: string, path: string) => string | null;
    log: (agentId: string, opts: { path?: string; limit?: number }) => Promise<MemoryCommit[]>;
    diff: (agentId: string, sha: string) => Promise<string>;
    /** Letta's reflection counters per conversation and the last pass that changed memory (mod/reflection.ts). */
    reflection?: (agentId: string) => Promise<ReflectionState>;
    /** Skills outside memory (mod/skills.ts). */
    globalSkills?: () => GlobalSkill[];
    install?: (agentId: string, source: string, force: boolean) => Promise<string>;
    /** Memory skills with origin (self/other), edited, and source (mod/skill-sources.ts); agent_get prefers this over `skills`. */
    skillsInfo?: (agentId: string) => Promise<MemorySkillInfo[]>;
    /** Fetch an other skill's upstream and replace, stage for reconciliation, or report current. */
    refreshSkill?: (agentId: string, name: string, spec?: string) => Promise<RefreshOutcome>;
  };
  /** Pin / unpin a conversation in Letta's pinned-conversations.json. */
  setPin?: (agentId: string, conversationId: string, pinned: boolean) => boolean;
  /** The models used lately, for the picker's quick picks (mod/models.ts): loki's picks, then Letta Code's own. */
  recentModels?: { read: () => string[]; add: (handle: string) => string[] };
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
    status: () => LanStatus;
    /** status() after asking Tailscale again (what lan_get answers with). */
    refresh: () => Promise<LanStatus>;
    setEnabled: (enabled: boolean) => Promise<LanStatus>;
    /** Which route the QR encodes; persisted. */
    setVia: (via: LanVia) => LanStatus;
    /** `tailscale serve` on or off for the listener. */
    setServe: (enabled: boolean) => Promise<LanStatus>;
    /** Mint a pairing code and the URL the QR carries. */
    pairBegin: () => { code: string; url: string; expiresAt: string };
    devices: () => DeviceSummary[];
    /** Forget a device and close its sockets. */
    forget: (id: string) => boolean;
  };
  broadcast(msg: object, scope?: Scope): void;
  /** Analytics (mod/analytics.ts): an event this client caused, or a `capture` frame it sent about one the mod cannot see. */
  capture?: (client: Client, event: string, properties?: Record<string, unknown>) => void;
}

export function createBridge(deps: BridgeDeps): WsHandlers {
  const { broadcast, appServerAvailable, appServerUrl } = deps;

  /** Which handler answers each frame: one per name, or the table and the modules disagree. */
  const handlers = new Map<FrameName, (payload: never, ctx: FrameContext) => unknown>();
  for (const m of [desksFrames(deps), seenFrames(deps), captureFrames(), historyFrames(deps), foldersFrames(deps), recallFrames(deps), boardFrames(deps), ...(deps.modules ?? [])]) {
    for (const [name, h] of Object.entries(m) as Array<[FrameName, (payload: never, ctx: FrameContext) => unknown]>) {
      if (handlers.has(name)) throw new Error(`two handlers for ${name}`);
      handlers.set(name, h);
    }
  }

  /** Run a handler, sync or async, and hand its outcome or its failure on; nothing it does escapes unanswered. */
  const settle = (run: () => unknown, ok: (value: unknown) => void, bad: (err: unknown) => void) => {
    try {
      const r = run();
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(ok, bad);
      else ok(r);
    } catch (err) {
      bad(err);
    }
  };

  return {
    appServerUrl: () => appServerUrl?.() ?? null,
    onConnect(client: Client) {
      client.send({ type: "config", appServer: appServerAvailable?.() ?? false });
      client.send(deskFrame(deps, client.scope));
      if (client.scope !== SHARED_SCOPE) client.send(deskFrame(deps, SHARED_SCOPE));
      if (deps.recentModels) client.send({ type: "models_recent", recent: deps.recentModels.read() });
    },

    onMessage(client: Client, msg: Record<string, unknown>) {
      // A paired phone shares this bridge with the desktop but not its authority: it reads desks and
      // transcripts and keeps its seen markers, nothing else (no gestures, board, pins, folders,
      // skills, agents, and never the pairing and device frames that mint or evict phones).
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      if (client.deviceId && !PHONE_FRAMES.has(msg.type as FrameName)) {
        return client.send({ type: "error", requestId, message: `${String(msg.type)} is not available on the phone` });
      }
      const track = (event: string, properties?: Record<string, unknown>) => deps.capture?.(client, event, properties);
      const entry = frameEntry(msg.type);
      const handle = entry && entry.kind !== "push" ? handlers.get(msg.type as FrameName) : undefined;
      if (entry && entry.kind !== "push" && handle) {
        const ctx: FrameContext = { client, push: (f) => client.send(f), broadcast: (f, scope) => broadcast(f, scope), track };
        const payload = entry.parse(msg);
        if (entry.kind === "request") {
          const answer = (out: Outcome<object>) => client.send(out.ok ? { ...out.reply, type: entry.reply, requestId } : { type: "error", requestId, message: out.message });
          if (typeof payload === "string") return answer(fail(payload));
          return settle(() => handle(payload as never, ctx), (out) => answer(out as Outcome<object>), (err) => answer(fail(errorMessage(err))));
        }
        if (typeof payload === "string") return client.send({ type: "error", message: payload });
        return settle(() => handle(payload as never, ctx), () => {}, (err) => client.send({ type: "error", message: errorMessage(err) }));
      }
      switch (msg.type) {
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
        case "lan_get":
        case "lan_set":
        case "lan_via_set":
        case "lan_serve_set":
        case "pair_begin":
        case "devices_list":
        case "device_forget": {
          const lan = deps.lan;
          if (!lan) return client.send({ type: "error", message: "the phone listener is not available in this mod" });
          const reply = (status: LanStatus) => client.send({ type: "lan_status", ...status });
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
