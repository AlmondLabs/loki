import { messageOf } from "../core/errors.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import type { AccountProvider, OutsideChange, OutsideRead, OutsideReplied, OutsideWindowAsk, ReplyThen } from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import type { AccountThreads, ThreadRecord } from "./account-threads.ts";
import type { GmailClient } from "./gmail.ts";
import type { ThreadMessage, ThreadText } from "./handoff.ts";
import type { CardView } from "./slack-view.ts";
import { log } from "./log.ts";
import { headerOf, replyAllOf, replySubject, replyTarget, slackPlace } from "./reply-proposals.ts";
import { SlackError, type SlackClient } from "./slack.ts";

/**
 * An outside card's thread for the person (plan 068): the whole thread to read on the card, and the person's own
 * reply, sent in it. This is the only place loki sends anything, and it is reached only by the reply frame the
 * person's own devices send (mod/frames/accounts.ts); no agent tool is built on it, so agents still never send (R18).
 */

/** What sending a reply needs of Gmail: the thread, to answer its newest message, the person's addresses, and the send. */
export type SendGmail = Pick<GmailClient, "getThread" | "sendAsAddresses" | "sendReply">;

/** What sending a reply needs of Slack: the post. */
export type SendSlack = Pick<SlackClient, "postReply">;

/** One account's sending client. */
export type SendClient = { provider: "gmail"; client: SendGmail } | { provider: "slack"; client: SendSlack };

/** What the thread reader and the reply are built from; the clients and readers are injected so tests own them. */
export interface OutsideThreadsOptions {
  accounts: Pick<Accounts, "get">;
  threads: Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "markWaiting" | "markDealt"> & {
    /** A card's record, for what its window is built around (plan 076). */
    get: (accountId: string, threadId: string) => Pick<ThreadRecord, "dealt_message_id" | "brought_ids"> | null;
  };
  /** The whole thread from its account, oldest first: the readers a hand-off uses (mod/handoff.ts). */
  threadText: Record<AccountProvider, ThreadText>;
  /** A card's own reader where it shows a window of more than the thread: Slack's (plan 074, plan 076). */
  cardView?: Partial<Record<AccountProvider, CardView>>;
  clientFor: (account: AccountRecord) => SendClient;
  /** Waiting out a rate limit before reading again; a timer when not given. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The longest rate-limit wait a thread read sits out before trying once more, the card showing it is still reading.
 * A longer wait is reported, so the card says why it shows only its last lines.
 */
const READ_WAIT_MAX_MS = 30_000;

/** The longest reply loki sends: well under Gmail's and Slack's own limits, and far past anything typed on a card. */
const MAX_REPLY = 30_000;

/** Reads an outside card's thread and sends the person's reply in it. */
export class OutsideThreads {
  private readonly opts: OutsideThreadsOptions;

  constructor(opts: OutsideThreadsOptions) {
    this.opts = opts;
  }

  /**
   * The thread as the card draws it: every message with its sender and time, and mail without the quoted thread under
   * it; for a Slack card, the window around what is new, or what `ask` asks for (plan 076), from the card's record.
   */
  async read(accountId: string, threadId: string, ask: OutsideWindowAsk = {}): Promise<OutsideRead> {
    const account = this.need(accountId);
    const view = this.opts.cardView?.[account.provider];
    const record = this.opts.threads.get(accountId, threadId);
    const facts = { dealt_message_id: record?.dealt_message_id ?? null, brought_ids: record?.brought_ids ?? [] };
    const readThread = async (): Promise<{ messages: ThreadMessage[]; window: OutsideRead["window"] }> =>
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
      ...(m.avatar ? { avatar: m.avatar } : {}),
      ...(m.in_thread ? { in_thread: true } : {}),
      ...(m.unread ? { unread: true } : {}),
      ...(m.replies ? { replies: m.replies } : {}),
      ...(m.more_after ? { more_after: true } : {}),
      ...(m.body ? { body: m.body } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.brought ? { brought: true } : {}),
      ...(m.new_replies ? { new_replies: m.new_replies } : {}),
    }));
    return { messages, window: read.window };
  }

  /**
   * Send the person's reply in the thread, then make the key's move (plan 070, R11, KTD6): `read` marks the thread read,
   * `later` leaves it unread on its newest incoming message and marks the record waiting for an answer, and `archive`
   * archives it. Gmail answers the newest message that is not a draft, to everyone on it but the person; Slack posts in
   * the DM, or in the thread for an Activity card. A send that fails throws its reason and nothing is marked. Once sent,
   * the move's failure is answered, not thrown, so the client tries the move again on its own and never sends twice.
   */
  async reply(accountId: string, threadId: string, text: string, then: ReplyThen): Promise<OutsideReplied> {
    const body = text.trim();
    if (!body) throw new Error("the reply is empty");
    if (body.length > MAX_REPLY) throw new Error("that reply is too long to send");
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    const sender = this.opts.clientFor(account);
    if (sender.provider === "gmail") {
      const thread = await sender.client.getThread(threadId, "metadata");
      const newest = replyTarget(thread.messages);
      if (!newest) throw new Error("that thread is empty in Gmail now");
      const own = [account.address, ...(await sender.client.sendAsAddresses())];
      const { to, cc } = replyAllOf(newest, own);
      if (to.length === 0 && cc.length === 0) throw new Error("no one in that thread to reply to");
      await sender.client.sendReply({
        threadId,
        inReplyTo: headerOf(newest, "Message-ID"),
        references: headerOf(newest, "References").split(/\s+/).filter(Boolean),
        to,
        cc,
        subject: replySubject(headerOf(newest, "Subject") || headerOf(thread.messages.at(0), "Subject")),
        body,
      });
    } else {
      const { channel, ts } = slackPlace(threadId);
      await sender.client.postReply({ channel, ...(ts ? { thread_ts: ts } : {}), text: body });
    }
    log("outside:replied", { provider: account.provider, then });
    // Replying is dealing with what came before, whichever key follows (plan 076, R5).
    this.opts.threads.markDealt(accountId, threadId);
    try {
      return { sent: true, then_error: null, change: await this.follow(accountId, threadId, then) };
    } catch (err) {
      return { sent: true, then_error: messageOf(err), change: null };
    }
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
