import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads } from "../mod/account-threads.ts";
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
  const sync = (i = 0) => {
    const account = must(accounts.get(`gmail:${addresses[i]}`), "the account");
    return new GmailSync({ accounts, threads, account, client: clientOf(account.account_id), now: clock });
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

  test("with 300 unread direct threads only the last 3 days come; each clearing brings every unread thread of the next window (AE3)", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    // One direct thread every 6 hours, newest first: 12 in the last 3 days, 16 more back to 7 days, 28 more to 14.
    for (let i = 0; i < 300; i++) box.deliver({ thread: `t${String(i).padStart(3, "0")}`, at: ago(i * 6 * HOUR + HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    const first = cards();
    expect(first).toHaveLength(12);
    expect(first.at(-1)).toBe("t011");
    // Nothing more while a card is open.
    await s.tick();
    expect(cards()).toEqual(first);
    const clear = async () => {
      for (const t of cards()) await threads.archive(id(), t);
    };
    await clear();
    await s.tick();
    const second = cards();
    expect(second).toEqual(Array.from({ length: 16 }, (_, i) => `t${String(12 + i).padStart(3, "0")}`));
    // Unread threads are not capped: the whole of the next window comes at once.
    await clear();
    await s.tick();
    expect(cards()).toEqual(Array.from({ length: 28 }, (_, i) => `t${String(28 + i).padStart(3, "0")}`));
  });

  test("a window of 30 read threads and 5 unread ones brings all 5 unread and the 20 newest read (KTD5)", async () => {
    const { box, sync, cards, ago, threads, id } = await setup();
    const read = Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(2, "0")}`);
    const unread = Array.from({ length: 5 }, (_, i) => `u${String(i)}`);
    // All of them between 3 and 7 days old, so the first window is empty and the next holds them; the unread ones oldest.
    read.forEach((t, i) => box.deliver({ thread: t, at: ago(3 * DAY + (i + 1) * HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] }));
    unread.forEach((t, i) => box.deliver({ thread: t, at: ago(6 * DAY + i * HOUR), from: GRACE, to: "ada@acme.com" }));
    const s = sync();
    await s.tick();
    expect(cards()).toEqual([...read.slice(0, 20), ...unread].sort());
    expect(threads.list(id()).filter((r) => r.unread_out_there)).toHaveLength(5);
    // The unread cards hold the rest back until they are read; the read cards never do.
    await s.tick();
    expect(cards()).toHaveLength(25);
    for (const t of unread) box.removeLabels(t, ["UNREAD"]);
    await s.tick();
    expect(cards()).toEqual([...read, ...unread].sort());
    expect(threads.get(id(), read[29])?.state).toBe("open");
  });

  test("only an unread card holds the next batch back; read cards, resting or not, do not", async () => {
    const { box, sync, cards, ago } = await setup();
    for (const t of ["t-a", "t-b", "t-c"]) box.deliver({ thread: t, at: ago(HOUR), from: GRACE, to: "ada@acme.com", labels: ["INBOX"] });
    box.deliver({ thread: "t-old", at: ago(5 * DAY), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-older", at: ago(10 * DAY), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    expect(cards()).toEqual(["t-a", "t-b", "t-c"]);
    // Three read cards and no unread one: the next older batch comes, and its unread card holds the one after.
    await s.tick();
    expect(cards()).toEqual(["t-a", "t-b", "t-c", "t-old"]);
    await s.tick();
    expect(cards()).toEqual(["t-a", "t-b", "t-c", "t-old"]);
    box.removeLabels("t-old", ["UNREAD"]);
    await s.tick();
    expect(cards()).toEqual(["t-a", "t-b", "t-c", "t-old", "t-older"]);
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

  test("after the upgrade, a thread archived only because it was read and still in the inbox reopens; one archived in Gmail stays out", async () => {
    const { box, sync, cards, ago, threads, accounts, id } = await setup();
    box.deliver({ thread: "t-read", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    box.deliver({ thread: "t-gone", at: ago(HOUR), from: GRACE, to: "ada@acme.com" });
    const s = sync();
    await s.tick();
    // What the old rule left behind: both records archived, one read in Gmail, one archived there, and a cursor of before.
    box.removeLabels("t-read", ["UNREAD"]);
    box.removeLabels("t-gone", ["INBOX"]);
    threads.markGoneOutThere(id(), "t-read");
    threads.markGoneOutThere(id(), "t-gone");
    const { history_id, refill } = must(accounts.get(id()), "the account").backfill;
    accounts.setBackfill(id(), { history_id, refill });
    await s.tick();
    expect(cards()).toEqual(["t-read"]);
    expect(threads.get(id(), "t-read")).toMatchObject({ state: "open", unread_out_there: false });
    expect(threads.get(id(), "t-gone")?.state).toBe("archived");
    // The check is made once: a thread archived from loki later stays archived although Gmail still holds it.
    threads.markGoneOutThere(id(), "t-read");
    await s.tick();
    expect(cards()).toEqual([]);
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
