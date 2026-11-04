import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts } from "../mod/accounts.ts";
import { GOOGLE_OAUTH_CALLBACK, GoogleSignIn } from "../mod/google-signin.ts";
import { startServer } from "../mod/server.ts";
import { fakeGoogle } from "./fixtures/gmail.ts";
import { must } from "./fixtures/must.ts";

/** A fetch's URL as text, whatever form it came in. */
const urlOf = (input: RequestInfo | URL): string => (input instanceof Request ? input.url : input instanceof URL ? input.href : input);
/** An abort's reason as an Error, as fetch rejects with it. */
const asError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(String(reason)));

const SHARED = { client_id: "shared-client.apps.googleusercontent.com", client_secret: "shared-secret" };
const OWN = { client_id: "own-client.apps.googleusercontent.com", client_secret: "own-secret" };
const REDIRECT = "http://127.0.0.1:41414/accounts/google/callback";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A sign-in over a fresh state folder, an in-memory keychain, a fake Google and a clock the test moves. */
function fixture(sharedApp = SHARED) {
  const dir = mkdtempSync(join(tmpdir(), "loki-google-"));
  dirs.push(dir);
  let now = new Date("2026-11-04T09:00:00Z");
  const clock = () => now;
  const secrets = memorySecrets();
  const file = join(dir, "accounts.json");
  const accounts = new Accounts({ file, secrets, now: clock, agentExists: (id) => id === "agent-work" || id === "agent-home" });
  const google = fakeGoogle({ now: clock });
  const signIn = new GoogleSignIn({ accounts, fetch: google.fetch, now: clock, redirect: REDIRECT, sharedApp });
  return { file, secrets, accounts, google, signIn, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("signing in to Gmail", () => {
  test("the authorization page asks for Gmail modify and the address, offline, with consent and PKCE", () => {
    const { signIn } = fixture();
    const url = new URL(signIn.start({ owner_agent_id: "agent-work" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("scope")?.split(" ")).toEqual(["https://www.googleapis.com/auth/gmail.modify", "openid", "https://www.googleapis.com/auth/userinfo.email"]);
    expect([q.get("access_type"), q.get("prompt"), q.get("code_challenge_method"), q.get("redirect_uri"), q.get("client_id")]).toEqual([
      "offline",
      "consent",
      "S256",
      REDIRECT,
      SHARED.client_id,
    ]);
    expect(q.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a matching state redeems the code, keeps the tokens in the keychain and adds the account with its owner", async () => {
    const { file, secrets, accounts, google, signIn } = fixture();
    const back = google.authorize(signIn.start({ owner_agent_id: "agent-work" }));
    const result = await signIn.finish(back);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Connected ada@acme.com");
    expect(accounts.list().map((a) => [a.account_id, a.address, a.owner_agent_id, a.status])).toEqual([
      ["gmail:ada@acme.com", "ada@acme.com", "agent-work", "connected"],
    ]);
    const secret = JSON.parse(must(secrets.entries.get("account:gmail:ada@acme.com"), "the account's secret")) as Record<string, unknown>;
    expect(secret).toEqual({ access_token: google.issued.access[0], refresh_token: google.issued.refresh[0], expires_at: "2026-11-04T10:00:00.000Z" });
    // The redemption carried the verifier the challenge was made from (the fake checks it) and the shared app.
    const form = new URLSearchParams(must(google.tokenRequests()[0], "a token request").body);
    expect([form.get("grant_type"), form.get("client_id"), form.get("client_secret")]).toEqual(["authorization_code", SHARED.client_id, SHARED.client_secret]);
    expect(readFileSync(file, "utf8")).not.toMatch(/access-|refresh-/);
  });

  test("an unknown, replayed or expired state is refused and nothing is kept", async () => {
    const { secrets, accounts, google, signIn, advance } = fixture();
    const unknown = await signIn.finish({ state: "not-ours", code: "x" });
    expect(unknown).toMatchObject({ ok: false, message: expect.stringContaining("not one loki started") as unknown });

    const late = google.authorize(signIn.start({ owner_agent_id: "agent-work" }));
    advance(10 * 60 * 1000 + 1);
    expect(await signIn.finish(late)).toMatchObject({ ok: false, message: expect.stringContaining("longer than 10 minutes") as unknown });
    // The expired sign-in is gone too: trying it again is a state loki does not know.
    expect(await signIn.finish(late)).toMatchObject({ ok: false, message: expect.stringContaining("not one loki started") as unknown });

    expect(google.tokenRequests()).toHaveLength(0);
    expect(accounts.list()).toEqual([]);
    expect(secrets.entries.size).toBe(0);
  });

  test("Google's refusal on its own page is shown and nothing is kept", async () => {
    const { accounts, signIn } = fixture();
    const state = must(new URL(signIn.start({ owner_agent_id: "agent-work" })).searchParams.get("state"), "a state");
    expect(await signIn.finish({ state, error: "access_denied" })).toEqual({ ok: false, message: "Google did not sign you in: access_denied" });
    expect(accounts.list()).toEqual([]);
  });

  test("with the own-app setting the sign-in and the kept secret use the person's client, not the shared one", async () => {
    const { secrets, google, signIn } = fixture();
    const url = signIn.start({ owner_agent_id: "agent-work", own_app: OWN });
    expect(new URL(url).searchParams.get("client_id")).toBe(OWN.client_id);
    expect((await signIn.finish(google.authorize(url))).ok).toBe(true);
    const form = new URLSearchParams(must(google.tokenRequests()[0], "a token request").body);
    expect([form.get("client_id"), form.get("client_secret")]).toEqual([OWN.client_id, OWN.client_secret]);
    const secret = JSON.parse(must(secrets.entries.get("account:gmail:ada@acme.com"), "the account's secret")) as Record<string, unknown>;
    expect(secret.own_app).toEqual(OWN);
  });

  test("with no shared app in this copy of loki, a sign-in says so instead of calling Google", () => {
    const { google, signIn } = fixture({ client_id: "", client_secret: "" });
    expect(() => signIn.start({ owner_agent_id: "agent-work" })).toThrow("the shared Google app is not set; use your own Google app in Preferences › Inbox");
    expect(google.requests).toHaveLength(0);
    // The person's own app still works there.
    expect(new URL(signIn.start({ owner_agent_id: "agent-work", own_app: OWN })).searchParams.get("client_id")).toBe(OWN.client_id);
  });

  test("a token exchange or address read that never answers ends the sign-in when its time runs out, and nothing is kept", async () => {
    const { secrets, accounts, google } = fixture();
    let hangOn = "";
    let expire: () => void = () => undefined;
    let reached: (url: string) => void = () => undefined;
    const hanging = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!urlOf(input).startsWith(hangOn)) return google.fetch(input, init);
      reached(urlOf(input));
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(asError(init.signal?.reason))));
    };
    const timeout = () => {
      const c = new AbortController();
      expire = () => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return c.signal;
    };
    const now = () => new Date("2026-11-04T09:00:00Z");
    const signIn = new GoogleSignIn({ accounts, fetch: hanging, now, redirect: REDIRECT, sharedApp: SHARED, timeout });
    for (const url of ["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/profile"]) {
      hangOn = url;
      const at = new Promise<string>((resolve) => (reached = resolve));
      const result = signIn.finish(google.authorize(signIn.start({ owner_agent_id: "agent-work" })));
      expect(await at).toBe(url);
      expire();
      expect(await result).toMatchObject({ ok: false, message: expect.stringContaining("Gmail did not connect") as unknown });
    }
    expect(accounts.list()).toEqual([]);
    expect(secrets.entries.size).toBe(0);
  });

  test("a mailbox already connected is refused; one that lost its sign-in takes the new tokens and keeps its owner", async () => {
    const { secrets, accounts, google, signIn } = fixture();
    await signIn.finish(google.authorize(signIn.start({ owner_agent_id: "agent-work" })));
    const again = await signIn.finish(google.authorize(signIn.start({ owner_agent_id: "agent-home" })));
    expect(again).toMatchObject({ ok: false, message: "Gmail did not connect: ada@acme.com is already connected" });

    accounts.setStatus("gmail:ada@acme.com", { disconnected: "sign_in_again" });
    const before = secrets.entries.get("account:gmail:ada@acme.com");
    const back = await signIn.finish(google.authorize(signIn.start({ owner_agent_id: "agent-home" })));
    expect(back.ok).toBe(true);
    expect(accounts.list().map((a) => [a.owner_agent_id, a.status])).toEqual([["agent-work", "connected"]]);
    expect(secrets.entries.get("account:gmail:ada@acme.com")).not.toBe(before);
  });

  test("the loopback server ends a sign-in at the Google callback and shows the page", async () => {
    const { google, signIn } = fixture();
    const server = await startServer({ port: 0, token: "t", googleSignIn: (p) => signIn.finish(p) });
    try {
      const back = google.authorize(signIn.start({ owner_agent_id: "agent-work" }));
      const res = await fetch(`http://127.0.0.1:${server.port}${GOOGLE_OAUTH_CALLBACK}?${new URLSearchParams(back).toString()}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Connected ada@acme.com");
      const refused = await fetch(`http://127.0.0.1:${server.port}${GOOGLE_OAUTH_CALLBACK}?state=nope&code=x`);
      expect(refused.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
