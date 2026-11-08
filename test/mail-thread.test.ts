import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailCompose, OutsideFacts, OutsideMessage } from "../core/frame-types.ts";
import { MailThread, fileSize, mailWhen, sentToLine } from "../app/src/desk/mail-thread.tsx";
import { OutsideCard, OutsideReply, type ReplyBoxControl } from "../app/src/desk/outside-card.tsx";
import type { AttentionItem } from "../core/attention/model.ts";
import { gmailThreadText } from "../mod/handoff.ts";
import type { GmailMessagePart, GmailThread } from "../mod/gmail.ts";

/** A desktop mail card laid out as Gmail lays out a thread (plan 078). */

const OWN = ["sam@acme.test"];

describe("the header line", () => {
  test("says whom a mail went to, the person as you, two names and then how many more", () => {
    expect(sentToLine({ to: '"Sam Lee" <Sam@acme.test>', cc: "Dev Patel <dev@acme.test>" }, OWN)).toBe("to you, cc Dev Patel");
    expect(sentToLine({ to: "a@x.test, Bo <b@x.test>, c@x.test, d@x.test" }, OWN)).toBe("to a@x.test, Bo and 2 others");
    expect(sentToLine({}, OWN)).toBe("");
  });

  test("says when as the time today, the day this year, and the year before that", () => {
    const now = new Date(2026, 10, 9, 15, 0);
    expect(mailWhen(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toBe("09:05");
    expect(mailWhen(new Date(2026, 10, 6, 9, 5).toISOString(), now)).toBe("6 Nov");
    expect(mailWhen(new Date(2025, 0, 2).toISOString(), now)).toBe("2 Jan 2025");
    expect(mailWhen("", now)).toBe("");
  });

  test("says a file's size in bytes, KB or MB", () => {
    expect(fileSize(500)).toBe("500 B");
    expect(fileSize(2048)).toBe("2.0 KB");
    expect(fileSize(300 * 1024)).toBe("300 KB");
    expect(fileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });
});

describe("the thread", () => {
  const mails: OutsideMessage[] = [
    { id: "m1", sender: "Asha Rao <asha@northwind.test>", at: "", text: "\nHi team, since Tuesday…", mine: false },
    {
      id: "m2",
      sender: "Asha Rao <asha@northwind.test>",
      at: "",
      text: "Still happening.",
      mine: false,
      to: "sam@acme.test",
      cc: "Dev Patel <dev@acme.test>",
      files: [
        { name: "shot.png", size: 2048 },
        { name: "shot.png", size: 4096 },
      ],
    },
  ];

  test("folds the mails before the newest and gives the newest its header line and its files", () => {
    const html = renderToStaticMarkup(createElement(MailThread, { messages: mails, own: OWN }));
    expect(html.match(/loki-mail-msg--folded/g)).toHaveLength(1);
    expect(html).toContain("Hi team, since Tuesday…");
    expect(html).toContain("&lt;asha@northwind.test&gt;");
    expect(html).toContain("to you, cc Dev Patel");
    expect(html.match(/shot\.png/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("4.0 KB");
  });

  test("the reader passes each mail's To, Cc and files on to the card", async () => {
    const header = (name: string, value: string) => ({ name, value });
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      filename: "",
      headers: [header("From", "Asha <asha@northwind.test>"), header("To", "sam@acme.test"), header("Cc", "dev@acme.test")],
      body: { size: 0 },
      parts: [
        { mimeType: "text/plain", filename: "", headers: [], body: { size: 3, data: Buffer.from("Hi.").toString("base64url") }, parts: [] },
        { mimeType: "image/png", filename: "shot.png", headers: [], body: { size: 2048, attachmentId: "a1" }, parts: [] },
      ],
    };
    const thread: GmailThread = {
      id: "t1",
      historyId: "1",
      messages: [{ id: "m1", threadId: "t1", labelIds: [], snippet: "", historyId: "1", internalDate: "0", payload }],
    };
    const read = gmailThreadText(() => ({ getThread: () => Promise.resolve(thread) }));
    const [m] = await read("gmail:sam@acme.test", "t1");
    expect(m).toMatchObject({ to: "sam@acme.test", cc: "dev@acme.test", files: [{ name: "shot.png", size: 2048 }] });
  });
});

describe("the reply box", () => {
  const facts: OutsideFacts = {
    account_id: "gmail:sam@acme.test",
    provider: "gmail",
    account_label: "sam@acme.test",
    thread_id: "t1",
    generation: 0,
    owner_agent_id: "agent-work",
    owner_name: "friday",
    sender: "Asha Rao <asha@northwind.test>",
    sender_address: "asha@northwind.test",
    subject: "Checkout fails",
    lines: ["Still happening."],
    newest_message_id: "m2",
    newest_at: "2026-11-09T10:00:00.000Z",
    handoff_conversation_id: null,
    disconnected: null,
  };
  const compose: MailCompose = {
    modes: { reply: { to: ["asha@northwind.test"], cc: [] }, reply_all: { to: ["asha@northwind.test"], cc: ["dev@acme.test"] } },
    from: [{ address: "sam@acme.test", name: "Sam", signature: "Sam" }],
    default_from: "sam@acme.test",
    subject: "Re: Checkout fails",
    people: [],
  };
  const box: ReplyBoxControl = { text: "", mail: null, busy: false, error: null, onText: () => {}, onMail: () => {}, onSend: () => {} };

  test("on the desktop a mail's box is one frame with send and discard, and leaves the card's moves to the card", () => {
    const moves = createElement("span", null, "the moves");
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts, box, compose, actions: moves }));
    expect(html).toContain("loki-mail-compose");
    expect(html).toContain("discard");
    expect(html).not.toContain("the moves");
  });

  test("the header says the mailbox as where the mail came in, after when, so it never reads as the sender's", () => {
    const noop = () => {};
    const card = (only: boolean) =>
      renderToStaticMarkup(
        createElement(OutsideCard, {
          current: { id: "o1", outside: facts } as unknown as AttentionItem,
          facts: { ...facts, only_account: only },
          flash: null,
          cameBack: false,
          typing: false,
          moves: { read: noop, later: noop, archive: noop, label: noop },
        }),
      );
    const html = card(false);
    expect(html.indexOf("in sam@acme.test")).toBeGreaterThan(html.indexOf("Asha Rao"));
    expect(html).toContain("in sam@acme.test");
    expect(card(true)).not.toContain("sam@acme.test");
  });

  test("on the phone the box keeps its moves on the send row", () => {
    const moves = createElement("span", null, "the moves");
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts, box, compose, actions: moves, touch: true }));
    expect(html).not.toContain("loki-mail-compose");
    expect(html).toContain("the moves");
  });
});
