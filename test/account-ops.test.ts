import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { IMAGE_NAME } from "../daemon/chat-images.ts";
import { gmailCardView, gmailThread, gmailThreadText, mailAttachments, mailHeader, mailParts } from "../mod/account-ops/gmail.ts";
import { MAIL_HTML_MAX } from "../mod/account-ops/thread.ts";
import { OutsidePreviews } from "../mod/outside-previews.ts";
import type { GmailMessage, GmailMessagePart, GmailThread } from "../mod/gmail.ts";

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

describe("pictures pasted into a mail", () => {
  const NAME = `${"a".repeat(32)}.png`;
  const picture = (contentId: string, over: Partial<GmailMessagePart> = {}): GmailMessagePart => ({
    mimeType: "image/png",
    filename: "image.png",
    headers: [{ name: "Content-ID", value: `<${contentId}>` }],
    body: { size: 2048, attachmentId: `att-${contentId}` },
    parts: [],
    ...over,
  });
  const pdf: GmailMessagePart = { mimeType: "application/pdf", filename: "terms.pdf", headers: [], body: { size: 4096, attachmentId: "att-pdf" }, parts: [] };
  const threadOf = (html: string, files: GmailMessagePart[]): GmailThread => ({
    id: "t1",
    historyId: "1",
    messages: [message("m1", "Shimbhu <s@farm.test>", "GST", [part("text/html", html), ...files])],
  });

  interface Asked {
    key: string;
    read: () => Promise<{ data: Buffer; type: string }>;
  }

  function pictures(answer: (key: string) => Promise<string | null> = () => Promise.resolve(NAME)) {
    const asked: Asked[] = [];
    const attachments: string[] = [];
    let endWait = (): void => {};
    const waitOver = new Promise<void>((done) => (endWait = done));
    return {
      asked,
      attachments,
      endWait: () => endWait(),
      pictures: {
        keep: (key: string, read: Asked["read"]) => {
          asked.push({ key, read });
          return answer(key);
        },
        attachment: (messageId: string, attachmentId: string) => {
          attachments.push(`${messageId}/${attachmentId}`);
          return Promise.resolve(Buffer.from("png bytes"));
        },
        waited: () => waitOver,
      },
    };
  }

  const read = (thread: GmailThread, p?: ReturnType<typeof pictures>["pictures"]) =>
    gmailThread({ getThread: () => Promise.resolve(thread) }, "gmail:sam@acme.test", "t1", p);

  test("a pasted picture is named for its card and is not counted as a file", async () => {
    const p = pictures();
    const got = await read(threadOf('<p>We are facing this.</p><img src="cid:ii_abc" alt="image.png">', [picture("ii_abc")]), p.pictures);
    expect(p.asked.map((a) => a.key)).toEqual(["gmail:gmail:sam@acme.test:m1:ii_abc"]);
    expect(got.messages[0].inline_images).toEqual({ ii_abc: NAME });
    expect(got.messages[0].files).toBeUndefined();
  });

  test("a picture's bytes come from Gmail's attachment, or from the part itself when Gmail sent it inline", async () => {
    const p = pictures();
    const small = picture("ii_small", { body: { size: 4, data: Buffer.from("tiny").toString("base64url") } });
    await read(threadOf('<img src="cid:ii_abc"><img src="cid:ii_small">', [picture("ii_abc"), small]), p.pictures);
    const [big, tiny] = await Promise.all(p.asked.map((a) => a.read()));
    expect(big).toEqual({ data: Buffer.from("png bytes"), type: "image/png" });
    expect(p.attachments).toEqual(["m1/att-ii_abc"]);
    expect(tiny).toEqual({ data: Buffer.from("tiny"), type: "image/png" });
  });

  test("a picture the store does not name stays a file, with nothing named", async () => {
    const p = pictures(() => Promise.resolve(null));
    const got = await read(threadOf('<img src="cid:ii_abc">', [picture("ii_abc", { mimeType: "image/svg+xml" })]), p.pictures);
    expect(got.messages[0].inline_images).toBeUndefined();
    expect(got.messages[0].files).toEqual([{ name: "image.png", size: 2048 }]);
  });

  test("a cid: link written percent-encoded names the same picture", async () => {
    const p = pictures();
    const got = await read(threadOf("<img src='cid:ii%5Fabc'>", [picture("ii_abc")]), p.pictures);
    expect(got.messages[0].inline_images).toEqual({ ii_abc: NAME });
  });

  test("a picture the HTML does not show is not fetched and stays a file", async () => {
    const p = pictures();
    const got = await read(threadOf("<p>No picture here.</p>", [picture("ii_abc")]), p.pictures);
    expect(p.asked).toEqual([]);
    expect(got.messages[0].files).toEqual([{ name: "image.png", size: 2048 }]);
  });

  test("a cid: link the card would not draw, after the body or inside a dropped element, leaves its picture a file", async () => {
    const p = pictures();
    const html = '<html><body><p>Hi</p><noscript><img src="cid:ii_hidden"></noscript></body></html><img src="cid:ii_after">';
    const got = await read(threadOf(html, [picture("ii_hidden"), picture("ii_after")]), p.pictures);
    expect(p.asked).toEqual([]);
    expect(got.messages[0].files).toEqual([
      { name: "image.png", size: 2048 },
      { name: "image.png", size: 2048 },
    ]);
  });

  test("a mail whose HTML is too long to draw fetches nothing and keeps its files", async () => {
    const p = pictures();
    const got = await read(threadOf(`<img src="cid:ii_abc">${"x".repeat(MAIL_HTML_MAX)}`, [picture("ii_abc")]), p.pictures);
    expect(p.asked).toEqual([]);
    expect(got.messages[0].html).toBeUndefined();
    expect(got.messages[0].files).toEqual([{ name: "image.png", size: 2048 }]);
  });

  test("only the PDF stays a file beside a pasted picture, and a forward still carries both", async () => {
    const p = pictures();
    const thread = threadOf('<img src="cid:ii_abc">', [picture("ii_abc"), pdf]);
    const got = await read(thread, p.pictures);
    expect(got.messages[0].files).toEqual([{ name: "terms.pdf", size: 4096 }]);
    expect(mailAttachments(thread.messages[0]).map((f) => f.filename)).toEqual(["image.png", "terms.pdf"]);
  });

  test("a picture that fails leaves the read and the other pictures as they are", async () => {
    const p = pictures((key) => (key.endsWith(":ii_bad") ? Promise.reject(new Error("refused")) : Promise.resolve(NAME)));
    const got = await read(threadOf('<img src="cid:ii_bad"><img src="cid:ii_abc">', [picture("ii_bad"), picture("ii_abc")]), p.pictures);
    expect(got.messages[0].inline_images).toEqual({ ii_abc: NAME });
    expect(got.messages[0].files).toEqual([{ name: "image.png", size: 2048 }]);
  });

  test("the read answers when the wait runs out, with a slow picture left as a file", async () => {
    const p = pictures((key) => (key.endsWith(":ii_slow") ? new Promise<string>(() => {}) : Promise.resolve(NAME)));
    const reading = read(threadOf('<img src="cid:ii_slow"><img src="cid:ii_abc">', [picture("ii_slow"), picture("ii_abc")]), p.pictures);
    p.endWait();
    const got = await reading;
    expect(got.messages[0].inline_images).toEqual({ ii_abc: NAME });
    expect(got.messages[0].files).toEqual([{ name: "image.png", size: 2048 }]);
  });

  test("a malformed cid: link beside a real picture does not stop the read", async () => {
    const p = pictures();
    const got = await read(threadOf('<img src="cid:%zz"><img src="cid:ii_abc">', [picture("ii_abc")]), p.pictures);
    expect(got.messages[0].inline_images).toEqual({ ii_abc: NAME });
  });

  test("a Gmail card keeps each picture once in the picture store, and a second open fetches nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-mail-pictures-"));
    try {
      const store = new OutsidePreviews({ dir });
      const fetched: string[] = [];
      const client = {
        getThread: () => Promise.resolve(threadOf('<img src="cid:ii_abc">', [picture("ii_abc")])),
        attachment: (messageId: string, attachmentId: string) => {
          fetched.push(`${messageId}/${attachmentId}`);
          return Promise.resolve(Buffer.from("png bytes"));
        },
      };
      const view = gmailCardView(
        () => client,
        (key, read) => store.preview(key, read),
        () => new Promise<void>(() => {}),
      );
      const facts = { dealt_message_id: null, brought_ids: [], newest_message_id: "m1" };
      const first = await view("gmail:sam@acme.test", "t1", facts, {});
      const second = await view("gmail:sam@acme.test", "t1", facts, {});
      expect(first.window).toBeNull();
      const name = first.messages[0].inline_images?.ii_abc ?? "";
      expect(name).toMatch(IMAGE_NAME);
      expect(readFileSync(join(dir, name), "utf8")).toBe("png bytes");
      expect(second.messages[0].inline_images).toEqual({ ii_abc: name });
      expect(fetched).toEqual(["m1/att-ii_abc"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reading the thread's text for a hand-off fetches no pictures and keeps its files", async () => {
    const thread = threadOf('<img src="cid:ii_abc">', [picture("ii_abc")]);
    const [m] = await gmailThreadText(() => ({ getThread: () => Promise.resolve(thread) }))("gmail:sam@acme.test", "t1");
    expect(m.inline_images).toBeUndefined();
    expect(m.files).toEqual([{ name: "image.png", size: 2048 }]);
  });
});
