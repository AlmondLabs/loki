import { describe, expect, test } from "vitest";
import type { AccountStatus } from "../core/frame-types.ts";
import { SlackClient, SlackError, uploadTimeoutMs } from "../mod/slack.ts";
import type { SlackSession } from "../mod/slack-session.ts";

/** A session as the desktop app gives it; every value is made up. */
const SESSION: SlackSession = {
  team_id: "T0ACME",
  team_name: "Acme",
  url: "https://acme.slack.com/",
  user_id: "U0ME",
  token: "xoxc-acme-1111",
  cookie: "xoxd-fixture+cookie/value==",
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  params: Record<string, string>;
}

/** A fake Slack: each request is recorded and answered by `answer`, by method name. */
function fakeSlack(answer: (method: string, params: Record<string, string>) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const params = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
    const method = url.slice(url.lastIndexOf("/") + 1);
    sent.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, params });
    const a = answer(method, params);
    return Promise.resolve(new Response(JSON.stringify(a.body ?? { ok: true }), { status: a.status ?? 200, headers: a.headers }));
  };
  return { sent, fetch: fetchFn };
}

/** A client over a fake Slack, a session provider that counts fresh reads, a status log and a clock the test moves. */
function client(answer: Parameters<typeof fakeSlack>[0], sessions: { stale?: SlackSession | null; fresh?: SlackSession | null } = {}) {
  const slack = fakeSlack(answer);
  const statuses: AccountStatus[] = [];
  const reads: boolean[] = [];
  const clock = { t: Date.parse("2026-11-04T10:00:00Z") };
  const c = new SlackClient({
    session: (fresh) => {
      reads.push(fresh);
      return Promise.resolve(fresh ? (sessions.fresh === undefined ? SESSION : sessions.fresh) : sessions.stale === undefined ? SESSION : sessions.stale);
    },
    setStatus: (s) => statuses.push(s),
    fetch: slack.fetch,
    now: () => new Date(clock.t),
  });
  return { c, sent: slack.sent, statuses, reads, clock };
}

describe("a call with the desktop session", () => {
  test("POSTs form-encoded to the workspace's own address with the token and the d cookie", async () => {
    const { c, sent } = client(() => ({ body: { ok: true, team_id: "T0ACME", team: "Acme", user_id: "U0ME", user: "me", url: "https://acme.slack.com/" } }));
    expect(await c.authTest()).toEqual({ team_id: "T0ACME", team: "Acme", user_id: "U0ME", user: "me", url: "https://acme.slack.com/" });
    expect(sent).toEqual([
      {
        url: "https://acme.slack.com/api/auth.test",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: "d=xoxd-fixture%2Bcookie%2Fvalue%3D%3D", origin: "https://app.slack.com" },
        params: { token: "xoxc-acme-1111" },
      },
    ]);
  });

  test("a workspace address off slack.com sends its calls to slack.com, so the token never leaves Slack", async () => {
    const { c, sent } = client(() => ({}), { stale: { ...SESSION, url: "https://acme.example.com/" } });
    await c.authTest();
    expect(sent[0]?.url).toBe("https://slack.com/api/auth.test");
  });
});

describe("a refused session", () => {
  test("is read afresh once, and the call goes through with the new one", async () => {
    const renewed = { ...SESSION, token: "xoxc-renewed" };
    const { c, sent, statuses, reads } = client(
      (_, p) => (p.token === "xoxc-renewed" ? { body: { ok: true, user_id: "U0ME" } } : { body: { ok: false, error: "invalid_auth" } }),
      {
        fresh: renewed,
      },
    );
    expect((await c.authTest()).user_id).toBe("U0ME");
    expect(reads).toEqual([false, true]);
    expect(sent.map((s) => s.params.token)).toEqual(["xoxc-acme-1111", "xoxc-renewed"]);
    expect(statuses).toEqual([]);
  });

  test("refused again after the re-read marks the account Slack signed out", async () => {
    const { c, sent, statuses, reads } = client(() => ({ body: { ok: false, error: "token_revoked" } }));
    const failure = await c.clientCounts().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SlackError);
    expect(failure).toMatchObject({ code: "signed_out" });
    expect(reads).toEqual([false, true]);
    expect(sent).toHaveLength(2);
    expect(statuses).toEqual([{ disconnected: "slack_signed_out" }]);
  });

  test("a workspace the desktop app is no longer signed in to marks the account signed out without a second call", async () => {
    const { c, sent, statuses } = client(() => ({ body: { ok: false, error: "not_authed" } }), { fresh: null });
    await expect(c.authTest()).rejects.toMatchObject({ code: "signed_out" });
    expect(sent).toHaveLength(1);
    expect(statuses).toEqual([{ disconnected: "slack_signed_out" }]);
  });

  test("other errors are the caller's, and leave the account connected", async () => {
    const { c, statuses, reads } = client(() => ({ body: { ok: false, error: "channel_not_found" } }));
    await expect(c.conversationsInfo("C0NOPE")).rejects.toMatchObject({ code: "channel_not_found" });
    expect(reads).toEqual([false]);
    expect(statuses).toEqual([]);
  });
});

describe("a rate limit", () => {
  test("holds calls back for Retry-After without marking the account disconnected", async () => {
    let limited = true;
    const { c, sent, statuses, clock } = client(() =>
      limited ? { status: 429, headers: { "retry-after": "30" }, body: { ok: false, error: "ratelimited" } } : {},
    );
    await expect(c.clientCounts()).rejects.toMatchObject({ code: "ratelimited", retryAfterMs: 30_000 });
    limited = false;
    clock.t += 10_000;
    await expect(c.clientCounts()).rejects.toMatchObject({ code: "ratelimited", retryAfterMs: 20_000 });
    expect(sent).toHaveLength(1);
    clock.t += 21_000;
    await c.clientCounts();
    expect(sent).toHaveLength(2);
    expect(statuses).toEqual([]);
  });

  test("holds back only the method Slack refused, so a busy Activity feed does not stop a thread being read", async () => {
    const { c, sent } = client((method) =>
      method === "activity.feed"
        ? { status: 429, headers: { "retry-after": "30" }, body: { ok: false, error: "ratelimited" } }
        : { body: { ok: true, messages: [], has_more: false } },
    );
    await expect(c.activityFeed({ unreadOnly: true, types: ["at_user"], limit: 50 })).rejects.toMatchObject({ code: "ratelimited" });
    await c.conversationsReplies({ channel: "C1", ts: "1.0" });
    expect(sent.map((s) => s.url.slice(s.url.lastIndexOf("/") + 1))).toEqual(["activity.feed", "conversations.replies"]);
    await expect(c.activityFeed({ unreadOnly: true, types: ["at_user"], limit: 50 })).rejects.toMatchObject({ code: "ratelimited" });
    expect(sent).toHaveLength(2);
  });
});

describe("marking a DM read", () => {
  const kinds: Record<string, Record<string, unknown>> = {
    D0DM: { id: "D0DM", is_im: true, user: "U0YOU" },
    C0MPIM: { id: "C0MPIM", is_mpim: true, is_private: true },
    C0CHAN: { id: "C0CHAN", is_channel: true, name: "general" },
    G0PRIV: { id: "G0PRIV", is_channel: false, is_private: true, name: "secret" },
  };
  const answer = (method: string, p: Record<string, string>) => (method === "conversations.info" ? { body: { ok: true, channel: kinds[p.channel] } } : {});

  test("marks a DM and a group DM", async () => {
    const { c, sent } = client(answer);
    await c.markDm("D0DM", "1700000000.000100");
    await c.markDm("C0MPIM", "1700000000.000200");
    expect(sent.filter((s) => s.url.endsWith("conversations.mark")).map((s) => s.params)).toEqual([
      { token: "xoxc-acme-1111", channel: "D0DM", ts: "1700000000.000100" },
      { token: "xoxc-acme-1111", channel: "C0MPIM", ts: "1700000000.000200" },
    ]);
  });

  test("refuses a channel or private channel, and marks nothing", async () => {
    const { c, sent } = client(answer);
    await expect(c.markDm("C0CHAN", "1")).rejects.toMatchObject({ code: "not_a_dm" });
    await expect(c.markDm("G0PRIV", "1")).rejects.toMatchObject({ code: "not_a_dm" });
    expect(sent.some((s) => s.url.endsWith("conversations.mark"))).toBe(false);
  });
});

describe("what the client reads", () => {
  test("the Activity feed: unread mentions and thread replies, with where each points", async () => {
    const { c, sent } = client(() => ({
      body: {
        ok: true,
        items: [
          {
            is_unread: true,
            feed_ts: "1700000100.000000",
            key: "at_user.1",
            item: { type: "at_user", message: { ts: "1700000099.000100", channel: "C0CHAN", author_user_id: "U0YOU" } },
          },
          {
            is_unread: true,
            feed_ts: "1700000200.000000",
            key: "thread_v2.2",
            item: {
              type: "thread_v2",
              bundle_info: { payload: { thread_entry: { channel_id: "C0CHAN", thread_ts: "1700000000.000001", latest_ts: "1700000199.000001" } } },
            },
          },
        ],
        response_metadata: { next_cursor: "next-page" },
      },
    }));
    const page = await c.activityFeed({ unreadOnly: true, cursor: "this-page" });
    expect(sent[0]?.params).toEqual({
      token: "xoxc-acme-1111",
      types: "at_user,at_user_group,at_channel,at_everyone,thread_v2",
      mode: "chrono_reads_and_unreads",
      unread_only: "true",
      archive_only: "false",
      priority_only: "false",
      limit: "50",
      cursor: "this-page",
    });
    expect(page.next_cursor).toBe("next-page");
    expect(page.items.map(({ item: _item, ...rest }) => rest)).toEqual([
      {
        key: "at_user.1",
        feed_ts: "1700000100.000000",
        is_unread: true,
        type: "at_user",
        channel: "C0CHAN",
        ts: "1700000099.000100",
        thread_ts: null,
        author_user_id: "U0YOU",
      },
      {
        key: "thread_v2.2",
        feed_ts: "1700000200.000000",
        is_unread: true,
        type: "thread_v2",
        channel: "C0CHAN",
        ts: "1700000199.000001",
        thread_ts: "1700000000.000001",
        author_user_id: null,
      },
    ]);
  });

  test("client.counts: DMs, group DMs, channels and threads", async () => {
    const { c } = client(() => ({
      body: {
        ok: true,
        ims: [{ id: "D0DM", has_unreads: true, mention_count: 1, latest: "2.0", last_read: "1.0" }],
        mpims: [{ id: "C0MPIM", has_unreads: false, mention_count: 0 }],
        channels: [],
        threads: { has_unreads: true, mention_count: 2 },
      },
    }));
    expect(await c.clientCounts()).toEqual({
      ims: [{ id: "D0DM", has_unreads: true, mention_count: 1, latest: "2.0", last_read: "1.0" }],
      mpims: [{ id: "C0MPIM", has_unreads: false, mention_count: 0, latest: null, last_read: null }],
      channels: [],
      threads: { has_unreads: true, mention_count: 2 },
    });
  });

  test("a draft reply in a thread is written to that thread, and drafts.list reads its text back", async () => {
    const { c, sent } = client((method) =>
      method === "drafts.create"
        ? { body: { ok: true, draft: { id: "Dr1", destinations: [{ channel_id: "D0DM", thread_ts: "1.0" }], blocks: [], last_updated_ts: "3.0" } } }
        : {
            body: {
              ok: true,
              drafts: [
                {
                  id: "Dr1",
                  destinations: [{ channel_id: "D0DM" }],
                  blocks: [
                    {
                      type: "rich_text",
                      elements: [
                        {
                          type: "rich_text_section",
                          elements: [
                            { type: "text", text: "hi " },
                            { type: "user", user_id: "U0YOU" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
    );
    expect((await c.draftsCreate({ channel: "D0DM", thread_ts: "1.0", text: "sounds good" })).id).toBe("Dr1");
    const params = sent[0]?.params ?? {};
    expect(JSON.parse(params.destinations)).toEqual([{ channel_id: "D0DM", thread_ts: "1.0", broadcast: false }]);
    expect(JSON.parse(params.blocks)).toEqual([
      { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "sounds good" }] }] },
    ]);
    expect(await c.draftsList()).toEqual([
      { id: "Dr1", text: "hi <@U0YOU>", destinations: [{ channel_id: "D0DM", thread_ts: null }], last_updated_ts: null, date_created: null },
    ]);
    expect(sent[1]?.params.is_active).toBe("true");
  });

  test("a draft is taken away by its id, as replacing one does", async () => {
    const { c, sent } = client(() => ({ body: { ok: true } }));
    await c.draftsDelete("Dr1");
    expect(sent.map((s) => [new URL(s.url).pathname, s.params.draft_id])).toEqual([["/api/drafts.delete", "Dr1"]]);
  });
});

describe("the workspace's people and mentions in a reply (plan 082)", () => {
  test("a page of people with the next page's cursor; people who left are left out and Slackbot is a bot", async () => {
    const { c, sent } = client(() => ({
      body: {
        ok: true,
        members: [
          { id: "U1", name: "ravi.kumar", real_name: "Ravi Kumar", profile: { display_name: "Ravi", image_72: "https://example.test/r.png" } },
          { id: "U2", name: "gone", deleted: true, profile: {} },
          { id: "USLACKBOT", name: "slackbot", profile: {} },
        ],
        response_metadata: { next_cursor: "dXNlcjpVMg==" },
      },
    }));
    const page = await c.usersList(null);
    expect(page.users.map((u) => [u.id, u.name, u.display_name, u.is_bot])).toEqual([
      ["U1", "ravi.kumar", "Ravi", false],
      ["USLACKBOT", "slackbot", "", true],
    ]);
    expect(page.next_cursor).toBe("dXNlcjpVMg==");
    expect(sent[0]?.params).toMatchObject({ limit: "200" });
    await c.usersList("dXNlcjpVMg==");
    expect(sent[1]?.params.cursor).toBe("dXNlcjpVMg==");
  });

  test("a reply's known @handles go as Slack's mentions, the rest of its words escaped as typed", async () => {
    const { c, sent } = client(() => ({ body: { ok: true, ts: "1.0" } }));
    await c.postReply({ channel: "D1", text: "@ravi.kumar <b> & @nobody, ask ravi@example.test", mentions: new Map([["ravi.kumar", "U1"]]) });
    expect(sent[0]?.params.text).toBe("<@U1> &lt;b&gt; &amp; @nobody, ask ravi@example.test");
  });
});

describe("the person's most-used emoji (plan 084)", () => {
  test("read from Slack's own counts, most used first; none when Slack keeps none or garbles them", async () => {
    const counts = (use: unknown) => client(() => ({ body: { ok: true, prefs: { emoji_use: use } } })).c.frequentEmoji();
    expect(await counts(JSON.stringify({ eyes: 3, "100": 9, "+1::skin-tone-2": 5, broken: "x", zero: 0 }))).toEqual(["100", "+1::skin-tone-2", "eyes"]);
    expect(await counts({ pray: 2 })).toEqual(["pray"]);
    expect(await counts(undefined)).toEqual([]);
    expect(await counts("{not json")).toEqual([]);
  });
});

describe("the person's reactions (plan 079)", () => {
  test("a reaction is added or taken back on its message; one already there, or already gone, is what was asked", async () => {
    const { c, sent } = client((method) => (method === "reactions.add" ? { body: { ok: false, error: "already_reacted" } } : { body: { ok: true } }));
    await c.react({ channel: "C0GEN", ts: "1.0", name: "eyes", on: true });
    await c.react({ channel: "C0GEN", ts: "1.0", name: "eyes", on: false });
    expect(sent.map((s) => [new URL(s.url).pathname, s.params.channel, s.params.timestamp, s.params.name])).toEqual([
      ["/api/reactions.add", "C0GEN", "1.0", "eyes"],
      ["/api/reactions.remove", "C0GEN", "1.0", "eyes"],
    ]);
  });

  test("any other refusal is the reaction's failure", async () => {
    const { c } = client(() => ({ body: { ok: false, error: "message_not_found" } }));
    await expect(c.react({ channel: "C0GEN", ts: "1.0", name: "eyes", on: true })).rejects.toMatchObject({ code: "message_not_found" });
  });
});

describe("a shared picture's thumbnail (plan 080)", () => {
  const THUMB = "https://files.slack.com/files-tmb/T0ACME-F1-abc/photo_360.png";
  /** A client whose fetch answers every address with `answer`, recording what was asked and with which headers. */
  const thumbs = (answer: () => Response, session: SlackSession | null = SESSION) => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    const statuses: AccountStatus[] = [];
    const c = new SlackClient({
      session: () => Promise.resolve(session),
      setStatus: (s) => statuses.push(s),
      fetch: (input, init) => {
        asked.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return Promise.resolve(answer());
      },
    });
    return { c, asked, statuses };
  };

  test("a thumbnail on files.slack.com is fetched as the person", async () => {
    const { c, asked } = thumbs(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    expect(await c.fileThumb(THUMB)).toEqual({ data: Buffer.from([1, 2, 3]), type: "image/png" });
    expect(asked).toEqual([{ url: THUMB, headers: { authorization: `Bearer ${SESSION.token}`, cookie: `d=${encodeURIComponent(SESSION.cookie)}` } }]);
  });

  test("an address anywhere else is never asked, so the session goes nowhere else", async () => {
    const { c, asked } = thumbs(() => new Response(""));
    expect(await c.fileThumb("https://files.slack.com.example.test/x.png")).toBeNull();
    expect(await c.fileThumb("http://files.slack.com/x.png")).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a refusal or a page that is not a picture is no thumbnail, and the account stays connected", async () => {
    const refused = thumbs(() => new Response("", { status: 403 }));
    expect(await refused.c.fileThumb(THUMB)).toBeNull();
    expect(refused.statuses).toEqual([]);
    const page = thumbs(() => new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }));
    expect(await page.c.fileThumb(THUMB)).toBeNull();
    expect(await thumbs(() => new Response(""), null).c.fileThumb(THUMB)).toBeNull();
  });
});

describe("a reply with files (plan 2026-11-14-1134, U3)", () => {
  interface Asked {
    url: string;
    headers: Record<string, string>;
    params: Record<string, string>;
    bytes: number[] | null;
  }
  /** A fake Slack that hands out an upload address per file and records every request, its form or its bytes. */
  const uploads = (opts: { uploadUrl?: (n: number) => string; complete?: { ok: boolean; error?: string } } = {}) => {
    const asked: Asked[] = [];
    let n = 0;
    const c = new SlackClient({
      session: () => Promise.resolve(SESSION),
      setStatus: () => undefined,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = init?.body;
        asked.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
          params: typeof body === "string" ? Object.fromEntries(new URLSearchParams(body)) : {},
          bytes: ArrayBuffer.isView(body) ? Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) : null,
        });
        if (url.endsWith("/api/files.getUploadURLExternal")) {
          n++;
          const uploadUrl = opts.uploadUrl?.(n) ?? `https://files.slack.com/upload/v1/up${n}`;
          return Promise.resolve(Response.json({ ok: true, upload_url: uploadUrl, file_id: `F${n}` }));
        }
        if (url.endsWith("/api/files.completeUploadExternal")) return Promise.resolve(Response.json(opts.complete ?? { ok: true, files: [] }));
        // The upload address answers with plain text, not JSON.
        return Promise.resolve(new Response("OK - 3"));
      },
    });
    return { c, asked };
  };
  const FILES = [
    { name: "plan.pdf", data: new Uint8Array([1, 2, 3]) },
    { name: "notes <draft>.txt", data: new Uint8Array([4, 5]) },
  ];

  test("each file is uploaded to files.slack.com as the person, then one completion posts the text in the thread", async () => {
    const { c, asked } = uploads();
    await c.postWithFiles({
      channel: "C0GEN",
      thread_ts: "1.0",
      text: "@ravi.kumar see <these> & those",
      mentions: new Map([["ravi.kumar", "U1"]]),
      files: FILES,
    });
    expect(asked.map((a) => a.url)).toEqual([
      "https://acme.slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/up1",
      "https://acme.slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/up2",
      "https://acme.slack.com/api/files.completeUploadExternal",
    ]);
    expect([asked[0]?.params, asked[2]?.params]).toEqual([
      { token: SESSION.token, filename: "plan.pdf", length: "3" },
      { token: SESSION.token, filename: "notes <draft>.txt", length: "2" },
    ]);
    const sentBytes = asked.filter((a) => a.url.startsWith("https://files.slack.com/"));
    expect(sentBytes.map((a) => [a.bytes, a.headers.authorization, a.headers.cookie])).toEqual([
      [[1, 2, 3], `Bearer ${SESSION.token}`, `d=${encodeURIComponent(SESSION.cookie)}`],
      [[4, 5], `Bearer ${SESSION.token}`, `d=${encodeURIComponent(SESSION.cookie)}`],
    ]);
    const done = asked[4]?.params ?? {};
    expect(JSON.parse(done.files)).toEqual([
      { id: "F1", title: "plan.pdf" },
      { id: "F2", title: "notes <draft>.txt" },
    ]);
    expect(done).toMatchObject({ channel_id: "C0GEN", thread_ts: "1.0", initial_comment: "<@U1> see &lt;these&gt; &amp; those" });
  });

  test("without a thread the completion names only the conversation", async () => {
    const { c, asked } = uploads();
    await c.postWithFiles({ channel: "D0DM", text: "here", files: [{ name: "a.txt", data: new Uint8Array([1]) }] });
    expect(asked.at(-1)?.params).not.toHaveProperty("thread_ts");
    expect(asked.at(-1)?.params.channel_id).toBe("D0DM");
  });

  test("an upload address anywhere but files.slack.com is refused: nothing goes there and nothing is completed", async () => {
    const { c, asked } = uploads({ uploadUrl: () => "https://files.slack.com.example.test/upload/v1/up1" });
    await expect(c.postWithFiles({ channel: "C0GEN", text: "x", files: FILES })).rejects.toMatchObject({ code: "upload_host" });
    expect(asked.map((a) => new URL(a.url).pathname)).toEqual(["/api/files.getUploadURLExternal"]);
  });

  test("a refused completion reports Slack's error and is not tried again", async () => {
    const { c, asked } = uploads({ complete: { ok: false, error: "channel_not_found" } });
    await expect(c.postWithFiles({ channel: "C0GEN", text: "x", files: FILES })).rejects.toMatchObject({ code: "channel_not_found" });
    expect(asked.filter((a) => a.url.endsWith("files.completeUploadExternal"))).toHaveLength(1);
  });

  test("an upload's timeout grows with its size, two minutes at least for 17 MB", () => {
    expect(uploadTimeoutMs(1000)).toBeGreaterThanOrEqual(20_000);
    expect(uploadTimeoutMs(17 * 1024 * 1024)).toBeGreaterThanOrEqual(120_000);
  });
});

describe("only the person's own reply posts on Slack (plan 068)", () => {
  const SEND = /send|post|update|delete|schedule|share|chat\./i;
  /**
   * Deleting one of the person's own drafts touches no message anyone sees; posting the person's own reply, with or
   * without files, is the one send, reached only from the person's own Send.
   */
  const ALLOWED = ["draftsDelete", "/api/drafts.delete", "postReply", "postWithFiles"];

  test("the person's reply posts in its thread, with Slack's markup characters escaped so it arrives as typed", async () => {
    const { c, sent } = client(() => ({ body: { ok: true, ts: "2.0" } }));
    expect(await c.postReply({ channel: "D0DM", thread_ts: "1.0", text: "a < b & c > d" })).toEqual({ ts: "2.0" });
    expect(sent.map((s) => [new URL(s.url).pathname, s.params.channel, s.params.thread_ts, s.params.text])).toEqual([
      ["/api/chat.postMessage", "D0DM", "1.0", "a &lt; b &amp; c &gt; d"],
    ]);
  });

  test("postReply is the client's only method that could send, and none edits or schedules a message", () => {
    const names = Object.getOwnPropertyNames(SlackClient.prototype).filter((n) => n !== "constructor");
    expect(names.filter((n) => SEND.test(n) && !ALLOWED.includes(n))).toEqual([]);
  });

  test("every call the client makes goes to a method that reads, marks a DM read, writes a draft or uploads the person's files", async () => {
    const { c, sent } = client((method) =>
      method === "conversations.info"
        ? { body: { ok: true, channel: { id: "D0DM", is_im: true } } }
        : method === "files.getUploadURLExternal"
          ? { body: { ok: true, upload_url: "https://files.slack.com/upload/v1/up1", file_id: "F1" } }
          : { body: { ok: true, draft: {} } },
    );
    await c.authTest();
    await c.clientCounts();
    await c.activityFeed({ unreadOnly: true });
    await c.conversationsHistory({ channel: "D0DM" });
    await c.conversationsReplies({ channel: "D0DM", ts: "1.0" });
    await c.conversationsInfo("D0DM");
    await c.usersInfo("U0YOU");
    await c.markDm("D0DM", "1.0");
    await c.draftsList();
    await c.draftsCreate({ channel: "D0DM", text: "x" });
    await c.draftsDelete("Dr1");
    await c.postWithFiles({ channel: "D0DM", text: "x", files: [{ name: "a.txt", data: new Uint8Array([1]) }] });
    expect([...new Set(sent.map((s) => new URL(s.url).host))].sort()).toEqual(["acme.slack.com", "files.slack.com"]);
    const paths = [...new Set(sent.map((s) => new URL(s.url).pathname))].sort();
    expect(paths).toEqual(
      [
        "/upload/v1/up1",
        "/api/files.completeUploadExternal",
        "/api/files.getUploadURLExternal",
        "/api/activity.feed",
        "/api/auth.test",
        "/api/client.counts",
        "/api/conversations.history",
        "/api/conversations.info",
        "/api/conversations.mark",
        "/api/conversations.replies",
        "/api/drafts.create",
        "/api/drafts.delete",
        "/api/drafts.list",
        "/api/users.info",
      ].sort(),
    );
    expect(paths.filter((p) => SEND.test(p) && !ALLOWED.includes(p))).toEqual([]);
  });
});
