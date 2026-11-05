import { messageOf } from "../core/errors.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import type { AccountProvider, OutsideChange, OutsideMessage, OutsideReplied, ReplyThen } from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import type { AccountThreads } from "./account-threads.ts";
import type { GmailClient } from "./gmail.ts";
import type { ThreadText } from "./handoff.ts";
import { log } from "./log.ts";
import { headerOf, replyAllOf, replySubject, replyTarget, slackPlace } from "./reply-proposals.ts";
import type { SlackClient } from "./slack.ts";

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
  threads: Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "markWaiting">;
  /** The whole thread from its account, oldest first: the readers a hand-off uses (mod/handoff.ts). */
  threadText: Record<AccountProvider, ThreadText>;
  clientFor: (account: AccountRecord) => SendClient;
}

/** The longest reply loki sends: well under Gmail's and Slack's own limits, and far past anything typed on a card. */
const MAX_REPLY = 30_000;

/** Reads an outside card's thread and sends the person's reply in it. */
export class OutsideThreads {
  private readonly opts: OutsideThreadsOptions;

  constructor(opts: OutsideThreadsOptions) {
    this.opts = opts;
  }

  /** The whole thread as the card draws it: every message with its sender and time, and mail without the quoted thread under it. */
  async read(accountId: string, threadId: string): Promise<OutsideMessage[]> {
    const account = this.need(accountId);
    const messages = await this.opts.threadText[account.provider](accountId, threadId);
    // A reader that gives no id leaves the message's place in the thread, which is stable since a thread is read whole.
    return messages.map((m, i) => ({
      id: m.id ?? `at-${i}`,
      sender: m.sender,
      at: m.at,
      text: account.provider === "gmail" ? withoutQuoted(m.text) : m.text,
      mine: m.mine === true,
    }));
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
