import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads, type ThreadRecord } from "../mod/account-threads.ts";
import { AccountWatcher } from "../mod/account-watcher.ts";
import { Accounts } from "../mod/accounts.ts";
import { JiraClient, JiraError, type JiraSecret, type JiraTicket } from "../mod/jira.ts";
import { JiraSync, jiraOutsideSource, type JiraSyncClient } from "../mod/jira-sync.ts";
import { JIRA_ADA, JIRA_BOB, JIRA_ME, fakeJira } from "./fixtures/jira.ts";
import { must } from "./fixtures/must.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const START = Date.parse("2026-11-10T09:00:00.000Z");
const ID = `jira:acme.atlassian.net:${JIRA_ME.account_id}`;

/** A time, in minutes from the first tick. */
const at = (minutes: number) => new Date(START + minutes * MIN);
/** The id the thread record keeps for a comment (`c`) or a history entry (`h`) made at a time (KTD8). */
const eid = (when: Date, kind: "c" | "h", jiraId: string) => `${when.toISOString()}:${kind}${jiraId.padStart(12, "0")}`;
/** A comment that mentions the person. */
const mentioning = (text: string) => ({
  version: 1,
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id: JIRA_ME.account_id, text: `@${JIRA_ME.display_name}` } },
        { type: "text", text: ` ${text}` },
      ],
    },
  ],
});

/**
 * One connected Jira site over the fake, on the test's clock. `faults` makes the client answer as Jira would in the
 * cases the fake site has no switch for: a failed search, a ticket whose calls fail or are refused as not found, a page
 * token Jira no longer takes, and a ticket whose update time moved with no new event (a comment edit).
 */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-jira-sync-"));
  dirs.push(dir);
  let now = START;
  const clock = () => new Date(now);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), now: clock });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  const jira = fakeJira({ now: clock });
  const secret: JiraSecret = { site: jira.host, email: jira.state.email, token: jira.state.token };
  await accounts.add({ account_id: ID, provider: "jira", address: jira.host, owner_agent_id: "agent-work" }, JSON.stringify(secret));
  threads.register("jira", jiraOutsideSource());
  const real = new JiraClient({
    secret: async () => JSON.parse(must(await accounts.getSecret(ID), "the secret")) as JiraSecret,
    setStatus: (status) => void accounts.setStatus(ID, status),
    fetch: jira.fetch,
    now: clock,
  });
  const faults = {
    search: false,
    failing: new Set<string>(),
    gone: new Set<string>(),
    staleTokens: new Set<string>(),
    /** Tickets by id with the update time an edit gave them. */
    edited: new Map<string, JiraTicket>(),
  };
  const guard = (ticket: string) => {
    if (faults.failing.has(ticket)) throw new JiraError("Jira answered 500", "http_500", 500);
    if (faults.gone.has(ticket)) throw new JiraError("Issue does not exist or you do not have permission to see it.", "not_found", 404);
  };
  const client: JiraSyncClient = {
    searchWatched: async (o) => {
      if (faults.search) throw new JiraError("Jira answered 500", "http_500", 500);
      if (o.pageToken && faults.staleTokens.delete(o.pageToken)) throw new JiraError("The page token has expired", "http_400", 400);
      const page = await real.searchWatched(o);
      if (o.sinceMinutes === null || faults.edited.size === 0) return page;
      const tickets = [...page.tickets.filter((t) => !faults.edited.has(t.id)), ...faults.edited.values()];
      return { ...page, tickets: tickets.sort((a, b) => a.updated.localeCompare(b.updated)) };
    },
    comments: async (ticket, o) => {
      guard(ticket);
      return real.comments(ticket, o);
    },
    history: async (ticket, o) => {
      guard(ticket);
      return real.history(ticket, o);
    },
  };
  const sync = (resting?: (r: ThreadRecord) => boolean) =>
    new JiraSync({ accounts, threads, account: must(accounts.get(ID), "the account"), client, now: clock, resting });
  const record = (ticketId: string) => threads.get(ID, ticketId);
  const open = () =>
    threads
      .list(ID)
      .filter((r) => r.state === "open")
      .map((r) => r.thread_id)
      .sort();
  /** Requests that read one ticket's comments or history. */
  const ticketReads = () => jira.requests.filter((r) => r.url.pathname.includes("/issue/")).length;
  const cursor = () => must(accounts.get(ID), "the account").backfill;
  return { accounts, threads, jira, faults, sync, record, open, ticketReads, cursor, advance: (ms: number) => (now += ms) };
}

/** A site whose first tick has run with nothing watched, so what a test adds afterwards arrives as new. */
async function connected() {
  const s = await setup();
  const sync = s.sync();
  await sync.tick();
  s.advance(MIN);
  return { ...s, tick: () => sync.tick() };
}

describe("an event on a watched ticket becomes a card (F2, R6, R7, R10)", () => {
  test("a comment by someone else makes one open card with that comment as what brought it", async () => {
    const { jira, tick, record, threads } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    const c = jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    expect(threads.rows().map((r) => r.outside?.thread_id)).toEqual([ticket]);
    expect(record(ticket)).toMatchObject({
      state: "open",
      newest_message_id: eid(at(0.5), "c", c),
      newest_at: at(0.5).toISOString(),
      sender: "Ada Lovelace",
      place: "OPS-1",
      subject_or_first_line: "Rotate the keys",
      lines: ["Can you look at this?"],
      reach: "watching",
      brought_ids: [eid(at(0.5), "c", c)],
      from_backfill: false,
    });
  });

  test("a status change and a second comment before the person reads leave one card with all three brought (AE2)", async () => {
    const { jira, tick, record, threads, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    const c1 = jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    // A quiet tick moves the watermark on, so the next one no longer reads the first comment: the card remembers it.
    advance(15 * MIN);
    await tick();
    advance(15 * MIN);
    const h = jira.change("OPS-1", { at: at(30.5), author: JIRA_BOB, items: [{ field: "status", from: "To Do", to: "In Progress" }] });
    const c2 = jira.comment("OPS-1", { at: at(30.6), author: JIRA_ADA, text: "Bob picked it up." });
    await tick();
    expect(threads.rows()).toHaveLength(1);
    expect(record(ticket)).toMatchObject({
      state: "open",
      generation: 1,
      newest_message_id: eid(at(30.6), "c", c2),
      lines: ["Bob picked it up."],
      brought_ids: [eid(at(0.5), "c", c1), eid(at(30.5), "h", h), eid(at(30.6), "c", c2)],
    });
  });

  test("after read ended the card, a new comment by someone else reopens the same card with only that comment brought (AE3)", async () => {
    const { jira, tick, record, threads, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    await threads.markRead(ID, ticket);
    expect(record(ticket)?.state).toBe("archived");
    advance(MIN);
    await tick();
    expect(record(ticket)?.state).toBe("archived");
    const c2 = jira.comment("OPS-1", { at: at(1.5), author: JIRA_BOB, text: "Done on staging." });
    advance(MIN);
    await tick();
    expect(record(ticket)).toMatchObject({ state: "open", generation: 1, sender: "Bob Stone", brought_ids: [eid(at(1.5), "c", c2)] });
    expect(threads.rows()).toHaveLength(1);
  });

  test("a comment on a ticket the person does not watch records nothing, though it is assigned to them (AE4)", async () => {
    const { jira, tick, threads } = await connected();
    jira.addTicket({ key: "OPS-1", summary: "Not watched", at: at(0.5), watchers: [JIRA_ADA], assignee: JIRA_ME });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, body: mentioning("this is yours") });
    await tick();
    expect(threads.list(ID)).toEqual([]);
  });

  test("ticks never end a card and never write to the site, whatever the person reads in Jira (AE5, R20)", async () => {
    const { jira, tick, record, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    const before = record(ticket);
    for (let i = 0; i < 15; i++) {
      advance(MIN);
      await tick();
    }
    expect(record(ticket)).toEqual(before);
    expect(before?.state).toBe("open");
    expect(jira.writes()).toEqual([]);
  });

  test("a history entry and a comment in the same minute both arrive, in the order they were made", async () => {
    const { jira, tick, record } = await connected();
    const first = jira.addTicket({ key: "OPS-1", summary: "History first", at: at(0.5) });
    const h1 = jira.change("OPS-1", { at: new Date(START + 30 * SEC), author: JIRA_BOB, items: [{ field: "status", from: "To Do", to: "Done" }] });
    const c1 = jira.comment("OPS-1", { at: new Date(START + 40 * SEC), author: JIRA_ADA, text: "Closing." });
    const second = jira.addTicket({ key: "OPS-2", summary: "Comment first", at: at(0.5) });
    const c2 = jira.comment("OPS-2", { at: new Date(START + 30 * SEC), author: JIRA_ADA, text: "Raising this." });
    const h2 = jira.change("OPS-2", {
      at: new Date(START + 40 * SEC),
      author: JIRA_BOB,
      items: [
        { field: "priority", from: "Low", to: "High" },
        { field: "assignee", from: null, to: "Bob Stone" },
      ],
    });
    await tick();
    expect(record(first)).toMatchObject({
      newest_message_id: eid(new Date(START + 40 * SEC), "c", c1),
      brought_ids: [eid(new Date(START + 30 * SEC), "h", h1), eid(new Date(START + 40 * SEC), "c", c1)],
    });
    expect(record(second)).toMatchObject({
      newest_message_id: eid(new Date(START + 40 * SEC), "h", h2),
      sender: "Bob Stone",
      lines: ["priority: Low → High", "assignee: none → Bob Stone"],
      brought_ids: [eid(new Date(START + 30 * SEC), "c", c2), eid(new Date(START + 40 * SEC), "h", h2)],
    });
  });

  test("a ticket moved to another project keeps its card, with the new key shown (KTD7)", async () => {
    const { jira, tick, record, threads, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    expect(record(ticket)?.place).toBe("OPS-1");
    jira.edit("OPS-1", { key: "PLAT-7", summary: "Rotate the platform keys" });
    jira.change("PLAT-7", { at: at(1.5), author: JIRA_ADA, items: [{ field: "Key", from: "OPS-1", to: "PLAT-7" }] });
    advance(MIN);
    await tick();
    expect(threads.list(ID)).toHaveLength(1);
    expect(record(ticket)).toMatchObject({ state: "open", generation: 1, place: "PLAT-7", subject_or_first_line: "Rotate the platform keys" });
  });
});

describe("the person's own events and comment edits bring nothing (R8, R27, KTD9)", () => {
  test("a ticket whose only new events are the person's own records nothing, and an open card's newest event does not change", async () => {
    const { jira, tick, record, threads, advance } = await connected();
    const carded = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    const before = record(carded);
    jira.comment("OPS-1", { at: at(1.5), author: JIRA_ME, text: "On it." });
    jira.change("OPS-1", { at: at(1.6), author: JIRA_ME, items: [{ field: "status", from: "To Do", to: "In Progress" }] });
    jira.addTicket({ key: "OPS-2", summary: "My own ticket", at: at(1.5) });
    jira.comment("OPS-2", { at: at(1.5), author: JIRA_ME, text: "A note to myself." });
    advance(MIN);
    await tick();
    expect(record(carded)).toEqual(before);
    expect(threads.list(ID)).toHaveLength(1);
  });

  test("the person's own comment on a card they ended does not bring it back", async () => {
    const { jira, tick, record, threads, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    await threads.markRead(ID, ticket);
    jira.comment("OPS-1", { at: at(1.5), author: JIRA_ME, text: "Done." });
    advance(MIN);
    await tick();
    expect(record(ticket)?.state).toBe("archived");
  });

  test("a ticket with an old event by someone else, brought into the search only by the person's own edit, makes no card", async () => {
    const { jira, tick, threads } = await connected();
    jira.addTicket({ key: "OPS-1", summary: "An old ticket", at: at(-24 * 60) });
    jira.comment("OPS-1", { at: at(-24 * 60), author: JIRA_ADA, text: "Yesterday's news." });
    jira.change("OPS-1", { at: at(0.5), author: JIRA_ME, items: [{ field: "labels", from: null, to: "infra" }] });
    await tick();
    expect(threads.list(ID)).toEqual([]);
  });

  test("an edit to an old comment moves the ticket's update time and records nothing (AE10)", async () => {
    const { jira, faults, tick, record, threads, advance } = await connected();
    // A ticket with no card, one with an open card and one whose card the person ended.
    const bare = jira.addTicket({ key: "OPS-1", summary: "Never a card", at: at(-24 * 60) });
    jira.comment("OPS-1", { at: at(-24 * 60), author: JIRA_ADA, text: "Yesterday's news." });
    const openCard = jira.addTicket({ key: "OPS-2", summary: "Open card", at: at(0.5) });
    jira.comment("OPS-2", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    const ended = jira.addTicket({ key: "OPS-3", summary: "Ended card", at: at(0.5) });
    jira.comment("OPS-3", { at: at(0.5), author: JIRA_BOB, text: "For your information." });
    await tick();
    await threads.markRead(ID, ended);
    const before = [record(openCard), record(ended)];
    advance(MIN);
    const edited = at(1.5).toISOString();
    faults.edited.set(bare, { id: bare, key: "OPS-1", summary: "Never a card", updated: edited, assignee_account_id: null });
    faults.edited.set(openCard, { id: openCard, key: "OPS-2", summary: "Open card", updated: edited, assignee_account_id: null });
    faults.edited.set(ended, { id: ended, key: "OPS-3", summary: "Ended card", updated: edited, assignee_account_id: null });
    await tick();
    expect(record(bare)).toBeNull();
    expect([record(openCard), record(ended)]).toEqual(before);
    expect(before.map((r) => r?.state)).toEqual(["open", "archived"]);
  });
});

describe("the tag says why the card is there (R13, KTD16)", () => {
  test("a mention in a brought comment gives mention; otherwise a ticket assigned to the person gives assigned; otherwise watching", async () => {
    const { jira, tick, record } = await connected();
    const mentioned = jira.addTicket({ key: "OPS-1", summary: "Mentioned", at: at(0.5), assignee: JIRA_ME });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, body: mentioning("can you check?") });
    const assigned = jira.addTicket({ key: "OPS-2", summary: "Assigned", at: at(0.5), assignee: JIRA_ME });
    jira.comment("OPS-2", { at: at(0.5), author: JIRA_ADA, text: "Any news?" });
    const watching = jira.addTicket({ key: "OPS-3", summary: "Watched", at: at(0.5), assignee: JIRA_BOB });
    jira.comment("OPS-3", { at: at(0.5), author: JIRA_ADA, text: "Any news?" });
    await tick();
    expect(record(mentioned)).toMatchObject({ reach: "mention", lines: ["@Mina Example can you check?"] });
    expect(record(assigned)?.reach).toBe("assigned");
    expect(record(watching)?.reach).toBe("watching");
  });

  test("a mention followed by a field edit still gives mention, in one batch and across ticks, until the person reads", async () => {
    const { jira, tick, record, threads, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Mentioned", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, body: mentioning("can you check?") });
    jira.change("OPS-1", { at: at(0.6), author: JIRA_BOB, items: [{ field: "labels", from: null, to: "infra" }] });
    await tick();
    expect(record(ticket)).toMatchObject({ reach: "mention", sender: "Bob Stone" });
    // A quiet tick moves the watermark on, so the next one reads only the edit: the mention that brought the card still counts.
    advance(15 * MIN);
    await tick();
    jira.change("OPS-1", { at: at(30.5), author: JIRA_BOB, items: [{ field: "priority", from: "Low", to: "High" }] });
    advance(15 * MIN);
    await tick();
    expect(record(ticket)).toMatchObject({ reach: "mention", lines: ["priority: Low → High"] });
    // Once read, the mention is dealt with: the next plain event is only a watched ticket's.
    await threads.markRead(ID, ticket);
    jira.comment("OPS-1", { at: at(31.5), author: JIRA_BOB, text: "Fixed." });
    advance(MIN);
    await tick();
    expect(record(ticket)).toMatchObject({ state: "open", reach: "watching" });
  });
});

describe("the watermark, the overlap and the memo (KTD6)", () => {
  test("a ticket the overlap returns again with the same update time is not read again", async () => {
    const { jira, tick, record, ticketReads, cursor, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    const reads = ticketReads();
    expect(reads).toBeGreaterThan(0);
    const before = record(ticket);
    advance(MIN);
    await tick();
    expect(ticketReads()).toBe(reads);
    expect(record(ticket)).toEqual(before);
    // A tick that read all the search returned stands the watermark at its own start.
    expect(cursor().watermark).toBe(at(2).toISOString());
    expect(cursor().seen).toEqual({ [ticket]: at(0.5).toISOString() });
  });

  test("a ticket the whole-minute search returns from just before the overlap is not read", async () => {
    const { jira, tick, record, ticketReads, advance } = await connected();
    // The watermark stands at the first tick; half a minute more makes the search reach 30 s before the overlap.
    advance(30 * SEC);
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Just too old", at: at(-10.25) });
    jira.comment("OPS-1", { at: at(-10.25), author: JIRA_ADA, text: "From before." });
    await tick();
    expect(jira.requests.at(-1)?.url.searchParams.get("jql")).toContain("-12m");
    expect(ticketReads()).toBe(0);
    expect(record(ticket)).toBeNull();
  });

  test("the memo forgets a ticket once the overlap can no longer return it", async () => {
    const { jira, tick, cursor, advance } = await connected();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    advance(20 * MIN);
    const later = jira.addTicket({ key: "OPS-2", summary: "Fix the pager", at: at(20.5) });
    jira.comment("OPS-2", { at: at(20.5), author: JIRA_ADA, text: "It rang twice." });
    await tick();
    expect(cursor().seen).toEqual({ [later]: at(20.5).toISOString() });
  });

  test("with 100 changed tickets, a tick handles 40 and the watermark stands at the fortieth; the next ticks finish the rest", async () => {
    const { jira, tick, record, threads, cursor, advance } = await connected();
    const changed = (i: number) => new Date(START + MIN + i * SEC);
    const tickets: string[] = [];
    for (let i = 0; i < 100; i++) {
      tickets.push(jira.addTicket({ key: `OPS-${String(i)}`, summary: `Ticket ${String(i)}`, at: changed(i) }));
      jira.comment(`OPS-${String(i)}`, { at: changed(i), author: JIRA_ADA, text: `Comment ${String(i)}` });
    }
    advance(2 * MIN);
    await tick();
    expect(tickets.filter((t) => record(t))).toEqual(tickets.slice(0, 40));
    expect(cursor().watermark).toBe(changed(39).toISOString());
    advance(MIN);
    await tick();
    expect(tickets.filter((t) => record(t))).toEqual(tickets.slice(0, 80));
    expect(cursor().watermark).toBe(changed(79).toISOString());
    advance(MIN);
    await tick();
    expect(tickets.filter((t) => record(t))).toEqual(tickets);
    expect(threads.list(ID)).toHaveLength(100);
  });

  test("a tick that fails halfway leaves the watermark at the last ticket fully handled, and the next tick takes up the rest", async () => {
    const { jira, faults, tick, record, cursor, advance } = await connected();
    const changed = (i: number) => new Date(START + 30 * SEC + i * SEC);
    const tickets: string[] = [];
    for (let i = 0; i < 10; i++) {
      tickets.push(jira.addTicket({ key: `OPS-${String(i)}`, summary: `Ticket ${String(i)}`, at: changed(i) }));
      jira.comment(`OPS-${String(i)}`, { at: changed(i), author: JIRA_ADA, text: `Comment ${String(i)}` });
    }
    faults.failing.add(tickets[4]);
    await expect(tick()).rejects.toThrow("Jira answered 500");
    expect(cursor().watermark).toBe(changed(3).toISOString());
    expect(record(tickets[4])).toBeNull();
    expect(record(tickets[8])).toBeNull();
    faults.failing.clear();
    advance(MIN);
    await tick();
    expect(tickets.filter((t) => record(t))).toEqual(tickets);
  });
});

describe("when Jira refuses, limits or fails (KTD5, R3)", () => {
  test("a 429 skips ticks until the wait ends and does not count toward failing for now", async () => {
    const { jira, accounts, tick, record, advance } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    jira.state.retry_after = 300;
    await tick();
    const asked = jira.requests.length;
    for (let i = 0; i < 4; i++) {
      advance(MIN);
      await tick();
    }
    // Held by the limit: nothing more was asked, no tick threw, and the account never showed as failing.
    expect(jira.requests).toHaveLength(asked);
    expect(accounts.get(ID)?.status).toBe("connected");
    expect(record(ticket)).toBeNull();
    jira.state.retry_after = null;
    advance(MIN);
    await tick();
    expect(record(ticket)?.state).toBe("open");
  });

  test("three failed ticks set failing for now; a good tick clears it", async () => {
    const { accounts, faults, tick, advance } = await connected();
    faults.search = true;
    for (let i = 0; i < 2; i++) {
      await expect(tick()).rejects.toThrow("Jira answered 500");
      advance(MIN);
    }
    expect(accounts.get(ID)?.status).toBe("connected");
    await expect(tick()).rejects.toThrow("Jira answered 500");
    expect(accounts.get(ID)?.status).toEqual({ disconnected: "temporarily_failing" });
    faults.search = false;
    advance(MIN);
    await tick();
    expect(accounts.get(ID)?.status).toBe("connected");
  });

  test("a rejected token sets sign_in_again, the watcher stops ticking the account, its open cards stay, and a reconnect resumes (AE6)", async () => {
    const { jira, accounts, threads, sync, record, advance } = await setup();
    const reports: string[] = [];
    const watcher = new AccountWatcher({ accounts, factories: { jira: () => sync() }, report: (event) => reports.push(event) });
    await watcher.tick();
    advance(MIN);
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await watcher.tick();
    expect(record(ticket)?.state).toBe("open");

    jira.state.unauthorized = true;
    advance(MIN);
    await watcher.tick();
    expect(accounts.get(ID)?.status).toEqual({ disconnected: "sign_in_again" });
    expect(reports).toEqual(["account:sync-failed"]);
    const asked = jira.requests.length;
    advance(MIN);
    await watcher.tick();
    expect(jira.requests).toHaveLength(asked);
    expect(threads.rows().map((r) => r.outside?.disconnected)).toEqual(["sign_in_again"]);

    // A new token: the account is connected again and the events since come.
    jira.state.unauthorized = false;
    const c2 = jira.comment("OPS-1", { at: at(2.5), author: JIRA_BOB, text: "Still waiting." });
    accounts.setStatus(ID, "connected");
    advance(MIN);
    await watcher.tick();
    expect(record(ticket)?.newest_message_id).toBe(eid(at(2.5), "c", c2));
  });

  test("a ticket the token can no longer see is skipped, and the tick goes on", async () => {
    const { jira, faults, tick, record, ticketReads, advance } = await connected();
    const hidden = jira.addTicket({ key: "SEC-1", summary: "Moved out of sight", at: at(0.4) });
    jira.comment("SEC-1", { at: at(0.4), author: JIRA_ADA, text: "Restricted now." });
    const seen = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    faults.gone.add(hidden);
    await tick();
    expect(record(hidden)).toBeNull();
    expect(record(seen)?.state).toBe("open");
    // It is passed, not tried again each tick.
    const reads = ticketReads();
    faults.gone.clear();
    advance(MIN);
    await tick();
    expect(ticketReads()).toBe(reads);
  });
});

describe("the past fill (R11, KTD19)", () => {
  /** Watched tickets from before the connection, the first the most recently changed; `own` names those only the person wrote on. */
  const past = (jira: ReturnType<typeof fakeJira>, count: number, own: (i: number) => boolean = () => false) => {
    const tickets: string[] = [];
    const comments: string[] = [];
    for (let i = 0; i < count; i++) {
      const when = new Date(START - HOUR - i * MIN);
      tickets.push(jira.addTicket({ key: `OLD-${String(i)}`, summary: `Old ${String(i)}`, at: when }));
      comments.push(jira.comment(`OLD-${String(i)}`, { at: when, author: own(i) ? JIRA_ME : JIRA_ADA, text: `Old comment ${String(i)}` }));
    }
    return { tickets, comments };
  };

  test("the first sync opens the 20 most recently updated watched tickets that have an event by someone else, marked as from the past", async () => {
    const { jira, sync, record, open } = await setup();
    const { tickets, comments } = past(jira, 25, (i) => i === 3 || i === 7);
    await sync().tick();
    const expected = tickets.filter((_, i) => i !== 3 && i !== 7).slice(0, 20);
    expect(open()).toEqual([...expected].sort());
    expect(expected.map((t) => record(t)?.from_backfill)).toEqual(expected.map(() => true));
    expect(record(tickets[0])).toMatchObject({
      place: "OLD-0",
      subject_or_first_line: "Old 0",
      sender: "Ada Lovelace",
      reach: "watching",
      brought_ids: [eid(new Date(START - HOUR), "c", comments[0])],
    });
  });

  test("the past fill pages past tickets with no event by someone else instead of stopping", async () => {
    const { jira, sync, open, advance } = await setup();
    const { tickets } = past(jira, 45, (i) => i < 41);
    const s = sync();
    await s.tick();
    advance(MIN);
    await s.tick();
    expect(open()).toEqual(tickets.slice(41).sort());
  });

  test("with 20 open cards the past fill adds none; after two are read it adds two more", async () => {
    const { jira, threads, sync, open, ticketReads, advance } = await setup();
    const { tickets } = past(jira, 25);
    const s = sync();
    await s.tick();
    expect(open()).toEqual(tickets.slice(0, 20).sort());
    const reads = ticketReads();
    advance(MIN);
    await s.tick();
    expect(ticketReads()).toBe(reads);
    await threads.markRead(ID, tickets[0]);
    await threads.markRead(ID, tickets[1]);
    advance(MIN);
    await s.tick();
    expect(open()).toEqual(tickets.slice(2, 22).sort());
  });

  test("a new event comes through with 20 cards already open", async () => {
    const { jira, sync, record, open, advance } = await setup();
    past(jira, 25);
    const s = sync();
    await s.tick();
    expect(open()).toHaveLength(20);
    advance(MIN);
    const fresh = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await s.tick();
    expect(open()).toHaveLength(21);
    expect(record(fresh)).toMatchObject({ state: "open", from_backfill: false });
  });

  test("a page position Jira no longer takes starts the past fill again from the top", async () => {
    const { jira, faults, sync, open, cursor, advance } = await setup();
    // The first page holds ten cards and thirty tickets of the person's own; the five after it are the next page.
    const { tickets } = past(jira, 45, (i) => i >= 10 && i < 40);
    const s = sync();
    await s.tick();
    expect(open()).toEqual(tickets.slice(0, 10).sort());
    const position = must(cursor().past, "the past fill's position") as { page_token: string | null };
    faults.staleTokens.add(must(position.page_token, "a page token"));
    advance(MIN);
    await expect(s.tick()).rejects.toThrow("The page token has expired");
    expect(cursor().past).toEqual({ page_token: null, done: false });
    for (let i = 0; i < 2; i++) {
      advance(MIN);
      await s.tick();
    }
    expect(open()).toEqual([...tickets.slice(0, 10), ...tickets.slice(40)].sort());
  });
});

describe("the Jira write-back writes nothing to Jira (KTD10, R16, R18, R20)", () => {
  const card = { unread_out_there: true } as ThreadRecord;

  test("read answers ended; later answers not ended; restore does nothing; archive and labels refuse with a reason", async () => {
    const source = jiraOutsideSource();
    expect(await source.markRead(ID, card)).toEqual({ move: "read", messages: [], ended: true, was_unread: true });
    expect(await source.markUnread(ID, card)).toEqual({ move: "unread", messages: [], ended: false, was_unread: true });
    await expect(source.restore(ID, card, { move: "read", messages: [], ended: true, was_unread: true })).resolves.toBeUndefined();
    await expect(source.archive(ID, card)).rejects.toThrow(/Jira/);
    await expect(source.addLabels(ID, card, ["x"])).rejects.toThrow(/Jira/);
    await expect(source.labels(ID)).rejects.toThrow(/Jira/);
  });

  test("later keeps the card open and unread, and archive leaves it in place", async () => {
    const { jira, tick, record, threads } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    await threads.markUnread(ID, ticket);
    expect(record(ticket)).toMatchObject({ state: "open", unread_out_there: true });
    await expect(threads.archive(ID, ticket)).rejects.toThrow(/Jira/);
    expect(record(ticket)?.state).toBe("open");
    expect(jira.writes()).toEqual([]);
  });

  test("read works on an account whose status is disconnected, and asks the site nothing", async () => {
    const { jira, accounts, tick, record, threads } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    await tick();
    accounts.setStatus(ID, { disconnected: "sign_in_again" });
    const asked = jira.requests.length;
    await threads.markRead(ID, ticket);
    expect(record(ticket)?.state).toBe("archived");
    expect(jira.requests).toHaveLength(asked);
  });

  test("undo after read reopens the card with the same events brought", async () => {
    const { jira, tick, record, threads } = await connected();
    const ticket = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at(0.5) });
    const c = jira.comment("OPS-1", { at: at(0.5), author: JIRA_ADA, text: "Can you look at this?" });
    const h = jira.change("OPS-1", { at: at(0.6), author: JIRA_BOB, items: [{ field: "status", from: "To Do", to: "Done" }] });
    await tick();
    const brought = [eid(at(0.5), "c", c), eid(at(0.6), "h", h)];
    const change = must(await threads.markRead(ID, ticket), "the change");
    expect(record(ticket)).toMatchObject({ state: "archived", dealt_message_id: brought[1] });
    await threads.restore(ID, ticket, change);
    expect(record(ticket)).toMatchObject({ state: "open", generation: 1, dealt_message_id: null, brought_ids: brought });
    expect(jira.writes()).toEqual([]);
  });
});
