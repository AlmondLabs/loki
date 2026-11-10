import type { Scope } from "./desk-core.ts";
import type { ReasoningEffort } from "./models.ts";
import type { AskedBy } from "./attention/priority.ts";

/**
 * The shapes frames carry (core/frames.ts) that the mod produces and the app reads: desks, the Inbox's rows, the
 * suggestions, agents and their memory and skills, folders, and the phone listener. Plain data, no behaviour; the
 * mod modules that build them import them from here.
 */

/** One agent as the Agents page shows it, read by the mod from the agent's record and sent in the `agent` frame. */
export interface LocalAgent {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  /** The agent's own effort (`reasoning_effort`), context window and the like, as its record keeps them. */
  model_settings: Record<string, unknown>;
  tags: string[];
  favourite: boolean;
  /** The first line of the system prompt, for orientation; the prompt is the agent record's, not editable here. */
  system_head: string | null;
  /** The Mac the agent lives on (plan 023), or null when its record names none: then it lives on the Mac that has it. */
  home_mac: string | null;
}

/** One file of an agent's memory, its path relative to the memory root with forward slashes, as the `agent` frame lists them. */
export interface MemoryFile {
  path: string;
  bytes: number;
  modified_at: string;
}

/** One skill in an agent's memory (its skills/ folder), named by its folder. */
export interface MemorySkill {
  name: string;
  path: string;
  /** From the SKILL.md frontmatter, or its first heading. */
  description: string | null;
}

/** One commit to an agent's memory repo, as the `agent` and `memory_commits` frames carry it; `at` is ISO time. */
export interface MemoryCommit {
  sha: string;
  message: string;
  at: string;
  files: string[];
  /** The committer: the agent's name, or "Reflection Subagent" for a sleep-time pass (mod/reflection.ts). */
  author: string;
}

/** Where a memory skill came from: written by the agent itself, or installed from somewhere else (mod/skill-sources.ts). */
export type SkillOrigin = "self" | "other";

/** Where refreshing an installed skill fetches it from. */
export type SkillSource =
  /** A git checkout on this Mac; refresh pulls it. `rel` is the skill folder inside it. */
  | { kind: "checkout"; repo: string; rel: string; label: string }
  /** A plain folder on this Mac (no git); refresh copies from it. */
  | { kind: "folder"; path: string; label: string }
  /** A GitHub repository; refresh clones it shallowly. `path` is the skill folder inside it. */
  | { kind: "github"; url: string; path: string; ref: string | null; label: string };

/** What the mod knows of a memory skill's origin: who wrote it, whether the agent changed its copy, and where refresh would fetch it. */
export interface SkillProvenance {
  origin: SkillOrigin;
  /** Commits after the last install/refresh: the agent changed its copy. */
  edited: boolean;
  /** Where refresh would fetch from; null for a self skill or an other skill nobody told us the source of. */
  source: SkillSource | null;
}

/** A memory skill with its provenance, as the `agent` frame lists it once the mod has read the repo's history. */
export type MemorySkillInfo = MemorySkill & SkillProvenance;

/** How refreshing an installed skill went (`skill_refreshed`): already current, replaced with upstream, or staged for the agent to reconcile with its own edits. */
export type RefreshOutcome =
  | { outcome: "current"; label: string }
  | { outcome: "replaced"; label: string; changed: string[]; sha: string | null }
  | { outcome: "reconcile"; label: string; changed: string[]; upstream_path: string; prompt: string };

/** One skill in the global skills folder (~/.agents/skills), as `skills_global` lists them. */
export interface GlobalSkill {
  name: string;
  /** Where the folder really is (the link target), or the folder itself. */
  path: string;
  is_link: boolean;
  description: string | null;
  /** Where it came from, when known (mod/skill-sources.ts describeGlobal): the checkout a link points into, or the repo the `skills` CLI recorded. */
  source?: string | null;
}

/** An agent's reflection passes as the `reflection_state` frame reports them. */
export interface ReflectionState {
  /** The newest memory commit a reflection pass made, or null when no pass has changed memory. */
  last_commit: MemoryCommit | null;
}

/** The two ways into the listener: the tailnet (a 100.x peer, or `tailscale serve` on loopback) or the Wi‑Fi. */
export type DeviceVia = "tailscale" | "lan";

/** What the inbox decides on, from the mod's view of each chat: who spoke last, and the assistant's last words. */
export interface LocalDigest {
  last_role: "user" | "assistant" | null;
  last_assistant_text: string | null;
  /** Who sent the last message into the conversation: the inbox's score tells a reply to you from a cron's report by it. */
  last_ask: AskedBy | null;
}

/**
 * Where a chat lives when it is not on this Mac (plan 023, U4): the Mac's id and name, and whether it can be reached
 * now. Absent on this Mac's own chats.
 */
export interface ChatHome {
  home?: string;
  home_name?: string;
  reachable?: boolean;
}

/** One open chat in the Inbox list the mod sends (`inbox`): the conversation, its agent, and its digest. Archived chats are left out. */
export interface InboxRow extends LocalDigest, ChatHome {
  id: string;
  agent_id: string;
  agent_name: string | null;
  title: string | null;
  last_message_at: string | null;
  archived: false;
  /** The person's labels on the chat (plan 022). */
  labels?: string[];
  /** The person's one line on what the chat is for (plan 049); null when none, absent from a mod that predates it. */
  purpose?: string | null;
  /** A suggestion saved as a draft waits in the chat's message box (plan 049, R9): the card says so. */
  has_draft?: boolean;
  /** That draft's text, which fills the chat's message box when it opens empty (plan 049, KTD7); null when none. */
  draft_text?: string | null;
  /** The folder the chat works in; null when it has none of its own. */
  cwd?: string | null;
  /** The replies its agent proposed that wait on the person or are being drafted (plan 067, KTD9): the card is blocked. */
  reply_proposals?: ReplyProposal[];
  /**
   * An outside card (plan 067, KTD1): a Gmail or Slack thread, not a chat. Its `agent_id` is `account:<account_id>` and
   * its `id` is `<thread_id>#<generation>`, so moving the account's owner keeps the card's marks, and the card after a
   * hand-off starts clean. Absent on a chat's row.
   */
  kind?: "outside";
  /** What an outside card shows and acts on; present exactly when `kind` is `outside`. */
  outside?: OutsideFacts;
}

/**
 * An outside card's own facts (plan 067, R10): the account and its owner, who wrote last and about what, the thread's
 * last few messages as plain text, and the chat a hand-off took it to. Message text stays on this Mac's clients and
 * paired Macs; it reaches a model only through a hand-off or the owner's tools (R23).
 */
export interface OutsideFacts {
  account_id: string;
  provider: AccountProvider;
  /** The account as the card names it: the mailbox's address, or the workspace's name. */
  account_label: string;
  thread_id: string;
  /** Rises with each hand-off, so a new message after one is a new card (R19). */
  generation: number;
  owner_agent_id: string;
  /** The owner's name; null when its record gives none. */
  owner_name: string | null;
  /** Who wrote the newest message, as the card shows it. */
  sender: string;
  /** The sender's email address, which email focus is learned by (R9); null for Slack. */
  sender_address: string | null;
  /** The subject, or a Slack message's first line. */
  subject: string;
  /** The last few messages as plain text, oldest first. */
  lines: string[];
  newest_message_id: string;
  newest_at: string;
  /** The chat the thread was handed to before; null when it never was. */
  handoff_conversation_id: string | null;
  /** Why the account is not watched now (R22); null while it is connected. */
  disconnected: AccountDisconnectCause | null;
  /**
   * Whether the thread is unread in its service (plan 070, KTD2). For email it is Gmail's own read state, which the
   * card's unread follows, since reading a mail in Gmail keeps its card; a Slack card is always unread until it ends.
   * A paired Mac on a loki older than plan 070 sends no value, which reads as unread, as the mod reads its own records.
   */
  unread_out_there?: boolean;
  /** How directly the newest message is meant for the person (plan 073); absent from an older loki. */
  reach?: OutsideReach | null;
  /** Where a Slack message was posted, as `#channel`; null for a DM and for mail (plan 073). */
  place?: string | null;
  /** The sender's photo: a Slack profile image's address; null for mail (plan 073). */
  sender_avatar?: string | null;
  /** Whether this is the only connected account of its service, so the card need not name it (plan 073). */
  only_account?: boolean;
}

/**
 * How directly a card's newest message is meant for the person (plan 073): a Slack DM or a mail to them, a mention of
 * them, a reply in their thread, a mention of a user group they are in or a mail not addressed to them, @channel or a
 * mailing list, a mail sent by a machine. `core/outside-reach.ts` orders them.
 */
export type OutsideReach = "dm" | "to_you" | "mention" | "thread" | "group" | "not_to_you" | "channel" | "list" | "automated";

/**
 * One of the person's moves on an outside card, for the ledger (plans 069 and 070): read (⌘]), later (⌘[), archive,
 * label, their reply, a hand-off to the owning agent, or an undo of the last of those; how it was made (a key or a
 * click on the Mac, a swipe or a tap on the phone; null when the box's own send made it), and how long the card was on
 * top first, when the app knows. `next` is what ⌘] was called before plan 070, kept so older clients still reach the
 * ledger; clients send `read` now.
 */
export interface OutsideMove {
  action: "read" | "later" | "archive" | "label" | "reply" | "handoff" | "undo" | "next";
  via: "key" | "click" | "swipe" | "tap" | null;
  dwell_ms: number | null;
  /** ISO time the move's rest brings the card back (read and later, and a reply followed by either); null when none. */
  return_at?: string | null;
  /** The Gmail label ids a label move put on; null for every other move. */
  labels?: string[] | null;
  /** Whether the person chose the return time themselves, at the second ⌘[ (R7). */
  picked?: boolean;
  /** For a reply, the key that followed it (R11); null for every other move. */
  after_reply?: ReplyThen | null;
}

/** A move loki writes back to an outside card's service (plan 070, KTD3). */
export type OutsideWrite = "archive" | "read" | "unread" | "label";

/** What one write-back did to one message: the Gmail labels it put on and took off, so an undo takes back just those. */
export interface OutsideMessageChange {
  message_id: string;
  labels_added: string[];
  labels_removed: string[];
}

/**
 * What a write-back changed (plan 070, KTD3), kept by the client so an undo (R14) puts back exactly that. `messages`
 * lists only the messages whose labels changed; a Slack write has none, since Slack has no labels. `ended` says the
 * move ended the card in loki (an archive, or reading a Slack card), and `was_unread` how loki showed the thread before.
 */
export interface OutsideChange {
  move: OutsideWrite;
  messages: OutsideMessageChange[];
  ended: boolean;
  was_unread: boolean;
}

/**
 * The move that follows a reply the person sent from an outside card (plan 070, R11, KTD6): mark the thread read, leave
 * it unread and waiting for an answer (`later`), or archive it.
 */
export type ReplyThen = "read" | "later" | "archive";

/**
 * How a reply went (plan 070, KTD6): it was sent, and the move after it is told apart, so a move that failed can be
 * tried again without sending the reply twice. `then_error` is that move's reason when it failed, and `change` what it
 * wrote, for an undo, or null when it failed or wrote nothing.
 */
export type OutsideReplied = { sent: true; then_error: string | null; change: OutsideChange | null } | { sent: false; undone: true };

/** How a mail reply is addressed (plan 076): to the sender, to everyone on the newest message, or forwarded to no one yet. */
export type MailMode = "reply" | "reply_all" | "forward";

/**
 * What the person chose on a mail card's recipients line (plan 076): the mode, who it goes to, the address it is sent
 * from (null for the one the mail came to), and whether their Gmail signature goes under it. A reply sent without it
 * goes to all, from that address, with the signature, as a reply from before plan 076 did, plus the signature.
 */
export interface MailAddressing {
  mode: MailMode;
  to: string[];
  cc: string[];
  bcc: string[];
  from: string | null;
  signature: boolean;
}

/** One address the person sends from in Gmail (plan 076): the address, the name it shows, and its signature as plain text. */
export interface MailSender {
  address: string;
  name: string;
  signature: string;
}

/** Someone the account has mail with (plan 076), for the recipients line's suggestions: the name they show, if any, and their address. */
export interface MailPerson {
  name: string;
  address: string;
}

/**
 * What a mail card's recipients line starts from (plan 076), read on the Mac the account lives on: who reply and reply
 * all go to, the addresses the person sends from with the default for this thread, the subject, and the people the
 * account has mail with, most often and most lately first.
 */
export interface MailCompose {
  modes: Record<"reply" | "reply_all", { to: string[]; cc: string[] }>;
  from: MailSender[];
  default_from: string;
  subject: string;
  people: MailPerson[];
}

/** One of an account's Gmail labels (plan 070, R12): Gmail's own (`system`, as STARRED) or one the person made (`user`). */
export interface AccountLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

/**
 * One message of an outside card's thread as the card draws it (plan 068): who wrote it, when (ISO, "" when unknown), its
 * text as plain text, and whether the account's own person wrote it.
 */
export interface OutsideMessage {
  /** The message's id in its service (Gmail's id, Slack's ts); unique within its thread. */
  id: string;
  sender: string;
  at: string;
  text: string;
  mine: boolean;
  /**
   * A mail's HTML as its sender wrote it, which the card draws in a frame where no script or form runs; absent for
   * Slack, for mail with only a plain part, and from a Mac on a loki older than this field.
   */
  html?: string;
  /** The sender's Slack photo (plan 074); absent for mail, for a sender with none, and from an older loki. */
  avatar?: string;
  /** A reply under the card's thread's first message, drawn indented as an open thread (plan 074). */
  in_thread?: boolean;
  /** Not yet read by the person in Slack, so the card draws the New line before the first such message (plan 074). */
  unread?: boolean;
  /** How many replies a channel message around the card has in its own thread, which the card does not open. */
  replies?: number;
  /** The channel has more messages after this one than the card shows (plan 074). */
  more_after?: boolean;
  /** A Slack message read the way Slack draws it (plan 075); absent for mail and from an older loki, which draw `text`. */
  body?: SlackBlock[];
  /** What a Slack app attached under its message (plan 075). */
  attachments?: SlackAttachment[];
  /** One of the messages that brought the card into the Inbox (plan 077, R12), drawn with Slack's mention look. */
  brought?: boolean;
  /**
   * New replies in this channel message's own thread (plan 077, R11): how many, or true when there are some but they
   * could not be counted. The card offers to open that thread.
   */
  new_replies?: number | true;
  /** A Slack message's reactions as Slack shows them under it (plan 079), in Slack's order; absent when it has none. */
  reactions?: SlackReaction[];
  /** The files shared in a Slack message (plan 080), shown as chips under it; absent when it has none. */
  slack_files?: SlackFile[];
  /** A mail's To and Cc headers as written (plan 078), for its header line; absent for Slack and from an older loki. */
  to?: string;
  cc?: string;
  /** The files a mail carries, by name and size in bytes (plan 078), shown as chips; absent when it has none. */
  files?: MailFile[];
}

/** A file a mail carries, as its card lists it (plan 078): its name and its size in bytes. */
export interface MailFile {
  name: string;
  size: number;
}

/** An outside card's thread as its account's Mac read it: the messages, and for a Slack card its window (plan 077). */
export interface OutsideRead {
  messages: OutsideMessage[];
  /** Null for mail, and from a Mac on a loki older than plan 077, which reads the whole view at once. */
  window: OutsideWindow | null;
}

/** Which of a Slack card's two views a window is (plan 077, R10): one thread alone, or the channel or DM around it. */
export type SlackCardView = "thread" | "channel";

/**
 * What a Slack card asks for beyond its opening window (plan 077, R3, R11): a view and its thread, and 20 more messages
 * before or after the message `from`. Asking nothing gets what the card opens on.
 */
export interface OutsideWindowAsk {
  view?: SlackCardView;
  /** The thread a thread view shows, by its first message's ts. */
  thread_ts?: string;
  direction?: "before" | "after";
  from?: string;
}

/**
 * The window a Slack card was given (plan 077): its view, the thread it shows, and what more there is on each side,
 * as a count when Slack tells loki, else whether there is any.
 */
export interface OutsideWindow {
  view: SlackCardView;
  thread_ts: string | null;
  more_before: number | boolean;
  more_after: number | boolean;
}

/**
 * A run of a Slack message's words as the card draws it (plan 075): text in its styles, a link with its address, a
 * mention of a person, channel or group, or an emoji, which is the character itself, else the workspace's own image.
 */
export type SlackSpan =
  | { kind: "text"; text: string; bold?: true; italic?: true; strike?: true; code?: true }
  | { kind: "link"; text: string; url: string; bold?: true; italic?: true; strike?: true }
  | { kind: "mention"; text: string }
  | { kind: "emoji"; text: string; image?: string };

/**
 * One emoji reaction on a Slack message (plan 079): Slack's name for it (`eyes`, `+1::skin-tone-2`), how many people
 * reacted with it, whether the person is one of them, and the emoji to draw, a character or the workspace's own image;
 * null when loki does not know the name, so the card shows `:name:`.
 */
export interface SlackReaction {
  name: string;
  count: number;
  mine: boolean;
  emoji: Extract<SlackSpan, { kind: "emoji" }> | null;
}

/** An emoji the person can react with (plan 079): Slack's name for it and how it draws. */
export interface EmojiChoice {
  name: string;
  emoji: Extract<SlackSpan, { kind: "emoji" }>;
}

/** A paragraph of a Slack message (plan 075): ordinary lines, a `>` quote, or a code block. */
export interface SlackBlock {
  kind: "text" | "quote" | "code";
  spans: SlackSpan[];
}

/**
 * What a Slack app attached to a message (plan 075): a lead line above it, a title that may link somewhere, its text
 * and fields, and the bar colour the app chose (`#rrggbb`), all optional as Slack's are.
 */
export interface SlackAttachment {
  pretext?: SlackBlock[];
  title?: SlackSpan[];
  body?: SlackBlock[];
  fields?: Array<{ title: string; value: SlackBlock[] }>;
  color?: string;
}

/**
 * A file shared in a Slack message (plan 080): its title, the kind Slack names it ("PDF", "PNG"), its size in bytes and
 * its page in Slack, each null when Slack gave none, and a picture's thumbnail. A file deleted since, or hidden by the
 * workspace's plan, keeps only that `gone` reason.
 */
export interface SlackFile {
  name: string;
  kind: string | null;
  size: number | null;
  link: string | null;
  gone?: "deleted" | "hidden";
  /**
   * A picture's thumbnail as the card draws it: the name its account's Mac saved it under, served as a message's
   * pictures are (`/chat-images/<name>`, plan 029), and its size in pixels; absent for any other file.
   */
  preview?: { name: string; width: number; height: number };
}

/** The chat a hand-off proposes (plan 067, KTD12): one of the owner's chats, or a new chat with it by this title. */
export type HandoffTarget = { kind: "existing"; conversation_id: string; title: string } | { kind: "new"; title: string };

/**
 * What handing an outside card's thread off proposes (plan 067, R15): the chat loki picked and the owner's other open
 * chats to pick from instead, newest first. `note` says why the chat the thread went to before is not proposed.
 */
export interface HandoffProposal {
  account_id: string;
  thread_id: string;
  owner_agent_id: string;
  proposed: HandoffTarget;
  choices: Array<{ conversation_id: string; title: string }>;
  note: string | null;
}

/**
 * Where a suggestion's message goes (plan 049, R1): an existing chat of any agent, or a new chat of an agent in a
 * folder.
 */
export type SuggestionTarget = { agent_id: string; conversation_id: string } | { agent_id: string; folder: string };

/**
 * Where a suggestion stands: waiting on the person, being sent, or settled by sending it, saving it as a draft,
 * rejecting it, or its agent taking it back.
 */
export type SuggestionStatus = "pending" | "sending" | "sent" | "drafted" | "rejected" | "withdrawn";

/** A message an agent suggests for another chat (plan 049), kept on the chat it was made in until the person acts. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- kept in ChatInfo, a pi-durable document
export type Suggestion = {
  id: string;
  title: string;
  /** The message as it would be sent. */
  text: string;
  target: SuggestionTarget;
  status: SuggestionStatus;
  /** Why an action was refused or failed, shown on the card; absent or null when nothing went wrong. */
  reason?: string | null;
  /** Who settled it and when. */
  decided_by?: string | null;
  decided_at?: string | null;
  created_at: string;
  /** The chat made for a new-chat target, kept once made so a retry never makes a second one. */
  made_conversation_id?: string | null;
};

/**
 * Where a reply proposal stands (plan 067, KTD9): waiting on the person, its draft being written, or settled by a
 * draft written out there, the person rejecting it, or its agent (or a move of the account) taking it back.
 */
export type ReplyProposalStatus = "pending" | "drafting" | "drafted" | "rejected" | "withdrawn";

/**
 * A reply an agent proposes in a thread handed to its chat (plan 067, R18, KTD9), kept on that chat until the person
 * acts. Approved, loki writes it as a draft in the same thread for the person to send; loki never sends it. The
 * people it goes to come from the thread, never from the agent: Gmail's reply-all to the newest message, or Slack's
 * same conversation and thread (`place`).
 */
export interface ReplyProposal {
  id: string;
  account_id: string;
  provider: AccountProvider;
  /** The account as a card names it: the mailbox's address, or the workspace's name. */
  account_label: string;
  thread_id: string;
  /** The thread's subject, or a Slack thread's first line. */
  subject: string;
  /** Gmail: who the draft is addressed to and copied to, as the newest message names them; empty for Slack. */
  to: string[];
  cc: string[];
  /** Slack: where the draft sits, in words ("the DM with Grace", "the thread in #ops"); null for Gmail. */
  place: string | null;
  text: string;
  status: ReplyProposalStatus;
  /** Why an action was refused or failed, shown on the card; null when nothing went wrong. */
  reason: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  /** Where the person finds the draft once written: Gmail's drafts page for it; null for Slack or before. */
  draft_url?: string | null;
}

/**
 * A suggestion saved as a draft (plan 049, KTD7), kept on the chat it is for until that chat sends or the person
 * empties its box: its text, the suggestion it came from, and the chat that suggestion was made in.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- kept in ChatInfo, a pi-durable document
export type SavedDraft = { text: string; suggestion_id: string; source: { agent_id: string; conversation_id: string } };

/** The folders chats have worked in lately (`folders`), for the folder picker. */
export interface RecentFolders {
  /** agentId → folders, most recently used first. */
  by_agent: Partial<Record<string, string[]>>;
  /** conversationDirName → folder, for the desk you are on. */
  by_conversation: Partial<Record<string, string>>;
}

/** Whether a path is a folder a chat can work in, and its git branch (`folder_status`, the answer to folder_check); `reason` says why not when `ok` is false. */
export interface FolderCheck {
  ok: boolean;
  path: string;
  branch: string | null;
  reason?: string;
}

/** The phone listener as Preferences › Phone shows it (mod/lan.ts). */
export interface LanStatus {
  /** The persisted setting. `error` says whether the listener is up when this is true. */
  enabled: boolean;
  /** First non-internal IPv4 (en0 preferred), or null when the machine is off the network. */
  address: string | null;
  /** Every Wi‑Fi/Ethernet address; the tailnet's 100.x address is in `tailscale.ip`, not here. */
  addresses: string[];
  /** The Mac's Bonjour name with `.local`: what the QR and the bookmark carry, because it survives a new address on a new network. */
  host: string | null;
  port: number;
  /** A built canvas was found to serve. */
  app_served: boolean;
  /** A bind error (EADDRINUSE …) or a missing network; null when all is well. */
  error: string | null;
  /** Which route the QR encodes: the tailnet (Addendum 3) or the Wi‑Fi. Persisted when the user chose; else tailscale iff it runs. */
  via: LanVia;
  /** The tailnet's view of the Mac (mod/tailscale.ts); null when the listener was built without Tailscale. */
  tailscale: TailscaleStatus | null;
}

/** Which route the phone's QR code encodes: the tailnet or the Wi-Fi. */
export type LanVia = "tailscale" | "lan";

/** The tailnet's view of the Mac (mod/tailscale.ts). */
export interface TailscaleStatus {
  /** A CLI binary was found. False → say how to install it. */
  installed: boolean;
  /** BackendState === "Running": the Mac is on the tailnet right now. */
  running: boolean;
  /** The 100.x address, or null. */
  ip: string | null;
  /** The MagicDNS name, lower-cased, no trailing dot: `my-macbook-pro.tail1234.ts.net`. */
  name: string | null;
  /** `https://<name>` when `tailscale serve` proxies 443 to the listener; else null. */
  serve_url: string | null;
  /** The CLI's complaint (trimmed, ≤ 400 chars), or null when all is well. */
  error: string | null;
}

/** live: conversation exists. archived: the chat was archived. deleted: bound once, conversation gone. none: never bound (shared, orphan folder). */
export type DeskStatus = "live" | "archived" | "deleted" | "none";

/** What the mod knows of the conversation behind a desk: its title, status, agent and model, as the `desk` frame carries them. */
export interface DeskInfo {
  title: string | null;
  status: DeskStatus;
  /** Which agent owns the conversation behind this desk. */
  agent_name: string | null;
  agent_id: string | null;
  /** The model this conversation runs on: its own override, else the agent's. */
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  /** The permission mode the daemon keeps for this conversation (default: unrestricted). */
  mode?: string | null;
  /** The person's labels on the chat (plan 022); absent from a mod that predates them. */
  labels?: string[];
  /** The person's one line on what the chat is for (plan 049); null when none, absent from a mod that predates it. */
  purpose?: string | null;
  /** A suggestion saved as a draft waits in the chat's message box (plan 049). */
  has_draft?: boolean;
  /** The folder the chat works in; null when it has none of its own. */
  cwd?: string | null;
}

/** One desk in the `desks` list: its conversation's details, its scope, how many widgets it holds, and when it was last active. */
export interface DeskSummary extends DeskInfo, ChatHome {
  scope: Scope;
  conversation_id: string | null;
  /** Pinned in loki's pins file (mod/pins.ts). */
  pinned?: boolean;
  widgets: number;
  active: boolean;
  last_active: string | null;
}

/** A paired phone as the canvas sees it: never its token hash (mod/devices.ts DeviceRecord adds that). */
export interface DeviceSummary {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  /** Which route the phone's last request came in by (mod/lan.ts requestVia); absent for a phone not seen since this field existed. */
  last_via?: DeviceVia;
}

/** Another device on the tailnet, as `tailscale status` lists it (plan 023): a candidate to pair a Mac with. */
export interface TailnetDevice {
  /** Its name on the tailnet (the device's host name). */
  name: string;
  /** Its MagicDNS name, lower-cased, no trailing dot: what another Mac types to reach it. */
  address: string;
  /** "macOS", "iOS", "linux", "windows" … as Tailscale says. */
  os: string;
  online: boolean;
}

/** A Mac as loki names it (plan 023): its install id (`state/device-id`) and the Mac's own name. */
export interface MacIdentity {
  mac_id: string;
  name: string;
}

/** Another Mac paired with this one, as Preferences › Macs shows it: never the token it holds (mod/peers.ts PeerRecord adds that). */
export interface PeerSummary extends MacIdentity {
  /** Where this Mac reaches it: its tailnet name and port, as the person typed it or it sent when pairing. */
  host: string;
  paired_at: string;
  last_seen_at: string;
  /** Its loki build when last heard from, or null. */
  build: string | null;
  /** True when it speaks another peer protocol than this Mac: paired, but nothing syncs until one of them updates. */
  outdated: boolean;
  /** True while this Mac's peer link to it is open and speaking the same protocol (plan 023, U2). */
  reachable: boolean;
}

/** One MCP tool as Settings shows it (daemon/mcp/): its hints, whether it skips search, and its definition's cost. */
export interface McpToolView {
  name: string;
  description: string;
  read_only: boolean;
  destructive: boolean;
  always_load: boolean;
  /** About how many tokens its definition costs when loaded (name, description and schema, four characters a token). */
  tokens: number;
}

/** One MCP server as Settings shows and edits it. Secrets show as the `${keychain:…}` names the file holds. */
export interface McpServerView {
  /** Safe for tool names (`mcp__<name>__…`). */
  name: string;
  /** The key as written in mcp.json, which edits name. */
  entry: string;
  kind: "local" | "remote";
  /** `signin`: a remote server waiting for an OAuth sign-in (`signIn.url`). */
  state: "starting" | "connected" | "down" | "signin";
  /** A remote server that signs in with OAuth (one with no Authorization header of its own); null for any other. */
  sign_in: { url: string | null; signed_in: boolean } | null;
  error: string | null;
  purpose: string | null;
  tools: McpToolView[];
  /** About how many tokens loading every tool would cost. */
  tokens: number;
  config: { command: string; args: string[]; env: Record<string, string>; cwd: string | null } | { url: string; headers: Record<string, string> };
  /** The agents it is switched off for. */
  off_for: string[];
}

/**
 * One ACP agent as Preferences › Engines shows it (plan 020, R10): how loki starts it, and how it stands. `ready`: a
 * message went through; `started`: it starts, and sign-in shows on the first message; `not_found`: its command is
 * not on loki's PATH; `signed_out`: it said it needs signing in; `failed`: it failed for another reason; `unknown`:
 * not tried yet.
 */
export interface EngineView {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Claude Code, which loki ships; `changed` when the person's file overrides how it starts. */
  builtin: boolean;
  changed: boolean;
  status: "ready" | "started" | "not_found" | "signed_out" | "failed" | "unknown";
  detail: string | null;
}

/** Preferences › Engines: the ACP agents and the file the person's own are kept in. */
export interface EnginesView {
  engines: EngineView[];
  config_path: string;
}

/** The MCP servers Settings shows (`chat_mcp`), with the problems found reading mcp.json and where that file is. */
export interface McpView {
  servers: McpServerView[];
  /** Entries in mcp.json that could not be read, one line each. */
  problems: string[];
  config_path: string;
}

/** The services an Inbox account connects (plan 067): a Gmail mailbox or a Slack workspace. */
export type AccountProvider = "gmail" | "slack";
/**
 * Why an account stopped working, as an id the app turns into words and a way back (plan 067, R22): Google wants a new
 * sign-in, a workspace admin blocks the app, the Slack desktop app signed out, or the service keeps failing for now.
 */
export type AccountDisconnectCause = "sign_in_again" | "admin_blocks" | "slack_signed_out" | "temporarily_failing";
/** Whether an account is watched: connected, or disconnected with its cause. */
export type AccountStatus = "connected" | { disconnected: AccountDisconnectCause };

/**
 * One connected account as the app sees it (plan 067, KTD2): which service, the address it shows (an email address, or
 * a Slack workspace's name), and the one agent that owns it. It never carries a token.
 */
export interface AccountView {
  /** The provider and its stable id: `gmail:<address>` or `slack:<team_id>:<user_id>` (mod/accounts.ts accountIdOf). */
  account_id: string;
  provider: AccountProvider;
  address: string;
  owner_agent_id: string;
  status: AccountStatus;
  connected_at: string;
}

/** A workspace signed in to the Slack desktop app on this Mac, as the person picks one to connect (plan 067, R21). */
export interface SlackWorkspaceView {
  team_id: string;
  team_name: string;
  /** The workspace's address, `https://<domain>.slack.com/`. */
  url: string;
  /** The person in that workspace, when the desktop app records it. */
  user_id: string | null;
}
