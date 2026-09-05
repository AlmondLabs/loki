import { describe, expect, test } from "bun:test";
import { WebSocketServer, type WebSocket } from "ws";
import { AppServerClient, deltaText, parseGatewayUrls, parseLsofPorts, probeAppServer } from "../mod/app-server.ts";

/** A fake Letta app-server speaking just enough of the protocol. */
function fakeAppServer() {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>();
  const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(m);
      if (m.type === "app_server_info") {
        // real servers replay pending state before answering; the probe must not mistake it for a refusal
        ws.send(JSON.stringify({ type: "control_request", request_id: "perm-x", request: { subtype: "can_use_tool", tool_name: "Bash" }, agent_id: "a", conversation_id: "c" }));
        ws.send(JSON.stringify({ type: "app_server_info_response", request_id: m.request_id, success: true, backend: "local", protocol_version: 1, capabilities: { runtime_start: true } }));
      } else if (m.type === "runtime_start") {
        const ok = m.agent_id !== "agent-missing";
        ws.send(JSON.stringify({ type: "runtime_start_response", request_id: m.request_id, success: ok, ...(ok ? { runtime: { agent_id: m.agent_id, conversation_id: m.conversation_id } } : { error: "Agent agent-missing not found" }) }));
      } else if (m.type === "input") {
        // the real server acknowledges with input_accepted (no _response suffix)
        ws.send(JSON.stringify({ type: "input_accepted", request_id: m.request_id, runtime: m.runtime, accepted: true, disposition: "started" }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    received,
    push: (event: object) => {
      for (const s of sockets) s.send(JSON.stringify(event));
    },
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

describe("app-server client", () => {
  test("probe recognizes an app-server and rejects a plain websocket", async () => {
    const srv = fakeAppServer();
    const plain = new WebSocketServer({ port: 0 });
    try {
      expect(await probeAppServer(srv.url)).toMatchObject({ protocol_version: 1, backend: "local" });
      expect(await probeAppServer(`ws://127.0.0.1:${(plain.address() as { port: number }).port}/ws`, 400)).toBeNull();
      expect(await probeAppServer("ws://127.0.0.1:1/ws", 400)).toBeNull();
    } finally {
      await srv.close();
      plain.close();
    }
  });

  test("runtime_start correlates by request_id, records subscriptions, surfaces errors", async () => {
    const srv = fakeAppServer();
    const client = new AppServerClient(srv.url);
    try {
      const rt = { agent_id: "agent-1", conversation_id: "conv-1" };
      const res = await client.runtimeStart(rt, "/tmp");
      expect(res.success).toBe(true);
      expect(client.isSubscribed(rt)).toBe(true);
      const start = srv.received.find((m) => m.type === "runtime_start")!;
      expect(start).toMatchObject({ agent_id: "agent-1", conversation_id: "conv-1", cwd: "/tmp" });
      expect(start.mode).toBeUndefined(); // naming a mode would reset the user's permission mode in Desktop
      await expect(client.runtimeStart({ agent_id: "agent-missing", conversation_id: "c" })).rejects.toThrow(/not found/);
      expect(client.isSubscribed({ agent_id: "agent-missing", conversation_id: "c" })).toBe(false);
    } finally {
      client.close();
      await srv.close();
    }
  });

  test("sendUserMessage submits create_message input; events fan out to listeners", async () => {
    const srv = fakeAppServer();
    const client = new AppServerClient(srv.url);
    try {
      const rt = { agent_id: "agent-1", conversation_id: "conv-1" };
      const events: string[] = [];
      client.on((e) => events.push(e.type));
      await client.runtimeStart(rt);
      const res = await client.sendUserMessage(rt, "hello", "cm-1");
      expect(res).toEqual({ accepted: true, disposition: "started" });
      const input = srv.received.find((m) => m.type === "input") as { payload: { kind: string; messages: Array<Record<string, unknown>> } };
      expect(input.payload.kind).toBe("create_message");
      expect(input.payload.messages[0]).toMatchObject({ role: "user", content: "hello", client_message_id: "cm-1" });
      srv.push({ type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: "hi" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain("stream_delta");
      expect(events).not.toContain("input_accepted"); // correlated replies are not fanned out
    } finally {
      client.close();
      await srv.close();
    }
  });

  test("discovery parsers: lsof -Fn output and the gateway command line", () => {
    expect(parseLsofPorts("p56965\nn127.0.0.1:41414\nn127.0.0.1:49985\nn*:41414\n")).toEqual([41414, 49985]);
    expect(parseGatewayUrls("/Applications/Letta.app/Contents/MacOS/Letta letta.js channel-gateway --app-server-url ws://127.0.0.1:49985/ws --channels  --restore-enabled-channels\nnode vite\n")).toEqual(["ws://127.0.0.1:49985/ws"]);
    expect(parseGatewayUrls("nothing here")).toEqual([]);
  });

  test("deltaText handles string and parts content", () => {
    expect(deltaText({ content: "abc" })).toBe("abc");
    expect(deltaText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("ab");
    expect(deltaText(undefined)).toBe("");
  });
});
