import { describe, expect, test } from "vitest";
import { attachWs, sameSecret, startServer, type Client } from "../mod/server.ts";
import { WS_PROTOCOL, tokenFromProtocols, tokenProtocols } from "../core/ws-auth.ts";
import { WebSocket as WsClient } from "../mod/ws.ts";

describe("the token in the subprotocol header, not the URL", () => {
  test("a tab sends it as a protocol; the server answers loki and lets it in; a wrong one is refused", async () => {
    const s = await startServer({ port: 0 });
    const bridge = attachWs(s.server, "0123456789abcdef0123456789abcdef", { onConnect: (c) => c.send({ type: "hello" }), onMessage: () => {} });
    try {
      const good = new WebSocket(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols("0123456789abcdef0123456789abcdef"));
      await new Promise<void>((resolve, reject) => {
        good.onmessage = () => resolve();
        good.onerror = () => reject(new Error("refused"));
      });
      expect(good.protocol).toBe(WS_PROTOCOL);
      good.close();
      const bad = new WebSocket(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols("ffffffffffffffffffffffffffffffff"));
      let opened = false;
      bad.onopen = () => (opened = true);
      await new Promise<void>((resolve) => {
        bad.onerror = () => resolve();
        bad.onclose = () => resolve();
      });
      expect(opened).toBe(false);
    } finally {
      bridge.close();
      await s.close();
    }
  });

  test("reading it back, and comparing in constant time", () => {
    expect(tokenProtocols("")).toEqual([]); // a phone: its cookie is the credential
    expect(tokenFromProtocols("loki, loki.t.abc")).toBe("abc");
    expect(tokenFromProtocols(["loki", "loki.t.abc"])).toBe("abc");
    expect(tokenFromProtocols("loki")).toBeNull();
    expect(tokenFromProtocols(undefined)).toBeNull();
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret("ab", "abc")).toBe(false);
    expect(sameSecret(null, "abc")).toBe(false);
  });
});

describe("a frame the server cannot read", () => {
  test("invalid UTF-8 closes that socket only; the server keeps serving", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const s = await startServer({ port: 0 });
    const bridge = attachWs(s.server, token, { onConnect: (c) => c.send({ type: "hello" }), onMessage: () => {} });
    const open = (ws: WsClient) =>
      new Promise<void>((resolve, reject) => {
        ws.once("message", () => resolve());
        ws.once("error", reject);
      });
    try {
      const bad = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      await open(bad);
      const closed = new Promise<number>((resolve) => bad.once("close", (code) => resolve(code)));
      bad.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
      expect(await closed).toBe(1007);
      const good = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      await open(good);
      good.close();
    } finally {
      bridge.close();
      await s.close();
    }
  });
});

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
      const health: unknown = await (await fetch(`http://127.0.0.1:${s.port}/health`)).json();
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
        good.onmessage = (ev) => resolve(JSON.parse(String(ev.data)) as Record<string, unknown>);
      });
      expect(hello).toEqual({ type: "hello", scope: "conv_1" });
      good.send(JSON.stringify({ type: "gesture", gesture: { kind: "focus", id: "conv_1/a" } }));
      good.send("not json");
      const err = await new Promise<Record<string, unknown>>((resolve) => {
        good.onmessage = (ev) => resolve(JSON.parse(String(ev.data)) as Record<string, unknown>);
      });
      expect(err).toEqual({ type: "error", message: "invalid json" });
      expect(received[0]).toEqual(["conv_1", { type: "gesture", gesture: { kind: "focus", id: "conv_1/a" } }]);

      // scoped broadcast
      const other = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=tok&desk=other`);
      await new Promise<void>((resolve) => {
        other.onmessage = () => resolve();
      });
      const got: string[] = [];
      good.onmessage = (ev) => got.push(`good:${(JSON.parse(String(ev.data)) as { type: string }).type}`);
      other.onmessage = (ev) => got.push(`other:${(JSON.parse(String(ev.data)) as { type: string }).type}`);
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
