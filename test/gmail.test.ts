import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts } from "../mod/accounts.ts";
import { GmailClient } from "../mod/gmail.ts";
import type { GoogleApp } from "../mod/google-app.ts";
import { GoogleSignIn } from "../mod/google-signin.ts";
import { fakeGoogle } from "./fixtures/gmail.ts";
import { must } from "./fixtures/must.ts";

/** A fetch's URL as text, whatever form it came in. */
const urlOf = (input: RequestInfo | URL): string => (input instanceof Request ? input.url : input instanceof URL ? input.href : input);
/** An abort's reason as an Error, as fetch rejects with it. */
const asError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(String(reason)));

const SHARED = { client_id: "shared-client", client_secret: "shared-secret" };
const OWN = { client_id: "own-client", client_secret: "own-secret" };
const ACCOUNT = "gmail:ada@acme.com";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A mailbox connected through a real sign-in against the fake Google, and its client, on a clock the test moves. */
async function connected(ownApp?: GoogleApp) {
  const dir = mkdtempSync(join(tmpdir(), "loki-gmail-"));
  dirs.push(dir);
  let now = new Date("2026-11-04T09:00:00Z");
  const clock = () => now;
  const secrets = memorySecrets();
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets, now: clock });
  const google = fakeGoogle({ now: clock });
  const signIn = new GoogleSignIn({
    accounts,
    fetch: google.fetch,
    now: clock,
    redirect: "http://127.0.0.1:41414/accounts/google/callback",
    sharedApp: SHARED,
  });
  const done = await signIn.finish(google.authorize(signIn.start({ owner_agent_id: "agent-work", ...(ownApp ? { own_app: ownApp } : {}) })));
  expect(done.ok).toBe(true);
  google.requests.length = 0;
  const client = new GmailClient({ accounts, account_id: ACCOUNT, sharedApp: SHARED, fetch: google.fetch, now: clock });
  return { accounts, secrets, google, client, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const HOUR = 3600 * 1000;
const formOf = (body: string | undefined) => new URLSearchParams(body ?? "");

describe("the Gmail client's tokens", () => {
  test("an access token past its expiry is refreshed once, kept in the keychain, and the call goes through", async () => {
    const { client, google, secrets, advance } = await connected();
    advance(HOUR + 1);
    expect(await client.profile()).toEqual({ emailAddress: "ada@acme.com", historyId: "500" });
    expect(google.tokenRequests()).toHaveLength(1);
    expect(formOf(google.tokenRequests()[0]?.body).get("grant_type")).toBe("refresh_token");
    const kept = JSON.parse(must(secrets.entries.get(`account:${ACCOUNT}`), "the secret")) as { access_token: string };
    expect(kept.access_token).toBe(google.issued.access.at(-1));
    // The new token lasts: a second call needs no refresh.
    await client.profile();
    expect(google.tokenRequests()).toHaveLength(1);
  });

  test("a token Google stops honouring early answers 401; the client refreshes once and retries the call", async () => {
    const { client, google } = await connected();
    google.revokeAccessTokens();
    expect((await client.profile()).emailAddress).toBe("ada@acme.com");
    expect(google.tokenRequests()).toHaveLength(1);
    expect(google.requests.filter((r) => r.url.pathname.endsWith("/profile"))).toHaveLength(2);
  });

  test("a refresh answering invalid_grant marks the account sign in again", async () => {
    const { client, google, accounts, advance } = await connected();
    google.revokeRefreshTokens();
    advance(HOUR + 1);
    await expect(client.profile()).rejects.toThrow("sign in again");
    expect(must(accounts.get(ACCOUNT), "the account").status).toEqual({ disconnected: "sign_in_again" });
  });

  test("an admin blocking the app marks the account admin blocks", async () => {
    const { client, google, accounts } = await connected();
    google.state.adminBlocked = true;
    await expect(client.listMessages("in:inbox")).rejects.toThrow("use your own Google app in Preferences › Accounts");
    expect(must(accounts.get(ACCOUNT), "the account").status).toEqual({ disconnected: "admin_blocks" });
  });

  test("an account signed in with the person's own app refreshes with that app", async () => {
    const { client, google, advance } = await connected(OWN);
    advance(HOUR + 1);
    await client.profile();
    const form = formOf(google.tokenRequests()[0]?.body);
    expect([form.get("client_id"), form.get("client_secret")]).toEqual([OWN.client_id, OWN.client_secret]);
  });
});

/**
 * A fetch that, while `hang` is on, never answers until its signal is aborted, and a timeout the test fires itself:
 * `reached` settles once a hung call is under way, `expire` aborts it as a timeout would.
 */
function hanging(inner: typeof fetch) {
  const signals: AbortController[] = [];
  let hit: (url: string) => void = () => undefined;
  const t = {
    hang: false,
    reached: new Promise<string>((resolve) => (hit = resolve)),
    timeout: () => {
      const c = new AbortController();
      signals.push(c);
      return c.signal;
    },
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!t.hang) return inner(input, init);
      hit(urlOf(input));
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(asError(init.signal?.reason))));
    },
    expire: () => must(signals.at(-1), "a signal").abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
  };
  return t;
}

describe("a Gmail call that never answers", () => {
  test("an API call fails when its time runs out, and the account stays connected", async () => {
    const { accounts, google } = await connected();
    const t = hanging(google.fetch);
    const now = () => new Date("2026-11-04T09:00:00Z");
    const client = new GmailClient({ accounts, account_id: ACCOUNT, sharedApp: SHARED, fetch: t.fetch, timeout: t.timeout, now });
    t.hang = true;
    const call = client.listMessages("in:inbox");
    expect(await t.reached).toContain("/messages");
    t.expire();
    await expect(call).rejects.toThrow("timeout");
    expect(must(accounts.get(ACCOUNT), "the account").status).toBe("connected");
  });

  test("a token refresh fails when its time runs out, and the account stays connected", async () => {
    const { accounts, google } = await connected();
    const t = hanging(google.fetch);
    // An hour on, the access token has lapsed and the call starts with a refresh.
    const now = () => new Date("2026-11-04T10:00:01Z");
    const client = new GmailClient({ accounts, account_id: ACCOUNT, sharedApp: SHARED, fetch: t.fetch, timeout: t.timeout, now });
    t.hang = true;
    const call = client.profile();
    expect(await t.reached).toBe("https://oauth2.googleapis.com/token");
    t.expire();
    await expect(call).rejects.toThrow("timeout");
    expect(must(accounts.get(ACCOUNT), "the account").status).toBe("connected");
  });
});

describe("the Gmail client's calls", () => {
  test("send-as lists every address, and a mailbox whose settings are refused gives its own address", async () => {
    const { client, google } = await connected();
    expect(await client.sendAsAddresses()).toEqual(["ada@acme.com", "ada@example.org"]);
    google.state.sendAs = 403;
    expect(await client.sendAsAddresses()).toEqual(["ada@acme.com"]);
  });

  test("history follows every page, and history Gmail no longer keeps reads as expired", async () => {
    const { client, google } = await connected();
    google.state.history = ["201", "202", "203"].map((id) => ({ id, messagesAdded: [{ message: { id: `m${id}`, threadId: `t${id}` } }] }));
    const changes = await client.historySince("200");
    expect(changes.kind === "changes" && changes.history.map((h) => [h.id, h.messagesAdded.map((m) => m.threadId)])).toEqual([
      ["201", ["t201"]],
      ["202", ["t202"]],
      ["203", ["t203"]],
    ]);
    expect(changes.kind === "changes" && changes.history_id).toBe("500");
    expect(await client.historySince("50")).toEqual({ kind: "expired" });
  });

  test("a search returns one page and where the next starts; a thread comes in metadata or full", async () => {
    const { client, google } = await connected();
    expect(await client.listMessages("to:me newer_than:7d")).toEqual({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t1" },
      ],
      nextPageToken: "p2",
    });
    expect(await client.listMessages("to:me", "p2")).toEqual({ messages: [{ id: "m3", threadId: "t2" }] });
    expect(must(google.requests[0], "a request").url.searchParams.get("q")).toBe("to:me newer_than:7d");

    const meta = await client.getThread("t1", "metadata");
    expect(meta.messages.map((m) => [m.id, m.labelIds, m.payload?.headers, m.payload?.body.data])).toEqual([
      ["m1", ["INBOX", "UNREAD"], [{ name: "Subject", value: "Lunch" }], undefined],
    ]);
    const full = await client.getThread("t1", "full");
    expect(full.messages[0]?.payload?.body.data).toBe("bHVuY2ggb24gZnJpZGF5Pw");
  });

  test("labels come off the given messages only: INBOX to archive, UNREAD to mark read; no messages makes no call", async () => {
    const { client, google } = await connected();
    await client.batchModify(["m1", "m2"], { removeLabels: ["INBOX", "UNREAD"] });
    await client.batchModify([], { removeLabels: ["INBOX"] });
    expect(google.modified).toEqual([{ ids: ["m1", "m2"], removeLabelIds: ["INBOX", "UNREAD"] }]);
  });

  test("a draft is an RFC 2822 reply in its thread, and a header value cannot add a header", async () => {
    const { client, google } = await connected();
    const draft = await client.createDraft({
      threadId: "t1",
      inReplyTo: "<m1@acme.com>",
      references: ["<m0@acme.com>"],
      to: ["bob@acme.com"],
      cc: ["cy@acme.com"],
      subject: "Re: Lunch\r\nBcc: eve@evil.example",
      body: "Friday works.\nSee you — Ada",
    });
    expect(draft).toEqual({ id: "d1", messageId: "dm1" });
    const sent = must(google.drafts[0], "a draft");
    expect(sent.threadId).toBe("t1");
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    const [head = "", body = ""] = raw.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "To: bob@acme.com",
      "Cc: cy@acme.com",
      "Subject: Re: Lunch Bcc: eve@evil.example",
      "In-Reply-To: <m1@acme.com>",
      "References: <m0@acme.com> <m1@acme.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Friday works.\r\nSee you — Ada");
  });

  test("a subject that is not plain ASCII is encoded as RFC 2047 asks", async () => {
    const { client, google } = await connected();
    await client.createDraft({ threadId: "t1", inReplyTo: "", references: [], to: ["bob@acme.com"], cc: [], subject: "Re: Café", body: "ok" });
    const raw = Buffer.from(must(google.drafts[0], "a draft").raw, "base64url").toString("utf8");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: Café").toString("base64")}?=`);
    expect(raw).not.toContain("In-Reply-To");
  });
});

describe("only the person's own reply sends from Gmail (plan 068)", () => {
  test("the person's reply goes to Gmail's send in its thread, as the same RFC 2822 message a draft is", async () => {
    const { client, google } = await connected();
    expect(
      await client.sendReply({
        threadId: "t1",
        inReplyTo: "<m1@acme.com>",
        references: [],
        to: ["bob@acme.com"],
        cc: [],
        subject: "Re: Lunch",
        body: "Friday.",
      }),
    ).toEqual({ id: "s1" });
    const sent = must(google.sentMail[0], "a sent message");
    expect(sent.threadId).toBe("t1");
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: bob@acme.com\r\n");
    expect(raw).toContain("In-Reply-To: <m1@acme.com>\r\n");
    expect(google.drafts).toEqual([]);
  });

  test("sendReply is the client's only send call, and nothing else it does reaches a send endpoint", async () => {
    const names = Object.getOwnPropertyNames(GmailClient.prototype);
    // sendAsAddresses reads the addresses the person writes from; it sends nothing.
    expect(names.filter((n) => /send/i.test(n)).sort()).toEqual(["sendAsAddresses", "sendReply"]);

    const { client, google, advance } = await connected();
    advance(HOUR + 1);
    google.state.history = [{ id: "201", messagesAdded: [] }];
    await client.profile();
    await client.sendAsAddresses();
    await client.historySince("200");
    await client.listMessages("in:inbox");
    await client.getThread("t1", "full");
    await client.batchModify(["m1"], { removeLabels: ["UNREAD"] });
    await client.createDraft({ threadId: "t1", inReplyTo: "<m1@acme.com>", references: [], to: ["bob@acme.com"], cc: [], subject: "Re", body: "ok" });
    expect(google.requests.length).toBeGreaterThan(7);
    expect(google.requests.filter((r) => r.url.pathname.split("/").includes("send"))).toEqual([]);
  });
});
