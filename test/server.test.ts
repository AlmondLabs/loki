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

describe("the limits of a socket", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const hello = (ws: WsClient) =>
    new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("error", reject);
    });
  const closed = (ws: WsClient) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  /** Wait for the server's side to catch up with a close the client already saw. */
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
      // A device that left the network: its socket is open here and nothing on it answers.
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

  test("a socket with too much waiting unsent is ended rather than fed more", async () => {
    const s = await startServer({ port: 0 });
    let fed = 0;
    const bridge = attachWs(
      s.server,
      token,
      {
        onConnect: (c) => c.send({ type: "hello" }),
        // Far more than any system keeps for a socket nobody reads: once its buffers are full the rest waits in the
        // daemon's memory, and the frame after the limit is passed ends the socket.
        onMessage: (c) => {
          const fill = "x".repeat(1024 * 1024);
          for (let i = 0; i < 64 && bridge.clientCount() > 0; i++, fed++) c.send({ type: "push", fill });
        },
      },
      { maxBufferedBytes: 64 * 1024 },
    );
    try {
      const ws = new WsClient(`ws://127.0.0.1:${s.port}/ws?desk=c1`, tokenProtocols(token));
      ws.on("error", () => {});
      await hello(ws);
      // A device that stopped reading, as a phone gone from the Wi-Fi has: how much its system buffers is not the
      // test's to guess, so it reads nothing at all.
      ws.pause();
      ws.send(JSON.stringify({ type: "go" }));
      await until(() => bridge.clientCount() === 0);
      expect(bridge.clientCount()).toBe(0);
      expect(fed).toBeLessThan(64);
      ws.terminate();
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

  test("a push for the paired Macs reaches a Mac's socket, and no tab or phone (plan 052)", async () => {
    const s = await startServer({ port: 0 });
    // Who each socket is, from its URL: what the LAN listener reads from a cookie or a Mac's key.
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
