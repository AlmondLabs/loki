/**
 * The peer link between two Macs over real sockets (plan 023, U2): `npm run test:node`. The far Mac is a phone
 * listener serving the real frame router; the near Mac is only its link, holding the token the far Mac minted for it.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySecrets } from "../daemon/credentials.ts";
import { createBridge } from "../mod/bridge.ts";
import { DeviceStore } from "../mod/devices.ts";
import { peersFrames } from "../mod/frames/peers.ts";
import { LanListener } from "../mod/lan.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PeerLink, type LinkStatus } from "../mod/peer-link.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, mintPeerToken } from "../mod/peers.ts";

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

/** The far Mac: a listener on `port` with the real router, answering `peer_ping` with `protocol`, that knows the near Mac by `token`. */
async function farMac(port: number, token: string, protocol = PEER_PROTOCOL) {
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
    via: () => "tailscale",
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
