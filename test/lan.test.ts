import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { DeviceStore } from "../mod/devices.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { LanListener, type LanStatus } from "../mod/lan.ts";
import type { Client, WsHandlers } from "../mod/server.ts";

const DESKTOP = "0123456789abcdef0123456789abcdef";

function fixture(opts: { port?: number; appDist?: string | null } = {}) {
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
      expect((await fetch(`${base(f.lan)}/pair`, { method: "POST", body: "not json" })).status).toBe(400);
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
      const bearer = await fetch(`${base(f.lan)}/me`, { headers: { authorization: `Bearer ${p.token}` } });
      expect(bearer.status).toBe(200);
      expect((await fetch(`${base(f.lan)}/me`, { headers: { authorization: `Bearer ${DESKTOP}` } })).status).toBe(401);

      // the same code pairs again inside its window: a second device (the Home Screen app's own cookie jar)
      const q = await pair(f.lan, code.toLowerCase(), "Home Screen");
      expect(q.res.status).toBe(200);
      expect(q.body.deviceId).not.toBe(p.body.deviceId);
      expect(f.devices.list()).toHaveLength(2);

      const un = await fetch(`${base(f.lan)}/unpair`, { method: "POST", headers: { cookie: p.cookie } });
      expect(un.status).toBe(200);
      expect(un.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await fetch(`${base(f.lan)}/me`, { headers: { cookie: p.cookie } })).status).toBe(401);
      expect(f.devices.list().map((d) => d.id)).toEqual([q.body.deviceId]);
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
      expect(await index.text()).toContain("<script>window.__LOKI__={lan:true}</script></head>");
      expect(await (await fetch(`${base(withApp.lan)}/assets/a.js`)).text()).toBe("1");
      expect((await fetch(`${base(noApp.lan)}/`)).status).toBe(503);

      expect(withApp.lan.pairUrl("ABC234")).toMatch(/^http:\/\/[^/]+:\d+\/\?code=ABC234$/);
    } finally {
      await withApp.lan.stop();
      await noApp.lan.stop();
      withApp.cleanup();
      noApp.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
