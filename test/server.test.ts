import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
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
    expect(tokenProtocols("")).toEqual([]);
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

describe("the limits of a socket", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const hello = (ws: WsClient) =>
    new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });
  const closed = (ws: WsClient) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  const until = async (ok: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  };

  test("a frame past the size limit closes that socket; one inside it is read", async () => {
    const s = await startServer({ port: 0 });
    const got: string[] = [];
    const bridge = attachWs(
      s.server,
      token,
      { onConnect: (c) => c.send({ type: "hello" }), onMessage: (_c, m) => got.push(String(m.type)) },
      { maxFrameBytes: 1000 },
    );
    try {
      const ws = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      ws.on("error", () => {});
      await hello(ws);
      const end = closed(ws);
      ws.send(JSON.stringify({ type: "small" }));
      ws.send(JSON.stringify({ type: "big", fill: "x".repeat(2000) }));
      expect(await end).toBe(1009);
      expect(got).toEqual(["small"]);
      await until(() => bridge.clientCount() === 0);
      expect(bridge.clientCount()).toBe(0);
    } finally {
      bridge.close();
      await s.close();
    }
  });

  test("a socket that stops answering pings is ended; one that answers stays", async () => {
    const s = await startServer({ port: 0 });
    const bridge = attachWs(s.server, token, { onConnect: (c) => c.send({ type: "hello" }), onMessage: () => {} }, { heartbeatMs: 40 });
    try {
      const gone = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token), { autoPong: false });
      const here = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      for (const ws of [gone, here]) ws.on("error", () => {});
      await Promise.all([hello(gone), hello(here)]);
      await closed(gone);
      expect(bridge.clientCount()).toBe(1);
      expect(here.readyState).toBe(WsClient.OPEN);
      here.close();
    } finally {
      bridge.close();
      await s.close();
    }
  });

  test("a socket with too much waiting unsent is ended rather than fed more, and every frame's after-send step still runs once", async () => {
    const s = await startServer({ port: 0 });
    let fed = 0;
    let steps = 0;
    const bridge = attachWs(
      s.server,
      token,
      {
        onConnect: (c) => c.send({ type: "hello" }),
        onMessage: (c) => {
          const fill = "x".repeat(1024 * 1024);
          for (let i = 0; i < 64 && bridge.clientCount() > 0; i++, fed++) c.send({ type: "push", fill }, () => steps++);
        },
      },
      { maxBufferedBytes: 64 * 1024 },
    );
    try {
      const ws = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      ws.on("error", () => {});
      await hello(ws);
      ws.pause();
      ws.send(JSON.stringify({ type: "go" }));
      await until(() => bridge.clientCount() === 0);
      expect(bridge.clientCount()).toBe(0);
      expect(fed).toBeLessThan(64);
      await until(() => steps === fed);
      expect(steps).toBe(fed);
      ws.terminate();
    } finally {
      bridge.close();
      await s.close();
    }
  });

  test("a frame's after-send step runs once the frame is written, once, and at once on a socket already gone", async () => {
    const s = await startServer({ port: 0 });
    const clients: Client[] = [];
    const bridge = attachWs(s.server, token, {
      onConnect: (c) => {
        clients.push(c);
        c.send({ type: "hello" });
      },
      onMessage: () => {},
    });
    try {
      const ws = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      await hello(ws);
      const [c] = clients;
      let steps = 0;
      const heard = new Promise<string>((resolve) => ws.once("message", (raw) => resolve(Buffer.isBuffer(raw) ? raw.toString("utf8") : "")));
      const written = new Promise<void>((resolve) =>
        c.send({ type: "chat_done", request_id: "r1" }, () => {
          steps++;
          resolve();
        }),
      );
      expect(steps).toBe(0);
      await written;
      expect(JSON.parse(await heard)).toEqual({ type: "chat_done", request_id: "r1" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(steps).toBe(1);
      const gone = closed(ws);
      ws.close();
      await gone;
      await until(() => bridge.clientCount() === 0);
      c.send({ type: "chat_done", request_id: "r2" }, () => steps++);
      expect(steps).toBe(2);
    } finally {
      bridge.close();
      await s.close();
    }
  });
});

describe("a refused upgrade", () => {
  test("a caller that hangs up on the refusal with a reset leaves the server serving", async () => {
    const s = await startServer({ port: 0 });
    const bridge = attachWs(s.server, "0123456789abcdef0123456789abcdef", { onConnect: () => {}, onMessage: () => {} });
    // Outside (Node): an 'error' on a socket with no listener is thrown, so the server's end of the upgrade is held here.
    const serverEnds: Duplex[] = [];
    s.server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => serverEnds.push(socket));
    const caller = connect(s.port, "127.0.0.1");
    try {
      caller.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      const answer = await new Promise<string>((resolve) => caller.once("data", (chunk: Buffer) => resolve(chunk.toString())));
      expect(answer).toMatch(/^HTTP\/1\.1 401/);
      const closed = new Promise((resolve) => serverEnds[0]?.once("close", resolve));
      caller.resetAndDestroy();
      await closed;
      expect((await fetch(`http://127.0.0.1:${s.port}/health`)).status).toBe(200);
    } finally {
      caller.destroy();
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

  test("a push for the paired Macs reaches a Mac's socket, and no tab or phone (plan 052)", async () => {
    const s = await startServer({ port: 0 });
    const bridge = attachWs(
      s.server,
      (_req, url) => ({ ok: true, peerId: url.searchParams.get("peer") ?? undefined, deviceId: url.searchParams.get("device") ?? undefined }),
      {
        onConnect: (c) => c.send({ type: "hello" }),
        onMessage: () => {},
      },
    );
    const open = (query: string) =>
      new Promise<{ ws: WebSocket; got: string[] }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?desk=c1&${query}`);
        const got: string[] = [];
        ws.onmessage = (ev) => {
          const type = (JSON.parse(String(ev.data)) as { type: string }).type;
          if (type === "hello") resolve({ ws, got });
          else got.push(type);
        };
      });
    const lastOf = (socket: { ws: WebSocket; got: string[] }) =>
      new Promise<void>((resolve) => {
        const before = socket.ws.onmessage;
        socket.ws.onmessage = (ev) => {
          before?.call(socket.ws, ev);
          if ((JSON.parse(String(ev.data)) as { type: string }).type === "last") resolve();
        };
      });
    try {
      const [mac, phone, tab] = await Promise.all([open("peer=m2"), open("device=d1"), open("tab=1")]);
      const done = Promise.all([mac, phone, tab].map(lastOf));
      bridge.broadcast({ type: "group_changed" }, undefined, "macs");
      bridge.broadcast({ type: "last" });
      await done;
      expect(mac.got).toEqual(["group_changed", "last"]);
      expect(phone.got).toEqual(["last"]);
      expect(tab.got).toEqual(["last"]);
      for (const c of [mac, phone, tab]) c.ws.close();
    } finally {
      bridge.close();
      await s.close();
    }
  });
});
