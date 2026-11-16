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
import { OauthStore, ServerOauth, callbackUrl, oauthKey } from "./oauth.ts";
import { toolResultsDir } from "../tool-results.ts";
import { mapResult } from "./results.ts";
import { rank, selected } from "./search.ts";
import { McpServers, type McpTool } from "./servers.ts";
import { coalesce } from "../../core/timers.ts";
import { messageOf } from "../../core/errors.ts";

const NAMES_LISTED = 60;
const SEARCH_LIMIT = 5;

export const SEARCH_TOOL = "mcp_search";

type Capture = (event: string, properties: Record<string, unknown>) => void;
export interface Secrets {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete?(account: string): Promise<void>;
}

export const usesOauth = (c: ServerConfig): boolean => c.kind === "remote" && !Object.keys(c.headers).some((h) => h.toLowerCase() === "authorization");

export const toolTokens = (t: McpTool): number => Math.ceil(JSON.stringify({ name: t.key, description: t.description, parameters: t.inputSchema }).length / 4);

export class McpTools {
  readonly servers: McpServers;
  private readonly registry: Registry;
  private readonly configPath: string;
  private readonly lokiDir: string;
  private readonly report: (message: string) => void;
  private capture: Capture = () => {};
  private problems: string[] = [];
  private readonly installing = coalesce(() => this.install(), 0, { unref: true });
  private watching = false;
  private readonly secrets: Secrets | null;
  private readonly offPath: string;
  private off: Record<string, string[]>;
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
    this.servers.onChange(() => {
      this.installing.schedule();
    });
    this.install();
  }

  setCapture(capture: Capture): void {
    this.capture = capture;
  }

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
    this.installing.cancel();
    await this.servers.close();
  }

  annotations(name: string): { readOnly?: boolean; destructive?: boolean } | undefined {
    if (name === SEARCH_TOOL) return { readOnly: true };
    if (!name.startsWith("mcp__")) return undefined;
    const tool = this.servers.tools().find((t) => t.key === name);
    return tool ? { readOnly: tool.readOnly, destructive: tool.destructive } : undefined;
  }

  offFor(agentId: string | null | undefined): Set<string> {
    return new Set(agentId ? (this.off[agentId] ?? []) : []);
  }

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
        this.report(`MCP server ${config.name} left out of ACP chats: ${messageOf(e)}`);
      }
    }
    return out;
  }

  acpReadOnly(agentId: string): string[] {
    return this.toolsFor(agentId)
      .filter((t) => t.readOnly)
      .map((t) => `mcp__${t.server}__${t.name}`);
  }

  private toolsFor(agentId: string | null | undefined): McpTool[] {
    const off = this.offFor(agentId);
    return this.servers.tools().filter((t) => !off.has(t.server));
  }

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
          const input: unknown = args;
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

  async prepare(store: AgentStore, chat: Conversation, context: Context): Promise<void> {
    const agentId = (await store.harness.snapshot(AgentInfoDoc, context))?.id;
    const off = this.offFor(agentId);
    const all = this.servers.tools().map((t) => t.key);
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

  setServer(entry: string, edit: ServerEdit | null, rename?: string): McpView {
    const before = this.servers.configs().filter((c) => c.kind === "remote" && usesOauth(c));
    editServer(this.configPath, entry, edit, rename ? { rename } : {});
    this.reload();
    const now = this.servers.configs();
    for (const old of before) {
      if (old.kind !== "remote" || now.some((c) => c.name === old.name && c.kind === "remote" && c.url === old.url)) continue;
      this.providers.delete(`${old.name}\u0000${old.url}`);
      this.signedIn.delete(old.name);
      void this.oauthStore
        .delete(oauthKey(old.name, old.url))
        .catch((e: unknown) => this.report(`mcp: could not forget ${old.name}'s sign-in: ${messageOf(e)}`));
    }
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

  async storeSecret(name: string, value: string): Promise<string> {
    if (!this.secrets) throw new Error("no keychain on this system; write the value into mcp.json instead");
    const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "secret";
    await this.secrets.set(`mcp.${safe}`, value);
    return keychainRef(safe);
  }

  oauthFor(config: ServerConfig): ServerOauth | undefined {
    if (!usesOauth(config) || config.kind !== "remote") return undefined;
    const key = `${config.name}\u0000${config.url}`;
    let p = this.providers.get(key);
    if (!p) {
      const tracked = new ServerOauth(
        config.name,
        config.url,
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
      this.providers.set(key, p);
    }
    return p;
  }

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
      return { ok: false, server, message: `${named} did not sign in: ${messageOf(error)}` };
    }
  }

  async signOut(name: string): Promise<McpView> {
    const config = this.servers.configs().find((c) => c.name === name);
    await (config && this.oauthFor(config))?.signOut();
    this.signedIn.delete(name);
    this.servers.restart(name);
    return this.view();
  }

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
    this.install();
    return this.view();
  }

  async forget(chat: Conversation, context: Context): Promise<void> {
    await chat.commit(async (tx) => {
      const doc = await tx.doc(ChatDoc, chat.id);
      if (doc.mcpKnown?.length) doc.mcpKnown = [];
    }, context);
  }
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;

function summary(t: McpTool): string {
  const props = Object.keys(t.inputSchema.properties ?? {});
  const required = new Set(Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : []);
  const desc = (t.description || t.title || t.name).split("\n")[0].slice(0, 200);
  return `${desc}${props.length ? ` (${props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ")})` : ""}`;
}

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
