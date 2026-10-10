import { isEventName } from "./analytics.ts";
import type { DeskState, Gesture, Scope, WidgetLogEntry, WidgetManifestEntry } from "./desk-core.ts";
import type { ModelEntry, ReasoningEffort } from "./models.ts";
import type { ChatEvent } from "./attention/model.ts";
import type { ConnectProvider } from "./attention/protocol.ts";
import type { CardWithSchedule, RecallSnapshot } from "./recall/model.ts";
import type { TranscriptRow } from "./attention/transcript.ts";
import type { FocusEntry } from "./attention/focus.ts";
import type { DeskStatus, DeskSummary, DeviceSummary, FolderCheck, GlobalSkill, InboxRow, LanStatus, LanVia, LocalAgent, MemoryCommit, MemoryFile, MemorySkill, MemorySkillInfo, RecentFolders, ReflectionState, RefreshOutcome, Task } from "./frame-types.ts";

/**
 * The mod's own protocol on `/ws` (GLOSSARY.md: Frame, Frame table), declared once. The app sends requests and
 * sends; the mod answers a request with its reply (or one `error`) and pushes the rest. Every entry here is what
 * the mod's router (mod/bridge.ts) dispatches on, what the app's `request()` and `send()` are typed by, and what
 * a paired phone may send: nothing else lists frames.
 *
 * On the wire a frame is `{ type, ...payload }`; a request and its reply also carry the request's `requestId`.
 */

type Raw = Record<string, unknown>;

/** A parser: the raw frame as the typed payload, or a message saying why it is not one. Never throws. */
export type Parse<P> = (m: Raw) => P | string;

const str = (v: unknown): v is string => typeof v === "string";
const strOr = <T>(v: unknown, or: T): string | T => (typeof v === "string" ? v : or);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): boolean => typeof v === "object" && v !== null && isNum((v as Raw).x) && isNum((v as Raw).y);

/**
 * Agent ids reach the mod from the socket and from the LAN page, then become path segments under the
 * backend's memfs. Only the shape Letta itself produces is allowed: letters, digits, `.`, `_`, `-`, not
 * starting with a dot. Anything else (`..`, `/`, `%2F`) is refused before it touches a path.
 */
export function isAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(id);
}

export const isLanVia = (v: unknown): v is LanVia => v === "tailscale" || v === "lan";

export function isGesture(v: unknown): v is Gesture {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Raw;
  if (typeof g.id !== "string" || !g.id) return false;
  switch (g.kind) {
    case "move":
      return isPoint(g.position);
    case "resize":
      return typeof g.size === "object" && g.size !== null && isNum((g.size as Raw).w) && isNum((g.size as Raw).h);
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

/** The task ids a board frame names: `ids`, or a single `id`. */
const taskIds = (m: Raw): string[] => (Array.isArray(m.ids) ? strings(m.ids) : str(m.id) ? [m.id] : []);
/** A conversation mark: which conversation, and its agent when the app knows it. */
const mark = (m: Raw) => (str(m.conversationId) ? { agentId: strOr(m.agentId, null), conversationId: m.conversationId } : "conversationId required");
const agent = (m: Raw) => (isAgentId(m.agentId) ? { agentId: m.agentId } : "agentId required");
/** A chat on loki's daemon: its agent and its id, both required. */
const chatRef = (m: Raw) => (isAgentId(m.agentId) && str(m.conversationId) && m.conversationId ? { agentId: m.agentId, conversationId: m.conversationId } : "agentId and conversationId required");
const nothing = (): Record<never, never> => ({});

/** The answer to a request, by reply name: the payload beside `type` and `requestId`. */
export interface Replies {
  folders: RecentFolders;
  folder_matches: { matches: string[] };
  folder_status: FolderCheck;
  folder_picked: { path: string | null };
  recall: RecallSnapshot;
  recall_card: { card: CardWithSchedule | null };
  recall_ran: { note: string };
  recall_export: { tsv: string };
  recall_lesson: { agentId: string; conversationId: string };
  tasks: { tasks: Task[] };
  task_created: { task: Task };
  tasks_updated: { tasks: Task[] };
  skills_global: { skills: GlobalSkill[] };
  skill_installed: { agentId: string; output: string };
  skill_refreshed: { agentId: string; name: string } & RefreshOutcome;
  agent: { agent: LocalAgent; files: MemoryFile[]; skills: Array<MemorySkill | MemorySkillInfo>; hasProfile: boolean; lastCommit: MemoryCommit | null };
  reflection_state: { agentId: string } & ReflectionState;
  memory_file: { agentId: string; path: string; content: string | null };
  memory_commits: { agentId: string; commits: MemoryCommit[] };
  memory_diff: { agentId: string; sha: string; diff: string };
  inbox: { conversations: InboxRow[] };
  history: { agentId: string | null; conversationId: string; messages: TranscriptRow[]; more: boolean; widgetLog: WidgetLogEntry[] };
  chat_state: ChatState;
  chat_created: { agentId: string; conversationId: string };
  chat_accepted: { accepted: boolean };
  chat_models: { entries: ModelEntry[] };
  chat_agents: { agents: Array<{ id: string; name: string }> };
  chat_agent_created: { id: string; name: string };
  chat_done: Record<never, never>;
  chat_providers: { providers: ConnectProvider[] };
  chat_signin: { url: string; instructions: string | null };
  chat_command_done: { success: boolean; output: string };
  chat_skill_enabled: { name: string; linkPath: string };
  chat_reflection: { trigger: "off" | "step-count" | "compaction-event"; stepCount: number; merge: "auto" | "explicit"; mergeInstructions: string };
  /** What the one-time import from Letta brought over (daemon/import/letta.ts). */
  chat_imported: { agents: string[]; chats: number; kept: number; credentials: string[]; schedules: number; notes: string[] };
}
export type ReplyName = keyof Replies;

/** Where a chat stands when a client opens it (loki's daemon, plan 017 U5): running or not, its mode and folder. */
export interface ChatState {
  agentId: string;
  conversationId: string;
  loop: "running" | "idle" | "approval";
  mode: string | null;
  cwd: string | null;
}

/** What the mod tells the app unasked, by push name: the payload beside `type`. */
export interface Pushes {
  /** `chats: "daemon"`: loki's daemon serves chats through the mod's own frames (plan 017, U5), not an app-server. */
  config: { appServer: boolean; chats?: "daemon" };
  desk: { scope: Scope; title: string | null; status: DeskStatus; agentName: string | null; agentId: string | null; model: string | null; reasoningEffort: ReasoningEffort | null; mode: string | null; state: DeskState; widgets: WidgetManifestEntry[] };
  desk_title: { scope: Scope; title: string | null; status: DeskStatus; agentName: string | null; model: string | null; reasoningEffort: ReasoningEffort | null; mode?: string | null };
  state: { scope: Scope; state: DeskState };
  widgets: { scope: Scope; widgets: WidgetManifestEntry[] };
  camera: { widgetId: string; widgetIds?: string[] };
  widget_change: { entry: WidgetLogEntry };
  switch_desk: { scope: Scope };
  desks: { desks: DeskSummary[] };
  seen: { seen: Record<string, string>; viewed: Record<string, string>; focus: Record<string, FocusEntry>; appServer: boolean };
  models_recent: { recent: string[] };
  recall_changed: Record<never, never>;
  tasks_changed: Record<never, never>;
  lan_status: LanStatus;
  devices: { devices: DeviceSummary[] };
  pair_code: { code: string; url: string; expiresAt: string };
  app_build: { build: string };
  /** What happened in a chat a client has open, in order (core/attention/model.ts ChatEvent). */
  chat_event: { agentId: string; conversationId: string; events: ChatEvent[] };
  /** A request that failed (with its requestId), or a send or frame the mod could not take (without). */
  error: { message: string; requestId?: string };
}
export type PushName = keyof Pushes;

interface RequestEntry<R extends ReplyName, P> {
  kind: "request";
  reply: R;
  phone: boolean;
  doc: string;
  parse: Parse<P>;
}
interface SendEntry<P> {
  kind: "send";
  phone: boolean;
  /** The pushes it causes: how its effect comes back. */
  causes: PushName[];
  doc: string;
  parse: Parse<P>;
}
interface PushEntry {
  kind: "push";
  doc: string;
}

const request = <R extends ReplyName, P>(reply: R, doc: string, parse: Parse<P>, phone = false): RequestEntry<R, P> => ({ kind: "request", reply, phone, doc, parse });
const send = <P>(doc: string, parse: Parse<P>, opts: { phone?: boolean; causes?: PushName[] } = {}): SendEntry<P> => ({ kind: "send", phone: opts.phone ?? false, causes: opts.causes ?? [], doc, parse });
const push = (doc: string): PushEntry => ({ kind: "push", doc });
const PHONE = true;

export const FRAMES = {
  // Desks and widgets
  gesture: send("a gesture on a widget (move, resize, set …); its desk's state follows", (m) => (isGesture(m.gesture) ? { gesture: m.gesture } : "malformed gesture"), { causes: ["state"] }),
  measure: send("a widget's rendered size, which drives placement", (m) => {
    const size = m.size as Raw | undefined;
    return str(m.id) && size && isNum(size.w) && isNum(size.h) ? { id: m.id, size: { w: size.w, h: size.h } } : "malformed measure";
  }, { causes: ["state"] }),
  arrange: send("tidy this desk into a grid", nothing, { causes: ["camera"] }),
  trash: send("delete the widget's file: the agent's work is gone for good", (m) => (str(m.id) ? { id: m.id } : "malformed trash")),
  widget_status: send("a runtime or reload error from the tab (null clears it)", (m) => (str(m.id) ? { id: m.id, error: str(m.error) && m.error.trim() ? m.error.trim() : null } : "malformed widget_status"), { causes: ["widgets"] }),
  desk_get: send("another desk's state and widgets, for widgets shown inline in a thread; no switch", (m) => (str(m.scope) && m.scope ? { scope: m.scope as Scope } : "scope required"), { phone: PHONE, causes: ["desk"] }),
  list_desks: send("every desk, for the sidebar and search", nothing, { phone: PHONE, causes: ["desks"] }),
  pin_set: send("pin or unpin a conversation (Letta's pinned-conversations.json)", (m) => (str(m.agentId) && str(m.conversationId) ? { agentId: m.agentId, conversationId: m.conversationId, pinned: m.pinned === true } : "agentId and conversationId required"), { phone: PHONE, causes: ["desks"] }),
  models_recent_add: send("a model picked in loki, for the shared quick picks", (m) => (str(m.handle) && m.handle ? { handle: m.handle } : "handle required"), { phone: PHONE, causes: ["models_recent"] }),

  // Seen marks and focus
  seen_list: send("the done and viewed marks and the focus weights", nothing, { phone: PHONE, causes: ["seen"] }),
  seen_mark: send("mark a conversation done", mark, { phone: PHONE, causes: ["seen"] }),
  seen_unmark: send("mark a conversation not done", mark, { phone: PHONE, causes: ["seen"] }),
  viewed_mark: send("a look, not done (the sidebar's bold, the New line)", mark, { phone: PHONE, causes: ["seen"] }),
  focus_add: send("an engagement the mod cannot see (it went to the app-server)", (m) => {
    const c = mark(m);
    if (typeof c === "string") return c;
    const action = m.action;
    return action === "answer" || action === "decide" || action === "skip" ? { ...c, action: action as "answer" | "decide" | "skip" } : "action must be answer, decide or skip";
  }, { phone: PHONE, causes: ["seen"] }),

  // Analytics
  capture: send("an analytics event the app saw; a `once` key keeps the first report of an event every window sees", (m) => {
    if (!isEventName(m.event)) return "malformed capture";
    const properties = m.properties && typeof m.properties === "object" && !Array.isArray(m.properties) ? { ...(m.properties as Raw) } : undefined;
    return { event: m.event, properties };
  }, { phone: PHONE }),

  // History and the Inbox
  history_get: request("history", "a chat's last `limit` rows from its log, whether older ones remain, and its desk's widget log", (m) =>
    str(m.conversationId) ? { agentId: strOr(m.agentId, null), conversationId: m.conversationId, limit: isNum(m.limit) ? m.limit : null } : "conversationId required", PHONE),
  inbox_list: request("inbox", "every open conversation from disk, with who spoke last", nothing, PHONE),

  // Chats on loki's daemon (plan 017, U5); under Letta the app-server serves these and the mod answers `error`
  chat_open: request("chat_state", "follow a chat: its state now, then its chat_event pushes; `mode` sets its permission mode", (m) => {
    const c = chatRef(m);
    return typeof c === "string" ? c : { ...c, mode: strOr(m.mode, null) };
  }, PHONE),
  chat_approve: request("chat_accepted", "the person's decision on a tool call the chat asked about", (m) => {
    const c = chatRef(m);
    if (typeof c === "string") return c;
    // The approval's own id: `requestId` is the frame's, matched to its reply.
    return str(m.approvalId) && typeof m.allow === "boolean" ? { ...c, approvalId: m.approvalId, allow: m.allow, message: strOr(m.message, null) } : "approvalId and allow required";
  }, PHONE),
  chat_answer: request("chat_accepted", "the person's answers to a question card (the tool input with `answers` filled in)", (m) => {
    const c = chatRef(m);
    if (typeof c === "string") return c;
    return str(m.questionId) && m.input && typeof m.input === "object" ? { ...c, questionId: m.questionId, input: m.input as Raw } : "questionId and input required";
  }, PHONE),
  chat_create: request("chat_created", "a new chat for an agent, in a folder", (m) =>
    isAgentId(m.agentId) ? { agentId: m.agentId, cwd: strOr(m.cwd, null), title: strOr(m.title, null) } : "agentId required", PHONE),
  chat_send: request("chat_accepted", "a message from the person; queued when the chat is busy, sent once per sendId", (m) => {
    const c = chatRef(m);
    if (typeof c === "string") return c;
    if (!str(m.text)) return "text required";
    const images = Array.isArray(m.images) ? (m.images as Raw[]).filter((i) => str(i.mediaType) && str(i.data)).map((i) => ({ mediaType: i.mediaType as string, data: i.data as string })) : [];
    return { ...c, text: m.text, images, sendId: strOr(m.sendId, null), context: strOr(m.context, null) };
  }, PHONE),
  chat_abort: request("chat_done", "stop the chat's turn", chatRef, PHONE),
  chat_update: request("chat_done", "rename, archive or hide a chat", (m) => {
    const c = chatRef(m);
    if (typeof c === "string") return c;
    return { ...c, title: m.title === null || str(m.title) ? (m.title as string | null) : undefined, archived: typeof m.archived === "boolean" ? m.archived : undefined, hidden: typeof m.hidden === "boolean" ? m.hidden : undefined };
  }, PHONE),
  chat_folder: request("chat_state", "move a chat to another folder", (m) => {
    const c = chatRef(m);
    return typeof c === "string" ? c : str(m.cwd) && m.cwd ? { ...c, cwd: m.cwd } : "cwd required";
  }, PHONE),
  chat_model: request("chat_done", "the model and reasoning effort a chat runs with", (m) => {
    const c = chatRef(m);
    if (typeof c === "string") return c;
    return str(m.handle) && m.handle ? { ...c, handle: m.handle, reasoningEffort: strOr(m.reasoningEffort, null) as ReasoningEffort | null } : "handle required";
  }, PHONE),
  chat_models: request("chat_models", "the models the connected providers offer", nothing, PHONE),
  chat_agents: request("chat_agents", "the person's agents", nothing, PHONE),
  chat_agent_create: request("chat_agent_created", "a new agent, with its main chat", (m) =>
    str(m.name) && m.name.trim() ? { name: m.name.trim(), description: strOr(m.description, null), model: strOr(m.model, null) } : "name required"),
  chat_agent_update: request("chat_done", "an agent's name, description or model", (m) =>
    isAgentId(m.agentId) ? { agentId: m.agentId, name: strOr(m.name, undefined), description: strOr(m.description, undefined), model: strOr(m.model, undefined) } : "agentId required"),
  chat_agent_delete: request("chat_done", "delete an agent, its memory and its chats", agent),
  chat_reflection_get: request("chat_reflection", "when reflection passes run", nothing),
  chat_import: request("chat_imported", "import agents, chats, keys and schedules from Letta, once (again: only what is missing)", nothing),
  chat_reflection_set: request("chat_reflection", "change when reflection passes run", (m) => {
    const trigger = m.trigger === "off" || m.trigger === "step-count" || m.trigger === "compaction-event" ? (m.trigger as "off" | "step-count" | "compaction-event") : null;
    if (!trigger) return "trigger must be off, step-count or compaction-event";
    return { trigger, stepCount: isNum(m.stepCount) && m.stepCount > 0 ? Math.floor(m.stepCount) : 25, merge: m.merge === "explicit" ? ("explicit" as const) : ("auto" as const), mergeInstructions: strOr(m.mergeInstructions, "") };
  }),
  chat_command: request("chat_command_done", "run a slash command in a chat: compact, clear, remember or reflect", (m) => {
    const c = chatRef(m);
    if (typeof c === "string") return c;
    return str(m.command) && m.command ? { ...c, command: m.command, args: strOr(m.args, null) } : "command required";
  }, PHONE),
  chat_memory_write: request("chat_done", "write a memory file (null content removes it), committed as yours", (m) =>
    isAgentId(m.agentId) && str(m.path) && m.path ? { agentId: m.agentId, path: m.path, content: m.content === null ? null : strOr(m.content, ""), message: strOr(m.message, undefined) } : "agentId and path required"),
  chat_skill_enable: request("chat_skill_enabled", "make a skill folder global: a link to it in the global skills folder", (m) => (str(m.path) && m.path ? { path: m.path } : "path required")),
  chat_skill_disable: request("chat_done", "take a global skill away: its link in the global skills folder", (m) => (str(m.name) && m.name && !m.name.includes("/") && !m.name.includes("..") ? { name: m.name } : "a skill name required")),
  chat_providers: request("chat_providers", "the model providers, connected or not", nothing),
  chat_provider_connect: request("chat_providers", "keep a provider's API key, once the provider accepts it", (m) =>
    str(m.providerId) && m.providerId && str(m.apiKey) ? { providerId: m.providerId, apiKey: m.apiKey } : "providerId and apiKey required"),
  chat_provider_disconnect: request("chat_providers", "forget a provider's credential", (m) => (str(m.providerId) && m.providerId ? { providerId: m.providerId } : "providerId required")),
  chat_provider_signin: request("chat_signin", "start signing in to a provider: the page to open; the credential is kept when the browser comes back. With `code`, the address the browser ended on, for a sign-in still waiting", (m) =>
    str(m.providerId) && m.providerId ? { providerId: m.providerId, code: strOr(m.code, null) } : "providerId required"),

  // Folders
  folders_get: request("folders", "the folders each agent and conversation has worked in", nothing, PHONE),
  folder_complete: request("folder_matches", "folders completing a typed prefix", (m) => ({ prefix: strOr(m.prefix, null) })),
  folder_check: request("folder_status", "whether a path is a folder a chat can work in, and its git branch", (m) => ({ path: strOr(m.path, null) })),
  folder_pick: request("folder_picked", "the system folder picker (null when cancelled)", (m) => ({ defaultPath: strOr(m.defaultPath, undefined) })),

  // Learn
  recall_list: request("recall", "the whole Learn section", nothing, PHONE),
  recall_grade: request("recall_card", "grade a card, 1 (again) to 4 (easy)", (m) =>
    m.grade === 1 || m.grade === 2 || m.grade === 3 || m.grade === 4 ? { id: strOr(m.id, ""), grade: m.grade as 1 | 2 | 3 | 4 } : "a grade is 1 (again) to 4 (easy)", PHONE),
  recall_edit: request("recall_card", "edit a card's front, back or tags", (m) =>
    ({ id: strOr(m.id, ""), front: strOr(m.front, undefined), back: strOr(m.back, undefined), tags: Array.isArray(m.tags) ? strings(m.tags) : undefined }), PHONE),
  recall_reject: request("recall_card", "set a card aside (card: null)", (m) => ({ id: strOr(m.id, "") }), PHONE),
  recall_restore: request("recall_card", "bring a set-aside card back", (m) => ({ id: strOr(m.id, "") }), PHONE),
  recall_forget: request("recall_card", "forget a set-aside card for good (card: null)", (m) => ({ id: strOr(m.id, "") })),
  recall_settings: request("recall", "the writer's settings: on, model, daily cap, minutes between sweeps", (m) => ({
    enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
    model: m.model === null || str(m.model) ? m.model || null : undefined,
    dailyCap: isNum(m.dailyCap) && m.dailyCap >= 0 ? Math.round(m.dailyCap) : undefined,
    tickMinutes: isNum(m.tickMinutes) ? m.tickMinutes : undefined,
  })),
  recall_run: request("recall_ran", "run the writer now", nothing),
  recall_export: request("recall_export", "every card as Anki TSV", nothing, PHONE),
  recall_lead_dismiss: request("recall", "set a lead aside", (m) => ({ id: strOr(m.id, "") }), PHONE),
  recall_lead_restore: request("recall", "bring a set-aside lead back", (m) => ({ id: strOr(m.id, "") }), PHONE),
  recall_lead_start: request("recall_lesson", "a lead becomes a [Learn] conversation with an info card on its desk; the app then sends the brief", (m) => ({ id: strOr(m.id, "") }), PHONE),

  // The board
  tasks_list: request("tasks", "the board's tasks (all of them, closed too, when asked)", (m) => ({ all: m.all === true })),
  task_create: request("task_created", "a task filed from the app, stamped with its chat and folder", (m) => ({
    title: String(m.title ?? ""),
    description: strOr(m.description, undefined),
    labels: Array.isArray(m.labels) ? strings(m.labels) : undefined,
    priority: typeof m.priority === "number" ? m.priority : undefined,
    desk: strOr(m.desk, null),
    agentId: strOr(m.agentId, null),
    agentName: strOr(m.agentName, null),
    conversationId: strOr(m.conversationId, null),
  })),
  task_assign: request("tasks_updated", "assign tasks to a chat, optionally starting them", (m) =>
    str(m.conversationId) && str(m.desk)
      ? { ids: taskIds(m), conversationId: m.conversationId, desk: m.desk, agentId: strOr(m.agentId, null), agentName: strOr(m.agentName, null), start: m.start === true }
      : "assign needs a conversation and a chat"),
  task_close: request("tasks_updated", "close tasks, with a reason", (m) => ({ ids: taskIds(m), reason: strOr(m.reason, undefined) })),
  task_status: request("tasks_updated", "move tasks to open, in progress, blocked or deferred", (m) =>
    m.status === "open" || m.status === "in_progress" || m.status === "blocked" || m.status === "deferred" ? { ids: taskIds(m), status: m.status as "open" | "in_progress" | "blocked" | "deferred" } : `unknown status ${String(m.status)}`),

  // Agents, memory and skills
  agent_get: request("agent", "an agent's local record, memory tree, skills, face and last memory commit", agent, PHONE),
  memory_read: request("memory_file", "one memory file (content null when missing)", (m) => (isAgentId(m.agentId) ? (str(m.path) ? { agentId: m.agentId, path: m.path } : "path required") : "agentId required"), PHONE),
  memory_log: request("memory_commits", "memory's git log, for a path or all of it", (m) =>
    isAgentId(m.agentId) ? { agentId: m.agentId, path: strOr(m.path, undefined), limit: typeof m.limit === "number" ? m.limit : undefined } : "agentId required", PHONE),
  memory_diff: request("memory_diff", "one memory commit's diff", (m) => (isAgentId(m.agentId) ? (str(m.sha) ? { agentId: m.agentId, sha: m.sha } : "sha required") : "agentId required"), PHONE),
  reflection_state: request("reflection_state", "Letta's reflection counters per conversation and the last pass that changed memory", agent),
  skills_global: request("skills_global", "skills outside memory (~/.letta/skills)", nothing),
  skill_install: request("skill_installed", "install a skill into an agent's memory", (m) =>
    isAgentId(m.agentId) && str(m.source) ? { agentId: m.agentId, source: m.source, force: m.force === true } : "agentId and source required"),
  skill_refresh: request("skill_refreshed", "refresh an other skill from its upstream: current, replaced, or staged for the agent to reconcile", (m) =>
    isAgentId(m.agentId) && str(m.name) ? { agentId: m.agentId, name: m.name, source: strOr(m.source, undefined) } : "agentId and name required"),

  // The phone listener (Settings › phone)
  lan_get: send("the listener's status, after asking Tailscale again", nothing, { causes: ["lan_status"] }),
  lan_set: send("turn the listener on or off (persisted, then bound or closed)", (m) => ({ enabled: m.enabled === true }), { causes: ["lan_status"] }),
  lan_via_set: send("which route the QR encodes", (m) => (isLanVia(m.via) ? { via: m.via } : 'via must be "tailscale" or "lan"'), { causes: ["lan_status"] }),
  lan_serve_set: send("`tailscale serve` on or off for the listener", (m) => ({ enabled: m.enabled === true }), { causes: ["lan_status"] }),
  pair_begin: send("mint a pairing code and the URL its QR carries", nothing, { causes: ["pair_code"] }),
  devices_list: send("the paired phones", nothing, { causes: ["devices"] }),
  device_forget: send("forget a phone and close its sockets", (m) => ({ id: strOr(m.id, null) }), { causes: ["devices"] }),

  // Pushes
  config: push("on connect: whether an app-server was discovered"),
  desk: push("one desk in full (on connect, and for desk_get)"),
  desk_title: push("a desk's conversation was renamed, archived or changed model or mode"),
  state: push("a desk's geometry and overlay changed"),
  widgets: push("a desk's widget files changed"),
  camera: push("frame these widgets"),
  widget_change: push("the agent added, changed or removed a widget on any desk (mod/widget-log.ts)"),
  switch_desk: push("the active conversation changed; the tab follows"),
  desks: push("every desk, after list_desks or a pin"),
  seen: push("the done and viewed marks and the focus weights, after any change"),
  models_recent: push("the models used lately (on connect, and after a pick)"),
  recall_changed: push("Learn changed: other tabs and phones refetch"),
  tasks_changed: push("the board changed: other tabs refetch"),
  lan_status: push("the phone listener's status"),
  devices: push("the paired phones"),
  pair_code: push("a pairing code, its URL and when it expires"),
  app_build: push("the build a phone is served, so it can offer a reload"),
  chat_event: push("what happened in a chat a client has open"),
  error: push("a failed request (with its requestId) or a frame the mod could not take"),
} as const;

type Table = typeof FRAMES;
export type FrameName = keyof Table;
export type RequestName = { [K in FrameName]: Table[K] extends { kind: "request" } ? K : never }[FrameName];
export type SendName = { [K in FrameName]: Table[K] extends { kind: "send" } ? K : never }[FrameName];
/** What a request or send carries once parsed. */
export type PayloadOf<N extends RequestName | SendName> = Exclude<ReturnType<Table[N]["parse"]>, string>;
/** What the app sends for a frame: the parsed payload, with every field that may be null or absent left optional. */
export type InputOf<N extends RequestName | SendName> = Optional<PayloadOf<N>>;
type Optional<T> = { [K in keyof T as undefined extends T[K] ? K : null extends T[K] ? K : never]?: T[K] } & { [K in keyof T as undefined extends T[K] ? never : null extends T[K] ? never : K]: T[K] };
/** How a request ends for the app: its reply, or the mod's message (or its silence, `timedOut`). */
export type RequestResult<R> = { ok: true; reply: R } | { ok: false; error: string; timedOut: boolean };
/** The reply a request is answered with. */
export type ReplyOf<N extends RequestName> = Table[N] extends { reply: infer R extends ReplyName } ? Replies[R] : never;
/** A push as it arrives: its name beside its payload. */
export type PushFrame = { [K in PushName]: { type: K } & Pushes[K] }[PushName];

export const frameEntry = (type: unknown): Table[FrameName] | undefined => (typeof type === "string" && Object.hasOwn(FRAMES, type) ? FRAMES[type as FrameName] : undefined);

/** How the app reads a request's answer: the frame that carried its requestId, or null when none came in time. */
export function requestResult<R>(answer: Record<string, unknown> | null): RequestResult<R> {
  if (!answer) return { ok: false, error: "no answer from the mod", timedOut: true };
  if (answer.type === "error") return { ok: false, error: typeof answer.message === "string" ? answer.message : "the mod refused", timedOut: false };
  return { ok: true, reply: answer as unknown as R };
}

/**
 * The frames a paired phone may send over its /ws (mod/lan.ts), marked `phone` above; everything else answers `error`.
 * Reads and the user's own markers: desks, transcripts, seen and focus, pins, recent folders, and the
 * read-only agent pages (record, memory tree and files, git log and diffs); Learn's cards, and its leads
 * (a lesson started, a lead set aside or brought back: each one tap by the person, as sending a message is);
 * and a model picked there, for the shared quick picks.
 * Never gestures, the board, skills, the writer's settings, or the pairing and device frames.
 */
export const PHONE_FRAMES: ReadonlySet<FrameName> = new Set((Object.keys(FRAMES) as FrameName[]).filter((n) => FRAMES[n].kind !== "push" && (FRAMES[n] as { phone: boolean }).phone));
