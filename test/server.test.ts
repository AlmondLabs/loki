import { describe, expect, test } from "bun:test";
import { attachWs, startServer, type Client } from "../mod/server.ts";
import { WebSocketServer } from "ws";

describe("loki server", () => {
  test("health, 404s, tokenized WS upgrade, scope from URL", async () => {
    const s = await startServer({ port: 0, health: () => ({ desks: ["x"] }) });
    const connected: Client[] = [];
    const received: Array<[string, Record<string, unknown>]> = [];
    const bridge = attachWs(s.server, "tok", {
      onConnect: (c) => {
        connected.push(c);
        c.send({ type: "hello", scope: c.scope });
      },
      onMessage: (c, m) => received.push([c.scope, m]),
    });
    try {
      const health = await (await fetch(`http://127.0.0.1:${s.port}/health`)).json();
      expect(health).toEqual({ ok: true, desks: ["x"] });
      expect((await fetch(`http://127.0.0.1:${s.port}/anything`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${s.port}/assets/%zz`)).status).toBe(404);

      // bad token: no connection
      const bad = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=wrong&desk=c1`);
      await new Promise<void>((resolve) => {
        bad.onerror = () => resolve();
        bad.onclose = () => resolve();
      });
      expect(bridge.clientCount()).toBe(0);

      const good = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=tok&desk=conv%2F1`);
      const hello = await new Promise<Record<string, unknown>>((resolve) => {
        good.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      });
      expect(hello).toEqual({ type: "hello", scope: "conv_1" });
      good.send(JSON.stringify({ type: "gesture", gesture: { kind: "focus", id: "conv_1/a" } }));
      good.send("not json");
      const err = await new Promise<Record<string, unknown>>((resolve) => {
        good.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      });
      expect(err).toEqual({ type: "error", message: "invalid json" });
      expect(received[0]).toEqual(["conv_1", { type: "gesture", gesture: { kind: "focus", id: "conv_1/a" } }]);

      // scoped broadcast
      const other = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=tok&desk=other`);
      await new Promise<void>((resolve) => {
        other.onmessage = () => resolve();
      });
      const got: string[] = [];
      good.onmessage = (ev) => got.push(`good:${JSON.parse(String(ev.data)).type}`);
      other.onmessage = (ev) => got.push(`other:${JSON.parse(String(ev.data)).type}`);
      bridge.broadcast({ type: "only-conv" }, "conv_1");
      bridge.broadcast({ type: "all" });
      await new Promise((r) => setTimeout(r, 50));
      expect(got.sort()).toEqual(["good:all", "good:only-conv", "other:all"]);
      good.close();
      other.close();
    } finally {
      bridge.close();
      await s.close();
    }
  });
});

describe("app-server tunnel", () => {
  test("pipes frames both ways and closes together; no upstream → tunnel_error", async () => {
    const upstream = new WebSocketServer({ port: 0 });
    const upstreamSeen: string[] = [];
    upstream.on("connection", (ws) => ws.on("message", (raw) => { upstreamSeen.push(String(raw)); ws.send(JSON.stringify({ type: "echo", got: JSON.parse(String(raw)).type })); }));
    const upstreamUrl = `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/ws`;
    let target: string | null = upstreamUrl;
    const s = await startServer({ port: 0 });
    const bridge = attachWs(s.server, "tok", { onConnect: () => {}, onMessage: () => {}, appServerUrl: () => target });
    try {
      const browser = new WebSocket(`ws://127.0.0.1:${s.port}/appserver?t=tok`);
      const reply = await new Promise<Record<string, unknown>>((resolve) => {
        browser.onopen = () => browser.send(JSON.stringify({ type: "app_server_info", request_id: "1" }));
        browser.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      });
      expect(reply).toEqual({ type: "echo", got: "app_server_info" });
      expect(upstreamSeen).toEqual([JSON.stringify({ type: "app_server_info", request_id: "1" })]);
      browser.close();

      target = null;
      const noTarget = new WebSocket(`ws://127.0.0.1:${s.port}/appserver?t=tok`);
      const err = await new Promise<Record<string, unknown>>((resolve) => {
        noTarget.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      });
      expect(err).toMatchObject({ type: "tunnel_error" });

      const badToken = new WebSocket(`ws://127.0.0.1:${s.port}/appserver?t=nope`);
      await new Promise<void>((resolve) => { badToken.onerror = () => resolve(); badToken.onclose = () => resolve(); });
    } finally {
      bridge.close();
      await s.close();
      upstream.close();
    }
  });
});
