import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideMessage, OutsideWindow } from "../core/frame-types.ts";
import type { ThreadControls } from "../app/src/desk/outside-card.tsx";
import type { SlackConversation, SlackMessage, SlackMessagePage, SlackUser } from "../mod/slack.ts";
import { slackChannelView, type CardFacts, type CardWindow } from "../mod/slack-view.ts";
import { must } from "./fixtures/must.ts";
import { SlackThread, planSlackRows } from "../app/src/desk/slack-thread.tsx";

/** A Slack card's body as a window around what is new (plan 076), and as Slack draws it (plan 074, plan 075). */

const ACCOUNT = "slack:T1:UME";

function msg(ts: string, user: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { ts, user, bot_id: null, text, thread_ts: null, subtype: null, reply_count: 0, raw: {}, ...extra };
}

/** Messages `from`..`to` seconds, one a second, as `<n>.000000`, from U2 unless `user` says. */
const run = (from: number, to: number, user = (_n: number) => "U2", extra: (n: number) => Partial<SlackMessage> = () => ({})) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(`${String(from + i)}.000000`, user(from + i), `m${String(from + i)}`, extra(from + i)));
const ts = (n: number) => `${String(n)}.000000`;

/**
 * A channel's history and its threads, answering as Slack does: history newest first, a limit, pages by cursor; a
 * thread's replies first message first, in pages of `limit` by cursor.
 */
function fakeSlack(opts: { history: SlackMessage[]; threads?: Record<string, SlackMessage[]>; last_read?: string | null; emoji?: Record<string, string> }) {
  const calls: string[] = [];
  const newestFirst = [...opts.history].sort((a, b) => Number(b.ts) - Number(a.ts));
  const client = {
    conversationsReplies: (o: { ts: string; limit?: number; cursor?: string }): Promise<SlackMessagePage> => {
      calls.push(`replies ${o.ts}${o.cursor ? ` ${o.cursor}` : ""}`);
      const all = opts.threads?.[o.ts] ?? [];
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 1000;
      const more = start + limit < all.length;
      return Promise.resolve({ messages: all.slice(start, start + limit), has_more: more, next_cursor: more ? String(start + limit) : null });
    },
    conversationsHistory: (o: { latest?: string; oldest?: string; inclusive?: boolean; limit?: number; cursor?: string }): Promise<SlackMessagePage> => {
      calls.push(`history ${o.oldest ? "after" : o.latest ? "before" : "latest"}${o.cursor ? ` ${o.cursor}` : ""}`);
      const inRange = newestFirst.filter(
        (m) => (!o.latest || Number(m.ts) < Number(o.latest) || (o.inclusive === true && m.ts === o.latest)) && (!o.oldest || Number(m.ts) > Number(o.oldest)),
      );
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 100;
      const page = inRange.slice(start, start + limit);
      const more = start + limit < inRange.length;
      return Promise.resolve({ messages: page, has_more: more, next_cursor: more ? String(start + limit) : null });
    },
    conversationsInfo: (channel: string): Promise<SlackConversation> =>
      Promise.resolve({
        id: channel,
        name: "crm-access",
        is_im: !channel.startsWith("C"),
        is_mpim: false,
        is_channel: channel.startsWith("C"),
        is_private: false,
        user: null,
        last_read: opts.last_read ?? null,
      }),
    emojiList: (): Promise<Record<string, string>> => Promise.resolve(opts.emoji ?? {}),
    usersInfo: (user: string): Promise<SlackUser> =>
      Promise.resolve({
        id: user,
        name: user,
        real_name: `Person ${user}`,
        display_name: "",
        is_bot: false,
        image: user === "U1" ? "https://example.test/u1.png" : "",
      }),
  };
  return { client, calls };
}

const facts = (brought: string[] = [], dealt: string | null = null): CardFacts => ({ dealt_message_id: dealt, brought_ids: brought });
const ids = (w: CardWindow) => w.messages.map((m) => m.id);
const flagged = (w: CardWindow, flag: "unread" | "brought") => w.messages.filter((m) => m[flag]).map((m) => m.id);

/** A thread of 40 replies, 1001..1040, under the post 1000. */
const forty = () => [msg(ts(1000), "U1", "the plan", { reply_count: 40 }), ...run(1001, 1040)];

describe("a thread card opens on its window (plan 076)", () => {
  test("covers AE1: the first message, then 5 replies either side of the one that brought it, with what is hidden counted", async () => {
    const { client } = fakeSlack({ history: [], threads: { [ts(1000)]: forty() } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1022)]), {});
    expect(ids(w)).toEqual([ts(1000), ...run(1017, 1027).map((m) => m.ts)]);
    expect(flagged(w, "brought")).toEqual([ts(1022)]);
    expect(flagged(w, "unread")).toEqual([ts(1022)]);
    expect(w.window).toEqual({ view: "thread", thread_ts: ts(1000), more_before: 16, more_after: 13 });
  });

  test("covers AE2: after the mark, only the newer mention is new; the earlier ones are context", async () => {
    const { client } = fakeSlack({ history: [], threads: { [ts(1000)]: forty() } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1030)], ts(1012)), {});
    expect(flagged(w, "unread")).toEqual([ts(1030)]);
    expect(w.messages.find((m) => m.id === ts(1012))).toBeUndefined();
  });

  test("covers AE5: loading earlier returns the replies before the first shown, and says when none are left", async () => {
    const { client } = fakeSlack({ history: [], threads: { [ts(1000)]: forty() } });
    const view = slackChannelView(() => client);
    const w = await view(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1012)]), { direction: "before", from: ts(1008) });
    expect(ids(w)).toEqual(run(1001, 1007).map((m) => m.ts));
    expect(w.window.more_before).toBe(0);
    const later = await view(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1012)]), { direction: "after", from: ts(1017) });
    expect(ids(later)).toEqual(run(1018, 1037).map((m) => m.ts));
    expect(later.window.more_after).toBe(3);
  });

  test("a thread longer than loki reads stops after five pages and says more came", async () => {
    const long = [msg(ts(1000), "U1", "busy"), ...run(1001, 2200)];
    const { client, calls } = fakeSlack({ history: [], threads: { [ts(1000)]: long } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1003)]), {});
    expect(calls.filter((c) => c.startsWith("replies"))).toHaveLength(5);
    expect(w.window.more_after).toBe(true);
  });

  test("the person's own messages are never new", async () => {
    const thread = [msg(ts(1000), "U1", "q"), msg(ts(1001), "UME", "mine"), msg(ts(1002), "U2", "yours")];
    const { client } = fakeSlack({ history: [], threads: { [ts(1000)]: thread } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1002)], ts(1000)), {});
    expect(w.messages.find((m) => m.id === ts(1001))).toMatchObject({ mine: true });
    expect(flagged(w, "unread")).toEqual([ts(1002)]);
  });
});

describe("a channel post and a DM open on their window (plan 076)", () => {
  test("covers AE3: a post that brought the card opens in the channel, with its new replies counted under it", async () => {
    const post = msg(ts(106), "U1", "@channel anyone with crm access?", { reply_count: 3 });
    const history = [...run(100, 105), post, ...run(107, 115)];
    const { client } = fakeSlack({ history, threads: { [ts(106)]: [post, ...run(201, 203)] } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(106)}`, facts([ts(106), ts(201), ts(202), ts(203)]), {});
    expect(w.window.view).toBe("channel");
    expect(ids(w)).toEqual([...run(101, 105), post, ...run(107, 111)].map((m) => m.ts));
    expect(w.messages.find((m) => m.id === ts(106))).toMatchObject({ brought: true, unread: true, new_replies: 3 });
    expect(w.window).toMatchObject({ more_before: true, more_after: true });
  });

  test("covers AE3: once only replies are new, the same card opens on the thread", async () => {
    const post = msg(ts(106), "U1", "@channel anyone?", { reply_count: 3 });
    const { client } = fakeSlack({ history: [post], threads: { [ts(106)]: [post, ...run(201, 203)] } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(106)}`, facts([ts(203)], ts(202)), {});
    expect(w.window).toMatchObject({ view: "thread", thread_ts: ts(106) });
  });

  test("covers AE4: a DM opens on 5 read messages, its unread run, and nothing to load after; nothing is highlighted", async () => {
    const history = run(1, 34, (n) => (n % 3 ? "U2" : "UME"));
    const { client } = fakeSlack({ history, last_read: ts(30) });
    const w = await slackChannelView(() => client)(ACCOUNT, "D1", facts([ts(32)]), {});
    expect(ids(w)).toEqual(run(26, 34).map((m) => m.ts));
    expect(flagged(w, "unread")).toEqual([ts(31), ts(32), ts(34)]);
    expect(flagged(w, "brought")).toEqual([]);
    expect(w.window).toMatchObject({ view: "channel", more_before: true, more_after: false });
  });

  test("a DM post whose thread has replies since the mark counts them; the person's own are not counted", async () => {
    const post = msg(ts(5), "U2", "parent", { reply_count: 2, raw: { latest_reply: ts(7) } });
    const history = [...run(1, 4), post, ...run(8, 9)];
    const { client } = fakeSlack({ history, threads: { [ts(5)]: [post, msg(ts(6), "UME", "mine"), msg(ts(7), "U2", "theirs")] }, last_read: ts(5) });
    const w = await slackChannelView(() => client)(ACCOUNT, "D1", facts(), {});
    expect(w.messages.find((m) => m.id === ts(5))).toMatchObject({ replies: 2, new_replies: 1 });
  });

  test("a channel load reads 20 more on one side; after, Slack is paged back from the newest", async () => {
    const { client, calls } = fakeSlack({ history: run(1, 300) });
    const view = slackChannelView(() => client);
    const before = await view(ACCOUNT, `C1:${ts(150)}`, facts([ts(150)]), { direction: "before", from: ts(100) });
    expect(ids(before)).toEqual(run(80, 99).map((m) => m.ts));
    expect(before.window.more_before).toBe(true);
    const after = await view(ACCOUNT, `C1:${ts(150)}`, facts([ts(150)]), { direction: "after", from: ts(100) });
    expect(ids(after)).toEqual(run(101, 120).map((m) => m.ts));
    expect(calls.filter((c) => c.startsWith("history after"))).toHaveLength(2);
  });

  test("a card from before plan 076 remembers nothing that brought it, so it opens on the channel with Slack's read marker", async () => {
    const post = msg(ts(106), "U1", "hello");
    const { client } = fakeSlack({ history: [...run(100, 105), post, ...run(107, 110)], threads: { [ts(106)]: [post] }, last_read: ts(105) });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(106)}`, facts(), {});
    expect(w.window.view).toBe("channel");
    expect(flagged(w, "unread")[0]).toBe(ts(106));
  });

  test("what brought the card before the person last dealt with it is plain, as after a reply sent with later", async () => {
    const { client } = fakeSlack({ history: [], threads: { [ts(1000)]: forty() } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1010), ts(1012)], ts(1012)), {});
    expect(flagged(w, "brought")).toEqual([]);
    expect(flagged(w, "unread")).toEqual([]);
  });

  test("a DM read on in Slack after loki's mark is new only after Slack's marker", async () => {
    const { client } = fakeSlack({ history: run(1, 40), last_read: ts(35) });
    const w = await slackChannelView(() => client)(ACCOUNT, "D1", facts([], ts(10)), {});
    expect(flagged(w, "unread")).toEqual(run(36, 40).map((m) => m.ts));
  });

  test("a channel with more after the post than loki reads says so in words and offers no load that cannot reach it", async () => {
    const post = msg(ts(1000), "U1", "the card");
    const { client } = fakeSlack({ history: [...run(990, 999), post, ...run(1001, 1400)], threads: { [ts(1000)]: [post] } });
    const w = await slackChannelView(() => client)(ACCOUNT, `C1:${ts(1000)}`, facts([ts(1000)]), {});
    expect(w.window.more_after).toBe(false);
    expect(w.messages.at(-1)?.more_after).toBe(true);
  });

  test("people are asked about once per account, across cards", async () => {
    const { client } = fakeSlack({ history: [msg(ts(1), "U1", "hi")], threads: { [ts(1)]: [msg(ts(1), "U1", "hi")] } });
    let asked = 0;
    const counted = { ...client, usersInfo: (u: string) => (asked++, client.usersInfo(u)) };
    const view = slackChannelView(() => counted);
    await view(ACCOUNT, `C1:${ts(1)}`, facts(), {});
    await view(ACCOUNT, `C1:${ts(1)}`, facts(), {});
    expect(asked).toBe(1);
  });

  test("messages come read as Slack draws them, and the workspace's emoji are asked for once per account", async () => {
    const one = msg(ts(1), "U1", ":shipit: <https://x.test|the doc>", { raw: { attachments: [{ title: "PR", title_link: "https://x.test/pr" }] } });
    const { client } = fakeSlack({ history: [one], threads: { [ts(1)]: [one] }, emoji: { shipit: "https://emoji.example.test/shipit.png" } });
    let asked = 0;
    const counted = { ...client, emojiList: () => (asked++, client.emojiList()) };
    const view = slackChannelView(() => counted);
    const { messages } = await view(ACCOUNT, `C1:${ts(1)}`, facts(), {});
    await view(ACCOUNT, `C1:${ts(1)}`, facts(), {});
    const m = must(messages.find((x) => x.id === ts(1)));
    expect(asked).toBe(1);
    expect(m.avatar).toBe("https://example.test/u1.png");
    expect(m.body?.[0].spans[0]).toEqual({ kind: "emoji", text: ":shipit:", image: "https://emoji.example.test/shipit.png" });
    expect(m.attachments?.[0].title).toEqual([{ kind: "link", text: "PR", url: "https://x.test/pr" }]);
    expect(m.text).toBe(":shipit: the doc (https://x.test)\nPR (https://x.test/pr)");
  });
});

describe("drawing a Slack card's body", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 6, 9, min)).toISOString();
  const m = (id: string, sender: string, min: number, extra: Partial<OutsideMessage> = {}): OutsideMessage => ({
    id,
    sender,
    at: at(min),
    text: id,
    mine: false,
    ...extra,
  });

  test("one person's messages close together share a face; a new person, a gap, the New line or the thread start a run", () => {
    const rows = [
      m("a", "Ravi", 0),
      m("b", "Ravi", 2),
      m("c", "Ravi", 20),
      m("d", "Neha", 21),
      m("e", "Neha", 22, { unread: true }),
      m("f", "Neha", 23, { in_thread: true }),
    ];
    const plan = planSlackRows(rows, Date.UTC(2026, 10, 6, 12));
    expect(plan.map((p) => p.first)).toEqual([true, false, true, true, true, true]);
    expect(plan.map((p) => p.divider)).toEqual([false, false, false, false, true, false]);
    expect(plan[0].day).toBe("Today");
  });

  test("day pills come from the channel's messages only; a reply on a later day shows that day by its time", () => {
    const day = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
    const rows: OutsideMessage[] = [
      { id: "a", sender: "Ravi", at: day(3, 9), text: "a", mine: false },
      { id: "b", sender: "Neha", at: day(4, 9), text: "b", mine: false, in_thread: true },
      { id: "c", sender: "Neha", at: day(5, 9), text: "c", mine: false, in_thread: true },
      { id: "d", sender: "Ravi", at: day(3, 10), text: "d", mine: false },
    ];
    const plan = planSlackRows(rows, Date.UTC(2026, 10, 6, 12));
    expect(plan.map((p) => p.day)).toEqual(["Tuesday", null, null, null]);
    expect(plan.map((p) => p.dayNote)).toEqual([null, "Wednesday", "Yesterday", "Tuesday"]);
    expect(plan.every((p) => p.first)).toBe(true);
  });

  test("a message's blocks are drawn: links, bold, quotes, code, emoji images and an app's attachment", () => {
    const html = renderToStaticMarkup(
      createElement(SlackThread, {
        messages: [
          m("a", "Shipyard", 0, {
            body: [
              {
                kind: "text",
                spans: [
                  { kind: "text", text: "done", bold: true },
                  { kind: "link", text: "PR", url: "https://x.test/pr", bold: true },
                  { kind: "link", text: "app", url: "slack://open" },
                  { kind: "emoji", text: ":shipit:", image: "https://emoji.example.test/shipit.png" },
                ],
              },
              { kind: "quote", spans: [{ kind: "text", text: "quoted" }] },
              { kind: "code", spans: [{ kind: "text", text: "npm test", code: true }] },
            ],
            attachments: [{ title: [{ kind: "text", text: "Build", bold: true }], color: "#2eb886" }],
          }),
        ],
        newest: "a",
      }),
    );
    expect(html).toContain("<strong>done</strong>");
    expect(html).toContain('<strong><a class="loki-mail-link" href="https://x.test/pr"');
    expect(html).not.toContain("slack://open");
    expect(html).toContain('<img class="loki-emoji" src="https://emoji.example.test/shipit.png"');
    expect(html).toContain('<blockquote class="loki-slack-quote">quoted</blockquote>');
    expect(html).toContain('<pre class="loki-slack-pre">npm test</pre>');
    expect(html).toContain('style="border-left-color:#2eb886"');
  });

  test("@channel is marked, replies are indented, and a message's thread says how many replies it has", () => {
    const html = renderToStaticMarkup(
      createElement(SlackThread, {
        messages: [m("a", "Ravi", 0, { text: "@channel who has access?", replies: 3 }), m("b", "Neha", 1, { in_thread: true, more_after: true })],
        newest: "a",
      }),
    );
    expect(html).toContain('<span class="loki-mention">@channel</span>');
    expect(html).toContain("3 replies");
    expect(html).toContain('class="loki-slack-reply"');
    expect(html).toContain("more messages in the channel since");
  });

  const controls: ThreadControls = { load: () => {}, openThread: () => {}, busy: null };
  const draw = (messages: OutsideMessage[], window: OutsideWindow, more: Partial<ThreadControls> = {}) =>
    renderToStaticMarkup(createElement(SlackThread, { messages, newest: messages.at(-1)?.id ?? "", window, controls: { ...controls, ...more } }));

  test("covers AE1: a thread view pins its first message, then counts the hidden replies on each side", () => {
    const html = draw([m("root", "Ravi", 0), m("r17", "Neha", 1), m("r22", "Neha", 2, { unread: true, brought: true })], {
      view: "thread",
      thread_ts: "root",
      more_before: 16,
      more_after: 13,
    });
    expect(html.indexOf("root")).toBeLessThan(html.indexOf("16 earlier replies"));
    expect(html.indexOf("16 earlier replies")).toBeLessThan(html.indexOf("r17"));
    expect(html).toContain("13 later replies");
  });

  test("covers AE2: a message that brought the card has the mention look; one that is only new does not", () => {
    const html = draw([m("a", "Ravi", 0, { unread: true }), m("b", "Neha", 9, { unread: true, brought: true })], {
      view: "channel",
      thread_ts: null,
      more_before: false,
      more_after: false,
    });
    expect(html.match(/loki-slack-brought/g)).toHaveLength(1);
    expect(html.indexOf("loki-slack-brought")).toBeGreaterThan(html.indexOf(">a<"));
  });

  test("covers AE4, AE5: with nothing more on a side there is no button; a channel or DM button carries no count", () => {
    const html = draw([m("a", "Ravi", 0, { unread: true })], { view: "channel", thread_ts: null, more_before: true, more_after: false });
    expect(html).toContain("load earlier");
    expect(html).not.toContain("load later");
    expect(html).not.toContain("loki-slack-brought");
    const none = draw([m("a", "Ravi", 0)], { view: "thread", thread_ts: "x", more_before: 0, more_after: 0 });
    expect(none).not.toContain("loki-slack-load");
  });

  test("covers AE3: a post with new replies offers to open them, and a thread opened from the channel offers the way back", () => {
    const html = draw([m("p", "Ravi", 0, { replies: 3, new_replies: 3 })], { view: "channel", thread_ts: null, more_before: false, more_after: false });
    expect(html).toContain("3 new replies");
    expect(html).not.toContain("back to the conversation");
    const back = draw([m("p", "Ravi", 0)], { view: "thread", thread_ts: "p", more_before: 0, more_after: 0 }, { back: () => {} });
    expect(back).toContain("back to the conversation");
  });

  test("a load in flight says so on its button and holds both", () => {
    const html = draw([m("a", "Ravi", 0)], { view: "channel", thread_ts: null, more_before: true, more_after: true }, { busy: "before" });
    expect(html).toContain("loading…");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
