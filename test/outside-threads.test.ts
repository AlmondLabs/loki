import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads } from "../mod/account-threads.ts";
import { Accounts } from "../mod/accounts.ts";
import { jiraAccountClient, type JiraSecret } from "../mod/jira.ts";
import { JiraSync, jiraOutsideSource } from "../mod/jira-sync.ts";
import { jiraCardView, jiraThreadText } from "../mod/jira-view.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideChange, OutsideFacts, OutsideMessage, OutsideWindow, OutsideWindowAsk } from "../core/frame-types.ts";
import { ownerAgentOf } from "../core/attention/model.ts";
import { FrameChatClient, type FrameRequest } from "../core/attention/chat-client.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import { agentLanes } from "../core/attention/lanes.ts";
import {
  OutsideCard,
  OutsideHeader,
  OutsideReply,
  OutsideThread,
  ticketAsk,
  withLoaded,
  type ReplyBoxControl,
  type ThreadState,
} from "../app/src/desk/outside-card.tsx";
import { JIRA_COMMENTS, jiraTicket } from "./fixtures/jira-card.ts";
import { outsideTitle, replyPlace } from "../app/src/desk/outside-words.ts";
import { KeysHint } from "../app/src/desk/catch-up-parts.tsx";
import { Decisions } from "../app/src/phone/inbox.tsx";
import { senderName } from "../app/src/desk/mail-thread.tsx";
import type { AccountRecord } from "../mod/accounts.ts";
import { PHONE_FRAMES, peerMeaning } from "../core/frames.ts";
import { accountFrames } from "../mod/frames/accounts.ts";
import type { GmailDraftInput, GmailMessage, GmailSendAs } from "../mod/gmail.ts";
import type { ThreadMessage } from "../mod/handoff.ts";
import { OutsideThreads } from "../mod/outside-threads.ts";
import type { CardFacts } from "../mod/slack-view.ts";
import { SlackError, type SlackDraftInput } from "../mod/slack.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { jiraItem, outsideItem } from "./fixtures/outside-item.ts";
import { JIRA_ADA, JIRA_ME, fakeJira } from "./fixtures/jira.ts";
import { must } from "./fixtures/must.ts";
import { bridgeOf, client, settled } from "./fixtures/frames.ts";

/** Outside cards for the person (plan 068): the whole thread on the card, and their own reply sent in it. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAIL = "gmail:ada@acme.com";
const SLACK = "slack:T1:U1";
const JIRA = "jira:acme.atlassian.net:557058:acc-me";
/** The window a fake card view answers with. */
const WINDOW: OutsideWindow = { view: "thread", thread_ts: "1", more_before: 3, more_after: false };

const account = (accountId: string, over: Partial<AccountRecord> = {}): AccountRecord => ({
  account_id: accountId,
  provider: accountId.startsWith("gmail:") ? "gmail" : accountId.startsWith("jira:") ? "jira" : "slack",
  address: accountId.startsWith("gmail:") ? "ada@acme.com" : accountId.startsWith("jira:") ? "acme.atlassian.net" : "Acme",
  owner_agent_id: "agent-work",
  status: "connected",
  connected_at: "2026-11-01T00:00:00.000Z",
  backfill: {},
  ...over,
});

const message = (id: string, at: number, headers: Record<string, string>, labelIds: string[] = ["INBOX"]): GmailMessage => ({
  id,
  threadId: "t1",
  labelIds,
  snippet: "",
  historyId: "1",
  internalDate: String(at),
  payload: {
    mimeType: "text/plain",
    filename: "",
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: { size: 0 },
    parts: [],
  },
});

/** OutsideThreads with fake clients and readers, recording what was sent and archived. */
function threads(
  opts: {
    accounts?: AccountRecord[];
    thread?: ThreadMessage[];
    view?: ThreadMessage[];
    record?: { dealt_message_id?: string | null; brought_ids?: string[] };
    gmail?: GmailMessage[];
    sendFails?: string;
    thenFails?: string;
    sendAs?: GmailSendAs[];
    extra?: Partial<ConstructorParameters<typeof OutsideThreads>[0]>;
    /** The person's most-used emoji as Slack keeps them, and whether reading them fails (plan 084). */
    frequent?: string[];
    frequentFails?: boolean;
  } = {},
) {
  /** What each card-view read was given: the record's facts and the ask. */
  const viewed: Array<{ facts: CardFacts; ask: OutsideWindowAsk }> = [];
  const sentMail: GmailDraftInput[] = [];
  const reacted: Array<{ channel: string; ts: string; name: string; on: boolean }> = [];
  const emojiReads = { n: 0 };
  const frequentReads = { n: 0 };
  const posted: Array<SlackDraftInput & { mentions?: ReadonlyMap<string, string> }> = [];
  /** Each Jira comment posted, as `[ticket, text]`. */
  const commented: Array<[string, string]> = [];
  const archived: string[] = [];
  /** Every write-back after a send, in order, as `<move> <account>/<thread>`. */
  const moves: string[] = [];
  const accounts = opts.accounts ?? [account(MAIL), account(SLACK)];
  const write =
    (move: OutsideChange["move"]) =>
    (accountId: string, threadId: string): Promise<OutsideChange | null> => {
      if (opts.thenFails) return Promise.reject(new Error(opts.thenFails));
      moves.push(`${move} ${accountId}/${threadId}`);
      if (move === "archive") archived.push(`${accountId}/${threadId}`);
      return Promise.resolve({ move, messages: [], ended: move === "archive", was_unread: true });
    };
  const t = new OutsideThreads({
    accounts: { get: (id) => accounts.find((a) => a.account_id === id) ?? null },
    threads: {
      archive: write("archive"),
      markRead: write("read"),
      markUnread: write("unread"),
      markWaiting: (accountId, threadId) => {
        moves.push(`waiting ${accountId}/${threadId}`);
        return true;
      },
      markDealt: (accountId, threadId) => {
        moves.push(`dealt ${accountId}/${threadId}`);
        return true;
      },
      clearSeeds: () => false,
      get: () => (opts.record ? { dealt_message_id: null, brought_ids: [], newest_message_id: "3", ...opts.record } : null),
    },
    threadText: { gmail: () => Promise.resolve(opts.thread ?? []), slack: () => Promise.resolve(opts.thread ?? []), jira: () => Promise.resolve([]) },
    ...(opts.view
      ? {
          cardView: {
            slack: (_a: string, _t: string, facts: CardFacts, ask: OutsideWindowAsk) => {
              viewed.push({ facts, ask });
              return Promise.resolve({ messages: opts.view ?? [], window: WINDOW });
            },
          },
        }
      : {}),
    clientFor: (a) =>
      a.provider === "jira"
        ? {
            provider: "jira",
            client: {
              postComment: (ticket: string, text: string) => {
                if (opts.sendFails) return Promise.reject(new Error(opts.sendFails));
                commented.push([ticket, text]);
                return Promise.resolve({ id: "30009" });
              },
            },
          }
        : a.provider === "gmail"
          ? {
              provider: "gmail",
              client: {
                getThread: () => Promise.resolve({ id: "t1", historyId: "1", messages: opts.gmail ?? [] }),
                sendAs: () =>
                  Promise.resolve(
                    opts.sendAs ?? [
                      { address: "ada@acme.com", name: "Ada", signature: "", isDefault: true },
                      { address: "ada@work.example", name: "Ada", signature: "", isDefault: false },
                    ],
                  ),
                attachment: (messageId: string, attachmentId: string) => Promise.resolve(Buffer.from(`${messageId}/${attachmentId}`)),
                sendReply: (r) => {
                  if (opts.sendFails) return Promise.reject(new Error(opts.sendFails));
                  sentMail.push(r);
                  return Promise.resolve({ id: "s1" });
                },
              },
            }
          : {
              provider: "slack",
              client: {
                postReply: (r) => {
                  if (opts.sendFails) return Promise.reject(new Error(opts.sendFails));
                  posted.push(r);
                  return Promise.resolve({ ts: "2.0" });
                },
                react: (r) => {
                  reacted.push(r);
                  return Promise.resolve();
                },
                emojiList: () => {
                  emojiReads.n++;
                  return Promise.resolve({ shipit: "https://example.test/shipit.png", ship_it: "alias:shipit" });
                },
                frequentEmoji: () => {
                  frequentReads.n++;
                  return opts.frequentFails ? Promise.reject(new Error("ratelimited")) : Promise.resolve(opts.frequent ?? []);
                },
              },
            },
    ...opts.extra,
  });
  return { t, sentMail, posted, commented, archived, moves, viewed, reacted, emojiReads, frequentReads };
}

describe("an email's own words, without the thread quoted under them", () => {
  test("cut at Gmail's and Apple Mail's 'On … wrote:', even when it wraps onto a second line", () => {
    expect(withoutQuoted("Friday works.\n\nOn Tue, 4 Nov 2026 at 10:02, Bob <bob@acme.com> wrote:\n> Lunch?")).toBe("Friday works.");
    expect(withoutQuoted("Yes.\nOn Tue, 4 Nov 2026 at 10:02, Bob\n<bob@acme.com> wrote:\n> Lunch?")).toBe("Yes.");
  });
  test("cut at Outlook's From: and Sent: block, and trailing > lines go", () => {
    expect(withoutQuoted("Done.\n\nFrom: Bob <bob@acme.com>\nSent: Tuesday\nSubject: x")).toBe("Done.");
    expect(withoutQuoted("ok\n> earlier\n> more")).toBe("ok");
  });
  test("a forward is kept whole, with the forwarded mail's header, but a reply quoting an earlier forward is cut", () => {
    const gmail = "See below.\n\n---------- Forwarded message ---------\nFrom: Bob <bob@acme.com>\nDate: Tue\n\nThe plan.";
    expect(withoutQuoted(gmail)).toBe(gmail);
    const apple = "FYI\n\nBegin forwarded message:\n\nFrom: Bob <bob@acme.com>\nDate: Tue\n\nThe plan.";
    expect(withoutQuoted(apple)).toBe(apple);
    expect(withoutQuoted("Thanks.\n\nOn Tue, Ada <ada@acme.com> wrote:\n> ---------- Forwarded message ---------\n> The plan.")).toBe("Thanks.");
  });
  test("a lone From: line is the writer's own text, and a message that is only a quote keeps its whole text", () => {
    expect(withoutQuoted("From: the team, thanks.\nAll good.")).toBe("From: the team, thanks.\nAll good.");
    expect(withoutQuoted("> only a quote")).toBe("> only a quote");
  });
});

describe("reading a card's whole thread", () => {
  test("every message with its sender and time; mail loses the quoted thread, and the person's own are marked", async () => {
    const { t } = threads({
      thread: [
        { sender: "Bob <bob@acme.com>", at: "2026-11-04T10:00:00.000Z", text: "Lunch?", id: "m1" },
        { sender: "Ada <ada@acme.com>", at: "2026-11-04T10:05:00.000Z", text: "Friday.\n\nOn Tue, Bob wrote:\n> Lunch?", mine: true },
      ],
    });
    expect((await t.read(MAIL, "t1")).messages).toEqual([
      { id: "m1", sender: "Bob <bob@acme.com>", at: "2026-11-04T10:00:00.000Z", text: "Lunch?", mine: false },
      { id: "at-1", sender: "Ada <ada@acme.com>", at: "2026-11-04T10:05:00.000Z", text: "Friday.", mine: true },
    ]);
  });
  test("a mail's HTML reaches the person's card as written; Slack has none", async () => {
    const thread = [{ sender: "Bob", at: "", text: "Bill", id: "m1", html: '<p>Bill <a href="https://x.test">here</a></p>' }];
    expect((await threads({ thread }).t.read(MAIL, "t1")).messages[0]).toMatchObject({ text: "Bill", html: '<p>Bill <a href="https://x.test">here</a></p>' });
    expect((await threads({ thread }).t.read(SLACK, "D1")).messages[0]).not.toHaveProperty("html");
  });
  test("a Slack card reads its channel view when there is one, with each message's photo, place and read state", async () => {
    const thread = [{ sender: "Bob", at: "", text: "only the thread", id: "1" }];
    const view = [
      { sender: "Ann", at: "", text: "before", id: "0", avatar: "https://example.test/a.png", replies: 2 },
      { sender: "Bob", at: "", text: "the card", id: "1", unread: true, more_after: true },
      { sender: "Ann", at: "", text: "a reply", id: "2", in_thread: true },
    ];
    const { messages } = await threads({ thread, view }).t.read(SLACK, "C1:1");
    expect(messages.map((m) => m.text)).toEqual(["before", "the card", "a reply"]);
    expect(messages[0]).toMatchObject({ avatar: "https://example.test/a.png", replies: 2 });
    expect(messages[1]).toMatchObject({ unread: true, more_after: true });
    expect(messages[2]).toMatchObject({ in_thread: true });
    const mail = await threads({ thread, view }).t.read(MAIL, "t1");
    expect([mail.messages.map((m) => m.text), mail.window]).toEqual([["only the thread"], null]);
  });
  test("a Slack card's window is built from its record, and a load's ask reaches the reader; what it marks comes back (plan 077)", async () => {
    const view = [{ sender: "Ann", at: "", text: "the mention", id: "2", brought: true, unread: true, new_replies: 3 }];
    const { t, viewed } = threads({ view, record: { dealt_message_id: "1", brought_ids: ["2"] } });
    const read = await t.read(SLACK, "C1:1", { direction: "before", from: "2" });
    expect(viewed).toEqual([{ facts: { dealt_message_id: "1", brought_ids: ["2"], newest_message_id: "3" }, ask: { direction: "before", from: "2" } }]);
    expect(read.window).toEqual(WINDOW);
    expect(read.messages[0]).toMatchObject({ brought: true, unread: true, new_replies: 3 });
  });
  /** What a Jira comment carries for the card to draw it as Slack's (plan 091): a picture, its blocks, and that it mentions the person. */
  const DRAWN = {
    avatar: "https://avatar-management.example/ada/48",
    body: [{ kind: "text" as const, spans: [{ kind: "mention" as const, text: "@Mina Example" }] }],
    mentions_me: true,
  };
  test("a Jira card reads its window with the record's key, and the ticket's address and the ticket come back with it (KTD14, R14, plan 089, 091)", async () => {
    const viewed: CardFacts[] = [];
    const asked: OutsideWindowAsk[] = [];
    const ticket = jiraTicket();
    const { t } = threads({
      accounts: [account(JIRA)],
      record: { dealt_message_id: "a", brought_ids: ["b"] },
      extra: {
        threads: {
          archive: () => Promise.resolve(null),
          markRead: () => Promise.resolve(null),
          markUnread: () => Promise.resolve(null),
          markWaiting: () => true,
          markDealt: () => true,
          clearSeeds: () => false,
          get: () => ({ dealt_message_id: "a", brought_ids: ["b"], newest_message_id: "b", place: "OPS-7" }),
        },
        cardView: {
          jira: (_a, _t, facts, ask) => {
            viewed.push(facts);
            asked.push(ask);
            return Promise.resolve({
              messages: [{ id: "b", sender: "Ada", at: "", text: "Can you look?", unread: true, brought: true, ...DRAWN }],
              window: { view: "channel", thread_ts: null, more_before: true, more_after: false },
              link: "https://jira.acme.example/browse/OPS-7",
              ...(ask.ticket ? { ticket } : {}),
            });
          },
        },
      },
    });
    const read = await t.read(JIRA, "10001", { ticket: true });
    expect(viewed).toEqual([{ dealt_message_id: "a", brought_ids: ["b"], newest_message_id: "b", place: "OPS-7" }]);
    expect(asked).toEqual([{ ticket: true }]);
    expect(read).toEqual({
      messages: [{ id: "b", sender: "Ada", at: "", text: "Can you look?", mine: false, unread: true, brought: true, ...DRAWN }],
      window: { view: "channel", thread_ts: null, more_before: true, more_after: false },
      link: "https://jira.acme.example/browse/OPS-7",
      ticket,
    });
    expect(await t.read(JIRA, "10001")).not.toHaveProperty("ticket");
  });
  test("a Jira read that fails says why, so the card shows its last lines with the reason", async () => {
    const { t } = threads({
      accounts: [account(JIRA)],
      extra: { cardView: { jira: () => Promise.reject(new Error("Jira did not accept the API token")) } },
    });
    await expect(t.read(JIRA, "10001")).rejects.toThrow("Jira did not accept the API token");
    const shown = renderToStaticMarkup(
      createElement(OutsideThread, { facts: JIRA_FACTS, state: { kind: "failed", message: "Jira did not accept the API token" } }),
    );
    expect(shown).toContain("could not read the whole thread: Jira did not accept the API token");
    expect(shown).toContain("Can you look at the rotation?");
  });
  test("an account not on this Mac is refused", async () => {
    await expect(threads({ accounts: [] }).t.read(MAIL, "t1")).rejects.toThrow("not connected on this Mac");
  });

  /** A Slack thread that Slack refuses once with the given wait, then reads; and every wait the reader sat out. */
  const limitedOnce = (waitMs: number) => {
    const waits: number[] = [];
    let calls = 0;
    const t = new OutsideThreads({
      accounts: { get: (id) => (id === SLACK ? account(SLACK) : null) },
      threads: {
        archive: () => Promise.resolve(null),
        markRead: () => Promise.resolve(null),
        markUnread: () => Promise.resolve(null),
        markWaiting: () => true,
        markDealt: () => true,
        clearSeeds: () => false,
        get: () => null,
      },
      threadText: {
        gmail: () => Promise.resolve([]),
        slack: () =>
          calls++ === 0
            ? Promise.reject(new SlackError(`Slack asked loki to wait ${String(waitMs / 1000)} s`, "ratelimited", waitMs))
            : Promise.resolve([{ sender: "Grace", at: "", text: "anyone with crm access?", id: "1" }]),
        jira: () => Promise.resolve([]),
      },
      clientFor: () => ({
        provider: "slack",
        client: {
          postReply: () => Promise.resolve({ ts: "1" }),
          react: () => Promise.resolve(),
          emojiList: () => Promise.resolve({}),
          frequentEmoji: () => Promise.resolve([]),
        },
      }),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    return { t, waits };
  };

  test("a short Slack rate limit is sat out and the thread read once more, so the card shows it", async () => {
    const { t, waits } = limitedOnce(19_000);
    expect((await t.read(SLACK, "C1:1.0")).messages.map((m) => m.text)).toEqual(["anyone with crm access?"]);
    expect(waits).toEqual([19_000]);
  });

  test("a long one is reported, so the card says why it shows only its last lines", async () => {
    const { t, waits } = limitedOnce(60_000);
    await expect(t.read(SLACK, "C1:1.0")).rejects.toThrow("wait 60 s");
    expect(waits).toEqual([]);
  });
});

describe("the person's reply", () => {
  test("Gmail: reply-all to the newest message that is not a draft, never to the person's own addresses, then the card is archived", async () => {
    const { t, sentMail, archived } = threads({
      gmail: [
        message("m1", 1, { From: "Bob <bob@acme.com>", To: "ada@acme.com, Cy <cy@acme.com>", Subject: "Lunch", "Message-ID": "<m1@acme.com>" }),
        message("m2", 3, { From: "ada@acme.com", To: "bob@acme.com", Subject: "Re: Lunch", "Message-ID": "<m2@acme.com>" }, ["DRAFT"]),
        message("m3", 2, {
          From: "Cy <cy@acme.com>",
          To: "bob@acme.com",
          Cc: "ada@work.example",
          Subject: "Re: Lunch",
          "Message-ID": "<m3@acme.com>",
          References: "<m1@acme.com>",
        }),
      ],
    });
    expect(await t.reply(MAIL, "t1", "  Friday works.  ", "archive")).toEqual({
      sent: true,
      then_error: null,
      change: { move: "archive", messages: [], ended: true, was_unread: true },
    });
    expect(sentMail).toEqual([
      {
        threadId: "t1",
        inReplyTo: "<m3@acme.com>",
        references: ["<m1@acme.com>"],
        // The mail came to the person's work address, so the answer goes from it (plan 076).
        from: '"Ada" <ada@work.example>',
        to: ["Cy <cy@acme.com>", "bob@acme.com"],
        cc: [],
        bcc: [],
        subject: "Re: Lunch",
        body: "Friday works.",
        html: '<div dir="ltr">Friday works.</div>',
      },
    ]);
    expect(archived).toEqual([`${MAIL}/t1`]);
  });
  test("Slack: in the thread for an Activity card, in the conversation for a DM", async () => {
    const { t, posted, archived } = threads();
    await t.reply(SLACK, "C1:1.0", "on it", "archive");
    await t.reply(SLACK, "D1", "thanks", "archive");
    expect(posted).toEqual([
      { channel: "C1", thread_ts: "1.0", text: "on it", mentions: new Map() },
      { channel: "D1", text: "thanks", mentions: new Map() },
    ]);
    expect(archived).toEqual([`${SLACK}/C1:1.0`, `${SLACK}/D1`]);
  });
  test("nothing is sent, archived or marked for an empty reply, a disconnected account, or a send that fails", async () => {
    const empty = threads();
    await expect(empty.t.reply(SLACK, "D1", "   ", "archive")).rejects.toThrow("the reply is empty");
    const off = threads({ accounts: [account(SLACK, { status: { disconnected: "slack_signed_out" } })] });
    await expect(off.t.reply(SLACK, "D1", "hi", "read")).rejects.toThrow("not connected now");
    const failing = threads({ sendFails: "channel_not_found" });
    await expect(failing.t.reply(SLACK, "D1", "hi", "later")).rejects.toThrow("channel_not_found");
    expect([...empty.posted, ...off.posted, ...failing.posted, ...failing.moves, ...off.moves, ...empty.moves]).toEqual([]);
  });
  const LUNCH = [message("m1", 1, { From: "Bob <bob@acme.com>", To: "ada@acme.com", Subject: "Lunch", "Message-ID": "<m1@acme.com>" })];
  test("Covers AE3. with later, the reply is sent, the thread is left unread on its newest incoming message and the record waits", async () => {
    const { t, sentMail, moves } = threads({ gmail: LUNCH });
    expect(await t.reply(MAIL, "t1", "Can you send the deck by Friday?", "later")).toEqual({
      sent: true,
      then_error: null,
      change: { move: "unread", messages: [], ended: false, was_unread: true },
    });
    expect(sentMail.map((m) => m.body.split("\n")[0])).toEqual(["Can you send the deck by Friday?"]);
    expect(moves).toEqual([`dealt ${MAIL}/t1`, `waiting ${MAIL}/t1`, `unread ${MAIL}/t1`]);
  });
  test("Covers AE4. with archive, the reply is sent and the thread archived", async () => {
    const { t, sentMail, moves } = threads({ gmail: LUNCH });
    expect(await t.reply(MAIL, "t1", "Here it is.", "archive")).toMatchObject({ sent: true, then_error: null, change: { move: "archive", ended: true } });
    expect(sentMail).toHaveLength(1);
    expect(moves).toEqual([`dealt ${MAIL}/t1`, `archive ${MAIL}/t1`]);
  });
  test("a reply goes into the thread the person opened on the card, in the card's conversation (plan 085)", async () => {
    const { t, posted } = threads();
    await t.reply(SLACK, "D1", "on it", "stay", null, null, "5.0");
    await t.reply(SLACK, "C1:1.0", "looking", "stay", null, null, "7.0");
    expect(posted.map((p) => [p.channel, p.thread_ts, p.text])).toEqual([
      ["D1", "5.0", "on it"],
      ["C1", "7.0", "looking"],
    ]);
    await expect(t.reply(MAIL, "t1", "ok", "stay", null, null, "7.0")).rejects.toThrow("only a Slack reply goes into a thread the card opened");
  });

  test("with stay, the reply is sent and nothing else moves (plan 083)", async () => {
    const { t, posted, moves } = threads();
    expect(await t.reply(SLACK, "D1", "on it", "stay")).toEqual({ sent: true, then_error: null, change: null });
    expect(posted).toHaveLength(1);
    expect(moves).toEqual([`dealt ${SLACK}/D1`]);
  });

  test("with read, the reply is sent and the thread marked read, and the card does not end", async () => {
    const { t, sentMail, moves } = threads({ gmail: LUNCH });
    expect(await t.reply(MAIL, "t1", "Thanks.", "read")).toMatchObject({ sent: true, then_error: null, change: { move: "read", ended: false } });
    expect(sentMail).toHaveLength(1);
    expect(moves).toEqual([`dealt ${MAIL}/t1`, `read ${MAIL}/t1`]);
  });
  test("a sent reply whose archive fails answers sent with the archive's reason, and nothing is sent twice", async () => {
    const { t, posted } = threads({ thenFails: "Slack is out of reach" });
    expect(await t.reply(SLACK, "D1", "on it", "archive")).toEqual({ sent: true, then_error: "Slack is out of reach", change: null });
    expect(posted).toEqual([{ channel: "D1", text: "on it", mentions: new Map() }]);
  });
  test("a Gmail thread with no one else in it is refused before anything is sent", async () => {
    const { t, sentMail } = threads({ gmail: [message("m1", 1, { From: "ada@acme.com", To: "ada@work.example", Subject: "note" })] });
    await expect(t.reply(MAIL, "t1", "hi", "archive")).rejects.toThrow("no one in that thread to reply to");
    expect(sentMail).toEqual([]);
  });
});

describe("the person's comment on a Jira card (plan 2026-11-10-1451, U7, KTD11)", () => {
  const jira = (over: Parameters<typeof threads>[0] = {}) => threads({ accounts: [account(JIRA)], ...over });

  test("Covers F3, AE1. with stay, the comment is posted on the ticket and nothing moves, not even the dealt mark", async () => {
    const { t, commented, moves } = jira();
    expect(await t.reply(JIRA, "10001", "  On it, rotating tonight.  ", "stay")).toEqual({ sent: true, then_error: null, change: null });
    expect(commented).toEqual([["10001", "On it, rotating tonight."]]);
    expect(moves).toEqual([]);
  });
  test("with read, the comment is posted and then the card is read, which ends it", async () => {
    const { t, commented, moves } = jira();
    expect(await t.reply(JIRA, "10001", "Done.", "read")).toMatchObject({ sent: true, then_error: null, change: { move: "read" } });
    expect(commented).toHaveLength(1);
    expect(moves).toEqual([`read ${JIRA}/10001`]);
  });
  test("with later, the comment is posted and the card left unread to come back", async () => {
    const { t, commented, moves } = jira();
    expect(await t.reply(JIRA, "10001", "Will look tomorrow.", "later")).toMatchObject({ sent: true, then_error: null, change: { move: "unread" } });
    expect(commented).toHaveLength(1);
    expect(moves).toEqual([`waiting ${JIRA}/10001`, `unread ${JIRA}/10001`]);
  });
  test("a post that fails throws its reason, and nothing is marked", async () => {
    const { t, commented, moves } = jira({ sendFails: "Jira answered 500" });
    await expect(t.reply(JIRA, "10001", "On it", "stay")).rejects.toThrow("Jira answered 500");
    expect([...commented, ...moves]).toEqual([]);
  });
  test("an empty comment, one past the length limit and one on a disconnected site are refused before anything is posted", async () => {
    const on = jira();
    await expect(on.t.reply(JIRA, "10001", "  \n ", "stay")).rejects.toThrow("the reply is empty");
    await expect(on.t.reply(JIRA, "10001", "x".repeat(30_001), "stay")).rejects.toThrow("that reply is too long to send");
    const off = threads({ accounts: [account(JIRA, { status: { disconnected: "sign_in_again" } })] });
    await expect(off.t.reply(JIRA, "10001", "On it", "stay")).rejects.toThrow("not connected now");
    expect([...on.commented, ...off.commented, ...on.moves, ...off.moves]).toEqual([]);
  });
});

describe("a comment from the card reaches the ticket and leaves the card as it was (plan 2026-11-10-1451, U7)", () => {
  const ID = `jira:acme.atlassian.net:${JIRA_ME.account_id}`;
  const START = Date.parse("2026-11-10T09:00:00.000Z");

  /** A site connected on a temporary folder: its records, the card's real reader, the sync and the reply, all over the fake site. */
  async function site(fetchOver?: typeof fetch) {
    const dir = mkdtempSync(join(tmpdir(), "loki-jira-comment-"));
    dirs.push(dir);
    let now = START;
    const clock = () => new Date(now);
    const jira = fakeJira({ now: clock });
    const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), now: clock });
    const secret: JiraSecret = { site: jira.host, email: jira.state.email, token: jira.state.token };
    await accounts.add({ account_id: ID, provider: "jira", address: jira.host, owner_agent_id: "agent-work" }, JSON.stringify(secret));
    const records = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
    records.register("jira", jiraOutsideSource());
    const client = jiraAccountClient(accounts, ID, { fetch: fetchOver ?? jira.fetch, now: clock });
    const sync = new JiraSync({ accounts, threads: records, account: must(accounts.get(ID), "the account"), client, now: clock });
    const t = new OutsideThreads({
      accounts,
      threads: records,
      threadText: { gmail: () => Promise.resolve([]), slack: () => Promise.resolve([]), jira: jiraThreadText(() => client) },
      cardView: {
        jira: jiraCardView(
          () => client,
          () => Promise.resolve(secret),
        ),
      },
      clientFor: () => ({ provider: "jira", client }),
    });
    return { jira, records, sync, t, advance: (ms: number) => (now += ms), at: (minutes: number) => new Date(START + minutes * 60_000) };
  }

  test("Covers AE1. the comment is on the ticket as the person's, shows on the card as theirs, and the card stays open with its new marks; the next sync brings nothing", async () => {
    const s = await site();
    await s.sync.tick();
    s.advance(60_000);
    const ticket = s.jira.addTicket({ key: "OPS-7", summary: "Rotate the keys", at: s.at(0.5) });
    s.jira.comment("OPS-7", { at: s.at(0.5), author: JIRA_ADA, text: "Can you look at the rotation?" });
    await s.sync.tick();
    const before = must(s.records.get(ID, ticket), "the card's record");
    expect(before.state).toBe("open");

    s.advance(60_000);
    expect(await s.t.reply(ID, ticket, "On it.\nRotating tonight.\n\nWill confirm here.", "stay")).toEqual({ sent: true, then_error: null, change: null });
    // Two paragraphs, the first with a line break, as Jira's own editor writes them (KTD15).
    expect(s.jira.posted.map(({ key, body }) => ({ key, body }))).toEqual([
      {
        key: "OPS-7",
        body: {
          version: 1,
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "On it." }, { type: "hardBreak" }, { type: "text", text: "Rotating tonight." }] },
            { type: "paragraph", content: [{ type: "text", text: "Will confirm here." }] },
          ],
        },
      },
    ]);
    expect(s.records.get(ID, ticket)).toEqual(before);

    const read = await s.t.read(ID, ticket);
    expect(read.messages.map((m) => [m.sender, m.mine, m.unread === true])).toEqual([
      ["Ada Lovelace", false, true],
      [JIRA_ME.display_name, true, false],
    ]);

    s.advance(60_000);
    await s.sync.tick();
    expect(s.records.get(ID, ticket)).toEqual(before);
  });

  test("sending the comment takes the approved comments off the card's record (plan 2026-11-10-1451, U8)", async () => {
    const s = await site();
    const ticket = s.jira.addTicket({ key: "OPS-7", summary: "Rotate the keys", at: s.at(0.5) });
    s.jira.comment("OPS-7", { at: s.at(0.5), author: JIRA_ADA, text: "Can you look at the rotation?" });
    s.advance(60_000);
    await s.sync.tick();
    s.records.seed(ID, ticket, { id: "reply-1", text: "Rotating tonight.", at: s.at(1).toISOString() });
    await s.t.reply(ID, ticket, "Rotating tonight.", "stay");
    expect(s.jira.posted).toHaveLength(1);
    expect(s.records.get(ID, ticket)?.seeds).toEqual([]);
  });

  test("a post that times out is reported and never sent again", async () => {
    const posts: string[] = [];
    const timingOut: typeof fetch = (input, init) => {
      if (init?.method === "POST") {
        posts.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
        return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    };
    const s = await site(timingOut);
    await expect(s.t.reply(ID, "10001", "On it", "stay")).rejects.toThrow("timed out");
    expect(posts).toHaveLength(1);
  });
});

/** The mail parts of the reply frames' fake, for tests about something else. */
/** What a fake reader that is about neither mail nor reactions answers. */
describe("the person's reactions on a Slack card (plan 079)", () => {
  test("a reaction goes to the message in the card's channel, and moves nothing on the card", async () => {
    const { t, reacted, moves } = threads();
    await t.react(SLACK, "C1:1.0", "1.5", "eyes", true);
    await t.react(SLACK, "D1", "2.0", "+1", false);
    expect(reacted).toEqual([
      { channel: "C1", ts: "1.5", name: "eyes", on: true },
      { channel: "D1", ts: "2.0", name: "+1", on: false },
    ]);
    expect(moves).toEqual([]);
  });

  test("a mail takes no reaction", async () => {
    const { t, reacted } = threads();
    await expect(t.react(MAIL, "t1", "m1", "eyes", true)).rejects.toThrow("only a Slack message takes a reaction");
    expect(reacted).toEqual([]);
  });

  test("the emoji search reaches the workspace's own, read once", async () => {
    const { t, emojiReads } = threads();
    expect((await t.searchEmoji(SLACK, "shipit")).map((c) => c.name)).toEqual(["shipit"]);
    await t.searchEmoji(SLACK, "eyes");
    expect(emojiReads.n).toBe(1);
  });

  test("an empty search is the person's most used in Slack, drawn, at most five; read again after ten minutes (plan 084)", async () => {
    let at = Date.parse("2026-11-10T10:00:00Z");
    const frequent = ["100", "ship_it", "not_an_emoji_anywhere", "+1::skin-tone-2", "eyes", "pray", "fire"];
    const { t, frequentReads } = threads({ frequent, extra: { now: () => new Date(at) } });
    expect(await t.searchEmoji(SLACK, "")).toEqual([
      { name: "100", emoji: { kind: "emoji", text: "💯" } },
      { name: "ship_it", emoji: { kind: "emoji", text: ":shipit:", image: "https://example.test/shipit.png" } },
      { name: "+1::skin-tone-2", emoji: { kind: "emoji", text: "👍\u{1F3FB}" } },
      { name: "eyes", emoji: { kind: "emoji", text: "👀" } },
      { name: "pray", emoji: { kind: "emoji", text: "🙏" } },
    ]);
    await t.searchEmoji(SLACK, " ");
    expect(frequentReads.n).toBe(1);
    at += 11 * 60_000;
    await t.searchEmoji(SLACK, "");
    expect(frequentReads.n).toBe(2);
  });

  test("most used that cannot be read are none, and asked again next time", async () => {
    const { t, frequentReads } = threads({ frequentFails: true });
    expect(await t.searchEmoji(SLACK, "")).toEqual([]);
    await t.searchEmoji(SLACK, "");
    expect(frequentReads.n).toBe(2);
  });
});

const NO_MAIL = {
  compose: () => Promise.reject(new Error("not a mail")),
  unsend: () => false,
  react: () => Promise.resolve(),
  searchEmoji: () => Promise.resolve([]),
  searchPeople: () => Promise.resolve([]),
};

describe("mentioning people in a Slack reply (plan 082)", () => {
  const people = (fails = false) => ({
    search: (_accountId: string, query: string) => Promise.resolve([{ id: "U2", handle: "ravi.kumar", name: query, avatar: null }]),
    mentions: () => (fails ? Promise.reject(new Error("offline")) : Promise.resolve(new Map([["ravi.kumar", "U2"]]))),
  });

  test("a reply carries the workspace's handles, so its @handles go as Slack's mentions", async () => {
    const { t, posted } = threads({ extra: { slackPeople: people() } });
    await t.reply(SLACK, "D1", "@ravi.kumar can you look", "archive");
    expect(posted[0]?.mentions).toEqual(new Map([["ravi.kumar", "U2"]]));
  });

  test("people who cannot be read leave the handles as typed, and the reply still goes", async () => {
    const { t, posted } = threads({ extra: { slackPeople: people(true) } });
    await t.reply(SLACK, "D1", "@ravi.kumar can you look", "archive");
    expect(posted[0]).toMatchObject({ text: "@ravi.kumar can you look", mentions: new Map() });
  });

  test("the search reaches the workspace's people; a mail account has none to mention", async () => {
    const { t } = threads({ extra: { slackPeople: people() } });
    expect(await t.searchPeople(SLACK, "ravi")).toEqual([{ id: "U2", handle: "ravi.kumar", name: "ravi", avatar: null }]);
    await expect(t.searchPeople(MAIL, "ravi")).rejects.toThrow("only a Slack account has people to mention");
  });

  test("a Jira site has no one to mention, so its card's box draws no list (plan 2026-11-10-1451, KTD11)", async () => {
    const { t } = threads({ accounts: [account(JIRA)], extra: { slackPeople: people() } });
    await expect(t.searchPeople(JIRA, "ravi")).rejects.toThrow("only a Slack account has people to mention");
  });
});

describe("the reply frames", () => {
  /** The account frames on a bridge, with a fake reader; each frame's last answer. */
  function ask(outside?: Parameters<typeof accountFrames>[0]["outside"]) {
    const bridge = bridgeOf({ modules: [accountFrames(outside ? { outside } : {})] });
    return async (frame: Record<string, unknown>) => {
      const c = client("d1");
      bridge.onMessage(c, { request_id: "r1", ...frame });
      await settled();
      await settled();
      return c.sent.at(-1) ?? {};
    };
  }

  test("a read answers the thread, a reply answers it was sent and how its move went, and a refusal comes back in words", async () => {
    const asked: OutsideWindowAsk[] = [];
    const send = ask({
      ...NO_MAIL,
      read: (_a, threadId, more) => {
        asked.push(more ?? {});
        return Promise.resolve({
          messages: [{ id: "1.0", sender: "Bob", at: "", text: "hi", mine: false }],
          window: WINDOW,
          ...(threadId === "10001" ? { link: "https://jira.acme.example/browse/OPS-7" } : {}),
        });
      },
      reply: (_a, _t, text, then) =>
        text === "boom"
          ? Promise.reject(new Error("Slack refused it"))
          : Promise.resolve({ sent: true as const, then_error: then === "archive" ? "Slack is out of reach" : null, change: null }),
    });
    expect(await send({ type: "account_thread_read", account_id: SLACK, thread_id: "D1" })).toMatchObject({
      type: "account_thread",
      messages: [{ sender: "Bob", text: "hi" }],
      window: WINDOW,
    });
    expect(await send({ type: "account_thread_read", account_id: JIRA, thread_id: "10001" })).toMatchObject({
      type: "account_thread",
      link: "https://jira.acme.example/browse/OPS-7",
    });
    asked.pop();
    await send({ type: "account_thread_read", account_id: SLACK, thread_id: "C1:1", view: "thread", thread_ts: "1", direction: "after", from: "5" });
    expect(asked).toEqual([{}, { view: "thread", thread_ts: "1", direction: "after", from: "5" }]);
    expect(await send({ type: "account_thread_read", account_id: SLACK, thread_id: "C1:1", direction: "sideways", from: "5" })).toMatchObject({
      type: "error",
      message: "direction must be before or after",
    });
    expect(await send({ type: "account_thread_read", account_id: SLACK, thread_id: "C1:1", direction: "after" })).toMatchObject({
      type: "error",
      message: "from required with direction",
    });
    expect(await send({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok", then: "later" })).toEqual({
      type: "account_thread_replied",
      request_id: "r1",
      account_id: SLACK,
      thread_id: "D1",
      sent: true,
      then_error: null,
      change: null,
    });
    expect(await send({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok", then: "archive" })).toMatchObject({
      type: "account_thread_replied",
      sent: true,
      then_error: "Slack is out of reach",
    });
    expect(await send({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "boom", then: "read" })).toMatchObject({
      type: "error",
      message: "Slack refused it",
    });
  });
  test("an empty reply or one with a move loki does not know is refused before it reaches the reader, and without the reader a reply says so", async () => {
    const reader = { ...NO_MAIL, read: () => Promise.resolve({ messages: [], window: null }), reply: () => Promise.reject(new Error("reached")) };
    expect(await ask(reader)({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "  ", then: "read" })).toMatchObject({
      type: "error",
      message: "account_id, thread_id and text required",
    });
    expect(await ask(reader)({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok", then: "snooze" })).toMatchObject({
      type: "error",
      message: "then must be read, later, archive or stay",
    });
    expect(await ask()({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok", then: "archive" })).toMatchObject({
      type: "error",
      message: "replying is not available in this mod",
    });
  });
  test("a reply from an app before plan 070, which sends no move, is sent and then archived, as it was then", async () => {
    const thens: string[] = [];
    const send = ask({
      ...NO_MAIL,
      read: () => Promise.resolve({ messages: [], window: null }),
      reply: (_a, _t, _text, then) => {
        thens.push(then);
        return Promise.resolve({ sent: true as const, then_error: null, change: { move: "archive", messages: [], ended: true, was_unread: true } });
      },
    });
    expect(await send({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok" })).toMatchObject({
      type: "account_thread_replied",
      request_id: "r1",
      sent: true,
      change: { move: "archive", ended: true },
    });
    expect(thens).toEqual(["archive"]);
  });
  test("a Jira card's ask for its ticket reaches the reader, and the ticket comes back in the answer and from the app's client (plan 089)", async () => {
    const asked: OutsideWindowAsk[] = [];
    const ticket = jiraTicket();
    const send = ask({
      ...NO_MAIL,
      read: (_a, _t, more) => {
        asked.push(more ?? {});
        return Promise.resolve({ messages: JIRA_COMMENTS, window: WINDOW, ...(more?.ticket ? { ticket } : {}) });
      },
      reply: () => Promise.reject(new Error("not sent")),
    });
    const answer = await send({ type: "account_thread_read", account_id: JIRA, thread_id: "10001", ticket: true });
    expect(answer).toMatchObject({ type: "account_thread", messages: JIRA_COMMENTS, ticket });
    // Anything but true is not an ask: an older app sends nothing, and a stray value changes nothing.
    await send({ type: "account_thread_read", account_id: JIRA, thread_id: "10001", ticket: "yes" });
    expect(asked).toEqual([{ ticket: true }, {}]);

    const sent: Array<Record<string, unknown>> = [];
    const request = ((type: string, payload: Record<string, unknown>) => {
      sent.push({ type, ...payload });
      return Promise.resolve({ ok: true, reply: answer });
    }) as unknown as FrameRequest;
    const app = new FrameChatClient({ request, onChatEvent: () => () => {} });
    const read = await app.readOutside(JIRA, "10001", null, { ticket: true });
    expect(sent).toEqual([{ type: "account_thread_read", account_id: JIRA, thread_id: "10001", home: null, ticket: true }]);
    expect(read).toEqual({ messages: JIRA_COMMENTS, window: WINDOW, ticket });
  });
  test("both go to the Mac the account lives on, and the phone may send them", () => {
    expect(peerMeaning("account_thread_read")).toMatchObject({ route: "home" });
    expect(peerMeaning("account_thread_reply")).toMatchObject({ route: "home", relists: true });
    expect(PHONE_FRAMES.has("account_thread_read") && PHONE_FRAMES.has("account_thread_reply")).toBe(true);
  });
});

describe("agents never send", () => {
  test("the person's Jira comment is posted from the reply module alone (plan 2026-11-10-1451, U7)", () => {
    expect(readFileSync(join(import.meta.dirname, "..", "mod", "outside-threads.ts"), "utf8")).toMatch(/\.postComment\(/);
  });
  test("the send calls are called from the person's reply module and nowhere else in the mod", () => {
    const dir = join(import.meta.dirname, "..", "mod");
    const callers = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\.(sendReply|postReply|postComment)\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(callers).toEqual(["outside-threads.ts"]);
  });
});

const FACTS: OutsideFacts = {
  account_id: SLACK,
  provider: "slack",
  account_label: "farmart",
  thread_id: "D1",
  generation: 0,
  owner_agent_id: "agent-work",
  owner_name: "friday",
  sender: "Shipyard",
  sender_address: null,
  subject: "Please review this PR",
  lines: ["Please review this PR"],
  newest_message_id: "1.0",
  newest_at: "2026-11-04T10:00:00.000Z",
  handoff_conversation_id: null,
  disconnected: null,
  unread_out_there: true,
};

describe("the card", () => {
  test("a Slack card is titled by who wrote, a mail by its subject; a mail sender by display name", () => {
    expect(outsideTitle(FACTS)).toBe("Shipyard");
    expect(outsideTitle({ ...FACTS, provider: "gmail", subject: "Lunch" })).toBe("Lunch");
    expect(senderName('"Bob Stone" <bob@acme.com>')).toBe("Bob Stone");
    expect(senderName("<bob@acme.com>")).toBe("bob@acme.com");
  });
  test("the reply box says where the reply goes", () => {
    expect([replyPlace(FACTS), replyPlace({ ...FACTS, thread_id: "C1:1.0" }), replyPlace({ ...FACTS, provider: "gmail" })]).toEqual([
      "reply in the DM",
      "reply in the thread",
      "reply to all",
    ]);
    // A thread opened on a DM card is where the reply goes (plan 085).
    expect(replyPlace(FACTS, true)).toBe("reply in the thread");
  });
  test("the thread draws each message with its sender, and the person's own as you; while it loads, the last lines stand in", () => {
    const read = renderToStaticMarkup(
      createElement(OutsideThread, {
        facts: FACTS,
        state: {
          kind: "read",
          messages: [
            { id: "1.0", sender: "Shipyard", at: "", text: "Please review", mine: false },
            { id: "2.0", sender: "Ada", at: "", text: "Looking now", mine: true },
          ],
        },
      }),
    );
    expect(read).toContain("Shipyard");
    expect(read).toContain(">you<");
    expect(read).toContain("Looking now");
    const loading = renderToStaticMarkup(createElement(OutsideThread, { facts: FACTS, state: { kind: "loading" } }));
    expect(loading).toContain("reading the whole thread");
    expect(loading).toContain("Please review this PR");
  });
});

const JIRA_FACTS: OutsideFacts = {
  account_id: JIRA,
  provider: "jira",
  account_label: "acme.atlassian.net",
  thread_id: "10001",
  generation: 0,
  owner_agent_id: "agent-work",
  owner_name: "friday",
  sender: "Ada Lovelace",
  sender_address: null,
  subject: "Rotate the keys",
  lines: ["Can you look at the rotation?"],
  newest_message_id: "2026-11-10T09:02:00.000Z:c000000030002",
  newest_at: "2026-11-10T09:02:00.000Z",
  handoff_conversation_id: null,
  disconnected: null,
  unread_out_there: true,
  reach: "watching",
  place: "OPS-7",
  only_account: false,
};

describe("a Jira card (plan 2026-11-10-1451, U5)", () => {
  const header = (link: string | null = null) =>
    renderToStaticMarkup(createElement(OutsideHeader, { facts: JIRA_FACTS, badge: null, went: null, cameBack: false, link }));
  const events = [
    { id: "e1", sender: "Bob Stone", at: "", text: "status: To Do → In Progress", mine: false },
    { id: "e2", sender: "Mina Example", at: "", text: "On it", mine: true },
    { id: "e3", sender: "Ada Lovelace", at: "", text: "Can you look at the rotation?", mine: false, unread: true, brought: true },
    { id: "e4", sender: "Bob Stone", at: "", text: "priority: Low → High", mine: false, unread: true, brought: true },
  ];

  test("is titled by its ticket's key and title, and its box comments on the ticket", () => {
    expect(outsideTitle(JIRA_FACTS)).toBe("OPS-7 · Rotate the keys");
    expect(replyPlace(JIRA_FACTS)).toBe("comment on the ticket");
  });
  test("its header shows the Jira mark, who, the key and title, the tag and the link to the ticket, and names the site", () => {
    const html = header();
    expect(html).toContain('aria-label="from Jira"');
    expect(html).toContain("◆");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("OPS-7 · Rotate the keys");
    expect(html).toContain(">watching<");
    expect(html).toMatch(/<a [^>]*href="https:\/\/acme\.atlassian\.net\/browse\/OPS-7"[^>]*>open in jira<\/a>/);
    expect(html).toContain('title="the site it came from"');
    expect(html).not.toContain("workspace");
  });
  test("a site with a custom domain links to that domain, as the read gave it", () => {
    expect(header("https://jira.acme.example/browse/OPS-7")).toContain('href="https://jira.acme.example/browse/OPS-7"');
  });
  test("its thread draws each event, the person's own as you, with the New line before the first unread one", () => {
    const html = renderToStaticMarkup(createElement(OutsideThread, { facts: JIRA_FACTS, state: { kind: "read", messages: events } }));
    expect(html.match(/New since you last read/g)?.length).toBe(1);
    expect(html.indexOf("New since you last read")).toBeLessThan(html.indexOf("Can you look at the rotation?"));
    expect(html.indexOf("New since you last read")).toBeGreaterThan(html.indexOf("On it"));
    expect(html).toContain(">you<");
    expect(html).toContain("status: To Do → In Progress");
  });
  test("it offers earlier events while the window has more before them", () => {
    const controls = { load: () => {}, openThread: () => {}, busy: null };
    const window: OutsideWindow = { view: "channel", thread_ts: null, more_before: true, more_after: false };
    const more = renderToStaticMarkup(createElement(OutsideThread, { facts: JIRA_FACTS, state: { kind: "read", messages: events, window, controls } }));
    expect(more).toContain(">load earlier<");
    const all = renderToStaticMarkup(
      createElement(OutsideThread, { facts: JIRA_FACTS, state: { kind: "read", messages: events, window: { ...window, more_before: false }, controls } }),
    );
    expect(all).not.toContain("load earlier");
  });
});

describe("a Jira card shaped like the ticket (plan 089)", () => {
  const read = (over: Partial<Extract<ThreadState, { kind: "read" }>> = {}): ThreadState => ({
    kind: "read",
    messages: JIRA_COMMENTS,
    ticket: jiraTicket(),
    ...over,
  });
  const thread = (state: ThreadState = read(), facts: OutsideFacts = JIRA_FACTS) => renderToStaticMarkup(createElement(OutsideThread, { facts, state }));
  const head = (ticket = jiraTicket(), facts: OutsideFacts = JIRA_FACTS) =>
    renderToStaticMarkup(createElement(OutsideHeader, { facts, badge: null, went: null, cameBack: false, ticket }));

  test("its header names the type, key and project, keeps the tag and the link, and is titled by the summary", () => {
    const html = head();
    expect(html).toContain('aria-label="from Jira"');
    expect(html).toMatch(/class="loki-jira-key"[^>]*>OPS-7</);
    expect(html).toContain("· Task · Operations");
    expect(html).toMatch(/class="loki-card-head-who"[^>]*>Rotate the keys</);
    expect(html).toContain(">watching<");
    expect(html).toContain(">open in jira<");
    expect(html.indexOf("OPS-7")).toBeLessThan(html.indexOf("Rotate the keys"));
    expect(html).not.toContain("loki-jira-new");
  });
  test("a summary someone else changed marks the header new", () => {
    const changed = [{ field: "summary", from: "Rotate keys", to: "Rotate the keys", by: "Ada Lovelace", at: "2026-11-10T09:00:00.000Z" }];
    expect(head(jiraTicket({ changed }))).toContain(">new<");
  });
  test("the header's new mark says in plain words what changed: the type, the project or the summary", () => {
    const by = { by: "Ada Lovelace", at: "2026-11-10T09:00:00.000Z" };
    const said = (field: string) => head(jiraTicket({ changed: [{ field, from: "a", to: "b", ...by }] }));
    expect(said("issuetype")).toContain('title="type changed · Ada Lovelace · ');
    expect(said("project")).toContain('title="project changed · Ada Lovelace · ');
    expect(said("summary")).toContain('title="summary changed · Ada Lovelace · ');
    expect(said("issuetype")).not.toContain("issuetype");
  });
  test("the fields show what the ticket has, the changed status marked new with what it was and who changed it", () => {
    const html = thread();
    // Desktop labels are lowercase (docs/style.md); the phone's are in sentence case.
    expect(html).toContain(">status<");
    expect(html).toContain(">In review<");
    expect(html).toContain(">assignee<");
    expect(html).toContain(">reporter<");
    expect(html).toContain(">priority<");
    expect(html).toContain(">labels<");
    expect(html).toContain("security, keys");
    expect(html).not.toContain(">sprint<");
    expect(html.match(/>new</g)?.length).toBe(1);
    expect(html).toContain("was In progress · Ada Lovelace · ");
  });
  test("a labels change says what they were, parted by commas, and a status that had none says was none", () => {
    const by = { by: "Ada Lovelace", at: "2026-11-10T09:00:00.000Z" };
    const changed = [
      { field: "labels", from: "security ops", to: "security keys", ...by },
      { field: "status", from: null, to: "In review", ...by },
    ];
    const html = thread(read({ ticket: jiraTicket({ changed }) }));
    expect(html).toContain("was security, ops · Ada Lovelace · ");
    expect(html).toContain("was none · Ada Lovelace · ");
  });
  test("the comment count is the ticket's, though the window shows fewer", () => {
    expect(thread(read({ ticket: jiraTicket({ comment_count: 40 }) }))).toContain("Comments · 40");
  });
  test("the fields it does not show are one line: also changed, with who", () => {
    expect(thread()).toContain("also changed: Rank, Story points · Ada Lovelace · ");
    expect(thread(read({ ticket: jiraTicket({ also_changed: [] }) }))).not.toContain("also changed");
  });
  test("the description folds after six lines, with show more", () => {
    const html = thread();
    expect(html).toContain(">Description<");
    expect(html).toContain("line 6");
    expect(html).not.toContain("line 7");
    expect(html).toContain(">show more<");
    const short = thread(read({ ticket: jiraTicket({ description: ["one line"] }) }));
    expect(short).not.toContain("show more");
  });
  test("an edited description is marked under its heading", () => {
    const changed = [{ field: "description", from: null, to: null, by: "Ada Lovelace", at: "2026-11-10T09:00:00.000Z" }];
    expect(thread(read({ ticket: jiraTicket({ changed }) }))).toContain("edited · Ada Lovelace · ");
  });
  test("the comments come last under their count, with the New line before the first unread", () => {
    const html = thread();
    expect(html).toContain("Comments · 2");
    const order = [">status<", "also changed", "Description", "Comments · 2", "On it", "New since you last read", "Can you look at the rotation?"].map((s) =>
      html.indexOf(s),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Field changes are no longer lines in the list.
    expect(html).not.toContain("status: ");
  });
  test("a ticket with no comments yet still draws the ticket", () => {
    const html = thread(read({ messages: [] }));
    expect(html).toContain(">Description<");
    expect(html).not.toContain("reading the whole thread");
  });
  test("a read without the ticket, from an older Mac, draws the card as before", () => {
    const html = thread({ kind: "read", messages: JIRA_COMMENTS });
    expect(html).not.toContain("Comments ·");
    expect(html).not.toContain("loki-jira");
    expect(html).toContain("New since you last read");
    expect(renderToStaticMarkup(createElement(OutsideHeader, { facts: JIRA_FACTS, badge: null, went: null, cameBack: false }))).toContain(
      "OPS-7 · Rotate the keys",
    );
  });
  test("a Gmail and a Slack card draw no ticket parts", () => {
    const mail = must(outsideItem("Lunch").outside, "mail facts");
    for (const facts of [mail, FACTS]) {
      const html = thread(read(), facts);
      expect(html).not.toContain("loki-jira");
      expect(html).not.toContain("Comments ·");
      expect(head(jiraTicket(), facts)).not.toContain("loki-jira");
    }
  });
  test("a Jira card's opening read asks for the ticket, and so does a load while it shows one; Gmail and Slack ask nothing new", () => {
    expect(ticketAsk(JIRA_FACTS, true)).toEqual({ ticket: true });
    // A card the Mac answered with the older log loads more of that log.
    expect(ticketAsk(JIRA_FACTS, false)).toEqual({});
    const mail = must(outsideItem("Lunch").outside, "mail facts");
    for (const facts of [mail, FACTS, undefined]) expect(ticketAsk(facts, true)).toEqual({});
  });
  test("loading earlier comments keeps the ticket the opening read gave", () => {
    const w: OutsideWindow = { view: "channel", thread_ts: null, more_before: true, more_after: false };
    const ticket = jiraTicket();
    const now = { view: "v", tag: "t", messages: JIRA_COMMENTS, window: w, busy: "before" as const, failed: null, link: null, ticket };
    const earlier = { id: "c0", sender: "Bob Stone", at: "", text: "Earlier", mine: false };
    const after = withLoaded(now, { messages: [earlier], window: { ...w, more_before: false } }, w, "before");
    expect(after.ticket).toBe(ticket);
    expect(after.messages.map((m) => m.id)).toEqual(["c0", "c1", "c2"]);
  });
});

describe("a Jira card's comments look like a Slack card's messages (plan 091)", () => {
  const ADA_FACE = "https://avatar-management.example/ada/48";
  const at = (day: number, hour: number, minute: number) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString();
  const comments: OutsideMessage[] = [
    {
      id: "c1",
      sender: "Ada Lovelace",
      at: at(9, 9, 0),
      text: "Plan is bold",
      mine: false,
      avatar: ADA_FACE,
      body: [
        {
          kind: "text",
          spans: [
            { kind: "text", text: "Plan is " },
            { kind: "text", text: "bold", bold: true },
          ],
        },
      ],
    },
    {
      id: "c2",
      sender: "Ada Lovelace",
      at: at(9, 9, 1),
      text: "@Mina Example can you?",
      mine: false,
      avatar: ADA_FACE,
      body: [
        {
          kind: "text",
          spans: [
            { kind: "mention", text: "@Mina Example" },
            { kind: "text", text: " can you?" },
          ],
        },
      ],
      mentions_me: true,
    },
    // Reactions and replies a Jira comment never has, so the card is seen to leave them out.
    {
      id: "c3",
      sender: "Bob Stone",
      at: at(9, 9, 30),
      text: "Same here",
      mine: false,
      replies: 2,
      reactions: [{ name: "eyes", count: 1, mine: false, emoji: null }],
    },
    { id: "c4", sender: "Ada Lovelace", at: at(10, 9, 0), text: "Next day", mine: false, avatar: ADA_FACE, unread: true, brought: true },
  ];
  const window: OutsideWindow = { view: "channel", thread_ts: null, more_before: true, more_after: false };
  // The card's controls can react and open threads, as a Slack card's do; a Jira card uses neither.
  const controls = { load: () => {}, openThread: () => {}, busy: null, react: () => {} };
  const draw = (state: Partial<Extract<ThreadState, { kind: "read" }>> = {}, facts: OutsideFacts = JIRA_FACTS, touch = false) =>
    renderToStaticMarkup(
      createElement(OutsideThread, {
        facts,
        touch,
        state: { kind: "read", messages: comments, window, controls, ticket: jiraTicket({ comment_count: 9 }), ...state },
      }),
    );

  test("faces on the first comment of each run, one name per run, clock times, day pills and the New line", () => {
    const html = draw();
    expect(html).toContain("loki-slack-thread");
    // Ada's two comments a minute apart are one run; Bob's, and Ada's on the next day, start their own.
    expect(html.match(/data-first="true"/g)).toHaveLength(3);
    expect(html.match(/<img[^>]*src="https:\/\/avatar-management\.example\/ada\/48"/g)).toHaveLength(2);
    expect(html.match(/class="loki-msg-name">Ada Lovelace/g)).toHaveLength(2);
    expect(html).toContain('<span class="sr-only">Ada Lovelace: </span>');
    expect(html.match(/<time class="loki-msg-time"/g)).toHaveLength(3);
    expect(html).toContain("loki-msg-day-pill");
    expect(html.match(/New since you last read/g)).toHaveLength(1);
    expect(html.indexOf("New since you last read")).toBeLessThan(html.indexOf("Next day"));
  });

  test("the words are drawn as Slack's blocks, a mention as its pill, and the wash is on the comment that mentions the person", () => {
    const html = draw();
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<span class="loki-mention">@Mina Example</span>');
    // The wash marks the mention, not the comment that only brought the card.
    expect(html.match(/loki-slack-brought/g)).toHaveLength(1);
    expect(html.indexOf("loki-slack-brought")).toBeGreaterThan(html.indexOf("Plan is"));
    expect(html.indexOf("loki-slack-brought")).toBeLessThan(html.indexOf("can you?"));
  });

  test("no reactions, no hover bar, no replies to open; load earlier and the comments heading stay", () => {
    const html = draw();
    expect(html).not.toContain("loki-slack-hoverbar");
    expect(html).not.toContain("loki-slack-reaction");
    expect(html).not.toContain("replies");
    expect(html).toContain(">load earlier<");
    expect(html).toContain("Comments · 9");
    expect(html.indexOf("Comments · 9")).toBeLessThan(html.indexOf("load earlier"));
  });

  test("a card from an older Mac, without the ticket, draws its log the same way", () => {
    const html = draw({ ticket: null });
    expect(html).not.toContain("Comments ·");
    expect(html.match(/data-first="true"/g)).toHaveLength(3);
    expect(html).toContain(">load earlier<");
    expect(html).not.toContain("loki-slack-hoverbar");
  });

  test("the phone keeps the plain list", () => {
    const html = draw({}, JIRA_FACTS, true);
    expect(html).not.toContain("loki-slack-thread");
    expect(html).not.toContain("data-first");
    expect(html).not.toContain("loki-slack-brought");
    expect(html).toContain("@Mina Example can you?");
  });

  test("a Slack card is as it was: the wash on what brought it, the hover bar, and its replies to open", () => {
    const html = draw({ ticket: null }, FACTS);
    expect(html.match(/loki-slack-brought/g)).toHaveLength(1);
    expect(html.indexOf("loki-slack-brought")).toBeGreaterThan(html.indexOf("Same here"));
    expect(html).toContain("loki-slack-hoverbar");
    expect(html).toContain("2 replies");
  });
});

describe("the moves a Jira card offers (plan 2026-11-10-1451, U6)", () => {
  const noop = () => {};
  const card = (facts: OutsideFacts) =>
    renderToStaticMarkup(
      createElement(OutsideCard, {
        current: attentionItem("10001#1", { outside: facts }),
        facts,
        flash: null,
        cameBack: false,
        typing: false,
        moves: { read: noop, later: noop, archive: noop, label: noop },
        onHandoff: noop,
      }),
    );

  test("on the desktop: hand off, later and read, with no archive or label, and hand off says the card stays", () => {
    const html = card(JIRA_FACTS);
    expect(html).toContain(">hand off<");
    expect(html).toContain(">later<");
    expect(html).toContain(">read<");
    expect(html).not.toContain(">archive<");
    expect(html).not.toContain(">label<");
    expect(html).toContain("give the whole ticket to friday in one of its chats; the card stays until you read it");
    // A Slack card keeps its archive and its hand-off words.
    const slack = card(FACTS);
    expect(slack).toContain(">archive<");
    expect(slack).toContain("the card leaves until someone writes again");
  });

  test("the key legend names only a Jira card's moves, and a comment rather than a reply", () => {
    const legend = (typing: boolean, current: Parameters<typeof KeysHint>[0]["current"]) => renderToStaticMarkup(createElement(KeysHint, { typing, current }));
    const jira = legend(false, jiraItem());
    expect(jira).not.toContain("archive");
    expect(jira).not.toContain("label");
    expect(jira).toContain(" comment");
    const typing = legend(true, jiraItem());
    expect(typing).toContain("enter comment (the card stays)");
    expect(typing).toContain("(a comment goes first)");
    expect(typing).not.toContain("archive");
    // Mail keeps its own.
    expect(legend(false, outsideItem("Lunch"))).toContain("archive");
    expect(legend(false, outsideItem("Lunch"))).toContain("label");
  });

  test("on the phone: Later and Read under a Jira card, and no Archive", () => {
    const decide = (onArchive?: () => void) =>
      renderToStaticMarkup(createElement(Decisions, { item: jiraItem(), onRead: noop, onLater: noop, onArchive, onApprove: noop }));
    expect(decide()).not.toContain("Archive");
    expect(decide()).toContain(">Later<");
    expect(decide()).toContain(">Read<");
    expect(decide(noop)).toContain(">Archive<");
  });
});

describe("a Jira card's comment box (plan 2026-11-10-1451, U7)", () => {
  const box: ReplyBoxControl = { text: "On it", mail: null, busy: false, error: null, onText: () => {}, onMail: () => {}, onSend: () => {} };
  test("on the desktop it comments on the ticket, sends on Enter, and says the card stays unread", () => {
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts: JIRA_FACTS, box }));
    expect(html).toContain('placeholder="comment on the ticket"');
    expect(html).toContain('title="post it on the ticket as you; the card stays, unread, for your next move"');
    expect(html).not.toContain("loki-mail-compose");
  });
  test("on the phone it says the comment posts as the person and the card stays; Slack's and mail's lines are as they were", () => {
    const phone = (facts: OutsideFacts) =>
      renderToStaticMarkup(createElement(OutsideReply, { facts, touch: true, onSend: () => Promise.resolve({ sent: true, error: null }) }));
    expect(phone(JIRA_FACTS)).toContain("Posts on the ticket as you. The card stays until you read it.");
    expect(phone(JIRA_FACTS)).toContain('placeholder="Comment on the ticket"');
    expect(phone(FACTS)).toContain("Sends as you. The card stays for your next swipe.");
  });
});

describe("Flow's agent lanes file outside cards under their owner", () => {
  test("a card from friday's Slack counts in friday's lane, not one of its own", () => {
    const chat = attentionItem("c", { agent_id: "agent-work", agent_name: "friday" });
    const card = attentionItem("o", { agent_id: `account:${SLACK}`, agent_name: "farmart (Slack)", outside: FACTS });
    expect(ownerAgentOf(card)).toBe("agent-work");
    expect(agentLanes([chat, card]).map((l) => [l.agent_id, l.name, l.count])).toEqual([["agent-work", "friday", 2]]);
    expect(agentLanes([card]).map((l) => l.name)).toEqual(["friday"]);
  });
});

describe("a Jira card's files say jira where Slack's say Slack (plan 092, U5)", () => {
  const comment = (files: OutsideMessage["slack_files"]): OutsideMessage => ({
    id: "c1",
    sender: "Ada Lovelace",
    at: "2026-11-10T09:00:00.000Z",
    text: "See attached",
    mine: false,
    slack_files: files,
  });
  const draw = (m: OutsideMessage) => renderToStaticMarkup(createElement(OutsideThread, { facts: JIRA_FACTS, state: { kind: "read", messages: [m] } }));

  test("a comment's PDF is a chip with its kind and size that opens in jira", () => {
    const html = draw(comment([{ name: "report.pdf", kind: "PDF", size: 2048, link: "https://acme.atlassian.net/rest/api/3/attachment/content/1" }]));
    expect(html).toContain('title="open report.pdf in jira"');
    expect(html).toContain("PDF · 2.0 KB");
    expect(html).not.toContain("in Slack");
  });
  test("a file with no link names jira as the place to open it", () => {
    const html = draw(comment([{ name: "notes.txt", kind: "Text", size: 10, link: null }]));
    expect(html).toContain('title="notes.txt: open it from jira"');
    expect(html).not.toContain("Slack");
  });
  test("a picture draws as itself with its name, and pressing it opens it in jira", () => {
    // The picture's address is the mod's, as a browser tab finds it.
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    vi.stubGlobal("localStorage", { getItem: () => null });
    const html = draw(
      comment([
        {
          name: "shot.png",
          kind: "PNG",
          size: 4096,
          link: "https://acme.atlassian.net/rest/api/3/attachment/content/2",
          preview: { name: `${"b".repeat(32)}.png`, width: 360, height: 200 },
        },
      ]),
    );
    vi.unstubAllGlobals();
    expect(html).toContain(`/chat-images/${"b".repeat(32)}.png`);
    expect(html).toContain("<figcaption>shot.png</figcaption>");
    expect(html).toContain('title="open shot.png in jira"');
    expect(html).not.toContain("in Slack");
  });
});
