import { Type } from "typebox";
import { HANDOFF_WAIT_MS } from "../frame-client.ts";
import type { MailAddressing, MailMode, OutsideMove, OutsideWindowAsk, ReplyThen } from "../frame-types.ts";
import {
  EmojiNameSchema,
  NonEmptyStr,
  OutboxIdSchema,
  ThreadTsSchema,
  addressLike,
  allStrings,
  compiledCheck,
  isAgentId,
  isNum,
  nothing,
  parseOutsideChange,
  replyMentionOf,
  str,
  strOr,
  threadRef,
  type Raw,
} from "./primitives.ts";
import { BY_HOME, PHONE, SENDS_REPLY, push, request } from "./types.ts";

const OUTSIDE_MOVES: ReadonlyArray<OutsideMove["action"]> = ["read", "later", "archive", "label", "reply", "handoff", "undo", "next"];
const MOVE_VIAS: ReadonlyArray<NonNullable<OutsideMove["via"]>> = ["key", "click", "swipe", "tap"];
const REPLY_THENS: readonly ReplyThen[] = ["read", "later", "archive"];
const SEND_THENS: readonly ReplyThen[] = [...REPLY_THENS, "stay"];
const MAIL_MODES: readonly MailMode[] = ["reply", "reply_all", "forward"];
const MAX_RECIPIENTS = 100;

const OwnAppSchema = Type.Object({ client_id: Type.String(), client_secret: Type.String() });

const checkNonEmpty = compiledCheck(NonEmptyStr);
const checkOutboxId = compiledCheck(OutboxIdSchema);
const checkThreadTs = compiledCheck(ThreadTsSchema);
const checkEmojiName = compiledCheck(EmojiNameSchema);
const checkOwnApp = compiledCheck(OwnAppSchema);

function parseMailAddressing(v: unknown): MailAddressing | null | string {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return "mail must be an object";
  const m = v as Raw;
  const mode = MAIL_MODES.find((x) => x === m.mode);
  if (!mode) return "mail.mode must be reply, reply_all or forward";
  const lists: Record<"to" | "cc" | "bcc", string[]> = { to: [], cc: [], bcc: [] };
  for (const k of ["to", "cc", "bcc"] as const) {
    const l = m[k] ?? [];
    if (!Array.isArray(l) || !l.every(addressLike)) return `mail.${k} must be a list of addresses`;
    lists[k] = l;
  }
  if (lists.to.length + lists.cc.length + lists.bcc.length > MAX_RECIPIENTS) return "that reply goes to too many people";
  if (m.from !== undefined && m.from !== null && !addressLike(m.from)) return "mail.from must be an address";
  return { mode, ...lists, from: addressLike(m.from) ? m.from : null, signature: m.signature !== false };
}

export const accountsFrames = {
  account_list: request("accounts", "the accounts connected on this Mac and the agent that owns each", nothing),
  account_move: request("accounts", "give an account to another agent, which gets its hand-offs and its tools from now on", (m: Raw) =>
    checkNonEmpty(m.account_id) && isAgentId(m.owner_agent_id)
      ? { account_id: m.account_id, owner_agent_id: m.owner_agent_id }
      : "account_id and owner_agent_id required",
  ),
  account_disconnect: request("accounts", "disconnect an account: loki forgets it and its sign-in", (m: Raw) =>
    checkNonEmpty(m.account_id) ? { account_id: m.account_id } : "account_id required",
  ),
  account_thread_archive: request(
    "account_thread_archived",
    "archive an outside card: the thread is archived in Gmail or marked read in Slack, then leaves the Flow (plan 067, R12); sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.thread_id)
        ? { account_id: m.account_id, thread_id: m.thread_id, home: strOr(m.home, null) }
        : "account_id and thread_id required",
    PHONE,
    { route: "home", relists: true },
  ),
  account_thread_mark_read: request(
    "account_thread_changed",
    "mark an outside card read: in Gmail up to the card's newest message, and the card stays; in Slack the DM is marked read and the card ends (plan 070, R5); sent to the Mac the account lives on by `home`",
    threadRef,
    PHONE,
    { route: "home", relists: true },
  ),
  account_thread_mark_unread: request(
    "account_thread_changed",
    "leave an outside card unread: in Gmail its newest incoming message is marked unread; Slack is left as it is (plan 070, R6); sent to the Mac the account lives on by `home`",
    threadRef,
    PHONE,
    { route: "home", relists: true },
  ),
  account_thread_label: request(
    "account_thread_changed",
    "put Gmail labels, by id, on an outside card's thread; the card stays (plan 070, R12); sent to the Mac the account lives on by `home`",
    (m: Raw) => {
      const ref = threadRef(m);
      if (typeof ref === "string") return ref;
      return allStrings(m.labels) && m.labels.length > 0 && m.labels.every(Boolean) ? { ...ref, labels: m.labels } : "labels required: one label id or more";
    },
    PHONE,
    BY_HOME,
  ),
  account_thread_restore: request(
    "account_thread_changed",
    "undo a move on an outside card: put back what `change`, as a write-back frame answered it, changed out there, and the card as it was (plan 070, R14); sent to the Mac the account lives on by `home`",
    (m: Raw) => {
      const ref = threadRef(m);
      if (typeof ref === "string") return ref;
      const change = parseOutsideChange(m.change);
      return change ? { ...ref, change } : "change required, as a write-back answered it";
    },
    PHONE,
    { route: "home", relists: true },
  ),
  account_labels_list: request(
    "account_labels",
    "an account's Gmail labels, for the label picker (plan 070, R12); sent to the Mac the account lives on by `home`",
    (m: Raw) => (checkNonEmpty(m.account_id) ? { account_id: m.account_id, home: strOr(m.home, null) } : "account_id required"),
    PHONE,
    BY_HOME,
  ),
  account_thread_read: request(
    "account_thread",
    "an outside card's thread, every message with its sender and time, read from its account (plan 068); a Slack card's window around what is new, or with `direction` and `from` 20 more messages before or after one (after one with `shown_from`, the shown messages again too, for their reactions), and with `view` and `thread_ts` one thread alone (plan 077); a Jira card's comments and field changes the same way, or with `ticket` its comments alone and, with its opening window, the ticket's fields, description and what changed since it was read (plan 089); sent to the Mac the account lives on by `home`",
    (m: Raw) => {
      if (!checkNonEmpty(m.account_id) || !checkNonEmpty(m.thread_id)) return "account_id and thread_id required";
      const ask: OutsideWindowAsk = {};
      if (m.view === "thread" || m.view === "channel") ask.view = m.view;
      else if (m.view !== undefined) return "view must be thread or channel";
      if (checkNonEmpty(m.thread_ts)) ask.thread_ts = m.thread_ts;
      if (m.direction === "before" || m.direction === "after") ask.direction = m.direction;
      else if (m.direction !== undefined) return "direction must be before or after";
      if (checkNonEmpty(m.from)) ask.from = m.from;
      if (ask.direction && !ask.from) return "from required with direction";
      if (ask.direction === "after" && checkNonEmpty(m.shown_from)) ask.shown_from = m.shown_from;
      if (m.ticket === true) ask.ticket = true;
      return { account_id: m.account_id, thread_id: m.thread_id, home: strOr(m.home, null), ...ask };
    },
    PHONE,
    { ...BY_HOME, timeout_ms: 30_000 },
  ),
  account_thread_reply: request(
    "account_thread_replied",
    "send the person's own reply in an outside card's thread (plan 068), then make the key's move: `then` marks it read, leaves it unread and waiting for an answer (`later`), or archives it (plan 070, R11), which is also what a reply without `then` does, or makes none (`stay`, plan 083); a Slack reply with `thread_ts` goes into that thread of the card's conversation, the one the person opened (plan 085), and its `mentions` are the people picked in the box, whose `@Full Name` still in the text become Slack's mentions (plan 2026-11-14-1530); the answer tells the send and the move apart; only the person's devices send this, and no agent tool reaches it; sent to the Mac the account lives on by `home`",
    (m: Raw) => {
      if (!checkNonEmpty(m.account_id) || !checkNonEmpty(m.thread_id) || !str(m.text) || !m.text.trim()) return "account_id, thread_id and text required";
      const then = m.then === undefined ? "archive" : SEND_THENS.find((t) => t === m.then);
      if (!then) return "then must be read, later, archive or stay";
      const mail = parseMailAddressing(m.mail);
      if (typeof mail === "string") return mail;
      if (m.outbox_id !== undefined && !checkOutboxId(m.outbox_id)) return "outbox_id must be a short id";
      if (m.thread_ts !== undefined && !checkThreadTs(m.thread_ts)) return "thread_ts must be a Slack message time";
      if (m.mentions !== undefined && m.mentions !== null && !(Array.isArray(m.mentions) && m.mentions.every((x: unknown) => replyMentionOf(x) !== null)))
        return "mentions must be a list of people, each with a display name and an id or address";
      return {
        account_id: m.account_id,
        thread_id: m.thread_id,
        text: m.text,
        then,
        mail,
        outbox_id: str(m.outbox_id) ? m.outbox_id : null,
        thread_ts: str(m.thread_ts) ? m.thread_ts : null,
        mentions: Array.isArray(m.mentions) ? m.mentions.flatMap((x: unknown) => replyMentionOf(x) ?? []) : [],
        home: strOr(m.home, null),
      };
    },
    PHONE,
    SENDS_REPLY,
  ),
  account_thread_compose: request(
    "account_compose",
    "what a mail card's recipients line starts from (plan 076): who reply and reply all go to, the addresses the person sends from and their signatures, the subject, the message a reply quotes, and the people the account has mail with; sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.thread_id)
        ? { account_id: m.account_id, thread_id: m.thread_id, home: strOr(m.home, null) }
        : "account_id and thread_id required",
    PHONE,
    { ...BY_HOME, timeout_ms: 30_000 },
  ),
  account_thread_react: request(
    "account_thread_reacted",
    "add the person's emoji reaction to a message on a Slack card, or take it back with `on: false` (plan 079), or send a Gmail reaction to a mail on a mail card, which can't be taken back (plan 2026-11-23-1800); `name` is Slack's name for the emoji; only the person's devices send this, and no agent tool reaches it; sent to the Mac the account lives on by `home`",
    (m: Raw) => {
      if (!checkNonEmpty(m.account_id) || !checkNonEmpty(m.thread_id) || !checkNonEmpty(m.message_id)) return "account_id, thread_id and message_id required";
      if (!checkEmojiName(m.name)) return "name must be an emoji name";
      if (typeof m.on !== "boolean") return "on must be true or false";
      return { account_id: m.account_id, thread_id: m.thread_id, message_id: m.message_id, name: m.name, on: m.on, home: strOr(m.home, null) };
    },
    PHONE,
    { ...BY_HOME, timeout_ms: 30_000 },
  ),
  account_emoji_search: request(
    "account_emoji",
    "the emoji an account can react with whose names hold `query` (plan 079), best matches first: a Slack workspace's own included, standard emoji only for mail; sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && str(m.query) && m.query.length <= 100
        ? { account_id: m.account_id, query: m.query, home: strOr(m.home, null) }
        : "account_id and query required",
    PHONE,
    BY_HOME,
  ),
  account_people_search: request(
    "account_people",
    "the people in a Slack account's workspace whose handle or name holds `query` (plan 082), best matches first, for the reply box's @ suggestions; sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && str(m.query) && m.query.length <= 100
        ? { account_id: m.account_id, query: m.query, home: strOr(m.home, null) }
        : "account_id and query required",
    PHONE,
    BY_HOME,
  ),
  account_thread_unsend: request(
    "account_thread_unsent",
    "stop a held mail reply before it goes (plan 076), by the `outbox_id` its reply frame carried; the reply frame then answers that it was undone; sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.outbox_id)
        ? { account_id: m.account_id, outbox_id: m.outbox_id, home: strOr(m.home, null) }
        : "account_id and outbox_id required",
    PHONE,
    BY_HOME,
  ),
  account_thread_resend: request(
    "account_thread_replied",
    "send again a mail reply of the person's that did not go (plan 096), by its `outbox_id`: its thread is read for it first and it is sent only when it is not there, then the key's move it was sent with; the person's devices alone send this; sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.thread_id) && checkOutboxId(m.outbox_id)
        ? { account_id: m.account_id, thread_id: m.thread_id, outbox_id: m.outbox_id, home: strOr(m.home, null) }
        : "account_id, thread_id and outbox_id required",
    PHONE,
    SENDS_REPLY,
  ),
  account_thread_discard: request(
    "account_thread_discarded",
    "let go of a mail reply of the person's that did not go (plan 096), by its `outbox_id`, so its card stops saying it was not sent; sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.outbox_id)
        ? { account_id: m.account_id, outbox_id: m.outbox_id, home: strOr(m.home, null) }
        : "account_id and outbox_id required",
    PHONE,
    BY_HOME,
  ),
  account_thread_move: request(
    "account_move_kept",
    "one of the person's moves on an outside card (read, later, archive, label, their reply, a hand-off, an undo), with its return time, labels, pick and the key after a reply, kept in the ledger of the Mac the account lives on so its preferences can be learned (plans 069 and 070); sent there by `home`",
    (m: Raw) => {
      if (!checkNonEmpty(m.account_id) || !checkNonEmpty(m.thread_id)) return "account_id and thread_id required";
      const action = OUTSIDE_MOVES.find((a) => a === m.action);
      if (!action) return "action must be read, later, archive, label, reply, handoff, undo or next";
      const via = MOVE_VIAS.find((v) => v === m.via) ?? null;
      const dwell = isNum(m.dwell_ms) && m.dwell_ms >= 0 ? Math.round(m.dwell_ms) : null;
      const move: OutsideMove = {
        action,
        via,
        dwell_ms: dwell,
        return_at: str(m.return_at) && !Number.isNaN(Date.parse(m.return_at)) ? m.return_at : null,
        labels: allStrings(m.labels) ? m.labels : null,
        picked: m.picked === true,
        after_reply: REPLY_THENS.find((t) => t === m.after_reply) ?? null,
      };
      return { account_id: m.account_id, thread_id: m.thread_id, ...move, home: strOr(m.home, null) };
    },
    PHONE,
    BY_HOME,
  ),
  account_thread_handoff_propose: request(
    "account_thread_handoff_proposal",
    "what handing an outside card's thread to its account's agent proposes: the chat it went to before, else a new chat, and the agent's other chats (plan 067, KTD12); sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.thread_id)
        ? { account_id: m.account_id, thread_id: m.thread_id, home: strOr(m.home, null) }
        : "account_id and thread_id required",
    PHONE,
    BY_HOME,
  ),
  account_thread_handoff: request(
    "account_thread_handed_off",
    "hand an outside card's thread to its account's agent: to `conversation_id`, one of its chats, else to a new chat; the whole thread goes there and the card leaves (plan 067, R15, R16); sent to the Mac the account lives on by `home`",
    (m: Raw) =>
      checkNonEmpty(m.account_id) && checkNonEmpty(m.thread_id)
        ? {
            account_id: m.account_id,
            thread_id: m.thread_id,
            conversation_id: checkNonEmpty(m.conversation_id) ? m.conversation_id : null,
            home: strOr(m.home, null),
          }
        : "account_id and thread_id required",
    PHONE,
    { route: "home", relists: true, timeout_ms: HANDOFF_WAIT_MS },
  ),
  account_connect_gmail: request(
    "account_signin",
    "start connecting a Gmail account the given agent will own: Google's page to open, with the person's own Google app when `own_app` names one; with `account_id`, sign that account in again, for more Google services or fresh tokens",
    (m: Raw) => {
      if (!isAgentId(m.owner_agent_id)) return "owner_agent_id required";
      const accountId = checkNonEmpty(m.account_id) ? m.account_id : null;
      if (m.own_app === undefined || m.own_app === null) return { owner_agent_id: m.owner_agent_id, own_app: null, account_id: accountId };
      return checkOwnApp(m.own_app)
        ? { owner_agent_id: m.owner_agent_id, own_app: { client_id: m.own_app.client_id, client_secret: m.own_app.client_secret }, account_id: accountId }
        : "own_app needs client_id and client_secret";
    },
  ),
  account_connect_slack: request(
    "slack_workspaces",
    "the workspaces signed in to the Slack desktop app on this Mac; with `team_id`, connect that workspace for the given agent, or connect it again after it signed out",
    (m: Raw) =>
      isAgentId(m.owner_agent_id) ? { owner_agent_id: m.owner_agent_id, team_id: checkNonEmpty(m.team_id) ? m.team_id : null } : "owner_agent_id required",
  ),
  account_connect_jira: request(
    "accounts",
    "connect a Jira Cloud site the given agent will own, with its address, the person's Atlassian email and an API token, which Jira checks before anything is kept (plan 2026-11-10-1451, R1, R5); with `account_id`, connect that site again with a new token",
    (m: Raw) => {
      if (!isAgentId(m.owner_agent_id)) return "owner_agent_id required";
      const [site, email, token] = [m.site, m.email, m.token].map((v) => (str(v) ? v.trim() : ""));
      if (!site || !email || !token) return "site, email and token required";
      return { owner_agent_id: m.owner_agent_id, site, email, token, account_id: checkNonEmpty(m.account_id) ? m.account_id : null };
    },
  ),

  accounts_changed: push("an account on this Mac was connected, moved, disconnected or changed status; sent to paired Macs too (plan 067)"),
} as const;
