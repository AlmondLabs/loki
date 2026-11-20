import { messageOf } from "../core/errors.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import type {
  ReplyMention,
  AccountProvider,
  EmojiChoice,
  MailAddressing,
  MailCompose,
  OutsideChange,
  OutsideRead,
  OutsideReplied,
  OutsideWindow,
  OutsideWindowAsk,
  ReplyThen,
  SlackPerson,
} from "../core/frame-types.ts";
import type { AccountRecord, Accounts } from "./accounts.ts";
import type { AccountThreads, ThreadRecord } from "./account-threads.ts";
import { OUTBOX_HEADER, type GmailAttachment, type GmailClient, type GmailMessage, type GmailSendAs } from "./gmail.ts";
import { JiraError, type JiraClient } from "./jira.ts";
import { mailAttachments, mailParts } from "./account-ops/gmail.ts";
import type { ThreadMessage, ThreadText } from "./account-ops/thread.ts";
import type { CardView } from "./slack-view.ts";
import { log } from "./log.ts";
import { forwardSubject, fromHeader, mailBody, signatureText } from "./mail-compose.ts";
import { MailOutbox, type HeldFile, type HeldProposal, type HeldReply, type HeldTarget, type MailOutboxOptions } from "./mail-outbox.ts";
import { headerPeople } from "../core/mail-header.ts";
import type { MailPeople } from "./mail-people.ts";
import { fileTypeOf } from "./google-tools/core.ts";
import { bareAddresses, headerOf, peopleChange, replyAllOf, replyOf, replySubject, replyTarget, slackPlace } from "./reply-addressing.ts";
import { liveMentions } from "../core/mentions.ts";
import { MAY_HAVE_GONE, checkedFiles } from "./reply-proposals.ts";
import { SlackError, type SlackClient } from "./slack.ts";
import { reactionEmoji, searchEmoji } from "./slack-markup.ts";
import type { SlackPeople } from "./slack-people.ts";

export type SendGmail = Pick<GmailClient, "getThread" | "sendAs" | "sendReply" | "attachment" | "listMessages">;

export type SendSlack = Pick<SlackClient, "postReply" | "postWithFiles" | "react" | "emojiList" | "frequentEmoji" | "openDm">;

export type SendJira = Pick<JiraClient, "postComment" | "attachFiles" | "createIssue">;

export type SendClient = { provider: "gmail"; client: SendGmail } | { provider: "slack"; client: SendSlack } | { provider: "jira"; client: SendJira };

export interface AgentReply {
  outbox_id: string;
  account_id: string;
  thread_id: string;
  text: string;
  files: HeldFile[];
  attached: string[];
  people: { to: string[]; cc: string[] } | null;
  proposal: HeldProposal;
  mentions: ReplyMention[];
  target?: HeldTarget;
}

export interface PeopleChanged {
  to: string[];
  cc: string[];
  added: string[];
  removed: string[];
}

export interface AgentReplyReports {
  sent(held: HeldReply, result: string | null): void;
  notSent(held: HeldReply, note: { reason: string; at: string }, people: PeopleChanged | null): void;
  attached(proposal: HeldProposal, names: string[]): void;
}

export interface OutsideThreadsOptions {
  accounts: Pick<Accounts, "get">;
  threads: Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "markWaiting" | "markDealt" | "clearSeeds"> &
    Partial<Pick<AccountThreads, "markNotSent">> & {
      get: (
        accountId: string,
        threadId: string,
      ) => (Pick<ThreadRecord, "dealt_message_id" | "brought_ids" | "newest_message_id"> & { place?: string | null }) | null;
    };
  threadText: Record<AccountProvider, ThreadText>;
  cardView?: Partial<Record<AccountProvider, CardView<OutsideWindow | null>>>;
  clientFor: (account: AccountRecord) => SendClient;
  sleep?: (ms: number) => Promise<void>;
  outbox?: Omit<MailOutboxOptions, "send">;
  slackPeople?: Pick<SlackPeople, "search">;
  people?: Pick<MailPeople, "top" | "saw">;
  zone?: string;
  now?: () => Date;
}

const READ_WAIT_MAX_MS = 30_000;

const MAX_REPLY = 30_000;

const QUICK_COUNT = 5;

const FREQUENT_TTL_MS = 10 * 60_000;

/** The most a forward carries in files: under Gmail's 25 MB once the files are written out as text. */
const MAX_FORWARD_BYTES = 17 * 1024 * 1024;

export class OutsideThreads {
  private readonly opts: OutsideThreadsOptions;
  private readonly outbox: MailOutbox | null;
  private readonly ownEmoji = new Map<string, Promise<Record<string, string>>>();
  private readonly frequent = new Map<string, { at: number; names: Promise<string[]> }>();
  private reports: AgentReplyReports | null = null;
  private readonly changedPeople = new Map<string, PeopleChanged>();

  constructor(opts: OutsideThreadsOptions) {
    this.opts = opts;
    this.outbox = opts.outbox
      ? new MailOutbox({
          ...opts.outbox,
          send: (held) => this.sendNow(held),
          wentOut: (held) => this.wentOut(held),
          onNotSent: (held, note) => {
            if (!held.proposal) {
              void opts.threads.markNotSent?.(held.account_id, held.thread_id, held.outbox_id, note && { outbox_id: held.outbox_id, text: held.text, ...note });
              return;
            }
            const people = this.changedPeople.get(held.outbox_id) ?? null;
            this.changedPeople.delete(held.outbox_id);
            if (note) this.reports?.notSent(held, note, people);
          },
          onSent: (held, result) => {
            if (held.proposal) this.reports?.sent(held, result);
          },
        })
      : null;
  }

  reportAgentRepliesTo(reports: AgentReplyReports): void {
    this.reports = reports;
  }

  resume(): void {
    this.outbox?.resume();
  }

  holdAgentReply(reply: AgentReply): void {
    if (!this.outbox) throw new Error("replies are not held on this Mac");
    const body = reply.text.trim();
    if (!body && reply.files.length + reply.attached.length === 0 && reply.target?.kind !== "ticket") throw new Error("the reply is empty");
    if (body.length > MAX_REPLY) throw new Error("that reply is too long to send");
    const account = this.need(reply.account_id);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    if (account.provider === "gmail" && !reply.people) throw new Error("a mail reply needs the people its card showed");
    if (reply.target?.kind === "email" && account.provider !== "gmail") throw new Error("only a Gmail account sends a new email");
    if (reply.target?.kind === "dm" && account.provider !== "slack") throw new Error("only a Slack account opens a DM");
    if (reply.target?.kind === "ticket" && account.provider !== "jira") throw new Error("only a Jira site takes a new ticket");
    const named = [...reply.attached, ...reply.files.map((f) => f.name)];
    const text = account.provider === "jira" && named.length ? [body, `Attached: ${named.join(", ")}`].filter(Boolean).join("\n\n") : body;
    const mail: MailAddressing | null =
      account.provider === "gmail" && reply.people
        ? { mode: "reply_all", to: reply.people.to, cc: reply.people.cc, bcc: [], from: null, signature: true }
        : null;
    const held = this.outbox.hold({
      outbox_id: reply.outbox_id,
      account_id: reply.account_id,
      thread_id: reply.thread_id,
      text,
      then: "stay",
      mail,
      thread_ts: null,
      files: reply.files,
      proposal: reply.proposal,
      ...(reply.mentions.length ? { mentions: reply.mentions } : {}),
      ...(reply.target ? { target: reply.target } : {}),
    });
    void held.catch(() => undefined);
  }

  holds(outboxId: string): boolean {
    return this.outbox?.has(outboxId) ?? false;
  }

  acknowledge(outboxId: string): void {
    this.outbox?.acknowledge(outboxId);
  }

  wentOutIn(accountId: string, threadId: string, outboxId: string, target?: HeldTarget): Promise<boolean | null> {
    return this.wentOut({ outbox_id: outboxId, account_id: accountId, thread_id: threadId, ...(target ? { target } : {}) });
  }

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

  async react(accountId: string, threadId: string, messageId: string, name: string, on: boolean): Promise<void> {
    const sender = this.slackSender(accountId);
    const { channel } = slackPlace(threadId);
    await sender.react({ channel, ts: messageId, name, on });
    log("outside:reacted", { provider: "slack", on });
  }

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
    const [names, emoji] = await Promise.all([this.frequentOf(accountId, sender), own]);
    const quick: EmojiChoice[] = [];
    for (const name of names) {
      const drawn = reactionEmoji(name, { emoji: (n) => emoji[n] ?? null });
      if (drawn) quick.push({ name, emoji: drawn });
      if (quick.length === QUICK_COUNT) break;
    }
    return quick;
  }

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

  unsend(accountId: string, outboxId: string): boolean {
    return this.outbox?.undo(accountId, outboxId) ?? false;
  }

  resend(accountId: string, outboxId: string): Promise<OutsideReplied> {
    if (!this.outbox) return Promise.reject(new Error("replies are not held on this Mac"));
    return this.outbox.resend(accountId, outboxId);
  }

  discardUnsent(accountId: string, outboxId: string): boolean {
    return this.outbox?.discard(accountId, outboxId) ?? false;
  }

  private async wentOut(held: Pick<HeldReply, "outbox_id" | "account_id" | "thread_id" | "target">): Promise<boolean | null> {
    const sender = this.opts.clientFor(this.need(held.account_id));
    if (sender.provider !== "gmail") return null;
    if (held.target?.kind === "email") return (await sender.client.listMessages(`rfc822msgid:${held.target.message_id}`)).messages.length > 0;
    const thread = await sender.client.getThread(held.thread_id, "metadata");
    return thread.messages.some((m) => headerOf(m, OUTBOX_HEADER) === held.outbox_id);
  }

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
    const readThread = async (): Promise<{ messages: ThreadMessage[]; window: OutsideRead["window"]; link?: string; ticket?: OutsideRead["ticket"] }> =>
      view ? view(accountId, threadId, facts, ask) : { messages: await this.opts.threadText[account.provider](accountId, threadId), window: null };
    const read = await readThread().catch(async (err: unknown) => {
      const wait = err instanceof SlackError && err.code === "ratelimited" ? err.retryAfterMs : null;
      if (wait === null || wait > READ_WAIT_MAX_MS) throw err;
      await (this.opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(wait);
      return readThread();
    });
    const messages = read.messages.map((m, i) => ({
      id: m.id ?? `at-${i}`,
      sender: m.sender,
      at: m.at,
      text: account.provider === "gmail" ? withoutQuoted(m.text) : m.text,
      mine: m.mine === true,
      ...(account.provider === "gmail" && m.html ? { html: m.html } : {}),
      ...(account.provider === "gmail" && m.html && m.inline_images ? { inline_images: m.inline_images } : {}),
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
      ...(m.mentions_me ? { mentions_me: true } : {}),
      ...(m.new_replies ? { new_replies: m.new_replies } : {}),
      ...(m.reactions?.length ? { reactions: m.reactions } : {}),
      ...(m.slack_files?.length ? { slack_files: m.slack_files } : {}),
    }));
    return { messages, window: read.window, ...(read.link ? { link: read.link } : {}), ...(read.ticket ? { ticket: read.ticket } : {}) };
  }

  async reply(
    accountId: string,
    threadId: string,
    text: string,
    then: ReplyThen,
    mail: MailAddressing | null = null,
    outboxId: string | null = null,
    threadTs: string | null = null,
    mentions: readonly ReplyMention[] = [],
  ): Promise<OutsideReplied> {
    const body = text.trim();
    if (!body) throw new Error("the reply is empty");
    if (body.length > MAX_REPLY) throw new Error("that reply is too long to send");
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    if (mail && account.provider !== "gmail") throw new Error("only a mail reply has recipients");
    if (threadTs && account.provider !== "slack") throw new Error("only a Slack reply goes into a thread the card opened");
    if (mail && mail.to.length + mail.cc.length + mail.bcc.length === 0) throw new Error("add someone to send it to");
    const picked = liveMentions(body, mentions);
    const held = {
      outbox_id: outboxId ?? "",
      account_id: accountId,
      thread_id: threadId,
      text: body,
      then,
      mail,
      thread_ts: threadTs,
      ...(picked.length ? { mentions: picked } : {}),
    };
    if (this.outbox && outboxId && account.provider === "gmail") return this.outbox.hold(held);
    return this.sendNow(held);
  }

  private async sendNow(held: Omit<HeldReply, "send_at">): Promise<OutsideReplied> {
    const { account_id: accountId, thread_id: threadId, text: body, then, mail } = held;
    const account = this.need(accountId);
    if (account.status !== "connected") throw new Error("that account is not connected now: connect it again in Preferences › Accounts");
    const sender = this.opts.clientFor(account);
    const agent = held.proposal != null;
    const files = held.files?.length ? await checkedFiles(held.files) : [];
    let deals = !agent;
    let created: string | null = null;
    const target = held.target;
    switch (sender.provider) {
      case "gmail":
        if (target?.kind === "email") {
          created = await this.sendNewMail(account, sender.client, body, mail, target, held.outbox_id, files, held.mentions ?? []);
          deals = false;
        } else await this.sendMail(account, sender.client, threadId, body, mail, held.outbox_id || null, agent, files, held.mentions ?? []);
        break;
      case "slack": {
        const place = target?.kind === "dm" ? { channel: await sender.client.openDm(target.people), ts: null } : slackPlace(threadId);
        if (target) deals = false;
        const { channel } = place;
        const ts = held.thread_ts ?? place.ts;
        const where = { channel, ...(ts ? { thread_ts: ts } : {}), text: body, mentions: held.mentions ?? [] };
        try {
          const dm = target?.kind === "dm" || channel.startsWith("D");
          if (files.length) {
            await sender.client.postWithFiles({ ...where, files });
            created = ts ? `${channel}:${ts}` : dm ? channel : null;
          } else {
            const posted = await sender.client.postReply(where);
            created = ts ? `${channel}:${ts}` : dm || !posted.ts ? channel : `${channel}:${posted.ts}`;
          }
        } catch (err) {
          if (agent) throw unclearPost(err, "Slack");
          throw err;
        }
        break;
      }
      case "jira":
        if (target?.kind === "ticket") {
          try {
            const made = await sender.client.createIssue({
              project: target.project,
              type_id: target.type_id,
              title: target.title,
              description: body,
              mentions: held.mentions ?? [],
              assignee: target.assignee,
              priority_id: target.priority_id,
              labels: target.labels,
              parent: target.parent,
            });
            created = made.key || null;
          } catch (err) {
            if (err instanceof JiraError && err.status >= 500) throw new Error(`Jira failed while creating it: ${MAY_HAVE_GONE}`);
            if (agent) throw unclearPost(err, "Jira");
            throw err;
          }
          deals = false;
          break;
        }
        if (files.length) {
          await sender.client.attachFiles(threadId, files);
          if (held.proposal)
            this.reports?.attached(
              held.proposal,
              files.map((f) => f.name),
            );
        }
        try {
          await sender.client.postComment(threadId, body, held.mentions ?? []);
        } catch (err) {
          if (agent) throw unclearPost(err, "Jira");
          throw err;
        }
        deals = false;
        if (!agent) this.opts.threads.clearSeeds(accountId, threadId);
        break;
    }
    log("outside:replied", { provider: account.provider, then, mode: mail?.mode ?? null, agent, target: target?.kind ?? null });
    if (deals) this.opts.threads.markDealt(accountId, threadId);
    const made = created && agent ? { created } : {};
    if (target) return { sent: true, then_error: null, change: null, ...made };
    try {
      return { sent: true, then_error: null, change: await this.follow(accountId, threadId, then), ...made };
    } catch (err) {
      return { sent: true, then_error: messageOf(err), change: null, ...made };
    }
  }

  private async sendNewMail(
    account: AccountRecord,
    client: SendGmail,
    body: string,
    mail: MailAddressing | null,
    target: { subject: string; message_id: string },
    outboxId: string,
    files: ReadonlyArray<{ name: string; data: Buffer }>,
    mentions: readonly ReplyMention[],
  ): Promise<string | null> {
    if (!mail) throw new Error("a new email needs the people its card showed");
    const sendAs = await client.sendAs();
    const from = sendAs.find((s) => s.isDefault) ?? sendAs.at(0);
    const added = mentionCc([...mail.to, ...mail.cc], mentions);
    if (mail.to.length + mail.cc.length + added.length === 0) throw new Error("a new email needs someone to send it to");
    const out = mailBody({ text: body, signature: from?.signature || null, quoted: null, forward: false, ...(this.opts.zone ? { zone: this.opts.zone } : {}) });
    const sent = await client.sendReply({
      threadId: "",
      inReplyTo: "",
      references: [],
      from: from ? fromHeader(from.address, from.name) : account.address,
      to: mail.to,
      cc: [...mail.cc, ...added],
      subject: target.subject,
      body: out.text,
      html: out.html,
      messageId: target.message_id,
      outboxId,
      ...(files.length ? { attachments: files.map((f) => ({ filename: f.name, mimeType: fileTypeOf(f.name), data: f.data })) } : {}),
    });
    log("outside:new-mail", { files: files.length });
    return sent.threadId ?? null;
  }

  private async sendMail(
    account: AccountRecord,
    client: SendGmail,
    threadId: string,
    body: string,
    mail: MailAddressing | null,
    outboxId: string | null,
    agent = false,
    files: ReadonlyArray<{ name: string; data: Buffer }> = [],
    mentions: readonly ReplyMention[] = [],
  ): Promise<void> {
    const [thread, sendAs] = await Promise.all([client.getThread(threadId, "full"), client.sendAs()]);
    const newest = replyTarget(thread.messages);
    if (!newest) throw new Error("that thread is empty in Gmail now");
    const own = ownAddresses(account, sendAs);
    if (agent && mail) {
      const change = peopleChange(newest, own, mail);
      if (change.added.length || change.removed.length) {
        if (outboxId) this.changedPeople.set(outboxId, { ...replyAllOf(newest, own), ...change });
        throw new Error(peopleWords(change));
      }
    }
    const fromAddress = (mail?.from ?? defaultFrom(newest, sendAs, account.address)).toLowerCase();
    const from = sendAs.find((s) => s.address.toLowerCase() === fromAddress);
    if (!from) throw new Error("that is not an address you send from in Gmail");
    const forward = mail?.mode === "forward";
    const people = mail ?? replyAllOf(newest, own);
    const added = mentionCc([...people.to, ...people.cc, ...(mail?.bcc ?? [])], mentions);
    const { to } = people;
    const cc = [...people.cc, ...added];
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
      ...(files.length ? { attachments: files.map((f) => ({ filename: f.name, mimeType: fileTypeOf(f.name), data: f.data })) } : {}),
      ...(outboxId ? { outboxId } : {}),
    });
    this.opts.people?.saw(account.account_id, [...to, ...cc, ...bcc].flatMap(headerPeople), (this.opts.now?.() ?? new Date()).getTime(), own);
  }

  private follow(accountId: string, threadId: string, then: ReplyThen): Promise<OutsideChange | null> {
    const { threads } = this.opts;
    if (then === "stay") return Promise.resolve(null);
    if (then === "archive") return threads.archive(accountId, threadId);
    if (then === "read") return threads.markRead(accountId, threadId);
    threads.markWaiting(accountId, threadId);
    return threads.markUnread(accountId, threadId);
  }

  private need(accountId: string): AccountRecord {
    const account = this.opts.accounts.get(accountId);
    if (!account) throw new Error("that account is not connected on this Mac");
    return account;
  }
}

function unclearPost(err: unknown, service: "Slack" | "Jira"): Error {
  const timedOut = (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) || (err instanceof JiraError && err.code === "timeout");
  if (timedOut) return new Error(`${service} did not answer in time: ${MAY_HAVE_GONE}`);
  // fetch throws a TypeError when the connection fails, which may be after the request reached the service.
  if (err instanceof TypeError) return new Error(`the connection to ${service} was lost: ${MAY_HAVE_GONE}`);
  // Slack answering 200 with a body it would not let us read, or failing on its side, may still have posted.
  if (err instanceof SlackError && /^http_(200|5\d\d)$/.test(err.code)) return new Error(`Slack did not answer clearly: ${MAY_HAVE_GONE}`);
  return err instanceof Error ? err : new Error(messageOf(err));
}

function mentionCc(already: readonly string[], mentions: readonly ReplyMention[]): string[] {
  const on = new Set(already.flatMap((p) => bareAddresses([p])));
  const added: string[] = [];
  for (const m of mentions) {
    const address = m.address?.toLowerCase();
    if (!address || on.has(address)) continue;
    on.add(address);
    added.push(fromHeader(m.address ?? address, m.display));
  }
  return added;
}

function peopleWords(change: { added: string[]; removed: string[] }): string {
  const parts = [change.added.length ? `${change.added.join(", ")} joined` : "", change.removed.length ? `${change.removed.join(", ")} left` : ""];
  return `the thread's people changed since the card showed them (${parts.filter(Boolean).join("; ")}): check who it goes to and send it again`;
}

function ownAddresses(account: AccountRecord, sendAs: readonly GmailSendAs[]): string[] {
  return [account.address, ...sendAs.map((s) => s.address)].map((a) => a.toLowerCase());
}

function defaultFrom(message: GmailMessage, sendAs: readonly GmailSendAs[], accountAddress: string): string {
  const to = ["To", "Cc", "Delivered-To"].flatMap((h) => headerPeople(headerOf(message, h)).map((p) => p.address));
  const addressed = sendAs.find((s) => to.includes(s.address.toLowerCase()));
  return (addressed ?? sendAs.find((s) => s.isDefault) ?? sendAs.at(0))?.address ?? accountAddress;
}

async function forwarded(client: Pick<SendGmail, "attachment">, message: GmailMessage): Promise<GmailAttachment[]> {
  const files = mailAttachments(message);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_FORWARD_BYTES) throw new Error("its files are too big to forward from loki: forward it from Gmail");
  return Promise.all(files.map(async (f) => ({ filename: f.filename, mimeType: f.mimeType, data: await client.attachment(message.id, f.attachmentId) })));
}
