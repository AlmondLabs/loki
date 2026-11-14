import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { MailAddressing, OutsideChange } from "../core/frame-types.ts";
import { FRAMES } from "../core/frames.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts, type AccountRecord } from "../mod/accounts.ts";
import { GmailClient, rfc2822, type GmailDraftInput, type GmailMessage, type GmailMessagePart, type GmailSendAs } from "../mod/gmail.ts";
import { forwardSubject, fromHeader, mailBody, mailDate } from "../mod/mail-compose.ts";
import { MailOutbox, RESUME_MAX_MS } from "../mod/mail-outbox.ts";
import { headerPeople } from "../core/mail-header.ts";
import { MailPeople } from "../mod/mail-people.ts";
import { OutsideThreads } from "../mod/outside-threads.ts";
import { peopleChange, replyOf } from "../mod/reply-proposals.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutsideReply } from "../app/src/desk/outside-card.tsx";
import { formatKeys } from "../app/src/shell/keymap.ts";
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
function mail(opts: { outbox?: string; key?: string | null; now?: () => Date; after?: (fn: () => void, ms: number) => () => void; sendFails?: string } = {}) {
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
    threads: {
      archive: write("archive"),
      markRead: write("read"),
      markUnread: write("unread"),
      markWaiting: () => true,
      markDealt: () => true,
      clearSeeds: () => false,
      get: () => null,
    },
    threadText: { gmail: () => Promise.resolve([]), slack: () => Promise.resolve([]), jira: () => Promise.resolve([]) },
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
    ...(opts.outbox
      ? {
          outbox: {
            file: opts.outbox,
            now,
            key: Promise.resolve(opts.key === undefined ? "the daemon's key" : opts.key),
            ...(opts.after ? { after: opts.after } : {}),
          },
        }
      : {}),
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
  test("each recipient is written out again from its name and address: a name cannot close its quote and add a second one", () => {
    const headers = (to: string[]) => rfc2822({ threadId: "t1", inReplyTo: "", references: [], to, cc: [], subject: "s", body: "b" }).split("\r\n");
    const toLine = (to: string[]) => headers(to).find((h) => h.startsWith("To: "));
    // A stranger's From, with a quote escaped inside the name to look like two people.
    const crafted = '"a\\" <victim@corp.example>, \\"b" <attacker@evil.example>';
    expect(headerPeople(crafted)).toEqual([{ name: 'a" <victim@corp.example>, "b', address: "attacker@evil.example" }]);
    expect(toLine([crafted])).toBe('To: "a\\" <victim@corp.example>, \\"b" <attacker@evil.example>');
    expect(headerPeople(toLine([crafted])?.slice(4) ?? "")).toHaveLength(1);
    expect(toLine(['"O\\"Brien, Pat" <Pat@x.example>', "plain@x.example", "Grace Hopper <grace@x.example>"])).toBe(
      'To: "O\\"Brien, Pat" <Pat@x.example>, plain@x.example, Grace Hopper <grace@x.example>',
    );
    expect(toLine(["Zoë <zoe@x.example>"])).toBe(`To: =?UTF-8?B?${Buffer.from("Zoë").toString("base64")}?= <zoe@x.example>`);
    expect(toLine(["not an address"])).toBeUndefined();
  });
  test("the message carries From and Bcc, plain text and HTML together, and forwarded files after them", () => {
    const raw = rfc2822({
      threadId: "t1",
      inReplyTo: "<p1@x>",
      references: [],
      from: '"Ada" <ada@acme.com>',
      to: ["p@x.example"],
      cc: [],
      bcc: ["boss@acme.com\r\nX-Evil: 1", "Boss <boss@acme.com>\r\nX-Evil: 1"],
      subject: "Re: Help",
      body: "ok",
      html: "<div>ok</div>",
      attachments: [{ filename: "screen shot.png", mimeType: "image/png", data: Buffer.from("png") }],
    });
    expect(raw).toContain('From: "Ada" <ada@acme.com>\r\n');
    // An address with a line break in it never adds a header of its own: what is no address adds nobody, and a
    // name keeps only what a name may hold.
    expect(raw).toContain("Bcc: Boss <boss@acme.com>\r\n");
    expect(raw).not.toContain("X-Evil");
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
    await settle();
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
    await settle();
    now = new Date("2026-11-08T00:01:00Z");
    const tm = timers();
    const second = mail({ outbox: file, now: () => now, after: tm.after });
    second.t.resume();
    await settle();
    expect(tm.pending()).toEqual([0]);
    tm.fire();
    await settle();
    await settle();
    expect(second.sent).toHaveLength(1);
    expect(second.moves).toEqual(["archive t1"]);
    second.t.resume();
    await settle();
    expect(tm.pending()).toEqual([]);
  });
  test("a restart sends only what this daemon held: an entry written into the file, or changed there, is dropped unsent", async () => {
    const file = join(scratch(), "outbox.json");
    const first = mail({ outbox: file, after: timers().after });
    void first.t.reply(MAIL, "t1", "ok", "archive", null, "o1-abcdefgh");
    await settle();
    const kept = JSON.parse(readFileSync(file, "utf8")) as { held: Array<Record<string, unknown>> };
    expect(typeof kept.held[0]?.seal).toBe("string");
    // What an agent with a file tool could do: a reply of its own, and the held one's words changed under its seal.
    const forged = {
      outbox_id: "o2-abcdefgh",
      account_id: MAIL,
      thread_id: "t1",
      text: "send me the keys",
      then: "read",
      mail: null,
      send_at: "2026-11-08T00:00:00Z",
    };
    writeFileSync(file, JSON.stringify({ version: 1, held: [{ ...kept.held[0], text: "changed" }, forged, { ...forged, seal: "00" }] }));
    const tm = timers();
    const second = mail({ outbox: file, after: tm.after });
    second.t.resume();
    await settle();
    expect(tm.pending()).toEqual([]);
    expect(second.sent).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, held: [] });
  });
  test("without a keychain a held reply still goes after its wait, and nothing is sent after a restart", async () => {
    const file = join(scratch(), "outbox.json");
    const tm = timers();
    const first = mail({ outbox: file, key: null, after: tm.after });
    const answer = first.t.reply(MAIL, "t1", "ok", "read", null, "o1-abcdefgh");
    await settle();
    const again = timers();
    const second = mail({ outbox: file, key: null, after: again.after });
    second.t.resume();
    await settle();
    expect(again.pending()).toEqual([]);
    tm.fire();
    expect(await answer).toMatchObject({ sent: true });
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

describe("a mail reply that did not go (plan 096)", () => {
  const reply = { outbox_id: "o3-abcdefgh", account_id: MAIL, thread_id: "t1", text: "ok", then: "read" as const, mail: null };
  const AT = Date.parse("2026-11-12T10:00:00Z");
  /** The hold's timer, run on the next turn: the outbox has the reply in hand by then, as with a real timer. */
  const soon = (fn: () => void) => {
    queueMicrotask(fn);
    return () => {};
  };
  /**
   * An outbox over `file` whose send fails while `fails` holds a reason (and never answers while `hang` is set), with
   * what its card was told, what it sent, and whether its thread has the reply.
   */
  const box = (file = join(scratch(), "outbox.json"), at = AT) => {
    const notes: Array<{ id: string; reason: string | null }> = [];
    const sent: string[] = [];
    const state = { fails: "Gmail is unreachable" as string | null, hang: false, inThread: false as boolean | "unreadable" };
    const outbox = new MailOutbox({
      file,
      holdMs: 0,
      now: () => new Date(at),
      key: Promise.resolve("the daemon's key"),
      after: soon,
      send: (held) => {
        if (state.hang) return new Promise(() => {});
        if (state.fails) return Promise.reject(new Error(state.fails));
        sent.push(held.outbox_id);
        return Promise.resolve({ sent: true, then_error: null, change: null });
      },
      wentOut: () => (state.inThread === "unreadable" ? Promise.reject(new Error("offline")) : Promise.resolve(state.inThread)),
      onNotSent: (held, note) => notes.push({ id: held.outbox_id, reason: note?.reason ?? null }),
    });
    const kept = () => (JSON.parse(readFileSync(file, "utf8")) as { held: Array<{ outbox_id: string; state?: string; reason?: string }> }).held;
    return { outbox, notes, sent, state, kept, file };
  };
  /** A reply that failed: in the file as failed, its card told. */
  const failed = async () => {
    const b = box();
    await expect(b.outbox.hold(reply)).rejects.toThrow("Gmail is unreachable");
    b.state.fails = null;
    return b;
  };

  test("a send that fails is kept with its reason, and its card is told; nothing tries it again by itself", async () => {
    const b = await failed();
    await settle();
    expect(b.kept()).toMatchObject([{ outbox_id: "o3-abcdefgh", state: "failed", reason: "Gmail is unreachable" }]);
    expect(b.notes).toEqual([{ id: "o3-abcdefgh", reason: "Gmail is unreachable" }]);
    expect(b.sent).toEqual([]);
  });

  test("send again goes when the thread does not have it, and settles the card", async () => {
    const b = await failed();
    expect(await b.outbox.resend(MAIL, "o3-abcdefgh")).toMatchObject({ sent: true });
    expect(b.sent).toEqual(["o3-abcdefgh"]);
    expect(b.kept()).toEqual([]);
    expect(b.notes.at(-1)).toEqual({ id: "o3-abcdefgh", reason: null });
  });

  test("send again never sends twice: a reply already in its thread is settled without a second send", async () => {
    const b = await failed();
    b.state.inThread = true; // Gmail took it, and only its answer was lost
    expect(await b.outbox.resend(MAIL, "o3-abcdefgh")).toMatchObject({ sent: true });
    expect(b.sent).toEqual([]);
    expect(b.kept()).toEqual([]);
  });

  test("a thread that cannot be read is no reason to send: the reply stays not sent", async () => {
    const b = await failed();
    b.state.inThread = "unreadable";
    await expect(b.outbox.resend(MAIL, "o3-abcdefgh")).rejects.toThrow(/could not be read/);
    expect(b.sent).toEqual([]);
    expect(b.kept()).toMatchObject([{ state: "failed" }]);
  });

  test("discard forgets it and settles the card; another account cannot discard it", async () => {
    const b = await failed();
    expect(b.outbox.discard("gmail:someone@else.example", "o3-abcdefgh")).toBe(false);
    expect(b.outbox.discard(MAIL, "o3-abcdefgh")).toBe(true);
    expect(b.kept()).toEqual([]);
    expect(b.notes.at(-1)).toEqual({ id: "o3-abcdefgh", reason: null });
    await expect(b.outbox.resend(MAIL, "o3-abcdefgh")).rejects.toThrow(/not waiting/);
  });

  test("after a restart: a send cut short is looked for in its thread, and a failed one is shown again", async () => {
    const file = join(scratch(), "outbox.json");
    const before = box(file);
    before.state.hang = true; // the daemon stops while Gmail has not answered
    void before.outbox.hold({ ...reply, outbox_id: "cut-short-1" });
    await settle();
    before.state.hang = false;
    await expect(before.outbox.hold({ ...reply, outbox_id: "failed-001" })).rejects.toThrow();
    expect(before.kept().map((h) => [h.outbox_id, h.state])).toEqual([
      ["cut-short-1", "sending"],
      ["failed-001", "failed"],
    ]);
    const after = box(file, AT + 60_000);
    after.state.inThread = true; // the cut-short one reached Gmail
    after.outbox.resume();
    await settle();
    await settle();
    expect(after.sent).toEqual([]);
    expect(after.kept().map((h) => h.outbox_id)).toEqual(["failed-001"]);
    expect(after.notes).toEqual(
      expect.arrayContaining([
        { id: "failed-001", reason: "Gmail is unreachable" },
        { id: "cut-short-1", reason: null },
      ]),
    );
  });

  test("a cut-short send not in its thread is kept as not sent, never sent again by itself", async () => {
    const file = join(scratch(), "outbox.json");
    const before = box(file);
    before.state.hang = true;
    void before.outbox.hold(reply);
    await settle();
    const after = box(file, AT + 60_000);
    after.state.fails = null;
    after.outbox.resume();
    await settle();
    await settle();
    expect(after.sent).toEqual([]);
    expect(after.kept()).toMatchObject([{ state: "failed" }]);
    expect(after.notes[0]?.reason).toMatch(/not in the thread/);
  });

  test("a reply still held when loki closed goes on its own only within ten minutes of when it was due", async () => {
    const file = join(scratch(), "outbox.json");
    const closed = new MailOutbox({
      file,
      holdMs: 10_000,
      now: () => new Date(AT),
      key: Promise.resolve("the daemon's key"),
      after: () => () => {},
      send: () => Promise.reject(new Error("never")),
    });
    void closed.hold(reply);
    await settle();
    const late = box(file, AT + 10_000 + RESUME_MAX_MS + 1000);
    late.state.fails = null;
    late.outbox.resume();
    await settle();
    expect(late.sent).toEqual([]);
    expect(late.kept()).toMatchObject([{ outbox_id: "o3-abcdefgh", state: "failed" }]);
    expect(late.notes[0]?.reason).toMatch(/loki was closed when it was due/);
  });

  test("a held reply with no move after it (stay) survives a restart and goes when due", async () => {
    const file = join(scratch(), "outbox.json");
    const closed = new MailOutbox({
      file,
      holdMs: 10_000,
      now: () => new Date(AT),
      key: Promise.resolve("the daemon's key"),
      after: () => () => {},
      send: () => Promise.reject(new Error("never")),
    });
    void closed.hold({ ...reply, then: "stay" });
    await settle();
    const after = box(file, AT + 20_000);
    after.state.fails = null;
    after.outbox.resume();
    await settle();
    await settle();
    expect(after.sent).toEqual(["o3-abcdefgh"]);
  });

  test("every held reply carries its id in a header, which is how its thread is searched for it", () => {
    const base = { threadId: "t1", inReplyTo: "", references: [], to: ["p@x.example"], cc: [], subject: "s", body: "b" };
    expect(rfc2822({ ...base, outboxId: "o3-abcdefgh" })).toContain("\r\nX-Loki-Outbox: o3-abcdefgh\r\n");
    expect(rfc2822(base)).not.toContain("X-Loki-Outbox");
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
  test("a Slack reply may name the thread it goes into, as a Slack message time (plan 085)", () => {
    expect(parse({ thread_ts: "1731234567.000100" })).toMatchObject({ thread_ts: "1731234567.000100" });
    expect(parse({})).toMatchObject({ thread_ts: null });
    expect(parse({ thread_ts: "C1:1.0" })).toBe("thread_ts must be a Slack message time");
  });
  test("a reply may be sent with no move after it, and a move loki does not know is refused (plan 083)", () => {
    expect(parse({ then: "stay" })).toMatchObject({ then: "stay" });
    expect(parse({ then: "snooze" })).toBe("then must be read, later, archive or stay");
  });
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
  const onSend = () => Promise.resolve({ sent: true, error: null });
  // The desktop's card draws its box with the item components (items); the phone keeps its own.
  test("the recipients line, the box, the signature under it and the folded quote; send names ⌘Enter", () => {
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts, compose, quote: "Please update", onSend, items: true }));
    expect(html).toContain("To Pinku, cc Ops");
    expect(html).toContain('placeholder="Reply"');
    expect(html).toContain("-- \nAda\nAcme support");
    expect(html).toContain("•••");
    expect(html).toContain("Reply All");
    expect(html).toMatch(new RegExp(`aria-label="Send" title="[^"]*\\(${formatKeys("cmd+enter")}\\)"`));
  });
  test("a reply that did not go: its words, why, and Send Again and Discard, the line in sentence case", () => {
    const note = { outbox_id: "o3-abcdefgh", text: "Thanks, I will look tomorrow\nAda", reason: "Gmail is unreachable", at: "2026-11-12T10:00:00Z" };
    const draw = (touch: boolean, onUnsent?: () => Promise<null>) =>
      renderToStaticMarkup(createElement(OutsideReply, { facts: { ...facts, not_sent: note }, touch, onUnsent, onSend, items: !touch }));
    const desk = draw(false, () => Promise.resolve(null));
    expect(desk).toContain('role="alert"');
    expect(desk).toContain("Not sent: Gmail is unreachable");
    expect(desk).toContain("“Thanks, I will look tomorrow”");
    expect(desk).toContain(">Send Again<");
    expect(desk).toMatch(/title="Let it go; the card stops saying it was not sent"[^>]*>Discard</);
    const phone = draw(true, () => Promise.resolve(null));
    expect(phone).toContain("Not sent: Gmail is unreachable");
    expect(phone).toContain(">Send Again<");
    // With nothing to settle it by, it still says so, and offers nothing.
    expect(draw(false)).toContain("Not sent: Gmail is unreachable");
    expect(draw(false)).not.toContain("Send Again");
    expect(draw(false)).not.toContain("Let it go");
    expect(renderToStaticMarkup(createElement(OutsideReply, { facts, onSend, items: true }))).not.toContain("Not sent");
  });
  test("before the line is read it says the reply goes to all, as before", () => {
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts, onSend, items: true }));
    expect(html).toContain("Reply to all");
    expect(html).not.toContain("•••");
  });
});

describe("the outbox holds any service's reply (plan 2026-11-14-1134, U1)", () => {
  const AT = Date.parse("2026-11-14T10:00:00Z");
  const KEY = "the daemon's key";
  const proposal = { agent_id: "agent-work", conversation_id: "conv-1", proposal_id: "reply-1" };
  const slackReply = {
    outbox_id: "slack-0001",
    account_id: "slack:T1:U1",
    thread_id: "C9:1700.1",
    text: "Deploying at 9.",
    then: "stay" as const,
    mail: null,
    thread_ts: "1700.1",
    files: [{ name: "plan.pdf", path: "/work/plan.pdf", size: 12, md5: "abc" }],
    proposal,
  };
  const soon = (fn: () => void) => {
    queueMicrotask(fn);
    return () => {};
  };
  /** An outbox over `file` at `at`, with what it sent and what each proposal was told. */
  const box = (file: string, at = AT, went: boolean | null = false) => {
    const sent: string[] = [];
    const told: Array<{ id: string; outcome: string }> = [];
    const state = { fails: null as string | null, hang: false };
    const outbox = new MailOutbox({
      file,
      holdMs: 0,
      now: () => new Date(at),
      key: Promise.resolve(KEY),
      after: soon,
      send: (held) => {
        if (state.hang) return new Promise(() => {});
        if (state.fails) return Promise.reject(new Error(state.fails));
        sent.push(held.outbox_id);
        return Promise.resolve({ sent: true, then_error: null, change: null });
      },
      wentOut: () => Promise.resolve(went),
      onNotSent: (held, note) => told.push({ id: held.outbox_id, outcome: note ? `failed: ${note.reason}` : "settled" }),
      onSent: (held) => told.push({ id: held.outbox_id, outcome: "sent" }),
    });
    const kept = () => (JSON.parse(readFileSync(file, "utf8")) as { held: Array<Record<string, unknown>> }).held;
    return { outbox, sent, told, state, kept };
  };

  test("an agent's Slack reply goes after its hold, stays in the file as sent until its proposal takes it, and is reported again after a restart", async () => {
    const file = join(scratch(), "outbox.json");
    const before = box(file);
    await expect(before.outbox.hold(slackReply)).resolves.toMatchObject({ sent: true });
    expect(before.sent).toEqual(["slack-0001"]);
    expect(before.told).toEqual([{ id: "slack-0001", outcome: "sent" }]);
    expect(before.kept()).toMatchObject([{ outbox_id: "slack-0001", state: "sent" }]);
    // loki stops before the proposal saved it: the next start reports it again, and sends nothing.
    const after = box(file, AT + 60_000);
    after.outbox.resume();
    await settle();
    expect(after.sent).toEqual([]);
    expect(after.told).toEqual([{ id: "slack-0001", outcome: "sent" }]);
    after.outbox.acknowledge("slack-0001");
    expect(after.kept()).toEqual([]);
  });

  test("a failed agent reply is reported until its proposal takes it, then never again", async () => {
    const file = join(scratch(), "outbox.json");
    const b = box(file);
    b.state.fails = "Slack is unreachable";
    await expect(b.outbox.hold(slackReply)).rejects.toThrow("Slack is unreachable");
    await settle();
    expect(b.told).toEqual([{ id: "slack-0001", outcome: "failed: Slack is unreachable" }]);
    b.outbox.acknowledge("slack-0001");
    const after = box(file, AT + 60_000);
    after.outbox.resume();
    await settle();
    expect(after.told).toEqual([]);
    expect(after.sent).toEqual([]);
  });

  test("a Slack reply cut short while sending is never sent again: it may have gone, so the person looks first", async () => {
    const file = join(scratch(), "outbox.json");
    const before = box(file);
    before.state.hang = true;
    void before.outbox.hold(slackReply);
    await settle();
    const after = box(file, AT + 60_000, null);
    after.outbox.resume();
    await settle();
    await settle();
    expect(after.sent).toEqual([]);
    expect(after.told[0]?.outcome).toMatch(/look in the thread before sending it again/);
  });

  test("an entry whose thread, files or proposal was changed in the file is dropped unsent", async () => {
    for (const change of [{ thread_ts: "1800.2" }, { files: [] }, { proposal: { ...proposal, proposal_id: "reply-9" } }]) {
      const file = join(scratch(), "outbox.json");
      const closed = new MailOutbox({
        file,
        holdMs: 10_000,
        now: () => new Date(AT),
        key: Promise.resolve(KEY),
        after: () => () => {},
        send: () => Promise.reject(new Error("never")),
      });
      void closed.hold(slackReply);
      await settle();
      const held = (JSON.parse(readFileSync(file, "utf8")) as { held: Array<Record<string, unknown>> }).held;
      writeFileSync(file, JSON.stringify({ version: 1, held: held.map((h) => ({ ...h, ...change })) }));
      const after = box(file, AT + 20_000);
      after.outbox.resume();
      await settle();
      await settle();
      expect(after.sent).toEqual([]);
      expect(after.kept()).toEqual([]);
    }
  });

  test("a person's own reply, with no proposal, is still removed once sent", async () => {
    const file = join(scratch(), "outbox.json");
    const b = box(file);
    await b.outbox.hold({ ...slackReply, outbox_id: "own-00001", proposal: null });
    expect(b.kept()).toEqual([]);
    expect(b.told).toEqual([]);
  });
});

describe("Gmail sends files through its upload route (plan 2026-11-14-1134, U2)", () => {
  const SIGNED_IN = JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_at: "2099-01-01T00:00:00.000Z" });
  /** A connected Gmail account whose client answers every send from a fake Gmail that keeps each request. */
  const gmail = async () => {
    const now = () => new Date("2026-11-14T10:00:00Z");
    const accounts = new Accounts({ file: join(scratch(), "accounts.json"), secrets: memorySecrets(), agentExists: () => true, now });
    await accounts.add({ account_id: MAIL, provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-work" }, SIGNED_IN);
    const requests: Array<{ url: string; type: string; body: string }> = [];
    const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const body = init?.body;
      requests.push({
        url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        type: headers.get("content-type") ?? "",
        body: typeof body === "string" ? body : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "",
      });
      return Promise.resolve(new Response(JSON.stringify({ id: "sent-1", threadId: "t1" }), { status: 200 }));
    };
    return { client: new GmailClient({ accounts, account_id: MAIL, fetch: fetchFn, now }), requests };
  };
  const reply: GmailDraftInput = {
    threadId: "t1",
    inReplyTo: "<p1@shop.example>",
    references: [],
    to: ["Pinku Kumar <pinku@shop.example>"],
    cc: [],
    subject: "Re: App will not open",
    body: "The report is attached.",
  };

  test("a reply with a 3 MB file goes to the upload route as multipart, the file an attachment part, and stays in its thread", async () => {
    const { client, requests } = await gmail();
    const file = Buffer.alloc(3 * 1024 * 1024, 7);
    await expect(client.sendReply({ ...reply, attachments: [{ filename: "report.pdf", mimeType: "application/pdf", data: file }] })).resolves.toEqual({
      id: "sent-1",
      threadId: "t1",
    });
    expect(requests).toHaveLength(1);
    const sent = must(requests[0], "the upload");
    expect(sent.url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart");
    const boundary = /^multipart\/related; boundary="?([^";]+)"?$/.exec(sent.type)?.[1];
    expect(boundary).toBeTruthy();
    const parts = sent.body.split(`--${boundary ?? ""}`);
    // The metadata first, then the message itself, then the closing boundary.
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain("Content-Type: application/json");
    expect(JSON.parse((parts[1] ?? "").split("\r\n\r\n")[1] ?? "")).toEqual({ threadId: "t1" });
    expect(parts[2]).toContain("Content-Type: message/rfc822");
    expect(parts[2]).toContain("Content-Disposition: attachment; filename*=UTF-8''report.pdf");
    expect((parts[2] ?? "").replace(/\r\n/g, "")).toContain(file.toString("base64"));
    expect(parts[3]).toBe("--\r\n");
  });

  test("a reply without files goes as JSON to the send route, as before", async () => {
    const { client, requests } = await gmail();
    await client.sendReply(reply);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(requests[0]?.type).toBe("application/json");
    const json = JSON.parse(requests[0]?.body ?? "") as { raw: string; threadId: string };
    expect(json.threadId).toBe("t1");
    expect(json.raw).toBe(Buffer.from(rfc2822(reply), "utf8").toString("base64url"));
  });

  /** The newest message of a thread, from Grace to Ada and Alan, cc Bob and whoever else `cc` adds. */
  const newest = (headers: Record<string, string>): GmailMessage => ({
    ...PINKU,
    payload: { mimeType: "text/plain", filename: "", body: { size: 0 }, parts: [], headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });
  const proposed = { to: ["Grace Hopper <grace@acme.com>", "Alan Turing <alan@acme.com>"], cc: ["Bob <bob@acme.com>"] };
  const own = ["ada@acme.com"];

  test("covers AE1: a thread that gained Carol since the proposal names her as added", () => {
    const now = newest({
      From: "Carol <carol@acme.com>",
      To: "Ada <ada@acme.com>, Grace Hopper <grace@acme.com>, Alan Turing <alan@acme.com>",
      Cc: "Bob <bob@acme.com>",
    });
    expect(peopleChange(now, own, proposed)).toEqual({ added: ["carol@acme.com"], removed: [] });
    const fewer = newest({ From: "Grace Hopper <grace@acme.com>", To: "Ada <ada@acme.com>" });
    expect(peopleChange(fewer, own, proposed)).toEqual({ added: [], removed: ["alan@acme.com", "bob@acme.com"] });
  });

  test("the same people in another order, or under another name, are no change", () => {
    const reordered = newest({ From: "Grace H. <GRACE@acme.com>", To: "Alan Turing <alan@acme.com>, Ada <ada@acme.com>", Cc: "bob@acme.com" });
    expect(peopleChange(reordered, own, proposed)).toEqual({ added: [], removed: [] });
  });
});
