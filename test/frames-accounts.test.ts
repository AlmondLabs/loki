import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts } from "../mod/accounts.ts";
import { AccountThreads, type OutsideSource } from "../mod/account-threads.ts";
import { accountFrames, type AccountConnectDeps } from "../mod/frames/accounts.ts";
import type { SlackSession } from "../mod/slack-session.ts";
import { peerMeaning } from "../core/frames.ts";
import { bridgeOf, client, settled } from "./fixtures/frames.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bridge with only the account frames, over two accounts of the work agent. */
async function fixture(source?: OutsideSource, connect?: AccountConnectDeps) {
  const dir = mkdtempSync(join(tmpdir(), "loki-frames-accounts-"));
  dirs.push(dir);
  const secrets = memorySecrets();
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets, now: () => new Date("2026-11-04T09:00:00Z"), agentExists: () => true });
  await accounts.add({ account_id: "gmail:ada@acme.com", provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-work" }, "token-1");
  await accounts.add({ account_id: "slack:T01:U02", provider: "slack", address: "Acme", owner_agent_id: "agent-work" });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  if (source) threads.register("gmail", source);
  const bridge = bridgeOf({ modules: [accountFrames({ accounts, threads, ...(connect ? { connect } : {}) })] });
  const ask = async (frame: Record<string, unknown>, peerId?: string) => {
    const c = client("d1", undefined, peerId);
    bridge.onMessage(c, { request_id: "r1", ...frame });
    await settled();
    await settled();
    return c.sent.at(-1) ?? {};
  };
  return { accounts, secrets, threads, ask };
}

describe("the account frames", () => {
  test("account_list names each account and its owner, with no secret and no cursor", async () => {
    const { ask } = await fixture();
    const answer = await ask({ type: "account_list" });
    expect(answer).toEqual({
      type: "accounts",
      request_id: "r1",
      accounts: [
        {
          account_id: "gmail:ada@acme.com",
          provider: "gmail",
          address: "ada@acme.com",
          owner_agent_id: "agent-work",
          status: "connected",
          connected_at: "2026-11-04T09:00:00.000Z",
        },
        {
          account_id: "slack:T01:U02",
          provider: "slack",
          address: "Acme",
          owner_agent_id: "agent-work",
          status: "connected",
          connected_at: "2026-11-04T09:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("token-1");
  });

  test("account_move gives the account to another agent and answers with the list", async () => {
    const { ask, accounts } = await fixture();
    const answer = await ask({ type: "account_move", account_id: "slack:T01:U02", owner_agent_id: "agent-home" });
    expect(answer.type).toBe("accounts");
    expect(accounts.get("slack:T01:U02")?.owner_agent_id).toBe("agent-home");
  });

  test("account_move for an account that is not here answers an error", async () => {
    const { ask } = await fixture();
    const answer = await ask({ type: "account_move", account_id: "gmail:bob@acme.com", owner_agent_id: "agent-home" });
    expect(answer).toMatchObject({ type: "error", request_id: "r1" });
  });

  test("account_disconnect forgets the account and its keychain entry", async () => {
    const { ask, secrets } = await fixture();
    const answer = await ask({ type: "account_disconnect", account_id: "gmail:ada@acme.com" });
    expect((answer.accounts as unknown[]).length).toBe(1);
    expect(secrets.entries.has("account:gmail:ada@acme.com")).toBe(false);
  });

  test("a paired Mac's peer_accounts_get hears the accounts here", async () => {
    const { ask } = await fixture();
    const answer = await ask({ type: "peer_accounts_get" }, "mac-mini");
    expect((answer.accounts as Array<{ account_id: string }>).map((a) => a.account_id)).toEqual(["gmail:ada@acme.com", "slack:T01:U02"]);
  });

  test("account_thread_archive archives the thread out there and the card leaves; one refused there answers why and stays", async () => {
    let refuse = false;
    const { ask, threads } = await fixture({ archive: () => (refuse ? Promise.reject(new Error("Gmail is out of reach")) : Promise.resolve()) });
    const seen = { message_id: "m1", at: "2026-11-04T09:00:00.000Z", sender: "Grace", subject: "hi", lines: ["hi"] };
    threads.observe("gmail:ada@acme.com", { ...seen, thread_id: "t1" });
    threads.observe("gmail:ada@acme.com", { ...seen, thread_id: "t2" });
    expect(await ask({ type: "account_thread_archive", account_id: "gmail:ada@acme.com", thread_id: "t1" })).toEqual({
      type: "account_thread_archived",
      request_id: "r1",
      account_id: "gmail:ada@acme.com",
      thread_id: "t1",
    });
    refuse = true;
    expect(await ask({ type: "account_thread_archive", account_id: "gmail:ada@acme.com", thread_id: "t2" })).toMatchObject({
      type: "error",
      message: "Gmail is out of reach",
    });
    expect(threads.rows().map((r) => r.id)).toEqual(["t2#1"]);
  });

  test("account_thread_archive goes to the Mac the account lives on, named by the card's home", () => {
    expect(peerMeaning("account_thread_archive")).toEqual({ route: "home", relists: true });
  });
});

/** Made-up sessions of the Slack desktop app: Acme (already connected in the fixture) and Globex. */
const SESSIONS: SlackSession[] = [
  { team_id: "T01", team_name: "Acme", url: "https://acme.slack.com/", user_id: "U02", token: "xoxc-acme", cookie: "xoxd-acme" },
  { team_id: "T09", team_name: "Globex", url: "https://globex.slack.com/", user_id: "U07", token: "xoxc-globex", cookie: "xoxd-globex" },
];

/** The ways to connect, over a sign-in that records what it started with and a Slack whose auth.test names the session's workspace. */
function connecting(opts: { supported?: boolean } = {}) {
  const started: unknown[] = [];
  const slackCalls: string[] = [];
  const connect: AccountConnectDeps = {
    agentExists: (id) => id === "agent-work" || id === "agent-home",
    googleSignIn: {
      start: (input) => {
        started.push(input);
        return "https://accounts.google.com/o/oauth2/v2/auth?state=s1";
      },
    },
    slackSessions: {
      available: () => (opts.supported === false ? { supported: false, reason: "connecting Slack works on a Mac only for now" } : { supported: true }),
      workspaces: () => Promise.resolve(SESSIONS.map(({ token: _t, cookie: _c, ...w }) => w)),
      get: (teamId) => Promise.resolve(SESSIONS.find((s) => s.team_id === teamId) ?? null),
    },
    slackFetch: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      slackCalls.push(url);
      const s = SESSIONS.find((x) => url.startsWith(x.url));
      const body = s ? { ok: true, team_id: s.team_id, team: s.team_name, user_id: s.user_id, user: "ada", url: s.url } : { ok: false, error: "invalid_auth" };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    },
  };
  return { connect, started, slackCalls };
}

describe("connecting an account (plan 067, U5)", () => {
  test("account_connect_gmail answers Google's page to open, with the owner and the person's own app", async () => {
    const { connect, started } = connecting();
    const { ask } = await fixture(undefined, connect);
    const ownApp = { client_id: "own-id", client_secret: "own-secret" };
    expect(await ask({ type: "account_connect_gmail", owner_agent_id: "agent-home", own_app: ownApp })).toEqual({
      type: "account_signin",
      request_id: "r1",
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=s1",
    });
    expect(started).toEqual([{ owner_agent_id: "agent-home", own_app: ownApp }]);
  });

  test("connecting for an agent that does not exist is refused before any sign-in starts", async () => {
    const { connect, started, slackCalls } = connecting();
    const { ask } = await fixture(undefined, connect);
    expect(await ask({ type: "account_connect_gmail", owner_agent_id: "agent-gone" })).toMatchObject({
      type: "error",
      message: "an account needs an owner: pick the agent it belongs to",
    });
    expect(await ask({ type: "account_connect_slack", owner_agent_id: "agent-gone", team_id: "T09" })).toMatchObject({ type: "error" });
    expect(started).toEqual([]);
    expect(slackCalls).toEqual([]);
  });

  test("account_connect_slack lists the desktop app's workspaces with no token or cookie in them", async () => {
    const { connect } = connecting();
    const { ask } = await fixture(undefined, connect);
    const answer = await ask({ type: "account_connect_slack", owner_agent_id: "agent-work" });
    expect(answer).toEqual({
      type: "slack_workspaces",
      request_id: "r1",
      account: null,
      workspaces: [
        { team_id: "T01", team_name: "Acme", url: "https://acme.slack.com/", user_id: "U02" },
        { team_id: "T09", team_name: "Globex", url: "https://globex.slack.com/", user_id: "U07" },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("xox");
  });

  test("where Slack cannot be read the answer says why", async () => {
    const { connect } = connecting({ supported: false });
    const { ask } = await fixture(undefined, connect);
    expect(await ask({ type: "account_connect_slack", owner_agent_id: "agent-work" })).toMatchObject({
      type: "error",
      message: "connecting Slack works on a Mac only for now",
    });
  });

  test("account_connect_slack with a workspace checks the session with Slack and keeps the account with its owner and no secret", async () => {
    const { connect, slackCalls } = connecting();
    const { ask, accounts, secrets } = await fixture(undefined, connect);
    const answer = await ask({ type: "account_connect_slack", owner_agent_id: "agent-home", team_id: "T09" });
    expect(slackCalls).toEqual(["https://globex.slack.com/api/auth.test"]);
    expect(answer).toMatchObject({
      type: "slack_workspaces",
      workspaces: [],
      account: { account_id: "slack:T09:U07", address: "Globex", owner_agent_id: "agent-home" },
    });
    expect(accounts.get("slack:T09:U07")?.status).toBe("connected");
    expect(secrets.entries.has("account:slack:T09:U07")).toBe(false);
  });

  test("a workspace that signed out is connected again with its owner, and one already connected is refused", async () => {
    const { connect } = connecting();
    const { ask, accounts } = await fixture(undefined, connect);
    expect(await ask({ type: "account_connect_slack", owner_agent_id: "agent-home", team_id: "T01" })).toMatchObject({
      type: "error",
      message: "Acme (Slack) is already connected",
    });
    accounts.setStatus("slack:T01:U02", { disconnected: "slack_signed_out" });
    expect(await ask({ type: "account_connect_slack", owner_agent_id: "agent-home", team_id: "T01" })).toMatchObject({
      account: { account_id: "slack:T01:U02", owner_agent_id: "agent-work", status: "connected" },
    });
  });
});
