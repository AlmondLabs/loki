import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ThreadRecord } from "../mod/account-threads.ts";
import type { AccountRecord } from "../mod/accounts.ts";
import { accountFrames } from "../mod/frames/accounts.ts";
import { InboxLedger } from "../mod/inbox-ledger.ts";
import { bridgeOf, client, settled } from "./fixtures/frames.ts";

/** The ledger of the person's moves on outside cards (plan 069): what they did, with what each thread was. */

const MAIL = "gmail:ada@acme.com";
const SLACK = "slack:T1:U1";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const account = (accountId: string): AccountRecord => ({
  account_id: accountId,
  provider: accountId.startsWith("gmail:") ? "gmail" : "slack",
  address: accountId.startsWith("gmail:") ? "ada@acme.com" : "Acme",
  owner_agent_id: "agent-work",
  status: "connected",
  connected_at: "2026-11-01T00:00:00.000Z",
  backfill: {},
});

const record = (threadId: string, over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  thread_id: threadId,
  state: "open",
  generation: 1,
  newest_message_id: "m2",
  newest_at: "2026-11-05T09:00:00.000Z",
  sender: "Edelweiss",
  sender_address: "statements@mf.example",
  subject_or_first_line: "Your monthly statement",
  lines: ["Your statement is ready"],
  handoff_conversation_id: null,
  from_backfill: false,
  traits: { to_you: true, list: false, automated: true, category: "updates" },
  unread_out_there: true,
  waiting: false,
  ...over,
});

/** A ledger in a fresh folder over the given accounts and threads, on a fixed clock. */
function ledgerWith(records: Array<[string, ThreadRecord]>, maxBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "loki-ledger-"));
  dirs.push(dir);
  const path = join(dir, "state", "inbox-ledger.jsonl");
  const accounts = [account(MAIL), account(SLACK)];
  const ledger = new InboxLedger({
    path,
    accounts: { get: (id) => accounts.find((a) => a.account_id === id) ?? null },
    threads: { get: (a, t) => records.find(([x, r]) => x === a && r.thread_id === t)?.[1] ?? null },
    now: () => new Date("2026-11-05T10:00:00.000Z"),
    ...(maxBytes ? { maxBytes } : {}),
  });
  const lines = () =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ledger, path, lines };
}

describe("the ledger of moves", () => {
  test("a move is one line, with who wrote, about what, what kind of mail it was, and how long the card was on top", () => {
    const { ledger, lines } = ledgerWith([[MAIL, record("t1")]]);
    ledger.record(MAIL, "t1", { action: "archive", via: "key", dwell_ms: 2400 });
    expect(lines()).toEqual([
      {
        at: "2026-11-05T10:00:00.000Z",
        account_id: MAIL,
        provider: "gmail",
        owner_agent_id: "agent-work",
        thread_id: "t1",
        generation: 1,
        message_id: "m2",
        action: "archive",
        via: "key",
        dwell_ms: 2400,
        sender: "Edelweiss",
        sender_address: "statements@mf.example",
        subject: "Your monthly statement",
        traits: { to_you: true, list: false, automated: true, category: "updates" },
        slack_kind: null,
        from_backfill: false,
        return_at: null,
        labels: null,
        picked: false,
        after_reply: null,
      },
    ]);
  });

  test("a later with a picked return time is one line with the time and the pick (plan 070, U10)", () => {
    const { ledger, lines } = ledgerWith([[MAIL, record("t1")]]);
    ledger.record(MAIL, "t1", { action: "later", via: "key", dwell_ms: 800, return_at: "2026-11-08T09:00:00.000Z", picked: true });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ action: "later", return_at: "2026-11-08T09:00:00.000Z", picked: true, labels: null, after_reply: null });
  });

  test("a label move keeps the labels put on, and an undo is a line of its own", () => {
    const { ledger, lines } = ledgerWith([[MAIL, record("t1")]]);
    ledger.record(MAIL, "t1", { action: "label", via: "click", dwell_ms: 300, labels: ["Label_7", "Label_9"] });
    ledger.record(MAIL, "t1", { action: "undo", via: null, dwell_ms: null });
    expect(lines().map((l) => [l.action, l.labels])).toEqual([
      ["label", ["Label_7", "Label_9"]],
      ["undo", null],
    ]);
  });

  test("a reply followed by ⌘E keeps the reply and the key that followed it", () => {
    const { ledger, lines } = ledgerWith([[MAIL, record("t1")]]);
    ledger.record(MAIL, "t1", { action: "reply", via: null, dwell_ms: 9000, after_reply: "archive" });
    expect(lines()[0]).toMatchObject({ action: "reply", after_reply: "archive", return_at: null });
  });

  test("Slack moves say whether the card was a DM or a thread, and moves add up in order", () => {
    const { ledger, lines } = ledgerWith([
      [SLACK, record("D1", { traits: null })],
      [SLACK, record("C1:1.0", { traits: null })],
    ]);
    ledger.record(SLACK, "D1", { action: "next", via: "swipe", dwell_ms: null });
    ledger.record(SLACK, "C1:1.0", { action: "reply", via: null, dwell_ms: 9000 });
    expect(lines().map((l) => [l.thread_id, l.action, l.slack_kind, l.traits])).toEqual([
      ["D1", "next", "dm", null],
      ["C1:1.0", "reply", "thread", null],
    ]);
  });

  test("a thread or account this Mac does not hold keeps nothing", () => {
    const { ledger, path } = ledgerWith([[MAIL, record("t1")]]);
    expect(ledger.record(MAIL, "elsewhere", { action: "next", via: "key", dwell_ms: 1 })).toBeNull();
    expect(ledger.record("gmail:bob@acme.com", "t1", { action: "next", via: "key", dwell_ms: 1 })).toBeNull();
    expect(() => readFileSync(path)).toThrow();
  });

  test("past its size the ledger moves to .1 and a fresh file starts", () => {
    const { ledger, path, lines } = ledgerWith([[MAIL, record("t1")]], 100);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${"x".repeat(200)}\n`);
    ledger.record(MAIL, "t1", { action: "archive", via: "click", dwell_ms: 5 });
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`${"x".repeat(200)}\n`);
    expect(lines()).toHaveLength(1);
  });
});

describe("the move frame", () => {
  /** The account frames on a bridge with a ledger that records what it is given; each frame's last answer. */
  function ask(withLedger = true) {
    const kept: unknown[] = [];
    const ledger = {
      record: (accountId: string, threadId: string, move: unknown) => {
        kept.push({ accountId, threadId, move });
        return null;
      },
    };
    const bridge = bridgeOf({ modules: [accountFrames(withLedger ? { ledger } : {})] });
    const send = async (frame: Record<string, unknown>) => {
      const c = client("d1");
      bridge.onMessage(c, { request_id: "r1", ...frame });
      await settled();
      return c.sent.at(-1) ?? {};
    };
    return { send, kept };
  }

  test("a move reaches the ledger as the person made it; a via or dwell it cannot read is left out", async () => {
    const { send, kept } = ask();
    await send({ type: "account_thread_move", account_id: MAIL, thread_id: "t1", action: "next", via: "key", dwell_ms: 1200.4 });
    await send({ type: "account_thread_move", account_id: MAIL, thread_id: "t1", action: "handoff", via: "elbow", dwell_ms: -3 });
    const bare = { return_at: null, labels: null, picked: false, after_reply: null };
    // A move from before plan 070 (Next, no return time, labels or pick) still reads.
    expect(kept).toEqual([
      { accountId: MAIL, threadId: "t1", move: { action: "next", via: "key", dwell_ms: 1200, ...bare } },
      { accountId: MAIL, threadId: "t1", move: { action: "handoff", via: null, dwell_ms: null, ...bare } },
    ]);
  });

  test("read, later, label, undo and a reply's following key reach the ledger with their facts; ones it cannot read are left out", async () => {
    const { send, kept } = ask();
    const move = (m: Record<string, unknown>) => send({ type: "account_thread_move", account_id: MAIL, thread_id: "t1", via: "key", dwell_ms: 5, ...m });
    await move({ action: "read", return_at: "2026-11-05T11:00:00.000Z" });
    await move({ action: "later", return_at: "2026-11-08T09:00:00.000Z", picked: true });
    await move({ action: "label", labels: ["Label_7"] });
    await move({ action: "undo", via: null, dwell_ms: null });
    await move({ action: "reply", via: null, after_reply: "archive" });
    await move({ action: "later", return_at: "soon", labels: ["ok", 3], picked: "yes", after_reply: "spam" });
    expect(kept.map((k) => (k as { move: unknown }).move)).toEqual([
      { action: "read", via: "key", dwell_ms: 5, return_at: "2026-11-05T11:00:00.000Z", labels: null, picked: false, after_reply: null },
      { action: "later", via: "key", dwell_ms: 5, return_at: "2026-11-08T09:00:00.000Z", labels: null, picked: true, after_reply: null },
      { action: "label", via: "key", dwell_ms: 5, return_at: null, labels: ["Label_7"], picked: false, after_reply: null },
      { action: "undo", via: null, dwell_ms: null, return_at: null, labels: null, picked: false, after_reply: null },
      { action: "reply", via: null, dwell_ms: 5, return_at: null, labels: null, picked: false, after_reply: "archive" },
      { action: "later", via: "key", dwell_ms: 5, return_at: null, labels: null, picked: false, after_reply: null },
    ]);
  });

  test("an action that is not a move is refused, and a mod without a ledger answers that it kept nothing", async () => {
    expect(await ask().send({ type: "account_thread_move", account_id: MAIL, thread_id: "t1", action: "approve" })).toMatchObject({
      type: "error",
      message: "action must be read, later, archive, label, reply, handoff, undo or next",
    });
    expect(await ask(false).send({ type: "account_thread_move", account_id: MAIL, thread_id: "t1", action: "next" })).toMatchObject({
      type: "account_move_kept",
      kept: false,
    });
  });
});
