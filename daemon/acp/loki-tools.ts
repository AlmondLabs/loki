import type { Context } from "@earendil-works/chord";
import type * as acp from "@agentclientprotocol/sdk";
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult as ServedResult } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type { ChatTool, ChatToolResult } from "../chat-tools.ts";
import { ACP_SCRIPT_TOOL, runAcpScript, scriptToolDescription } from "./scripts.ts";
import type { StoreManager } from "../kernel/stores.ts";
import { messageOf } from "../../core/errors.ts";

export const LOKI_TOOLS_SERVER = "loki";

interface ChatKey {
  agentId: string;
  conversationId: string;
  only?: ReadonlySet<string>;
}

export interface AcpScripts {
  sandbox: CodemodeSandboxBase;
  timeoutMs: number;
  strangerText: (tool: string) => boolean;
  ask: (
    agentId: string,
    conversationId: string,
    input: { code: string; first_call: { tool: string; input: unknown } },
    signal: AbortSignal,
  ) => Promise<{ allow: boolean; message?: string }>;
}

export class LokiTools {
  private readonly deps: { tools: () => ChatTool[]; stores: StoreManager; context: Context; version: string; scripts?: AcpScripts };
  private readonly chats = new Map<string, ChatKey>();
  private readonly keys = new Map<string, string>();
  private readonly called = new Map<string, string[]>();
  private http: HttpServer | null = null;
  private url: string | null = null;

  constructor(deps: LokiTools["deps"]) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    // Outside (Node): an unhandled rejection ends the daemon, so a request that fails (the agent drops it mid-body, the
    // handler throws) fails alone.
    const http = createServer((req, res) => {
      this.serve(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      });
    });
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

  serverFor(agentId: string, conversationId: string, only?: readonly string[]): acp.McpServer | null {
    if (!this.url) return null;
    const chat = chatKey(agentId, conversationId);
    let key = this.keys.get(chat);
    if (!key) {
      key = randomUUID();
      this.keys.set(chat, key);
    }
    this.chats.set(key, { agentId, conversationId, ...(only ? { only: new Set(only) } : {}) });
    return { type: "http", name: LOKI_TOOLS_SERVER, url: this.url, headers: [{ name: "authorization", value: `Bearer ${key}` }] };
  }

  takeCalls(agentId: string, conversationId: string): string[] {
    const chat = chatKey(agentId, conversationId);
    const calls = this.called.get(chat) ?? [];
    this.called.delete(chat);
    return calls;
  }

  static named(tools: readonly string[]): string[] {
    return tools.map((t) => `mcp__${LOKI_TOOLS_SERVER}__${t}`);
  }

  readOnly(): string[] {
    const served = this.deps.tools().filter((t) => t.kind === "read" && (!t.callers || t.callers.includes("model")));
    return LokiTools.named([...(this.deps.scripts ? [ACP_SCRIPT_TOOL] : []), ...served.map((t) => t.name)]);
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

  private server(chat: ChatKey): McpServer {
    const server = new McpServer({ name: LOKI_TOOLS_SERVER, version: this.deps.version });
    const forChat = this.deps.tools().filter((t) => (!chat.only || chat.only.has(t.name)) && (!t.forAgent || t.forAgent(chat.agentId)));
    const served = forChat.filter((t) => !t.callers || t.callers.includes("model"));
    const scriptOnly = forChat.filter((t) => t.callers?.includes("tools") === true && !t.callers.includes("model"));
    const scripts = this.deps.scripts;
    if (scripts && scriptOnly.length > 0 && (!chat.only || chat.only.has(ACP_SCRIPT_TOOL)))
      server.registerTool(
        ACP_SCRIPT_TOOL,
        {
          description: scriptToolDescription(scriptOnly),
          inputSchema: schema({ type: "object", properties: { code: { type: "string" } }, required: ["code"] }),
          annotations: { readOnlyHint: true },
        },
        async (args, ctx): Promise<ServedResult> => {
          try {
            const signal = ctx.mcpReq.signal;
            const out = await runAcpScript(typeof args.code === "string" ? args.code : "", {
              sandbox: scripts.sandbox,
              tools: scriptOnly,
              run: (tool, toolArgs) => this.runAs(chat, tool, toolArgs, signal),
              ask: (input) => scripts.ask(chat.agentId, chat.conversationId, input, signal),
              strangerText: scripts.strangerText,
              signal,
              timeoutMs: scripts.timeoutMs,
            });
            return { content: [{ type: "text", text: out.text }], ...(out.isError ? { isError: true } : {}) };
          } catch (e) {
            return failed(e);
          }
        },
      );
    for (const tool of served)
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: schema(tool.parameters), annotations: { readOnlyHint: tool.kind === "read" } },
        async (args, ctx): Promise<ServedResult> => {
          try {
            const content = (await this.runAs(chat, tool, args, ctx.mcpReq.signal)).output ?? [];
            if (chat.only) {
              const key = chatKey(chat.agentId, chat.conversationId);
              this.called.set(key, [...(this.called.get(key) ?? []), tool.name]);
            }
            return { content };
          } catch (e) {
            return failed(e);
          }
        },
      );
    return server;
  }

  private async runAs(chat: ChatKey, tool: ChatTool, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult> {
    const store = await this.deps.stores.get(chat.agentId);
    const conversation = await store.chat(chat.conversationId, this.deps.context);
    if (!conversation) throw new Error("this chat is no longer here");
    const call = { read: store.harness, conversationId: conversation.id, callId: randomUUID(), signal, output: () => {} };
    return tool.run(args, call, this.deps.context);
  }
}

const chatKey = (agentId: string, conversationId: string) => `${agentId}\u0000${conversationId}`;

const schema = (parameters: object) => fromJsonSchema<Record<string, unknown>>(parameters);

const failed = (e: unknown): ServedResult => ({ content: [{ type: "text", text: messageOf(e) }], isError: true });
