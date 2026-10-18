/**
 * Two Macs pairing over real sockets (plan 023, U1), under Node's own test runner, the daemon's runtime:
 * `npm run test:node`. Each "Mac" is a phone listener with its own stores; requests count as coming over the tailnet
 * unless a test says otherwise, since a test cannot join a real one.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket as WsClient } from "ws";
import type { DeviceVia } from "../core/frame-types.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { DeviceStore } from "../mod/devices.ts";
import { LanListener } from "../mod/lan.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers } from "../mod/peers.ts";
import type { Client } from "../mod/server.ts";

const DESKTOP = "0123456789abcdef0123456789abcdef";

/** One Mac: its listener, stores and pairing, on an ephemeral port; `via` decides which way requests count as arriving. */
async function mac(name: string, macId: string, opts: { via?: DeviceVia; protocol?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `loki-peer-${name}-`));
  const devices = new DeviceStore(join(dir, "devices.json"));
  const store = new PeerStore(join(dir, "peers.json"));
  const secrets = memorySecrets();
  const keys = new PeerKeys(secrets);
  const codes = new PairingCodes();
  const phoneCodes = new PairingCodes();
  const sockets: Client[] = [];
  let lan: LanListener | null = null;
  const peers = new Peers({
    store,
    keys,
    codes,
    me: () => ({ mac_id: macId, name, host: `127.0.0.1:${lan?.status().port ?? 0}`, build: "b1", protocol: opts.protocol ?? PEER_PROTOCOL }),
    timeoutMs: 2000,
    onForget: (id) => lan?.closePeer(id),
  });
  lan = new LanListener({
    port: 0,
    stateFile: join(dir, "lan.json"),
    devices,
    codes: phoneCodes,
    handlers: { onConnect: (c) => (sockets.push(c), c.send({ type: "hello", peer: c.peerId ?? null, device: c.deviceId ?? null })), onMessage: () => {} },
    desktopToken: DESKTOP,
    appDist: null,
    peers,
    via: () => opts.via ?? "tailscale",
  });
  await lan.setPeersNeeded(true);
  const host = `127.0.0.1:${lan.status().port}`;
  return {
    name,
    macId,
    host,
    lan,
    store,
    keys,
    secrets,
    codes,
    phoneCodes,
    devices,
    peers,
    sockets,
    done: async () => {
      await lan.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MACBOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

/** "open" with the first frame once the bridge says hello, "closed" when the upgrade is refused. */
const socket = (url: string, headers: Record<string, string>) =>
  new Promise<string>((resolve) => {
    const ws = new WsClient(url, { headers });
    const t = setTimeout(() => resolve("timeout"), 2000);
    ws.on("error", () => {});
    ws.once("message", (raw) => {
      clearTimeout(t);
      ws.close();
      resolve(`open ${(Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString("utf8")}`);
    });
    ws.once("close", () => {
      clearTimeout(t);
      resolve("closed");
    });
  });

void test("a code shown on one Mac and typed on the other pairs them both ways", async () => {
  const book = await mac("MacBook", MACBOOK);
  const mini = await mac("Mac mini", MINI);
  try {
    const { code } = book.codes.mint();
    const peer = await mini.peers.join(book.host, code);
    assert.equal(peer.mac_id, MACBOOK);
    assert.deepEqual(
      book.store.list().map((p) => [p.mac_id, p.name, p.outdated]),
      [[MINI, "Mac mini", false]],
    );
    assert.deepEqual(
      mini.store.list().map((p) => [p.mac_id, p.host]),
      [[MACBOOK, book.host]],
    );
    // Each holds the other's token, and that token opens the other's door.
    const bookToken = await book.keys.get(MINI);
    const miniToken = await mini.keys.get(MACBOOK);
    assert.ok(bookToken && miniToken && bookToken !== miniToken);
    assert.equal(mini.store.verify(bookToken)?.mac_id, MACBOOK);
    assert.equal(book.store.verify(miniToken)?.mac_id, MINI);
    // Hearing from each other works and refreshes the record.
    assert.equal(await mini.peers.contact(MACBOOK), "ok");
    assert.equal(await book.peers.contact(MINI), "ok");
    // A paired Mac's socket opens and names it.
    assert.equal(
      await socket(`ws://${book.host}/ws?desk=c1`, { authorization: `Bearer ${miniToken}` }),
      `open {"type":"hello","peer":"${MINI}","device":null}`,
    );
  } finally {
    await book.done();
    await mini.done();
  }
});

void test("a wrong or expired code pairs nothing on either side", async () => {
  const book = await mac("MacBook", MACBOOK);
  const mini = await mac("Mac mini", MINI);
  try {
    await assert.rejects(() => mini.peers.join(book.host, "ZZZZZZ"), /unknown or expired code/);
    assert.deepEqual(book.store.list(), []);
    assert.deepEqual(mini.store.list(), []);
    assert.equal(mini.secrets.entries.size, 0);
  } finally {
    await book.done();
    await mini.done();
  }
});

void test("a Mac pairing over the Wi‑Fi is refused, even with a good code", async () => {
  const book = await mac("MacBook", MACBOOK, { via: "lan" });
  const mini = await mac("Mac mini", MINI);
  try {
    await assert.rejects(() => mini.peers.join(book.host, book.codes.mint().code), /Macs pair over Tailscale only/);
    assert.deepEqual(book.store.list(), []);
  } finally {
    await book.done();
    await mini.done();
  }
});

void test("a Mac's token opens no phone route, a phone's opens no Mac route, and the desktop token opens neither", async () => {
  const book = await mac("MacBook", MACBOOK);
  const mini = await mac("Mac mini", MINI);
  try {
    await book.lan.setEnabled(true);
    await mini.peers.join(book.host, book.codes.mint().code);
    const miniToken = await mini.keys.get(MACBOOK);
    assert.ok(miniToken);
    const phone = book.devices.mint("phone");
    const me = await fetch(`http://${book.host}/me`, { headers: { authorization: `Bearer ${miniToken}` } });
    assert.equal(me.status, 401);
    const hello = await fetch(`http://${book.host}/peer/hello`, { headers: { authorization: `Bearer ${phone.token}` } });
    assert.equal(hello.status, 401);
    const desktop = await fetch(`http://${book.host}/peer/hello`, { headers: { authorization: `Bearer ${DESKTOP}` } });
    assert.equal(desktop.status, 401);
  } finally {
    await book.done();
    await mini.done();
  }
});

void test("forgetting a Mac tells it, and both forget; a Mac told nothing finds out at its next contact", async () => {
  const book = await mac("MacBook", MACBOOK);
  const mini = await mac("Mac mini", MINI);
  try {
    await mini.peers.join(book.host, book.codes.mint().code);
    assert.equal(await book.peers.forget(MINI), true);
    assert.deepEqual(book.store.list(), []);
    assert.deepEqual(mini.store.list(), []);
    assert.equal(await mini.keys.get(MACBOOK), null);

    // Pair again, then forget while the other Mac is out of reach.
    await mini.peers.join(book.host, book.codes.mint().code);
    await mini.lan.stop();
    assert.equal(await book.peers.forget(MINI), true);
    assert.equal(mini.store.list().length, 1);
    assert.equal(await mini.peers.contact(MACBOOK), "unpaired");
    assert.deepEqual(mini.store.list(), []);
  } finally {
    await book.done();
    await mini.done();
  }
});

void test("the listener stays up for a paired Mac with the phone switch off, and lets no phone in", async () => {
  const book = await mac("MacBook", MACBOOK);
  const mini = await mac("Mac mini", MINI);
  try {
    await book.lan.setEnabled(true);
    const phone = book.devices.mint("phone");
    await mini.peers.join(book.host, book.codes.mint().code);
    await book.lan.setEnabled(false);
    assert.equal(book.lan.status().enabled, false);
    assert.equal(await mini.peers.contact(MACBOOK), "ok");
    assert.equal(await socket(`ws://${book.host}/ws?desk=c1`, { authorization: `Bearer ${phone.token}` }), "closed");
    const page = await fetch(`http://${book.host}/`);
    assert.equal(page.status, 404);
  } finally {
    await book.done();
    await mini.done();
  }
});

void test("a Mac on another protocol stays paired and is listed as needing an update", async () => {
  const book = await mac("MacBook", MACBOOK);
  const mini = await mac("Mac mini", MINI, { protocol: PEER_PROTOCOL + 1 });
  try {
    await mini.peers.join(book.host, book.codes.mint().code);
    assert.deepEqual(
      book.store.list().map((p) => p.outdated),
      [true],
    );
    assert.deepEqual(
      mini.store.list().map((p) => p.outdated),
      [false],
    );
  } finally {
    await book.done();
    await mini.done();
  }
});
