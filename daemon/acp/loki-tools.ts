import type { Context } from "@earendil-works/chord";
import type * as acp from "@agentclientprotocol/sdk";
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult as ServedResult } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { ChatTool } from "../chat-tools.ts";
import type { StoreManager } from "../kernel/stores.ts";

/** The name loki's tools go by in an ACP agent: Claude Code calls them `mcp__loki__<tool>`. */
export const LOKI_TOOLS_SERVER = "loki";

interface ChatKey {
  agentId: string;
  conversationId: string;
}

/**
 * loki's own tools for chats on an ACP agent (plan 042): an MCP endpoint on loopback, handed to each session as an
 * HTTP server named `loki` with a key that names the chat, so every call runs as that chat on the same bodies loki's
 * engine runs (daemon/chat-tools.ts). Keys live in memory only; a session reopened after a restart gets a new one. The
 * MCP servers set up in loki are not served here: the agent connects to them itself (daemon/mcp/ acpServers).
 */
export class LokiTools {
  private readonly deps: { tools: () => ChatTool[]; stores: StoreManager; context: Context; version: string };
  private readonly chats = new Map<string, ChatKey>();
  private readonly keys = new Map<string, string>();
  private http: HttpServer | null = null;
  private url: string | null = null;

  constructor(deps: LokiTools["deps"]) {
    this.deps = deps;
  }

  /** Listen on a free loopback port. */
  async start(): Promise<void> {
    const http = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => resolve());
    });
    this.http = http;
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("loki's tool endpoint has no port");
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = null;
    this.url = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  /** loki's tools as an ACP session takes them, for one chat; null until the endpoint listens. */
  serverFor(agentId: string, conversationId: string): acp.McpServer | null {
    if (!this.url) return null;
    const chat = `${agentId}\u0000${conversationId}`;
    let key = this.keys.get(chat);
    if (!key) {
      key = randomUUID();
      this.keys.set(chat, key);
      this.chats.set(key, { agentId, conversationId });
    }
    return { type: "http", name: LOKI_TOOLS_SERVER, url: this.url, headers: [{ name: "authorization", value: `Bearer ${key}` }] };
  }

  /** loki's tools that only read, as the agent names them: it runs them without asking, as loki's engine does. */
  readOnly(): string[] {
    return this.deps
      .tools()
      .filter((t) => t.kind === "read")
      .map((t) => `mcp__${LOKI_TOOLS_SERVER}__${t.name}`);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const chat = key ? this.chats.get(key) : undefined;
    if (!chat) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const method = req.method ?? "GET";
    const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
    });
    const handler = createMcpHandler(() => this.server(chat), { responseMode: "json" });
    try {
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } finally {
      await handler.close();
    }
  }

  /** One request's MCP server: loki's tools, each run as `chat`. */
  private server(chat: ChatKey): McpServer {
    const server = new McpServer({ name: LOKI_TOOLS_SERVER, version: this.deps.version });
    for (const tool of this.deps.tools())
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: schema(tool.parameters), annotations: { readOnlyHint: tool.kind === "read" } },
        async (args, ctx): Promise<ServedResult> => {
          try {
            const store = await this.deps.stores.get(chat.agentId);
            const conversation = await store.chat(chat.conversationId, this.deps.context);
            if (!conversation) throw new Error("this chat is no longer here");
            const call = { read: store.harness, conversationId: conversation.id, callId: randomUUID(), signal: ctx.mcpReq.signal, output: () => {} };
            return { content: (await tool.run(args, call, this.deps.context)).output ?? [] };
          } catch (e) {
            return failed(e);
          }
        },
      );
    return server;
  }
}

/** A tool's JSON Schema as the server checks arguments against: an object, as every tool's is. */
const schema = (parameters: object) => fromJsonSchema<Record<string, unknown>>(parameters);

/** A call that went wrong, as the agent reads it. */
const failed = (e: unknown): ServedResult => ({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
