import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type OAuthClientProvider,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { sameServer, type ServerConfig } from "./config.ts";
import { Listeners } from "../../core/listeners.ts";

/**
 * The MCP servers loki is connected to (one client each), and the tools they offer. A local server is started with the
 * daemon and started again, with a growing pause, when it exits; a remote one is reconnected the same way. A server's
 * tools are read when it connects and again whenever it says they changed. Nothing here knows about chats: the
 * catalog and the calls are all loki.mcp (daemon/mcp/index.ts) needs.
 */

/** One tool of one server, as loki names it to the model: `mcp__<server>__<tool>`, at most 64 characters. */
export interface McpTool {
  key: string;
  server: string;
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

/** `signin`: a remote server that wants an OAuth sign-in, which waits for the person rather than retrying. */
export type ServerState = "starting" | "connected" | "down" | "signin";
/** One server's state as Settings and the `mcp` section show it: `tools` is how many it offers, `purpose` the first line of its own description or instructions. */
export interface ServerStatus {
  name: string;
  kind: ServerConfig["kind"];
  state: ServerState;
  error: string | null;
  tools: number;
  purpose: string | null;
}

/**
 * Opens a connection to a server (its stderr, if any, goes to `stderr`; a remote one signs in with `auth` when it
 * asks); replaced in tests by one that connects in memory.
 */
export type Connector = (config: ServerConfig, client: Client, stderr: (text: string) => void, auth?: OAuthClientProvider) => Promise<void>;

/** Provider tool names are at most 64 characters of letters, digits, `_` and `-`. */
export function toolKey(server: string, tool: string): string {
  const safe = tool.replace(/[^A-Za-z0-9_-]+/g, "_");
  const key = `mcp__${server}__${safe}`;
  if (key.length <= 64 && safe === tool) return key;
  // Cut (or changed) names keep a short hash of the real name, so two tools never share a key.
  const hash = createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 6);
  return `${key.slice(0, 57)}_${hash}`;
}

/** How long to wait before the next try, after `failures` failures in a row: 1s, 2s, 4s … up to a minute. */
export const backoffMs = (failures: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));

const STDERR_KEEP = 2000;

/** The real connector: a local server is started over stdio, a remote one reached over Streamable HTTP. */
export const connectServer: Connector = async (config, client, stderr, auth) => {
  let transport: Transport;
  if (config.kind === "local") {
    // The given env adds to the safe defaults (PATH, HOME …) rather than replacing them: a server started with only
    // its token in its environment could not find its own runtime.
    const stdio = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      stderr: "pipe",
    });
    stdio.stderr?.on("data", (chunk: Buffer) => stderr(chunk.toString("utf8")));
    transport = stdio;
  } else {
    transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, ...(auth ? { authProvider: auth } : {}) });
  }
  await client.connect(transport);
};

interface Entry {
  config: ServerConfig;
  state: ServerState;
  error: string | null;
  tools: McpTool[];
  purpose: string | null;
  client: Client | null;
  /** The end of a local server's stderr, for the error line when it fails. */
  stderr: string;
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  /** Bumped on every (re)start and stop: a connection from an older start that finishes late is closed, not kept. */
  generation: number;
}

/** The servers and their connections, by name: `configure` makes them match mcp.json, a server that fails is retried after backoffMs, and `close` stops them all. */
export class McpServers {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Listeners();
  private readonly connect: Connector;
  /** Fills a config's `${keychain:…}` values just before it connects (daemon/mcp/config.ts withSecrets). */
  private readonly resolve: (config: ServerConfig) => Promise<ServerConfig>;
  /** The sign-in a remote server uses when it asks for one (daemon/mcp/oauth.ts); none for a server with its own token. */
  private readonly oauthFor: (config: ServerConfig) => OAuthClientProvider | undefined;
  private readonly report: (message: string) => void;
  private readonly version: string;
  private closed = false;

  constructor(
    opts: {
      connect?: Connector;
      resolve?: (config: ServerConfig) => Promise<ServerConfig>;
      oauthFor?: (config: ServerConfig) => OAuthClientProvider | undefined;
      report?: (message: string) => void;
      version?: string;
    } = {},
  ) {
    this.connect = opts.connect ?? connectServer;
    this.resolve = opts.resolve ?? ((c) => Promise.resolve(c));
    this.oauthFor = opts.oauthFor ?? (() => undefined);
    this.report = opts.report ?? (() => {});
    this.version = opts.version ?? "0";
  }

  /** Told after any change to a server's state or tools. */
  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private changed(): void {
    this.listeners.emit();
  }

  /** Make the running servers match the config: new ones start, removed ones stop, changed ones restart. */
  configure(servers: readonly ServerConfig[]): void {
    const wanted = new Map(servers.map((s) => [s.name, s]));
    for (const [name, entry] of this.entries) {
      const next = wanted.get(name);
      if (!next) {
        void this.stop(entry);
        this.entries.delete(name);
      } else if (!sameServer(entry.config, next)) {
        entry.config = next;
        void this.start(entry);
      }
    }
    for (const config of servers) {
      if (this.entries.has(config.name)) continue;
      const entry: Entry = {
        config,
        state: "starting",
        error: null,
        tools: [],
        purpose: null,
        client: null,
        stderr: "",
        failures: 0,
        retry: null,
        generation: 0,
      };
      this.entries.set(config.name, entry);
      void this.start(entry);
    }
    this.changed();
  }

  private async stop(entry: Entry): Promise<void> {
    entry.generation++;
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    const client = entry.client;
    entry.client = null;
    await client?.close().catch(() => {});
  }

  private async start(entry: Entry): Promise<void> {
    // The generation is taken as stop bumps it, before waiting on the old connection: read after, two starts close
    // together (a restart while a change still closes) both read the later one, both connect, and one is never closed.
    const stopping = this.stop(entry);
    const generation = entry.generation;
    await stopping;
    if (this.closed || generation !== entry.generation) return;
    // A retry keeps the last error until it connects, so the log can tell a new failure from the same one again.
    if (entry.state !== "down") entry.error = null;
    entry.state = "starting";
    this.changed();
    const client = new Client(
      { name: "loki", version: this.version },
      {
        listChanged: {
          tools: {
            onChanged: (error, tools) =>
              error ? this.report(`mcp ${entry.config.name}: tools did not refresh: ${String(error)}`) : this.setTools(entry, generation, tools ?? []),
          },
        },
      },
    );
    entry.stderr = "";
    const stderr = (text: string) => {
      if (generation === entry.generation) entry.stderr = (entry.stderr + text).slice(-STDERR_KEEP);
    };
    try {
      await this.connect(await this.resolve(entry.config), client, stderr, this.oauthFor(entry.config));
      if (generation !== entry.generation) {
        await client.close().catch(() => {});
        return;
      }
      entry.client = client;
      const listed = await client.listTools();
      if (generation !== entry.generation) return;
      const info = client.getServerVersion() as { title?: string; description?: string } | undefined;
      const instructions = client.getInstructions();
      entry.purpose = firstLine(info?.description ?? info?.title ?? instructions ?? null);
      entry.failures = 0;
      entry.state = "connected";
      this.setTools(entry, generation, listed.tools);
      // A connection that drops (the process exited, the network went) is a down server, started again after a pause.
      client.onclose = () => {
        if (generation !== entry.generation || this.closed) return;
        entry.client = null;
        this.down(entry, generation, `the server stopped${tailOf(entry.stderr)}`);
      };
    } catch (error) {
      if (generation !== entry.generation) return;
      await client.close().catch(() => {});
      entry.client = null;
      // A server that wants a sign-in waits for it: retrying would only open the same page again.
      if (error instanceof UnauthorizedError) return this.needsSignIn(entry);
      this.down(entry, generation, `${error instanceof Error ? error.message : String(error)}${tailOf(entry.stderr)}`);
    }
  }

  private needsSignIn(entry: Entry): void {
    if (entry.state !== "signin") this.report(`mcp ${entry.config.name}: needs a sign-in (Preferences › MCP servers)`);
    entry.state = "signin";
    entry.error = "needs a sign-in: Preferences › MCP servers";
    entry.tools = [];
    this.changed();
  }

  private down(entry: Entry, generation: number, error: string): void {
    // The same failure on every retry (a missing program, a dead URL) is logged once, not once a minute for ever.
    if (error !== entry.error) this.report(`mcp ${entry.config.name}: ${error}`);
    entry.state = "down";
    entry.error = error;
    entry.tools = [];
    entry.failures++;
    this.changed();
    const wait = backoffMs(entry.failures);
    entry.retry = setTimeout(() => {
      if (generation === entry.generation && !this.closed) void this.start(entry);
    }, wait);
    entry.retry.unref();
  }

  private setTools(entry: Entry, generation: number, tools: readonly Tool[]): void {
    if (generation !== entry.generation) return;
    entry.tools = tools.map((t) => ({
      key: toolKey(entry.config.name, t.name),
      server: entry.config.name,
      name: t.name,
      title: t.title ?? t.annotations?.title ?? null,
      description: (t.description ?? "").trim(),
      inputSchema: t.inputSchema,
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
    }));
    this.changed();
  }

  /** Start a server again now (Settings' restart): a down one does not wait out its pause. */
  restart(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.failures = 0;
    void this.start(entry);
    return true;
  }

  /** The configs the servers run with, as read (secrets as their `${keychain:…}` names). */
  configs(): ServerConfig[] {
    return [...this.entries.values()].map((e) => e.config);
  }

  /** Every tool of every connected server, in config order. */
  tools(): McpTool[] {
    return [...this.entries.values()].flatMap((e) => (e.state === "connected" ? e.tools : []));
  }

  /** The tools a server's config always loads, by key. */
  alwaysLoaded(): Set<string> {
    const out = new Set<string>();
    for (const e of this.entries.values()) for (const t of e.tools) if (e.config.alwaysLoad.includes(t.name)) out.add(t.key);
    return out;
  }

  status(): ServerStatus[] {
    return [...this.entries.values()].map((e) => ({
      name: e.config.name,
      kind: e.config.kind,
      state: e.state,
      error: e.error,
      tools: e.tools.length,
      purpose: e.purpose,
    }));
  }

  /** Call a tool by its key. A server that is down, or a tool it no longer has, is an error the model reads. */
  async call(key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const tool = this.tools().find((t) => t.key === key);
    if (!tool) throw new Error(`${key} is not available: its server is down or no longer has it`);
    const client = this.entries.get(tool.server)?.client;
    if (!client) throw new Error(`the ${tool.server} MCP server is not connected`);
    // A long tool (a build, a crawl) is not cut off at the SDK's default minute; Stop still ends it.
    return client.callTool({ name: tool.name, arguments: args }, { ...(signal ? { signal } : {}), timeout: 10 * 60_000, resetTimeoutOnProgress: true });
  }

  /** Stop every server (the daemon is stopping). */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map((e) => this.stop(e)));
  }
}

const firstLine = (text: string | null): string | null => {
  const line = text?.trim().split("\n")[0]?.trim();
  return line ? (line.length > 100 ? `${line.slice(0, 97)}…` : line) : null;
};
const tailOf = (stderr: string): string => {
  const tail = stderr.trim();
  return tail ? `: ${tail.split("\n").slice(-3).join(" ").slice(-300)}` : "";
};
