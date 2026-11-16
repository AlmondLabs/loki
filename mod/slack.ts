// The way calls are made with a desktop session (form-encoded POSTs to the workspace's own address, carrying the token
// and the `d` cookie) is ported from agent-slack (https://github.com/stablyai/agent-slack, src/slack/client.ts):
//
// MIT License. Copyright (c) 2026 Stably. Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
// conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

import type { AccountStatus } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { log } from "./log.ts";
import type { SlackSession } from "./slack-session.ts";
import { writeMentions } from "../core/mentions.ts";

export const SLACK_METHODS = [
  "auth.test",
  "client.counts",
  "activity.feed",
  "activity.markRead",
  "activity.markUnread",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "conversations.members",
  "users.conversations",
  "users.info",
  "users.list",
  "users.prefs.get",
  "emoji.list",
  "conversations.mark",
  "chat.postMessage",
  "files.getUploadURLExternal",
  "files.completeUploadExternal",
  "reactions.add",
  "reactions.remove",
] as const;

export type SlackMethod = (typeof SLACK_METHODS)[number];

/** The errors Slack gives when the session is no good: signed out, revoked or expired. */
const AUTH_ERRORS = ["invalid_auth", "not_authed", "token_revoked", "token_expired"];
const DEFAULT_RETRY_MS = 60_000;
const TIMEOUT_MS = 20_000;

export const uploadTimeoutMs = (bytes: number): number => TIMEOUT_MS + Math.ceil(bytes / 170);

const PREVIEW_MAX_BYTES = 1_000_000;

export class SlackError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(message: string, code: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "SlackError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SlackClientOptions {
  session: (fresh: boolean) => Promise<SlackSession | null>;
  setStatus: (status: AccountStatus) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface SlackIdentity {
  team_id: string;
  team: string;
  user_id: string;
  user: string;
  url: string;
}

export interface SlackCount {
  id: string;
  has_unreads: boolean;
  mention_count: number;
  latest: string | null;
  last_read: string | null;
}

export interface SlackCounts {
  ims: SlackCount[];
  mpims: SlackCount[];
  channels: SlackCount[];
  threads: { has_unreads: boolean; mention_count: number };
}

export const SLACK_ACTIVITY_TYPES = ["at_user", "at_user_group", "at_channel", "at_everyone", "thread_v2"] as const;

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

export type SlackActivityEntry = Pick<SlackActivityItem, "type" | "key" | "feed_ts">;

export interface SlackActivityPage {
  items: SlackActivityItem[];
  next_cursor: string | null;
}

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

export interface SlackMessagePage {
  messages: SlackMessage[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SlackConversation {
  id: string;
  name: string | null;
  is_im: boolean;
  is_mpim: boolean;
  is_channel: boolean;
  is_private: boolean;
  user: string | null;
  last_read: string | null;
  is_member?: boolean;
  is_ext_shared?: boolean;
}

export interface SlackMembership {
  id: string;
  name: string | null;
  is_im: boolean;
  is_mpim: boolean;
  user: string | null;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  is_bot: boolean;
  image?: string;
}

export type SlackStoredMentions = ReadonlyArray<{ display: string; id: string | null }>;

export interface SlackPostInput {
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

const replyText = (text: string, mentions: ReadonlyArray<{ display: string; id: string | null }> | undefined): string =>
  writeMentions(
    text,
    (mentions ?? []).filter((m) => m.id),
    (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    (m) => `<@${m.id ?? ""}>`,
  ).join("");

const isFilesHost = (url: string): boolean => url.startsWith("https://files.slack.com/");

/** How files.slack.com knows the person: the token as a bearer and the desktop app's `d` cookie. */
const filesHeaders = (session: SlackSession): Record<string, string> => ({
  authorization: `Bearer ${session.token}`,
  cookie: `d=${encodeURIComponent(session.cookie)}`,
});

function apiBase(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"))) return `https://${u.hostname}/api/`;
  } catch {}
  return "https://slack.com/api/";
}

export class SlackClient {
  private readonly opts: SlackClientOptions;
  private current: SlackSession | null = null;
  /**
   * Until when Slack asked for no calls of each method (a rate limit), in ms since the epoch. Slack limits each method
   * on its own, so a busy Activity feed does not keep a thread from being read.
   */
  private readonly holdUntil = new Map<SlackMethod, number>();

  constructor(opts: SlackClientOptions) {
    this.opts = opts;
  }

  async authTest(): Promise<SlackIdentity> {
    const r = await this.call("auth.test", {});
    return { team_id: str(r.team_id), team: str(r.team), user_id: str(r.user_id), user: str(r.user), url: str(r.url) };
  }

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

  async conversationsReplies(opts: { channel: string; ts: string; oldest?: string; limit?: number; cursor?: string }): Promise<SlackMessagePage> {
    return parsePage(await this.call("conversations.replies", { ...opts }));
  }

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
      is_member: c.is_im === true || c.is_member === true,
      is_ext_shared: c.is_ext_shared === true,
    };
  }

  async usersConversations(cursor: string | null): Promise<{ conversations: SlackMembership[]; next_cursor: string | null }> {
    const r = await this.call("users.conversations", {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const conversations = list(r.channels).map((v) => {
      const c = rec(v);
      return { id: str(c.id), name: strOrNull(c.name), is_im: c.is_im === true, is_mpim: c.is_mpim === true, user: strOrNull(c.user) };
    });
    return { conversations: conversations.filter((c) => c.id), next_cursor: strOrNull(rec(r.response_metadata).next_cursor) };
  }

  async conversationsMembers(channel: string, cursor: string | null): Promise<{ members: string[]; next_cursor: string | null }> {
    const r = await this.call("conversations.members", { channel, limit: 200, ...(cursor ? { cursor } : {}) });
    return {
      members: list(r.members).filter((m): m is string => typeof m === "string" && m !== ""),
      next_cursor: strOrNull(rec(r.response_metadata).next_cursor),
    };
  }

  async emojiList(): Promise<Record<string, string>> {
    const emoji = rec((await this.call("emoji.list", {})).emoji);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(emoji)) if (typeof value === "string") out[name] = value;
    return out;
  }

  async frequentEmoji(): Promise<string[]> {
    const raw = rec((await this.call("users.prefs.get", {})).prefs).emoji_use;
    let use: unknown = raw;
    if (typeof raw === "string") {
      try {
        use = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    const counts: Array<[string, number]> = [];
    for (const [name, n] of Object.entries(rec(use))) if (typeof n === "number" && n > 0) counts.push([name, n]);
    return counts.sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }

  async usersInfo(user: string): Promise<SlackUser> {
    const u = rec((await this.call("users.info", { user })).user);
    const profile = rec(u.profile);
    return {
      id: str(u.id) || user,
      name: str(u.name),
      real_name: str(u.real_name) || str(profile.real_name),
      display_name: str(profile.display_name),
      is_bot: u.is_bot === true,
      image: str(profile.image_72) || str(profile.image_48),
    };
  }

  async usersList(cursor: string | null): Promise<{ users: SlackUser[]; next_cursor: string | null }> {
    const r = await this.call("users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
    const users: SlackUser[] = [];
    for (const raw of Array.isArray(r.members) ? (r.members as unknown[]) : []) {
      const u = rec(raw);
      if (!str(u.id) || u.deleted === true) continue;
      const profile = rec(u.profile);
      users.push({
        id: str(u.id),
        name: str(u.name),
        real_name: str(u.real_name) || str(profile.real_name),
        display_name: str(profile.display_name),
        is_bot: u.is_bot === true || str(u.id) === "USLACKBOT",
        image: str(profile.image_72) || str(profile.image_48),
      });
    }
    const next = str(rec(r.response_metadata).next_cursor);
    return { users, next_cursor: next || null };
  }

  async markDm(channel: string, ts: string): Promise<void> {
    const info = await this.conversationsInfo(channel);
    if (!info.is_im && !info.is_mpim) throw new SlackError(`${channel} is not a DM or group DM: loki marks only those read`, "not_a_dm");
    await this.call("conversations.mark", { channel, ts });
  }

  async markActivity(items: readonly SlackActivityEntry[], read: boolean): Promise<void> {
    if (items.length === 0) return;
    const entries = items.map((i) => ({ type: i.type, key: i.key, feed_ts: i.feed_ts }));
    await this.call(read ? "activity.markRead" : "activity.markUnread", { entries });
  }

  async postReply(input: SlackPostInput & { mentions?: SlackStoredMentions }): Promise<{ ts: string }> {
    const text = replyText(input.text, input.mentions);
    const r = await this.call("chat.postMessage", { channel: input.channel, text, ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}) });
    return { ts: typeof r.ts === "string" ? r.ts : "" };
  }

  async postWithFiles(input: SlackPostInput & { mentions?: SlackStoredMentions; files: ReadonlyArray<{ name: string; data: Uint8Array }> }): Promise<void> {
    const uploaded: Array<{ id: string; title: string }> = [];
    for (const file of input.files) {
      const r = await this.call("files.getUploadURLExternal", { filename: file.name, length: file.data.length });
      const uploadUrl = str(r.upload_url);
      if (!isFilesHost(uploadUrl)) throw new SlackError("Slack gave an upload address off files.slack.com, so loki sent nothing there", "upload_host");
      await this.upload(uploadUrl, file.data);
      uploaded.push({ id: str(r.file_id), title: file.name });
    }
    await this.call("files.completeUploadExternal", {
      files: uploaded,
      channel_id: input.channel,
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      initial_comment: replyText(input.text, input.mentions),
    });
  }

  async react(input: { channel: string; ts: string; name: string; on: boolean }): Promise<void> {
    try {
      await this.call(input.on ? "reactions.add" : "reactions.remove", { channel: input.channel, timestamp: input.ts, name: input.name });
    } catch (err) {
      if (err instanceof SlackError && (err.code === "already_reacted" || err.code === "no_reaction")) return;
      throw err;
    }
  }

  async fileThumb(url: string): Promise<{ data: Buffer; type: string } | null> {
    if (!isFilesHost(url)) return null;
    const session = this.current ?? (await this.readSession(false));
    if (!session) return null;
    const res = await (this.opts.fetch ?? fetch)(url, { headers: filesHeaders(session), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok || !type.startsWith("image/")) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length <= PREVIEW_MAX_BYTES ? { data, type } : null;
  }

  /**
   * Send one file's bytes to the files.slack.com address Slack just gave for it, as the person. Slack answers a good
   * upload with plain text, not JSON, so only the status is read.
   */
  private async upload(url: string, data: Uint8Array): Promise<void> {
    const session = this.current;
    if (!session) return this.signedOut("the session went away between asking for an upload address and uploading");
    const res = await (this.opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { ...filesHeaders(session), "content-type": "application/octet-stream" },
      // A copy on its own ArrayBuffer, which fetch's types ask for; one copy of at most 17 MB is cheap.
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(uploadTimeoutMs(data.length)),
    });
    if (!res.ok) throw new SlackError(`Slack refused a file upload: http_${res.status}`, `http_${res.status}`);
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private async call(method: SlackMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const wait = (this.holdUntil.get(method) ?? 0) - this.now();
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
    throw new SlackError("Slack signed out: open the Slack app, sign in, then reconnect in Preferences › Accounts", "signed_out");
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

  private rateLimited(method: SlackMethod, retryAfter: string | null): never {
    const seconds = Number(retryAfter);
    const wait = retryAfter !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS;
    this.holdUntil.set(method, this.now() + wait);
    log("slack:rate-limited", { method, wait_ms: wait });
    throw new SlackError(`Slack asked loki to wait ${Math.ceil(wait / 1000)} s`, "ratelimited", wait);
  }
}
