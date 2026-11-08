import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { MailAddressing, OutsideChange } from "../core/frame-types.ts";
import { FRAMES } from "../core/frames.ts";
import type { AccountRecord } from "../mod/accounts.ts";
import { rfc2822, type GmailDraftInput, type GmailMessage, type GmailMessagePart, type GmailSendAs } from "../mod/gmail.ts";
import { forwardSubject, fromHeader, mailBody, mailDate } from "../mod/mail-compose.ts";
import { MailOutbox } from "../mod/mail-outbox.ts";
import { MailPeople, headerPeople } from "../mod/mail-people.ts";
import { OutsideThreads } from "../mod/outside-threads.ts";
import { replyOf } from "../mod/reply-proposals.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutsideReply } from "../app/src/desk/outside-card.tsx";
import { outsideItem } from "./fixtures/outside-item.ts";
import { must } from "./fixtures/must.ts";
import { addressSummary, addressingFor, recipientName, startAddressing, suggest, typedRecipient } from "../app/src/desk/mail-address.tsx";

/** Replying to mail the way Gmail does (plan 076): recipients, modes, the quote, the signature, From and undo send. */

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "loki-mail-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAIL = "gmail:ada@acme.com";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const account: AccountRecord = {
  account_id: MAIL,
  provider: "gmail",
  address: "ada@acme.com",
  owner_agent_id: "agent-work",
  status: "connected",
  connected_at: "2026-11-01T00:00:00.000Z",
  backfill: {},
};

const leaf = (mimeType: string, data: string, over: Partial<GmailMessagePart> = {}): GmailMessagePart => ({
  mimeType,
  filename: "",
  headers: [],
  body: { size: data.length, data: b64(data) },
  parts: [],
  ...over,
});

/** A message from Pinku to Ada, in plain text and HTML, with a file on it. */
const PINKU: GmailMessage = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  snippet: "",
  historyId: "1",
  internalDate: String(Date.parse("2026-11-06T10:02:00Z")),
  payload: {
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "From", value: "Pinku Kumar <pinku@shop.example>" },
      { name: "To", value: "ada@acme.com" },
      { name: "Cc", value: "Ops <ops@acme.com>" },
      { name: "Subject", value: "App will not open" },
      { name: "Message-ID", value: "<p1@shop.example>" },
    ],
    body: { size: 0 },
    parts: [
      {
        mimeType: "multipart/alternative",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts: [leaf("text/plain", "Please update\nit fails"), leaf("text/html", "<html><body><p>Please update</p></body></html>")],
      },
      { mimeType: "image/png", filename: "screen.png", headers: [], body: { size: 4, attachmentId: "a1" }, parts: [] },
    ],
  },
};

const SEND_AS: GmailSendAs[] = [
  { address: "ada@acme.com", name: "Ada Lovelace", signature: "<div>Ada<br>Acme support</div>", isDefault: true },
  { address: "help@acme.com", name: "Acme help", signature: "", isDefault: false },
];

/** OutsideThreads on one Gmail account with Pinku's thread, recording what was sent and moved. */
function mail(opts: { outbox?: string; now?: () => Date; after?: (fn: () => void, ms: number) => () => void; sendFails?: string } = {}) {
  const sent: GmailDraftInput[] = [];
  const moves: string[] = [];
  const now = opts.now ?? (() => new Date("2026-11-08T00:00:00Z"));
  const people = new MailPeople({ file: join(scratch(), "people.json"), defer: () => {}, now: () => new Date("2026-11-08T00:00:00Z") });
  const write =
    (move: OutsideChange["move"]) =>
    (_a: string, threadId: string): Promise<OutsideChange | null> => {
      moves.push(`${move} ${threadId}`);
      return Promise.resolve({ move, messages: [], ended: move === "archive", was_unread: true });
    };
  const t = new OutsideThreads({
    accounts: { get: (id) => (id === MAIL ? account : null) },
    threads: { archive: write("archive"), markRead: write("read"), markUnread: write("unread"), markWaiting: () => true },
    threadText: { gmail: () => Promise.resolve([]), slack: () => Promise.resolve([]) },
    clientFor: () => ({
      provider: "gmail",
      client: {
        getThread: () => Promise.resolve({ id: "t1", historyId: "1", messages: [PINKU] }),
        sendAs: () => Promise.resolve(SEND_AS),
        attachment: (messageId, attachmentId) => Promise.resolve(Buffer.from(`${messageId}/${attachmentId}`)),
        sendReply: (r) => {
          if (opts.sendFails) return Promise.reject(new Error(opts.sendFails));
          sent.push(r);
          return Promise.resolve({ id: "s1" });
        },
      },
    }),
    people,
    zone: "UTC",
    now,
    ...(opts.outbox ? { outbox: { file: opts.outbox, now, ...(opts.after ? { after: opts.after } : {}) } } : {}),
  });
  return { t, sent, moves, people };
}

/** A timer the test fires itself. */
function timers() {
  const due: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  return {
    after: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      due.push(t);
      return () => (t.live = false);
    },
    fire: () => {
      for (const t of due.splice(0)) if (t.live) t.fn();
    },
    pending: () => due.filter((t) => t.live).map((t) => t.ms),
  };
}
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("the body Gmail would write", () => {
  const quoted = {
    from: "Pinku <p@x.example>",
    at: "2026-11-06T10:02:00Z",
    to: "ada@acme.com",
    cc: "",
    subject: "Help",
    text: "Please update\nit fails",
    html: null,
  };
  test("the words, the signature after '-- ', and the mail quoted line by line under 'On … wrote:'", () => {
    const out = mailBody({ text: "Looking now.\n", signature: "<div>Ada</div>", quoted, forward: false, zone: "UTC" });
    expect(out.text).toBe("Looking now.\n\n-- \nAda\n\nOn Fri, 6 Nov 2026 at 10:02, Pinku <p@x.example> wrote:\n> Please update\n> it fails");
    expect(out.html).toContain('<div dir="ltr">Looking now.</div>');
    expect(out.html).toContain('class="gmail_signature"><div>Ada</div>');
    expect(out.html).toContain('<blockquote class="gmail_quote"');
    expect(out.html).toContain("On Fri, 6 Nov 2026 at 10:02, Pinku &lt;p@x.example&gt; wrote:");
  });
  test("a forward sets the mail out under its headers instead, and text is escaped in the HTML", () => {
    const out = mailBody({ text: "eng: <see below>", signature: null, quoted: { ...quoted, cc: "ops@acme.com" }, forward: true, zone: "UTC" });
    expect(out.text.split("\n").slice(0, 8)).toEqual([
      "eng: <see below>",
      "",
      "---------- Forwarded message ---------",
      "From: Pinku <p@x.example>",
      "Date: Fri, 6 Nov 2026 at 10:02",
      "Subject: Help",
      "To: ada@acme.com",
      "Cc: ops@acme.com",
    ]);
    expect(out.html).toContain("eng: &lt;see below&gt;");
    expect(out.html).not.toContain("blockquote");
  });
  test("a mail with nothing to quote is answered without an empty quote; dates and headers are written as mail writes them", () => {
    expect(mailBody({ text: "ok", signature: null, quoted: { ...quoted, text: " " }, forward: false }).text).toBe("ok");
    expect(mailDate("not a date")).toBe("");
    expect(forwardSubject("Help")).toBe("Fwd: Help");
    expect(forwardSubject("Fwd: Help")).toBe("Fwd: Help");
    expect(fromHeader("ada@acme.com", 'Ada "A" Lovelace')).toBe('"Ada A Lovelace" <ada@acme.com>');
    expect(fromHeader("ada@acme.com", "आदा")).toBe(`=?UTF-8?B?${Buffer.from("आदा").toString("base64")}?= <ada@acme.com>`);
    expect(fromHeader("ada@acme.com", "")).toBe("ada@acme.com");
  });
  test("the message carries From and Bcc, plain text and HTML together, and forwarded files after them", () => {
    const raw = rfc2822({
      threadId: "t1",
      inReplyTo: "<p1@x>",
      references: [],
      from: '"Ada" <ada@acme.com>',
      to: ["p@x.example"],
      cc: [],
      bcc: ["boss@acme.com\r\nX-Evil: 1"],
      subject: "Re: Help",
      body: "ok",
      html: "<div>ok</div>",
      attachments: [{ filename: "screen shot.png", mimeType: "image/png", data: Buffer.from("png") }],
    });
    expect(raw).toContain('From: "Ada" <ada@acme.com>\r\n');
    // An address with a line break in it never adds a header of its own.
    expect(raw).toContain("Bcc: boss@acme.com X-Evil: 1\r\n");
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="loki-mix"');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="loki-alt"');
    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");
    expect(raw).toContain("Content-Disposition: attachment; filename*=UTF-8''screen%20shot.png");
    expect(raw).toContain(Buffer.from("png").toString("base64"));
    expect(raw.trimEnd().endsWith("--loki-mix--")).toBe(true);
  });
});

describe("who each mode goes to", () => {
  const msg = (headers: Record<string, string>): GmailMessage => ({
    ...PINKU,
    payload: { mimeType: "text/plain", filename: "", headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { size: 0 }, parts: [] },
  });
  test("reply goes to the sender alone, or to whom Reply-To names; the person's own mail is answered to whom it went", () => {
    expect(replyOf(msg({ From: "Bob <bob@acme.com>", To: "ada@acme.com, cy@acme.com" }), ["ada@acme.com"])).toEqual({ to: ["Bob <bob@acme.com>"], cc: [] });
    expect(replyOf(msg({ From: "Bob <bob@acme.com>", "Reply-To": "help@shop.example" }), ["ada@acme.com"])).toEqual({ to: ["help@shop.example"], cc: [] });
    expect(replyOf(msg({ From: "ada@acme.com", To: "Bob <bob@acme.com>" }), ["ada@acme.com"])).toEqual({ to: ["Bob <bob@acme.com>"], cc: [] });
  });
});

describe("what the recipients line starts from", () => {
  test("reply and reply all, every address the person sends from with its signature as text, the subject, and the thread's people first", async () => {
    const { t, people } = mail();
    people.saw(MAIL, [{ name: "Eng", address: "eng@acme.com" }], 1, []);
    expect(await t.compose(MAIL, "t1")).toEqual({
      modes: {
        reply: { to: ["Pinku Kumar <pinku@shop.example>"], cc: [] },
        reply_all: { to: ["Pinku Kumar <pinku@shop.example>"], cc: ["Ops <ops@acme.com>"] },
      },
      from: [
        { address: "ada@acme.com", name: "Ada Lovelace", signature: "Ada\nAcme support" },
        { address: "help@acme.com", name: "Acme help", signature: "" },
      ],
      default_from: "ada@acme.com",
      subject: "App will not open",
      people: [
        { name: "Pinku Kumar", address: "pinku@shop.example" },
        { name: "Ops", address: "ops@acme.com" },
        { name: "Eng", address: "eng@acme.com" },
      ],
    });
  });
});

describe("sending a mail reply as the person addressed it", () => {
  const addressing = (over: Partial<MailAddressing> = {}): MailAddressing => ({
    mode: "reply_all",
    to: ["Pinku Kumar <pinku@shop.example>"],
    cc: ["Ops <ops@acme.com>", "Eng <eng@acme.com>"],
    bcc: [],
    from: null,
    signature: true,
    ...over,
  });
  test("someone added to Cc gets it, with the signature and the quote, threaded, and they come first in suggestions after", async () => {
    const { t, sent, moves, people } = mail();
    expect(await t.reply(MAIL, "t1", "Adding eng to look.", "read", addressing())).toMatchObject({ sent: true, then_error: null });
    const m = sent[0];
    expect(m).toMatchObject({
      from: '"Ada Lovelace" <ada@acme.com>',
      to: ["Pinku Kumar <pinku@shop.example>"],
      cc: ["Ops <ops@acme.com>", "Eng <eng@acme.com>"],
      bcc: [],
      subject: "Re: App will not open",
      inReplyTo: "<p1@shop.example>",
    });
    expect(m.body).toBe(
      "Adding eng to look.\n\n-- \nAda\nAcme support\n\nOn Fri, 6 Nov 2026 at 10:02, Pinku Kumar <pinku@shop.example> wrote:\n> Please update\n> it fails",
    );
    expect(m.html).toContain("<p>Please update</p>");
    expect(m.html).not.toContain("<body>");
    expect(m.attachments).toBeUndefined();
    expect(moves).toEqual(["read t1"]);
    expect(people.top(MAIL).map((p) => p.address)).toContain("eng@acme.com");
  });
  test("without the signature, from another address the person sends from, with Bcc", async () => {
    const { t, sent } = mail();
    await t.reply(MAIL, "t1", "ok", "read", addressing({ signature: false, from: "help@acme.com", bcc: ["boss@acme.com"] }));
    expect(sent[0]).toMatchObject({ from: '"Acme help" <help@acme.com>', bcc: ["boss@acme.com"] });
    expect(sent[0]?.body.startsWith("ok\n\nOn ")).toBe(true);
  });
  test("a forward says Fwd:, sets the mail out under its headers, and carries its files", async () => {
    const { t, sent } = mail();
    await t.reply(MAIL, "t1", "eng, can you look?", "archive", addressing({ mode: "forward", to: ["eng@acme.com"], cc: [] }));
    expect(sent[0]).toMatchObject({ subject: "Fwd: App will not open", to: ["eng@acme.com"], cc: [] });
    expect(sent[0]?.body).toContain("---------- Forwarded message ---------");
    expect(sent[0]?.attachments?.map((a) => [a.filename, a.mimeType, a.data.toString()])).toEqual([["screen.png", "image/png", "m1/a1"]]);
  });
  test("nobody to send to, an address the person does not send from, or recipients on a Slack reply are refused before anything goes", async () => {
    const { t, sent } = mail();
    await expect(t.reply(MAIL, "t1", "ok", "read", addressing({ to: [], cc: [] }))).rejects.toThrow("add someone to send it to");
    await expect(t.reply(MAIL, "t1", "ok", "read", addressing({ from: "evil@acme.com" }))).rejects.toThrow("that is not an address you send from in Gmail");
    expect(sent).toEqual([]);
  });
  test("a reply with no addressing goes to all from the address the mail came to, with the signature, as before plus the signature", async () => {
    const { t, sent } = mail();
    await t.reply(MAIL, "t1", "ok", "read");
    expect(sent[0]).toMatchObject({ from: '"Ada Lovelace" <ada@acme.com>', to: ["Pinku Kumar <pinku@shop.example>"], cc: ["Ops <ops@acme.com>"] });
    expect(sent[0]?.body).toContain("-- \nAda");
  });
});

describe("undo send", () => {
  test("a mail reply with an id waits its 10 seconds before it goes, and the key's move comes after", async () => {
    const tm = timers();
    const { t, sent, moves } = mail({ outbox: join(scratch(), "outbox.json"), after: tm.after });
    const answer = t.reply(MAIL, "t1", "ok", "read", null, "o1-abcdefgh");
    await settle();
    expect(tm.pending()).toEqual([10_000]);
    expect(sent).toEqual([]);
    expect(moves).toEqual([]);
    tm.fire();
    expect(await answer).toMatchObject({ sent: true, change: { move: "read" } });
    expect(sent).toHaveLength(1);
  });
  test("undo while it waits stops it: nothing is sent or moved, and the reply answers undone", async () => {
    const tm = timers();
    const file = join(scratch(), "outbox.json");
    const { t, sent, moves } = mail({ outbox: file, after: tm.after });
    const answer = t.reply(MAIL, "t1", "ok", "read", null, "o1-abcdefgh");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ held: [{ outbox_id: "o1-abcdefgh", text: "ok" }] });
    expect(t.unsend("gmail:someone@else.example", "o1-abcdefgh")).toBe(false);
    expect(t.unsend(MAIL, "o1-abcdefgh")).toBe(true);
    expect(await answer).toEqual({ sent: false, undone: true });
    tm.fire();
    await settle();
    expect([...sent, ...moves]).toEqual([]);
    expect(t.unsend(MAIL, "o1-abcdefgh")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, held: [] });
  });
  test("a reply held when the daemon stopped goes when it starts again; one already gone from the file is never sent twice", async () => {
    const file = join(scratch(), "outbox.json");
    let now = new Date("2026-11-08T00:00:00Z");
    const first = mail({ outbox: file, now: () => now, after: timers().after });
    void first.t.reply(MAIL, "t1", "ok", "archive", null, "o1-abcdefgh");
    now = new Date("2026-11-08T00:01:00Z");
    const tm = timers();
    const second = mail({ outbox: file, now: () => now, after: tm.after });
    second.t.resume();
    expect(tm.pending()).toEqual([0]);
    tm.fire();
    await settle();
    await settle();
    expect(second.sent).toHaveLength(1);
    expect(second.moves).toEqual(["archive t1"]);
    second.t.resume();
    expect(tm.pending()).toEqual([]);
  });
  test("a send that fails after its wait rejects with its reason; the outbox holds an id once", async () => {
    const tm = timers();
    const { t } = mail({ outbox: join(scratch(), "outbox.json"), after: tm.after, sendFails: "Gmail refused it" });
    const answer = t.reply(MAIL, "t1", "ok", "read", null, "o1-abcdefgh");
    await expect(t.reply(MAIL, "t1", "ok", "read", null, "o1-abcdefgh")).rejects.toThrow("already on its way");
    tm.fire();
    await expect(answer).rejects.toThrow("Gmail refused it");
  });
  test("without an id the reply goes at once, as from a client before plan 076", async () => {
    const tm = timers();
    const { t, sent } = mail({ outbox: join(scratch(), "outbox.json"), after: tm.after });
    await t.reply(MAIL, "t1", "ok", "read");
    expect(sent).toHaveLength(1);
    expect(tm.pending()).toEqual([]);
  });
  test("the outbox's own timer runs when none is given", async () => {
    const box = new MailOutbox({
      file: join(scratch(), "outbox.json"),
      holdMs: 0,
      send: () => Promise.resolve({ sent: true, then_error: null, change: null }),
    });
    expect(await box.hold({ outbox_id: "o2-abcdefgh", account_id: MAIL, thread_id: "t1", text: "ok", then: "read", mail: null })).toMatchObject({ sent: true });
  });
});

describe("the people an account has mail with", () => {
  test("names and addresses from headers, quoted names kept, groups and junk left out", () => {
    expect(headerPeople('"Kumar, Pinku" <Pinku@Shop.example>, eng@acme.com, undisclosed-recipients:;')).toEqual([
      { name: "Kumar, Pinku", address: "pinku@shop.example" },
      { name: "", address: "eng@acme.com" },
    ]);
  });
  test("each newer message counts once, the person's own addresses are left out, and the most often and lately come first", () => {
    const file = join(scratch(), "people.json");
    const people = new MailPeople({ file, defer: () => {}, now: () => new Date(100 * 24 * 3600 * 1000) });
    const eng = { name: "Eng", address: "eng@acme.com" };
    const old = { name: "", address: "old@acme.com" };
    people.saw(MAIL, [eng, { name: "Ada", address: "ada@acme.com" }], 99 * 24 * 3600 * 1000, ["ada@acme.com"]);
    people.saw(MAIL, [eng], 99 * 24 * 3600 * 1000, []);
    for (let i = 1; i <= 3; i++) people.saw(MAIL, [old], i, []);
    expect(people.top(MAIL)).toEqual([eng, old]);
    people.flush();
    const again = new MailPeople({ file, defer: () => {} });
    expect(
      again
        .top(MAIL)
        .map((p) => p.address)
        .sort(),
    ).toEqual(["eng@acme.com", "old@acme.com"]);
    again.forget(MAIL);
    expect(again.top(MAIL)).toEqual([]);
  });
});

describe("the reply frame's addressing", () => {
  const parse = (m: Record<string, unknown>) => FRAMES.account_thread_reply.parse({ account_id: MAIL, thread_id: "t1", text: "ok", then: "read", ...m });
  test("read as sent, with the signature on unless it says off", () => {
    expect(parse({ mail: { mode: "forward", to: ["eng@acme.com"] }, outbox_id: "o1-abcdefgh" })).toMatchObject({
      mail: { mode: "forward", to: ["eng@acme.com"], cc: [], bcc: [], from: null, signature: true },
      outbox_id: "o1-abcdefgh",
    });
    expect(parse({})).toMatchObject({ mail: null, outbox_id: null });
  });
  test("a mode, address or id loki does not take is refused", () => {
    expect(parse({ mail: { mode: "bcc_all", to: [] } })).toBe("mail.mode must be reply, reply_all or forward");
    expect(parse({ mail: { mode: "reply", to: ["a@b.c\nBcc: x@y.z"] } })).toBe("mail.to must be a list of addresses");
    expect(parse({ mail: { mode: "reply", to: [], from: "nobody" } })).toBe("mail.from must be an address");
    expect(parse({ mail: { mode: "reply", to: Array.from({ length: 101 }, (_, i) => `p${i}@acme.com`) } })).toBe("that reply goes to too many people");
    expect(parse({ outbox_id: "../x" })).toBe("outbox_id must be a short id");
  });
});

describe("the recipients line", () => {
  const compose = {
    modes: {
      reply: { to: ["Pinku <p@x.example>"], cc: [] },
      reply_all: { to: ["Pinku <p@x.example>"], cc: ["Ops <ops@acme.com>", "a@acme.com", "b@acme.com"] },
    },
    from: [{ address: "ada@acme.com", name: "Ada", signature: "Ada" }],
    default_from: "ada@acme.com",
    subject: "Help",
    people: [
      { name: "Engineering", address: "eng@acme.com" },
      { name: "", address: "engage@vendor.example" },
      { name: "Bea Tester", address: "bea@acme.com" },
    ],
  };
  test("starts as reply all; a mode keeps From, the signature and Bcc, and a forward starts with nobody", () => {
    const start = startAddressing(compose);
    expect(start).toMatchObject({ mode: "reply_all", from: "ada@acme.com", signature: true, bcc: [] });
    const fwd = addressingFor(compose, "forward", { ...start, bcc: ["boss@acme.com"], signature: false });
    expect(fwd).toMatchObject({ mode: "forward", to: [], cc: [], bcc: ["boss@acme.com"], signature: false });
    expect(addressingFor(compose, "reply", null)).toMatchObject({ to: ["Pinku <p@x.example>"], cc: [] });
  });
  test("collapsed, it names who it goes to", () => {
    expect(addressSummary(startAddressing(compose))).toBe("to Pinku, cc 3 others");
    expect(addressSummary({ ...startAddressing(compose), cc: ["Ops <ops@acme.com>"], bcc: ["x@y.z"] })).toBe("to Pinku, cc Ops, bcc 1");
    expect(addressSummary(addressingFor(compose, "forward", null))).toBe("nobody yet: add someone");
    expect(recipientName('"Kumar, Pinku" <p@x.example>')).toBe("Kumar, Pinku");
  });
  test("suggestions: a name's word or an address that starts with what was typed first, then any that has it, never someone already on it", () => {
    expect(suggest(compose.people, "eng", new Set()).map((p) => p.address)).toEqual(["eng@acme.com", "engage@vendor.example"]);
    expect(suggest(compose.people, "test", new Set()).map((p) => p.address)).toEqual(["bea@acme.com"]);
    expect(suggest(compose.people, "eng", new Set(["eng@acme.com"])).map((p) => p.address)).toEqual(["engage@vendor.example"]);
    expect(suggest(compose.people, " ", new Set())).toEqual([]);
  });
  test("a whole address typed by hand is taken; half of one is not yet", () => {
    expect(typedRecipient("eng@acme.com,")).toBe("eng@acme.com");
    expect(typedRecipient("Eng <eng@acme.com>")).toBe("Eng <eng@acme.com>");
    expect(typedRecipient("eng@acme")).toBeNull();
    expect(typedRecipient("eng")).toBeNull();
  });
});

describe("the mail reply box as drawn", () => {
  const compose = {
    modes: { reply: { to: ["Pinku <p@x.example>"], cc: [] }, reply_all: { to: ["Pinku <p@x.example>"], cc: ["Ops <ops@acme.com>"] } },
    from: [{ address: "ada@acme.com", name: "Ada", signature: "Ada\nAcme support" }],
    default_from: "ada@acme.com",
    subject: "Help",
    people: [],
  };
  const facts = must(outsideItem("Help").outside, "an outside card");
  test("the recipients line, the box, the signature under it and the folded quote; send names ⌘Enter", () => {
    const html = renderToStaticMarkup(
      createElement(OutsideReply, { facts, compose, quote: "Please update", onSend: () => Promise.resolve({ sent: true, error: null }) }),
    );
    expect(html).toContain("to Pinku, cc Ops");
    expect(html).toContain('placeholder="reply"');
    expect(html).toContain("-- \nAda\nAcme support");
    expect(html).toContain("•••");
    expect(html).toContain("reply all");
  });
  test("before the line is read it says the reply goes to all, as before", () => {
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts, onSend: () => Promise.resolve({ sent: true, error: null }) }));
    expect(html).toContain("reply to all");
    expect(html).not.toContain("•••");
  });
});
