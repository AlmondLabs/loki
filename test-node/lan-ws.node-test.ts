/**
 * The LAN listener's /ws refusing another site's Origin, under Node's own test runner, the daemon's runtime:
 * `npm run test:node`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket as WsClient } from "ws";
import { DeviceStore } from "../mod/devices.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { LanListener } from "../mod/lan.ts";

/** "open" once the bridge says hello, "closed" when the upgrade is refused, "timeout" if neither. */
const outcome = (url: string, headers: Record<string, string>) =>
  new Promise<string>((resolve) => {
    const ws = new WsClient(url, { headers });
    const t = setTimeout(() => resolve("timeout"), 2000);
    ws.on("error", () => {});
    ws.once("message", () => {
      clearTimeout(t);
      ws.close();
      resolve("open");
    });
    ws.once("close", () => {
      clearTimeout(t);
      resolve("closed");
    });
  });

void test("an upgrade from a page on another site is refused, even with the phone's cookie; the page's own origin connects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-lan-ws-"));
  const devices = new DeviceStore(join(dir, "devices.json"));
  const codes = new PairingCodes();
  const lan = new LanListener({
    port: 0,
    stateFile: join(dir, "lan.json"),
    devices,
    codes,
    handlers: { onConnect: (c) => c.send({ type: "hello" }), onMessage: () => {} },
    desktopToken: "0123456789abcdef0123456789abcdef",
    appDist: null,
  });
  try {
    await lan.setEnabled(true);
    const base = `127.0.0.1:${lan.status().port}`;
    const res = await fetch(`http://${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: codes.mint().code, name: "phone" }),
    });
    assert.equal(res.status, 200);
    const cookie = /loki_device=[a-f0-9]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
    assert.ok(cookie);
    assert.equal(await outcome(`ws://${base}/ws?desk=c1`, { cookie, origin: "http://evil.example" }), "closed");
    assert.equal(await outcome(`ws://${base}/ws?desk=c1`, { cookie, origin: `http://${base}` }), "open");
    assert.equal(await outcome(`ws://${base}/ws?desk=c1`, { cookie }), "open"); // the phone app's own socket names no Origin
  } finally {
    await lan.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
