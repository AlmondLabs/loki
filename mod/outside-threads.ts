import { messageOf } from "../core/errors.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import type {
  AccountProvider,
  EmojiChoice,
  MailAddressing,
  MailCompose,
  OutsideChange,
  OutsideRead,
  OutsideReplied,
  OutsideWindowAsk,
  ReplyThen,
  SlackPerson,
} from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import type { AccountThreads, ThreadRecord } from "./account-threads.ts";
import type { GmailAttachment, GmailClient, GmailMessage, GmailSendAs } from "./gmail.ts";
import type { JiraClient } from "./jira.ts";
import { mailAttachments, mailParts, type ThreadMessage, type ThreadText } from "./handoff.ts";
import type { CardView } from "./slack-view.ts";
import { log } from "./log.ts";
import { forwardSubject, fromHeader, mailBody, signatureText } from "./mail-compose.ts";
import { MailOutbox, type HeldReply, type MailOutboxOptions } from "./mail-outbox.ts";
import { headerPeople } from "../core/mail-header.ts";
import type { MailPeople } from "./mail-people.ts";
import { headerOf, replyAllOf, replyOf, replySubject, replyTarget, slackPlace } from "./reply-proposals.ts";
import { SlackError, type SlackClient } from "./slack.ts";
import { reactionEmoji, searchEmoji } from "./slack-markup.ts";
import type { SlackPeople } from "./slack-people.ts";

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

/** What the person's own Slack moves need: the post, a reaction, and the workspace's emoji to pick one from (plan 079). */
export type SendSlack = Pick<SlackClient, "postReply" | "react" | "emojiList" | "frequentEmoji">;

/** What the person's comment on a Jira card needs (plan 2026-11-10-1451, U7): the post, Jira's only write. */
export type SendJira = Pick<JiraClient, "postComment">;

/** One account's sending client. */
export type SendClient = { provider: "gmail"; client: SendGmail } | { provider: "slack"; client: SendSlack } | { provider: "jira"; client: SendJira };

/** What the thread reader and the reply are built from; the clients and readers are injected so tests own them. */
export interface OutsideThreadsOptions {
  accounts: Pick<Accounts, "get">;
  threads: Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "markWaiting" | "markDealt" | "clearSeeds"> & {
    /** A card's record, for what its window is built around (plan 077). */
    get: (
      accountId: string,
      threadId: string,
    ) => (Pick<ThreadRecord, "dealt_message_id" | "brought_ids" | "newest_message_id"> & { place?: string | null }) | null;
  };
  /** The whole thread from its account, oldest first: the readers a hand-off uses (mod/handoff.ts). */
  threadText: Record<AccountProvider, ThreadText>;
  /** A card's own reader where it shows a window rather than the whole thread: Slack's (plan 074, plan 077) and Jira's (KTD14). */
  cardView?: Partial<Record<AccountProvider, CardView>>;
  clientFor: (account: AccountRecord) => SendClient;
  /** Waiting out a rate limit before reading again; a timer when not given. */
  sleep?: (ms: number) => Promise<void>;
  /** Where held mail replies wait for their undo (plan 076); without it a mail reply goes at once. */
  outbox?: Omit<MailOutboxOptions, "send">;
  /** The people in each Slack workspace, for the reply box's @ suggestions and the mentions a reply sends (plan 082). */
  slackPeople?: Pick<SlackPeople, "search" | "mentions">;
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

/** How many quick reactions a Slack card offers from the person's most used (plan 084): three on the bar, five on keys. */
const QUICK_COUNT = 5;

/** How long the person's most-used emoji are kept before Slack is asked again, so a new favourite shows within minutes. */
const FREQUENT_TTL_MS = 10 * 60_000;

/** The most a forward carries in files: under Gmail's 25 MB once the files are written out as text. */
const MAX_FORWARD_BYTES = 17 * 1024 * 1024;

/** Reads an outside card's thread and sends the person's reply in it. */
export class OutsideThreads {
  private readonly opts: OutsideThreadsOptions;
  private readonly outbox: MailOutbox | null;
  /** Each Slack account's own emoji, read once while loki runs for the emoji search; a failed read is tried again. */
  private readonly ownEmoji = new Map<string, Promise<Record<string, string>>>();
  /** Each workspace's most-used emoji (plan 084) and when they were read, read again after FREQUENT_TTL_MS. */
  private readonly frequent = new Map<string, { at: number; names: Promise<string[]> }>();

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

  /**
   * Add the person's emoji reaction to a message on a Slack card, or take it back (plan 079). Like a reply, only the
   * person's own frame reaches this; agents never react. It moves nothing on the card.
   */
  async react(accountId: string, threadId: string, messageId: string, name: string, on: boolean): Promise<void> {
    const sender = this.slackSender(accountId);
    const { channel } = slackPlace(threadId);
    await sender.react({ channel, ts: messageId, name, on });
    log("outside:reacted", { provider: "slack", on });
  }

  /** The emoji a Slack account can react with whose names hold `query`, the workspace's own included (plan 079). */
  async searchEmoji(accountId: string, query: string): Promise<EmojiChoice[]> {
    const sender = this.slackSender(accountId);
    let own = this.ownEmoji.get(accountId);
    if (!own) {
      own = sender.emojiList().catch(() => {
        this.ownEmoji.delete(accountId);
        return {};
      });
      this.ownEmoji.set(accountId, own);
    }
    if (query.trim()) return searchEmoji(query, await own);
    // An empty search is the person's quick reactions (plan 084): what they use most in Slack, as Slack's hover bar
    // shows them. The card fills up to five with its own when Slack keeps fewer.
    const [names, emoji] = await Promise.all([this.frequentOf(accountId, sender), own]);
    const quick: EmojiChoice[] = [];
    for (const name of names) {
      const drawn = reactionEmoji(name, { emoji: (n) => emoji[n] ?? null });
      if (drawn) quick.push({ name, emoji: drawn });
      if (quick.length === QUICK_COUNT) break;
    }
    return quick;
  }

  /** The person's most-used emoji in the workspace, read again once they are FREQUENT_TTL_MS old; none when unreadable. */
  private frequentOf(accountId: string, sender: SendSlack): Promise<string[]> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    const had = this.frequent.get(accountId);
    if (had && now - had.at < FREQUENT_TTL_MS) return had.names;
    const names = sender.frequentEmoji().catch(() => {
      this.frequent.delete(accountId);
      return [];
    });
    this.frequent.set(accountId, { at: now, names });
    return names;
  }

  /** A connected Slack account's own client, or why there is none. */
  /** The people in a Slack account's workspace whose handle or name holds `query` (plan 082), for @ suggestions. */
  async searchPeople(accountId: string, query: string): Promise<SlackPerson[]> {
    if (this.need(accountId).provider !== "slack") throw new Error("only a Slack account has people to mention");
    if (!this.opts.slackPeople) return [];
    return this.opts.slackPeople.search(accountId, query);
  }

  private slackSender(accountId: string): SendSlack {
    const account = this.need(accountId);
    if (account.provider !== "slack") throw new Error("only a Slack message takes a reaction");
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    const sender = this.opts.clientFor(account);
    if (sender.provider !== "slack") throw new Error("only a Slack message takes a reaction");
    return sender.client;
  }

  /** Stop a held mail reply before it goes (plan 076); false when it already went or was never held here. */
  unsend(accountId: string, outboxId: string): boolean {
    return this.outbox?.undo(accountId, outboxId) ?? false;
  }

  /**
   * The thread as the card draws it: every message with its sender and time, and mail without the quoted thread under
   * it; for a Slack or Jira card, the window around what is new, or what `ask` asks for (plan 077, KTD14), from the
   * card's record, and for a Jira card the ticket's address in the browser.
   */
  async read(accountId: string, threadId: string, ask: OutsideWindowAsk = {}): Promise<OutsideRead> {
    const account = this.need(accountId);
    const view = this.opts.cardView?.[account.provider];
    const record = this.opts.threads.get(accountId, threadId);
    const facts = {
      dealt_message_id: record?.dealt_message_id ?? null,
      brought_ids: record?.brought_ids ?? [],
      newest_message_id: record?.newest_message_id ?? null,
      ...(record?.place ? { place: record.place } : {}),
    };
    const readThread = async (): Promise<{ messages: ThreadMessage[]; window: OutsideRead["window"]; link?: string }> =>
      view ? view(accountId, threadId, facts, ask) : { messages: await this.opts.threadText[account.provider](accountId, threadId), window: null };
    const read = await readThread().catch(async (err: unknown) => {
      const wait = err instanceof SlackError && err.code === "ratelimited" ? err.retryAfterMs : null;
      if (wait === null || wait > READ_WAIT_MAX_MS) throw err;
      await (this.opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(wait);
      return readThread();
    });
    // A reader that gives no id leaves the message's place in the thread, which is stable since a thread is read whole.
    const messages = read.messages.map((m, i) => ({
      id: m.id ?? `at-${i}`,
      sender: m.sender,
      at: m.at,
      text: account.provider === "gmail" ? withoutQuoted(m.text) : m.text,
      mine: m.mine === true,
      ...(account.provider === "gmail" && m.html ? { html: m.html } : {}),
      ...(account.provider === "gmail" && m.to ? { to: m.to } : {}),
      ...(account.provider === "gmail" && m.cc ? { cc: m.cc } : {}),
      ...(account.provider === "gmail" && m.files?.length ? { files: m.files } : {}),
      ...(m.avatar ? { avatar: m.avatar } : {}),
      ...(m.in_thread ? { in_thread: true } : {}),
      ...(m.unread ? { unread: true } : {}),
      ...(m.replies ? { replies: m.replies } : {}),
      ...(m.more_after ? { more_after: true } : {}),
      ...(m.body ? { body: m.body } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.brought ? { brought: true } : {}),
      ...(m.new_replies ? { new_replies: m.new_replies } : {}),
      ...(m.reactions?.length ? { reactions: m.reactions } : {}),
      ...(m.slack_files?.length ? { slack_files: m.slack_files } : {}),
    }));
    return { messages, window: read.window, ...(read.link ? { link: read.link } : {}) };
  }

  /**
   * Send the person's reply in the thread, then make the key's move (plan 070, R11, KTD6): `read` marks the thread read,
   * `later` leaves it unread on its newest incoming message and marks the record waiting for an answer, and `archive`
   * archives it, and `stay` makes none (plan 083). Gmail answers the newest message that is not a draft, as `mail`
   * addresses it (plan 076), or to everyone on it but the person when it does not; Slack posts in the DM, or in the
   * thread for an Activity card; Jira posts a comment on the ticket as plain text, and leaves its events new. A
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
    threadTs: string | null = null,
  ): Promise<OutsideReplied> {
    const body = text.trim();
    if (!body) throw new Error("the reply is empty");
    if (body.length > MAX_REPLY) throw new Error("that reply is too long to send");
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    if (mail && account.provider !== "gmail") throw new Error("only a mail reply has recipients");
    if (threadTs && account.provider !== "slack") throw new Error("only a Slack reply goes into a thread the card opened");
    if (mail && mail.to.length + mail.cc.length + mail.bcc.length === 0) throw new Error("add someone to send it to");
    const held = { outbox_id: outboxId ?? "", account_id: accountId, thread_id: threadId, text: body, then, mail };
    if (this.outbox && outboxId && account.provider === "gmail") return this.outbox.hold(held);
    return this.sendNow(held, threadTs);
  }

  /** The send itself and the move after it, at once or once a hold is over. */
  private async sendNow(held: Omit<HeldReply, "send_at">, threadTs: string | null = null): Promise<OutsideReplied> {
    const { account_id: accountId, thread_id: threadId, text: body, then, mail } = held;
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    const sender = this.opts.clientFor(account);
    // Replying is dealing with what came before, whichever key follows (plan 077, R5). A Jira comment is not: the
    // ticket's events stay new until the person reads the card (KTD11, AE1).
    let deals = true;
    switch (sender.provider) {
      case "gmail":
        await this.sendMail(account, sender.client, threadId, body, mail);
        break;
      case "slack": {
        // A thread the person opened on the card (plan 085) is where they are writing, else the card's own place.
        const place = slackPlace(threadId);
        const { channel } = place;
        const ts = threadTs ?? place.ts;
        // People who cannot be read leave each @handle as typed; the reply still goes.
        const mentions = (await this.opts.slackPeople?.mentions(accountId, body).catch(() => null)) ?? new Map<string, string>();
        await sender.client.postReply({ channel, ...(ts ? { thread_ts: ts } : {}), text: body, mentions });
        break;
      }
      case "jira":
        // Posted once: a post that fails or times out is reported and never tried again, since a retry could post the
        // comment twice (plan 2026-11-10-1451, KTD11). The thread id is the ticket's own id.
        await sender.client.postComment(threadId, body);
        deals = false;
        // The box held any comment the person approved, so what they sent is it, as they left it (KTD18).
        this.opts.threads.clearSeeds(accountId, threadId);
        break;
    }
    log("outside:replied", { provider: account.provider, then, mode: mail?.mode ?? null });
    if (deals) this.opts.threads.markDealt(accountId, threadId);
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
    // Sent alone (plan 083): the card stays for the person's own next move.
    if (then === "stay") return Promise.resolve(null);
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
  return Promise.all(files.map(async (f) => ({ filename: f.filename, mimeType: f.mimeType, data: await client.attachment(message.id, f.attachmentId) })));
}
