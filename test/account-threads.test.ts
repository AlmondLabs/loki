import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads, type ObservedMessage, type OutsideSource } from "../mod/account-threads.ts";
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
    const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts, agentName: (id) => (id === "agent-work" ? "Work" : null) });
    if (source) threads.register("gmail", source);
    return threads;
  };
  return { dir, accounts, threads: make(), again: make };
}

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
      },
    });
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

  test("a thread read out there leaves the Inbox, and comes back only with a newer message, as the same card", async () => {
    const { threads } = await fixture();
    threads.observe(MAIL, message());
    threads.markReadOutThere(MAIL, "t1");
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
    const { threads } = await fixture({
      archive: (accountId, record) => {
        archived.push(`${accountId} ${record.thread_id} ${record.newest_message_id}`);
        return Promise.resolve();
      },
    });
    threads.observe(MAIL, message());
    await threads.archive(MAIL, "t1");
    expect(archived).toEqual([`${MAIL} t1 m1`]);
    expect(threads.rows()).toEqual([]);
  });

  test("an archive the account refuses throws its reason and the card stays", async () => {
    const { threads } = await fixture({ archive: () => Promise.reject(new Error("Gmail is out of reach")) });
    threads.observe(MAIL, message());
    await expect(threads.archive(MAIL, "t1")).rejects.toThrow("Gmail is out of reach");
    expect(threads.rows().map((r) => r.id)).toEqual(["t1#1"]);
  });

  test("the records outlive a restart, in a file per account whose name Windows allows", async () => {
    const { dir, threads, again } = await fixture();
    threads.observe(MAIL, message());
    threads.markReadOutThere(MAIL, "t1");
    const files = readdirSync(join(dir, "account-threads"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[<>:"/\\|?*]/);
    // Read again, the archived thread still keeps an old message from making a card.
    const next = again();
    expect(next.observe(MAIL, message())).toBe(false);
    expect(next.rows()).toEqual([]);
  });
});
