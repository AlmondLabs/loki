/**
 * The peer link between two Macs over real sockets (plan 023, U2): `npm run test:node`. The far Mac is a phone
 * listener serving the real frame router; the near Mac is only its link, holding the token the far Mac minted for it.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySecrets } from "../daemon/credentials.ts";
import { createBridge } from "../mod/bridge.ts";
import { DeviceStore } from "../mod/devices.ts";
import { peersFrames } from "../mod/frames/peers.ts";
import { LanListener } from "../mod/lan.ts";
import { initLog } from "../mod/log.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PeerLink, PeerLinks, type LinkStatus } from "../mod/peer-link.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, mintPeerToken } from "../mod/peers.ts";
import type { DeviceVia } from "../core/frame-types.ts";

const FAR = "cccccccc-3333-4333-8333-333333333333";
const NEAR = "dddddddd-4444-4444-8444-444444444444";

/** A port nothing listens on yet, so the far Mac can come back on the same one. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** Wait for a condition, or fail after `ms`. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * The far Mac: a listener on `port` with the real router, answering `peer_ping` with `protocol`, that knows the near
 * Mac by `token` and sees every request arrive by `via`.
 */
async function farMac(port: number, token: string, protocol = PEER_PROTOCOL, via: DeviceVia = "tailscale") {
  const dir = mkdtempSync(join(tmpdir(), "loki-link-"));
  const store = new PeerStore(join(dir, "peers.json"));
  store.add({ mac_id: NEAR, name: "near", host: "near:41415", build: null, protocol: PEER_PROTOCOL }, token);
  const peers = new Peers({
    store,
    keys: new PeerKeys(memorySecrets()),
    codes: new PairingCodes(),
    me: () => ({ mac_id: FAR, name: "far", host: `127.0.0.1:${port}`, build: "b1", protocol }),
  });
  let lan: LanListener | null = null;
  const bridge = createBridge({
    modules: [
      peersFrames({
        peers: {
          view: () => ({ me: { mac_id: FAR, name: "far", host: null }, peers: [] }),
          begin: () => Promise.resolve({ code: "x", host: null, expires_at: "" }),
          join: () => Promise.reject(new Error("no")),
          forget: () => Promise.resolve(false),
          hello: () => peers.hello(),
          agents: () => ({ agents: [], tombstones: [] }),
          chats: () => ({ desks: [], inbox: [] }),
          state: () => ({ marks: {}, pins: {}, labels: {}, learn: {}, mcp: {}, mods: {} }),
          memory: (agentId) => Promise.resolve({ agent_id: agentId, bundle: null }),
        },
      }),
    ],
    broadcast: (msg) => lan?.broadcast(msg),
  });
  lan = new LanListener({
    port,
    stateFile: join(dir, "lan.json"),
    devices: new DeviceStore(join(dir, "devices.json")),
    codes: new PairingCodes(),
    handlers: bridge,
    appDist: null,
    peers,
    via: () => via,
  });
  await lan.setPeersNeeded(true);
  return {
    lan,
    done: async () => {
      await lan.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The near Mac's link to the far Mac at `port`, with the backoff shortened. */
function nearLink(port: number, token: string) {
  const statuses: LinkStatus[] = [];
  const pushes: Array<Record<string, unknown>> = [];
  /** How many times the link has tried to open: one more for each retry. */
  const tries = { count: 0 };
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => {
      tries.count++;
      return Promise.resolve(token);
    },
    protocol: PEER_PROTOCOL,
    onStatus: (s) => statuses.push(s),
    onPush: (f) => pushes.push(f),
    minBackoffMs: 20,
    maxBackoffMs: 100,
    requestTimeoutMs: 2000,
  });
  return { link, statuses, pushes, tries };
}

void test("a request over the link gets its own reply, two at once, and a push reaches the near Mac", async () => {
  const port = await freePort();
  const token = mintPeerToken();
  const far = await farMac(port, token);
  const { link, pushes } = nearLink(port, token);
  try {
    link.start();
    await until(() => link.status === "reachable");
    const [a, b] = await Promise.all([link.request({ type: "peer_ping" }), link.request({ type: "peer_ping" })]);
    assert.equal(a.type, "peer_pong");
    assert.equal(b.mac_id, FAR);
    assert.notEqual(a.request_id, b.request_id);
    far.lan.broadcast({ type: "agents_changed" });
    await until(() => pushes.some((p) => p.type === "agents_changed"));
  } finally {
    link.stop();
    await far.done();
  }
});

void test("the far Mac going away makes it unreachable within a backoff step, and its return reconnects", async () => {
  const port = await freePort();
  const token = mintPeerToken();
  let far = await farMac(port, token);
  const { link, statuses, tries } = nearLink(port, token);
  try {
    link.start();
    await until(() => link.status === "reachable");
    await far.done();
    await until(() => link.status === "unreachable");
    await assert.rejects(() => link.request({ type: "peer_ping" }), /out of reach/);
    // Retries while it is away say nothing new (plan 048): no "connecting" between each one.
    const down = tries.count;
    await until(() => tries.count >= down + 3);
    assert.deepEqual(statuses, ["reachable", "unreachable"]);
    far = await farMac(port, token);
    await until(() => link.status === "reachable");
    assert.deepEqual(statuses, ["reachable", "unreachable", "reachable"]);
  } finally {
    link.stop();
    await far.done();
  }
});

void test("a frame not marked for Macs is refused by the far Mac and nothing runs", async () => {
  const port = await freePort();
  const token = mintPeerToken();
  const far = await farMac(port, token);
  const { link } = nearLink(port, token);
  try {
    link.start();
    await until(() => link.status === "reachable");
    await assert.rejects(() => link.request({ type: "peer_pair_join", host: "x", code: "y" }), /peer_pair_join is not available to another Mac/);
  } finally {
    link.stop();
    await far.done();
  }
});

void test("a far Mac on another protocol is outdated and is asked nothing", async () => {
  const port = await freePort();
  const token = mintPeerToken();
  const far = await farMac(port, token, PEER_PROTOCOL + 1);
  const { link } = nearLink(port, token);
  try {
    link.start();
    await until(() => link.status === "outdated");
    await assert.rejects(() => link.request({ type: "peer_ping" }), /another loki version/);
  } finally {
    link.stop();
    await far.done();
  }
});

void test("a token the far Mac does not know is refused, and the near Mac is told", async () => {
  const port = await freePort();
  const far = await farMac(port, mintPeerToken());
  let refused = 0;
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => Promise.resolve(mintPeerToken()),
    protocol: PEER_PROTOCOL,
    onRefused: () => refused++,
    minBackoffMs: 20,
    maxBackoffMs: 100,
  });
  try {
    link.start();
    await until(() => refused > 0);
    assert.notEqual(link.status, "reachable");
  } finally {
    link.stop();
    await far.done();
  }
});

void test("a known token that came the wrong way is turned away without telling the near Mac it was forgotten", async () => {
  const port = await freePort();
  const token = mintPeerToken();
  // The far Mac takes this caller for the Wi‑Fi: a path problem, which must never unpair the two.
  const far = await farMac(port, token, PEER_PROTOCOL, "lan");
  let refused = 0;
  let tries = 0;
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => {
      tries++;
      return Promise.resolve(token);
    },
    protocol: PEER_PROTOCOL,
    onRefused: () => refused++,
    minBackoffMs: 20,
    maxBackoffMs: 100,
  });
  try {
    link.start();
    await until(() => tries >= 3);
    assert.equal(link.status, "unreachable");
    assert.equal(refused, 0);
  } finally {
    link.stop();
    await far.done();
  }
});

void test("each reason a link fails is logged once when it starts, not once per retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-link-log-"));
  const logFile = join(dir, "mod.log");
  initLog(logFile);
  const port = await freePort();
  const token = mintPeerToken();
  const far = await farMac(port, token, PEER_PROTOCOL, "lan");
  let tries = 0;
  let keychain: string | null = null;
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => {
      tries++;
      return Promise.resolve(keychain);
    },
    protocol: PEER_PROTOCOL,
    minBackoffMs: 10,
    maxBackoffMs: 20,
  });
  const failures = () =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.includes("peers:link_failed"));
  try {
    link.start();
    await until(() => tries >= 3);
    assert.equal(failures().length, 1);
    assert.match(failures()[0], /no token/);
    // A token turns up, and the far Mac turns it away for the path it came by: one new line, saying so.
    keychain = token;
    const before = tries;
    await until(() => tries >= before + 3);
    assert.equal(failures().length, 2);
    assert.match(failures()[1], /403/);
  } finally {
    link.stop();
    await far.done();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the same failure is logged again once the link has worked in between, and a stop on purpose logs nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-link-log-"));
  const logFile = join(dir, "mod.log");
  initLog(logFile);
  const failures = () =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.includes("peers:link_failed"));
  const port = await freePort();
  const token = mintPeerToken();
  let far = await farMac(port, token);
  const { link, tries } = nearLink(port, token);
  try {
    link.start();
    await until(() => link.status === "reachable");
    // The far Mac goes away: retries fail the same way, logged once.
    await far.done();
    await until(() => link.status === "unreachable");
    const down = tries.count;
    await until(() => tries.count >= down + 3);
    assert.equal(failures().length, 1);
    // It comes back, then goes away again: the same reason is news again.
    far = await farMac(port, token);
    await until(() => link.status === "reachable");
    await far.done();
    await until(() => failures().length === 2);
    assert.equal(failures()[0].replace(/^\S+ /, ""), failures()[1].replace(/^\S+ /, ""));
  } finally {
    link.stop();
    await far.done();
  }
  // A link stopped mid-handshake (a Mac forgotten, or the mod reloading) did not fail: nothing is logged.
  const held: Socket[] = [];
  const silent = createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const quiet = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${(silent.address() as { port: number }).port}/ws`,
    token: () => Promise.resolve(token),
    protocol: PEER_PROTOCOL,
    minBackoffMs: 10,
    maxBackoffMs: 20,
  });
  try {
    const before = failures().length;
    quiet.start();
    await until(() => held.length > 0);
    quiet.stop();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(failures().length, before);
  } finally {
    quiet.stop();
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a link that cannot even be opened is out of reach and tried again, and the daemon lives on", async () => {
  for (const broken of [
    { url: () => "ws://bad host:41415/ws", token: () => Promise.resolve(mintPeerToken()) },
    { url: () => "ws://127.0.0.1:1/ws", token: () => Promise.reject(new Error("the keychain is locked")) },
  ]) {
    let tries = 0;
    const link = new PeerLink({
      macId: FAR,
      url: broken.url,
      token: () => {
        tries++;
        return broken.token();
      },
      protocol: PEER_PROTOCOL,
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    try {
      link.start();
      await until(() => tries >= 2);
      assert.equal(link.status, "unreachable");
    } finally {
      link.stop();
    }
  }
});

void test("a paired Mac saved with an address that cannot be one is never dialled", async () => {
  const statuses: LinkStatus[] = [];
  const links = new PeerLinks({
    token: () => Promise.resolve(mintPeerToken()),
    defaults: { protocol: PEER_PROTOCOL, minBackoffMs: 10, maxBackoffMs: 20 },
    onStatus: (_mac, s) => statuses.push(s),
  });
  try {
    links.sync([{ mac_id: FAR, host: "bad host" }]);
    await until(() => statuses.includes("unreachable"));
  } finally {
    links.sync([]);
  }
});
