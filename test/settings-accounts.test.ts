import { describe, expect, test } from "vitest";
import type { FrameRequest } from "../core/attention/chat-client.ts";
import { daemonCalls } from "../core/daemon-calls.ts";
import type { AccountView } from "../core/frame-types.ts";
import type { RequestResult } from "../core/frames.ts";
import { accountRows, connectState, deleteBlockers, moveTargets, ownAppOf } from "../app/src/settings/accounts.tsx";
import { must } from "./fixtures/must.ts";

/** A mod socket that records each request and answers from `replies` by its type; a type with none is refused. */
function fakeRequest(replies: Record<string, unknown>) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const request = ((type: string, payload: unknown) => {
    sent.push({ type, payload });
    const reply = replies[type];
    const result: RequestResult<unknown> = reply === undefined ? { ok: false, error: `no ${type} here`, timed_out: false } : { ok: true, reply };
    return Promise.resolve(result);
  }) as FrameRequest;
  return { request, sent };
}

const AGENTS = [
  { id: "agent-work", name: "Work" },
  { id: "agent-home", name: "Home" },
  { id: "agent-ops", name: "Ops" },
];

const MAIL: AccountView = {
  account_id: "gmail:ada@acme.com",
  provider: "gmail",
  address: "ada@acme.com",
  owner_agent_id: "agent-work",
  status: "connected",
  connected_at: "2026-11-01T09:00:00.000Z",
};
const SLACK: AccountView = {
  account_id: "slack:T01:U02",
  provider: "slack",
  address: "Acme",
  owner_agent_id: "agent-work",
  status: "connected",
  connected_at: "2026-11-01T09:00:00.000Z",
};

describe("Preferences › Accounts (plan 067, U11)", () => {
  test("connect is not possible before the owning agent is chosen (R2)", () => {
    for (const provider of ["gmail", "slack"] as const) {
      const state = connectState(provider, null, "macos");
      expect(state.ready).toBe(false);
      expect(state.reason).toBe("add an agent first: an account belongs to one");
      expect(connectState(provider, "agent-work", "macos")).toEqual({ ready: true, reason: null });
    }
  });

  test("on Windows and Linux, connect slack says it is not supported yet, even with an owner; Gmail still connects", () => {
    expect(connectState("slack", "agent-work", "windows")).toEqual({ ready: false, reason: "Connecting Slack isn't on Windows yet" });
    expect(connectState("slack", "agent-work", "linux")).toEqual({ ready: false, reason: "Connecting Slack isn't on Linux yet" });
    expect(connectState("gmail", "agent-work", "linux")).toEqual({ ready: true, reason: null });
  });

  test("each row names the account, its service, its owner and its state", () => {
    expect(accountRows([MAIL, { ...SLACK, owner_agent_id: "agent-gone" }], AGENTS)).toEqual([
      {
        account_id: "gmail:ada@acme.com",
        label: "ada@acme.com",
        service: "Gmail",
        owner_agent_id: "agent-work",
        owner: "Work",
        state: "connected",
        problem: false,
        reconnect: null,
      },
      {
        account_id: "slack:T01:U02",
        label: "Acme",
        service: "Slack",
        owner_agent_id: "agent-gone",
        owner: "an agent no longer here",
        state: "connected",
        problem: false,
        reconnect: null,
      },
    ]);
  });

  test("AE8: a workspace whose Slack app signed out shows that state and a reconnect with its team", () => {
    const [row] = accountRows([{ ...SLACK, status: { disconnected: "slack_signed_out" } }], AGENTS);
    expect(row.problem).toBe(true);
    expect(row.state).toBe("the Slack app signed out: sign in there, then connect again in Preferences › Accounts");
    expect(row.reconnect).toEqual({ provider: "slack", owner_agent_id: "agent-work", team_id: "T01" });
  });

  test("a Gmail sign-in gone stale reconnects by signing in again; a service failing for now offers no reconnect", () => {
    const [stale, failing] = accountRows(
      [
        { ...MAIL, status: { disconnected: "sign_in_again" } },
        { ...MAIL, account_id: "gmail:bo@acme.com", status: { disconnected: "temporarily_failing" } },
      ],
      AGENTS,
    );
    expect(stale.reconnect).toEqual({ provider: "gmail", owner_agent_id: "agent-work", team_id: null });
    expect(failing.problem).toBe(true);
    expect(failing.reconnect).toBeNull();
  });

  test("moving the owner sends account_move and the row then names the new owner (R3)", async () => {
    const { request, sent } = fakeRequest({ account_move: { accounts: [{ ...MAIL, owner_agent_id: "agent-home" }] } });
    const moved = await daemonCalls(request).accounts.move(MAIL.account_id, "agent-home");
    expect(sent).toEqual([{ type: "account_move", payload: { account_id: "gmail:ada@acme.com", owner_agent_id: "agent-home" } }]);
    expect(typeof moved).not.toBe("string");
    expect(accountRows(typeof moved === "string" ? [] : moved, AGENTS)[0].owner).toBe("Home");
  });

  test("the accounts calls send their frames and answer in words when refused", async () => {
    const workspaces = [{ team_id: "T01", team_name: "Acme", url: "https://acme.slack.com/", user_id: "U02" }];
    const { request, sent } = fakeRequest({
      account_list: { accounts: [MAIL] },
      account_connect_gmail: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" },
      account_connect_slack: { workspaces, account: null },
    });
    const calls = daemonCalls(request).accounts;
    expect(await calls.list()).toEqual([MAIL]);
    expect(await calls.connectGmail("agent-work", null)).toEqual({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    expect(await calls.connectGmail("agent-work", { client_id: "id", client_secret: "secret" })).toEqual({
      url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    });
    expect(await calls.connectSlack("agent-work")).toEqual({ workspaces, account: null });
    expect(await calls.connectSlack("agent-work", "T01")).toEqual({ workspaces, account: null });
    expect(await calls.disconnect(MAIL.account_id)).toBe("no account_disconnect here");
    expect(sent).toEqual([
      { type: "account_list", payload: {} },
      { type: "account_connect_gmail", payload: { owner_agent_id: "agent-work", own_app: null } },
      { type: "account_connect_gmail", payload: { owner_agent_id: "agent-work", own_app: { client_id: "id", client_secret: "secret" } } },
      { type: "account_connect_slack", payload: { owner_agent_id: "agent-work", team_id: null } },
      { type: "account_connect_slack", payload: { owner_agent_id: "agent-work", team_id: "T01" } },
      { type: "account_disconnect", payload: { account_id: "gmail:ada@acme.com" } },
    ]);
  });

  test("Preferences › Accounts lists only this Mac's accounts given a reply with both lists; the editor's call gets both (plan 087, U4)", async () => {
    const other = { ...SLACK, account_id: "slack:T09:U07", address: "Studio", mac_id: "mac-mini", mac_name: "Mac mini" };
    const { request } = fakeRequest({ account_list: { accounts: [MAIL], other_macs: [other] } });
    const calls = daemonCalls(request).accounts;
    const listed = await calls.list();
    expect(listed).toEqual([MAIL]);
    expect(accountRows(typeof listed === "string" ? [] : listed, AGENTS).map((r) => r.account_id)).toEqual(["gmail:ada@acme.com"]);
    expect(await calls.everywhere()).toEqual({ accounts: [MAIL], other_macs: [other] });
    // A mod from before other Macs' accounts answers without the list.
    expect(await daemonCalls(fakeRequest({ account_list: { accounts: [MAIL] } }).request).accounts.everywhere()).toEqual({ accounts: [MAIL], other_macs: [] });
  });

  test("your own Google app goes with the sign-in only when both its id and secret are filled in", () => {
    expect(ownAppOf("", "")).toBeNull();
    expect(ownAppOf(" id.apps.googleusercontent.com ", "")).toBeNull();
    expect(ownAppOf(" id.apps.googleusercontent.com ", " s3cret ")).toEqual({ client_id: "id.apps.googleusercontent.com", client_secret: "s3cret" });
  });
});

describe("deleting an agent that owns accounts (plan 067, R4, AE5)", () => {
  test("the refusal turns into a choice for each account the agent owns: move to another agent, or disconnect", () => {
    const accounts = [MAIL, SLACK, { ...MAIL, account_id: "gmail:me@home.net", address: "me@home.net", owner_agent_id: "agent-home" }];
    const blockers = deleteBlockers(accounts, "agent-work");
    expect(blockers.map((a) => a.account_id)).toEqual(["gmail:ada@acme.com", "slack:T01:U02"]);
    expect(moveTargets(AGENTS, "agent-work").map((a) => a.id)).toEqual(["agent-home", "agent-ops"]);
    expect(deleteBlockers(accounts, must(AGENTS.at(2), "ops").id)).toEqual([]);
  });
});
