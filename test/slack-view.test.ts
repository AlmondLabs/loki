import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideMessage } from "../core/frame-types.ts";
import type { SlackConversation, SlackMessage, SlackMessagePage, SlackUser } from "../mod/slack.ts";
import { slackChannelView } from "../mod/slack-view.ts";
import { SlackThread, planSlackRows } from "../app/src/desk/slack-thread.tsx";

/** A Slack card's body as the channel shows it (plan 074): the messages before and after the card's thread. */

const ACCOUNT = "slack:T1:UME";

function msg(ts: string, user: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { ts, user, bot_id: null, text, thread_ts: null, subtype: null, reply_count: 0, raw: {}, ...extra };
}

/** A channel's history and one thread, answering as Slack does: history newest first, a limit, and pages by cursor. */
function fakeSlack(opts: { history: SlackMessage[]; thread: SlackMessage[]; last_read?: string | null }) {
  const calls: string[] = [];
  const newestFirst = [...opts.history].sort((a, b) => Number(b.ts) - Number(a.ts));
  const client = {
    conversationsReplies: ({ ts }: { ts: string }): Promise<SlackMessagePage> => {
      calls.push(`replies ${ts}`);
      return Promise.resolve({ messages: opts.thread, has_more: false, next_cursor: null });
    },
    conversationsHistory: (o: { latest?: string; oldest?: string; inclusive?: boolean; limit?: number; cursor?: string }): Promise<SlackMessagePage> => {
      calls.push(`history ${o.oldest ? "after" : o.latest ? "before" : "latest"}${o.cursor ? ` ${o.cursor}` : ""}`);
      const inRange = newestFirst.filter((m) => (!o.latest || Number(m.ts) < Number(o.latest)) && (!o.oldest || Number(m.ts) > Number(o.oldest)));
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
        is_im: false,
        is_mpim: false,
        is_channel: true,
        is_private: false,
        user: null,
        last_read: opts.last_read ?? null,
      }),
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

describe("reading a Slack card as its channel shows it", () => {
  test("a channel message comes with the five before it, its replies under it and the five after it", async () => {
    const history = Array.from({ length: 12 }, (_, i) => msg(`${100 + i}.000000`, i % 2 ? "U1" : "U2", `m${i}`));
    const thread = [msg("106.000000", "U1", "@channel anyone with crm access?", { reply_count: 1 }), msg("106.500000", "U2", "me")];
    const { client } = fakeSlack({ history, thread, last_read: "105.000000" });
    const view = slackChannelView(() => client);
    const out = await view(ACCOUNT, "C1:106.000000");
    expect(out.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m5", "@channel anyone with crm access?", "me", "m7", "m8", "m9", "m10", "m11"]);
    expect(out.filter((m) => m.in_thread).map((m) => m.id)).toEqual(["106.500000"]);
    expect(out[0].avatar).toBe("https://example.test/u1.png");
    expect(out.find((m) => m.text === "m4")?.unread).toBeUndefined();
    expect(out.find((m) => m.id === "106.000000")?.unread).toBe(true);
    expect(out.at(-1)?.more_after).toBeUndefined();
  });

  test("a busy channel is paged back to the messages right after, and past three pages shows none and says more came", async () => {
    const thread = [msg("1000.000000", "U1", "the card")];
    const busy = (n: number) => [msg("999.000000", "U2", "before"), ...Array.from({ length: n }, (_, i) => msg(`${1001 + i}.000000`, "U2", `after ${i}`))];
    const near = fakeSlack({ history: busy(250), thread });
    const out = await slackChannelView(() => near.client)(ACCOUNT, "C1:1000.000000");
    expect(out.slice(-5).map((m) => m.text)).toEqual(["after 0", "after 1", "after 2", "after 3", "after 4"]);
    expect(out.at(-1)?.more_after).toBe(true);
    expect(near.calls.filter((c) => c.startsWith("history after"))).toHaveLength(3);
    const far = fakeSlack({ history: busy(400), thread });
    const farOut = await slackChannelView(() => far.client)(ACCOUNT, "C1:1000.000000");
    expect(farOut.map((m) => m.text)).toEqual(["before", "the card"]);
    expect(farOut.at(-1)?.more_after).toBe(true);
  });

  test("people are asked about once per account, across cards", async () => {
    const { client } = fakeSlack({ history: [], thread: [msg("1.000000", "U1", "hi")] });
    let asked = 0;
    const counted = { ...client, usersInfo: (u: string) => (asked++, client.usersInfo(u)) };
    const view = slackChannelView(() => counted);
    await view(ACCOUNT, "C1:1.000000");
    await view(ACCOUNT, "C1:1.000000");
    expect(asked).toBe(1);
  });

  test("the person's own messages are never unread", async () => {
    const { client } = fakeSlack({ history: [], thread: [msg("5.000000", "UME", "mine")], last_read: "1.000000" });
    const out = await slackChannelView(() => client)(ACCOUNT, "C1:5.000000");
    expect(out[0]).toMatchObject({ mine: true });
    expect(out[0].unread).toBeUndefined();
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
});
