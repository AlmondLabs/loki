import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineExtension,
  defineTool,
  section,
  type Conversation,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerView, McpView } from "../../core/frame-types.ts";
import { AgentInfoDoc, ChatDoc, type AgentStore } from "../kernel/index.ts";
import { auth } from "@modelcontextprotocol/client";
import type * as acp from "@agentclientprotocol/sdk";
import { commandPath } from "../acp/agents.ts";
import { editServer, keychainRef, readConfig, setAlwaysLoad, withSecrets, type ServerConfig, type ServerEdit } from "./config.ts";
import { OauthStore, ServerOauth, callbackUrl } from "./oauth.ts";
import { toolResultsDir } from "../tool-results.ts";
import { mapResult } from "./results.ts";
import { rank, selected } from "./search.ts";
import { McpServers, type McpTool } from "./servers.ts";

/**
 * MCP on loki's daemon (the `loki.mcp` extension). Every connected server's tools are registered once, named
 * `mcp__<server>__<tool>`, but a chat starts with none of them: its tool filter hides each one until `mcp_search` finds
 * it, and pi-durable's `addTools` control (in the search's result) shows it from the chat's next step, as a real tool
 * with its real schema. Up front every chat sees only the `mcp` section: each server, what it is for, and the bare
 * names of its tools, so the agent knows what to search for. Adding servers never fills the context: Claude Code's
 * and Cursor's answer to MCP tool bloat. A server's `alwaysLoad` tools skip the search. Loaded tools stay for the chat;
 * /clear and a compaction unload them (`forget`). Big results spill to `<loki>/tool-results/<chat>/`.
 */

/** How many of a server's tool names the section lists before "… and n more". */
const NAMES_LISTED = 60;
/** How many tools a free-text search loads. */
const SEARCH_LIMIT = 5;

/** The name of the tool that finds MCP tools and loads them into a chat. */
export const SEARCH_TOOL = "mcp_search";

type Capture = (event: string, properties: Record<string, unknown>) => void;
/** Where `${keychain:…}` secrets live: the daemon's keychain (daemon/credentials.ts SecretBackend), under mcp.<name>. */
export interface Secrets {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete?(account: string): Promise<void>;
}

/** A remote server signs in with OAuth unless its headers carry its own Authorization. */
export const usesOauth = (c: ServerConfig): boolean => c.kind === "remote" && !Object.keys(c.headers).some((h) => h.toLowerCase() === "authorization");

/** About how many tokens a tool's definition costs once loaded (four characters a token). */
export const toolTokens = (t: McpTool): number => Math.ceil(JSON.stringify({ name: t.key, description: t.description, parameters: t.inputSchema }).length / 4);

/**
 * The `loki.mcp` extension and its settings: registers the connected servers' tools and the
 * search, keeps each chat's tool filter, the servers switched off per agent and the OAuth sign-ins, and answers the
 * MCP part of Settings (McpView).
 */
export class McpTools {
  readonly servers: McpServers;
  private readonly registry: Registry;
  private readonly configPath: string;
  private readonly lokiDir: string;
  private readonly report: (message: string) => void;
  private capture: Capture = () => {};
  private problems: string[] = [];
  private installTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;
  private readonly secrets: Secrets | null;
  /** Each agent's switched-off servers (Agents › Profile), kept in `<loki>/state/mcp-agents.json`. */
  private readonly offPath: string;
  private off: Record<string, string[]>;
  // Sign-ins (daemon/mcp/oauth.ts): each remote server's provider, the page each waiting one sends you to, the state
  // each page carries (one-time, matched when the browser comes back), and the servers known to hold a token.
  private readonly oauthStore: OauthStore;
  private readonly providers = new Map<string, ServerOauth>();
  private readonly signInUrls = new Map<string, string>();
  private readonly pendingStates = new Map<string, string>();
  private readonly signedIn = new Set<string>();
  private readonly redirect: string;

  constructor(opts: {
    registry: Registry;
    configPath: string;
    lokiDir: string;
    report?: (message: string) => void;
    servers?: McpServers;
    version?: string;
    secrets?: Secrets;
    redirect?: string;
  }) {
    this.registry = opts.registry;
    this.configPath = opts.configPath;
    this.lokiDir = opts.lokiDir;
    this.report = opts.report ?? (() => {});
    this.secrets = opts.secrets ?? null;
    this.offPath = join(opts.lokiDir, "state", "mcp-agents.json");
    this.off = readOff(this.offPath);
    this.oauthStore = new OauthStore(this.secrets);
    this.redirect = opts.redirect ?? callbackUrl();
    const secrets = this.secrets;
    this.servers =
      opts.servers ??
      new McpServers({
        report: this.report,
        ...(opts.version ? { version: opts.version } : {}),
        resolve: (c) => withSecrets(c, (name) => (secrets ? secrets.get(`mcp.${name}`) : Promise.resolve(null))),
        oauthFor: (c) => this.oauthFor(c),
      });
    // A server connecting, failing or changing its tools re-registers the extension (once per burst of changes).
    this.servers.onChange(() => {
      if (this.installTimer) return;
      this.installTimer = setTimeout(() => {
        this.installTimer = null;
        this.install();
      }, 0);
      this.installTimer.unref();
    });
    this.install();
  }

  /** Product analytics for searches and calls (the daemon's analytics is made after the tools are). */
  setCapture(capture: Capture): void {
    this.capture = capture;
  }

  /** Read the config and connect, then follow the file: an edit reconnects only the servers it changed. */
  start(): void {
    this.reload();
    if (this.watching) return;
    this.watching = true;
    watchFile(this.configPath, { interval: 2000, persistent: false }, () => this.reload());
  }

  reload(): void {
    const config = readConfig(this.configPath);
    this.problems = config.problems;
    for (const p of config.problems) this.report(`mcp: ${p}`);
    this.servers.configure(config.servers);
  }

  async close(): Promise<void> {
    if (this.watching) unwatchFile(this.configPath);
    this.watching = false;
    if (this.installTimer) clearTimeout(this.installTimer);
    await this.servers.close();
  }

  /** The permission kind's input for a tool name (daemon/approvals.ts kindOf): MCP's own hints; the search only reads. */
  annotations(name: string): { readOnly?: boolean; destructive?: boolean } | undefined {
    if (name === SEARCH_TOOL) return { readOnly: true };
    if (!name.startsWith("mcp__")) return undefined;
    const tool = this.servers.tools().find((t) => t.key === name);
    return tool ? { readOnly: tool.readOnly, destructive: tool.destructive } : undefined;
  }

  /** The servers an agent has switched off. */
  offFor(agentId: string | null | undefined): Set<string> {
    return new Set(agentId ? (this.off[agentId] ?? []) : []);
  }

  /**
   * The servers an agent has on, as an ACP session takes them (plan 042): the agent connects to each itself, with its
   * `${keychain:…}` values filled in, and signs in itself to one that wants OAuth (loki's sign-in stays loki's). A
   * local server's command goes by its full path, as ACP names it. A local server with its own folder (ACP has no
   * field for one), or whose command or secret cannot be found, is left out with a line in the daemon's log.
   */
  async acpServers(agentId: string): Promise<acp.McpServer[]> {
    const off = this.offFor(agentId);
    const secrets = this.secrets;
    const out: acp.McpServer[] = [];
    for (const config of this.servers.configs().filter((c) => !off.has(c.name))) {
      try {
        const c = await withSecrets(config, (name) => (secrets ? secrets.get(`mcp.${name}`) : Promise.resolve(null)));
        const pairs = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));
        if (c.kind === "remote") {
          out.push({ type: "http", name: c.name, url: c.url, headers: pairs(c.headers) });
          continue;
        }
        if (c.cwd) throw new Error("it runs in its own folder, which an ACP agent cannot be told");
        const command = commandPath(c.command);
        if (!command) throw new Error(`${c.command} is not on the PATH`);
        out.push({ name: c.name, command, args: c.args, env: pairs(c.env) });
      } catch (e) {
        this.report(`MCP server ${config.name} left out of ACP chats: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  /** The tools that only read, of the servers an agent has on, as an ACP agent names them: it runs them without asking. */
  acpReadOnly(agentId: string): string[] {
    return this.toolsFor(agentId)
      .filter((t) => t.readOnly)
      .map((t) => `mcp__${t.server}__${t.name}`);
  }

  /** The tools an agent can use: its switched-off servers' left out. */
  private toolsFor(agentId: string | null | undefined): McpTool[] {
    const off = this.offFor(agentId);
    return this.servers.tools().filter((t) => !off.has(t.server));
  }

  /** What a chat of `agentId` sees up front: its servers and their tools' names, or nothing when it has none. */
  sectionText(agentId?: string | null): string | undefined {
    const off = this.offFor(agentId);
    const status = this.servers.status().filter((s) => !off.has(s.name));
    if (!status.length && !this.problems.length) return undefined;
    const tools = this.toolsFor(agentId);
    const lines = status.map((s) => {
      if (s.state === "down") return `- ${s.name}: down (${s.error ?? "not connected"})`;
      if (s.state === "signin") return `- ${s.name}: needs the person to sign in (Preferences › MCP servers); its tools are not available until then`;
      if (s.state === "starting") return `- ${s.name}: starting`;
      const names = tools.filter((t) => t.server === s.name).map((t) => t.name);
      const listed = names.slice(0, NAMES_LISTED).join(", ") + (names.length > NAMES_LISTED ? `, … and ${names.length - NAMES_LISTED} more` : "");
      return `- ${s.name}${s.purpose ? `: ${s.purpose}` : ""} (${names.length} tool${names.length === 1 ? "" : "s"}): ${listed}`;
    });
    return [
      `MCP servers connected to loki. Their tools are not loaded until you need them: call ${SEARCH_TOOL} with what you want to do, or "select:server.tool" for one you know, and the tools it finds become available from your next step.`,
      ...lines,
      ...this.problems.map((p) => `- config problem: ${p}`),
    ].join("\n");
  }

  /** Register the current tools (and the search and the section) as `loki.mcp`, replacing the last registration. */
  install(): void {
    this.registry.install(this.extension());
  }

  private extension(): Extension {
    return defineExtension({
      name: "loki.mcp",
      sections: [section("mcp", async (input, context) => this.sectionText((await input.read.snapshot(AgentInfoDoc, context))?.id))],
      tools: [this.searchTool(), ...this.servers.tools().map((t) => this.callTool(t))],
    });
  }

  private searchTool(): ToolRegistration {
    return defineTool({
      name: SEARCH_TOOL,
      description:
        'Load MCP tools before using them. Describe what you want to do ("open pull requests on GitHub") and the best matching tools are loaded, or name exact ones with "select:server.tool" (comma-separated). Loaded tools are available from your next step and stay for this chat.',
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: 'What you need, or "select:server.tool, …"' } },
        required: ["query"],
      } as never,
      execute: async (args, api, context) => {
        const asked = (args as { query?: unknown }).query;
        const query = typeof asked === "string" ? asked : "";
        const all = this.toolsFor((await api.snapshot(AgentInfoDoc, context))?.id);
        const found = selected(query, all) ?? rank(query, all, SEARCH_LIMIT);
        this.capture("mcp_search", { hits: found.length, loaded: found.map((t) => t.key), select: query.trim().toLowerCase().startsWith("select:") });
        if (!found.length) {
          const servers = this.servers
            .status()
            .map((s) => `${s.name} (${s.state === "connected" ? `${s.tools} tools` : s.state})`)
            .join(", ");
          return {
            output: [
              {
                type: "text",
                text: `No MCP tool matches "${query}". Servers: ${servers || "none"}. Try other words, or "select:server.tool" with a name from the mcp section.`,
              },
            ],
          };
        }
        const lines = found.map((t) => `- ${t.key}: ${summary(t)}`);
        return {
          output: [{ type: "text", text: `Loaded ${found.length} tool${found.length === 1 ? "" : "s"}, available from your next step:\n${lines.join("\n")}` }],
          control: { addTools: found.map((t) => t.key) },
        };
      },
    });
  }

  private callTool(t: McpTool): ToolRegistration {
    return defineTool({
      name: t.key,
      description: `[${t.server}] ${t.title && !t.description.startsWith(t.title) ? `${t.title}: ` : ""}${t.description || t.name}`,
      parameters: t.inputSchema as never,
      execute: async (args, api, context) => {
        const started = Date.now();
        const spillDir = await toolResultsDir(this.lokiDir, api, api.conversationId, context);
        try {
          const input: unknown = args; // the model's arguments, as JSON: the schema is the server's, not typed here
          const result = await this.servers.call(t.key, (input ?? {}) as Record<string, unknown>, context.abortSignal);
          const mapped = mapResult(result, { spillDir, name: t.key });
          this.capture("mcp_call", {
            server: t.server,
            tool: t.name,
            ms: Date.now() - started,
            error: mapped.isError,
            spilled: mapped.spilled !== null,
            chars: mapped.chars,
          });
          return { output: mapped.content, isError: mapped.isError };
        } catch (error) {
          this.capture("mcp_call", { server: t.server, tool: t.name, ms: Date.now() - started, error: true, spilled: false, chars: 0 });
          throw error;
        }
      },
    });
  }

  /**
   * Set a chat's tool filter before it runs: every MCP tool hidden unless it was loaded in this chat (known when the
   * filter was last set, and not hidden since) or its server always loads it. A chat that names its tools outright (a
   * background pass's) is left alone. Writes only when something changed.
   */
  async prepare(store: AgentStore, chat: Conversation, context: Context): Promise<void> {
    const agentId = (await store.harness.snapshot(AgentInfoDoc, context))?.id;
    const off = this.offFor(agentId);
    const all = this.servers.tools().map((t) => t.key);
    // A switched-off server's tools are hidden whatever the chat loaded, and count as unknown, so switching it back
    // on does not bring back what the chat had: it searches again.
    const usable = new Set(
      this.servers
        .tools()
        .filter((t) => !off.has(t.server))
        .map((t) => t.key),
    );
    const settings = (await store.agentSettings(chat.id, context)) as { tools?: string[] | { remove: string[] } } | undefined;
    if (Array.isArray(settings?.tools)) return;
    const removed = settings?.tools?.remove ?? [];
    if (!all.length && !removed.some((n) => n.startsWith("mcp__"))) return;
    const info = await store.chatInfo(chat.id, context);
    const known = new Set(info?.mcpKnown ?? []);
    const hidden = new Set(removed);
    const always = this.servers.alwaysLoaded();
    const hide = all.filter((k) => !usable.has(k) || (!always.has(k) && !(known.has(k) && !hidden.has(k))));
    const next = [...removed.filter((n) => !n.startsWith("mcp__")), ...hide];
    const nowKnown = all.filter((k) => usable.has(k));
    const unchanged = sameSet(next, removed) && sameSet(nowKnown, [...known]);
    if (unchanged) return;
    const registered = new Map(
      this.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    );
    await chat.commit(async (tx) => {
      await configure(tx, chat.id, { tools: { remove: next.map((n) => registered.get(n) ?? ({ name: n } as ToolRegistration)) } });
      const doc = await tx.doc(ChatDoc, chat.id);
      doc.mcpKnown = nowKnown;
    }, context);
  }

  // --- Preferences › MCP servers and Agents › Profile ------------------------------------------------------------------------

  /** Everything Settings shows: each server with its state, tools and their costs, and who has it switched off. */
  view(): McpView {
    const status = new Map(this.servers.status().map((s) => [s.name, s]));
    const tools = this.servers.tools();
    const servers: McpServerView[] = this.servers.configs().map((c) => {
      const s = status.get(c.name);
      const mine = tools
        .filter((t) => t.server === c.name)
        .map((t) => ({
          name: t.name,
          description: t.description,
          read_only: t.readOnly,
          destructive: t.destructive,
          always_load: c.alwaysLoad.includes(t.name),
          tokens: toolTokens(t),
        }));
      return {
        name: c.name,
        entry: c.entry,
        kind: c.kind,
        state: s?.state ?? "starting",
        error: s?.error ?? null,
        purpose: s?.purpose ?? null,
        tools: mine,
        tokens: mine.reduce((n, t) => n + t.tokens, 0),
        config: c.kind === "local" ? { command: c.command, args: c.args, env: c.env, cwd: c.cwd } : { url: c.url, headers: c.headers },
        sign_in: usesOauth(c) ? { url: s?.state === "signin" ? (this.signInUrls.get(c.name) ?? null) : null, signed_in: this.signedIn.has(c.name) } : null,
        off_for: Object.entries(this.off)
          .filter(([, servers]) => servers.includes(c.name))
          .map(([agent]) => agent),
      };
    });
    return { servers, problems: this.problems, config_path: this.configPath };
  }

  /** Add, change, rename (`rename`) or remove (`edit` null) a server in mcp.json, and connect as it now says. */
  setServer(entry: string, edit: ServerEdit | null, rename?: string): McpView {
    editServer(this.configPath, entry, edit, rename ? { rename } : {});
    this.reload();
    return this.view();
  }

  setAlwaysLoad(entry: string, tools: string[]): McpView {
    setAlwaysLoad(this.configPath, entry, tools);
    this.reload();
    return this.view();
  }

  restart(name: string): McpView {
    this.servers.restart(name);
    return this.view();
  }

  /** Keep a secret in the keychain for mcp.json to name: the `${keychain:…}` reference to write instead of it. */
  async storeSecret(name: string, value: string): Promise<string> {
    if (!this.secrets) throw new Error("no keychain on this system; write the value into mcp.json instead");
    const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "secret";
    await this.secrets.set(`mcp.${safe}`, value);
    return keychainRef(safe);
  }

  // --- OAuth sign-ins ----------------------------------------------------------------------------------------------

  /**
   * The sign-in a server uses (its provider, made once), or none. The provider tells loki when the server sends you to
   * its authorization page, and which servers hold a token, so Settings can say "sign in" or "sign out".
   */
  oauthFor(config: ServerConfig): ServerOauth | undefined {
    if (!usesOauth(config)) return undefined;
    let p = this.providers.get(config.name);
    if (!p) {
      const tracked = new ServerOauth(
        config.name,
        this.oauthStore,
        (server, url, state) => {
          this.signInUrls.set(server, url.href);
          for (const [s, name] of this.pendingStates) if (name === server) this.pendingStates.delete(s);
          if (state) this.pendingStates.set(state, server);
        },
        this.redirect,
      );
      const tokens = tracked.tokens.bind(tracked);
      const save = tracked.saveTokens.bind(tracked);
      tracked.tokens = async () => {
        const t = await tokens();
        if (t) this.signedIn.add(config.name);
        else this.signedIn.delete(config.name);
        return t;
      };
      tracked.saveTokens = async (t) => {
        await save(t);
        this.signedIn.add(config.name);
      };
      p = tracked;
      this.providers.set(config.name, p);
    }
    return p;
  }

  /**
   * The browser came back from a server's authorization page (mod/server.ts, MCP_OAUTH_CALLBACK): match its state to
   * the sign-in that sent it, redeem the code, and connect. Every outcome is a line for the page the browser shows.
   */
  async finishAuth(params: Record<string, string>): Promise<{ ok: boolean; server: string | null; message: string }> {
    const server = params.state ? this.pendingStates.get(params.state) : undefined;
    if (!server)
      return {
        ok: false,
        server: null,
        message: "This sign-in is not one loki started, or it was already used. Start it again from Preferences › MCP servers.",
      };
    this.pendingStates.delete(params.state);
    const config = this.servers.configs().find((c) => c.name === server);
    // The page the browser shows names the server as you wrote it (its tool-safe name only when it is gone).
    const named = config?.entry ?? server;
    if (params.error) return { ok: false, server, message: `${named} did not sign in: ${params.error_description || params.error}` };
    const provider = config && this.oauthFor(config);
    if (config?.kind !== "remote" || !provider || !params.code) return { ok: false, server, message: `${named} sent no code to sign in with.` };
    try {
      const result = await auth(provider, { serverUrl: config.url, authorizationCode: params.code, ...(params.iss ? { iss: params.iss } : {}) });
      if (result !== "AUTHORIZED") return { ok: false, server, message: `${named} asked to sign in again.` };
      this.signInUrls.delete(server);
      this.servers.restart(server);
      return { ok: true, server, message: `Signed in to ${named}. You can close this tab and go back to loki.` };
    } catch (error) {
      return { ok: false, server, message: `${named} did not sign in: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Forget a server's tokens (its registration stays) and connect again, which asks for a sign-in. */
  async signOut(name: string): Promise<McpView> {
    await this.oauthStore.delete(name, ["tokens", "verifier"]);
    this.signedIn.delete(name);
    this.servers.restart(name);
    return this.view();
  }

  /** Switch a server on or off for one agent; its chats follow from their next run. */
  setAgentServer(agentId: string, server: string, on: boolean): McpView {
    const next = new Set(this.off[agentId] ?? []);
    if (on) next.delete(server);
    else next.add(server);
    if (next.size) this.off[agentId] = [...next].sort();
    else {
      const { [agentId]: _was, ...others } = this.off;
      this.off = others;
    }
    mkdirSync(dirname(this.offPath), { recursive: true });
    writeFileSync(this.offPath, `${JSON.stringify({ off: this.off }, null, 2)}\n`);
    this.install(); // the section reads the switches
    return this.view();
  }

  /** Unload every MCP tool a chat has (/clear, a compaction): its next run starts with none. */
  async forget(chat: Conversation, context: Context): Promise<void> {
    await chat.commit(async (tx) => {
      const doc = await tx.doc(ChatDoc, chat.id);
      if (doc.mcpKnown?.length) doc.mcpKnown = [];
    }, context);
  }
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;

/** A found tool in one line: what it does, then its parameters (required ones bare, optional ones with ?). */
function summary(t: McpTool): string {
  const props = Object.keys(t.inputSchema.properties ?? {});
  const required = new Set(Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : []);
  const desc = (t.description || t.title || t.name).split("\n")[0].slice(0, 200);
  return `${desc}${props.length ? ` (${props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ")})` : ""}`;
}

/** The switched-off servers per agent, as saved; anything unreadable is none. */
function readOff(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { off?: unknown };
    const out: Record<string, string[]> = {};
    if (raw.off && typeof raw.off === "object")
      for (const [k, v] of Object.entries(raw.off)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
}
