import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { DEFAULT_MOD_PORT, MCP_OAUTH_CALLBACK } from "../../mod/paths.ts";

export const callbackUrl = (port = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT)): string => `http://127.0.0.1:${port}${MCP_OAUTH_CALLBACK}`;

type Kind = "tokens" | "client" | "verifier";
export interface OauthSecrets {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete?(account: string): Promise<void>;
}

export class OauthStore {
  private readonly memory = new Map<string, string>();
  private readonly secrets: OauthSecrets | null;

  constructor(secrets: OauthSecrets | null) {
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
    const secrets = this.secrets;
    for (const kind of kinds) this.memory.delete(this.account(server, kind));
    if (!secrets) return;
    await Promise.all(
      kinds.map((kind) => (secrets.delete ? secrets.delete(this.account(server, kind)) : secrets.set(this.account(server, kind), "")).catch(() => {})),
    );
  }
}

export const oauthKey = (server: string, url: string): string => `${server}.${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;

export class ServerOauth implements OAuthClientProvider {
  private lastState: string | null = null;
  private registered = false;
  readonly server: string;
  private readonly key: string;
  private readonly store: OauthStore;
  private readonly onRedirect: (server: string, url: URL, state: string) => void;
  private readonly redirect: string;

  constructor(
    server: string,
    serverUrl: string,
    store: OauthStore,
    onRedirect: (server: string, url: URL, state: string) => void,
    redirect: string = callbackUrl(),
  ) {
    this.server = server;
    this.key = oauthKey(server, serverUrl);
    this.store = store;
    this.onRedirect = onRedirect;
    this.redirect = redirect;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "loki",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.lastState = randomBytes(16).toString("hex");
    return this.lastState;
  }

  /**
   * loki's registration with the server, used only while it is known good: tokens were issued to it, or this daemon
   * made it for the sign-in under way. One kept from a sign-in that never finished may since have been forgotten by the
   * server, which says so only on its own page in the browser, where loki never hears of it; so a new sign-in registers
   * again. A registration made for another callback address (loki on another port) is not this client either.
   */
  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const client = await this.store.get<StoredOAuthClientInformation & { redirect_uris?: string[] }>(this.key, "client");
    if (client?.redirect_uris && !client.redirect_uris.includes(this.redirect)) return undefined;
    if (client && !this.registered && !(await this.store.get(this.key, "tokens"))) return undefined;
    return client;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    await this.store.set(this.key, "client", { redirect_uris: [this.redirect], ...info });
    this.registered = true;
  }

  tokens(): Promise<StoredOAuthTokens | undefined> {
    return this.store.get<StoredOAuthTokens>(this.key, "tokens");
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.store.set(this.key, "tokens", tokens);
  }

  redirectToAuthorization(url: URL): void {
    this.onRedirect(this.server, url, this.lastState ?? url.searchParams.get("state") ?? "");
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.set(this.key, "verifier", verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.store.get<string>(this.key, "verifier");
    if (!v) throw new Error("no sign-in is under way for this server; start it again from Preferences › MCP servers");
    return v;
  }

  async signOut(): Promise<void> {
    this.registered = false;
    await this.store.delete(this.key, ["tokens", "verifier", "client"]);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "discovery") return;
    if (scope === "all" || scope === "client") this.registered = false;
    await this.store.delete(this.key, scope === "all" ? ["tokens", "client", "verifier"] : [scope]);
  }
}
