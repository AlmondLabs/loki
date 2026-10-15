import { randomBytes } from "node:crypto";
import type { OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { DEFAULT_MOD_PORT, MCP_OAUTH_CALLBACK } from "../../mod/paths.ts";

/**
 * Signing in to a remote MCP server (OAuth 2.1 with PKCE, as MCP's authorization spec has it). The SDK does the
 * protocol: it finds the server's authorization server, registers loki as a client when the server allows it, and
 * redeems codes and refreshes tokens. This is what it keeps and where the browser goes. A sign-in opens the server's
 * authorization page; the browser comes back to loki's loopback server at MCP_OAUTH_CALLBACK, the one address a
 * registration names, matched by a one-time `state`; the tokens, the registration and the PKCE verifier are kept
 * per server in the keychain (in memory when there is none, which lasts until the daemon stops).
 */

/** Where the browser comes back to, on the loopback server the mod serves (mod/server.ts). */
export const callbackUrl = (port = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT)): string => `http://127.0.0.1:${port}${MCP_OAUTH_CALLBACK}`;

/** What a sign-in keeps, by kind, as JSON in the keychain under `mcp-oauth.<server>.<kind>`. */
type Kind = "tokens" | "client" | "verifier";
export type OAuthSecrets = { get(account: string): Promise<string | null>; set(account: string, value: string): Promise<void>; delete?(account: string): Promise<void> };

export class OAuthStore {
  private readonly memory = new Map<string, string>();
  private readonly secrets: OAuthSecrets | null;

  constructor(secrets: OAuthSecrets | null) {
    this.secrets = secrets;
  }

  private account = (server: string, kind: Kind) => `mcp-oauth.${server}.${kind}`;

  async get<T>(server: string, kind: Kind): Promise<T | undefined> {
    const raw = this.secrets ? await this.secrets.get(this.account(server, kind)).catch(() => null) : (this.memory.get(this.account(server, kind)) ?? null);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set(server: string, kind: Kind, value: unknown): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.secrets) await this.secrets.set(this.account(server, kind), raw);
    else this.memory.set(this.account(server, kind), raw);
  }

  async delete(server: string, kinds: Kind[] = ["tokens", "client", "verifier"]): Promise<void> {
    for (const kind of kinds) {
      this.memory.delete(this.account(server, kind));
      // A keychain without delete gets an empty value, which reads as nothing.
      if (this.secrets) await (this.secrets.delete ? this.secrets.delete(this.account(server, kind)) : this.secrets.set(this.account(server, kind), "")).catch(() => {});
    }
  }
}

/** One remote server's side of the flow, as the SDK's transport and `auth()` ask for it. */
export class ServerOAuth implements OAuthClientProvider {
  private lastState: string | null = null;
  readonly server: string;
  private readonly store: OAuthStore;
  /** The authorization page to send the person to, and the state it carries: Settings shows "sign in". */
  private readonly onRedirect: (server: string, url: URL, state: string) => void;
  private readonly redirect: string;

  constructor(server: string, store: OAuthStore, onRedirect: (server: string, url: URL, state: string) => void, redirect: string = callbackUrl()) {
    this.server = server;
    this.store = store;
    this.onRedirect = onRedirect;
    this.redirect = redirect;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "loki", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  state(): string {
    this.lastState = randomBytes(16).toString("hex");
    return this.lastState;
  }

  /** A registration made for another callback address (loki on another port) is not this client: register again. */
  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const client = await this.store.get<StoredOAuthClientInformation & { redirect_uris?: string[] }>(this.server, "client");
    if (client?.redirect_uris && !client.redirect_uris.includes(this.redirect)) return undefined;
    return client;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    await this.store.set(this.server, "client", { redirect_uris: [this.redirect], ...info });
  }

  tokens(): Promise<StoredOAuthTokens | undefined> {
    return this.store.get<StoredOAuthTokens>(this.server, "tokens");
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.store.set(this.server, "tokens", tokens);
  }

  redirectToAuthorization(url: URL): void {
    this.onRedirect(this.server, url, this.lastState ?? url.searchParams.get("state") ?? "");
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.set(this.server, "verifier", verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.store.get<string>(this.server, "verifier");
    if (!v) throw new Error("no sign-in is under way for this server; start it again from Settings › MCP");
    return v;
  }

  /** The server said what it holds is no longer good (a revoked token, a forgotten registration): forget it. */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "discovery") return;
    await this.store.delete(this.server, scope === "all" ? ["tokens", "client", "verifier"] : [scope]);
  }
}
