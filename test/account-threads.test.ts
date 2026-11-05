import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import type { OutsideChange } from "../core/frame-types.ts";
import { AccountThreads, type ObservedMessage, type OutsideSource, type ThreadRecord } from "../mod/account-threads.ts";
import { Accounts } from "../mod/accounts.ts";
import { must } from "./fixtures/must.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAIL = "gmail:ada@acme.com";

/** Accounts with one Gmail mailbox of the work agent, and the thread records in the same state folder. */
async function fixture(source?: OutsideSource) {
  const dir = mkdtempSync(join(tmpdir(), "loki-account-threads-"));
  dirs.push(dir);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true });
  await accounts.add({ account_id: MAIL, provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-work" });
  const make = () => {
    const threads = new AccountThreads({
      dir: join(dir, "account-threads"),
      accounts,
      agentName: (id) => (id === "agent-work" ? "Work" : null),
      now: () => new Date("2026-11-04T12:00:00.000Z"),
    });
    if (source) threads.register("gmail", source);
    return threads;
  };
  return { dir, accounts, threads: make(), again: make };
}

/** What a fake write-back says it changed: nothing on any message. */
const changeOf = (move: OutsideChange["move"], ended: boolean, record: ThreadRecord): OutsideChange => ({
  move,
  messages: [],
  ended,
  was_unread: record.unread_out_there,
});

/** A write-back that changes nothing out there, with any of its writes replaced. */
const fakeSource = (more: Partial<OutsideSource> = {}): OutsideSource => ({
  archive: (_a, r) => Promise.resolve(changeOf("archive", true, r)),
  markRead: (_a, r) => Promise.resolve(changeOf("read", false, r)),
  markUnread: (_a, r) => Promise.resolve(changeOf("unread", false, r)),
  addLabels: (_a, r) => Promise.resolve(changeOf("label", false, r)),
  restore: () => Promise.resolve(),
  labels: () => Promise.resolve([]),
  ...more,
});

const message = (more: Partial<ObservedMessage> = {}): ObservedMessage => ({
  thread_id: "t1",
  message_id: "m1",
  at: "2026-11-04T09:00:00.000Z",
  sender: "Grace Hopper",
  sender_address: "grace@acme.com",
  subject: "Quarterly numbers",
  lines: ["Can you look at these before Friday?"],
  ...more,
});

describe("the thread records of an account", () => {
  test("a thread seen for the first time is an open card keyed by account and thread, with its owner and what the card shows", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    const rows = threads.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "outside",
      id: "t1#1",
      agent_id: `account:${MAIL}`,
      title: "Quarterly numbers",
      last_message_at: "2026-11-04T09:00:00.000Z",
      archived: false,
      outside: {
        account_id: MAIL,
        provider: "gmail",
        account_label: "ada@acme.com",
        thread_id: "t1",
        generation: 1,
        owner_agent_id: "agent-work",
        owner_name: "Work",
        sender: "Grace Hopper",
        sender_address: "grace@acme.com",
        subject: "Quarterly numbers",
        lines: ["Can you look at these before Friday?"],
        newest_message_id: "m1",
        handoff_conversation_id: null,
        disconnected: null,
        unread_out_there: true,
      },
    });
  });

  test("covers AE7: the thread read out there keeps its card, shown as read, and unread again shows unread", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    expect(threads.observe(MAIL, message({ unread_out_there: false }))).toBe(true);
    expect(threads.rows().map((r) => [r.id, r.outside?.unread_out_there])).toEqual([["t1#1", false]]);
    expect(threads.observe(MAIL, message({ unread_out_there: false }))).toBe(false);
    expect(threads.observe(MAIL, message({ unread_out_there: true }))).toBe(true);
    expect(threads.get(MAIL, "t1")?.unread_out_there).toBe(true);
  });

  test("the read state of a thread that is not a card changes nothing", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    threads.markGoneOutThere(MAIL, "t1");
    expect(threads.observe(MAIL, message({ unread_out_there: false }))).toBe(false);
    expect(threads.rows()).toEqual([]);
  });

  test("reopen brings an archived thread back as the same card without a newer message; open and handed-off ones stay", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    threads.observe(MAIL, message({ thread_id: "t2" }));
    threads.markGoneOutThere(MAIL, "t1");
    threads.handedOff(MAIL, "t2", "conv-7");
    expect(threads.reopen(MAIL, "t1")).toBe(true);
    expect(threads.reopen(MAIL, "t1")).toBe(false);
    expect(threads.reopen(MAIL, "t2")).toBe(false);
    expect(threads.reopen(MAIL, "nope")).toBe(false);
    expect(threads.rows().map((r) => r.id)).toEqual(["t1#1"]);
  });

  test("a record from before read state was kept reads as unread out there, so no card goes quiet", async () => {
    const { dir, threads, again } = await fixture();
    threads.observe(MAIL, message());
    const folder = join(dir, "account-threads");
    const [name] = readdirSync(folder);
    const file = JSON.parse(readFileSync(join(folder, name), "utf8")) as { threads: Array<Record<string, unknown>> };
    delete file.threads[0].unread_out_there;
    writeFileSync(join(folder, name), JSON.stringify(file), { mode: 0o600 });
    expect(again().get(MAIL, "t1")?.unread_out_there).toBe(true);
  });

  test("covers AE2: a newer message on an open thread updates the same card; the same or an older one changes nothing", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    expect(threads.observe(MAIL, message({ message_id: "m0", at: "2026-11-04T08:00:00.000Z", lines: ["older"] }))).toBe(false);
    expect(threads.observe(MAIL, message())).toBe(false);
    expect(threads.observe(MAIL, message({ message_id: "m2", at: "2026-11-04T10:00:00.000Z", lines: ["a", "b", "c", "d"] }))).toBe(true);
    const rows = threads.rows();
    expect(rows.map((r) => r.id)).toEqual(["t1#1"]);
    expect(must(rows[0].outside, "outside").newest_message_id).toBe("m2");
    // The card shows the last few messages only.
    expect(must(rows[0].outside, "outside").lines).toEqual(["b", "c", "d"]);
  });

  test("a thread gone out there leaves the Inbox, and comes back only with a newer message, as the same card", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    threads.markGoneOutThere(MAIL, "t1");
    expect(threads.rows()).toEqual([]);
    expect(threads.observe(MAIL, message())).toBe(false);
    expect(threads.rows()).toEqual([]);
    threads.observe(MAIL, message({ message_id: "m2", at: "2026-11-04T10:00:00.000Z" }));
    expect(threads.rows().map((r) => r.id)).toEqual(["t1#1"]);
  });

  test("covers AE2: after a hand-off the next message is a new card, the next generation, naming the chat it went to", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    threads.handedOff(MAIL, "t1", "conv-7");
    expect(threads.rows()).toEqual([]);
    expect(threads.observe(MAIL, message())).toBe(false);
    threads.observe(MAIL, message({ message_id: "m2", at: "2026-11-04T10:00:00.000Z" }));
    const [row] = threads.rows();
    expect(row.id).toBe("t1#2");
    expect(must(row.outside, "outside")).toMatchObject({ generation: 2, handoff_conversation_id: "conv-7" });
  });

  test("a message that came while a hand-off ran keeps the card open as the next generation, naming the chat", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    // The hand-off read m1; m2 arrived before it finished.
    threads.observe(MAIL, message({ message_id: "m2", at: "2026-11-04T10:00:00.000Z" }));
    threads.handedOff(MAIL, "t1", "conv-7", "m1");
    const [row] = threads.rows();
    expect(row.id).toBe("t1#2");
    expect(must(row.outside, "outside")).toMatchObject({ generation: 2, newest_message_id: "m2", handoff_conversation_id: "conv-7" });
  });

  test("a hand-off of the newest message the card shows closes the card", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    threads.handedOff(MAIL, "t1", "conv-7", "m1");
    expect(threads.rows()).toEqual([]);
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "handed_off", generation: 1, handoff_conversation_id: "conv-7" });
  });

  test("moving the account to another agent keeps the card's key and names the new owner", async () => {
    const { threads, accounts } = await fixture();
    threads.observe(MAIL, message());
    accounts.moveOwner(MAIL, "agent-home");
    const [row] = threads.rows();
    expect([row.agent_id, row.id]).toEqual([`account:${MAIL}`, "t1#1"]);
    expect(must(row.outside, "outside").owner_agent_id).toBe("agent-home");
  });

  test("a disconnected account's cards say why", async () => {
    const { threads, accounts } = await fixture();
    threads.observe(MAIL, message());
    accounts.setStatus(MAIL, { disconnected: "sign_in_again" });
    expect(must(threads.rows()[0].outside, "outside").disconnected).toBe("sign_in_again");
  });

  test("archive writes back to the account first, then the card leaves", async () => {
    const archived: string[] = [];
    const { threads } = await fixture(
      fakeSource({
        archive: (accountId, record) => {
          archived.push(`${accountId} ${record.thread_id} ${record.newest_message_id}`);
          return Promise.resolve(changeOf("archive", true, record));
        },
      }),
    );
    threads.observe(MAIL, message());
    await threads.archive(MAIL, "t1");
    expect(archived).toEqual([`${MAIL} t1 m1`]);
    expect(threads.rows()).toEqual([]);
  });

  test("an archive the account refuses throws its reason and the card stays", async () => {
    const { threads } = await fixture(fakeSource({ archive: () => Promise.reject(new Error("Gmail is out of reach")) }));
    threads.observe(MAIL, message());
    await expect(threads.archive(MAIL, "t1")).rejects.toThrow("Gmail is out of reach");
    expect(threads.rows().map((r) => r.id)).toEqual(["t1#1"]);
  });

  test("mark read shows the card read and keeps it; mark unread shows it unread again (plan 070, R5, R6)", async () => {
    const { threads } = await fixture(fakeSource());
    threads.observe(MAIL, message());
    expect(await threads.markRead(MAIL, "t1")).toEqual({ move: "read", messages: [], ended: false, was_unread: true });
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", unread_out_there: false });
    expect(await threads.markUnread(MAIL, "t1")).toMatchObject({ move: "unread", was_unread: false });
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", unread_out_there: true });
  });

  test("a message that came while mark read ran keeps the card unread", async () => {
    let arrive = () => {};
    const { threads } = await fixture(
      fakeSource({
        markRead: (_a, r) => {
          arrive();
          return Promise.resolve(changeOf("read", false, r));
        },
      }),
    );
    threads.observe(MAIL, message());
    arrive = () => threads.observe(MAIL, message({ message_id: "m2", at: "2026-11-04T10:00:00.000Z" }));
    await threads.markRead(MAIL, "t1");
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", newest_message_id: "m2", unread_out_there: true });
  });

  test("restore puts the record back as the move found it: an archive reopens the card, a read shows it unread again", async () => {
    const restored: string[] = [];
    const { threads } = await fixture(
      fakeSource({
        restore: (_a, r, change) => {
          restored.push(`${r.thread_id} ${change.move}`);
          return Promise.resolve();
        },
      }),
    );
    threads.observe(MAIL, message());
    const archived = must(await threads.archive(MAIL, "t1"), "the archive's change");
    expect(threads.rows()).toEqual([]);
    await threads.restore(MAIL, "t1", archived);
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", generation: 1, unread_out_there: true });
    const read = must(await threads.markRead(MAIL, "t1"), "the read's change");
    await threads.restore(MAIL, "t1", read);
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", unread_out_there: true });
    expect(restored).toEqual(["t1 archive", "t1 read"]);
  });

  test("a card an undo reopened is kept open until a newer message, which clears the mark", async () => {
    const { threads } = await fixture(fakeSource({}));
    threads.observe(MAIL, message());
    expect(threads.get(MAIL, "t1")?.kept_open).toBe(false);
    const archived = must(await threads.archive(MAIL, "t1"), "the archive's change");
    await threads.restore(MAIL, "t1", archived);
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", kept_open: true });
    threads.observe(MAIL, message({ message_id: "m2", at: "2026-11-04T10:00:00.000Z" }));
    expect(threads.get(MAIL, "t1")).toMatchObject({ state: "open", newest_message_id: "m2", kept_open: false });
  });

  test("a write on a card that is not open writes nothing and answers null; a refused restore leaves the record", async () => {
    const { threads } = await fixture(fakeSource({ restore: () => Promise.reject(new Error("Gmail is out of reach")) }));
    threads.observe(MAIL, message());
    const archived = must(await threads.archive(MAIL, "t1"), "the archive's change");
    expect(await threads.markRead(MAIL, "t1")).toBeNull();
    expect(await threads.archive(MAIL, "t1")).toBeNull();
    await expect(threads.restore(MAIL, "t1", archived)).rejects.toThrow("Gmail is out of reach");
    expect(threads.get(MAIL, "t1")?.state).toBe("archived");
    await expect(threads.restore(MAIL, "t9", archived)).rejects.toThrow("loki has no record of that thread");
  });

  test("the records outlive a restart, in a file per account whose name Windows allows", async () => {
    const { dir, threads, again } = await fixture();
    threads.observe(MAIL, message());
    threads.markGoneOutThere(MAIL, "t1");
    const files = readdirSync(join(dir, "account-threads"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[<>:"/\\|?*]/);
    // Read again, the archived thread still keeps an old message from making a card.
    const next = again();
    expect(next.observe(MAIL, message())).toBe(false);
    expect(next.rows()).toEqual([]);
  });

  test("a damaged file is moved aside, owner-only, and the account starts empty instead of overwriting it", async () => {
    const { dir, threads, again } = await fixture();
    threads.observe(MAIL, message());
    const folder = join(dir, "account-threads");
    const [name] = readdirSync(folder);
    writeFileSync(join(folder, name), '{"version": 1, "threads": [{"thread_id"', { mode: 0o600 });
    const next = again();
    expect(next.rows()).toEqual([]);
    next.observe(MAIL, message({ thread_id: "t2" }));
    const bad = readdirSync(folder).filter((f) => f !== name);
    expect(bad).toEqual([`${name}.bad-20261104T120000Z`]);
    expect(readFileSync(join(folder, bad[0]), "utf8")).toBe('{"version": 1, "threads": [{"thread_id"');
    if (process.platform !== "win32") expect(statSync(join(folder, bad[0])).mode & 0o777).toBe(0o600);
    expect(next.list(MAIL).map((r) => r.thread_id)).toEqual(["t2"]);
  });
});
