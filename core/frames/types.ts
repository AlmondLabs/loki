import type { ChatEvent } from "../attention/model.ts";
import type { ChatEngineView, ModelEntry, ReasoningEffort } from "../models.ts";
import type { ChatLink, LinkDuration } from "../chat-links.ts";
import type { Scope } from "../chat-scope.ts";
import type { SubagentView } from "../subagents.ts";
import type { FocusEntry } from "../attention/focus.ts";
import type { Lane } from "../attention/lanes.ts";
import type { Rest, ReturnTimes } from "../attention/rest.ts";
import type { CardWithSchedule, LearnReply } from "../learn/model.ts";
import type { ConnectProvider, PassSettings } from "../attention/protocol.ts";
import type { ToolStep, TranscriptRow } from "../attention/transcript.ts";
import type { LabelView } from "../labels.ts";
import type { UsageReply } from "../usage.ts";
import { REPLY_WAIT_MS } from "../frame-client.ts";
import type {
  AccountLabel,
  AccountView,
  ChatStatus,
  ChatSummary,
  DeviceSummary,
  EmojiChoice,
  EnginesView,
  FolderCheck,
  GlobalSkill,
  HandoffProposal,
  FlowRow,
  JiraCardTicket,
  LanStatus,
  LocalAgent,
  MacIdentity,
  MailCompose,
  McpView,
  MemoryCommit,
  MemoryFile,
  MemorySkill,
  MemorySkillInfo,
  OutsideChange,
  OutsideMessage,
  OutsideReplied,
  OutsideWindow,
  PeerSummary,
  RecentFolders,
  ReflectionState,
  RefreshOutcome,
  ReplyMention,
  ReplyPersonChoice,
  ReplyProposal,
  SlackPerson,
  SlackWorkspaceView,
  Suggestion,
  TailnetDevice,
} from "../frame-types.ts";

export type Raw = Record<string, unknown>;

export type Parse<P> = (m: Raw) => P | string;

/** The person's state kept as folders of files, which another Mac asks for only when they changed (plan 040). */
export const STATE_FOLDERS = ["learn", "mods"] as const;
export type StateFolder = (typeof STATE_FOLDERS)[number];

/** The folders a frame names; undefined when it names none, as a pull on reaching a Mac or on the poll does, which means all of them. */
export function stateFolders(v: unknown): StateFolder[] | undefined {
  return Array.isArray(v) ? STATE_FOLDERS.filter((f) => v.includes(f)) : undefined;
}

/**
 * Why a chat refuses a saved draft (plan 049, KTD7): it holds another suggestion's, which is never replaced. The chat's
 * Mac says it, and the Mac that asked recognises it.
 */
export const DRAFT_HELD = "that chat already holds a saved draft";

/** What the person does with a suggestion: send it now, save it as a draft in its chat's box, or reject it. */
export type SuggestionAction = "send" | "draft" | "reject";

/**
 * What the person does with a reply an agent proposed (plan 2026-11-14-1134, KTD3): Send it (`approve` on the wire, the
 * name clients already send), Undo it while it is held, or reject it.
 */
export type ReplyAction = "approve" | "undo" | "reject";

/**
 * What a Send carries beside its action: the text as the person edited it, the names of the files they kept (all when
 * left out), and the people they mentioned with the card's picker (plan 2026-11-14-1530, KTD6), already resolved.
 */
export interface ReplyDecideOptions {
  text?: string | null;
  files?: readonly string[] | null;
  mentions?: readonly ReplyMention[] | null;
  /** A new ticket's title as the person edited it on the card; its only field besides the words they may change. */
  title?: string | null;
}

/** The payload of a frame that carries nothing beside `type` (and a reply's `request_id`). */
export type NoPayload = object;

export interface MacAccountView extends AccountView {
  mac_id: string;
  /** The Mac's name as this Mac shows it. */
  mac_name: string;
}

export interface ChatState {
  agent_id: string;
  conversation_id: string;
  loop: "running" | "idle" | "approval";
  mode: string | null;
  cwd: string | null;
  /** The answer in flight as written so far, when one is: a client opening mid-answer streams on from it. */
  streaming?: { text: string; at: string | null } | null;
  /** The ACP agent the chat runs on (plan 020); null or absent on loki's own engine. */
  engine?: ChatEngineView | null;
  /** The suggestions made in the chat that wait on the person or are being sent (plan 049); absent from a mod that predates them. */
  suggestions?: Suggestion[];
  /** The replies proposed in the chat that wait on the person or are being drafted (plan 067); absent from a mod that predates them. */
  reply_proposals?: ReplyProposal[];
  /** The chat's live links to other chats (plan 067); absent from a mod that predates them. */
  links?: ChatLink[];
  /** This chat's helper subagents for the Workers tab. */
  subagents?: SubagentView[];
}

/** The answer to a request, by reply name: the payload beside `type` and `request_id`. */
export interface Replies {
  folders: RecentFolders;
  folder_matches: { matches: string[] };
  folder_status: FolderCheck;
  folder_picked: { path: string | null };
  learn: LearnReply;
  usage: UsageReply;
  learn_card: { card: CardWithSchedule | null };
  learn_ran: { note: string };
  learn_export: { tsv: string };
  learn_lesson: { agent_id: string; conversation_id: string };
  skills_global: { skills: GlobalSkill[] };
  skill_installed: { agent_id: string; output: string };
  skill_refreshed: { agent_id: string; name: string } & RefreshOutcome;
  agent: { agent: LocalAgent; files: MemoryFile[]; skills: Array<MemorySkill | MemorySkillInfo>; has_profile: boolean; last_commit: MemoryCommit | null };
  reflection_state: { agent_id: string } & ReflectionState;
  memory_file: { agent_id: string; path: string; content: string | null };
  memory_commits: { agent_id: string; commits: MemoryCommit[] };
  memory_diff: { agent_id: string; sha: string; diff: string };
  flow: { conversations: FlowRow[] };
  /** `start` is the position of the first of `messages` in the chat's whole thread. */
  history: { agent_id: string | null; conversation_id: string; messages: TranscriptRow[]; more: boolean; start: number };
  /**
   * One lean row made whole: a tool row's step (plan 041), or an event's detail (plan 043); each null when the row is
   * not that. A Mac on a loki from before plan 043 leaves `detail` out, and sends no event lean.
   */
  history_step: { step: ToolStep | null; detail?: string | null };
  chat_state: ChatState;
  chat_created: { agent_id: string; conversation_id: string };
  chat_accepted: { accepted: boolean };
  chat_models: { entries: ModelEntry[] };
  /** `home_mac` is the Mac each agent lives on (plan 023), null for one whose record names none. */
  chat_agents: { agents: Array<{ id: string; name: string; home_mac?: string | null }> };
  chat_agent_created: { id: string; name: string };
  /**
   * Done. `chat_update` that saved a draft names its suggestion in `draft_suggestion_id`: a 2026.1116 Mac drafting
   * here checks for it before it calls the suggestion drafted.
   */
  chat_done: { draft_suggestion_id?: string };
  chat_providers: { providers: ConnectProvider[] };
  chat_signin: { url: string; instructions: string | null };
  chat_command_done: { success: boolean; output: string };
  chat_skill_enabled: { name: string; link_path: string };
  /** Tools that run without asking, in every mode but strict (daemon/approvals.ts). */
  chat_approvals: { always: string[] };
  chat_mcp: McpView;
  chat_engines: EnginesView;
  chat_labels: { labels: LabelView[] };
  /** What this Mac lacks to run an agent's chat (plan 023, U10): one line for the person each, none when nothing. */
  chat_requirements: { agent_id: string; missing: string[] };
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
   * files, each in the shape its store merges (mod/peer-state.ts). Learn's and the mods' files come only when asked for
   * (plan 040).
   */
  peer_state: { marks: object; pins: object; labels: object; learn?: object; mcp: object; mods?: object };
  /** The chats here of agents that live on the asking Mac, for it to take over on first pairing (plan 023, U9). */
  peer_moves: { chats: Array<{ agent_id: string; conversation_id: string }> };
  /** One chat copied out for the Mac it moves to (daemon/chat-move.ts MovedChat), or `busy` to wait. */
  peer_chat: { chat: object | null; busy: boolean };
  /** The Macs this one is paired with, for another to join those it lacks (plan 023, addendum D1). */
  peer_group: { macs: Array<MacIdentity & { host: string }> };
  /** An invite to pair with a Mac, bound to the asking Mac, and where to redeem it (addendum D4). */
  peer_invite: { host: string; code: string };
  /** Whether this Mac holds a chat, and where it went when this Mac let it go (plan 023, addendum B2). */
  peer_here: { held: boolean; moved_to: string | null };
  /** Whether a Mac took the chat the asking Mac offered it (plan 023, addendum A1), or `busy` while a turn runs there. */
  peer_chat_taken: { moved: boolean; busy: boolean };
  /** A Mac's own chats for another Mac's lists (plan 023, U4): its desks and its Inbox rows, none of another Mac's. */
  peer_chats: {
    chats: ChatSummary[];
    flow: FlowRow[];
    /**
     * Its outside cards (plan 067, R14), apart from `flow` so a Mac on a loki from before them, which reads only
     * `flow`, shows none of them.
     */
    outside?: FlowRow[];
  };
  /** Another Mac's answer to `peer_ping` on its peer link: who it is and which peer protocol it speaks. */
  peer_pong: MacIdentity & { build: string | null; protocol: number };
  chat_mcp_secret: { ref: string };
  chat_passes: PassSettings;
  /**
   * A suggestion as it stands after an action (plan 049): `done` when the action took, else `message` says why not,
   * among them what already happened to it and from where (R17).
   */
  suggestion_decided: { suggestion: Suggestion; done: boolean; message: string | null };
  /**
   * A reply proposal as it stands after an action (plan 2026-11-14-1134, KTD3): `done` when it took, else `message`
   * says why not. A Send answers as sending; what became of the reply comes as the chat's `reply_proposals` event.
   */
  reply_decided: { proposal: ReplyProposal; done: boolean; message: string | null };
  /** The people a reply card's `@` picker offers, and a line to show instead when the account cannot search by name. */
  reply_people_found: { people: ReplyPersonChoice[]; notice: string | null };
  /**
   * The accounts connected on this Mac (plan 067, U2), after a list, a move or a disconnect; no secrets in them. A list
   * also carries each paired Mac's accounts as it last said (plan 087, KTD9); a mod from before that leaves them out.
   */
  accounts: { accounts: AccountView[]; other_macs?: MacAccountView[] };
  /**
   * An outside card's thread archived on the Mac its account lives on (plan 067, U3), with what the archive changed out
   * there for an undo (plan 070, R14); null when nothing was written.
   */
  account_thread_archived: { account_id: string; thread_id: string; change: OutsideChange | null };
  /**
   * A move written back to an outside card's account (plan 070, KTD3): what it changed, for the client to keep for an
   * undo; null when nothing was written (the card was not open) and after an undo itself.
   */
  account_thread_changed: { account_id: string; thread_id: string; change: OutsideChange | null };
  /**
   * The person's reply sent in an outside card's thread (plan 070, KTD6), and apart from it how the move after it went:
   * `then_error` is that move's reason when it failed, and the client tries the move again without the text.
   */
  account_thread_replied: { account_id: string; thread_id: string } & OutsideReplied;
  account_compose: { account_id: string; thread_id: string } & MailCompose;
  /** Whether a held mail reply was stopped before it went (plan 076); false when it had already gone or was never held. */
  account_thread_unsent: { account_id: string; outbox_id: string; undone: boolean };
  /** Whether a mail reply that did not go was discarded (plan 096); false when there was none to discard. */
  account_thread_discarded: { account_id: string; outbox_id: string; discarded: boolean };
  account_thread_reacted: { account_id: string; thread_id: string; message_id: string; name: string; on: boolean };
  account_emoji: { account_id: string; emoji: EmojiChoice[] };
  account_people: { account_id: string; people: SlackPerson[] };
  account_labels: { account_id: string; labels: AccountLabel[] };
  account_thread: { account_id: string; thread_id: string; messages: OutsideMessage[]; window?: OutsideWindow; link?: string; ticket?: JiraCardTicket };
  /** A move on an outside card kept in the ledger of the Mac its account lives on (plan 069); `kept` is false when that Mac keeps none. */
  account_move_kept: { account_id: string; thread_id: string; kept: boolean };
  account_thread_handoff_proposal: HandoffProposal;
  account_thread_handed_off: { account_id: string; thread_id: string; agent_id: string; conversation_id: string };
  /** Google's page to open for connecting a Gmail account (plan 067, U5); the account is kept when the browser comes back. */
  account_signin: { url: string };
  /**
   * The workspaces signed in to the Slack desktop app here (plan 067, R21) when listing them, with `account` null; after
   * connecting one, the account connected, and no workspaces.
   */
  slack_workspaces: { workspaces: SlackWorkspaceView[]; account: AccountView | null };
  /** The live links of a Mac's chats, and the duration the link card starts on (plan 067). */
  chat_links: { links: ChatLink[]; default_duration: LinkDuration };
}
export type ReplyName = keyof Replies;

/** What the mod tells the app unasked, by push name: the payload beside `type`. */
export interface Pushes {
  chat_meta: {
    scope: Scope;
    title: string | null;
    status: ChatStatus;
    agent_name: string | null;
    agent_id: string | null;
    model: string | null;
    reasoning_effort: ReasoningEffort | null;
    mode?: string | null;
  };
  switch_chat: { scope: Scope };
  chats: { chats: ChatSummary[] };
  /**
   * `viewed`, `focus`, `rests` and `return_times` are missing from older mods; `return_times` is null while the person
   * has set none (plan 070), and the Mac then moves its own old first-rest choice there. `lanes` is missing from a mod
   * from before plan 087, and the client then keeps what it has.
   */
  seen: {
    seen: Record<string, string>;
    viewed?: Record<string, string>;
    focus?: Record<string, FocusEntry>;
    rests?: Record<string, Rest>;
    return_times?: ReturnTimes | null;
    lanes?: Lane[];
  };
  /** One chat's marks as they now stand, after a change to that chat alone (plan 055); null where it has none. */
  seen_chat: { key: string; seen: string | null; viewed: string | null; focus: FocusEntry | null; rest: Rest | null };
  models_recent: { recent: string[] };
  /** Each agent's usual models (mod/usual-models.ts), most used first: a new chat starts on the first, the switcher leads with them. */
  models_usual: { usual: Record<string, Array<{ handle: string; reasoning_effort: ReasoningEffort | null; uses: number }>> };
  learn_changed: NoPayload;
  usage_changed: NoPayload;
  /** An agent was created, renamed or deleted, or agents were imported: every client asks for its lists again. */
  agents_changed: NoPayload;
  /** Another Mac's chats changed, or it came into or out of reach (plan 023): every client asks for its lists again. */
  lists_changed: NoPayload;
  /**
   * A chat on this Mac was renamed, archived, hidden, relabelled or given a purpose or draft (plan 050): every client asks for its lists again,
   * and a paired Mac fetches this Mac's chats.
   */
  chat_changed: NoPayload;
  /** An agent's memory has new commits on this Mac: a paired Mac asks for them (plan 023, U7). */
  memory_changed: { agent_id: string };
  /**
   * The person's marks, pins, label colours or Learn changed on this Mac: a paired Mac asks for them (plan 023, U8),
   * with the folders named here (plan 040).
   */
  state_changed: { folders: StateFolder[] };
  lan_status: LanStatus;
  devices: { devices: DeviceSummary[] };
  pair_code: { code: string; url: string; expires_at: string };
  /**
   * This Mac and the Macs paired with it (plan 023); `me.host` is its tailnet address, null off the tailnet.
   * `tailnet` is the other computers on the tailnet, to pick one to pair with instead of typing its address.
   */
  peers: { me: MacIdentity & { host: string | null }; peers: PeerSummary[]; tailnet?: Array<TailnetDevice & { paired: boolean }> };
  /** A code another Mac types to pair with this one, the address it types beside it, and when the code expires. */
  peer_pair_code: { code: string; host: string | null; expires_at: string };
  app_build: { build: string };
  /** What happened in a chat a client has open, in order (core/attention/model.ts ChatEvent). */
  chat_event: { agent_id: string; conversation_id: string; events: ChatEvent[] };
  /** A request that failed (with its request_id), or a send or frame the mod could not take (without). */
  /**
   * `moved_to`: a paired Mac's frame named a chat that does not live here (plan 023, addendum B3): where it went when
   * this Mac let it go, or null when it has no note. Absent on every other error.
   */
  error: { message: string; request_id?: string; moved_to?: string | null };
  /** A checkout's code changed (plans 024 and 041): `file` names it; the window offers the update (a build, a restart). */
  restart_due: { file: string | null };
  /** The Macs this one is paired with changed (addendum D1). */
  group_changed: NoPayload;
  /** This Mac let a chat go to the paired Mac `to` (plan 023, addendum B3): other Macs send its frames there now. */
  chat_left: { agent_id: string | null; conversation_id: string; to: string };
  /** An account here was connected, moved, disconnected or changed status; sent to paired Macs too (plan 067). */
  accounts_changed: NoPayload;
}
export type PushName = keyof Pushes;

/** How a request or send crosses to another paired Mac (plan 023, addendum C). */
export interface PeerMeaning {
  /**
   * How a frame from this Mac's clients finds the Mac it is about: the chat it names, the Mac its
   * `home` names, or the Mac a new chat will live on. Absent: a frame only paired Macs send each other.
   */
  route?: "chat" | "home" | "new-chat";
  /** Once it succeeds on another Mac, that Mac's chats are read again: it changes how a chat is listed there. */
  relists?: true;
  /** How long it may take on the other Mac; absent, the router's usual wait. */
  timeout_ms?: number;
}

/** How a push from a paired Mac is taken here (addendum C). */
export interface PushPeerMeaning {
  /** Passed on to this Mac's clients when it comes from the Mac holding the chat it names. */
  relay?: "chat";
  /** It may change that Mac's chats, so they are read again: always, or only for these chat event kinds. */
  lists?: true | ReadonlyArray<ChatEvent["kind"]>;
}

export interface RequestEntry<R extends ReplyName, P> {
  kind: "request";
  reply: R;
  phone: boolean;
  /** How another paired Mac may send it (plan 023, addendum C): its own allow-list, never the phone's; null, never. */
  peer: PeerMeaning | null;
  doc: string;
  parse: Parse<P>;
}

export interface SendEntry<P> {
  kind: "send";
  phone: boolean;
  /** How another paired Mac may send it (plan 023, addendum C); null, never. */
  peer: PeerMeaning | null;
  /** The pushes it causes: how its effect comes back. */
  causes: PushName[];
  doc: string;
  parse: Parse<P>;
}

export interface PushEntry {
  kind: "push";
  doc: string;
  /** How it is taken when a paired Mac pushes it (addendum C); absent, it is not passed on and changes no list. */
  peer?: PushPeerMeaning;
}

export const request = <R extends ReplyName, P>(
  reply: R,
  doc: string,
  parse: Parse<P>,
  phone = false,
  peer: PeerMeaning | null = null,
): RequestEntry<R, P> => ({
  kind: "request",
  reply,
  phone,
  peer,
  doc,
  parse,
});

export const send = <P>(doc: string, parse: Parse<P>, opts: { phone?: boolean; peer?: PeerMeaning; causes?: PushName[] } = {}): SendEntry<P> => ({
  kind: "send",
  phone: opts.phone ?? false,
  peer: opts.peer ?? null,
  causes: opts.causes ?? [],
  doc,
  parse,
});

export const push = (doc: string, peer?: PushPeerMeaning): PushEntry => ({ kind: "push", doc, ...(peer ? { peer } : {}) });

export const PHONE = true;
export const BY_CHAT: PeerMeaning = { route: "chat" };
export const BY_CHAT_RELISTED: PeerMeaning = { route: "chat", relists: true };
export const BY_HOME: PeerMeaning = { route: "home" };
export const SENDS_REPLY: PeerMeaning = { route: "home", relists: true, timeout_ms: REPLY_WAIT_MS };
export const BETWEEN_MACS: PeerMeaning = {};
export const LISTED_EVENTS: ReadonlyArray<ChatEvent["kind"]> = ["loop", "turn_end", "approval", "question", "error", "device", "reply_proposals"];
