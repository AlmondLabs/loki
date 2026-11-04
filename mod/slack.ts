// The way calls are made with a desktop session (form-encoded POSTs to the workspace's own address, carrying the token
// and the `d` cookie) and the drafts endpoints' shape are ported from agent-slack
// (https://github.com/stablyai/agent-slack, src/slack/client.ts and src/slack/drafts.ts):
//
// MIT License. Copyright (c) 2026 Stably. Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
// conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

import { randomUUID } from "node:crypto";
import type { AccountStatus } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { log } from "./log.ts";
import type { SlackSession } from "./slack-session.ts";

/**
 * A thin Slack client over fetch for one connected workspace (plan 067, U6, KTD4), calling as the person through the
 * desktop app's session. It reads, lists activity and counts, marks a DM read and writes drafts, and nothing more: no
 * call that sends, edits or schedules a message exists here, so "agents never send" (R18) holds by construction: every
 * request names one of SLACK_METHODS, and the type allows no other.
 *
 * Slack refusing the session gets one fresh read of the desktop app's session; when that is refused too, the account
 * says "Slack signed out" (R22). A rate limit holds calls back for as long as Slack asks and never counts as a sign-out.
 */

/** Every Slack method this client calls, and the only ones a request can name. */
export const SLACK_METHODS = [
  "auth.test",
  "client.counts",
  "activity.feed",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "users.info",
  "conversations.mark",
  "drafts.list",
  "drafts.create",
] as const;

/** One of the methods this client may call. */
export type SlackMethod = (typeof SLACK_METHODS)[number];

/** The errors Slack gives when the session is no good: signed out, revoked or expired. */
const AUTH_ERRORS = ["invalid_auth", "not_authed", "token_revoked", "token_expired"];
/** How long to hold back after a rate limit that names no wait. */
const DEFAULT_RETRY_MS = 60_000;
const TIMEOUT_MS = 20_000;

/** A Slack call that failed, with Slack's error code (`invalid_auth`, `ratelimited`, `channel_not_found`, `http_500` …). */
export class SlackError extends Error {
  readonly code: string;
  /** For `ratelimited`: how long Slack asked to wait. */
  readonly retryAfterMs: number | null;

  constructor(message: string, code: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "SlackError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** What SlackClient is built from; fetch, the clock and the session are injected so tests own them. */
export interface SlackClientOptions {
  /** The workspace's session, from memory, or read afresh from the desktop app when `fresh`; null when it is signed out there. */
  session: (fresh: boolean) => Promise<SlackSession | null>;
  /** Tell the account its status changed: here only ever to `{ disconnected: "slack_signed_out" }`. */
  setStatus: (status: AccountStatus) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** The person's identity in the workspace, as auth.test reports it. */
export interface SlackIdentity {
  team_id: string;
  team: string;
  user_id: string;
  user: string;
  url: string;
}

/** One conversation's unread state from client.counts. */
export interface SlackCount {
  id: string;
  has_unreads: boolean;
  mention_count: number;
  latest: string | null;
  last_read: string | null;
}

/** What client.counts reports: DMs, group DMs and channels, and threads as a whole. */
export interface SlackCounts {
  ims: SlackCount[];
  mpims: SlackCount[];
  channels: SlackCount[];
  threads: { has_unreads: boolean; mention_count: number };
}

/** The Activity item kinds a card may come from (Key Decision "Slack decides what is addressed to the person"). */
export const SLACK_ACTIVITY_TYPES = ["at_user", "at_user_group", "at_channel", "at_everyone", "thread_v2"] as const;

/** One Activity item: its kind, whether it is unread, and where it points; `item` keeps Slack's own shape for kinds not parsed here. */
export interface SlackActivityItem {
  key: string;
  feed_ts: string;
  is_unread: boolean;
  type: string;
  /** The conversation and message it points at, when Slack says (mentions: `item.message`; thread replies: `item.bundle_info.payload.thread_entry`). */
  channel: string | null;
  ts: string | null;
  thread_ts: string | null;
  author_user_id: string | null;
  item: Record<string, unknown>;
}

/** One page of the Activity feed, newest first, and where the next page starts. */
export interface SlackActivityPage {
  items: SlackActivityItem[];
  next_cursor: string | null;
}

/** A message as Slack returns it, with the fields loki reads; `raw` keeps the rest. */
export interface SlackMessage {
  ts: string;
  user: string | null;
  bot_id: string | null;
  text: string;
  thread_ts: string | null;
  subtype: string | null;
  reply_count: number;
  raw: Record<string, unknown>;
}

/** A page of messages and where the next one starts. */
export interface SlackMessagePage {
  messages: SlackMessage[];
  has_more: boolean;
  next_cursor: string | null;
}

/** A conversation: what kind it is, and for a DM, the person on the other side. */
export interface SlackConversation {
  id: string;
  name: string | null;
  is_im: boolean;
  is_mpim: boolean;
  is_channel: boolean;
  is_private: boolean;
  user: string | null;
  last_read: string | null;
}

/** A person in the workspace, by the names Slack shows. */
export interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  is_bot: boolean;
}

/** A draft as drafts.list returns it, with its text read out of its blocks. */
export interface SlackDraft {
  id: string;
  text: string;
  destinations: Array<{ channel_id: string; thread_ts: string | null }>;
  last_updated_ts: string | null;
  date_created: number | null;
}

/** A reply to keep as a draft in one conversation, in a thread when `thread_ts` is given; the person sends it from Slack. */
export interface SlackDraftInput {
  channel: string;
  thread_ts?: string;
  text: string;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

const parseCount = (v: unknown): SlackCount => {
  const r = rec(v);
  return {
    id: str(r.id),
    has_unreads: r.has_unreads === true,
    mention_count: num(r.mention_count),
    latest: strOrNull(r.latest),
    last_read: strOrNull(r.last_read),
  };
};

function parseActivity(v: unknown): SlackActivityItem {
  const r = rec(v);
  const item = rec(r.item);
  const message = rec(item.message);
  const thread = rec(rec(rec(item.bundle_info).payload).thread_entry);
  return {
    key: str(r.key),
    feed_ts: str(r.feed_ts),
    is_unread: r.is_unread === true,
    type: str(item.type),
    channel: strOrNull(message.channel) ?? strOrNull(thread.channel_id),
    ts: strOrNull(message.ts) ?? strOrNull(thread.latest_ts),
    thread_ts: strOrNull(message.thread_ts) ?? strOrNull(thread.thread_ts),
    author_user_id: strOrNull(message.author_user_id),
    item,
  };
}

function parseMessage(v: unknown): SlackMessage {
  const r = rec(v);
  return {
    ts: str(r.ts),
    user: strOrNull(r.user),
    bot_id: strOrNull(r.bot_id),
    text: str(r.text),
    thread_ts: strOrNull(r.thread_ts),
    subtype: strOrNull(r.subtype),
    reply_count: num(r.reply_count),
    raw: r,
  };
}

const parsePage = (r: Record<string, unknown>): SlackMessagePage => ({
  messages: list(r.messages).map(parseMessage),
  has_more: r.has_more === true,
  next_cursor: strOrNull(rec(r.response_metadata).next_cursor),
});

/** The text of rich_text blocks: their text, links, mentions and emoji, section by section. */
function blocksText(blocks: unknown): string {
  const out: string[] = [];
  const walk = (el: unknown): string => {
    const e = rec(el);
    if (e.type === "text") return str(e.text);
    if (e.type === "link") return str(e.text) || str(e.url);
    if (e.type === "user") return `<@${str(e.user_id)}>`;
    if (e.type === "channel") return `<#${str(e.channel_id)}>`;
    if (e.type === "emoji") return `:${str(e.name)}:`;
    return list(e.elements).map(walk).join("");
  };
  for (const b of list(blocks)) for (const section of list(rec(b).elements)) out.push(walk(section));
  return out.join("\n").trim();
}

function parseDraft(v: unknown): SlackDraft {
  const r = rec(v);
  return {
    id: str(r.id),
    text: blocksText(r.blocks),
    destinations: list(r.destinations).map((d) => ({ channel_id: str(rec(d).channel_id), thread_ts: strOrNull(rec(d).thread_ts) })),
    last_updated_ts: strOrNull(r.last_updated_ts),
    date_created: typeof r.date_created === "number" ? r.date_created : null,
  };
}

/** Where a workspace's calls go: its own address when that is on slack.com, else slack.com itself, so a token never leaves Slack. */
function apiBase(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"))) return `https://${u.hostname}/api/`;
  } catch {
    // An address that does not parse falls back to slack.com below.
  }
  return "https://slack.com/api/";
}

/** One connected Slack workspace's calls. */
export class SlackClient {
  private readonly opts: SlackClientOptions;
  private current: SlackSession | null = null;
  /** Until when Slack asked for no calls (a rate limit), in ms since the epoch. */
  private holdUntil = 0;

  constructor(opts: SlackClientOptions) {
    this.opts = opts;
  }

  /** Who the session is: the workspace and the person, which connecting checks before keeping the account. */
  async authTest(): Promise<SlackIdentity> {
    const r = await this.call("auth.test", {});
    return { team_id: str(r.team_id), team: str(r.team), user_id: str(r.user_id), user: str(r.user), url: str(r.url) };
  }

  /** Unread state of every DM, group DM and channel, and of threads as a whole. */
  async clientCounts(): Promise<SlackCounts> {
    const r = await this.call("client.counts", { thread_count_by_channel: true });
    const threads = rec(r.threads);
    return {
      ims: list(r.ims).map(parseCount),
      mpims: list(r.mpims).map(parseCount),
      channels: list(r.channels).map(parseCount),
      threads: { has_unreads: threads.has_unreads === true, mention_count: num(threads.mention_count) },
    };
  }

  /** One page of the Activity feed, newest first, of the given kinds (default every kind a card may come from). */
  async activityFeed(opts: { unreadOnly: boolean; types?: readonly string[]; cursor?: string; limit?: number }): Promise<SlackActivityPage> {
    const r = await this.call("activity.feed", {
      types: (opts.types ?? SLACK_ACTIVITY_TYPES).join(","),
      mode: "chrono_reads_and_unreads",
      unread_only: opts.unreadOnly,
      archive_only: false,
      priority_only: false,
      limit: opts.limit ?? 50,
      cursor: opts.cursor,
    });
    return { items: list(r.items).map(parseActivity), next_cursor: strOrNull(rec(r.response_metadata).next_cursor) };
  }

  /** A conversation's messages, newest first, between `oldest` and `latest` when given. */
  async conversationsHistory(opts: {
    channel: string;
    oldest?: string;
    latest?: string;
    inclusive?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<SlackMessagePage> {
    return parsePage(await this.call("conversations.history", { ...opts }));
  }

  /** A thread's messages, its parent first. */
  async conversationsReplies(opts: { channel: string; ts: string; oldest?: string; limit?: number; cursor?: string }): Promise<SlackMessagePage> {
    return parsePage(await this.call("conversations.replies", { ...opts }));
  }

  /** What kind of conversation a channel id is, and for a DM, with whom. */
  async conversationsInfo(channel: string): Promise<SlackConversation> {
    const c = rec((await this.call("conversations.info", { channel })).channel);
    return {
      id: str(c.id) || channel,
      name: strOrNull(c.name),
      is_im: c.is_im === true,
      is_mpim: c.is_mpim === true,
      is_channel: c.is_channel === true,
      is_private: c.is_private === true,
      user: strOrNull(c.user),
      last_read: strOrNull(c.last_read),
    };
  }

  /** A person in the workspace. */
  async usersInfo(user: string): Promise<SlackUser> {
    const u = rec((await this.call("users.info", { user })).user);
    const profile = rec(u.profile);
    return {
      id: str(u.id) || user,
      name: str(u.name),
      real_name: str(u.real_name) || str(profile.real_name),
      display_name: str(profile.display_name),
      is_bot: u.is_bot === true,
    };
  }

  /**
   * Mark a DM or group DM read up to `ts`, as archiving its card does (R12). Any other conversation is refused before
   * anything is marked: a channel's read marker never moves, since that would hide messages the person has not seen (R13).
   */
  async markDm(channel: string, ts: string): Promise<void> {
    const info = await this.conversationsInfo(channel);
    if (!info.is_im && !info.is_mpim) throw new SlackError(`${channel} is not a DM or group DM: loki marks only those read`, "not_a_dm");
    await this.call("conversations.mark", { channel, ts });
  }

  /** The person's drafts, active ones unless told otherwise. */
  async draftsList(opts: { activeOnly?: boolean } = {}): Promise<SlackDraft[]> {
    const r = await this.call("drafts.list", { is_active: opts.activeOnly === false ? undefined : true });
    return list(r.drafts).map(parseDraft);
  }

  /** Keep a reply as a draft where the person will find it in Slack; loki never sends it. */
  async draftsCreate(input: SlackDraftInput): Promise<SlackDraft> {
    const destination = input.thread_ts ? { channel_id: input.channel, thread_ts: input.thread_ts, broadcast: false } : { channel_id: input.channel };
    const r = await this.call("drafts.create", {
      blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: input.text }] }] }],
      destinations: [destination],
      client_msg_id: randomUUID(),
      file_ids: [],
      is_from_composer: true,
    });
    return parseDraft(r.draft);
  }

  // --- the session and requests ------------------------------------------------------------------------------------

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /**
   * One call with the session: a refused session is read afresh once and tried again; refused again, or gone from the
   * desktop app, the account is marked signed out.
   */
  private async call(method: SlackMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const wait = this.holdUntil - this.now();
    if (wait > 0) throw new SlackError(`Slack asked loki to wait ${Math.ceil(wait / 1000)} s`, "ratelimited", wait);
    let session = this.current ?? (await this.readSession(false));
    for (let attempt = 0; ; attempt++) {
      if (!session) return this.signedOut("the desktop app's session is gone or unreadable");
      this.current = session;
      try {
        return await this.request(session, method, params);
      } catch (err) {
        if (!(err instanceof SlackError) || !AUTH_ERRORS.includes(err.code)) throw err;
        if (attempt > 0) return this.signedOut(err.code);
      }
      session = await this.readSession(true);
    }
  }

  /**
   * The session, or null when the desktop app has none for this workspace or it cannot be read (signed out, Slack gone,
   * a Slack update loki does not know): each of those needs the person to reconnect, so each shows as signed out (R22).
   */
  private async readSession(fresh: boolean): Promise<SlackSession | null> {
    try {
      return await this.opts.session(fresh);
    } catch (err) {
      log("slack:session-failed", { error: messageOf(err) });
      return null;
    }
  }

  private signedOut(why: string): never {
    this.current = null;
    log("slack:signed-out", { why });
    this.opts.setStatus({ disconnected: "slack_signed_out" });
    throw new SlackError("Slack signed out: open the Slack app, sign in, then reconnect in Preferences › Inbox", "signed_out");
  }

  private async request(session: SlackSession, method: SlackMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({ token: session.token });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      body.set(k, typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
    }
    const res = await (this.opts.fetch ?? fetch)(`${apiBase(session.url)}${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `d=${encodeURIComponent(session.cookie)}`,
        origin: "https://app.slack.com",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) return this.rateLimited(method, res.headers.get("retry-after"));
    const answer = rec(await res.json().catch(() => ({})));
    if (answer.ok === true) return answer;
    const code = str(answer.error) || `http_${res.status}`;
    if (code === "ratelimited") return this.rateLimited(method, res.headers.get("retry-after"));
    throw new SlackError(`Slack ${method} failed: ${code}`, code);
  }

  /** Hold calls back for as long as Slack asks; the account stays connected. */
  private rateLimited(method: SlackMethod, retryAfter: string | null): never {
    const seconds = Number(retryAfter);
    const wait = retryAfter !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS;
    this.holdUntil = this.now() + wait;
    log("slack:rate-limited", { method, wait_ms: wait });
    throw new SlackError(`Slack asked loki to wait ${Math.ceil(wait / 1000)} s`, "ratelimited", wait);
  }
}
