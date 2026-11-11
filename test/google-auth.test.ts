import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts } from "../mod/accounts.ts";
import { GoogleAuth, GoogleError } from "../mod/google-auth.ts";
import { GmailClient } from "../mod/gmail.ts";
import { ALL_SCOPES } from "./fixtures/gmail.ts";
import { must } from "./fixtures/must.ts";

const SHARED = { client_id: "shared-client.apps.googleusercontent.com", client_secret: "shared-secret" };
const ACCOUNT = "gmail:ada@acme.com";
const DRIVE = "https://www.googleapis.com/drive/v3";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Google's token endpoint and a sliver of Drive and Gmail, on the test's clock: one access token is good at a time,
 * the refresh answers with `state.scope`, and every request is kept.
 */
function fakeApis(now: () => Date) {
  const state = { access: "a0", expires: now().getTime() + 3600_000, refreshes: 0, scope: ALL_SCOPES.join(" "), revoked: false, missingDrive: false };
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ method: init?.method ?? "GET", url: url.href, body: init?.body });
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (state.revoked) return json(400, { error: "invalid_grant" });
      // Answered after a turn of the event loop, so two callers can find the token lapsed at once.
      await Promise.resolve();
      state.refreshes++;
      state.access = `a${state.refreshes}`;
      state.expires = now().getTime() + 3600_000;
      return json(200, { access_token: state.access, expires_in: 3600, scope: state.scope });
    }
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    if (bearer !== state.access || state.expires <= now().getTime()) return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    if (url.href.startsWith(`${DRIVE}/files`) && state.missingDrive)
      return json(403, { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } });
    if (url.pathname === "/drive/v3/files/f1" && url.searchParams.get("alt") === "media") return new Response(new Uint8Array([0, 1, 2, 250, 255]));
    if (url.pathname === "/drive/v3/files/f1" && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/drive/v3/files") return json(200, { files: [{ id: "f1", name: "budget.xlsx" }] });
    if (url.pathname === "/gmail/v1/users/me/profile") return json(200, { emailAddress: "ada@acme.com", historyId: "9" });
    return json(404, { error: { code: 404, message: "File not found: nope." } });
  };
  return { state, requests, fetch: fetchFn };
}

/** An account signed in with every service, its token good for an hour from the test's start. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loki-google-auth-"));
  dirs.push(dir);
  let now = new Date("2026-11-11T09:00:00Z");
  const clock = () => now;
  const secrets = memorySecrets();
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets, now: clock, agentExists: () => true });
  const apis = fakeApis(clock);
  const secret = { access_token: "a0", refresh_token: "r0", expires_at: new Date(now.getTime() + 3600_000).toISOString(), scopes: ALL_SCOPES.join(" ") };
  await accounts.add(
    {
      account_id: ACCOUNT,
      provider: "gmail",
      address: "ada@acme.com",
      owner_agent_id: "agent-work",
      services: ["gmail", "drive", "sheets", "docs", "calendar"],
    },
    JSON.stringify(secret),
  );
  const auth = new GoogleAuth({ accounts, account_id: ACCOUNT, sharedApp: SHARED, fetch: apis.fetch, now: clock });
  return { accounts, secrets, apis, auth, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("one Google account's sign-in (plan 2026-11-11, U6)", () => {
  test("a call carries the token; a lapsed token is refreshed first and kept in the keychain", async () => {
    const f = await fixture();
    expect(await f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files`, query: { q: "trashed = false" } })).toEqual({
      files: [{ id: "f1", name: "budget.xlsx" }],
    });
    f.advance(3600_000);
    await f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files` });
    expect(f.apis.state.refreshes).toBe(1);
    const kept = JSON.parse(must(f.secrets.entries.get(`account:${ACCOUNT}`), "the secret")) as { access_token: string };
    expect(kept.access_token).toBe("a1");
  });

  test("a 401 refreshes once and tries again; Google refusing the refresh disconnects the account to sign in again", async () => {
    const f = await fixture();
    f.apis.state.access = "elsewhere";
    expect(await f.auth.json({ service: "gmail", method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" })).toMatchObject({
      emailAddress: "ada@acme.com",
    });
    expect(f.apis.state.refreshes).toBe(1);
    f.apis.state.access = "elsewhere";
    f.apis.state.revoked = true;
    await expect(f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files` })).rejects.toThrow("Google asks you to sign in again");
    expect(f.accounts.get(ACCOUNT)?.status).toEqual({ disconnected: "sign_in_again" });
  });

  test("R17: a service the account did not grant is a sign-in-again for it, and the account stays connected", async () => {
    const f = await fixture();
    f.apis.state.missingDrive = true;
    const refused = f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files` });
    await expect(refused).rejects.toThrow("this Google account has not let loki use Drive: sign in again for it in Preferences › Accounts");
    await expect(refused).rejects.toBeInstanceOf(GoogleError);
    expect(f.accounts.get(ACCOUNT)?.status).toBe("connected");
  });

  test("a refresh that reports fewer scopes keeps the account's services as Google now has them", async () => {
    const f = await fixture();
    const [gmail, drive] = ALL_SCOPES;
    f.apis.state.scope = [gmail, drive, "openid"].join(" ");
    f.advance(3600_000);
    await f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files` });
    expect(f.accounts.get(ACCOUNT)?.services).toEqual(["gmail", "drive"]);
    expect(f.auth.services()).toEqual(["gmail", "drive"]);
  });

  test("a download's bytes come back exactly; a 204 delete answers nothing; Google's own error message is kept", async () => {
    const f = await fixture();
    expect([...(await f.auth.bytes({ service: "drive", method: "GET", url: `${DRIVE}/files/f1`, query: { alt: "media" } }))]).toEqual([0, 1, 2, 250, 255]);
    expect(await f.auth.json({ service: "drive", method: "DELETE", url: `${DRIVE}/files/f1` })).toEqual({});
    await expect(f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files/nope` })).rejects.toThrow("File not found: nope.");
  });

  test("a raw body goes as it is, with its type", async () => {
    const f = await fixture();
    const data = new Uint8Array([9, 8, 7]);
    await f.auth.send({ service: "drive", method: "PUT", url: `${DRIVE}/files`, body: { data, type: "application/pdf" } }).catch(() => undefined);
    expect(f.apis.requests.at(-1)).toMatchObject({ method: "PUT", body: data });
  });

  test("a call that never answers ends when its time runs out", async () => {
    const f = await fixture();
    let expire = () => {};
    const timeout = () => {
      const c = new AbortController();
      expire = () => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return c.signal;
    };
    let reached = () => {};
    const atFetch = new Promise<void>((r) => (reached = r));
    const hanging = (_: RequestInfo | URL, init?: RequestInit) => {
      reached();
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))));
    };
    const auth = new GoogleAuth({ accounts: f.accounts, account_id: ACCOUNT, sharedApp: SHARED, fetch: hanging, timeout });
    const call = auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files`, timeoutMs: 120_000 });
    await atFetch;
    expire();
    await expect(call).rejects.toThrow("timed out");
  });

  test("Gmail and the Google tools on one account share one refresh when both find the token lapsed", async () => {
    const f = await fixture();
    const gmail = new GmailClient({ accounts: f.accounts, account_id: ACCOUNT, auth: f.auth });
    f.advance(3600_000);
    await Promise.all([gmail.profile(), f.auth.json({ service: "drive", method: "GET", url: `${DRIVE}/files` })]);
    expect(f.apis.state.refreshes).toBe(1);
  });
});
