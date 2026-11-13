import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads, type ThreadRecord } from "../mod/account-threads.ts";
import { AccountWatcher } from "../mod/account-watcher.ts";
import { Accounts } from "../mod/accounts.ts";
import { GmailClient } from "../mod/gmail.ts";
import { GmailSync, gmailOutsideSource } from "../mod/gmail-sync.ts";
import { fakeMailbox } from "./fixtures/gmail-mailbox.ts";
import { must } from "./fixtures/must.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-04T09:00:00Z");
/** A sign-in that stays good on the test's clock, so these tests reach only the mailbox. */
const SECRET = JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_at: "2099-01-01T00:00:00.000Z" });
const GRACE = "Grace Hopper <grace@acme.com>";

/** Gmail accounts, each over its own fake mailbox, on one clock; `sync(i)` builds a watcher's sync for account i. */
async function setup(addresses = ["ada@acme.com"]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-gmail-sync-"));
  dirs.push(dir);
  let now = START;
  const clock = () => new Date(now);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), now: clock });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  const boxes = addresses.map((email) => fakeMailbox({ email, sendAs: [email.replace("@acme.com", "@example.org")] }));
  const clients = new Map<string, GmailClient>();
  for (const [i, email] of addresses.entries()) {
    const id = `gmail:${email}`;
    await accounts.add({ account_id: id, provider: "gmail", address: email, owner_agent_id: "agent-work" }, SECRET);
    clients.set(id, new GmailClient({ accounts, account_id: id, fetch: boxes[i].fetch, now: clock }));
  }
  const clientOf = (id: string) => must(clients.get(id), "the account's client");
  threads.register("gmail", gmailOutsideSource(clientOf));
  const sync = (i = 0, resting?: (r: ThreadRecord) => boolean) => {
    const account = must(accounts.get(`gmail:${addresses[i]}`), "the account");
    return new GmailSync({ accounts, threads, account, client: clientOf(account.account_id), now: clock, resting });
  };
  const id = (i = 0) => `gmail:${addresses[i]}`;
  const cards = (i = 0) =>
    threads
      .rows()
      .filter((r) => r.outside?.account_id === id(i))
      .map((r) => must(r.outside, "outside").thread_id)
      .sort();
  return {
    accounts,
    threads,
    box: boxes[0],
    boxes,
    sync,
    id,
    cards,
    ago: (ms: number) => new Date(now - ms),
    advance: (ms: number) => (now += ms),
  };
}

describe("the first sync of a Gmail account (R5, R8, AE1)", () => {
  test("every unread mail is a card, a list, an automated mail and a no-reply sender too, each with what kind it is (plan 069)", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    box.deliver({
      thread: "t-cc",
      at: ago(HOUR),
      from: GRACE,
      to: "team@acme.com",
      cc: "ada@acme.com",
      subject: "Budget",
      snippet: "can you check the numbers?",
      labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    });
    box.deliver({
      thread: "t-news",
      at: ago(HOUR),
      from: "News <news@acme.com>",
      to: "ada@acme.com",
      headers: { "List-Unsubscribe": "<mailto:u@acme.com>" },
      labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    });
    box.deliver({ thread: "t-auto", at: ago(HOUR), from: "CI <ci@acme.com>", to: "ada@acme.com", headers: { "Auto-Submitted": "auto-generated" } });
    box.deliver({ thread: "t-noreply", at: ago(HOUR), from: "GitHub <noreply@github.com>", to: "team@acme.com" });
    await sync().tick();
    expect(cards().sort()).toEqual(["t-auto", "t-cc", "t-news", "t-noreply"]);
    expect(["t-cc", "t-news", "t-auto", "t-noreply"].map((t) => threads.get(id(), t)?.traits)).toEqual([
      { to_you: true, list: false, automated: false, category: "primary" },
      { to_you: true, list: true, automated: false, category: "promotions" },
      { to_you: true, list: false, automated: true, category: null },
      { to_you: false, list: false, automated: true, category: null },
    ]);
    expect(threads.get(id(), "t-cc")).toMatchObject({
      sender: "Grace Hopper",
      sender_address: "grace@acme.com",
      subject_or_first_line: "Budget",
      lines: ["can you check the numbers?"],
    });
  });

  test("a mail sent to one of the person's send-as aliases counts as to them", async () => {
    const { box, sync, cards, ago } = await setup();
    box.deliver({ thread: "t-alias", at: ago(HOUR), from: GRACE, to: "Ada <ada@example.org>" });
    await sync().tick();
    expect(cards()).toEqual(["t-alias"]);
  });

  test("a thread whose mail is all read but still in the inbox is a card, shown as read out there", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    box.deliver({ thread: "t-read", at: ago(HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    box.deliver({ thread: "t-unread", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-out", at: ago(HOUR), from: GRACE, to: "ada@acme.com", labels: ["UNREAD"] });
    await sync().tick();
    expect(cards()).toEqual(["t-read", "t-unread"]);
    expect(["t-read", "t-unread"].map((t) => threads.get(id(), t)?.unread_out_there)).toEqual([false, true]);
  });

  test("the person's own mail in a thread never becomes the card's newest message", async () => {
    const { box, sync, ago, threads, id } = await setup();
    const theirs = box.deliver({ thread: "t1", at: ago(2 * HOUR), from: GRACE, to: "ada@acme.com", snippet: "can you?" });
    // A reply the person sent with a copy to themselves lands in the inbox too, read.
    box.deliver({ thread: "t1", at: ago(HOUR), from: "Ada <ada@example.org>", to: "grace@acme.com", cc: "ada@acme.com", labels: ["INBOX", "SENT"] });
    await sync().tick();
    expect(threads.get(id(), "t1")).toMatchObject({ newest_message_id: theirs, sender: "Grace Hopper", unread_out_there: true });
  });

  test("with 300 inbox threads the first tick takes the newest 20; closing cards makes room for the next (plans 078, 088)", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    // One direct thread every 6 hours, newest first.
    const t = (i: number) => `t${String(i).padStart(3, "0")}`;
    for (let i = 0; i < 300; i++) box.deliver({ thread: t(i), at: ago(i * 6 * HOUR + HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    expect(cards()).toEqual(Array.from({ length: 20 }, (_, i) => t(i)));
    // At the cap, nothing more of the inbox comes, but new mail still does.
    await s.tick();
    expect(cards()).toHaveLength(20);
    box.deliver({ thread: "t-new", at: ago(60_000), from: GRACE, to: "ada@acme.com" });
    await s.tick();
    expect(cards()).toContain("t-new");
    await threads.archive(id(), "t-new");
    // Closing five makes room for the next five; closing all brings the next twenty.
    for (const c of cards().slice(0, 5)) await threads.archive(id(), c);
    await s.tick();
    expect(cards()).toEqual(Array.from({ length: 20 }, (_, i) => t(i + 5)));
    for (const c of cards()) await threads.archive(id(), c);
    await s.tick();
    expect(cards()).toEqual(Array.from({ length: 20 }, (_, i) => t(i + 25)));
  });

  test("a card resting in the Inbox leaves the cap, so the inbox fills its room; when it stops resting it counts again", async () => {
    const { box, sync, cards, ago } = await setup();
    const t = (i: number) => `t${String(i).padStart(3, "0")}`;
    for (let i = 0; i < 60; i++) box.deliver({ thread: t(i), at: ago(i * 6 * HOUR + HOUR), from: GRACE, to: "ada@acme.com" });
    const resting = new Set<string>();
    const s = sync(0, (r) => resting.has(r.thread_id));
    await s.tick();
    expect(cards()).toHaveLength(20);
    // Five are read and resting: five older threads take their room, and the resting five stay as cards.
    for (let i = 0; i < 5; i++) resting.add(t(i));
    await s.tick();
    expect(cards()).toEqual(Array.from({ length: 25 }, (_, i) => t(i)));
    // Their rests end: they count again, and the account is over the cap, so nothing more of the inbox comes.
    resting.clear();
    await s.tick();
    expect(cards()).toHaveLength(25);
  });

  test("the listing takes inbox threads read or unread alike, newest first, and read cards count toward the cap (plans 078, 088)", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    const read = Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(2, "0")}`);
    const unread = Array.from({ length: 5 }, (_, i) => `u${String(i)}`);
    // All of them days old, the unread ones oldest.
    read.forEach((t, i) => box.deliver({ thread: t, at: ago(3 * DAY + (i + 1) * HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] }));
    unread.forEach((t, i) => box.deliver({ thread: t, at: ago(6 * DAY + i * HOUR), from: GRACE, to: "ada@acme.com" }));
    const s = sync();
    await s.tick();
    expect(cards()).toEqual(read.slice(0, 20));
    await s.tick();
    expect(cards()).toEqual(read.slice(0, 20));
    for (const c of read.slice(0, 15)) await threads.archive(id(), c);
    await s.tick();
    expect(cards()).toEqual([...read.slice(15), ...unread].sort());
    expect(threads.get(id(), "u4")?.state).toBe("open");
  });
});

describe("watching a Gmail account (R7, R12, R13)", () => {
  test("a thread whose first mail was automated is a card at once, and a person writing in it updates the card and its kind", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    const s = sync();
    await s.tick();
    box.deliver({ thread: "t1", at: ago(10 * 60_000), from: "Jira <jira@acme.com>", to: "ada@acme.com", headers: { "Auto-Submitted": "auto-generated" } });
    await s.tick();
    expect(cards()).toEqual(["t1"]);
    expect(threads.get(id(), "t1")?.traits?.automated).toBe(true);
    const human = box.deliver({ thread: "t1", at: ago(60_000), from: GRACE, to: "ada@acme.com", snippet: "I looked at it" });
    await s.tick();
    expect(cards()).toEqual(["t1"]);
    expect(threads.get(id(), "t1")).toMatchObject({ newest_message_id: human, traits: { automated: false } });
  });

  test("a new mail in an open thread updates its card rather than adding one", async () => {
    const { box, sync, ago, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com", snippet: "first" });
    const s = sync();
    await s.tick();
    box.deliver({ thread: "t1", at: ago(60_000), from: "Bob <bob@acme.com>", to: "ada@acme.com", snippet: "second" });
    await s.tick();
    expect(threads.rows()).toHaveLength(1);
    expect(threads.get(id(), "t1")).toMatchObject({ sender: "Bob", lines: ["first", "second"] });
  });

  test("covers AE7: reading the thread in Gmail keeps its card, shown as read; archiving it there ends the card at the next tick", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t2", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    box.removeLabels("t1", ["UNREAD"]);
    box.removeLabels("t2", ["INBOX"]);
    await s.tick();
    expect(cards()).toEqual(["t1"]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", unread_out_there: false });
    box.removeLabels("t1", ["INBOX"]);
    await s.tick();
    expect(cards()).toEqual([]);
  });

  test("a starred thread's card is starred, and unstarring it in Gmail clears that at the next tick (plan 097, U9)", async () => {
    const { box, sync, ago, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    expect(threads.get(id(), "t1")?.starred).toBe(false);
    box.addLabels("t1", ["STARRED"]);
    await s.tick();
    expect(threads.get(id(), "t1")?.starred).toBe(true);
    box.removeLabels("t1", ["STARRED"]);
    await s.tick();
    expect(threads.get(id(), "t1")?.starred).toBe(false);
  });

  test("archive from loki takes INBOX and UNREAD off the thread, and a later poll does not bring the card back", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    await threads.archive(id(), "t1");
    expect(box.labelsOf("t1")).toEqual([]);
    expect(threads.get(id(), "t1")?.state).toBe("archived");
    await s.tick();
    await s.tick();
    expect(cards()).toEqual([]);
  });

  test("archive takes only the card's messages out of the inbox: one that came after the last poll stays unread and makes the card again", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    const first = box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    const later = box.deliver({ thread: "t1", at: ago(60_000), from: GRACE, to: "ada@acme.com", snippet: "one more thing" });
    await threads.archive(id(), "t1");
    expect(box.labelsOfMessage(first)).toEqual([]);
    expect(box.labelsOfMessage(later)).toEqual(["INBOX", "UNREAD"]);
    await s.tick();
    expect(cards()).toEqual(["t1"]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", newest_message_id: later });
  });

  test("history Gmail no longer keeps rebuilds the account without bringing back archived threads", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    box.deliver({ thread: "t-archived", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-read", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    // Archived from loki, but say Gmail kept it unread in the inbox (another device put it back): still not a card.
    await threads.archive(id(), "t-archived");
    box.deliver({ thread: "t-archived", at: ago(2 * HOUR), from: GRACE, to: "ada@acme.com", snippet: "older" });
    box.removeLabels("t-read", ["UNREAD"]);
    box.deliver({ thread: "t-new", at: ago(60_000), from: GRACE, to: "ada@acme.com" });
    box.expireHistory();
    await s.tick();
    // The thread read in Gmail is still in the inbox, so its card stays.
    expect(cards()).toEqual(["t-new", "t-read"]);
    // The account watches on from the history it rebuilt from.
    box.deliver({ thread: "t-after", at: ago(0), from: GRACE, to: "ada@acme.com" });
    await s.tick();
    expect(cards()).toEqual(["t-after", "t-new", "t-read"]);
  });

  test("after the upgrade to plan 088, inbox mail an earlier rule passed over becomes a card; archived threads stay archived", async () => {
    const { box, sync, cards, ago, threads, accounts, id } = await setup();
    box.deliver({ thread: "t-gone", at: ago(3 * HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-held", at: ago(3 * HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    // What an account connected under an earlier rule holds: a thread archived in Gmail too, one whose archive is still
    // on its way to Gmail, and a job alert the rule kept out, with a cursor of before whose past was all read.
    box.removeLabels("t-gone", ["INBOX"]);
    threads.markGoneOutThere(id(), "t-gone");
    threads.markGoneOutThere(id(), "t-held");
    box.deliver({ thread: "t-skipped", at: ago(2 * HOUR), from: "LinkedIn <jobs@linkedin.com>", to: "ada@acme.com", labels: ["INBOX", "CATEGORY_UPDATES"] });
    const refill = { anchor: ago(DAY).toISOString(), before: ago(90 * DAY).toISOString(), days: 90, exhausted: true };
    accounts.setBackfill(id(), { history_id: box.historyId(), refill, version: 2 });
    await s.tick();
    expect(cards()).toEqual(["t-skipped"]);
    expect(threads.get(id(), "t-skipped")).toMatchObject({ state: "open", from_backfill: true, unread_out_there: false });
    expect(["t-gone", "t-held"].map((t) => threads.get(id(), t)?.state)).toEqual(["archived", "archived"]);
    expect(must(accounts.get(id()), "the account").backfill).toMatchObject({ more: false, version: 3 });
  });

  test("in an inbox at zero, a tick lists the inbox only while it may hold threads loki has not drawn (plan 088)", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    expect(box.inboxListings()).toBe(1);
    // New mail comes through the history alone.
    box.deliver({ thread: "t2", at: ago(60_000), from: GRACE, to: "ada@acme.com" });
    await s.tick();
    await s.tick();
    expect(cards()).toEqual(["t1", "t2"]);
    expect(box.inboxListings()).toBe(1);
    // Lost history lists the inbox again, and a thread loki closed that got mail meanwhile comes back.
    await threads.archive(id(), "t1");
    box.deliver({ thread: "t1", at: ago(0), from: GRACE, to: "ada@acme.com", snippet: "while you were away" });
    box.expireHistory();
    await s.tick();
    expect(box.inboxListings()).toBeGreaterThan(1);
    expect(cards()).toEqual(["t1", "t2"]);
  });
});

describe("writing moves back to Gmail and putting them back (plan 070, U3)", () => {
  test("mark read takes UNREAD off the messages up to the card's newest only; one that came after stays unread", async () => {
    const { box, sync, ago, threads, id } = await setup();
    const first = box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    await sync().tick();
    const later = box.deliver({ thread: "t1", at: ago(60_000), from: GRACE, to: "ada@acme.com", snippet: "one more thing" });
    const change = await threads.markRead(id(), "t1");
    expect(change).toEqual({ move: "read", messages: [{ message_id: first, labels_added: [], labels_removed: ["UNREAD"] }], ended: false, was_unread: true });
    expect(box.labelsOfMessage(first)).toEqual(["INBOX"]);
    expect(box.labelsOfMessage(later)).toEqual(["INBOX", "UNREAD"]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", unread_out_there: false });
  });

  test("mark unread on a read thread sets UNREAD on its newest incoming message alone", async () => {
    const { box, sync, ago, threads, id } = await setup();
    const older = box.deliver({ thread: "t1", at: ago(3 * HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    const newest = box.deliver({ thread: "t1", at: ago(2 * HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    const mine = box.deliver({ thread: "t1", at: ago(HOUR), from: "Ada <ada@acme.com>", to: "grace@acme.com", labels: ["INBOX"] });
    const s = sync();
    await s.tick();
    expect(threads.get(id(), "t1")?.unread_out_there).toBe(false);
    const change = await threads.markUnread(id(), "t1");
    expect(change?.messages).toEqual([{ message_id: newest, labels_added: ["UNREAD"], labels_removed: [] }]);
    expect([older, newest, mine].map((m) => box.labelsOfMessage(m))).toEqual([["INBOX"], ["INBOX", "UNREAD"], ["INBOX"]]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", unread_out_there: true });
    await s.tick();
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", unread_out_there: true });
  });

  test("restore after an archive puts INBOX and UNREAD back on exactly the messages archive changed, and the card reopens", async () => {
    const { box, sync, ago, cards, threads, id } = await setup();
    const unread = box.deliver({ thread: "t1", at: ago(2 * HOUR), from: GRACE, to: "ada@acme.com" });
    const read = box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    const s = sync();
    await s.tick();
    const change = must(await threads.archive(id(), "t1"), "the archive's change");
    expect(change).toMatchObject({ move: "archive", ended: true, was_unread: true });
    expect([unread, read].map((m) => box.labelsOfMessage(m))).toEqual([[], []]);
    expect(cards()).toEqual([]);
    await threads.restore(id(), "t1", change);
    expect([unread, read].map((m) => box.labelsOfMessage(m))).toEqual([["INBOX", "UNREAD"], ["INBOX"]]);
    expect(cards()).toEqual(["t1"]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", unread_out_there: true });
    await s.tick();
    expect(cards()).toEqual(["t1"]);
  });

  test("the person moves an archived thread back into the inbox in Gmail: the next tick reopens its card", async () => {
    const { box, sync, ago, cards, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    await threads.archive(id(), "t1");
    await s.tick();
    expect(cards()).toEqual([]);
    box.addLabels("t1", ["INBOX"]);
    await s.tick();
    expect(cards()).toEqual(["t1"]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", generation: 1, unread_out_there: false });
  });

  test("a rebuild after history expired does not reopen a thread that has left the inbox", async () => {
    const { box, sync, ago, cards, threads, id } = await setup();
    box.deliver({ thread: "t-loki", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-gmail", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    await threads.archive(id(), "t-loki");
    box.removeLabels("t-gmail", ["INBOX"]);
    box.expireHistory();
    await s.tick();
    expect(cards()).toEqual([]);
    expect(["t-loki", "t-gmail"].map((t) => threads.get(id(), t)?.state)).toEqual(["archived", "archived"]);
  });

  test("adding the label Receipts puts it on the thread's messages and leaves INBOX and UNREAD alone; restore takes it off", async () => {
    const { box, sync, ago, threads, id } = await setup();
    const first = box.deliver({ thread: "t1", at: ago(2 * HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    const second = box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    await sync().tick();
    const labels = await threads.labels(id());
    const receipts = must(
      labels.find((l) => l.name === "Receipts"),
      "the Receipts label",
    );
    expect(receipts).toEqual({ id: "Label_1", name: "Receipts", type: "user" });
    const change = must(await threads.addLabels(id(), "t1", [receipts.id, "INBOX", "UNREAD"]), "the label's change");
    expect(change).toMatchObject({ move: "label", ended: false });
    expect(change.messages.map((m) => [m.message_id, m.labels_added, m.labels_removed])).toEqual([
      [first, ["Label_1"], []],
      [second, ["Label_1"], []],
    ]);
    expect([first, second].map((m) => box.labelsOfMessage(m))).toEqual([
      ["INBOX", "Label_1"],
      ["INBOX", "Label_1", "UNREAD"],
    ]);
    expect(threads.get(id(), "t1")).toMatchObject({ state: "open", unread_out_there: true });
    await threads.restore(id(), "t1", change);
    expect([first, second].map((m) => box.labelsOfMessage(m))).toEqual([["INBOX"], ["INBOX", "UNREAD"]]);
  });

  test("no label move or undo trashes mail: TRASH and SPAM in a picked label or an undo's change are left out", async () => {
    const { box, sync, ago, threads, id } = await setup();
    const only = box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    await sync().tick();
    await expect(threads.addLabels(id(), "t1", ["TRASH", "SPAM"])).rejects.toThrow("pick a label");
    // An undo whose change a client wrote itself: what it names is not trusted.
    await threads.restore(id(), "t1", {
      move: "label",
      messages: [{ message_id: only, labels_added: ["INBOX"], labels_removed: ["TRASH", "SPAM"] }],
      ended: false,
      was_unread: true,
    });
    expect(box.labelsOfMessage(only)).toEqual(["UNREAD"]);
  });

  test("a Gmail refusal answers the reason in words, and the record is unchanged", async () => {
    const { box, sync, ago, threads, id } = await setup();
    box.deliver({ thread: "t1", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t2", at: ago(HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    await sync().tick();
    const before = threads.list(id());
    box.state.refuseModify = "Request had insufficient authentication scopes.";
    // A refusal for a scope the sign-in lacks says how to get it back (plan 2026-11-11 scripts, R17).
    const words = "this Google account has not let loki use Gmail: sign in again for it in Preferences › Accounts";
    await expect(threads.markRead(id(), "t1")).rejects.toThrow(words);
    await expect(threads.archive(id(), "t1")).rejects.toThrow(words);
    await expect(threads.addLabels(id(), "t1", ["Label_2"])).rejects.toThrow(words);
    await expect(threads.markUnread(id(), "t2")).rejects.toThrow(words);
    expect(threads.list(id())).toEqual(before);
    expect([box.labelsOf("t1"), box.labelsOf("t2")]).toEqual([["INBOX", "UNREAD"], ["INBOX"]]);
  });
});

describe("a Gmail account that fails (R22)", () => {
  test("a thread Gmail will not give is passed over: the history moves on and other mail still makes cards", async () => {
    const { box, sync, cards, ago } = await setup();
    const s = sync();
    await s.tick();
    box.deliver({ thread: "t-bad", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-good", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.state.unreadable.add("t-bad");
    await s.tick();
    expect(cards()).toEqual(["t-good"]);
    // The next tick starts after the unreadable thread: it is not read again, and new mail flows.
    box.deliver({ thread: "t-later", at: ago(0), from: GRACE, to: "ada@acme.com" });
    await s.tick();
    expect(cards()).toEqual(["t-good", "t-later"]);
    expect(box.requests.filter((r) => r.url.pathname.endsWith("/threads/t-bad"))).toHaveLength(1);
  });

  test("one account failing leaves another's sync running; three failures in a row say temporarily failing, and a good tick mends it", async () => {
    const { boxes, sync, cards, ago, accounts, id } = await setup(["ada@acme.com", "bo@acme.com"]);
    const watcher = new AccountWatcher({ accounts, factories: { gmail: (a) => sync(a.account_id === id(0) ? 0 : 1) } });
    await watcher.tick();
    boxes[0].state.failing = true;
    for (let i = 0; i < 2; i++) await watcher.tick();
    expect(must(accounts.get(id(0)), "ada").status).toBe("connected");
    boxes[1].deliver({ thread: "t-bo", at: ago(0), from: GRACE, to: "bo@acme.com" });
    await watcher.tick();
    expect(must(accounts.get(id(0)), "ada").status).toEqual({ disconnected: "temporarily_failing" });
    expect(cards(1)).toEqual(["t-bo"]);
    boxes[0].state.failing = false;
    boxes[0].deliver({ thread: "t-ada", at: ago(0), from: GRACE, to: "ada@acme.com" });
    await watcher.tick();
    expect(must(accounts.get(id(0)), "ada").status).toBe("connected");
    expect(cards(0)).toEqual(["t-ada"]);
  });
});
