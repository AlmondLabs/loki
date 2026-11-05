import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideChange, OutsideFacts } from "../core/frame-types.ts";
import { ownerAgentOf } from "../core/attention/model.ts";
import { withoutQuoted } from "../core/mail-quote.ts";
import { agentPills } from "../app/src/desk/catch-up-parts.tsx";
import { OutsideThread, outsideTitle, replyPlace, senderName } from "../app/src/desk/outside-card.tsx";
import type { AccountRecord } from "../mod/accounts.ts";
import { PHONE_FRAMES, peerMeaning } from "../core/frames.ts";
import { accountFrames } from "../mod/frames/accounts.ts";
import type { GmailDraftInput, GmailMessage } from "../mod/gmail.ts";
import type { ThreadMessage } from "../mod/handoff.ts";
import { OutsideThreads } from "../mod/outside-threads.ts";
import type { SlackDraftInput } from "../mod/slack.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { bridgeOf, client, settled } from "./fixtures/frames.ts";

/** Outside cards for the person (plan 068): the whole thread on the card, and their own reply sent in it. */

const MAIL = "gmail:ada@acme.com";
const SLACK = "slack:T1:U1";

const account = (accountId: string, over: Partial<AccountRecord> = {}): AccountRecord => ({
  account_id: accountId,
  provider: accountId.startsWith("gmail:") ? "gmail" : "slack",
  address: accountId.startsWith("gmail:") ? "ada@acme.com" : "Acme",
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
function threads(opts: { accounts?: AccountRecord[]; thread?: ThreadMessage[]; gmail?: GmailMessage[]; sendFails?: string; thenFails?: string } = {}) {
  const sentMail: GmailDraftInput[] = [];
  const posted: SlackDraftInput[] = [];
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
    },
    threadText: { gmail: () => Promise.resolve(opts.thread ?? []), slack: () => Promise.resolve(opts.thread ?? []) },
    clientFor: (a) =>
      a.provider === "gmail"
        ? {
            provider: "gmail",
            client: {
              getThread: () => Promise.resolve({ id: "t1", historyId: "1", messages: opts.gmail ?? [] }),
              sendAsAddresses: () => Promise.resolve(["ada@work.example"]),
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
            },
          },
  });
  return { t, sentMail, posted, archived, moves };
}

describe("an email's own words, without the thread quoted under them", () => {
  test("cut at Gmail's and Apple Mail's 'On … wrote:', even when it wraps onto a second line", () => {
    expect(withoutQuoted("Friday works.\n\nOn Tue, 4 Nov 2026 at 10:02, Bob <bob@acme.com> wrote:\n> Lunch?")).toBe("Friday works.");
    expect(withoutQuoted("Yes.\nOn Tue, 4 Nov 2026 at 10:02, Bob\n<bob@acme.com> wrote:\n> Lunch?")).toBe("Yes.");
  });
  test("cut at Outlook's From: and Sent: block and at a forwarded message's rule, and trailing > lines go", () => {
    expect(withoutQuoted("Done.\n\nFrom: Bob <bob@acme.com>\nSent: Tuesday\nSubject: x")).toBe("Done.");
    expect(withoutQuoted("See below.\n---------- Forwarded message ---------\nFrom: x")).toBe("See below.");
    expect(withoutQuoted("ok\n> earlier\n> more")).toBe("ok");
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
    expect(await t.read(MAIL, "t1")).toEqual([
      { id: "m1", sender: "Bob <bob@acme.com>", at: "2026-11-04T10:00:00.000Z", text: "Lunch?", mine: false },
      { id: "at-1", sender: "Ada <ada@acme.com>", at: "2026-11-04T10:05:00.000Z", text: "Friday.", mine: true },
    ]);
  });
  test("an account not on this Mac is refused", async () => {
    await expect(threads({ accounts: [] }).t.read(MAIL, "t1")).rejects.toThrow("not connected on this Mac");
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
        to: ["Cy <cy@acme.com>", "bob@acme.com"],
        cc: [],
        subject: "Re: Lunch",
        body: "Friday works.",
      },
    ]);
    expect(archived).toEqual([`${MAIL}/t1`]);
  });
  test("Slack: in the thread for an Activity card, in the conversation for a DM", async () => {
    const { t, posted, archived } = threads();
    await t.reply(SLACK, "C1:1.0", "on it", "archive");
    await t.reply(SLACK, "D1", "thanks", "archive");
    expect(posted).toEqual([
      { channel: "C1", thread_ts: "1.0", text: "on it" },
      { channel: "D1", text: "thanks" },
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
    expect(sentMail.map((m) => m.body)).toEqual(["Can you send the deck by Friday?"]);
    expect(moves).toEqual([`waiting ${MAIL}/t1`, `unread ${MAIL}/t1`]);
  });
  test("Covers AE4. with archive, the reply is sent and the thread archived", async () => {
    const { t, sentMail, moves } = threads({ gmail: LUNCH });
    expect(await t.reply(MAIL, "t1", "Here it is.", "archive")).toMatchObject({ sent: true, then_error: null, change: { move: "archive", ended: true } });
    expect(sentMail).toHaveLength(1);
    expect(moves).toEqual([`archive ${MAIL}/t1`]);
  });
  test("with read, the reply is sent and the thread marked read, and the card does not end", async () => {
    const { t, sentMail, moves } = threads({ gmail: LUNCH });
    expect(await t.reply(MAIL, "t1", "Thanks.", "read")).toMatchObject({ sent: true, then_error: null, change: { move: "read", ended: false } });
    expect(sentMail).toHaveLength(1);
    expect(moves).toEqual([`read ${MAIL}/t1`]);
  });
  test("a sent reply whose archive fails answers sent with the archive's reason, and nothing is sent twice", async () => {
    const { t, posted } = threads({ thenFails: "Slack is out of reach" });
    expect(await t.reply(SLACK, "D1", "on it", "archive")).toEqual({ sent: true, then_error: "Slack is out of reach", change: null });
    expect(posted).toEqual([{ channel: "D1", text: "on it" }]);
  });
  test("a Gmail thread with no one else in it is refused before anything is sent", async () => {
    const { t, sentMail } = threads({ gmail: [message("m1", 1, { From: "ada@acme.com", To: "ada@work.example", Subject: "note" })] });
    await expect(t.reply(MAIL, "t1", "hi", "archive")).rejects.toThrow("no one in that thread to reply to");
    expect(sentMail).toEqual([]);
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
    const send = ask({
      read: () => Promise.resolve([{ id: "1.0", sender: "Bob", at: "", text: "hi", mine: false }]),
      reply: (_a, _t, text, then) =>
        text === "boom"
          ? Promise.reject(new Error("Slack refused it"))
          : Promise.resolve({ sent: true as const, then_error: then === "archive" ? "Slack is out of reach" : null, change: null }),
    });
    expect(await send({ type: "account_thread_read", account_id: SLACK, thread_id: "D1" })).toMatchObject({
      type: "account_thread",
      messages: [{ sender: "Bob", text: "hi" }],
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
    const reader = { read: () => Promise.resolve([]), reply: () => Promise.reject(new Error("reached")) };
    expect(await ask(reader)({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "  ", then: "read" })).toMatchObject({
      type: "error",
      message: "account_id, thread_id and text required",
    });
    expect(await ask(reader)({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok", then: "snooze" })).toMatchObject({
      type: "error",
      message: "then must be read, later or archive",
    });
    expect(await ask()({ type: "account_thread_reply", account_id: SLACK, thread_id: "D1", text: "ok", then: "archive" })).toMatchObject({
      type: "error",
      message: "replying is not available in this mod",
    });
  });
  test("a reply from an app before plan 070, which sends no move, is sent and then archived, as it was then", async () => {
    const thens: string[] = [];
    const send = ask({
      read: () => Promise.resolve([]),
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
  test("both go to the Mac the account lives on, and the phone may send them", () => {
    expect(peerMeaning("account_thread_read")).toMatchObject({ route: "home" });
    expect(peerMeaning("account_thread_reply")).toMatchObject({ route: "home", relists: true });
    expect(PHONE_FRAMES.has("account_thread_read") && PHONE_FRAMES.has("account_thread_reply")).toBe(true);
  });
});

describe("agents never send", () => {
  test("the send calls are called from the person's reply module and nowhere else in the mod", () => {
    const dir = join(import.meta.dirname, "..", "mod");
    const callers = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\.(sendReply|postReply)\(/.test(readFileSync(join(dir, f), "utf8")));
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

describe("the Inbox's tabs file outside cards under their owner", () => {
  test("a card from friday's Slack counts on friday's pill, not one of its own", () => {
    const chat = attentionItem("c", { agent_id: "agent-work", agent_name: "friday" });
    const card = attentionItem("o", { agent_id: `account:${SLACK}`, agent_name: "farmart (Slack)", outside: FACTS });
    expect(ownerAgentOf(card)).toBe("agent-work");
    expect(agentPills([chat, card]).map((p) => [p.agentId, p.name, p.count])).toEqual([["agent-work", "friday", 2]]);
    expect(agentPills([card]).map((p) => p.name)).toEqual(["friday"]);
  });
});
