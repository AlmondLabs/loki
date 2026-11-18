import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MailAddressing, OutsideReplied, ReplyMention, ReplyThen } from "../core/frame-types.ts";
import { MAIL_HOLD_MS, replyMentionOf } from "../core/frames.ts";
import { messageOf } from "../core/errors.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";

export interface HeldFile {
  name: string;
  path: string;
  size: number;
  md5: string;
}

export interface HeldProposal {
  agent_id: string;
  conversation_id: string;
  proposal_id: string;
}

export interface HeldReply {
  outbox_id: string;
  account_id: string;
  thread_id: string;
  text: string;
  then: ReplyThen;
  mail: MailAddressing | null;
  send_at: string;
  thread_ts?: string | null;
  files?: HeldFile[];
  proposal?: HeldProposal | null;
  mentions?: ReplyMention[];
  target?: HeldTarget;
}

export type HeldTarget =
  | { kind: "email"; subject: string; message_id: string }
  | { kind: "dm"; people: string[] }
  | {
      kind: "ticket";
      project: string;
      type_id: string;
      title: string;
      assignee: string | null;
      priority_id: string | null;
      labels: string[];
      parent: string | null;
    };

export interface MailOutboxOptions {
  file: string;
  send: (held: HeldReply) => Promise<OutsideReplied>;
  holdMs?: number;
  key?: Promise<string | null>;
  now?: () => Date;
  after?: (fn: () => void, ms: number) => () => void;
  wentOut?: (held: HeldReply) => Promise<boolean | null>;
  onNotSent?: (held: HeldReply, note: { reason: string; at: string } | null) => void;
  onSent?: (held: HeldReply, result: string | null) => void;
}

export const RESUME_MAX_MS = 10 * 60_000;

interface Waiting {
  held: HeldReply;
  cancel: () => void;
  settle: (r: OutsideReplied | Error) => void;
}

export class MailOutbox {
  private readonly opts: MailOutboxOptions;
  private readonly waiting = new Map<string, Waiting>();
  private readonly trying = new Set<string>();

  constructor(opts: MailOutboxOptions) {
    this.opts = opts;
  }

  hold(reply: Omit<HeldReply, "send_at">): Promise<OutsideReplied> {
    if (this.waiting.has(reply.outbox_id)) return Promise.reject(new Error("that reply is already on its way"));
    const held: HeldReply = { ...reply, send_at: new Date(this.now() + this.holdMs()).toISOString() };
    const waited = new Promise<OutsideReplied>((resolve, reject) => {
      this.wait(held, (r) => (r instanceof Error ? reject(r) : resolve(r)));
    });
    void this.keep(held, {}, () => this.waiting.get(held.outbox_id)?.held === held);
    return waited;
  }

  acknowledge(outboxId: string): void {
    const held = this.read().find((h) => h.outbox_id === outboxId);
    if (held?.proposal && (held.state === "sent" || held.state === "failed")) this.remove(outboxId);
  }

  has(outboxId: string): boolean {
    return this.waiting.has(outboxId) || this.read().some((h) => h.outbox_id === outboxId);
  }

  undo(accountId: string, outboxId: string): boolean {
    const w = this.waiting.get(outboxId);
    if (w?.held.account_id !== accountId) return false;
    w.cancel();
    this.waiting.delete(outboxId);
    this.remove(outboxId);
    log("outside:unsent", {});
    w.settle({ sent: false, undone: true });
    return true;
  }

  resume(): void {
    void this.key().then((key) => {
      for (const held of this.read()) {
        if (this.waiting.has(held.outbox_id)) continue;
        if (!key || !sealed(key, held)) {
          log("outside:resume-refused", { reason: key ? "seal" : "no key" });
          this.remove(held.outbox_id);
          continue;
        }
        if (held.state === "failed") {
          this.opts.onNotSent?.(held, { reason: held.reason ?? "not sent", at: held.failed_at ?? held.send_at });
          continue;
        }
        if (held.state === "sent") {
          this.opts.onSent?.(held, held.result ?? null);
          continue;
        }
        if (held.state === "sending") {
          void this.checkCutShort(held);
          continue;
        }
        if (this.now() - Date.parse(held.send_at) > RESUME_MAX_MS) {
          this.fail(held, "loki was closed when it was due: send it again if it should still go");
          continue;
        }
        this.wait(held, (r) => {
          if (r instanceof Error) log("outside:resumed-send-failed", { error: r.message });
        });
      }
    });
  }

  async resend(accountId: string, outboxId: string): Promise<OutsideReplied> {
    const key = await this.key();
    const held = this.read().find((h) => h.outbox_id === outboxId && h.account_id === accountId);
    if (held?.state !== "failed") throw new Error("that reply is not waiting to be sent again");
    if (!key || !sealed(key, held)) throw new Error("loki cannot send that reply again: write it again");
    if (this.trying.has(outboxId)) throw new Error("that reply is already on its way");
    this.trying.add(outboxId);
    try {
      this.mark(outboxId, { state: "sending" });
      let went: boolean;
      try {
        const found = this.opts.wentOut ? await this.opts.wentOut(held) : false;
        if (found === null) throw new Error("its thread cannot be searched for it");
        went = found;
      } catch (err) {
        this.mark(outboxId, { state: "failed" });
        throw new Error(`the thread could not be read to check it did not go already: ${messageOf(err)}`);
      }
      if (went) {
        log("outside:resend-found", {});
        this.settled(held);
        return { sent: true, then_error: null, change: null };
      }
      try {
        const r = await this.opts.send(held);
        this.settled(held);
        return r;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(messageOf(err));
        this.fail(held, e.message);
        throw e;
      }
    } finally {
      this.trying.delete(outboxId);
    }
  }

  discard(accountId: string, outboxId: string): boolean {
    const held = this.read().find((h) => h.outbox_id === outboxId && h.account_id === accountId);
    if (held?.state !== "failed" || this.trying.has(outboxId)) return false;
    this.settled(held);
    log("outside:discarded", {});
    return true;
  }

  private async checkCutShort(held: Stored): Promise<void> {
    const went = this.opts.wentOut ? await this.opts.wentOut(held).catch(() => null) : null;
    if (went === true) {
      log("outside:cut-short-went", {});
      if (held.proposal) {
        this.mark(held.outbox_id, { state: "sent" });
        this.opts.onSent?.(held, null);
      } else this.settled(held);
      return;
    }
    this.fail(
      held,
      went === false
        ? "loki stopped while sending it, and it is not in the thread"
        : "loki stopped while sending it: look in the thread before sending it again",
    );
  }

  private key(): Promise<string | null> {
    return (this.opts.key ?? Promise.resolve(null)).catch(() => null);
  }

  private wait(held: HeldReply, settle: (r: OutsideReplied | Error) => void): void {
    const ms = Math.max(0, Date.parse(held.send_at) - this.now());
    const after =
      this.opts.after ??
      ((fn: () => void, wait: number) => {
        const t = setTimeout(fn, wait);
        return () => clearTimeout(t);
      });
    const cancel = after(() => void this.go(held.outbox_id), ms);
    this.waiting.set(held.outbox_id, { held, cancel, settle });
  }

  private async go(outboxId: string): Promise<void> {
    const w = this.waiting.get(outboxId);
    if (!w) return;
    this.waiting.delete(outboxId);
    await this.keep(w.held, { state: "sending" });
    try {
      const r = await this.opts.send(w.held);
      if (w.held.proposal) {
        const result = r.sent ? (r.created ?? null) : null;
        this.mark(outboxId, { state: "sent", ...(result ? { result } : {}) });
        this.opts.onSent?.(w.held, result);
      } else this.remove(outboxId);
      w.settle(r);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(messageOf(err));
      this.fail(w.held, e.message);
      w.settle(e);
    }
  }

  private fail(held: HeldReply, reason: string): void {
    const at = new Date(this.now()).toISOString();
    void this.keep(held, { state: "failed", reason, failed_at: at });
    log("outside:not-sent", { error: reason });
    this.opts.onNotSent?.(held, { reason, at });
  }

  private async keep(held: HeldReply, change: Partial<Pick<Stored, "state" | "reason" | "failed_at">>, still: () => boolean = () => true): Promise<void> {
    const key = await this.key();
    if (!still()) return;
    const list = this.read();
    const at = list.findIndex((h) => h.outbox_id === held.outbox_id);
    const was = at >= 0 ? list[at] : key ? { ...held, seal: sealOf(key, held) } : { ...held };
    const next = { ...was, ...change };
    this.write(at >= 0 ? list.map((h, i) => (i === at ? next : h)) : [...list, next]);
  }

  private settled(held: HeldReply): void {
    this.remove(held.outbox_id);
    this.opts.onNotSent?.(held, null);
  }

  private mark(outboxId: string, change: Partial<Pick<Stored, "state" | "reason" | "failed_at" | "result">>): void {
    this.write(this.read().map((h) => (h.outbox_id === outboxId ? { ...h, ...change } : h)));
  }

  private remove(outboxId: string): void {
    this.write(this.read().filter((h) => h.outbox_id !== outboxId));
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private holdMs(): number {
    return this.opts.holdMs ?? MAIL_HOLD_MS;
  }

  private read(): Stored[] {
    const raw = readJson(this.opts.file);
    const list = typeof raw === "object" && raw !== null ? (raw as { held?: unknown }).held : null;
    return Array.isArray(list) ? list.filter(isHeld) : [];
  }

  private write(held: Stored[]): void {
    writeJsonAtomic(this.opts.file, { version: 1, held }, { mode: 0o600 });
  }
}

/**
 * A held reply as the file keeps it: with its seal, when there was a key to make one, and how its send stands. No state
 * is a reply still waiting out its hold; `sending` one whose send began; `failed` one that did not go, with why.
 */
type Stored = HeldReply & { seal?: unknown; state?: "sending" | "sent" | "failed"; reason?: string; failed_at?: string; result?: string };

/**
 * The seal of a held reply: an HMAC over every field its send reads, in one fixed order. The Slack thread, files and
 * proposal are sealed only when a reply has any, so a reply held before they existed keeps the seal it was written with.
 */
function sealOf(key: string, h: HeldReply): string {
  const base: unknown[] = [h.outbox_id, h.account_id, h.thread_id, h.text, h.then, h.mail, h.send_at];
  const mentioned = h.mentions !== undefined;
  const targeted = h.target !== undefined;
  const more = h.thread_ts != null || h.files !== undefined || h.proposal != null || mentioned || targeted;
  const tail = targeted ? [h.mentions ?? null, h.target] : mentioned ? [h.mentions] : [];
  const fields = more ? [...base, h.thread_ts ?? null, h.files ?? null, h.proposal ?? null, ...tail] : base;
  return createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}

function sealed(key: string, h: Stored): boolean {
  if (typeof h.seal !== "string") return false;
  const want = Buffer.from(sealOf(key, h), "hex");
  const got = Buffer.from(h.seal, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

const KEY_ACCOUNT = "outbox-key";

export async function outboxKey(secrets: {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
}): Promise<string | null> {
  try {
    const kept = await secrets.get(KEY_ACCOUNT);
    if (kept) return kept;
    const made = randomBytes(32).toString("hex");
    await secrets.set(KEY_ACCOUNT, made);
    return made;
  } catch (err) {
    log("outside:outbox-key-failed", { error: messageOf(err) });
    return null;
  }
}

function isHeld(v: unknown): v is Stored {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.outbox_id === "string" &&
    typeof h.account_id === "string" &&
    typeof h.thread_id === "string" &&
    typeof h.text === "string" &&
    (h.then === "read" || h.then === "later" || h.then === "archive" || h.then === "stay") &&
    typeof h.send_at === "string" &&
    typeof h.mail === "object" &&
    (h.thread_ts === undefined || h.thread_ts === null || typeof h.thread_ts === "string") &&
    (h.files === undefined || (Array.isArray(h.files) && h.files.every(isFile))) &&
    (h.proposal === undefined || h.proposal === null || isProposal(h.proposal)) &&
    (h.mentions === undefined || (Array.isArray(h.mentions) && h.mentions.every((m) => replyMentionOf(m) !== null))) &&
    (h.target === undefined || isTarget(h.target)) &&
    (h.result === undefined || typeof h.result === "string")
  );
}

function isTarget(v: unknown): v is HeldTarget {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  if (t.kind === "email") return typeof t.subject === "string" && typeof t.message_id === "string" && t.message_id !== "";
  const text = (x: unknown) => typeof x === "string" && x !== "";
  const maybe = (x: unknown) => x === null || text(x);
  if (t.kind === "ticket")
    return (
      text(t.project) &&
      text(t.type_id) &&
      text(t.title) &&
      maybe(t.assignee) &&
      maybe(t.priority_id) &&
      maybe(t.parent) &&
      Array.isArray(t.labels) &&
      t.labels.every(text)
    );
  return t.kind === "dm" && Array.isArray(t.people) && t.people.length > 0 && t.people.every((p) => typeof p === "string" && p !== "");
}

function isFile(v: unknown): v is HeldFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.name === "string" && typeof f.path === "string" && typeof f.size === "number" && typeof f.md5 === "string";
}

function isProposal(v: unknown): v is HeldProposal {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.agent_id === "string" && typeof p.conversation_id === "string" && typeof p.proposal_id === "string";
}
