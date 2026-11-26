import { chmodSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AccountLabel, AccountProvider, FlowRow, NotSentReply, OutsideChange, OutsideReach, OutsideSeed } from "../core/frame-types.ts";
import { Listeners } from "../core/listeners.ts";
import { parseMailTraits, type MailTraits } from "../core/mail-filter.ts";
import { REACH_LEVEL, mailReach } from "../core/outside-reach.ts";
import { keyedQueue } from "../core/serial.ts";
import { SERVICE_NAME, accountLabel, type AccountRecord, type Accounts } from "./accounts.ts";
import { writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";

export type ThreadState = "open" | "archived" | "handed_off";

export function outsideCardId(r: Pick<ThreadRecord, "thread_id" | "generation">): string {
  return `${r.thread_id}#${String(r.generation)}`;
}

export interface ThreadRecord {
  thread_id: string;
  state: ThreadState;
  generation: number;
  newest_message_id: string;
  /** ISO time of the newest message: what "newer" is judged by. */
  newest_at: string;
  sender: string;
  sender_address: string | null;
  subject_or_first_line: string;
  /** The last few messages as plain text, oldest first, for the card's body. */
  lines: string[];
  handoff_conversation_id: string | null;
  from_backfill: boolean;
  traits: MailTraits | null;
  unread_out_there: boolean;
  starred: boolean;
  waiting: boolean;
  kept_open: boolean;
  reach: OutsideReach | null;
  /** Where a Slack message was posted, `#channel`; null for a DM, for mail and from before. */
  place: string | null;
  /** The sender's Slack photo; null for mail and from before. */
  sender_avatar: string | null;
  not_sent: NotSentReply | null;
  dealt_message_id: string | null;
  /** The mark before the last move set it, so an undo of that move puts it back. */
  dealt_was: string | null;
  brought_ids: string[];
  seeds: OutsideSeed[];
  /** The approved comments the last move that ended the card let go, so an undo of that move puts them back. */
  seeds_was: OutsideSeed[];
}

export interface ObservedMessage {
  thread_id: string;
  message_id: string;
  at: string;
  sender: string;
  sender_address?: string | null;
  subject: string;
  lines: string[];
  from_backfill?: boolean;
  traits?: MailTraits | null;
  unread_out_there?: boolean;
  starred?: boolean;
  reach?: OutsideReach | null;
  place?: string | null;
  sender_avatar?: string | null;
  brought_ids?: string[];
}

export interface OutsideSource {
  archive(accountId: string, record: ThreadRecord): Promise<OutsideChange>;
  markRead(accountId: string, record: ThreadRecord): Promise<OutsideChange>;
  markUnread(accountId: string, record: ThreadRecord): Promise<OutsideChange>;
  addLabels(accountId: string, record: ThreadRecord, labels: string[]): Promise<OutsideChange>;
  restore(accountId: string, record: ThreadRecord, change: OutsideChange): Promise<void>;
  labels(accountId: string): Promise<AccountLabel[]>;
}

export interface AccountThreadsOptions {
  dir: string;
  accounts: Pick<Accounts, "get" | "list">;
  agentName?: (agentId: string) => string | null;
  now?: () => Date;
}

const LINES = 3;
const BROUGHT_MAX = 50;
const LINE_MAX = 280;
const STATES: readonly ThreadState[] = ["open", "archived", "handed_off"];

/** A file name for an account id on every system: ":" and the like, which Windows refuses, written as %XX. */
export function fileName(accountId: string): string {
  return `${accountId.replace(/[^A-Za-z0-9._@-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}.json`;
}

const newer = (m: { at: string; message_id: string }, r: ThreadRecord): boolean =>
  m.at > r.newest_at || (m.at === r.newest_at && m.message_id !== r.newest_message_id && m.message_id > r.newest_message_id);

const trimLines = (lines: string[]): string[] => lines.slice(-LINES).map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l));

function parseSeeds(v: unknown): OutsideSeed[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown): OutsideSeed[] => {
    if (typeof x !== "object" || x === null) return [];
    const r = x as Record<string, unknown>;
    return typeof r.id === "string" && typeof r.text === "string" && typeof r.at === "string" ? [{ id: r.id, text: r.text, at: r.at }] : [];
  });
}

function parseRecord(v: unknown): ThreadRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? r[k] : null);
  const threadId = s("thread_id"),
    messageId = s("newest_message_id"),
    at = s("newest_at");
  if (!threadId || messageId === null || at === null || !STATES.includes(r.state as ThreadState)) return null;
  return {
    thread_id: threadId,
    state: r.state as ThreadState,
    generation: typeof r.generation === "number" && r.generation >= 1 ? Math.floor(r.generation) : 1,
    newest_message_id: messageId,
    newest_at: at,
    sender: s("sender") ?? "",
    sender_address: s("sender_address"),
    subject_or_first_line: s("subject_or_first_line") ?? "",
    lines: Array.isArray(r.lines) ? r.lines.filter((l): l is string => typeof l === "string") : [],
    handoff_conversation_id: s("handoff_conversation_id"),
    from_backfill: r.from_backfill === true,
    traits: parseMailTraits(r.traits),
    unread_out_there: r.unread_out_there !== false,
    starred: r.starred === true,
    waiting: r.waiting === true,
    kept_open: r.kept_open === true,
    reach: typeof r.reach === "string" && r.reach in REACH_LEVEL ? (r.reach as OutsideReach) : null,
    place: s("place"),
    sender_avatar: s("sender_avatar"),
    not_sent: parseNotSent(r.not_sent),
    dealt_message_id: s("dealt_message_id"),
    dealt_was: s("dealt_was"),
    brought_ids: Array.isArray(r.brought_ids) ? r.brought_ids.filter((l): l is string => typeof l === "string") : [],
    seeds: parseSeeds(r.seeds),
    seeds_was: parseSeeds(r.seeds_was),
  };
}

function parseNotSent(v: unknown): NotSentReply | null {
  if (typeof v !== "object" || v === null) return null;
  const n = v as Record<string, unknown>;
  return typeof n.outbox_id === "string" && typeof n.text === "string" && typeof n.reason === "string" && typeof n.at === "string"
    ? { outbox_id: n.outbox_id, text: n.text, reason: n.reason, at: n.at }
    : null;
}

const dealt = (r: ThreadRecord): ThreadRecord => ({ ...r, dealt_message_id: r.newest_message_id, dealt_was: r.dealt_message_id });

function senderAddressOf(provider: AccountProvider, r: ThreadRecord): string | null {
  switch (provider) {
    case "gmail":
      return r.sender_address;
    case "slack":
    case "jira":
      return null;
  }
}

function reachOf(provider: AccountProvider, r: ThreadRecord): OutsideReach | null {
  switch (provider) {
    case "gmail":
      return r.reach ?? mailReach(r.traits);
    case "slack":
    case "jira":
      return r.reach;
  }
}

export class AccountThreads {
  private readonly opts: AccountThreadsOptions;
  private readonly byAccount = new Map<string, Map<string, ThreadRecord>>();
  private readonly sources = new Map<AccountProvider, OutsideSource>();
  private readonly listeners = new Listeners();
  private readonly serial = keyedQueue();
  private readonly batchDepth = new Map<string, number>();
  private readonly batchDirty = new Set<string>();

  constructor(opts: AccountThreadsOptions) {
    this.opts = opts;
  }

  async batch<T>(accountId: string, fn: () => Promise<T> | T): Promise<T> {
    this.batchDepth.set(accountId, (this.batchDepth.get(accountId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (this.batchDepth.get(accountId) ?? 1) - 1;
      if (left <= 0) {
        this.batchDepth.delete(accountId);
        if (this.batchDirty.delete(accountId)) this.saveNow(accountId);
      } else this.batchDepth.set(accountId, left);
    }
  }

  register(provider: AccountProvider, source: OutsideSource): void {
    this.sources.set(provider, source);
  }

  observe(accountId: string, m: ObservedMessage): boolean {
    const records = this.records(accountId);
    const prev = records.get(m.thread_id);
    const unreadOutThere = m.unread_out_there ?? true;
    const starred = m.starred === true;
    if (prev && !newer(m, prev)) {
      if (prev.state !== "open" || (prev.unread_out_there === unreadOutThere && prev.starred === starred)) return false;
      records.set(m.thread_id, { ...prev, unread_out_there: unreadOutThere, starred });
      this.save(accountId);
      return true;
    }
    const generation = !prev ? 1 : prev.state === "handed_off" ? prev.generation + 1 : prev.generation;
    records.set(m.thread_id, {
      thread_id: m.thread_id,
      state: "open",
      generation,
      newest_message_id: m.message_id,
      newest_at: m.at,
      sender: m.sender,
      sender_address: m.sender_address ?? null,
      subject_or_first_line: m.subject,
      lines: trimLines(m.lines),
      handoff_conversation_id: prev?.handoff_conversation_id ?? null,
      from_backfill: prev ? prev.from_backfill && m.from_backfill === true : m.from_backfill === true,
      traits: m.traits ?? null,
      unread_out_there: unreadOutThere,
      starred,
      waiting: false,
      kept_open: false,
      reach: m.reach ?? null,
      place: m.place ?? null,
      sender_avatar: m.sender_avatar ?? null,
      not_sent: prev?.not_sent ?? null,
      dealt_message_id: prev?.dealt_message_id ?? null,
      dealt_was: prev?.dealt_was ?? null,
      brought_ids: (m.brought_ids ?? prev?.brought_ids ?? []).slice(-BROUGHT_MAX),
      seeds: prev?.seeds ?? [],
      seeds_was: prev?.seeds_was ?? [],
    });
    this.save(accountId);
    return true;
  }

  markGoneOutThere(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "open") return false;
    this.records(accountId).set(threadId, { ...r, state: "archived" });
    this.save(accountId);
    return true;
  }

  markNotSent(accountId: string, threadId: string, outboxId: string, note: NotSentReply | null): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    if (note === null && r.not_sent?.outbox_id !== outboxId) return false;
    this.records(accountId).set(threadId, { ...r, not_sent: note });
    this.save(accountId);
    return true;
  }

  markWaiting(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "open" || r.waiting) return false;
    this.records(accountId).set(threadId, { ...r, waiting: true });
    this.save(accountId);
    return true;
  }

  describe(accountId: string, threadId: string, about: { reach: OutsideReach | null; place: string | null }): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    const reach = r.reach ?? about.reach;
    const place = r.place ?? about.place;
    if (reach === r.reach && place === r.place) return false;
    this.records(accountId).set(threadId, { ...r, reach, place });
    this.save(accountId);
    return true;
  }

  markDealt(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r || r.dealt_message_id === r.newest_message_id) return false;
    this.records(accountId).set(threadId, dealt(r));
    this.save(accountId);
    return true;
  }

  reopen(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (r?.state !== "archived") return false;
    this.records(accountId).set(threadId, { ...r, state: "open" });
    this.save(accountId);
    return true;
  }

  seed(accountId: string, threadId: string, seed: OutsideSeed): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    const seeds = [...r.seeds.filter((s) => s.id !== seed.id), seed];
    this.records(accountId).set(threadId, { ...r, state: r.state === "archived" ? "open" : r.state, seeds });
    this.save(accountId);
    return true;
  }

  clearSeeds(accountId: string, threadId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r?.seeds.length) return false;
    this.records(accountId).set(threadId, { ...r, seeds: [] });
    this.save(accountId);
    return true;
  }

  archive(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "archive", (source, r) => source.archive(accountId, r));
  }

  markRead(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "mark read", (source, r) => source.markRead(accountId, r));
  }

  markUnread(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "mark unread", (source, r) => source.markUnread(accountId, r));
  }

  addLabels(accountId: string, threadId: string, labels: string[]): Promise<OutsideChange | null> {
    return this.write(accountId, threadId, "label", (source, r) => source.addLabels(accountId, r, labels));
  }

  async labels(accountId: string): Promise<AccountLabel[]> {
    return this.sourceOf(accountId, "list labels").labels(accountId);
  }

  restore(accountId: string, threadId: string, change: OutsideChange): Promise<void> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (!r) throw new Error("loki has no record of that thread");
      await this.sourceOf(accountId, "undo").restore(accountId, r, change);
      const now = this.records(accountId).get(threadId);
      if (!now) return;
      const reopened = change.ended && now.state === "archived";
      const state = reopened ? "open" : now.state;
      const unread = change.move === "label" ? now.unread_out_there : change.was_unread;
      const keptOpen = reopened || now.kept_open;
      const mark = reopened ? now.dealt_was : now.dealt_message_id;
      const back = change.ended ? now.seeds_was.filter((s) => !now.seeds.some((x) => x.id === s.id)) : [];
      if (state === now.state && unread === now.unread_out_there && keptOpen === now.kept_open && mark === now.dealt_message_id && back.length === 0) return;
      const seeds = back.length > 0 ? [...back, ...now.seeds] : now.seeds;
      this.records(accountId).set(threadId, {
        ...now,
        state,
        unread_out_there: unread,
        kept_open: keptOpen,
        dealt_message_id: mark,
        seeds,
        seeds_was: change.ended ? [] : now.seeds_was,
      });
      this.save(accountId);
    });
  }

  private write(
    accountId: string,
    threadId: string,
    what: string,
    run: (source: OutsideSource, r: ThreadRecord) => Promise<OutsideChange>,
  ): Promise<OutsideChange | null> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (r?.state !== "open") return null;
      const change = await run(this.sourceOf(accountId, what), r);
      const now = this.records(accountId).get(threadId);
      if (now?.state !== "open" || now.newest_message_id !== r.newest_message_id) return change;
      const next = change.ended
        ? { ...dealt(now), state: "archived" as const, ...this.letSeedsGo(accountId, now) }
        : change.move === "read" || change.move === "unread"
          ? { ...now, unread_out_there: change.move === "unread" }
          : now;
      if (next !== now) {
        this.records(accountId).set(threadId, next);
        this.save(accountId);
      }
      return change;
    });
  }

  private letSeedsGo(accountId: string, r: ThreadRecord): Pick<ThreadRecord, "seeds" | "seeds_was"> {
    if (this.opts.accounts.get(accountId)?.provider !== "jira") return { seeds: r.seeds, seeds_was: r.seeds_was };
    return { seeds: [], seeds_was: r.seeds };
  }

  private sourceOf(accountId: string, what: string): OutsideSource {
    const account = this.opts.accounts.get(accountId);
    if (!account) throw new Error("that account is not connected on this Mac");
    const source = this.sources.get(account.provider);
    if (!source) throw new Error(`loki cannot ${what} in ${SERVICE_NAME[account.provider]} yet`);
    return source;
  }

  handedOff(accountId: string, threadId: string, conversationId: string, handedMessageId?: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    const missed = handedMessageId !== undefined && handedMessageId !== r.newest_message_id;
    this.records(accountId).set(
      threadId,
      missed
        ? { ...r, state: "open", generation: r.generation + 1, handoff_conversation_id: conversationId }
        : { ...dealt(r), state: "handed_off", handoff_conversation_id: conversationId },
    );
    this.save(accountId);
    return true;
  }

  handedOffStaying(accountId: string, threadId: string, conversationId: string): boolean {
    const r = this.records(accountId).get(threadId);
    if (!r) return false;
    if (r.handoff_conversation_id === conversationId) return true;
    this.records(accountId).set(threadId, { ...r, handoff_conversation_id: conversationId });
    this.save(accountId);
    return true;
  }

  archiveHandedOff(accountId: string, threadId: string): Promise<OutsideChange | null> {
    return this.serial(`${accountId} ${threadId}`, async () => {
      const r = this.records(accountId).get(threadId);
      if (r?.state !== "handed_off") return null;
      return this.sourceOf(accountId, "archive").archive(accountId, r);
    });
  }

  get(accountId: string, threadId: string): ThreadRecord | null {
    const r = this.records(accountId).get(threadId);
    return r ? { ...r } : null;
  }

  list(accountId: string): ThreadRecord[] {
    return [...this.records(accountId).values()].map((r) => ({ ...r }));
  }

  rows(): FlowRow[] {
    const out: FlowRow[] = [];
    const accounts = this.opts.accounts.list();
    const providerCounts = new Map<AccountProvider, number>();
    for (const a of accounts) providerCounts.set(a.provider, (providerCounts.get(a.provider) ?? 0) + 1);
    const ownerNames = new Map<string, string | null>();
    for (const account of accounts) {
      if (!ownerNames.has(account.owner_agent_id)) ownerNames.set(account.owner_agent_id, this.opts.agentName?.(account.owner_agent_id) ?? null);
      const ownerName = ownerNames.get(account.owner_agent_id) ?? null;
      const onlyAccount = (providerCounts.get(account.provider) ?? 0) <= 1;
      for (const r of this.records(account.account_id).values()) if (r.state === "open") out.push(this.row(account, r, ownerName, onlyAccount));
    }
    return out.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private row(account: AccountRecord, r: ThreadRecord, ownerName: string | null, onlyAccount: boolean): FlowRow {
    const label = accountLabel(account);
    return {
      kind: "outside",
      id: outsideCardId(r),
      agent_id: `account:${account.account_id}`,
      agent_name: label,
      title: r.subject_or_first_line,
      last_message_at: r.newest_at,
      archived: false,
      last_role: null,
      last_assistant_text: null,
      last_ask: null,
      outside: {
        account_id: account.account_id,
        provider: account.provider,
        account_label: account.address,
        thread_id: r.thread_id,
        generation: r.generation,
        owner_agent_id: account.owner_agent_id,
        owner_name: ownerName,
        sender: r.sender,
        sender_address: senderAddressOf(account.provider, r),
        subject: r.subject_or_first_line,
        lines: [...r.lines],
        newest_message_id: r.newest_message_id,
        newest_at: r.newest_at,
        handoff_conversation_id: r.handoff_conversation_id,
        disconnected: account.status === "connected" ? null : account.status.disconnected,
        unread_out_there: r.unread_out_there,
        ...(r.starred ? { starred: true } : {}),
        reach: reachOf(account.provider, r),
        place: r.place,
        sender_avatar: r.sender_avatar,
        ...(r.not_sent ? { not_sent: { ...r.not_sent } } : {}),
        only_account: onlyAccount,
        ...(r.seeds.length > 0 ? { seeds: r.seeds.map((s) => ({ ...s })) } : {}),
      },
    };
  }

  private file(accountId: string): string {
    return join(this.opts.dir, fileName(accountId));
  }

  private records(accountId: string): Map<string, ThreadRecord> {
    let records = this.byAccount.get(accountId);
    if (!records) {
      const list = this.read(accountId);
      const parsed = list.map(parseRecord).filter((r): r is ThreadRecord => r !== null);
      records = new Map(parsed.map((r) => [r.thread_id, r]));
      this.byAccount.set(accountId, records);
    }
    return records;
  }

  private read(accountId: string): unknown[] {
    const file = this.file(accountId);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {}
    const list = typeof raw === "object" && raw !== null ? (raw as { threads?: unknown }).threads : null;
    if (Array.isArray(list)) return list as unknown[];
    // Outside (Windows): a file name may not hold a colon, so the time is written without them.
    const stamp = (this.opts.now?.() ?? new Date())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const aside = `${file}.bad-${stamp}`;
    renameSync(file, aside);
    chmodSync(aside, 0o600);
    log.error("account-threads:file-unreadable", { account_id: accountId, moved_to: aside });
    return [];
  }

  private save(accountId: string): void {
    if ((this.batchDepth.get(accountId) ?? 0) > 0) {
      this.batchDirty.add(accountId);
      return;
    }
    this.saveNow(accountId);
  }

  private saveNow(accountId: string): void {
    writeJsonAtomic(this.file(accountId), { version: 1, threads: [...this.records(accountId).values()] }, { pretty: true, newline: true, mode: 0o600 });
    this.listeners.emit();
  }
}
