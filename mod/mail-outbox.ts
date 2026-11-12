import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MailAddressing, OutsideReplied, ReplyThen } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";

/**
 * Mail replies held before they go, so the person can take one back (plan 076): Gmail's undo send, on this Mac. A held
 * reply is kept in `state/outbox.json` until the moment it is sent, so a daemon that restarts sends it when it starts
 * again instead of losing it.
 *
 * A send that fails is kept, with its reason, and its card says "not sent" until the person sends it again or
 * discards it (plan 096); nothing is sent again by itself. Gmail has no way to make a send safe to repeat, so each
 * reply carries its own header (`X-Loki-Outbox`, mod/gmail.ts), and before any second try the thread is read for it:
 * found, the reply went, and it is not sent again. A reply loki stopped in the middle of sending is checked the same
 * way when it starts again.
 *
 * Agents can write files under `~/.loki`, and the outbox sends as the person: a script that sends mail does so on its
 * own (mod/google-tools/gmail.ts), never through here. So each held reply is written with a seal made
 * with a key from the keychain, which agents cannot read, and a restart sends only the replies whose seal holds: an
 * entry something else put in the file is passed over. Without a keychain nothing is sent after a restart.
 */

/** One held reply: everything its send needs, and when it goes (ISO). */
export interface HeldReply {
  outbox_id: string;
  account_id: string;
  thread_id: string;
  text: string;
  then: ReplyThen;
  mail: MailAddressing | null;
  send_at: string;
}

/** What MailOutbox is built from; the clock and the timer are injected so tests own them. */
export interface MailOutboxOptions {
  file: string;
  /** The send itself, once the hold is over. */
  send: (held: HeldReply) => Promise<OutsideReplied>;
  holdMs?: number;
  /**
   * The key held replies are sealed with (`outboxKey`), or null without a keychain. Left out, replies are written
   * unsealed and none is sent after a restart.
   */
  key?: Promise<string | null>;
  now?: () => Date;
  /** Run `fn` after `ms`; returns how to cancel it. A timer when not given. */
  after?: (fn: () => void, ms: number) => () => void;
  /**
   * Whether the reply is in its thread already, by its header: asked before it is sent a second time. Left out, a reply
   * whose send was cut short is never sent again from loki.
   */
  wentOut?: (held: HeldReply) => Promise<boolean>;
  /** A reply stopped going (`note`, with why and when) or is settled after all (null): its card says so, or stops saying it. */
  onNotSent?: (held: HeldReply, note: { reason: string; at: string } | null) => void;
}

/**
 * How late a held reply may still go on its own after loki was closed when it was due. Past this it waits for the
 * person: a reply written for a thread as it was then should not arrive days later, after newer mail.
 */
export const RESUME_MAX_MS = 10 * 60_000;

/** How long a mail reply waits before it goes: one visible constant, long enough to notice a wrong Cc. */
export const HOLD_MS = 10_000;

/** One held reply in memory: how to cancel its timer, and how to tell whoever waits on it. */
interface Waiting {
  held: HeldReply;
  cancel: () => void;
  settle: (r: OutsideReplied | Error) => void;
}

/** The held replies of this Mac. */
export class MailOutbox {
  private readonly opts: MailOutboxOptions;
  private readonly waiting = new Map<string, Waiting>();
  /** The replies a "send again" is trying now, so a second press does not send twice. */
  private readonly trying = new Set<string>();

  constructor(opts: MailOutboxOptions) {
    this.opts = opts;
  }

  /**
   * Hold a reply for its time, then send it: resolves as the send went, or as undone when `undo` stopped it first. A
   * send that fails rejects with its reason. An id already held is refused, so one press never sends twice.
   */
  hold(reply: Omit<HeldReply, "send_at">): Promise<OutsideReplied> {
    if (this.waiting.has(reply.outbox_id)) return Promise.reject(new Error("that reply is already on its way"));
    const held: HeldReply = { ...reply, send_at: new Date(this.now() + this.holdMs()).toISOString() };
    const waited = new Promise<OutsideReplied>((resolve, reject) => {
      this.wait(held, (r) => (r instanceof Error ? reject(r) : resolve(r)));
    });
    // Undone while the key was read: there is nothing left to keep. Sent or failing meanwhile: its own write keeps it.
    void this.keep(held, {}, () => this.waiting.get(held.outbox_id)?.held === held);
    return waited;
  }

  /** Stop a held reply before it goes; false when it already went, or was never held here. */
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

  /**
   * The replies a daemon that stopped left in the file. One still held is sent when its time comes (at once when it
   * has passed), unless it is past RESUME_MAX_MS; one cut short in the middle of its send is looked for in its thread;
   * one that failed is shown again. Nobody waits on them now, so a failure is shown on the card.
   */
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

  /**
   * The person's "send again" on a reply that did not go: looked for in its thread first, and sent only when it is not
   * there, so it never goes twice. Rejects with why when it cannot be tried, and with the send's reason when it fails
   * again (the card then still says "not sent").
   */
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
        went = this.opts.wentOut ? await this.opts.wentOut(held) : false;
      } catch (err) {
        // Not knowing whether it went is never a reason to send it: it stays as it was.
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

  /** The person's "discard" on a reply that did not go: it is forgotten, and its card stops saying "not sent". */
  discard(accountId: string, outboxId: string): boolean {
    const held = this.read().find((h) => h.outbox_id === outboxId && h.account_id === accountId);
    if (held?.state !== "failed" || this.trying.has(outboxId)) return false;
    this.settled(held);
    log("outside:discarded", {});
    return true;
  }

  /** A reply cut short in the middle of its send: settled when it is in its thread, else kept as not sent. */
  private async checkCutShort(held: Stored): Promise<void> {
    const went = this.opts.wentOut ? await this.opts.wentOut(held).catch(() => null) : null;
    if (went === true) {
      log("outside:cut-short-went", {});
      this.settled(held);
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
    // Kept, marked as being sent: a crash now leaves it to be looked for in its thread at the next start, never sent
    // again blindly and never lost.
    await this.keep(w.held, { state: "sending" });
    try {
      const r = await this.opts.send(w.held);
      this.remove(outboxId);
      w.settle(r);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(messageOf(err));
      this.fail(w.held, e.message);
      w.settle(e);
    }
  }

  /** The reply did not go: kept with why, and its card told. */
  private fail(held: HeldReply, reason: string): void {
    const at = new Date(this.now()).toISOString();
    void this.keep(held, { state: "failed", reason, failed_at: at });
    log("outside:not-sent", { error: reason });
    this.opts.onNotSent?.(held, { reason, at });
  }

  /**
   * Write a held reply with `change`, sealed when there is a key: added when the file does not have it yet (the key
   * is still being read when the hold is short, or the keychain is slow to answer), else changed in place. `still`
   * says whether it is still wanted once the key is in hand.
   */
  private async keep(held: HeldReply, change: Partial<Pick<Stored, "state" | "reason" | "failed_at">>, still: () => boolean = () => true): Promise<void> {
    const key = await this.key();
    if (!still()) return;
    const list = this.read();
    const at = list.findIndex((h) => h.outbox_id === held.outbox_id);
    const was = at >= 0 ? list[at] : key ? { ...held, seal: sealOf(key, held) } : { ...held };
    const next = { ...was, ...change };
    this.write(at >= 0 ? list.map((h, i) => (i === at ? next : h)) : [...list, next]);
  }

  /** The reply went, or the person let it go: out of the file, and its card no longer says "not sent". */
  private settled(held: HeldReply): void {
    this.remove(held.outbox_id);
    this.opts.onNotSent?.(held, null);
  }

  private mark(outboxId: string, change: Partial<Pick<Stored, "state" | "reason" | "failed_at">>): void {
    this.write(this.read().map((h) => (h.outbox_id === outboxId ? { ...h, ...change } : h)));
  }

  private remove(outboxId: string): void {
    this.write(this.read().filter((h) => h.outbox_id !== outboxId));
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private holdMs(): number {
    return this.opts.holdMs ?? HOLD_MS;
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
type Stored = HeldReply & { seal?: unknown; state?: "sending" | "failed"; reason?: string; failed_at?: string };

/** The seal of a held reply: an HMAC over every field its send reads, in one fixed order. */
function sealOf(key: string, h: HeldReply): string {
  const fields = [h.outbox_id, h.account_id, h.thread_id, h.text, h.then, h.mail, h.send_at];
  return createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}

/** Whether a reply read from the file carries the seal this daemon would have made for it. */
function sealed(key: string, h: Stored): boolean {
  if (typeof h.seal !== "string") return false;
  const want = Buffer.from(sealOf(key, h), "hex");
  const got = Buffer.from(h.seal, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The keychain entry the outbox's key is kept under. */
const KEY_ACCOUNT = "outbox-key";

/**
 * The key held replies are sealed with, made on first use and kept in the keychain; null when the keychain cannot be
 * read or written, and then no reply is sent after a restart.
 */
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

/** Whether a value read from the file is a held reply; anything else in it is passed over. */
function isHeld(v: unknown): v is Stored {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.outbox_id === "string" &&
    typeof h.account_id === "string" &&
    typeof h.thread_id === "string" &&
    typeof h.text === "string" &&
    (h.then === "read" || h.then === "later" || h.then === "archive") &&
    typeof h.send_at === "string" &&
    typeof h.mail === "object"
  );
}
