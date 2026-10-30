import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as connectSocket } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type * as acp from "@agentclientprotocol/sdk";
import { LokiTools } from "../daemon/acp/loki-tools.ts";
import type { ChatTool } from "../daemon/chat-tools.ts";
import { AgentStore, ChatDoc } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import type { Suggestion } from "../core/frame-types.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import { Suggestions } from "../mod/suggestions.ts";
import { registerTools } from "../mod/tools.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A tool that answers with the chat it was called for, as loki's tools find it. */
const whoami: ChatTool = {
  name: "whoami",
  description: "Which chat this is.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  run: async (_args, call, context) => ({ output: [{ type: "text", text: (await call.read.snapshot(ChatDoc, call.conversationId, context))?.id ?? "none" }] }),
};

const echo: ChatTool = {
  name: "echo",
  description: "Says back its words.",
  parameters: { type: "object", properties: { words: { type: "string" } }, required: ["words"] },
  kind: "command",
  run: (args) => Promise.resolve({ output: [{ type: "text", text: String(args.words) }] }),
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-acp-tools-"));
  const models = createModels();
  const mods = new ModRegistry(() => {});
  const stores = new StoreManager(
    join(dir, "stores"),
    { models, registry: mods.registry },
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
  );
  const store = await stores.get("ada");
  const conversationId = "local-conv-garden";
  await store.createChat(conversationId, { title: null }, ctx);
  const tools = new LokiTools({ tools: () => [whoami, echo], stores, context: ctx, version: "test" });
  await tools.start();
  cleanups.push(async () => {
    await tools.stop();
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return { tools, conversationId };
}

/** An MCP client on one of the session's servers, as the ACP agent connects to it. */
async function connect(server: { url: string; headers: Array<{ name: string; value: string }> }) {
  const client = new Client({ name: "test", version: "1" });
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
  cleanups.push(() => client.close());
  return client;
}

/** One of the session's servers, which loki always serves over HTTP. */
const http = (s: acp.McpServer | undefined) => {
  if (!s || !("type" in s) || s.type !== "http") throw new Error("not an HTTP server");
  return s;
};

describe("loki's tools for a chat on an ACP agent (plan 044)", () => {
  test("a session gets loki's tools as one HTTP server, and each runs as the chat its key names", async () => {
    const { tools, conversationId } = await setup();
    const loki = await connect(http(tools.serverFor("ada", conversationId) ?? undefined));
    expect((await loki.listTools()).tools.map((t) => t.name)).toEqual(["whoami", "echo"]);
    expect((await loki.callTool({ name: "whoami", arguments: {} })).content).toEqual([{ type: "text", text: conversationId }]);
    expect((await loki.callTool({ name: "echo", arguments: { words: "hello" } })).content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("a request without its chat's key is refused", async () => {
    const { tools, conversationId } = await setup();
    const loki = http(tools.serverFor("ada", conversationId) ?? undefined);
    expect((await fetch(loki.url, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("a request the agent drops mid-body fails alone, and the endpoint keeps serving", async () => {
    const { tools, conversationId } = await setup();
    const loki = http(tools.serverFor("ada", conversationId) ?? undefined);
    const url = new URL(loki.url);
    const auth = loki.headers.map((h) => `${h.name}: ${h.value}\r\n`).join("");
    await new Promise<void>((resolve, reject) => {
      const socket = connectSocket(Number(url.port), url.hostname, () => {
        socket.write(`POST ${url.pathname} HTTP/1.1\r\nhost: ${url.host}\r\n${auth}content-length: 1000\r\n\r\n{"jsonrpc"`, () => {
          socket.destroy();
          resolve();
        });
      });
      socket.on("error", reject);
    });
    await expect.poll(async () => (await fetch(loki.url, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("the tools that only read run without asking, named as the agent names them", async () => {
    const { tools } = await setup();
    expect(tools.readOnly()).toEqual(["mcp__loki__whoami"]);
  });

  test("covers plan 061: a pass's chat is served only its job's tools, and the calls it ran are taken once", async () => {
    const { tools, conversationId } = await setup();
    const pass = await connect(http(tools.serverFor("ada", conversationId, ["echo"]) ?? undefined));
    expect((await pass.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await pass.callTool({ name: "echo", arguments: { words: "one" } });
    await pass.callTool({ name: "echo", arguments: { words: "two" } });
    expect(tools.takeCalls("ada", conversationId)).toEqual(["echo", "echo"]);
    expect(tools.takeCalls("ada", conversationId)).toEqual([]);
    expect(LokiTools.named(["memory_write"])).toEqual(["mcp__loki__memory_write"]);
  });

  test("an ordinary chat's calls are not kept: nothing would ever take them", async () => {
    const { tools, conversationId } = await setup();
    const loki = await connect(http(tools.serverFor("ada", conversationId) ?? undefined));
    await loki.callTool({ name: "echo", arguments: { words: "hello" } });
    expect(tools.takeCalls("ada", conversationId)).toEqual([]);
  });

  test("suggestion_create through the loopback server stores the suggestion on the calling chat, and runs without asking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-acp-suggest-"));
    const models = createModels();
    const mods = new ModRegistry(() => {});
    const stored = new Map<string, Suggestion[]>();
    const suggestions = new Suggestions({
      records: {
        read: (a, c) => Promise.resolve({ suggestions: stored.get(`${a}/${c}`) ?? [], archived: false }),
        write: (a, c, s) => (stored.set(`${a}/${c}`, s), Promise.resolve()),
      },
      chat: () => null,
      agentExists: () => true,
      call: () => Promise.resolve({ ok: true, reply: {} }),
      push: () => {},
      newId: () => "sugg-1",
    });
    await mods.load({
      name: "loki",
      apiVersion: 1,
      activate: (api) =>
        registerTools(api, {
          store: new DeskStore(),
          gestures: new GestureLog(),
          widgets: { entries: () => [], get: () => undefined, setRuntimeError: () => false, rescan: () => Promise.resolve(), close: () => {} },
          widgetsDir: join(dir, "widgets"),
          activeScope: () => "shared",
          broadcast: () => {},
          chats: {
            suggestions,
            agents: () => [{ id: "agent-local-ira", name: "Ira", mac: "studio", reachable: true }],
            chats: () => [
              {
                scope: "conv-site",
                conversation_id: "conv-site",
                agent_id: "agent-local-ira",
                agent_name: "Ira",
                title: "site",
                status: "live",
                model: null,
                reasoning_effort: null,
                cwd: "/work/site",
                widgets: 0,
                active: false,
                last_active: null,
              },
            ],
            passChat: () => false,
          },
        }),
    });
    const stores = new StoreManager(
      join(dir, "stores"),
      { models, registry: mods.registry },
      ctx,
      () => {},
      () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
    );
    const store = await stores.get("agent-local-ada");
    await store.createChat("local-conv-garden", { title: null }, ctx);
    const tools = new LokiTools({ tools: () => mods.chatTools(), stores, context: ctx, version: "test" });
    await tools.start();
    cleanups.push(async () => {
      await tools.stop();
      await stores.closeAll();
      rmSync(dir, { recursive: true, force: true });
    });
    const loki = await connect(http(tools.serverFor("agent-local-ada", "local-conv-garden") ?? undefined));
    const out = await loki.callTool({
      name: "suggestion_create",
      arguments: { title: "Write the site's intro", text: "Write /work/site/intro.md.", target: { agent_id: "agent-local-ira", folder: "/work/site" } },
    });
    expect(JSON.stringify(out.content)).toContain("sugg-1");
    expect([...stored.values()].flat()).toMatchObject([{ id: "sugg-1", status: "pending", target: { agent_id: "agent-local-ira", folder: "/work/site" } }]);
    expect(tools.readOnly()).toEqual(
      expect.arrayContaining(["mcp__loki__chat_list", "mcp__loki__suggestion_create", "mcp__loki__suggestion_list", "mcp__loki__suggestion_withdraw"]),
    );
  });
});
