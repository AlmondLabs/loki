import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads } from "../mod/account-threads.ts";
import { Accounts, accountIdOf } from "../mod/accounts.ts";
import { initLog } from "../mod/log.ts";
import { SlackClient } from "../mod/slack.ts";
import type { SlackSession } from "../mod/slack-session.ts";
import { SlackSync } from "../mod/slack-sync.ts";
import { must } from "./fixtures/must.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SESSION: SlackSession = {
  team_id: "T0ACME",
  team_name: "Acme",
  url: "https://acme.slack.com/",
  user_id: "U0ME",
  token: "xoxc-acme-1111",
  cookie: "xoxd-fixture",
};
const ACCOUNT = accountIdOf({ provider: "slack", team_id: "T0ACME", user_id: "U0ME" });
/** When the account was connected, in seconds: the line between watching and the batches of older items. */
const CONNECTED = Date.parse("2026-11-04T10:00:00Z") / 1000;
const DAY = 86_400;

/** A Slack ts `seconds` after the account was connected (negative for before). */
const at = (seconds: number) => `${String(CONNECTED + seconds)}.000100`;

interface FakeMessage {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
}

interface FakeItem {
  key: string;
  type: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  unread: boolean;
}

/**
 * A made-up Slack workspace answering the calls SlackSync makes, as Slack shapes them: DMs with read markers, channel
 * messages, the Activity feed (which, unlike Slack, ignores the types asked for, so a reaction reaches the client and
 * must be dropped there) and people. Every request is recorded.
 */
function fakeWorkspace() {
  const kinds = new Map<string, "im" | "mpim" | "channel">();
  const lastRead = new Map<string, string>();
  const messages = new Map<string, FakeMessage[]>();
  const activity: FakeItem[] = [];
  const users: Partial<Record<string, string>> = { U0GRACE: "Grace Hopper", U0ALAN: "Alan Turing", U0ME: "Ada" };
  const sent: Array<{ method: string; params: Record<string, string> }> = [];
  const mainStream = (c: string) => (messages.get(c) ?? []).filter((m) => !m.thread_ts || m.thread_ts === m.ts);
  const toMessage = (m: FakeMessage) => ({ type: "message", ts: m.ts, user: m.user, text: m.text, thread_ts: m.thread_ts });
  const toItem = (i: FakeItem) =>
    i.type === "thread_v2"
      ? {
          key: i.key,
          feed_ts: i.ts,
          is_unread: i.unread,
          item: { type: i.type, bundle_info: { payload: { thread_entry: { channel_id: i.channel, latest_ts: i.ts, thread_ts: i.thread_ts } } } },
        }
      : {
          key: i.key,
          feed_ts: i.ts,
          is_unread: i.unread,
          item: { type: i.type, message: { channel: i.channel, ts: i.ts, thread_ts: i.thread_ts, author_user_id: "U0GRACE" } },
        };

  const answer = (method: string, p: Partial<Record<string, string>>): unknown => {
    switch (method) {
      case "client.counts": {
        const count = (id: string) => {
          const latest = mainStream(id).at(-1)?.ts ?? null;
          const read = lastRead.get(id) ?? "0";
          return { id, has_unreads: latest !== null && latest > read, mention_count: 0, latest, last_read: read };
        };
        const of = (k: "im" | "mpim") => [...kinds].filter(([, v]) => v === k).map(([id]) => count(id));
        return { ok: true, ims: of("im"), mpims: of("mpim"), channels: [], threads: { has_unreads: false, mention_count: 0 } };
      }
      case "activity.feed": {
        const all = activity.filter((i) => p.unread_only !== "true" || i.unread).sort((a, b) => b.ts.localeCompare(a.ts));
        const from = Number(p.cursor ?? "0");
        const limit = Number(p.limit ?? "50");
        const next = from + limit < all.length ? String(from + limit) : "";
        return { ok: true, items: all.slice(from, from + limit).map(toItem), response_metadata: { next_cursor: next } };
      }
      case "conversations.history": {
        let list = mainStream(p.channel ?? "");
        if (p.oldest) list = list.filter((m) => m.ts > (p.oldest ?? ""));
        if (p.latest) list = list.filter((m) => (p.inclusive === "true" ? m.ts <= (p.latest ?? "") : m.ts < (p.latest ?? "")));
        return {
          ok: true,
          messages: list
            .reverse()
            .slice(0, Number(p.limit ?? "100"))
            .map(toMessage),
          has_more: false,
        };
      }
      case "conversations.replies": {
        const list = (messages.get(p.channel ?? "") ?? []).filter((m) => m.ts === p.ts || m.thread_ts === p.ts);
        return { ok: true, messages: list.map(toMessage), has_more: false };
      }
      case "conversations.info": {
        const k = kinds.get(p.channel ?? "") ?? "channel";
        return { ok: true, channel: { id: p.channel, is_im: k === "im", is_mpim: k === "mpim", is_channel: k === "channel" } };
      }
      case "users.info":
        return { ok: true, user: { id: p.user, name: "handle", real_name: users[p.user ?? ""] ?? "", profile: { display_name: "" } } };
      case "conversations.mark":
        lastRead.set(p.channel ?? "", p.ts ?? "");
        return { ok: true };
      default:
        return { ok: false, error: "unknown_method" };
    }
  };

  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const params = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
    const method = url.slice(url.lastIndexOf("/") + 1);
    sent.push({ method, params });
    return Promise.resolve(new Response(JSON.stringify(answer(method, params))));
  };

  return {
    sent,
    fetch: fetchFn,
    dm(id: string, kind: "im" | "mpim" = "im") {
      kinds.set(id, kind);
    },
    post(channel: string, m: FakeMessage) {
      if (!kinds.has(channel)) kinds.set(channel, "channel");
      messages.set(
        channel,
        [...(messages.get(channel) ?? []), m].sort((a, b) => a.ts.localeCompare(b.ts)),
      );
    },
    item(i: Omit<FakeItem, "unread"> & { unread?: boolean }) {
      activity.push({ unread: true, ...i });
    },
    readItem(key: string) {
      const i = activity.find((x) => x.key === key);
      if (i) i.unread = false;
    },
    read(channel: string, ts: string) {
      lastRead.set(channel, ts);
    },
    lastRead: (channel: string) => lastRead.get(channel) ?? null,
  };
}

/** One connected workspace over the fake, its thread records and its sync. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loki-slack-sync-"));
  dirs.push(dir);
  const slack = fakeWorkspace();
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true, now: () => new Date(CONNECTED * 1000) });
  await accounts.add({ account_id: ACCOUNT, provider: "slack", address: "Acme", owner_agent_id: "agent-work" });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  const client = new SlackClient({ session: () => Promise.resolve(SESSION), setStatus: () => {}, fetch: slack.fetch });
  const sync = new SlackSync({ accounts, threads, account: must(accounts.get(ACCOUNT)), client });
  const open = () => threads.list(ACCOUNT).filter((r) => r.state === "open");
  return { dir, slack, accounts, threads, sync, open };
}

describe("DMs", () => {
  test("a DM with three unread messages becomes one card showing them, from the person who wrote", async () => {
    const { slack, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(10), user: "U0GRACE", text: "seen earlier" });
    slack.read("D0GRACE", at(10));
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "Are you around?" });
    slack.post("D0GRACE", { ts: at(30), user: "U0GRACE", text: "I need the <https://acme.com/q3|Q3 numbers>" });
    slack.post("D0GRACE", { ts: at(40), user: "U0GRACE", text: "for &lt;@board&gt; at noon" });
    await sync.tick();
    expect(open()).toEqual([
      expect.objectContaining({
        thread_id: "D0GRACE",
        newest_message_id: at(40),
        newest_at: new Date((CONNECTED + 40) * 1000 + 0).toISOString(),
        sender: "Grace Hopper",
        subject_or_first_line: "for <@board> at noon",
        lines: ["Are you around?", "I need the Q3 numbers", "for <@board> at noon"],
        from_backfill: false,
      }),
    ]);
  });

  test("a reply inside a DM thread folds into the DM's one card", async () => {
    const { slack, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(10), user: "U0GRACE", text: "parent" });
    slack.read("D0GRACE", at(10));
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "a reply in the thread", thread_ts: at(10) });
    slack.item({ key: "k1", type: "thread_v2", channel: "D0GRACE", ts: at(20), thread_ts: at(10) });
    await sync.tick();
    expect(open().map((r) => [r.thread_id, r.lines.at(-1)])).toEqual([["D0GRACE", "a reply in the thread"]]);
  });

  test("Covers AE4. archiving a DM card marks the DM read up to the card's last message, not a later one", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "first" });
    await sync.tick();
    slack.post("D0GRACE", { ts: at(30), user: "U0GRACE", text: "came after the card was drawn" });
    await threads.archive(ACCOUNT, "D0GRACE");
    expect(slack.sent.filter((s) => s.method === "conversations.mark").map((s) => s.params)).toEqual([
      { token: SESSION.token, channel: "D0GRACE", ts: at(20) },
    ]);
    expect(slack.lastRead("D0GRACE")).toBe(at(20));
    expect(open()).toEqual([]);
  });

  test("a new message in the DM after archive opens the card again", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "first" });
    await sync.tick();
    await threads.archive(ACCOUNT, "D0GRACE");
    await sync.tick();
    expect(open()).toEqual([]);
    slack.post("D0GRACE", { ts: at(30), user: "U0GRACE", text: "one more thing" });
    await sync.tick();
    expect(open().map((r) => [r.thread_id, r.lines])).toEqual([["D0GRACE", ["one more thing"]]]);
  });

  test("a DM read in Slack past the card's last message leaves the Inbox at the next tick", async () => {
    const { slack, sync, open } = await fixture();
    slack.dm("G0TEAM", "mpim");
    slack.post("G0TEAM", { ts: at(20), user: "U0ALAN", text: "lunch?" });
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual(["G0TEAM"]);
    slack.read("G0TEAM", at(20));
    await sync.tick();
    expect(open()).toEqual([]);
  });
});

describe("Activity", () => {
  test("mentions, thread replies, @channel and user-group mentions each become a card; a reaction does not", async () => {
    const { slack, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.post("C0GEN", { ts: at(20), user: "U0ALAN", text: "<!channel> deploy at five" });
    slack.post("C0ENG", { ts: at(30), user: "U0GRACE", text: "<!subteam^S0OPS> paging ops" });
    slack.post("C0ENG", { ts: at(5), user: "U0ME", text: "my question" });
    slack.post("C0ENG", { ts: at(40), user: "U0ALAN", text: "answered it", thread_ts: at(5) });
    slack.post("C0GEN", { ts: at(50), user: "U0GRACE", text: "nice" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    slack.item({ key: "b", type: "at_channel", channel: "C0GEN", ts: at(20) });
    slack.item({ key: "c", type: "at_user_group", channel: "C0ENG", ts: at(30) });
    slack.item({ key: "d", type: "thread_v2", channel: "C0ENG", ts: at(40), thread_ts: at(5) });
    slack.item({ key: "e", type: "message_reaction", channel: "C0GEN", ts: at(50) });
    await sync.tick();
    const cards = Object.fromEntries(open().map((r) => [r.thread_id, r]));
    expect(Object.keys(cards).sort()).toEqual([`C0ENG:${at(5)}`, `C0ENG:${at(30)}`, `C0GEN:${at(10)}`, `C0GEN:${at(20)}`]);
    expect(cards[`C0GEN:${at(10)}`]).toMatchObject({ sender: "Grace Hopper", lines: ["@Ada can you check this"] });
    expect(cards[`C0GEN:${at(20)}`]).toMatchObject({ sender: "Alan Turing", lines: ["@channel deploy at five"] });
    expect(cards[`C0ENG:${at(5)}`]).toMatchObject({ sender: "Alan Turing", newest_message_id: at(40), lines: ["my question", "answered it"] });
  });

  test("an item loki cannot place is skipped, and the rest still make cards", async () => {
    const { slack, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> hello" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    slack.item({ key: "b", type: "at_user", channel: "", ts: at(11) });
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual([`C0GEN:${at(10)}`]);
  });

  test("Covers AE4. archiving an @mention card sends no conversations.mark, and with no mark endpoint known makes no Slack call", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.post("C0GEN", { ts: at(11), user: "U0ALAN", text: "unrelated, still unread" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    const before = slack.sent.length;
    await threads.archive(ACCOUNT, `C0GEN:${at(10)}`);
    expect(slack.sent.slice(before)).toEqual([]);
    expect(open()).toEqual([]);
    await sync.tick();
    expect(open()).toEqual([]);
    expect(slack.sent.some((s) => s.method === "conversations.mark")).toBe(false);
  });

  test("an Activity item read in Slack removes its card at the next tick", async () => {
    const { slack, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    expect(open()).toHaveLength(1);
    slack.readItem("a");
    await sync.tick();
    expect(open()).toEqual([]);
  });
});

describe("read, unread, labels and undo on a Slack card (plan 070, U3)", () => {
  test("mark read on a DM marks it read up to the card's last message, and the card ends", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "first" });
    await sync.tick();
    slack.post("D0GRACE", { ts: at(30), user: "U0GRACE", text: "came after the card was drawn" });
    const change = await threads.markRead(ACCOUNT, "D0GRACE");
    expect(change).toEqual({ move: "read", messages: [], ended: true, was_unread: true });
    expect(slack.sent.filter((s) => s.method === "conversations.mark").map((s) => s.params)).toEqual([
      { token: SESSION.token, channel: "D0GRACE", ts: at(20) },
    ]);
    expect(open()).toEqual([]);
  });

  test("mark read on an Activity item ends the card in loki, calls Slack for nothing, and logs the gap", async () => {
    const { dir, slack, threads, sync, open } = await fixture();
    const logFile = join(dir, "mod.log");
    initLog(logFile);
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    const before = slack.sent.length;
    expect(await threads.markRead(ACCOUNT, `C0GEN:${at(10)}`)).toMatchObject({ move: "read", ended: true });
    expect(slack.sent.slice(before)).toEqual([]);
    expect(open()).toEqual([]);
    expect(readFileSync(logFile, "utf8")).toContain("slack:activity-mark-unavailable");
  });

  test("mark unread keeps the card unread in loki and writes nothing to Slack; labels are refused in words; undo reopens in loki", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "first" });
    await sync.tick();
    const before = slack.sent.length;
    expect(await threads.markUnread(ACCOUNT, "D0GRACE")).toEqual({ move: "unread", messages: [], ended: false, was_unread: true });
    expect(slack.sent.slice(before)).toEqual([]);
    expect(open().map((r) => [r.thread_id, r.unread_out_there])).toEqual([["D0GRACE", true]]);
    await expect(threads.addLabels(ACCOUNT, "D0GRACE", ["Label_1"])).rejects.toThrow("Slack has no labels");
    await expect(threads.labels(ACCOUNT)).rejects.toThrow("Slack has no labels");
    const change = must(await threads.archive(ACCOUNT, "D0GRACE"), "the archive's change");
    expect(open()).toEqual([]);
    const marks = slack.sent.filter((s) => s.method === "conversations.mark").length;
    await threads.restore(ACCOUNT, "D0GRACE", change);
    expect(open().map((r) => r.thread_id)).toEqual(["D0GRACE"]);
    expect(slack.sent.filter((s) => s.method === "conversations.mark")).toHaveLength(marks);
  });
});

describe("older unread items", () => {
  test("arrive in batches of the last few days first, then older, each when the account's cards are cleared", async () => {
    const { slack, accounts, threads, sync, open } = await fixture();
    const mention = (key: string, seconds: number) => {
      slack.post("C0GEN", { ts: at(seconds), user: "U0GRACE", text: `<@U0ME> ${key}` });
      slack.item({ key, type: "at_user", channel: "C0GEN", ts: at(seconds) });
    };
    for (let i = 0; i < 25; i++) mention(`recent-${String(i)}`, -DAY + i);
    mention("last-week", -5 * DAY);
    slack.dm("D0OLD");
    slack.post("D0OLD", { ts: at(-40 * DAY), user: "U0ALAN", text: "from long ago" });
    const clear = async () => {
      for (const r of open()) await threads.archive(ACCOUNT, r.thread_id);
    };

    await sync.tick();
    expect(open()).toHaveLength(20);
    expect(open().every((r) => r.from_backfill && r.subject_or_first_line.startsWith("@Ada recent-"))).toBe(true);
    expect(open().map((r) => r.subject_or_first_line)).toContain("@Ada recent-24");

    mention("live", 60);
    await sync.tick();
    expect(open()).toHaveLength(21);
    await clear();
    await sync.tick();
    expect(
      open()
        .map((r) => r.subject_or_first_line)
        .sort(),
    ).toEqual(["@Ada recent-0", "@Ada recent-1", "@Ada recent-2", "@Ada recent-3", "@Ada recent-4"]);

    await clear();
    await sync.tick();
    expect(open().map((r) => r.subject_or_first_line)).toEqual(["@Ada last-week"]);

    await clear();
    await sync.tick();
    expect(open().map((r) => [r.thread_id, r.from_backfill])).toEqual([["D0OLD", true]]);

    await clear();
    await sync.tick();
    expect(open()).toEqual([]);
    expect(must(accounts.get(ACCOUNT)).backfill).toMatchObject({ exhausted: true });
  });
});

describe("a channel's read marker", () => {
  test("never moves, whatever is archived", async () => {
    const { slack, threads, sync } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "dm" });
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> hi" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    for (const r of threads.list(ACCOUNT)) await threads.archive(ACCOUNT, r.thread_id);
    expect(slack.sent.filter((s) => s.method === "conversations.mark").map((s) => s.params.channel)).toEqual(["D0GRACE"]);
  });
});
