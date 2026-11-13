import { describe, expect, test } from "vitest";
import { gmailThread, mailHeader, mailParts } from "../mod/account-ops/gmail.ts";
import type { GmailMessage, GmailMessagePart, GmailThread } from "../mod/gmail.ts";

/** The account operations (plan 097, U1): one reader per service, which every caller shares. */

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const part = (mimeType: string, text: string, filename = ""): GmailMessagePart => ({
  mimeType,
  filename,
  headers: [],
  body: { data: b64(text), size: text.length },
  parts: [],
});
const message = (id: string, from: string, subject: string, parts: GmailMessagePart[], snippet = ""): GmailMessage => ({
  id,
  threadId: "t1",
  labelIds: ["INBOX"],
  snippet,
  historyId: "1",
  internalDate: String(Date.UTC(2026, 10, 13, 9, 0)),
  payload: {
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "From", value: from },
      { name: "Subject", value: subject },
    ],
    body: { size: 0 },
    parts,
  },
});

describe("reading Gmail", () => {
  test("a thread gives its first message's subject and each message's text, the mailbox's own marked as the person's", async () => {
    const thread: GmailThread = {
      id: "t1",
      historyId: "1",
      messages: [
        message("m1", "Asha <asha@northwind.test>", "Invoice 42", [part("text/plain", "Hello,\r\nthe invoice.")]),
        message("m2", "Sam <sam@acme.test>", "Re: Invoice 42", [part("text/html", "<p>Paid <b>today</b></p>")]),
      ],
    };
    const read = await gmailThread({ getThread: () => Promise.resolve(thread) }, "gmail:sam@acme.test", "t1");
    expect(read.subject).toBe("Invoice 42");
    expect(read.messages.map((m) => [m.sender, m.mine, m.text.trim()])).toEqual([
      ["Asha <asha@northwind.test>", false, "Hello,\nthe invoice."],
      ["Sam <sam@acme.test>", true, "Paid today"],
    ]);
    expect(read.messages[0].at).toBe("2026-11-13T09:00:00.000Z");
  });

  test("a message's text: its plain part, else its HTML as text, else its snippet; an attached text file is not its text", () => {
    const attached = message("m1", "a@x.test", "s", [part("text/plain", "file contents", "notes.txt"), part("text/html", "<p>the body</p>")]);
    expect(mailParts(attached).text.trim()).toBe("the body");
    expect(mailParts(message("m2", "a@x.test", "s", [], "just the snippet")).text).toBe("just the snippet");
  });

  test("a header is found in any case", () => {
    expect(mailHeader(message("m1", "a@x.test", "Hi", []), "subject")).toBe("Hi");
    expect(mailHeader(message("m1", "a@x.test", "Hi", []), "Cc")).toBe("");
  });
});
