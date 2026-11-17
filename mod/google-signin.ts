import { createHash, randomBytes } from "node:crypto";
import { messageOf } from "../core/errors.ts";
import { accountIdOf, type Accounts, type AccountRecord, type GoogleGrants } from "./accounts.ts";
import { GOOGLE_TIMEOUT_MS } from "./google-auth.ts";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  CONTACT_SCOPES,
  SERVICE_SCOPES,
  SHARED_APP_MISSING,
  SHARED_GOOGLE_APP,
  grantedContacts,
  grantedServices,
  isUsableApp,
  type GmailSecret,
  type GoogleApp,
} from "./google-app.ts";
import { DEFAULT_MOD_PORT } from "./paths.ts";

export const GOOGLE_OAUTH_CALLBACK = "/accounts/google/callback";

export const googleCallbackUrl = (port = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT)): string => `http://127.0.0.1:${port}${GOOGLE_OAUTH_CALLBACK}`;

export const GOOGLE_SCOPES = [...Object.values(SERVICE_SCOPES), ...Object.values(CONTACT_SCOPES), "openid", "https://www.googleapis.com/auth/userinfo.email"];

export const PENDING_SIGN_IN_MS = 10 * 60 * 1000;

/** Who signed in, from Google's own account service: it answers whichever services were ticked. */
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const START_AGAIN = "Start it again from Preferences › Accounts.";

export interface GoogleSignInStart {
  owner_agent_id: string;
  own_app?: GoogleApp;
  account_id?: string;
}

export interface GoogleSignInResult {
  ok: boolean;
  message: string;
  account?: AccountRecord;
}

export interface GoogleSignInOptions {
  accounts: Accounts;
  fetch?: typeof fetch;
  now?: () => Date;
  redirect?: string;
  sharedApp?: GoogleApp;
  timeout?: () => AbortSignal;
}

interface Pending {
  owner_agent_id: string;
  account_id?: string;
  app: GoogleApp;
  own: boolean;
  verifier: string;
  started: number;
}

export class GoogleSignIn {
  private readonly opts: GoogleSignInOptions;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: GoogleSignInOptions) {
    this.opts = opts;
  }

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private signal(): AbortSignal {
    return this.opts.timeout?.() ?? AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
  }

  private get redirect(): string {
    return this.opts.redirect ?? googleCallbackUrl();
  }

  start(input: GoogleSignInStart): string {
    if (!input.owner_agent_id) throw new Error("an account needs an owner: pick the agent it belongs to");
    const own = input.own_app !== undefined;
    const app = input.own_app ?? this.opts.sharedApp ?? SHARED_GOOGLE_APP;
    if (!isUsableApp(app)) throw new Error(own ? "your own Google app needs both its client id and its client secret" : SHARED_APP_MISSING);
    this.prune();
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, {
      owner_agent_id: input.owner_agent_id,
      ...(input.account_id ? { account_id: input.account_id } : {}),
      app,
      own,
      verifier,
      started: this.now(),
    });
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: this.redirect,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      include_granted_scopes: "true",
      // A refresh token, every time: Google gives one only on a consent, and the watcher needs it to keep reading.
      access_type: "offline",
      prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    }).toString();
    return url.href;
  }

  async finish(params: Record<string, string>): Promise<GoogleSignInResult> {
    const pending = params.state ? this.pending.get(params.state) : undefined;
    if (!pending) return { ok: false, message: `This sign-in is not one loki started, or it was already used. ${START_AGAIN}` };
    this.pending.delete(params.state);
    if (this.now() - pending.started > PENDING_SIGN_IN_MS) return { ok: false, message: `This sign-in took longer than 10 minutes. ${START_AGAIN}` };
    if (params.error) return { ok: false, message: `Google did not sign you in: ${params.error_description || params.error}` };
    if (!params.code) return { ok: false, message: `Google sent no code to sign in with. ${START_AGAIN}` };
    try {
      const tokens = await this.redeem(params.code, pending);
      const address = await this.address(tokens.access_token);
      const secret: GmailSecret = { ...tokens, ...(pending.own ? { own_app: pending.app } : {}) };
      const grants: GoogleGrants =
        tokens.scopes === undefined
          ? { services: ["gmail"], contacts: [] }
          : { services: grantedServices(tokens.scopes), contacts: grantedContacts(tokens.scopes) };
      const account = await this.connect(address, pending, JSON.stringify(secret), grants);
      return { ok: true, message: `Connected ${address}. You can close this tab and go back to loki.`, account };
    } catch (error) {
      return { ok: false, message: `Gmail did not connect: ${messageOf(error)}` };
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [state, p] of this.pending) if (now - p.started > PENDING_SIGN_IN_MS) this.pending.delete(state);
  }

  private async redeem(code: string, pending: Pending): Promise<Omit<GmailSecret, "own_app">> {
    const res = await (this.opts.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
        client_id: pending.app.client_id,
        client_secret: pending.app.client_secret,
        redirect_uri: this.redirect,
      }).toString(),
      signal: this.signal(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(
        typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `Google answered ${res.status}`,
      );
    const { access_token: access, refresh_token: refresh, expires_in: expiresIn, scope } = body;
    if (typeof access !== "string" || typeof refresh !== "string" || typeof expiresIn !== "number") throw new Error("Google gave no tokens to keep");
    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: new Date(this.now() + expiresIn * 1000).toISOString(),
      ...(typeof scope === "string" ? { scopes: scope } : {}),
    };
  }

  /**
   * The account's own address, from Google's account service, so the account is the one the tokens act for. Not from
   * Gmail: a person who unticked Gmail still gets a message naming the account.
   */
  private async address(accessToken: string): Promise<string> {
    const res = await (this.opts.fetch ?? fetch)(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: this.signal() });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.email !== "string" || !body.email) throw new Error(`Google would not say which account this is (${res.status})`);
    return body.email;
  }

  private async connect(address: string, pending: Pending, secret: string, grants: GoogleGrants): Promise<AccountRecord> {
    const accountId = accountIdOf({ provider: "gmail", address });
    const wanted = pending.account_id;
    if (wanted && wanted !== accountId)
      throw new Error(`you signed in as ${address.toLowerCase()}, not ${wanted.replace(/^gmail:/, "")}: nothing was changed. Sign in again as that account.`);
    if (!grants.services.includes("gmail"))
      throw new Error(
        "Gmail was unticked on Google's page, and loki needs it to read this mailbox: nothing was changed. Sign in again and leave Gmail ticked.",
      );
    const existing = this.opts.accounts.get(accountId);
    if (existing && (existing.status !== "connected" || wanted)) return this.opts.accounts.signedIn(accountId, secret, grants);
    return this.opts.accounts.add(
      { account_id: accountId, provider: "gmail", address: address.toLowerCase(), owner_agent_id: pending.owner_agent_id, ...grants },
      secret,
    );
  }
}
