import { isEventName } from "./analytics.ts";
import type { DeskState, Gesture, Scope, WidgetLogEntry, WidgetManifestEntry } from "./desk-core.ts";
import type { ChatEngineView, ModelEntry, ReasoningEffort } from "./models.ts";
import type { ChatEvent } from "./attention/model.ts";
import type { ConnectProvider, PassSettings } from "./attention/protocol.ts";
import type { Grade } from "./recall/fsrs.ts";
import { isRecallId, type CardWithSchedule, type RecallReply } from "./recall/model.ts";
import type { UsageReply } from "./usage.ts";
import type { TranscriptRow } from "./attention/transcript.ts";
import type { FocusEntry } from "./attention/focus.ts";
import { LABEL_COLORS, chatLabels, labelName, type LabelView } from "./labels.ts";
import type {
  DeskStatus,
  DeskSummary,
  DeviceSummary,
  FolderCheck,
  GlobalSkill,
  InboxRow,
  LanStatus,
  LanVia,
  MacIdentity,
  PeerSummary,
  LocalAgent,
  EnginesView,
  McpView,
  MemoryCommit,
  MemoryFile,
  MemorySkill,
  MemorySkillInfo,
  RecentFolders,
  ReflectionState,
  RefreshOutcome,
  Task,
} from "./frame-types.ts";
import { parseTaskSource } from "./task-source.ts";

/**
 * The mod's own protocol on `/ws` (glossary.md: Frame, Frame table), declared once. The app sends requests and
 * sends; the mod answers a request with its reply (or one `error`) and pushes the rest. Every entry here is what
 * the mod's router (mod/bridge.ts) dispatches on, what the app's `request()` and `send()` are typed by, and what
 * a paired phone may send: nothing else lists frames.
 *
 * On the wire a frame is `{ type, ...payload }`; a request and its reply also carry the request's `request_id`.
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
 * backend's memfs. Only the shape agent ids take (`agent-…`, as Letta made them and the daemon still does) is
 * allowed: letters, digits, `.`, `_`, `-`, not starting with a dot. Anything else (`..`, `/`, `%2F`) is refused before it touches a path.
 */
export function isAgentId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(id);
}

/** Whether a value names a route the phone's QR code may encode, as lan_via_set must carry. */
export const isLanVia = (v: unknown): v is LanVia => v === "tailscale" || v === "lan";

/** Whether a value is a well-formed gesture from the canvas, the only state change a tab may ask for; anything else is refused before it reaches a desk. */
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

/** An MCP server edit as Settings sends it: a local server (command…) or a remote one (url…); null removes it. */
const stringRecord = (v: unknown): Record<string, string> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") return null;
    out[k] = x;
  }
  return out;
};
function mcpEdit(
  v: unknown,
): { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> } | null | string {
  if (v === null) return null;
  if (!v || typeof v !== "object") return "edit required (or null to remove)";
  const e = v as Raw;
  if (str(e.command)) {
    const env = e.env === undefined ? {} : stringRecord(e.env);
    return env ? { command: e.command, args: strings(e.args), env, cwd: strOr(e.cwd, null) } : "env must map names to strings";
  }
  if (str(e.url)) {
    const headers = e.headers === undefined ? {} : stringRecord(e.headers);
    return headers ? { url: e.url, headers } : "headers must map names to strings";
  }
  return "a server needs a command or a url";
}

/** Whether a value is an ISO date and time a request can take as an instant. */
const isInstant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
/** The task ids a task list frame names: `ids`, or a single `id`. */
const taskIds = (m: Raw): string[] => (Array.isArray(m.ids) ? strings(m.ids) : str(m.id) ? [m.id] : []);
/** A conversation mark: which conversation, and its agent when the app knows it. */
const mark = (m: Raw) => (str(m.conversation_id) ? { agent_id: strOr(m.agent_id, null), conversation_id: m.conversation_id } : "conversation_id required");
const agent = (m: Raw) => (isAgentId(m.agent_id) ? { agent_id: m.agent_id } : "agent_id required");
/** A chat on loki's daemon: its agent and its id, both required. */
const chatRef = (m: Raw) =>
  isAgentId(m.agent_id) && str(m.conversation_id) && m.conversation_id
    ? { agent_id: m.agent_id, conversation_id: m.conversation_id }
    : "agent_id and conversation_id required";
/** The payload of a frame that carries nothing beside `type` (and a reply's `request_id`). */
type NoPayload = object;
const nothing = (): NoPayload => ({});
const recallId = <T extends object>(m: Raw, rest: (id: string) => T | string = () => ({}) as T): ({ id: string } & T) | string => {
  if (!isRecallId(m.id)) return "a card or lead id required";
  const r = rest(m.id);
  return typeof r === "string" ? r : { id: m.id, ...r };
};

/** The answer to a request, by reply name: the payload beside `type` and `request_id`. */
export interface Replies {
  folders: RecentFolders;
  folder_matches: { matches: string[] };
  folder_status: FolderCheck;
  folder_picked: { path: string | null };
  recall: RecallReply;
  usage: UsageReply;
  recall_card: { card: CardWithSchedule | null };
  recall_ran: { note: string };
  recall_export: { tsv: string };
  recall_lesson: { agent_id: string; conversation_id: string };
  tasks: { tasks: Task[] };
  task_created: { task: Task };
  tasks_updated: { tasks: Task[] };
  skills_global: { skills: GlobalSkill[] };
  skill_installed: { agent_id: string; output: string };
  skill_refreshed: { agent_id: string; name: string } & RefreshOutcome;
  agent: { agent: LocalAgent; files: MemoryFile[]; skills: Array<MemorySkill | MemorySkillInfo>; has_profile: boolean; last_commit: MemoryCommit | null };
  reflection_state: { agent_id: string } & ReflectionState;
  memory_file: { agent_id: string; path: string; content: string | null };
  memory_commits: { agent_id: string; commits: MemoryCommit[] };
  memory_diff: { agent_id: string; sha: string; diff: string };
  inbox: { conversations: InboxRow[] };
  history: { agent_id: string | null; conversation_id: string; messages: TranscriptRow[]; more: boolean; widget_log: WidgetLogEntry[] };
  chat_state: ChatState;
  chat_created: { agent_id: string; conversation_id: string };
  chat_accepted: { accepted: boolean };
  chat_models: { entries: ModelEntry[] };
  /** `home_mac` is the Mac each agent lives on (plan 023), null for one whose record names none. */
  chat_agents: { agents: Array<{ id: string; name: string; home_mac?: string | null }> };
  chat_agent_created: { id: string; name: string };
  chat_done: NoPayload;
  chat_providers: { providers: ConnectProvider[] };
  chat_signin: { url: string; instructions: string | null };
  chat_command_done: { success: boolean; output: string };
  chat_skill_enabled: { name: string; link_path: string };
  /** Tools that run without asking, in every mode but strict (daemon/approvals.ts). */
  chat_approvals: { always: string[] };
  chat_mcp: McpView;
  chat_engines: EnginesView;
  /** Every label on a chat, with its colour and how many chats carry it (plan 022). */
  chat_labels: { labels: LabelView[] };
  /** What this Mac lacks to run an agent's chat (plan 023, U10): one line for the person each, none when nothing. */
  chat_requirements: { agent_id: string; missing: string[] };
  /** A Mac paired by `peer_pair_join` (plan 023). */
  peer_paired: { peer: PeerSummary };
  /**
   * A Mac's agents for another Mac (plan 023, U3): each record as its file holds it, with its change stamps and home,
   * and the agents deleted there (daemon/store/agent-sync.ts).
   */
  peer_agents: { agents: Array<{ id: string; record: Record<string, unknown> }>; tombstones: Array<{ id: string; at: string; mac: string }> };
  /** The commits of an agent's memory another Mac lacks, as a base64 git bundle, or null when it lacks none (plan 023, U7). */
  peer_memory: { agent_id: string; bundle: string | null };
  /**
   * The person's own state for another Mac (plan 023, U8): Inbox marks and focus, pins, label colours and Learn's
   * files, each in the shape its store merges (mod/peer-state.ts).
   */
  peer_state: { marks: object; pins: object; labels: object; learn: object; mcp: object; mods: object };
  /** The chats here of agents that live on the asking Mac, for it to take over on first pairing (plan 023, U9). */
  peer_moves: { chats: Array<{ agent_id: string; conversation_id: string }> };
  /** One chat copied out for the Mac it moves to (daemon/chat-move.ts MovedChat), its canvas files, or `busy` to wait. */
  peer_chat: { chat: object | null; busy: boolean; widgets: Record<string, string> };
  /** A Mac's own chats for another Mac's lists (plan 023, U4): its desks and its Inbox rows, none of another Mac's. */
  peer_chats: { desks: DeskSummary[]; inbox: InboxRow[] };
  /** Another Mac's answer to `peer_ping` on its peer link: who it is and which peer protocol it speaks. */
  peer_pong: MacIdentity & { build: string | null; protocol: number };
  chat_mcp_secret: { ref: string };
  chat_passes: PassSettings;
  /** What the import from Letta brought over (daemon/import/letta.ts). */
  chat_imported: { agents: string[]; chats: number; kept: number; credentials: string[]; schedules: number; notes: string[] };
  /** Whether Letta is here, whether an import finished with it, and how the last run went (at start or from Settings). */
  chat_import_status: { letta: boolean; complete: boolean; last: { at: string; ok: boolean; message: string } | null };
}
/** The name of a frame that answers a request. */
export type ReplyName = keyof Replies;

/** Where a chat stands when a client opens it (loki's daemon, plan 017 U5): running or not, its mode and folder. */
export interface ChatState {
  agent_id: string;
  conversation_id: string;
  loop: "running" | "idle" | "approval";
  /** The turn running now (daemon/telemetry.ts), for the app's analytics; null when idle. */
  turn_id?: string | null;
  mode: string | null;
  cwd: string | null;
  /** The answer in flight as written so far, when one is: a client opening mid-answer streams on from it. */
  streaming?: { text: string; at: string | null } | null;
  /** The ACP agent the chat runs on (plan 020); null or absent on loki's own engine. */
  engine?: ChatEngineView | null;
}

/** What the mod tells the app unasked, by push name: the payload beside `type`. */
export interface Pushes {
  desk: {
    scope: Scope;
    title: string | null;
    status: DeskStatus;
    agent_name: string | null;
    agent_id: string | null;
    model: string | null;
    reasoning_effort: ReasoningEffort | null;
    mode: string | null;
    state: DeskState;
    widgets: WidgetManifestEntry[];
  };
  desk_title: {
    scope: Scope;
    title: string | null;
    status: DeskStatus;
    agent_name: string | null;
    model: string | null;
    reasoning_effort: ReasoningEffort | null;
    mode?: string | null;
  };
  state: { scope: Scope; state: DeskState };
  widgets: { scope: Scope; widgets: WidgetManifestEntry[] };
  camera: { widget_id: string; widget_ids?: string[] };
  widget_change: { entry: WidgetLogEntry };
  switch_desk: { scope: Scope };
  desks: { desks: DeskSummary[] };
  /** `viewed` and `focus` are missing from older mods. */
  seen: { seen: Record<string, string>; viewed?: Record<string, string>; focus?: Record<string, FocusEntry> };
  models_recent: { recent: string[] };
  recall_changed: NoPayload;
  usage_changed: NoPayload;
  tasks_changed: NoPayload;
  /** An agent was created, renamed or deleted, or agents were imported: every client asks for its lists again. */
  agents_changed: NoPayload;
  /** Another Mac's chats changed, or it came into or out of reach (plan 023): every client asks for its lists again. */
  lists_changed: NoPayload;
  /** An agent's memory has new commits on this Mac: a paired Mac asks for them (plan 023, U7). */
  memory_changed: { agent_id: string };
  /** The person's marks, pins, label colours or Learn changed on this Mac: a paired Mac asks for them (plan 023, U8). */
  state_changed: NoPayload;
  lan_status: LanStatus;
  devices: { devices: DeviceSummary[] };
  pair_code: { code: string; url: string; expires_at: string };
  /** This Mac and the Macs paired with it (plan 023); `me.host` is its tailnet address, null off the tailnet. */
  peers: { me: MacIdentity & { host: string | null }; peers: PeerSummary[] };
  /** A code another Mac types to pair with this one, the address it types beside it, and when the code expires. */
  peer_pair_code: { code: string; host: string | null; expires_at: string };
  app_build: { build: string };
  /** What happened in a chat a client has open, in order (core/attention/model.ts ChatEvent). */
  chat_event: { agent_id: string; conversation_id: string; events: ChatEvent[] };
  /** A request that failed (with its request_id), or a send or frame the mod could not take (without). */
  error: { message: string; request_id?: string };
}
/** The name of a frame the mod pushes unasked. */
export type PushName = keyof Pushes;

interface RequestEntry<R extends ReplyName, P> {
  kind: "request";
  reply: R;
  phone: boolean;
  /** Whether another paired Mac may send it (plan 023): its own allow-list, never the phone's. */
  peer: boolean;
  doc: string;
  parse: Parse<P>;
}
interface SendEntry<P> {
  kind: "send";
  phone: boolean;
  /** Whether another paired Mac may send it (plan 023). */
  peer: boolean;
  /** The pushes it causes: how its effect comes back. */
  causes: PushName[];
  doc: string;
  parse: Parse<P>;
}
interface PushEntry {
  kind: "push";
  doc: string;
}

const request = <R extends ReplyName, P>(reply: R, doc: string, parse: Parse<P>, phone = false, peer = false): RequestEntry<R, P> => ({
  kind: "request",
  reply,
  phone,
  peer,
  doc,
  parse,
});
const send = <P>(doc: string, parse: Parse<P>, opts: { phone?: boolean; peer?: boolean; causes?: PushName[] } = {}): SendEntry<P> => ({
  kind: "send",
  phone: opts.phone ?? false,
  peer: opts.peer ?? false,
  causes: opts.causes ?? [],
  doc,
  parse,
});
const push = (doc: string): PushEntry => ({ kind: "push", doc });
const PHONE = true;
/** Marks a frame another paired Mac may send: a chat or canvas frame routed to the Mac it lives on (plan 023, U5). */
const PEER = true;

/** The frame table: every frame on `/ws` by name, whether it is a request (and the reply that answers it), a send (and the pushes it causes) or a push, a line saying what it is for, its parser, and whether a paired phone may send it. */
export const FRAMES = {
  // Desks and widgets
  gesture: send(
    "a gesture on a widget (move, resize, set …); its desk's state follows",
    (m) => (isGesture(m.gesture) ? { gesture: m.gesture } : "malformed gesture"),
    { causes: ["state"], peer: PEER },
  ),
  measure: send(
    "a widget's rendered size, which drives placement",
    (m) => {
      const size = m.size as Raw | undefined;
      return str(m.id) && size && isNum(size.w) && isNum(size.h) ? { id: m.id, size: { w: size.w, h: size.h } } : "malformed measure";
    },
    { causes: ["state"], peer: PEER },
  ),
  arrange: send("tidy this desk into a grid", nothing, { causes: ["camera"] }),
  trash: send("delete the widget's file: the agent's work is gone for good", (m) => (str(m.id) ? { id: m.id } : "malformed trash")),
  widget_status: send(
    "a runtime or reload error from the tab (null clears it)",
    (m) => (str(m.id) ? { id: m.id, error: str(m.error) && m.error.trim() ? m.error.trim() : null } : "malformed widget_status"),
    { causes: ["widgets"], peer: PEER },
  ),
  desk_get: send(
    "another desk's state and widgets, for widgets shown inline in a thread; no switch",
    (m) => (str(m.scope) && m.scope ? { scope: m.scope } : "scope required"),
    { phone: PHONE, causes: ["desk"], peer: PEER },
  ),
  list_desks: send("every desk, for the sidebar and search", nothing, { phone: PHONE, causes: ["desks"] }),
  pin_set: send(
    "pin or unpin a conversation (state/pins.json)",
    (m) =>
      str(m.agent_id) && str(m.conversation_id)
        ? { agent_id: m.agent_id, conversation_id: m.conversation_id, pinned: m.pinned === true }
        : "agent_id and conversation_id required",
    { phone: PHONE, causes: ["desks"] },
  ),
  models_recent_add: send("a model picked in loki, for the shared quick picks", (m) => (str(m.handle) && m.handle ? { handle: m.handle } : "handle required"), {
    phone: PHONE,
    causes: ["models_recent"],
  }),

  // Seen marks and focus
  seen_list: send("the done and viewed marks and the focus weights", nothing, { phone: PHONE, causes: ["seen"] }),
  seen_mark: send("mark a conversation done", mark, { phone: PHONE, causes: ["seen"] }),
  seen_unmark: send("mark a conversation not done", mark, { phone: PHONE, causes: ["seen"] }),
  viewed_mark: send("a look, not done (the sidebar's bold, the New line)", mark, { phone: PHONE, causes: ["seen"] }),
  focus_add: send(
    "an engagement the mod cannot see (a decision, an answer)",
    (m) => {
      const c = mark(m);
      if (typeof c === "string") return c;
      const action = m.action;
      return action === "answer" || action === "decide" || action === "skip"
        ? ({ ...c, action } satisfies { action: "answer" | "decide" | "skip" })
        : "action must be answer, decide or skip";
    },
    { phone: PHONE, causes: ["seen"] },
  ),

  // Analytics
  capture: send(
    "an analytics event the app saw; a `once` key keeps the first report of an event every window sees",
    (m) => {
      if (!isEventName(m.event)) return "malformed capture";
      const properties = m.properties && typeof m.properties === "object" && !Array.isArray(m.properties) ? { ...(m.properties as Raw) } : undefined;
      return { event: m.event, properties };
    },
    { phone: PHONE },
  ),

  // History and the Inbox
  history_get: request(
    "history",
    "a chat's last `limit` rows from its log, whether older ones remain, and its desk's widget log",
    (m) =>
      str(m.conversation_id)
        ? { agent_id: strOr(m.agent_id, null), conversation_id: m.conversation_id, limit: isNum(m.limit) ? m.limit : null }
        : "conversation_id required",
    PHONE,
    PEER,
  ),
  inbox_list: request("inbox", "every open conversation from disk, with who spoke last", nothing, PHONE),

  // Chats on loki's daemon (plan 017, U5), answered by its ChatBackend (mod/frames/chat.ts)
  chat_open: request(
    "chat_state",
    "follow a chat: its state now, then its chat_event pushes; `mode` sets its permission mode",
    (m) => {
      const c = chatRef(m);
      return typeof c === "string" ? c : { ...c, mode: strOr(m.mode, null) };
    },
    PHONE,
    PEER,
  ),
  chat_approve: request(
    "chat_accepted",
    "the person's decision on a tool call the chat asked about",
    (m) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      // The approval's own id: `request_id` is the frame's, matched to its reply.
      return str(m.approval_id) && typeof m.allow === "boolean"
        ? { ...c, approval_id: m.approval_id, allow: m.allow, message: strOr(m.message, null), always: m.always === true }
        : "approval_id and allow required";
    },
    PHONE,
    PEER,
  ),
  chat_answer: request(
    "chat_accepted",
    "the person's answers to a question card (the tool input with `answers` filled in)",
    (m) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return str(m.question_id) && m.input && typeof m.input === "object"
        ? { ...c, question_id: m.question_id, input: m.input as Raw }
        : "question_id and input required";
    },
    PHONE,
    PEER,
  ),
  chat_create: request(
    "chat_created",
    "a new chat for an agent, in a folder; `home` is the Mac it lives on, else its agent's when that Mac is in reach",
    (m) =>
      isAgentId(m.agent_id) ? { agent_id: m.agent_id, cwd: strOr(m.cwd, null), title: strOr(m.title, null), home: strOr(m.home, null) } : "agent_id required",
    PHONE,
    PEER,
  ),
  chat_send: request(
    "chat_accepted",
    "a message from the person; queued when the chat is busy, sent once per send_id",
    (m) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      if (!str(m.text)) return "text required";
      const images = Array.isArray(m.images)
        ? (m.images as Raw[]).filter((i) => str(i.media_type) && str(i.data)).map((i) => ({ media_type: i.media_type as string, data: i.data as string }))
        : [];
      return { ...c, text: m.text, images, send_id: strOr(m.send_id, null), context: strOr(m.context, null) };
    },
    PHONE,
    PEER,
  ),
  chat_abort: request("chat_done", "stop the chat's turn", chatRef, PHONE, PEER),
  chat_update: request(
    "chat_done",
    "rename, archive or hide a chat, or set its labels",
    (m) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return {
        ...c,
        title: m.title === null || str(m.title) ? m.title : undefined,
        archived: typeof m.archived === "boolean" ? m.archived : undefined,
        hidden: typeof m.hidden === "boolean" ? m.hidden : undefined,
        labels: Array.isArray(m.labels) ? chatLabels(strings(m.labels)) : undefined,
      };
    },
    PHONE,
    PEER,
  ),
  chat_folder: request(
    "chat_state",
    "move a chat to another folder",
    (m) => {
      const c = chatRef(m);
      return typeof c === "string" ? c : str(m.cwd) && m.cwd ? { ...c, cwd: m.cwd } : "cwd required";
    },
    PHONE,
    PEER,
  ),
  chat_model: request(
    "chat_done",
    "the model and reasoning effort a chat runs with",
    (m) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return str(m.handle) && m.handle
        ? { ...c, handle: m.handle, reasoning_effort: strOr(m.reasoning_effort, null) as ReasoningEffort | null }
        : "handle required";
    },
    PHONE,
    PEER,
  ),
  chat_models: request("chat_models", "the models the connected providers offer", nothing, PHONE),
  chat_agents: request("chat_agents", "the person's agents", nothing, PHONE),
  chat_agent_create: request("chat_agent_created", "a new agent, with its main chat; `persona` is who it is, written to its memory", (m) =>
    str(m.name) && m.name.trim()
      ? { name: m.name.trim(), description: strOr(m.description, null), persona: strOr(m.persona, null), model: strOr(m.model, null) }
      : "name required",
  ),
  chat_agent_update: request("chat_done", "an agent's name, description, model or home Mac", (m) =>
    isAgentId(m.agent_id)
      ? {
          agent_id: m.agent_id,
          name: strOr(m.name, undefined),
          description: strOr(m.description, undefined),
          model: strOr(m.model, undefined),
          home_mac: strOr(m.home_mac, undefined),
        }
      : "agent_id required",
  ),
  chat_agent_delete: request("chat_done", "delete an agent, its memory and its chats", agent),
  chat_import: request("chat_imported", "import agents, chats, keys and schedules from Letta (again: only what is missing)", nothing),
  chat_import_status: request("chat_import_status", "whether Letta is here, whether an import finished, and how the last one went", nothing),
  chat_passes_get: request("chat_passes", "whether reflection and Learn run in the background, and Learn's cards a day", nothing),
  chat_passes_set: request("chat_passes", "turn reflection or Learn on or off, or set Learn's cards a day", (m) => {
    const part = (v: unknown) => (v && typeof v === "object" ? (v as Raw) : undefined);
    const r = part(m.reflection),
      l = part(m.learn);
    if (r?.enabled !== undefined && typeof r.enabled !== "boolean") return "reflection.enabled must be true or false";
    if (l?.enabled !== undefined && typeof l.enabled !== "boolean") return "learn.enabled must be true or false";
    if (l?.daily_cap !== undefined && !(isNum(l.daily_cap) && l.daily_cap >= 0)) return "learn.daily_cap must be a number, 0 or more";
    return {
      ...(r?.enabled !== undefined ? { reflection: { enabled: r.enabled } } : {}),
      ...(l
        ? {
            learn: {
              ...(l.enabled !== undefined ? { enabled: l.enabled } : {}),
              ...(l.daily_cap !== undefined ? { daily_cap: Math.floor(l.daily_cap) } : {}),
            },
          }
        : {}),
    };
  }),
  chat_command: request(
    "chat_command_done",
    "run a slash command in a chat: compact, clear, remember or reflect",
    (m) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return str(m.command) && m.command ? { ...c, command: m.command, args: strOr(m.args, null) } : "command required";
    },
    PHONE,
  ),
  chat_memory_write: request("chat_done", "write a memory file (null content removes it), committed as yours", (m) =>
    isAgentId(m.agent_id) && str(m.path) && m.path
      ? { agent_id: m.agent_id, path: m.path, content: m.content === null ? null : strOr(m.content, ""), message: strOr(m.message, undefined) }
      : "agent_id and path required",
  ),
  chat_memory_revert: request("chat_done", "undo one memory commit with a new commit, as yours", (m) =>
    isAgentId(m.agent_id) && str(m.sha) && /^[0-9a-f]{7,40}$/i.test(m.sha) ? { agent_id: m.agent_id, sha: m.sha } : "agent_id and a commit sha required",
  ),
  chat_approvals_get: request("chat_approvals", "the tools you always allow", nothing),
  chat_approvals_set: request("chat_approvals", "always allow a tool, or take that back", (m) =>
    str(m.tool) && m.tool && typeof m.on === "boolean" ? { tool: m.tool, on: m.on } : "tool and on required",
  ),
  chat_labels_get: request("chat_labels", "every label on a chat, its colour and how many chats carry it", nothing, PHONE),
  chat_label_set: request("chat_labels", "rename, recolour or delete a label on every chat that carries it", (m) => {
    const name = str(m.name) ? labelName(m.name) : null;
    if (!name) return "name required";
    if (m.remove === true) return { name, remove: true as const };
    const rename = str(m.rename) ? labelName(m.rename) : null;
    if (str(m.rename) && !rename) return "rename to a label of letters, digits or dashes";
    const color = typeof m.color === "number" && Number.isInteger(m.color) && m.color >= 0 && m.color < LABEL_COLORS ? m.color : null;
    return rename || color !== null ? { name, ...(rename ? { rename } : {}), ...(color !== null ? { color } : {}) } : "rename, color or remove required";
  }),
  chat_engines_get: request("chat_engines", "the ACP agents a chat can run on, and how each stands", nothing),
  chat_engine_set: request("chat_engines", "add or change an ACP agent: its name and how loki starts it", (m) =>
    str(m.id) && /^[a-z0-9][a-z0-9-]*$/.test(m.id) && str(m.name) && m.name.trim() && str(m.command) && m.command.trim()
      ? { id: m.id, name: m.name.trim(), command: m.command.trim(), args: strings(m.args) }
      : "id (lowercase letters, digits and dashes), name and command required",
  ),
  chat_engine_remove: request("chat_engines", "remove an ACP agent, or put Claude Code back as loki ships it", (m) =>
    str(m.id) && m.id ? { id: m.id } : "id required",
  ),
  chat_engine_check: request("chat_engines", "start an ACP agent now, to see that it starts", (m) => (str(m.id) && m.id ? { id: m.id } : "id required")),
  chat_mcp_get: request("chat_mcp", "the MCP servers: state, tools and their costs, who has each switched off", nothing),
  chat_mcp_server: request("chat_mcp", "add, change, rename or remove an MCP server in mcp.json", (m) => {
    if (!str(m.entry) || !m.entry.trim()) return "entry required";
    const edit = mcpEdit(m.edit);
    if (typeof edit === "string") return edit;
    return { entry: m.entry, edit, rename: strOr(m.rename, null) };
  }),
  chat_mcp_always_load: request("chat_mcp", "the tools of an MCP server that skip search", (m) =>
    str(m.entry) && m.entry ? { entry: m.entry, tools: strings(m.tools) } : "entry required",
  ),
  chat_mcp_restart: request("chat_mcp", "start an MCP server again now", (m) => (str(m.name) && m.name ? { name: m.name } : "name required")),
  chat_mcp_signout: request("chat_mcp", "forget a remote MCP server's sign-in", (m) => (str(m.name) && m.name ? { name: m.name } : "name required")),
  chat_mcp_agent: request("chat_mcp", "switch an MCP server on or off for one agent", (m) =>
    isAgentId(m.agent_id) && str(m.server) && m.server && typeof m.on === "boolean"
      ? { agent_id: m.agent_id, server: m.server, on: m.on }
      : "agent_id, server and on required",
  ),
  chat_mcp_secret: request("chat_mcp_secret", "keep a value in the keychain for mcp.json to name", (m) =>
    str(m.name) && m.name && str(m.value) && m.value ? { name: m.name, value: m.value } : "name and value required",
  ),
  chat_skill_enable: request("chat_skill_enabled", "make a skill folder global: a link to it in the global skills folder", (m) =>
    str(m.path) && m.path ? { path: m.path } : "path required",
  ),
  chat_skill_disable: request("chat_done", "take a global skill away: its link in the global skills folder", (m) =>
    str(m.name) && m.name && !m.name.includes("/") && !m.name.includes("..") ? { name: m.name } : "a skill name required",
  ),
  chat_providers: request("chat_providers", "the model providers, connected or not", nothing),
  chat_provider_connect: request("chat_providers", "keep a provider's API key, once the provider accepts it", (m) =>
    str(m.provider_id) && m.provider_id && str(m.api_key) ? { provider_id: m.provider_id, api_key: m.api_key } : "provider_id and api_key required",
  ),
  chat_provider_disconnect: request("chat_providers", "forget a provider's credential", (m) =>
    str(m.provider_id) && m.provider_id ? { provider_id: m.provider_id } : "provider_id required",
  ),
  chat_provider_signin: request(
    "chat_signin",
    "start signing in to a provider: the page to open; the credential is kept when the browser comes back. With `code`, the address the browser ended on, for a sign-in still waiting",
    (m) => (str(m.provider_id) && m.provider_id ? { provider_id: m.provider_id, code: strOr(m.code, null) } : "provider_id required"),
  ),

  // Folders
  // `home` asks the Mac a new chat will live on (plan 023, U6): its folders, not this Mac's.
  folders_get: request("folders", "the folders each agent and conversation has worked in", (m) => ({ home: strOr(m.home, null) }), PHONE, PEER),
  folder_complete: request(
    "folder_matches",
    "folders completing a typed prefix",
    (m) => ({ prefix: strOr(m.prefix, null), home: strOr(m.home, null) }),
    false,
    PEER,
  ),
  folder_check: request(
    "folder_status",
    "whether a path is a folder a chat can work in, and its git branch",
    (m) => ({ path: strOr(m.path, null), home: strOr(m.home, null) }),
    false,
    PEER,
  ),
  folder_pick: request("folder_picked", "the system folder picker (null when cancelled)", (m) => ({ default_path: strOr(m.default_path, undefined) })),

  // Usage
  usage_get: request(
    "usage",
    "what the agents spent from `since` up to `until` (ISO instants): the ledger's hourly rows and each model's price status",
    (m) => (isInstant(m.since) && isInstant(m.until) ? { since: m.since, until: m.until } : "since and until required, as ISO instants"),
    PHONE,
  ),

  // Learn
  recall_list: request("recall", "the whole Learn section", nothing, PHONE),
  recall_grade: request(
    "recall_card",
    "grade a card, 1 (again) to 4 (easy)",
    (m) =>
      recallId(m, () =>
        m.grade === 1 || m.grade === 2 || m.grade === 3 || m.grade === 4 ? ({ grade: m.grade } satisfies { grade: Grade }) : "a grade is 1 (again) to 4 (easy)",
      ),
    PHONE,
  ),
  recall_edit: request(
    "recall_card",
    "edit a card's front, back or tags",
    (m) => recallId(m, () => ({ front: strOr(m.front, undefined), back: strOr(m.back, undefined), tags: Array.isArray(m.tags) ? strings(m.tags) : undefined })),
    PHONE,
  ),
  recall_reject: request("recall_card", "set a card aside (card: null)", (m) => recallId(m), PHONE),
  recall_restore: request("recall_card", "bring a set-aside card back", (m) => recallId(m), PHONE),
  recall_forget: request("recall_card", "forget a set-aside card for good (card: null)", (m) => recallId(m)),
  recall_settings: request("recall", "Learn's settings: on or off, and the most cards it writes in a day", (m) => ({
    enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
    daily_cap: isNum(m.daily_cap) && m.daily_cap >= 0 ? Math.round(m.daily_cap) : undefined,
  })),
  recall_run: request("recall_ran", "run Learn now over every chat with new material", nothing),
  recall_export: request("recall_export", "every card as Anki TSV", nothing, PHONE),
  recall_lead_dismiss: request("recall", "set a lead aside", (m) => recallId(m), PHONE),
  recall_lead_restore: request("recall", "bring a set-aside lead back", (m) => recallId(m), PHONE),
  recall_lead_start: request(
    "recall_lesson",
    "a lead becomes a [Learn] conversation with an info card on its desk; the app then sends the brief",
    (m) => recallId(m),
    PHONE,
  ),

  // The task list
  // The phone reads the list (a message's task chip) and files a task from a message's long press: one tap by the person.
  tasks_list: request("tasks", "the tasks in Tasks (all of them, closed too, when asked)", (m) => ({ all: m.all === true }), PHONE),
  task_create: request(
    "task_created",
    "a task filed from the app, stamped with its chat and folder, and the message it came from (Add task)",
    (m) => ({
      title: strOr(m.title, ""),
      description: strOr(m.description, undefined),
      labels: Array.isArray(m.labels) ? strings(m.labels) : undefined,
      priority: typeof m.priority === "number" ? m.priority : undefined,
      desk: strOr(m.desk, null),
      agent_id: strOr(m.agent_id, null),
      agent_name: strOr(m.agent_name, null),
      conversation_id: strOr(m.conversation_id, null),
      source: parseTaskSource(m.source),
    }),
    PHONE,
  ),
  task_assign: request("tasks_updated", "assign tasks to a chat, optionally starting them", (m) =>
    str(m.conversation_id) && str(m.desk)
      ? {
          ids: taskIds(m),
          conversation_id: m.conversation_id,
          desk: m.desk,
          agent_id: strOr(m.agent_id, null),
          agent_name: strOr(m.agent_name, null),
          start: m.start === true,
        }
      : "assign needs a conversation and a chat",
  ),
  task_close: request("tasks_updated", "close tasks, with a reason", (m) => ({ ids: taskIds(m), reason: strOr(m.reason, undefined) })),
  task_reopen: request("tasks_updated", "not done after all: an agent's done? taken back, or done tasks opened again", (m) => ({ ids: taskIds(m) })),
  task_status: request("tasks_updated", "move tasks to open, in progress, blocked or deferred", (m) =>
    m.status === "open" || m.status === "in_progress" || m.status === "blocked" || m.status === "deferred"
      ? ({ ids: taskIds(m), status: m.status } satisfies { ids: string[]; status: "open" | "in_progress" | "blocked" | "deferred" })
      : `unknown status ${String(m.status)}`,
  ),

  // Agents, memory and skills
  agent_get: request("agent", "an agent's local record, memory tree, skills, face and last memory commit", agent, PHONE),
  memory_read: request(
    "memory_file",
    "one memory file (content null when missing)",
    (m) => (isAgentId(m.agent_id) ? (str(m.path) ? { agent_id: m.agent_id, path: m.path } : "path required") : "agent_id required"),
    PHONE,
  ),
  memory_log: request(
    "memory_commits",
    "memory's git log, for a path or all of it",
    (m) =>
      isAgentId(m.agent_id)
        ? { agent_id: m.agent_id, path: strOr(m.path, undefined), limit: typeof m.limit === "number" ? m.limit : undefined }
        : "agent_id required",
    PHONE,
  ),
  memory_diff: request(
    "memory_diff",
    "one memory commit's diff",
    (m) => (isAgentId(m.agent_id) ? (str(m.sha) ? { agent_id: m.agent_id, sha: m.sha } : "sha required") : "agent_id required"),
    PHONE,
  ),
  reflection_state: request("reflection_state", "the last reflection pass that changed an agent's memory", agent),
  skills_global: request("skills_global", "skills outside memory (~/.agents/skills)", nothing),
  skill_install: request("skill_installed", "install a skill into an agent's memory", (m) =>
    isAgentId(m.agent_id) && str(m.source) ? { agent_id: m.agent_id, source: m.source, force: m.force === true } : "agent_id and source required",
  ),
  skill_refresh: request("skill_refreshed", "refresh an other skill from its upstream: current, replaced, or staged for the agent to reconcile", (m) =>
    isAgentId(m.agent_id) && str(m.name) ? { agent_id: m.agent_id, name: m.name, source: strOr(m.source, undefined) } : "agent_id and name required",
  ),

  // The phone listener (Settings › phone)
  lan_get: send("the listener's status, after asking Tailscale again", nothing, { causes: ["lan_status"] }),
  lan_set: send("turn the listener on or off (persisted, then bound or closed)", (m) => ({ enabled: m.enabled === true }), { causes: ["lan_status"] }),
  lan_via_set: send("which route the QR encodes", (m) => (isLanVia(m.via) ? { via: m.via } : 'via must be "tailscale" or "lan"'), { causes: ["lan_status"] }),
  lan_serve_set: send("`tailscale serve` on or off for the listener", (m) => ({ enabled: m.enabled === true }), { causes: ["lan_status"] }),
  pair_begin: send("mint a pairing code and the URL its QR carries", nothing, { causes: ["pair_code"] }),
  devices_list: send("the paired phones", nothing, { causes: ["devices"] }),
  device_forget: send("forget a phone and close its sockets", (m) => ({ id: strOr(m.id, null) }), { causes: ["devices"] }),

  // Other Macs (plan 023, mod/peers.ts): pairing, and the Macs paired with this one, for Settings › Macs
  peers_get: send("this Mac and the Macs paired with it", nothing, { causes: ["peers"] }),
  peer_pair_begin: send("mint a code another Mac types to pair with this one", nothing, { causes: ["peer_pair_code"] }),
  peer_pair_join: request("peer_paired", "pair with the Mac at `host` using the code it shows", (m) =>
    str(m.host) && m.host.trim() && str(m.code) && m.code.trim() ? { host: m.host.trim(), code: m.code.trim() } : "expected {host, code}",
  ),
  // Between paired Macs only (plan 023, U2): the peer link's first word, which also tells the two protocols apart.
  chat_requirements: request(
    "chat_requirements",
    "what the Mac a chat would live on (`home`, else this one) lacks to run the agent's chat",
    (m) => (isAgentId(m.agent_id) ? { agent_id: m.agent_id, home: strOr(m.home, null) } : "agent_id required"),
    false,
    PEER,
  ),
  peer_ping: request("peer_pong", "who this Mac is and which peer protocol it speaks", nothing, false, true),
  peer_agents_get: request("peer_agents", "this Mac's agents and the agents deleted here, for another Mac to take", nothing, false, true),
  peer_memory_get: request(
    "peer_memory",
    "the commits of an agent's memory the asking Mac lacks, given the commits it has",
    (m) => (isAgentId(m.agent_id) ? { agent_id: m.agent_id, have: strings(m.have) } : "agent_id required"),
    false,
    PEER,
  ),
  peer_state_get: request("peer_state", "the person's marks, pins, label colours and Learn, for another Mac", nothing, false, true),
  peer_moves_get: request("peer_moves", "the chats here whose agent lives on the asking Mac", nothing, false, true),
  peer_chat_export: request("peer_chat", "a chat copied out for the Mac it moves to; marks it moving here", chatRef, false, true),
  peer_chat_moved: request("chat_done", "the asking Mac holds the chat now: hide it here and stop its schedules", chatRef, false, true),
  peer_chats_get: request("peer_chats", "this Mac's own chats, for another Mac's lists", nothing, false, true),
  peer_forget: send("forget a paired Mac, telling it when it can be reached", (m) => (str(m.mac_id) ? { mac_id: m.mac_id } : "expected {mac_id}"), {
    causes: ["peers"],
  }),

  // Pushes
  desk: push("one desk in full (on connect, and for desk_get)"),
  desk_title: push("a desk's conversation was renamed, archived or changed model or mode"),
  state: push("a desk's geometry and overlay changed"),
  widgets: push("a desk's widget files changed"),
  camera: push("frame these widgets"),
  widget_change: push("the agent added, changed or removed a widget on any desk (mod/widget-log.ts)"),
  switch_desk: push("the active conversation changed; the tab follows"),
  desks: push("every desk, after list_desks or a pin"),
  agents_changed: push("an agent was created, renamed or deleted, or agents were imported; clients ask for the agents, chats and desks again"),
  lists_changed: push("another Mac's chats changed, or it came into or out of reach: ask for the lists again"),
  memory_changed: push("an agent's memory has new commits on this Mac"),
  state_changed: push("the person's marks, pins, label colours or Learn changed on this Mac"),
  seen: push("the done and viewed marks and the focus weights, after any change"),
  models_recent: push("the models used lately (on connect, and after a pick)"),
  recall_changed: push("Learn changed: other tabs and phones refetch"),
  usage_changed: push("the usage ledger counted more: open usage pages refetch"),
  tasks_changed: push("Tasks changed: other tabs refetch"),
  lan_status: push("the phone listener's status"),
  devices: push("the paired phones"),
  pair_code: push("a pairing code, its URL and when it expires"),
  peers: push("this Mac and the Macs paired with it"),
  peer_pair_code: push("a code another Mac types to pair with this one"),
  app_build: push("the build a phone is served, so it can offer a reload"),
  chat_event: push("what happened in a chat a client has open"),
  error: push("a failed request (with its request_id) or a frame the mod could not take"),
} as const;

type Table = typeof FRAMES;
/** The name of any frame in the table. */
export type FrameName = keyof Table;
/** The name of a frame the app sends and the mod answers with a reply. */
export type RequestName = { [K in FrameName]: Table[K] extends { kind: "request" } ? K : never }[FrameName];
/** The name of a frame the app sends without waiting for an answer; its effect comes back as pushes. */
export type SendName = { [K in FrameName]: Table[K] extends { kind: "send" } ? K : never }[FrameName];
/** What a request or send carries once parsed. */
export type PayloadOf<N extends RequestName | SendName> = Exclude<ReturnType<Table[N]["parse"]>, string>;
/** What the app sends for a frame: the parsed payload, with every field that may be null or absent left optional. */
export type InputOf<N extends RequestName | SendName> = Optional<PayloadOf<N>>;
type Optional<T> = { [K in keyof T as undefined extends T[K] ? K : null extends T[K] ? K : never]?: T[K] } & {
  [K in keyof T as undefined extends T[K] ? never : null extends T[K] ? never : K]: T[K];
};
/** How a request ends for the app: its reply, or the mod's message (or its silence, `timedOut`). */
export type RequestResult<R> = { ok: true; reply: R } | { ok: false; error: string; timed_out: boolean };
/** The reply a request is answered with. */
export type ReplyOf<N extends RequestName> = Table[N] extends { reply: infer R extends ReplyName } ? Replies[R] : never;
/** A push as it arrives: its name beside its payload. */
export type PushFrame = { [K in PushName]: { type: K } & Pushes[K] }[PushName];

/** The frame table's entry for a frame's `type` (how the mod's router finds what to do); undefined for a type the table does not list. */
export const frameEntry = (type: unknown): Table[FrameName] | undefined =>
  typeof type === "string" && Object.hasOwn(FRAMES, type) ? FRAMES[type as FrameName] : undefined;

/** How the app reads a request's answer: the frame that carried its request_id, or null when none came in time. */
export function requestResult<R>(answer: Record<string, unknown> | null): RequestResult<R> {
  if (!answer) return { ok: false, error: "no answer from the mod", timed_out: true };
  if (answer.type === "error") return { ok: false, error: typeof answer.message === "string" ? answer.message : "the mod refused", timed_out: false };
  return { ok: true, reply: answer as unknown as R };
}

/**
 * The frames a paired phone may send over its /ws (mod/lan.ts), marked `phone` above; everything else answers `error`.
 * Reads and the user's own markers: desks, transcripts, seen and focus, pins, recent folders, and the
 * read-only agent pages (record, memory tree and files, git log and diffs); Learn's cards, and its leads
 * (a lesson started, a lead set aside or brought back: each one tap by the person, as sending a message is);
 * and a model picked there, for the shared quick picks.
 * The task list to read, and a task filed from a message (Add task in its long press); nothing that assigns, closes or reopens.
 * Never gestures, skills, the writer's settings, or the pairing and device frames.
 */
export const PHONE_FRAMES: ReadonlySet<FrameName> = new Set(
  (Object.keys(FRAMES) as FrameName[]).filter((n) => FRAMES[n].kind !== "push" && (FRAMES[n] as { phone: boolean }).phone),
);

/**
 * The frames another paired Mac may send over its /ws (plan 023, KTD4), marked `peer` above; everything else answers
 * `error`. A phone's frame reaches another Mac only after its own Mac checked it against PHONE_FRAMES. Never the
 * pairing, device or Mac frames, nor the writer's settings.
 */
export const PEER_FRAMES: ReadonlySet<FrameName> = new Set(
  (Object.keys(FRAMES) as FrameName[]).filter((n) => FRAMES[n].kind !== "push" && (FRAMES[n] as { peer: boolean }).peer),
);
