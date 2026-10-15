import type { Context } from "@earendil-works/chord";
import { configure, defineExtension, defineTool, section, type Conversation, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { ChatDoc, type AgentStore } from "../kernel/index.ts";
import { readConfig } from "./config.ts";
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

export const SEARCH_TOOL = "mcp_search";

type Capture = (event: string, properties: Record<string, unknown>) => void;

export class McpTools {
  readonly servers: McpServers;
  private readonly registry: Registry;
  private readonly configPath: string;
  private readonly resultsDir: string;
  private readonly report: (message: string) => void;
  private capture: Capture = () => {};
  private problems: string[] = [];
  private installTimer: ReturnType<typeof setTimeout> | null = null;
  private watching = false;

  constructor(opts: { registry: Registry; configPath: string; lokiDir: string; report?: (message: string) => void; servers?: McpServers; version?: string }) {
    this.registry = opts.registry;
    this.configPath = opts.configPath;
    this.resultsDir = join(opts.lokiDir, "tool-results");
    this.report = opts.report ?? (() => {});
    this.servers = opts.servers ?? new McpServers({ report: this.report, ...(opts.version ? { version: opts.version } : {}) });
    // A server connecting, failing or changing its tools re-registers the extension (once per burst of changes).
    this.servers.onChange(() => {
      if (this.installTimer) return;
      this.installTimer = setTimeout(() => {
        this.installTimer = null;
        this.install();
      }, 0);
      this.installTimer.unref?.();
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

  /** What every chat sees up front: the servers and their tools' names, or nothing when no server is configured. */
  sectionText(): string | undefined {
    const status = this.servers.status();
    if (!status.length && !this.problems.length) return undefined;
    const tools = this.servers.tools();
    const lines = status.map((s) => {
      if (s.state === "down") return `- ${s.name}: down (${s.error ?? "not connected"})`;
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
      sections: [section("mcp", () => this.sectionText())],
      tools: [this.searchTool(), ...this.servers.tools().map((t) => this.callTool(t))],
    });
  }

  private searchTool(): ToolRegistration {
    return defineTool({
      name: SEARCH_TOOL,
      description:
        "Load MCP tools before using them. Describe what you want to do (\"open pull requests on GitHub\") and the best matching tools are loaded, or name exact ones with \"select:server.tool\" (comma-separated). Loaded tools are available from your next step and stay for this chat.",
      parameters: { type: "object", properties: { query: { type: "string", description: 'What you need, or "select:server.tool, …"' } }, required: ["query"] } as never,
      execute: async (args) => {
        const query = String((args as { query?: unknown }).query ?? "");
        const all = this.servers.tools();
        const found = selected(query, all) ?? rank(query, all, SEARCH_LIMIT);
        this.capture("mcp_search", { hits: found.length, loaded: found.map((t) => t.key), select: query.trim().toLowerCase().startsWith("select:") });
        if (!found.length) {
          const servers = this.servers.status().map((s) => `${s.name} (${s.state === "connected" ? `${s.tools} tools` : s.state})`).join(", ");
          return { content: [{ type: "text", text: `No MCP tool matches "${query}". Servers: ${servers || "none"}. Try other words, or "select:server.tool" with a name from the mcp section.` }] };
        }
        const lines = found.map((t) => `- ${t.key}: ${summary(t)}`);
        return {
          content: [{ type: "text", text: `Loaded ${found.length} tool${found.length === 1 ? "" : "s"}, available from your next step:\n${lines.join("\n")}` }],
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
        const chat = (await api.snapshot(ChatDoc, api.conversationId, context))?.id || `conversation-${api.conversationId}`;
        try {
          const result = await this.servers.call(t.key, (args ?? {}) as Record<string, unknown>, context.abortSignal);
          const mapped = mapResult(result, { spillDir: join(this.resultsDir, chat.replace(/[^A-Za-z0-9_.-]+/g, "_")), name: t.key });
          this.capture("mcp_call", { server: t.server, tool: t.name, ms: Date.now() - started, error: mapped.isError, spilled: mapped.spilled !== null, chars: mapped.chars });
          return { content: mapped.content, isError: mapped.isError };
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
    const all = this.servers.tools().map((t) => t.key);
    const settings = (await store.agentSettings(chat.id, context)) as { tools?: string[] | { remove: string[] } } | undefined;
    if (Array.isArray(settings?.tools)) return;
    const removed = settings?.tools?.remove ?? [];
    if (!all.length && !removed.some((n) => n.startsWith("mcp__"))) return;
    const info = await store.chatInfo(chat.id, context);
    const known = new Set(info?.mcpKnown ?? []);
    const hidden = new Set(removed);
    const always = this.servers.alwaysLoaded();
    const hide = all.filter((k) => !always.has(k) && !(known.has(k) && !hidden.has(k)));
    const next = [...removed.filter((n) => !n.startsWith("mcp__")), ...hide];
    const unchanged = sameSet(next, removed) && sameSet(all, [...known]);
    if (unchanged) return;
    const registered = new Map(this.registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
    await chat.commit(async (tx) => {
      await configure(tx, chat.id, { tools: { remove: next.map((n) => registered.get(n) ?? ({ name: n } as ToolRegistration)) } });
      const doc = await tx.doc(ChatDoc, chat.id);
      doc.mcpKnown = all;
    }, context);
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
  const props = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>);
  const required = new Set(Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : []);
  const desc = (t.description || t.title || t.name).split("\n")[0].slice(0, 200);
  return `${desc}${props.length ? ` (${props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ")})` : ""}`;
}
