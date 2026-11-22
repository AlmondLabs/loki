import type { GoogleService } from "../core/frame-types.ts";
import { contactsOf, servicesOf, type Accounts, type GoogleGrants } from "./accounts.ts";
import { GOOGLE_TOKEN_URL, SHARED_GOOGLE_APP, grantedContacts, grantedServices, parseGmailSecret, type GmailSecret, type GoogleApp } from "./google-app.ts";

const EXPIRY_MARGIN_MS = 60 * 1000;
export const GOOGLE_TIMEOUT_MS = 20_000;
/** The reasons Google gives when a Workspace admin has not allowed the app. */
const ADMIN_REASONS = ["admin_policy_enforced"];
/** The reasons Google gives when the token lacks the scope a call needs: the person did not grant that service. */
const SCOPE_REASONS = ["insufficientpermissions", "access_token_scope_insufficient"];

export const GOOGLE_SERVICE_NAME: Readonly<Record<GoogleService, string>> = {
  gmail: "Gmail",
  drive: "Drive",
  sheets: "Sheets",
  docs: "Docs",
  calendar: "Calendar",
};

export type GoogleCallFor = GoogleService | "contacts";

const callName = (what: GoogleCallFor): string => (what === "contacts" ? "Google Contacts" : GOOGLE_SERVICE_NAME[what]);

export const CONTACTS_NOT_ALLOWED = "this Google account has not let loki look up people: sign in again in Preferences › Accounts";

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

export interface GoogleAuthOptions {
  accounts: Accounts;
  account_id: string;
  sharedApp?: GoogleApp;
  fetch?: typeof fetch;
  now?: () => Date;
  timeout?: (ms: number) => AbortSignal;
}

export interface GoogleRequest {
  service: GoogleCallFor;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  query?: Record<string, string>;
  json?: unknown;
  body?: { data: Uint8Array<ArrayBuffer> | string; type: string };
  headers?: Record<string, string>;
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

export const signInAgainFor = (service: GoogleService): string =>
  `this Google account has not let loki use ${GOOGLE_SERVICE_NAME[service]}: sign in again for it in Preferences › Accounts`;

export class GoogleAuth {
  private readonly opts: GoogleAuthOptions;
  private secret: GmailSecret | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(opts: GoogleAuthOptions) {
    this.opts = opts;
  }

  get accountId(): string {
    return this.opts.account_id;
  }

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
    if (res.status === 403 && isMissingScope(reasons))
      throw new GoogleError(req.service === "contacts" ? CONTACTS_NOT_ALLOWED : signInAgainFor(req.service), res.status, "insufficient_scope");
    throw new GoogleError(str(rec(answer.error).message) || `${callName(req.service)} answered ${res.status}`, res.status, reasons[0] ?? null);
  }

  async json(req: GoogleRequest): Promise<unknown> {
    const res = await this.send(req);
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GoogleError(`${callName(req.service)} answered with something that is not JSON`, res.status, null);
    }
  }

  async bytes(req: GoogleRequest): Promise<Uint8Array> {
    const res = await this.send(req);
    return new Uint8Array(await res.arrayBuffer());
  }

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

  private async accessToken(): Promise<string> {
    const secret = await this.load();
    if (Date.parse(secret.expires_at) - EXPIRY_MARGIN_MS <= this.now() || !secret.access_token) return this.refresh();
    return secret.access_token;
  }

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
    // Outside (Google): Google may hand out a new refresh token; the newest one is the one that keeps working.
    const next: GmailSecret = {
      ...secret,
      access_token: access,
      refresh_token: str(answer.refresh_token) || secret.refresh_token,
      expires_at: new Date(this.now() + expiresIn * 1000).toISOString(),
      ...(scopes ? { scopes } : {}),
    };
    await this.opts.accounts.setSecret(this.opts.account_id, JSON.stringify(next));
    this.secret = next;
    if (scopes) this.keepGrants({ services: grantedServices(scopes), contacts: grantedContacts(scopes) });
    return access;
  }

  private keepGrants(grants: GoogleGrants): void {
    const account = this.opts.accounts.get(this.opts.account_id);
    if (!account) return;
    const same = (had: readonly string[], now: readonly string[]) => had.length === now.length && had.every((s) => now.includes(s));
    if (same(servicesOf(account), grants.services) && same(contactsOf(account), grants.contacts)) return;
    this.opts.accounts.setGrants(this.opts.account_id, grants);
  }

  private disconnect(cause: "sign_in_again" | "admin_blocks"): void {
    this.secret = null;
    const account = this.opts.accounts.get(this.opts.account_id);
    if (!account) return;
    if (typeof account.status === "object" && account.status.disconnected === cause) return;
    this.opts.accounts.setStatus(this.opts.account_id, { disconnected: cause });
  }
}
