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
import { messageOf } from "../../core/errors.ts";

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

export type ServerState = "starting" | "connected" | "down" | "signin";
export interface ServerStatus {
  name: string;
  kind: ServerConfig["kind"];
  state: ServerState;
  error: string | null;
  tools: number;
  purpose: string | null;
}

export type Connector = (config: ServerConfig, client: Client, stderr: (text: string) => void, auth?: OAuthClientProvider) => Promise<void>;

/** Provider tool names are at most 64 characters of letters, digits, `_` and `-`. */
export function toolKey(server: string, tool: string): string {
  const safe = tool.replace(/[^A-Za-z0-9_-]+/g, "_");
  const key = `mcp__${server}__${safe}`;
  if (key.length <= 64 && safe === tool) return key;
  const hash = createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 6);
  return `${key.slice(0, 57)}_${hash}`;
}

export const backoffMs = (failures: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));

const STDERR_KEEP = 2000;

export const connectServer: Connector = async (config, client, stderr, auth) => {
  let transport: Transport;
  if (config.kind === "local") {
    // The given env adds to the safe defaults (PATH, HOME …) rather than replacing them: a server started with only
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
  stderr: string;
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  generation: number;
}

export class McpServers {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Listeners();
  private readonly connect: Connector;
  private readonly resolve: (config: ServerConfig) => Promise<ServerConfig>;
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

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private changed(): void {
    this.listeners.emit();
  }

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
    const stopping = this.stop(entry);
    const generation = entry.generation;
    await stopping;
    if (this.closed || generation !== entry.generation) return;
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
      client.onclose = () => {
        if (generation !== entry.generation || this.closed) return;
        entry.client = null;
        this.down(entry, generation, `the server stopped${tailOf(entry.stderr)}`);
      };
    } catch (error) {
      if (generation !== entry.generation) return;
      await client.close().catch(() => {});
      entry.client = null;
      if (error instanceof UnauthorizedError) return this.needsSignIn(entry);
      this.down(entry, generation, `${messageOf(error)}${tailOf(entry.stderr)}`);
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

  restart(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.failures = 0;
    void this.start(entry);
    return true;
  }

  configs(): ServerConfig[] {
    return [...this.entries.values()].map((e) => e.config);
  }

  tools(): McpTool[] {
    return [...this.entries.values()].flatMap((e) => (e.state === "connected" ? e.tools : []));
  }

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

  async call(key: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const tool = this.tools().find((t) => t.key === key);
    if (!tool) throw new Error(`${key} is not available: its server is down or no longer has it`);
    const client = this.entries.get(tool.server)?.client;
    if (!client) throw new Error(`the ${tool.server} MCP server is not connected`);
    // A long tool (a build, a crawl) is not cut off at the SDK's default minute; Stop still ends it.
    return client.callTool({ name: tool.name, arguments: args }, { ...(signal ? { signal } : {}), timeout: 10 * 60_000, resetTimeoutOnProgress: true });
  }

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
