import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MailAddressing, OutsideReplied, ReplyThen } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";

/**
 * Mail replies held before they go, so the person can take one back (plan 076): Gmail's undo send, on this Mac. A held
 * reply is kept in `state/outbox.json` until the moment it is sent, so a daemon that restarts sends it when it starts
 * again instead of losing it. It leaves the file before the send begins, so a crash during the send loses it at worst
 * and never sends it twice.
 *
 * Agents can write files under `~/.loki`, and no agent may send mail. So each held reply is written with a seal made
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
}

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
    void this.key().then((key) => {
      // Sent or undone while the key was read: there is nothing left to keep.
      if (this.waiting.get(held.outbox_id)?.held !== held) return;
      this.write([...this.read().filter((h) => h.outbox_id !== held.outbox_id), key ? { ...held, seal: sealOf(key, held) } : held]);
    });
    return waited;
  }

  /** Stop a held reply before it goes; false when it already went, or was never held here. */
  undo(accountId: string, outboxId: string): boolean {
    const w = this.waiting.get(outboxId);
    if (w?.held.account_id !== accountId) return false;
    w.cancel();
    this.waiting.delete(outboxId);
    this.write(this.read().filter((h) => h.outbox_id !== outboxId));
    log("outside:unsent", {});
    w.settle({ sent: false, undone: true });
    return true;
  }

  /**
   * The replies a daemon that stopped left held, each sent when its time comes (at once when it has passed). Nobody waits
   * on them now, so how each went is only logged.
   */
  resume(): void {
    void this.key().then((key) => {
      for (const held of this.read()) {
        if (this.waiting.has(held.outbox_id)) continue;
        if (!key || !sealed(key, held)) {
          log("outside:resume-refused", { reason: key ? "seal" : "no key" });
          this.write(this.read().filter((h) => h.outbox_id !== held.outbox_id));
          continue;
        }
        this.wait(held, (r) => {
          if (r instanceof Error) log("outside:resumed-send-failed", { error: r.message });
        });
      }
    });
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
    // Out of the file before the send: a crash now loses the reply rather than sending it twice.
    this.write(this.read().filter((h) => h.outbox_id !== outboxId));
    try {
      w.settle(await this.opts.send(w.held));
    } catch (err) {
      w.settle(err instanceof Error ? err : new Error(messageOf(err)));
    }
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

/** A held reply as the file keeps it: with its seal, when there was a key to make one. */
type Stored = HeldReply & { seal?: unknown };

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
