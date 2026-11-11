import type { GoogleService } from "../core/frame-types.ts";
import type { Accounts } from "./accounts.ts";
import { GOOGLE_TOKEN_URL, SHARED_GOOGLE_APP, grantedServices, parseGmailSecret, type GmailSecret, type GoogleApp } from "./google-app.ts";

/**
 * One Google account's sign-in, shared by everything that calls Google for it (plan 2026-11-11 scripts, KTD8): the Gmail
 * client its watcher and Flow use, and the Google tools scripts call. It reads the tokens from the keychain, refreshes
 * them there (one refresh at a time, whoever asks), keeps the account's granted services as Google reports them, and
 * marks the account disconnected when only a new sign-in helps. `request` adds the token to any call on Google's APIs:
 * every method, JSON or raw bodies, JSON or byte answers. Nothing here hands the token out.
 */

/** An access token this close to its expiry is refreshed first, so a call does not start with one about to lapse. */
const EXPIRY_MARGIN_MS = 60 * 1000;
/**
 * How long one call to Google may take, as SlackClient allows: a call that hangs past it fails that tick, which the
 * next tick tries again, instead of holding the account's sync until loki restarts. A transfer passes its own.
 */
export const GOOGLE_TIMEOUT_MS = 20_000;
/** The reasons Google gives when a Workspace admin has not allowed the app. */
const ADMIN_REASONS = ["admin_policy_enforced"];
/** The reasons Google gives when the token lacks the scope a call needs: the person did not grant that service. */
const SCOPE_REASONS = ["insufficientpermissions", "access_token_scope_insufficient"];

/** Each service by the name the person knows it by. */
export const GOOGLE_SERVICE_NAME: Readonly<Record<GoogleService, string>> = {
  gmail: "Gmail",
  drive: "Drive",
  sheets: "Sheets",
  docs: "Docs",
  calendar: "Calendar",
};

/** A call Google refused, with its status and Google's first reason; a missing service's says which. */
export class GoogleError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(message: string, status: number, reason: string | null) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
    this.reason = reason;
  }
}

/** What GoogleAuth is built from; fetch, the clock and the timeout are injected so tests own them. */
export interface GoogleAuthOptions {
  accounts: Accounts;
  account_id: string;
  /** The app to refresh with when the account was signed in with the shared one (SHARED_GOOGLE_APP). */
  sharedApp?: GoogleApp;
  fetch?: typeof fetch;
  now?: () => Date;
  /** A fresh signal for each call, aborted after `ms`; tests pass one they abort themselves. */
  timeout?: (ms: number) => AbortSignal;
}

/** One call on a Google API: the service it belongs to (for the missing-service message), and what to send. */
export interface GoogleRequest {
  service: GoogleService;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The whole URL, on a Google API host. */
  url: string;
  query?: Record<string, string>;
  /** A JSON body. */
  json?: unknown;
  /** A raw body and its type, for an upload. */
  body?: { data: Uint8Array<ArrayBuffer> | string; type: string };
  headers?: Record<string, string>;
  /** How long the call may take; a transfer passes more than GOOGLE_TIMEOUT_MS. */
  timeoutMs?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** Google's reasons for a refusal, from either shape of its error answers (OAuth's string, the APIs' object). */
export function reasonsOf(body: Record<string, unknown>): string[] {
  if (typeof body.error === "string") return [body.error];
  const e = rec(body.error);
  return [...list(e.errors).map((x) => str(rec(x).reason)), ...list(e.details).map((x) => str(rec(x).reason)), str(e.status)].filter(Boolean);
}
const isAdminBlock = (reasons: string[]) => reasons.some((r) => ADMIN_REASONS.includes(r.toLowerCase()));
const isMissingScope = (reasons: string[]) => reasons.some((r) => SCOPE_REASONS.includes(r.toLowerCase()));

/** The words for a service the account has not granted, which the row in Preferences › Accounts offers to fix. */
export const signInAgainFor = (service: GoogleService): string =>
  `this Google account has not let loki use ${GOOGLE_SERVICE_NAME[service]}: sign in again for it in Preferences › Accounts`;

/** One Google account's tokens and calls. */
export class GoogleAuth {
  private readonly opts: GoogleAuthOptions;
  private secret: GmailSecret | null = null;
  /** The refresh under way, which every caller that finds the token lapsed waits on. */
  private refreshing: Promise<string> | null = null;

  constructor(opts: GoogleAuthOptions) {
    this.opts = opts;
  }

  /** The account this signs in, as `accountIdOf` names it. */
  get accountId(): string {
    return this.opts.account_id;
  }

  /** The services the account granted, as its record says; Gmail alone for one signed in before loki asked for more. */
  services(): GoogleService[] {
    return this.opts.accounts.get(this.opts.account_id)?.services ?? ["gmail"];
  }

  /**
   * A call with a good access token: a 401 refreshes the token once and tries again. A refusal throws GoogleError with
   * Google's message; a missing service says to sign in again for it (the account stays connected), and an admin's
   * block marks the account disconnected. Answers with the response, its body unread.
   */
  async send(req: GoogleRequest): Promise<Response> {
    const url = `${req.url}${req.query ? `?${new URLSearchParams(req.query).toString()}` : ""}`;
    const body = req.json !== undefined ? JSON.stringify(req.json) : req.body?.data;
    const type = req.json !== undefined ? "application/json" : req.body?.type;
    const call = (token: string) =>
      this.fetch(url, {
        method: req.method,
        headers: { authorization: `Bearer ${token}`, ...(type ? { "content-type": type } : {}), ...req.headers },
        ...(body === undefined ? {} : { body }),
        signal: this.signal(req.timeoutMs ?? GOOGLE_TIMEOUT_MS),
      });
    let res = await call(await this.accessToken());
    if (res.status === 401) res = await call(await this.refresh());
    if (res.ok) return res;
    const answer = rec(await res.json().catch(() => ({})));
    const reasons = reasonsOf(answer);
    if (res.status === 403 && isAdminBlock(reasons)) {
      this.disconnect("admin_blocks");
      throw new GoogleError("your Google admin blocks this app: use your own Google app in Preferences › Accounts", res.status, reasons[0] ?? null);
    }
    if (res.status === 403 && isMissingScope(reasons)) throw new GoogleError(signInAgainFor(req.service), res.status, "insufficient_scope");
    throw new GoogleError(str(rec(answer.error).message) || `${GOOGLE_SERVICE_NAME[req.service]} answered ${res.status}`, res.status, reasons[0] ?? null);
  }

  /** A call whose answer is JSON; an empty answer (a 204) is `{}`. */
  async json(req: GoogleRequest): Promise<unknown> {
    const res = await this.send(req);
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GoogleError(`${GOOGLE_SERVICE_NAME[req.service]} answered with something that is not JSON`, res.status, null);
    }
  }

  /** A call whose answer is bytes: a file's content or an export. */
  async bytes(req: GoogleRequest): Promise<Uint8Array> {
    const res = await this.send(req);
    return new Uint8Array(await res.arrayBuffer());
  }

  // --- tokens -------------------------------------------------------------------------------------------------------

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private signal(ms: number): AbortSignal {
    return this.opts.timeout?.(ms) ?? AbortSignal.timeout(ms);
  }

  private async load(): Promise<GmailSecret> {
    if (this.secret) return this.secret;
    const secret = parseGmailSecret(await this.opts.accounts.getSecret(this.opts.account_id));
    if (!secret) {
      this.disconnect("sign_in_again");
      throw new GoogleError("this Google account keeps no sign-in: sign in again", 401, null);
    }
    this.secret = secret;
    return secret;
  }

  /** The access token, refreshed first when it has lapsed or is about to. */
  private async accessToken(): Promise<string> {
    const secret = await this.load();
    if (Date.parse(secret.expires_at) - EXPIRY_MARGIN_MS <= this.now() || !secret.access_token) return this.refresh();
    return secret.access_token;
  }

  /** A new access token; callers that ask while one is being fetched share it, so the keychain is written once. */
  private refresh(): Promise<string> {
    this.refreshing ??= this.refreshNow().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /**
   * A new access token from the refresh token, kept in the keychain with the scopes Google now reports. Google refusing
   * the refresh token (`invalid_grant`: revoked, expired, or the password changed) means only a new sign-in helps, and
   * the account says so.
   */
  private async refreshNow(): Promise<string> {
    const secret = await this.load();
    const app = secret.own_app ?? this.opts.sharedApp ?? SHARED_GOOGLE_APP;
    const res = await this.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: secret.refresh_token,
        client_id: app.client_id,
        client_secret: app.client_secret,
      }).toString(),
      signal: this.signal(GOOGLE_TIMEOUT_MS),
    });
    const answer = rec(await res.json().catch(() => ({})));
    if (!res.ok) {
      const reasons = reasonsOf(answer);
      if (isAdminBlock(reasons)) {
        this.disconnect("admin_blocks");
        throw new GoogleError("your Google admin blocks this app: use your own Google app in Preferences › Accounts", res.status, reasons[0] ?? null);
      }
      if (reasons.includes("invalid_grant")) {
        this.disconnect("sign_in_again");
        throw new GoogleError("Google asks you to sign in again", res.status, "invalid_grant");
      }
      throw new GoogleError(`Google would not refresh the sign-in (${res.status})`, res.status, reasons[0] ?? null);
    }
    const access = str(answer.access_token);
    const expiresIn = typeof answer.expires_in === "number" ? answer.expires_in : 0;
    if (!access) throw new GoogleError("Google gave no access token", res.status, null);
    const scopes = str(answer.scope);
    // Google may hand out a new refresh token; the newest one is the one that keeps working.
    const next: GmailSecret = {
      ...secret,
      access_token: access,
      refresh_token: str(answer.refresh_token) || secret.refresh_token,
      expires_at: new Date(this.now() + expiresIn * 1000).toISOString(),
      ...(scopes ? { scopes } : {}),
    };
    await this.opts.accounts.setSecret(this.opts.account_id, JSON.stringify(next));
    this.secret = next;
    if (scopes) this.keepServices(grantedServices(scopes));
    return access;
  }

  /** The account's services as Google now reports them, written only when they changed (the person took one back). */
  private keepServices(services: GoogleService[]): void {
    const account = this.opts.accounts.get(this.opts.account_id);
    if (!account) return;
    const had = account.services ?? ["gmail"];
    if (had.length === services.length && had.every((s) => services.includes(s))) return;
    this.opts.accounts.setServices(this.opts.account_id, services);
  }

  /** Mark the account disconnected with why, unless it already says so; an account no longer here is left alone. */
  private disconnect(cause: "sign_in_again" | "admin_blocks"): void {
    // A sign-in made again later writes new tokens to the keychain: read them then, not the ones that stopped working.
    this.secret = null;
    const account = this.opts.accounts.get(this.opts.account_id);
    if (!account) return;
    if (typeof account.status === "object" && account.status.disconnected === cause) return;
    this.opts.accounts.setStatus(this.opts.account_id, { disconnected: cause });
  }
}
