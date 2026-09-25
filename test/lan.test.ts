import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { DeviceStore } from "../mod/devices.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { LanListener, type LanStatus, bonjourHost, crossSite, requestVia, isTailnetAddress } from "../mod/lan.ts";
import { Tailscale } from "../mod/tailscale.ts";
import type { Client, WsHandlers } from "../mod/server.ts";
import type { IncomingMessage } from "node:http";
import type { networkInterfaces } from "node:os";
import { SERVE_41415, STATUS_RUNNING } from "./fixtures/tailscale.ts";

// These tests open sockets and spawn processes; on a loaded machine (a Rust build beside them, a CI runner) one
// of them has crossed bun's 5 s default. Twenty seconds still catches a hang.
setDefaultTimeout(20_000);

const DESKTOP = "0123456789abcdef0123456789abcdef";
const TAILNET = "my-macbook-pro.tail1234.ts.net";

/** A Tailscale whose CLI is recorded output: running (or stopped), with or without the https front on `port`. */
function fakeTailscale(opts: { running?: boolean; serve?: boolean; port?: number } = {}) {
  const port = opts.port ?? 41415;
  const serve = opts.serve ?? false;
  return new Tailscale({
    bin: "/fake/tailscale",
    port,
    exec: async (_bin, args) => {
      if (args[0] === "status") return opts.running === false ? JSON.stringify({ BackendState: "Stopped", Self: { DNSName: `${TAILNET}.` } }) : STATUS_RUNNING;
      if (args[0] === "serve" && args[1] === "status") return serve ? SERVE_41415.replace("41415", String(port)) : "{}";
      return "";
    },
  });
}

function fixture(opts: { port?: number; appDist?: string | null; tailscale?: Tailscale; host?: () => string | null; interfaces?: () => ReturnType<typeof networkInterfaces> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-lan-"));
  const devices = new DeviceStore(join(dir, "devices.json"));
  const codes = new PairingCodes();
  const connected: Client[] = [];
  const handlers: WsHandlers = {
    onConnect: (c) => {
      connected.push(c);
      c.send({ type: "hello", scope: c.scope, deviceId: c.deviceId ?? null });
    },
    onMessage: (c, m) => {
      if (m.type === "list_desks") c.send({ type: "desks", desks: [{ scope: c.scope }] });
    },
    appServerUrl: () => null,
  };
  const changes: Array<["status" | "devices", LanStatus]> = [];
  writeFileSync(join(dir, "face.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const lan = new LanListener({
    port: opts.port ?? 0,
    stateFile: join(dir, "lan.json"),
    devices,
    codes,
    handlers,
    desktopToken: DESKTOP,
    profile: (id) => (id === "a1" ? join(dir, "face.png") : null),
    appDist: opts.appDist === undefined ? null : opts.appDist,
    onChange: (what, status) => changes.push([what, status]),
    tailscale: opts.tailscale,
    host: opts.host,
    interfaces: opts.interfaces,
  });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, devices, codes, handlers, connected, changes, lan, cleanup };
}

const base = (lan: LanListener) => `http://127.0.0.1:${lan.status().port}`;

async function pair(lan: LanListener, code: string, name = "phone"): Promise<{ res: Response; cookie: string; token: string; body: { deviceId: string; name: string } }> {
  const res = await fetch(`${base(lan)}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = /loki_device=([a-f0-9]*)/.exec(setCookie)?.[1] ?? "";
  return { res, cookie: `loki_device=${token}`, token, body: (await res.json()) as { deviceId: string; name: string } };
}

/** Resolves when the socket closes, or after `ms` with "timeout". */
const closedWithin = (ws: WsClient, ms: number) =>
  new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    ws.once("close", () => {
      clearTimeout(t);
      resolve("closed");
    });
  });

/** A client whose errors (a destroyed upgrade is one) never go unhandled. */
function connect(url: string, headers: Record<string, string> = {}): WsClient {
  const ws = new WsClient(url, { headers });
  ws.on("error", () => {});
  return ws;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("LAN listener", () => {
  test("off by default: nothing listens and the state file says so", async () => {
    const port = await freePort();
    const f = fixture({ port });
    try {
      expect(f.lan.enabled()).toBe(false);
      const s = f.lan.status();
      expect(s).toMatchObject({ enabled: false, port, appServed: false, error: null });
      expect(Array.isArray(s.addresses)).toBe(true);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeDefined();
      expect(f.changes).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test("enable persists first, binds, serves /health; disable closes and fires the callback", async () => {
    const f = fixture();
    try {
      const status = await f.lan.setEnabled(true);
      expect(status.enabled).toBe(true);
      expect(status.error).toBeNull();
      expect(status.port).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(join(f.dir, "lan.json"), "utf8"))).toEqual({ enabled: true });
      expect(f.changes.map((c) => c[0])).toEqual(["status"]);
      expect(f.changes[0][1].enabled).toBe(true);
      const health = await fetch(`${base(f.lan)}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });
      // a fresh instance reads the setting back (this is what activate does after /reload)
      const again = new LanListener({ stateFile: join(f.dir, "lan.json"), devices: f.devices, codes: f.codes, handlers: f.handlers, port: 0 });
      expect(again.enabled()).toBe(true);

      const port = status.port;
      const off = await f.lan.setEnabled(false);
      expect(off.enabled).toBe(false);
      expect(JSON.parse(readFileSync(join(f.dir, "lan.json"), "utf8"))).toEqual({ enabled: false });
      expect(f.changes.map((c) => c[0])).toEqual(["status", "status"]);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeDefined();
    } finally {
      await f.lan.stop();
      f.cleanup();
    }
  });

  test("a bind conflict is reported in status, never thrown", async () => {
    const a = fixture();
    let b: ReturnType<typeof fixture> | null = null;
    try {
      await a.lan.setEnabled(true);
      b = fixture({ port: a.lan.status().port });
      const status = await b.lan.setEnabled(true);
      expect(status.enabled).toBe(true);
      expect(status.error).toContain("EADDRINUSE");
      expect(b.changes.map((c) => c[0])).toEqual(["status"]);
      expect(b.changes[0][1].error).toContain("EADDRINUSE");
      expect(b.lan.enabled()).toBe(true); // the setting stays; the next start may succeed
    } finally {
      await a.lan.stop();
      await b?.lan.stop();
      a.cleanup();
      b?.cleanup();
    }
  });

  test("pairing: bad code 404, good code sets an HttpOnly cookie, /me and /unpair follow it", async () => {
    const f = fixture();
    try {
      await f.lan.setEnabled(true);
      const bad = await fetch(`${base(f.lan)}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "ZZZZZZ", name: "x" }) });
      expect(bad.status).toBe(404);
      // Cross-site protection: a body not declared JSON (what a form or no-cors text post looks like) is 415,
      // a foreign Origin is 403, the page's own origin passes, and a JSON body that is not JSON is 400.
      expect((await fetch(`${base(f.lan)}/pair`, { method: "POST", body: "not json" })).status).toBe(415);
      expect((await fetch(`${base(f.lan)}/pair`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" })).status).toBe(403);
      expect((await fetch(`${base(f.lan)}/pair`, { method: "POST", headers: { "content-type": "application/json", origin: base(f.lan) }, body: "{" })).status).toBe(400);
      expect((await fetch(`${base(f.lan)}/unpair`, { method: "POST" })).status).toBe(415);
      expect((await fetch(`${base(f.lan)}/me`)).status).toBe(401);

      const { code } = f.codes.mint();
      const p = await pair(f.lan, code, "Deepak's iPhone");
      expect(p.res.status).toBe(200);
      expect(p.body.name).toBe("Deepak's iPhone");
      expect(p.token).toMatch(/^[a-f0-9]{64}$/);
      const setCookie = p.res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("loki_device=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Max-Age=31536000");
      expect(f.devices.list().map((d) => d.id)).toEqual([p.body.deviceId]);
      expect(f.changes.filter((c) => c[0] === "devices")).toHaveLength(1);

      const me = await fetch(`${base(f.lan)}/me`, { headers: { cookie: p.cookie } });
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ deviceId: p.body.deviceId, name: "Deepak's iPhone" });
      // The request came from loopback with no tailnet marks: the Wi‑Fi route, recorded on the device for Settings.
      expect(f.devices.list()[0].lastVia).toBe("lan");
      const bearer = await fetch(`${base(f.lan)}/me`, { headers: { authorization: `Bearer ${p.token}` } });
      expect(bearer.status).toBe(200);
      expect((await fetch(`${base(f.lan)}/me`, { headers: { authorization: `Bearer ${DESKTOP}` } })).status).toBe(401);

      // the same code pairs again inside its window: a second device (the Home Screen app's own cookie jar)
      const q = await pair(f.lan, code.toLowerCase(), "Home Screen");
      expect(q.res.status).toBe(200);
      expect(q.body.deviceId).not.toBe(p.body.deviceId);
      expect(f.devices.list()).toHaveLength(2);

      const un = await fetch(`${base(f.lan)}/unpair`, { method: "POST", headers: { cookie: p.cookie, "content-type": "application/json" } });
      expect(un.status).toBe(200);
      expect(un.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await fetch(`${base(f.lan)}/me`, { headers: { cookie: p.cookie } })).status).toBe(401);
      expect(f.devices.list().map((d) => d.id)).toEqual([q.body.deviceId]);
    } finally {
      await f.lan.stop();
      f.cleanup();
    }
  });

  test("ten wrong codes from one address and it waits; a right code clears the slate", async () => {
    const f = fixture();
    try {
      await f.lan.setEnabled(true);
      for (let i = 0; i < 9; i++) expect((await pair(f.lan, "ZZZZZZ")).res.status).toBe(404);
      const { code } = f.codes.mint();
      expect((await pair(f.lan, code)).res.status).toBe(200); // the ninth miss did not block; a hit resets
      for (let i = 0; i < 10; i++) expect((await pair(f.lan, "ZZZZZZ")).res.status).toBe(404);
      const fresh = f.codes.mint().code;
      expect((await pair(f.lan, fresh)).res.status).toBe(429); // blocked even with a valid code
    } finally {
      await f.lan.stop();
      f.cleanup();
    }
  });

  test("upgrades: desktop token refused, device cookie or bearer reaches the bridge, forget closes the socket", async () => {
    const f = fixture();
    try {
      await f.lan.setEnabled(true);
      const { code } = f.codes.mint();
      const p = await pair(f.lan, code);

      const viaDesktopQuery = connect(`ws://127.0.0.1:${f.lan.status().port}/ws?t=${DESKTOP}&desk=c1`);
      expect(await closedWithin(viaDesktopQuery, 1000)).toBe("closed");
      const viaDesktopBearer = connect(`ws://127.0.0.1:${f.lan.status().port}/ws?desk=c1`, { authorization: `Bearer ${DESKTOP}` });
      expect(await closedWithin(viaDesktopBearer, 1000)).toBe("closed");
      const noAuth = connect(`ws://127.0.0.1:${f.lan.status().port}/ws?desk=c1`);
      expect(await closedWithin(noAuth, 1000)).toBe("closed");
      expect(f.connected).toHaveLength(0);
      expect(f.lan.clientCount()).toBe(0);

      const good = connect(`ws://127.0.0.1:${f.lan.status().port}/ws?t=${DESKTOP}&desk=conv%2F1`, { cookie: p.cookie });
      const hello = await new Promise<Record<string, unknown>>((resolve) => good.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      expect(hello).toEqual({ type: "hello", scope: "conv_1", deviceId: p.body.deviceId });
      good.send(JSON.stringify({ type: "list_desks" }));
      const desks = await new Promise<Record<string, unknown>>((resolve) => good.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      expect(desks).toEqual({ type: "desks", desks: [{ scope: "conv_1" }] });
      expect(f.lan.clientCount()).toBe(1);

      const viaBearer = connect(`ws://127.0.0.1:${f.lan.status().port}/ws?desk=c2`, { authorization: `Bearer ${p.token}` });
      await new Promise<void>((resolve) => viaBearer.once("message", () => resolve()));
      expect(f.lan.clientCount()).toBe(2);

      // broadcast reaches phones
      const got = new Promise<Record<string, unknown>>((resolve) => good.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      f.lan.broadcast({ type: "ping" });
      expect(await got).toEqual({ type: "ping" });

      // forget: the record goes and both live sockets close within a second
      const closes = Promise.all([closedWithin(good, 1000), closedWithin(viaBearer, 1000)]);
      expect(f.lan.forget(p.body.deviceId)).toBe(true);
      expect(await closes).toEqual(["closed", "closed"]);
      expect(f.devices.list()).toEqual([]);
      expect(f.lan.clientCount()).toBe(0);
      expect((await fetch(`${base(f.lan)}/me`, { headers: { cookie: p.cookie } })).status).toBe(401);
    } finally {
      await f.lan.stop();
      f.cleanup();
    }
  });

  test("a new canvas build is announced to phones as app_build and shows in /health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-lan-build-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html><head></head><body><div id=\"root\"></div></body></html>");
    const f = fixture({ appDist: dir });
    try {
      await f.lan.setEnabled(true);
      const first = ((await (await fetch(`${base(f.lan)}/health`)).json()) as { build: string }).build;
      expect(first).toMatch(/^[a-f0-9]{12}$/);
      const html = await (await fetch(`${base(f.lan)}/`)).text();
      expect(html).toContain(`build:"${first}"`);
      const { code } = f.codes.mint();
      const p = await pair(f.lan, code);
      const phone = connect(`ws://127.0.0.1:${f.lan.status().port}/ws?desk=shared`, { cookie: p.cookie });
      await new Promise<void>((r) => phone.once("message", () => r()));
      const announced = new Promise<Record<string, unknown>>((r) => phone.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "app_build") r(m); }));
      writeFileSync(join(dir, "index.html"), "<html><head></head><body><div id=\"root\"></div><!-- v2 --></body></html>");
      f.lan.checkBuild();
      const m = (await announced) as { build: string };
      expect(m.build).toMatch(/^[a-f0-9]{12}$/);
      expect(m.build).not.toBe(first);
      expect(((await (await fetch(`${base(f.lan)}/health`)).json()) as { build: string }).build).toBe(m.build);
      phone.close();
    } finally {
      await f.lan.stop();
      f.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no Tailscale given: via is lan, tailscale is null, and the old QR and state file are unchanged", async () => {
    const f = fixture({ port: 41415, host: () => "my-macbook-pro.local" });
    try {
      expect(f.lan.status()).toMatchObject({ via: "lan", tailscale: null });
      expect(await f.lan.refresh()).toMatchObject({ via: "lan", tailscale: null });
      expect(f.lan.pairUrl("ABC234")).toBe("http://my-macbook-pro.local:41415/?code=ABC234");
    } finally {
      f.cleanup();
    }
  });

  test("pairUrl prefers the https front, then the tailnet name, then the Bonjour name, then the address", async () => {
    const en0 = { en0: [{ address: "192.168.1.3", netmask: "255.255.255.0", family: "IPv4" as const, mac: "0", internal: false, cidr: "192.168.1.3/24" }] };
    const served = fixture({ port: 41415, tailscale: fakeTailscale({ serve: true }), host: () => "my-macbook-pro.local", interfaces: () => en0 });
    const named = fixture({ port: 41415, tailscale: fakeTailscale(), host: () => "my-macbook-pro.local", interfaces: () => en0 });
    const stopped = fixture({ port: 41415, tailscale: fakeTailscale({ running: false }), host: () => "my-macbook-pro.local", interfaces: () => en0 });
    const noName = fixture({ port: 41415, tailscale: fakeTailscale({ running: false }), host: () => null, interfaces: () => en0 });
    const nothing = fixture({ port: 41415, tailscale: fakeTailscale({ running: false }), host: () => null, interfaces: () => ({}) });
    try {
      // before the first refresh the cache only knows the binary exists: the Wi‑Fi route
      expect(served.lan.status().tailscale).toEqual({ installed: true, running: false, ip: null, name: null, serveUrl: null, error: null });
      expect(served.lan.pairUrl("ABC234")).toBe("http://my-macbook-pro.local:41415/?code=ABC234");

      const s = await served.lan.refresh();
      expect(s.via).toBe("tailscale");
      expect(s.tailscale).toEqual({ installed: true, running: true, ip: "100.101.102.103", name: TAILNET, serveUrl: `https://${TAILNET}`, error: null });
      expect(served.lan.pairUrl("ABC234")).toBe(`https://${TAILNET}/?code=ABC234`);

      expect((await named.lan.refresh()).tailscale?.serveUrl).toBeNull();
      expect(named.lan.pairUrl("ABC234")).toBe(`http://${TAILNET}:41415/?code=ABC234`);
      // the user's choice of the Wi‑Fi wins over a running tailnet
      expect(named.lan.setVia("lan").via).toBe("lan");
      expect(named.lan.pairUrl("ABC234")).toBe("http://my-macbook-pro.local:41415/?code=ABC234");
      expect(named.lan.setVia("tailscale").via).toBe("tailscale");
      expect(named.lan.pairUrl("ABC234")).toBe(`http://${TAILNET}:41415/?code=ABC234`);

      const st = await stopped.lan.refresh();
      expect(st.via).toBe("lan");
      expect(st.tailscale).toMatchObject({ running: false, name: TAILNET });
      expect(stopped.lan.pairUrl("ABC234")).toBe("http://my-macbook-pro.local:41415/?code=ABC234");
      // asking for the tailnet while it is stopped falls through to the Wi‑Fi rather than a dead name
      stopped.lan.setVia("tailscale");
      expect(stopped.lan.pairUrl("ABC234")).toBe("http://my-macbook-pro.local:41415/?code=ABC234");

      await noName.lan.refresh();
      expect(noName.lan.pairUrl("ABC234")).toBe("http://192.168.1.3:41415/?code=ABC234");
      await nothing.lan.refresh();
      expect(nothing.lan.pairUrl("ABC234")).toBe("http://127.0.0.1:41415/?code=ABC234");
    } finally {
      for (const f of [served, named, stopped, noName, nothing]) f.cleanup();
    }
  });

  test("via persists to lan.json, survives a new instance, and defaults to tailscale only while it runs", async () => {
    const f = fixture({ port: 41415, tailscale: fakeTailscale() });
    try {
      // an older file has no via: the default applies
      writeFileSync(join(f.dir, "lan.json"), JSON.stringify({ enabled: false }));
      const fresh = new LanListener({ stateFile: join(f.dir, "lan.json"), devices: f.devices, codes: f.codes, handlers: f.handlers, port: 41415, tailscale: fakeTailscale({ running: false }) });
      expect((await fresh.refresh()).via).toBe("lan");
      const running = new LanListener({ stateFile: join(f.dir, "lan.json"), devices: f.devices, codes: f.codes, handlers: f.handlers, port: 41415, tailscale: fakeTailscale() });
      expect((await running.refresh()).via).toBe("tailscale");

      f.changes.length = 0;
      expect(f.lan.setVia("lan").via).toBe("lan");
      expect(JSON.parse(readFileSync(join(f.dir, "lan.json"), "utf8"))).toEqual({ enabled: false, via: "lan" });
      expect(f.changes.map((c) => c[0])).toEqual(["status"]);
      expect(f.changes[0][1].via).toBe("lan");
      // the choice outlives a restart and an enable/disable, which rewrite the file
      const again = new LanListener({ stateFile: join(f.dir, "lan.json"), devices: f.devices, codes: f.codes, handlers: f.handlers, port: 41415, tailscale: fakeTailscale() });
      expect((await again.refresh()).via).toBe("lan");
      await f.lan.setEnabled(false);
      expect(JSON.parse(readFileSync(join(f.dir, "lan.json"), "utf8"))).toEqual({ enabled: false, via: "lan" });
      const junk = new LanListener({ stateFile: join(f.dir, "lan.json"), devices: f.devices, codes: f.codes, handlers: f.handlers, port: 41415 });
      writeFileSync(join(f.dir, "lan.json"), JSON.stringify({ enabled: true, via: "pigeon" }));
      expect(new LanListener({ stateFile: join(f.dir, "lan.json"), devices: f.devices, codes: f.codes, handlers: f.handlers, port: 41415 }).status()).toMatchObject({ enabled: true, via: "lan" });
      expect(junk.status().via).toBe("lan");
    } finally {
      f.cleanup();
    }
  });

  test("a refresh that changes the tailnet's answer broadcasts lan_status; one that does not stays quiet", async () => {
    let running = true;
    let serve = false;
    const ts = new Tailscale({
      bin: "/fake/tailscale",
      port: 41415,
      ttlMs: 0,
      exec: async (_bin, args) => {
        if (args[0] === "status") return running ? STATUS_RUNNING : JSON.stringify({ BackendState: "Stopped" });
        return serve ? SERVE_41415 : "{}";
      },
    });
    const f = fixture({ port: 41415, tailscale: ts });
    try {
      await f.lan.refresh();
      expect(f.changes).toEqual([]); // the first read is not a change
      await f.lan.refresh();
      expect(f.changes).toEqual([]);
      serve = true;
      await f.lan.refresh();
      expect(f.changes.map((c) => c[0])).toEqual(["status"]);
      expect(f.changes[0][1].tailscale?.serveUrl).toBe(`https://${TAILNET}`);
      running = false;
      await f.lan.refresh();
      expect(f.changes).toHaveLength(2);
      expect(f.changes[1][1]).toMatchObject({ via: "lan", tailscale: { running: false } });
    } finally {
      f.cleanup();
    }
  });

  test("the route of a request: a 100.x peer or tailscale serve on loopback is the tailnet; anything else is the Wi‑Fi", () => {
    const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });
    expect(requestVia(req("100.74.177.93"))).toBe("tailscale");
    expect(requestVia(req("::ffff:100.101.102.103"))).toBe("tailscale");
    expect(requestVia(req("127.0.0.1", { "x-forwarded-for": "100.74.177.93", host: "my-macbook-pro.tail1234.ts.net" }))).toBe("tailscale");
    expect(requestVia(req("127.0.0.1", { host: "my-macbook-pro.tail1234.ts.net:443" }))).toBe("tailscale");
    expect(requestVia(req("192.168.1.20", { host: "my-macbook-pro.local:41415" }))).toBe("lan");
    expect(requestVia(req("::ffff:172.20.0.7"))).toBe("lan");
    expect(requestVia(req("127.0.0.1"))).toBe("lan");
    // A 100.x address is only the tailnet inside CGNAT space (100.64–100.127); 100.1.x is somebody's real network.
    expect(requestVia(req("100.1.2.3"))).toBe("lan");
    expect(requestVia(req("192.168.1.20", { "x-forwarded-for": "100.74.177.93" }))).toBe("lan"); // a header alone proves nothing
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.127.255.254")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("10.8.0.2")).toBe(false);
  });

  test("the tailnet's 100.x address is not listed among the Wi‑Fi addresses", async () => {
    const f = fixture({ interfaces: () => ({ en0: [{ address: "192.168.1.3", family: "IPv4", internal: false }], utun4: [{ address: "100.74.177.93", family: "IPv4", internal: false }], lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }) as unknown as ReturnType<typeof networkInterfaces> });
    try {
      expect(f.lan.status().addresses).toEqual(["192.168.1.3"]);
      expect(f.lan.status().address).toBe("192.168.1.3");
    } finally {
      f.cleanup();
    }
  });

  test("cross-site: an Origin matching the Host, X-Forwarded-Host or an allowed host passes; a stranger is refused", () => {
    const req = (headers: Record<string, string>) => ({ headers: { "content-type": "application/json", ...headers } }) as unknown as IncomingMessage;
    const allowed = [TAILNET, `${TAILNET}:443`, "my-macbook-pro.local"];
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: `https://${TAILNET}` }), allowed)).toBeNull();
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: `https://${TAILNET}` }))).toMatchObject({ status: 403 });
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: "https://evil.example" }), allowed)).toMatchObject({ status: 403, error: "cross-site request refused" });
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: `https://${TAILNET}.evil.example` }), allowed)).toMatchObject({ status: 403 });
    expect(crossSite(req({ host: "127.0.0.1:41415", "x-forwarded-host": TAILNET, origin: `https://${TAILNET}` }))).toBeNull();
    expect(crossSite(req({ host: "127.0.0.1:41415", "x-forwarded-host": `${TAILNET}, 127.0.0.1:41415`, origin: `https://${TAILNET}` }))).toBeNull();
    expect(crossSite(req({ host: "My-MacBook-Pro.local:41415", origin: "http://my-macbook-pro.local:41415" }))).toBeNull();
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: "http://127.0.0.1:41415" }))).toBeNull();
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: "null" }))).toBeNull();
    expect(crossSite(req({ host: "127.0.0.1:41415", origin: "not a url" }), allowed)).toMatchObject({ status: 403, error: "bad origin" });
    expect(crossSite({ headers: { "content-type": "text/plain", origin: `https://${TAILNET}` } } as unknown as IncomingMessage, allowed)).toMatchObject({ status: 415 });
  });

  test("behind tailscale serve: /pair from the tailnet origin reaches the code check; a stranger is still 403", async () => {
    const port = await freePort();
    const f = fixture({ port, tailscale: fakeTailscale({ port }) });
    try {
      await f.lan.setEnabled(true);
      expect(f.lan.status().tailscale?.name).toBe(TAILNET); // start() refreshed
      const post = (origin: string, extra: Record<string, string> = {}) => fetch(`${base(f.lan)}/pair`, { method: "POST", headers: { "content-type": "application/json", origin, ...extra }, body: JSON.stringify({ code: "ZZZZZZ", name: "x" }) });
      expect((await post(`https://${TAILNET}`)).status).toBe(404); // past the origin check, the code is wrong
      expect((await post(`http://${TAILNET}:${port}`)).status).toBe(404);
      expect((await post("https://evil.example")).status).toBe(403);
      expect((await post("https://evil.example", { "x-forwarded-host": "evil.example" })).status).toBe(404); // a proxy in front vouches for the Host
    } finally {
      await f.lan.stop();
      f.cleanup();
    }
  });

  test("profile route needs device auth and ignores ?t=; static falls back to the SPA or a 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-lan-dist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html><head></head><body></body></html>");
    writeFileSync(join(dir, "assets", "a.js"), "1");
    const withApp = fixture({ appDist: dir });
    const noApp = fixture();
    try {
      await withApp.lan.setEnabled(true);
      await noApp.lan.setEnabled(true);
      expect(withApp.lan.status().appServed).toBe(true);
      expect(noApp.lan.status().appServed).toBe(false);
      const { code } = withApp.codes.mint();
      const p = await pair(withApp.lan, code);

      expect((await fetch(`${base(withApp.lan)}/agents/a1/profile.png`)).status).toBe(401);
      expect((await fetch(`${base(withApp.lan)}/agents/a1/profile.png?t=${DESKTOP}`)).status).toBe(401);
      const face = await fetch(`${base(withApp.lan)}/agents/a1/profile.png`, { headers: { cookie: p.cookie } });
      expect(face.status).toBe(200);
      expect(face.headers.get("content-type")).toBe("image/png");
      expect((await fetch(`${base(withApp.lan)}/agents/nobody/profile.png`, { headers: { cookie: p.cookie } })).status).toBe(404);

      const index = await fetch(`${base(withApp.lan)}/inbox?code=${code}`);
      expect(index.status).toBe(200);
      expect(await index.text()).toMatch(/<script>window\.__LOKI__=\{lan:true,build:"[a-f0-9]{12}",os:"(macos|windows|linux)"\}<\/script><\/head>/);
      expect(await (await fetch(`${base(withApp.lan)}/assets/a.js`)).text()).toBe("1");
      expect((await fetch(`${base(noApp.lan)}/`)).status).toBe(503);

      expect(withApp.lan.pairUrl("ABC234")).toMatch(/^http:\/\/[^/]+:\d+\/\?code=ABC234$/);
      // The Bonjour name wins over the address so a bookmark survives a new network; no name → the address.
      expect(withApp.lan.status().host).toBe(bonjourHost());
      expect(withApp.lan.pairUrl("ABC234").startsWith(`http://${withApp.lan.status().host ?? withApp.lan.status().address}:`)).toBe(true);
    } finally {
      await withApp.lan.stop();
      await noApp.lan.stop();
      withApp.cleanup();
      noApp.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
