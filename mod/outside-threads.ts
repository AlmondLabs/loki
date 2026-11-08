import { messageOf } from "../core/errors.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import type { AccountProvider, MailAddressing, MailCompose, OutsideChange, OutsideMessage, OutsideReplied, ReplyThen } from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import type { AccountThreads } from "./account-threads.ts";
import type { GmailAttachment, GmailClient, GmailMessage, GmailSendAs } from "./gmail.ts";
import { mailAttachments, mailParts, type ThreadText } from "./handoff.ts";
import { log } from "./log.ts";
import { forwardSubject, fromHeader, mailBody, signatureText } from "./mail-compose.ts";
import { MailOutbox, type HeldReply, type MailOutboxOptions } from "./mail-outbox.ts";
import { headerPeople, type MailPeople } from "./mail-people.ts";
import { headerOf, replyAllOf, replyOf, replySubject, replyTarget, slackPlace } from "./reply-proposals.ts";
import { SlackError, type SlackClient } from "./slack.ts";

/**
 * An outside card's thread for the person (plan 068): the whole thread to read on the card, and the person's own
 * reply, sent in it. This is the only place loki sends anything, and it is reached only by the reply frame the
 * person's own devices send (mod/frames/accounts.ts); no agent tool is built on it, so agents still never send (R18).
 */

/**
 * What sending a reply needs of Gmail: the thread, to answer its newest message, the addresses the person sends from
 * with their signatures, a forwarded mail's files, and the send.
 */
export type SendGmail = Pick<GmailClient, "getThread" | "sendAs" | "sendReply" | "attachment">;

/** What sending a reply needs of Slack: the post. */
export type SendSlack = Pick<SlackClient, "postReply">;

/** One account's sending client. */
export type SendClient = { provider: "gmail"; client: SendGmail } | { provider: "slack"; client: SendSlack };

/** What the thread reader and the reply are built from; the clients and readers are injected so tests own them. */
export interface OutsideThreadsOptions {
  accounts: Pick<Accounts, "get">;
  threads: Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "markWaiting">;
  /** The whole thread from its account, oldest first: the readers a hand-off uses (mod/handoff.ts). */
  threadText: Record<AccountProvider, ThreadText>;
  /** A card's own reader where it shows more than the thread: Slack's channel around it (plan 074). */
  cardView?: Partial<Record<AccountProvider, ThreadText>>;
  clientFor: (account: AccountRecord) => SendClient;
  /** Waiting out a rate limit before reading again; a timer when not given. */
  sleep?: (ms: number) => Promise<void>;
  /** Where held mail replies wait for their undo (plan 076); without it a mail reply goes at once. */
  outbox?: Omit<MailOutboxOptions, "send">;
  /** The people each account has mail with, for suggestions, and told of whom the person sends to (plan 076). */
  people?: Pick<MailPeople, "top" | "saw">;
  /** The time zone a quote's date is written in; this Mac's when left out. */
  zone?: string;
  now?: () => Date;
}

/**
 * The longest rate-limit wait a thread read sits out before trying once more, the card showing it is still reading.
 * A longer wait is reported, so the card says why it shows only its last lines.
 */
const READ_WAIT_MAX_MS = 30_000;

/** The longest reply loki sends: well under Gmail's and Slack's own limits, and far past anything typed on a card. */
const MAX_REPLY = 30_000;

/** The most a forward carries in files: under Gmail's 25 MB once the files are written out as text. */
const MAX_FORWARD_BYTES = 17 * 1024 * 1024;

/** Reads an outside card's thread and sends the person's reply in it. */
export class OutsideThreads {
  private readonly opts: OutsideThreadsOptions;
  private readonly outbox: MailOutbox | null;

  constructor(opts: OutsideThreadsOptions) {
    this.opts = opts;
    this.outbox = opts.outbox ? new MailOutbox({ ...opts.outbox, send: (held) => this.sendNow(held) }) : null;
  }

  /** Send the mail replies a daemon that stopped left held (plan 076), each when its time comes. */
  resume(): void {
    this.outbox?.resume();
  }

  /**
   * What a mail card's recipients line starts from (plan 076): who reply and reply all go to, the addresses the person
   * sends from with their signatures as text and the one this thread is answered from, the subject, and the people the
   * account has mail with, this thread's own first.
   */
  async compose(accountId: string, threadId: string): Promise<MailCompose> {
    const account = this.need(accountId);
    const sender = this.opts.clientFor(account);
    if (sender.provider !== "gmail") throw new Error("only a mail thread has recipients");
    const [thread, sendAs] = await Promise.all([sender.client.getThread(threadId, "metadata"), sender.client.sendAs()]);
    const newest = replyTarget(thread.messages);
    if (!newest) throw new Error("that thread is empty in Gmail now");
    const own = ownAddresses(account, sendAs);
    const here = thread.messages.flatMap((m) => ["From", "To", "Cc"].flatMap((h) => headerPeople(headerOf(m, h))));
    const seen = new Set(own);
    const people = [...here, ...(this.opts.people?.top(accountId) ?? [])].filter((p) => !seen.has(p.address) && seen.add(p.address));
    return {
      modes: { reply: replyOf(newest, own), reply_all: replyAllOf(newest, own) },
      from: sendAs.map((s) => ({ address: s.address, name: s.name, signature: s.signature ? signatureText(s.signature) : "" })),
      default_from: defaultFrom(newest, sendAs, account.address),
      subject: headerOf(newest, "Subject") || headerOf(thread.messages.at(0), "Subject"),
      people,
    };
  }

  /** Stop a held mail reply before it goes (plan 076); false when it already went or was never held here. */
  unsend(accountId: string, outboxId: string): boolean {
    return this.outbox?.undo(accountId, outboxId) ?? false;
  }

  /** The whole thread as the card draws it: every message with its sender and time, and mail without the quoted thread under it. */
  async read(accountId: string, threadId: string): Promise<OutsideMessage[]> {
    const account = this.need(accountId);
    const reader = this.opts.cardView?.[account.provider] ?? this.opts.threadText[account.provider];
    const readThread = () => reader(accountId, threadId);
    const messages = await readThread().catch(async (err: unknown) => {
      const wait = err instanceof SlackError && err.code === "ratelimited" ? err.retryAfterMs : null;
      if (wait === null || wait > READ_WAIT_MAX_MS) throw err;
      await (this.opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(wait);
      return readThread();
    });
    // A reader that gives no id leaves the message's place in the thread, which is stable since a thread is read whole.
    return messages.map((m, i) => ({
      id: m.id ?? `at-${i}`,
      sender: m.sender,
      at: m.at,
      text: account.provider === "gmail" ? withoutQuoted(m.text) : m.text,
      mine: m.mine === true,
      ...(account.provider === "gmail" && m.html ? { html: m.html } : {}),
      ...(m.avatar ? { avatar: m.avatar } : {}),
      ...(m.in_thread ? { in_thread: true } : {}),
      ...(m.unread ? { unread: true } : {}),
      ...(m.replies ? { replies: m.replies } : {}),
      ...(m.more_after ? { more_after: true } : {}),
      ...(m.body ? { body: m.body } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    }));
  }

  /**
   * Send the person's reply in the thread, then make the key's move (plan 070, R11, KTD6): `read` marks the thread read,
   * `later` leaves it unread on its newest incoming message and marks the record waiting for an answer, and `archive`
   * archives it. Gmail answers the newest message that is not a draft, as `mail` addresses it (plan 076), or to
   * everyone on it but the person when it does not; Slack posts in the DM, or in the thread for an Activity card. A
   * mail reply with an `outboxId` is held for its undo first, and answers as undone when `unsend` stops it. A send that
   * fails throws its reason and nothing is marked. Once sent, the move's failure is answered, not thrown, so the client
   * tries the move again on its own and never sends twice.
   */
  async reply(
    accountId: string,
    threadId: string,
    text: string,
    then: ReplyThen,
    mail: MailAddressing | null = null,
    outboxId: string | null = null,
  ): Promise<OutsideReplied> {
    const body = text.trim();
    if (!body) throw new Error("the reply is empty");
    if (body.length > MAX_REPLY) throw new Error("that reply is too long to send");
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    if (mail && account.provider !== "gmail") throw new Error("only a mail reply has recipients");
    if (mail && mail.to.length + mail.cc.length + mail.bcc.length === 0) throw new Error("add someone to send it to");
    const held = { outbox_id: outboxId ?? "", account_id: accountId, thread_id: threadId, text: body, then, mail };
    if (this.outbox && outboxId && account.provider === "gmail") return this.outbox.hold(held);
    return this.sendNow(held);
  }

  /** The send itself and the move after it, at once or once a hold is over. */
  private async sendNow(held: Omit<HeldReply, "send_at">): Promise<OutsideReplied> {
    const { account_id: accountId, thread_id: threadId, text: body, then, mail } = held;
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    const sender = this.opts.clientFor(account);
    if (sender.provider === "gmail") await this.sendMail(account, sender.client, threadId, body, mail);
    else {
      const { channel, ts } = slackPlace(threadId);
      await sender.client.postReply({ channel, ...(ts ? { thread_ts: ts } : {}), text: body });
    }
    log("outside:replied", { provider: account.provider, then, mode: mail?.mode ?? null });
    try {
      return { sent: true, then_error: null, change: await this.follow(accountId, threadId, then) };
    } catch (err) {
      return { sent: true, then_error: messageOf(err), change: null };
    }
  }

  /**
   * A mail reply as Gmail writes one (plan 076): from the chosen address with its signature, to whom `mail` says (or
   * everyone on the newest message), with that message quoted under it, or set out with its files for a forward.
   */
  private async sendMail(account: AccountRecord, client: SendGmail, threadId: string, body: string, mail: MailAddressing | null): Promise<void> {
    const [thread, sendAs] = await Promise.all([client.getThread(threadId, "full"), client.sendAs()]);
    const newest = replyTarget(thread.messages);
    if (!newest) throw new Error("that thread is empty in Gmail now");
    const own = ownAddresses(account, sendAs);
    const fromAddress = (mail?.from ?? defaultFrom(newest, sendAs, account.address)).toLowerCase();
    const from = sendAs.find((s) => s.address.toLowerCase() === fromAddress);
    if (!from) throw new Error("that is not an address you send from in Gmail");
    const forward = mail?.mode === "forward";
    const { to, cc } = mail ?? replyAllOf(newest, own);
    const bcc = mail?.bcc ?? [];
    if (to.length + cc.length + bcc.length === 0) throw new Error(forward ? "add someone to forward it to" : "no one in that thread to reply to");
    const { text, html } = mailParts(newest);
    const subject = headerOf(newest, "Subject") || headerOf(thread.messages.at(0), "Subject");
    const out = mailBody({
      text: body,
      signature: mail?.signature === false || !from.signature ? null : from.signature,
      quoted: {
        from: headerOf(newest, "From"),
        at: new Date(Number(newest.internalDate)).toISOString(),
        to: headerOf(newest, "To"),
        cc: headerOf(newest, "Cc"),
        subject,
        text,
        html,
      },
      forward,
      ...(this.opts.zone ? { zone: this.opts.zone } : {}),
    });
    await client.sendReply({
      threadId,
      inReplyTo: headerOf(newest, "Message-ID"),
      references: headerOf(newest, "References").split(/\s+/).filter(Boolean),
      from: fromHeader(from.address, from.name),
      to,
      cc,
      bcc,
      subject: forward ? forwardSubject(subject) : replySubject(subject),
      body: out.text,
      html: out.html,
      ...(forward ? { attachments: await forwarded(client, newest) } : {}),
    });
    // Whoever the person writes to comes first in their suggestions after this.
    this.opts.people?.saw(account.account_id, [...to, ...cc, ...bcc].flatMap(headerPeople), (this.opts.now?.() ?? new Date()).getTime(), own);
  }

  /** The move after a sent reply, as the card's own move frames write it back. */
  private follow(accountId: string, threadId: string, then: ReplyThen): Promise<OutsideChange | null> {
    const { threads } = this.opts;
    if (then === "archive") return threads.archive(accountId, threadId);
    if (then === "read") return threads.markRead(accountId, threadId);
    // The wait is loki's own record and is marked first, so it holds even when Gmail refuses the unread mark.
    threads.markWaiting(accountId, threadId);
    return threads.markUnread(accountId, threadId);
  }

  private need(accountId: string): AccountRecord {
    const account = this.opts.accounts.get(accountId);
    if (!account) throw new Error("that account is not connected on this Mac");
    return account;
  }
}

/** The person's addresses in an account: the one it signed in with and every one they send from. */
function ownAddresses(account: AccountRecord, sendAs: readonly GmailSendAs[]): string[] {
  return [account.address, ...sendAs.map((s) => s.address)].map((a) => a.toLowerCase());
}

/**
 * The address a thread is answered from, as Gmail picks it: the one of the person's addresses the message came to,
 * else their default in Gmail, else the account's own.
 */
function defaultFrom(message: GmailMessage, sendAs: readonly GmailSendAs[], accountAddress: string): string {
  const to = ["To", "Cc", "Delivered-To"].flatMap((h) => headerPeople(headerOf(message, h)).map((p) => p.address));
  const addressed = sendAs.find((s) => to.includes(s.address.toLowerCase()));
  return (addressed ?? sendAs.find((s) => s.isDefault) ?? sendAs.at(0))?.address ?? accountAddress;
}

/** The files a forward carries: the forwarded message's own, read from Gmail, refused when they are too big to send. */
async function forwarded(client: Pick<SendGmail, "attachment">, message: GmailMessage): Promise<GmailAttachment[]> {
  const files = mailAttachments(message);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_FORWARD_BYTES) throw new Error("its files are too big to forward from loki: forward it from Gmail");
  const out: GmailAttachment[] = [];
  for (const f of files) out.push({ filename: f.filename, mimeType: f.mimeType, data: await client.attachment(message.id, f.attachmentId) });
  return out;
}
