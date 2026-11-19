import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads } from "../mod/account-threads.ts";
import { AccountWatcher } from "../mod/account-watcher.ts";
import { Accounts, accountIdOf } from "../mod/accounts.ts";
import { initLog } from "../mod/log.ts";
import { OutsideThreads } from "../mod/outside-threads.ts";
import { SlackClient } from "../mod/slack.ts";
import type { SlackSession } from "../mod/slack-session.ts";
import { SlackSync, slackOutsideSource } from "../mod/slack-sync.ts";
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
const CONNECTED = Date.parse("2026-11-04T10:00:00Z") / 1000;
const DAY = 86_400;

const at = (seconds: number) => `${String(CONNECTED + seconds)}.000100`;

interface FakeMessage {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  files?: unknown[];
}

interface FakeItem {
  key: string;
  type: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  unread: boolean;
}

function fakeWorkspace() {
  const kinds = new Map<string, "im" | "mpim" | "channel">();
  const lastRead = new Map<string, string>();
  // DMs closed in Slack, which client.counts no longer lists.
  const closed = new Set<string>();
  const messages = new Map<string, FakeMessage[]>();
  const activity: FakeItem[] = [];
  const users: Partial<Record<string, string>> = { U0GRACE: "Grace Hopper", U0ALAN: "Alan Turing", U0ME: "Ada" };
  const sent: Array<{ method: string; params: Record<string, string> }> = [];
  const refuse = {
    mark: null as string | null,
    feedAt: null as string | null,
    activityMark: null as string | null,
    info: null as string | null,
    history: null as string | null,
  };
  let posts = 0;
  const mainStream = (c: string) => (messages.get(c) ?? []).filter((m) => !m.thread_ts || m.thread_ts === m.ts);
  const toMessage = (m: FakeMessage) => ({ type: "message", ts: m.ts, user: m.user, text: m.text, thread_ts: m.thread_ts, files: m.files });
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
        const of = (k: "im" | "mpim") => [...kinds].filter(([id, v]) => v === k && !closed.has(id)).map(([id]) => count(id));
        return { ok: true, ims: of("im"), mpims: of("mpim"), channels: [], threads: { has_unreads: false, mention_count: 0 } };
      }
      case "activity.feed": {
        if (refuse.feedAt !== null && (p.cursor ?? "0") === refuse.feedAt) return { ok: false, error: "ratelimited" };
        const all = activity.filter((i) => p.unread_only !== "true" || i.unread).sort((a, b) => b.ts.localeCompare(a.ts));
        const from = Number(p.cursor ?? "0");
        const limit = Number(p.limit ?? "50");
        const next = from + limit < all.length ? String(from + limit) : "";
        return { ok: true, items: all.slice(from, from + limit).map(toItem), response_metadata: { next_cursor: next } };
      }
      case "conversations.history": {
        if (refuse.history) return { ok: false, error: refuse.history };
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
        // Slack's order: the parent, then the replies oldest first, a page at a time.
        const list = (messages.get(p.channel ?? "") ?? []).filter((m) => m.ts === p.ts || m.thread_ts === p.ts);
        const from = Number(p.cursor ?? "0");
        const limit = Number(p.limit ?? "1000");
        const more = from + limit < list.length;
        return {
          ok: true,
          messages: list.slice(from, from + limit).map(toMessage),
          has_more: more,
          response_metadata: { next_cursor: more ? String(from + limit) : "" },
        };
      }
      case "conversations.info": {
        if (refuse.info) return { ok: false, error: refuse.info };
        const k = kinds.get(p.channel ?? "") ?? "channel";
        const names: Partial<Record<string, string>> = { C0GEN: "general", C0ENG: "eng" };
        return {
          ok: true,
          channel: {
            id: p.channel,
            name: names[p.channel ?? ""],
            is_im: k === "im",
            is_mpim: k === "mpim",
            is_channel: k === "channel",
            last_read: lastRead.get(p.channel ?? "") ?? "0",
          },
        };
      }
      case "users.info":
        return {
          ok: true,
          user: {
            id: p.user,
            name: "handle",
            real_name: users[p.user ?? ""] ?? "",
            profile: { display_name: "", image_72: `https://avatars.example/${p.user ?? ""}.png` },
          },
        };
      case "conversations.mark":
        if (refuse.mark) return { ok: false, error: refuse.mark };
        lastRead.set(p.channel ?? "", p.ts ?? "");
        return { ok: true };
      case "activity.markRead":
      case "activity.markUnread": {
        if (refuse.activityMark) return { ok: false, error: refuse.activityMark };
        const entries: unknown = JSON.parse(p.entries ?? "null");
        if (!Array.isArray(entries)) return { ok: false, error: "invalid_arguments" };
        for (const e of entries as Array<Partial<Record<string, string>>>) {
          const i = activity.find((x) => x.key === e.key && x.type === e.type && x.ts === e.feed_ts);
          if (!i) return { ok: false, error: "invalid_arguments" };
          i.unread = method === "activity.markUnread";
        }
        return { ok: true };
      }
      case "chat.postMessage": {
        // The person's own post, which Slack counts as read up to it, as the desktop app does.
        const channel = p.channel ?? "";
        const ts = `${String(CONNECTED + 1000 + posts++)}.000100`;
        messages.set(channel, [...(messages.get(channel) ?? []), { ts, user: "U0ME", text: p.text ?? "", thread_ts: p.thread_ts }]);
        if (!p.thread_ts) lastRead.set(channel, ts);
        return { ok: true, ts };
      }
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
    refuse,
    fetch: fetchFn,
    dm(id: string, kind: "im" | "mpim" = "im") {
      kinds.set(id, kind);
    },
    close(id: string) {
      closed.add(id);
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
    unread: (key: string) => activity.find((x) => x.key === key)?.unread ?? null,
  };
}

async function fixture(clock = { t: CONNECTED * 1000 + 60_000 }) {
  const dir = mkdtempSync(join(tmpdir(), "loki-slack-sync-"));
  dirs.push(dir);
  const slack = fakeWorkspace();
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true, now: () => new Date(CONNECTED * 1000) });
  await accounts.add({ account_id: ACCOUNT, provider: "slack", address: "Acme", owner_agent_id: "agent-work" });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  const now = () => new Date(clock.t);
  const client = new SlackClient({ session: () => Promise.resolve(SESSION), setStatus: () => {}, fetch: slack.fetch, now });
  const resting = new Set<string>();
  const sync = new SlackSync({ accounts, threads, account: must(accounts.get(ACCOUNT)), client, now, resting: (r) => resting.has(r.thread_id) });
  threads.register(
    "slack",
    slackOutsideSource((accountId) => (accountId === ACCOUNT ? sync : null)),
  );
  const open = () => threads.list(ACCOUNT).filter((r) => r.state === "open");
  const outside = new OutsideThreads({
    accounts,
    threads,
    threadText: { gmail: () => Promise.resolve([]), slack: () => Promise.resolve([]), jira: () => Promise.resolve([]) },
    clientFor: () => ({ provider: "slack", client }),
  });
  return { dir, slack, accounts, threads, sync, open, outside, clock, resting };
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

  test("a message of only a file names the file on its card (plan 080)", async () => {
    const { slack, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "", files: [{ name: "invoice.pdf", pretty_type: "PDF", size: 10 }] });
    await sync.tick();
    expect(open().map((r) => [r.lines, r.subject_or_first_line])).toEqual([[["file: invoice.pdf"], "file: invoice.pdf"]]);
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

  test("a DM read and closed in Slack, which client.counts no longer lists, leaves the Inbox at the next tick", async () => {
    const { slack, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "Are you around?" });
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual(["D0GRACE"]);
    slack.close("D0GRACE");
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual(["D0GRACE"]);
    slack.read("D0GRACE", at(20));
    await sync.tick();
    expect(open()).toEqual([]);
  });

  test("a closed DM Slack no longer has leaves the Inbox; one Slack cannot describe now stays", async () => {
    const { slack, sync, open } = await fixture();
    slack.dm("G0LEFT", "mpim");
    slack.post("G0LEFT", { ts: at(20), user: "U0ALAN", text: "lunch?" });
    await sync.tick();
    slack.close("G0LEFT");
    slack.refuse.info = "internal_error";
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual(["G0LEFT"]);
    slack.refuse.info = "channel_not_found";
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

  test("each card knows where it was posted, how directly it is meant for the person, and the sender's photo (plan 073)", async () => {
    const { slack, sync, open, threads } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(5), user: "U0GRACE", text: "quick one" });
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.post("C0GEN", { ts: at(20), user: "U0ALAN", text: "<!channel> deploy at five" });
    slack.post("C0ENG", { ts: at(30), user: "U0GRACE", text: "<!subteam^S0OPS> paging ops" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    slack.item({ key: "b", type: "at_channel", channel: "C0GEN", ts: at(20) });
    slack.item({ key: "c", type: "at_user_group", channel: "C0ENG", ts: at(30) });
    await sync.tick();
    const cards = Object.fromEntries(open().map((r) => [r.thread_id, r]));
    expect(cards.D0GRACE).toMatchObject({ reach: "dm", place: null, sender_avatar: "https://avatars.example/U0GRACE.png" });
    expect(cards[`C0GEN:${at(10)}`]).toMatchObject({ reach: "mention", place: "#general" });
    expect(cards[`C0GEN:${at(20)}`]).toMatchObject({ reach: "channel", place: "#general", sender_avatar: "https://avatars.example/U0ALAN.png" });
    expect(cards[`C0ENG:${at(30)}`]).toMatchObject({ reach: "group", place: "#eng" });
    expect(slack.sent.filter((c) => c.method === "conversations.info" && c.params.channel === "C0GEN")).toHaveLength(1);
    const row = threads.rows().find((r) => r.outside?.thread_id === `C0GEN:${at(20)}`);
    expect(row?.outside).toMatchObject({ reach: "channel", place: "#general", only_account: true });
  });

  test("an item loki cannot place is skipped, and the rest still make cards", async () => {
    const { slack, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> hello" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    slack.item({ key: "b", type: "at_user", channel: "", ts: at(11) });
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual([`C0GEN:${at(10)}`]);
  });

  test("Covers AE4. archiving an @mention card sends no conversations.mark, and marks only its own Activity item read (plan 092)", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.post("C0GEN", { ts: at(11), user: "U0ALAN", text: "unrelated, still unread" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    const before = slack.sent.length;
    await threads.archive(ACCOUNT, `C0GEN:${at(10)}`);
    expect(slack.sent.slice(before).map((s) => s.method)).toEqual(["activity.markRead"]);
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

describe("walking the Activity feed", () => {
  const busy = (slack: ReturnType<typeof fakeWorkspace>) => {
    for (let i = 1; i <= 120; i++) {
      slack.post("C0GEN", { ts: at(i), user: "U0GRACE", text: `<@U0ME> item ${String(i)}` });
      slack.item({ key: `k${String(i)}`, type: "at_user", channel: "C0GEN", ts: at(i) });
    }
  };
  const feedCalls = (slack: ReturnType<typeof fakeWorkspace>) => slack.sent.filter((c) => c.method === "activity.feed").map((c) => c.params.cursor || "0");

  test("a tick reads the newest page; the whole feed is walked at first and then every 15 minutes", async () => {
    const { slack, sync, clock } = await fixture();
    busy(slack);
    await sync.tick();
    expect(feedCalls(slack)).toEqual(["0", "50", "100"]);
    clock.t += 60_000;
    await sync.tick();
    expect(feedCalls(slack)).toEqual(["0", "50", "100", "0"]);
    clock.t += 15 * 60_000;
    await sync.tick();
    expect(feedCalls(slack)).toEqual(["0", "50", "100", "0", "0", "50", "100"]);
  });

  test("a walk reads past 1,000 items, so the oldest unread mention is seen (plan 078)", async () => {
    const { slack, sync } = await fixture();
    for (let i = 1; i <= 1100; i++) slack.item({ key: `k${String(i)}`, type: "at_user", channel: "C0GEN", ts: at(i) });
    await sync.tick();
    expect(feedCalls(slack)).toHaveLength(22);
  });

  test("a walk a rate limit stops goes on from where it stopped, and the tick keeps what it read", async () => {
    const { slack, sync, open, clock } = await fixture();
    busy(slack);
    slack.refuse.feedAt = "50";
    await sync.tick();
    expect(feedCalls(slack)).toEqual(["0", "50"]);
    expect(open().length).toBeGreaterThan(0);
    slack.refuse.feedAt = null;
    clock.t += 61_000;
    await sync.tick();
    expect(feedCalls(slack)).toEqual(["0", "50", "50", "100"]);
  });

  test("a rate limit before anything is read ends the tick quietly and never counts toward failing for now", async () => {
    const { slack, sync, accounts, open, clock } = await fixture();
    busy(slack);
    slack.refuse.feedAt = "0";
    const reports: string[] = [];
    const watcher = new AccountWatcher({ accounts, factories: { slack: () => sync }, report: (event) => reports.push(event) });
    for (let i = 0; i < 4; i++) {
      await watcher.tick();
      clock.t += 61_000;
    }
    expect(reports).toEqual([]);
    expect(accounts.get(ACCOUNT)?.status).toBe("connected");
    expect(open()).toEqual([]);
    slack.refuse.feedAt = null;
    clock.t += 10 * 60_000;
    await watcher.tick();
    expect(open().length).toBeGreaterThan(0);
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

  test("mark read on an Activity card marks its items read in Slack, and no read marker moves (plan 092)", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    const before = slack.sent.length;
    expect(await threads.markRead(ACCOUNT, `C0GEN:${at(10)}`)).toMatchObject({ move: "read", ended: true });
    expect(slack.sent.slice(before).map((s) => [s.method, s.params.entries])).toEqual([
      ["activity.markRead", JSON.stringify([{ type: "at_user", key: "a", feed_ts: at(10) }])],
    ]);
    expect(slack.unread("a")).toBe(false);
    expect(slack.lastRead("C0GEN")).toBeNull();
    expect(open()).toEqual([]);
  });

  test("a thread's card marks every unread item of it up to the card's newest message, and not one that came after", async () => {
    const { slack, threads, sync } = await fixture();
    slack.post("C0ENG", { ts: at(10), user: "U0ME", text: "the plan" });
    slack.post("C0ENG", { ts: at(11), user: "U0GRACE", text: "<@U0ME> looks good", thread_ts: at(10) });
    slack.post("C0ENG", { ts: at(12), user: "U0ALAN", text: "agreed", thread_ts: at(10) });
    slack.item({ key: "m", type: "at_user", channel: "C0ENG", ts: at(11), thread_ts: at(10) });
    slack.item({ key: "t", type: "thread_v2", channel: "C0ENG", ts: at(12), thread_ts: at(10) });
    await sync.tick();
    const card = `C0ENG:${at(10)}`;
    expect(threads.get(ACCOUNT, card)?.newest_message_id).toBe(at(12));
    slack.post("C0ENG", { ts: at(13), user: "U0ALAN", text: "<@U0ME> one more", thread_ts: at(10) });
    slack.item({ key: "late", type: "at_user", channel: "C0ENG", ts: at(13), thread_ts: at(10) });
    await threads.archive(ACCOUNT, card);
    expect([slack.unread("m"), slack.unread("t"), slack.unread("late")]).toEqual([false, false, true]);
  });

  test("an undo marks the items unread again, and a second read marks them read once more", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    const card = `C0GEN:${at(10)}`;
    const change = must(await threads.markRead(ACCOUNT, card), "the read's change");
    await threads.restore(ACCOUNT, card, change);
    expect(slack.unread("a")).toBe(true);
    expect(open().map((r) => r.thread_id)).toEqual([card]);
    await threads.markRead(ACCOUNT, card);
    expect(slack.unread("a")).toBe(false);
  });

  test("when Slack refuses the mark, the card still ends in loki and the refusal is logged", async () => {
    const { dir, slack, threads, sync, open } = await fixture();
    const logFile = join(dir, "mod.log");
    initLog(logFile);
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    await sync.tick();
    slack.refuse.activityMark = "unknown_method";
    expect(await threads.markRead(ACCOUNT, `C0GEN:${at(10)}`)).toMatchObject({ move: "read", ended: true });
    expect(slack.unread("a")).toBe(true);
    expect(open()).toEqual([]);
    expect(readFileSync(logFile, "utf8")).toContain("slack:activity-mark-failed");
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

  test("a DM read then undone stays through a tick that still sees it read, and ends at a read after a newer message", async () => {
    const { slack, threads, sync, open } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "first" });
    await sync.tick();
    const change = must(await threads.markRead(ACCOUNT, "D0GRACE"), "the read's change");
    expect(slack.lastRead("D0GRACE")).toBe(at(20));
    await threads.restore(ACCOUNT, "D0GRACE", change);
    await sync.tick();
    expect(open().map((r) => r.thread_id)).toEqual(["D0GRACE"]);
    slack.post("D0GRACE", { ts: at(40), user: "U0GRACE", text: "second" });
    await sync.tick();
    expect(open().map((r) => [r.thread_id, r.lines.at(-1)])).toEqual([["D0GRACE", "second"]]);
    slack.read("D0GRACE", at(40));
    await sync.tick();
    expect(open()).toEqual([]);
  });
});

describe("older unread items", () => {
  test("fill the workspace up to 20 open cards, newest first across windows; new items come past it (plan 078)", async () => {
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
    ).toEqual(["@Ada last-week", "@Ada recent-0", "@Ada recent-1", "@Ada recent-2", "@Ada recent-3", "@Ada recent-4", "from long ago"]);
    expect(must(accounts.get(ACCOUNT)).backfill).toMatchObject({ exhausted: true });

    await clear();
    await sync.tick();
    expect(open()).toEqual([]);
  });
  test("an item Slack no longer shows takes no room: the next batch fills past it, and it is not asked for again", async () => {
    const { slack, threads, sync, open } = await fixture();
    const mention = (key: string, seconds: number, posted = true) => {
      if (posted) slack.post("C0GEN", { ts: at(seconds), user: "U0GRACE", text: `<@U0ME> ${key}` });
      slack.item({ key, type: "at_user", channel: "C0GEN", ts: at(seconds) });
    };
    for (let i = 0; i < 20; i++) mention(`first-${String(i)}`, -DAY + 100 + i);
    for (let i = 0; i < 20; i++) mention(`deleted-${String(i)}`, -DAY + 50 + i, false);
    for (let i = 0; i < 5; i++) mention(`next-${String(i)}`, -DAY + i);

    await sync.tick();
    expect(open()).toHaveLength(20);
    for (const r of open()) await threads.markRead(ACCOUNT, r.thread_id);
    await sync.tick();
    expect(
      open()
        .map((r) => r.subject_or_first_line)
        .sort(),
    ).toEqual(["@Ada next-0", "@Ada next-1", "@Ada next-2", "@Ada next-3", "@Ada next-4"]);

    const asked = slack.sent.filter((s) => s.method === "conversations.history").length;
    await sync.tick();
    expect(slack.sent.filter((s) => s.method === "conversations.history")).toHaveLength(asked);
  });

  test("a Slack failure that passes leaves the backlog where it was, and the items come at the next good tick", async () => {
    const { slack, accounts, sync, open } = await fixture();
    for (let i = 0; i < 3; i++) {
      slack.post("C0GEN", { ts: at(-DAY + i), user: "U0GRACE", text: `<@U0ME> old-${String(i)}` });
      slack.item({ key: `old-${String(i)}`, type: "at_user", channel: "C0GEN", ts: at(-DAY + i) });
    }
    slack.post("C0GEN", { ts: at(30), user: "U0GRACE", text: "<@U0ME> live" });
    slack.item({ key: "live", type: "at_user", channel: "C0GEN", ts: at(30) });
    slack.refuse.history = "internal_error";
    await sync.tick();
    expect(open()).toEqual([]);
    expect(must(accounts.get(ACCOUNT)).backfill).toEqual({});
    slack.refuse.history = null;
    await sync.tick();
    expect(
      open()
        .map((r) => r.subject_or_first_line)
        .sort(),
    ).toEqual(["@Ada live", "@Ada old-0", "@Ada old-1", "@Ada old-2"]);
  });
});

describe("resting cards and the past's cap (plan 078)", () => {
  test("a resting card leaves the count, so older items take its room", async () => {
    const { slack, sync, open, resting } = await fixture();
    for (let i = 0; i < 25; i++) {
      slack.post("C0GEN", { ts: at(-DAY + i), user: "U0GRACE", text: `<@U0ME> m-${String(i)}` });
      slack.item({ key: `m-${String(i)}`, type: "at_user", channel: "C0GEN", ts: at(-DAY + i) });
    }
    await sync.tick();
    expect(open()).toHaveLength(20);
    for (const r of open().slice(0, 3)) resting.add(r.thread_id);
    await sync.tick();
    expect(open()).toHaveLength(23);
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

describe("a reply on a Slack card, then the key's move (plan 070, U5)", () => {
  const posts = (slack: ReturnType<typeof fakeWorkspace>) => slack.sent.filter((s) => s.method === "chat.postMessage");

  test("with later, the card stays through a tick that sees the DM read, and ends at a read after the other side writes", async () => {
    const { slack, sync, open, outside } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "Can you send the deck?" });
    await sync.tick();
    expect(await outside.reply(ACCOUNT, "D0GRACE", "By Friday.", "later")).toMatchObject({ sent: true, then_error: null, change: { ended: false } });
    await sync.tick();
    expect(open().map((r) => [r.thread_id, r.waiting])).toEqual([["D0GRACE", true]]);
    slack.post("D0GRACE", { ts: at(2000), user: "U0GRACE", text: "Thanks" });
    await sync.tick();
    expect(open().map((r) => [r.thread_id, r.lines.at(-1), r.waiting])).toEqual([["D0GRACE", "Thanks", false]]);
    slack.read("D0GRACE", at(2000));
    await sync.tick();
    expect(open()).toEqual([]);
  });

  test("with read or archive, the reply is sent and the card ends", async () => {
    const { slack, sync, open, outside } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "ping" });
    slack.dm("D0ALAN");
    slack.post("D0ALAN", { ts: at(30), user: "U0ALAN", text: "pong" });
    await sync.tick();
    expect(await outside.reply(ACCOUNT, "D0GRACE", "here", "read")).toMatchObject({ sent: true, change: { move: "read", ended: true } });
    expect(await outside.reply(ACCOUNT, "D0ALAN", "here", "archive")).toMatchObject({ sent: true, change: { move: "archive", ended: true } });
    expect(open()).toEqual([]);
    expect(posts(slack)).toHaveLength(2);
  });

  test("a sent reply whose archive fails says so, the card stays, and the archive tried again sends nothing more", async () => {
    const { slack, threads, sync, open, outside } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(20), user: "U0GRACE", text: "ping" });
    await sync.tick();
    slack.refuse.mark = "channel_not_found";
    const answer = await outside.reply(ACCOUNT, "D0GRACE", "on it", "archive");
    expect(answer).toMatchObject({ sent: true, change: null });
    expect(answer.sent && answer.then_error).toEqual(expect.any(String));
    expect(open().map((r) => r.thread_id)).toEqual(["D0GRACE"]);
    slack.refuse.mark = null;
    await threads.archive(ACCOUNT, "D0GRACE");
    expect(open()).toEqual([]);
    expect(posts(slack)).toHaveLength(1);
  });
});

describe("an old card's header", () => {
  test("a card from before plan 073 learns its channel and tag on the next tick, though no newer message came", async () => {
    const { slack, sync, threads } = await fixture();
    slack.post("C0GEN", { ts: at(10), user: "U0GRACE", text: "<@U0ME> can you check this" });
    slack.item({ key: "a", type: "at_user", channel: "C0GEN", ts: at(10) });
    const id = `C0GEN:${at(10)}`;
    threads.observe(ACCOUNT, {
      thread_id: id,
      message_id: at(10),
      at: new Date(Number(at(10)) * 1000).toISOString(),
      sender: "Grace Hopper",
      subject: "x",
      lines: ["x"],
    });
    expect(threads.get(ACCOUNT, id)).toMatchObject({ reach: null, place: null });
    await sync.tick();
    expect(threads.get(ACCOUNT, id)).toMatchObject({ reach: "mention", place: "#general", newest_message_id: at(10) });
  });
});

describe("what brought a card (plan 077, KTD2)", () => {
  test("two mentions in one thread bring the card, not the replies between them", async () => {
    const { slack, sync, threads } = await fixture();
    slack.post("C0ENG", { ts: at(5), user: "U0GRACE", text: "the plan" });
    slack.post("C0ENG", { ts: at(10), user: "U0ALAN", text: "<@U0ME> look", thread_ts: at(5) });
    slack.post("C0ENG", { ts: at(20), user: "U0GRACE", text: "agreed", thread_ts: at(5) });
    slack.post("C0ENG", { ts: at(30), user: "U0ALAN", text: "<@U0ME> and this", thread_ts: at(5) });
    slack.item({ key: "a", type: "at_user", channel: "C0ENG", ts: at(10), thread_ts: at(5) });
    slack.item({ key: "b", type: "at_user", channel: "C0ENG", ts: at(30), thread_ts: at(5) });
    await sync.tick();
    expect(threads.get(ACCOUNT, `C0ENG:${at(5)}`)?.brought_ids).toEqual([at(10), at(30)]);
  });

  test("a followed thread brings every reply by someone else, and none of the person's own", async () => {
    const { slack, sync, threads } = await fixture();
    slack.post("C0ENG", { ts: at(5), user: "U0ME", text: "my question" });
    slack.post("C0ENG", { ts: at(10), user: "U0ALAN", text: "one idea", thread_ts: at(5) });
    slack.post("C0ENG", { ts: at(20), user: "U0ME", text: "thanks", thread_ts: at(5) });
    slack.post("C0ENG", { ts: at(30), user: "U0GRACE", text: "another", thread_ts: at(5) });
    slack.item({ key: "d", type: "thread_v2", channel: "C0ENG", ts: at(30), thread_ts: at(5) });
    await sync.tick();
    expect(threads.get(ACCOUNT, `C0ENG:${at(5)}`)?.brought_ids).toEqual([at(10), at(30)]);
  });

  test("a thread of more than one page of replies shows its newest reply, and the next tick reads it no more", async () => {
    const { slack, sync, threads } = await fixture();
    slack.post("C0ENG", { ts: at(5), user: "U0GRACE", text: "the plan" });
    for (let i = 1; i <= 250; i++) slack.post("C0ENG", { ts: at(5 + i), user: "U0ALAN", text: `reply ${String(i)}`, thread_ts: at(5) });
    slack.item({ key: "d", type: "thread_v2", channel: "C0ENG", ts: at(255), thread_ts: at(5) });
    slack.item({ key: "m", type: "at_user", channel: "C0ENG", ts: at(240), thread_ts: at(5) });
    const replies = () => slack.sent.filter((s) => s.method === "conversations.replies").length;
    await sync.tick();
    expect(threads.get(ACCOUNT, `C0ENG:${at(5)}`)).toMatchObject({ newest_message_id: at(255), lines: ["reply 248", "reply 249", "reply 250"] });
    // Two pages, read once for both items of the thread.
    expect(replies()).toBe(2);
    await sync.tick();
    expect(replies()).toBe(2);
  });

  test("a DM brings nothing; its New line marks it", async () => {
    const { slack, sync, threads } = await fixture();
    slack.dm("D0GRACE");
    slack.post("D0GRACE", { ts: at(10), user: "U0GRACE", text: "Are you around?" });
    slack.item({ key: "k", type: "at_user", channel: "D0GRACE", ts: at(10) });
    await sync.tick();
    expect(threads.get(ACCOUNT, "D0GRACE")?.brought_ids).toEqual([]);
  });

  test("covers AE2: after the person dealt with the card, only a newer mention brings it back", async () => {
    const { slack, sync, threads, clock } = await fixture();
    slack.post("C0ENG", { ts: at(5), user: "U0GRACE", text: "the plan" });
    slack.post("C0ENG", { ts: at(8), user: "U0ALAN", text: "<@U0ME> look", thread_ts: at(5) });
    slack.post("C0ENG", { ts: at(12), user: "U0ALAN", text: "<@U0ME> again", thread_ts: at(5) });
    slack.item({ key: "a", type: "at_user", channel: "C0ENG", ts: at(8), thread_ts: at(5) });
    slack.item({ key: "b", type: "at_user", channel: "C0ENG", ts: at(12), thread_ts: at(5) });
    await sync.tick();
    const id = `C0ENG:${at(5)}`;
    expect(threads.markDealt(ACCOUNT, id)).toBe(true);
    slack.post("C0ENG", { ts: at(30), user: "U0GRACE", text: "<@U0ME> now this", thread_ts: at(5) });
    slack.item({ key: "c", type: "at_user", channel: "C0ENG", ts: at(30), thread_ts: at(5) });
    clock.t += 20 * 60_000;
    await sync.tick();
    expect(threads.get(ACCOUNT, id)?.brought_ids).toEqual([at(30)]);
  });
});
