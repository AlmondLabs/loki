/**
 * The same agents on two paired Macs over a real peer link (plan 023, U3): `npm run test:node`. The far Mac answers
 * `peer_agents_get` from its backend folder; the near Mac pulls through its link and applies.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySecrets } from "../daemon/credentials.ts";
import { addTombstone, readRecord, stamp } from "../daemon/store/agent-sync.ts";
import { writeRecord } from "../daemon/store/agents.ts";
import { createBridge } from "../mod/bridge.ts";
import { DeviceStore } from "../mod/devices.ts";
import { peersFrames } from "../mod/frames/peers.ts";
import { LanListener } from "../mod/lan.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PeerAgents } from "../mod/peer-agents.ts";
import { PeerLink } from "../mod/peer-link.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, mintPeerToken } from "../mod/peers.ts";

const FAR = "eeeeeeee-5555-4555-8555-555555555555";
const NEAR = "ffffffff-6666-4666-8666-666666666666";
const FRIDAY = "agent-local-22222222-2222-4222-8222-222222222222";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** An agent record with its memory folder, as the daemon keeps them. */
function agent(dir: string, id: string, record: Record<string, unknown>): void {
  mkdirSync(join(dir, "memfs", id, "memory"), { recursive: true });
  writeRecord(dir, id, record);
}

/** Two Macs: the far one serving its backend's agents, the near one linked to it and pulling. */
async function pair() {
  const root = mkdtempSync(join(tmpdir(), "loki-peer-agents-"));
  const farBackend = join(root, "far");
  const nearBackend = join(root, "near");
  mkdirSync(nearBackend, { recursive: true });
  const port = await freePort();
  const token = mintPeerToken();
  const store = new PeerStore(join(root, "peers.json"));
  store.add({ mac_id: NEAR, name: "near", host: "near:41415", build: null, protocol: PEER_PROTOCOL }, token);
  const farAgents = new PeerAgents({ backendDir: () => farBackend, macId: FAR, link: () => null, remove: () => Promise.resolve(), onChanged: () => {} });
  const peers = new Peers({
    store,
    keys: new PeerKeys(memorySecrets()),
    codes: new PairingCodes(),
    me: () => ({ mac_id: FAR, name: "far", host: `127.0.0.1:${port}`, build: null, protocol: PEER_PROTOCOL }),
  });
  let lan: LanListener | null = null;
  const bridge = createBridge({
    modules: [
      peersFrames({
        peers: {
          view: () => ({ me: { mac_id: FAR, name: "far", host: null }, peers: [] }),
          begin: () => ({ code: "x", host: null, expires_at: "" }),
          join: () => Promise.reject(new Error("no")),
          forget: () => Promise.resolve(false),
          hello: () => peers.hello(),
          agents: () => farAgents.snapshot(),
          chats: () => ({ desks: [], inbox: [] }),
        },
      }),
    ],
    broadcast: (msg) => lan?.broadcast(msg),
  });
  lan = new LanListener({
    port,
    stateFile: join(root, "lan.json"),
    devices: new DeviceStore(join(root, "devices.json")),
    codes: new PairingCodes(),
    handlers: bridge,
    appDist: null,
    peers,
    via: () => "tailscale",
  });
  await lan.setPeersNeeded(true);
  const removed: string[] = [];
  let changes = 0;
  // The near Mac's agents, set below: the link's push handler only runs once the link is up.
  const nearRef: { agents: PeerAgents | null } = { agents: null };
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => Promise.resolve(token),
    protocol: PEER_PROTOCOL,
    onPush: (f) => {
      if (f.type === "agents_changed") void nearRef.agents?.pull(FAR);
    },
    minBackoffMs: 20,
  });
  const near = new PeerAgents({
    backendDir: () => nearBackend,
    macId: NEAR,
    link: () => link,
    remove: (id) => {
      removed.push(id);
      rmSync(join(nearBackend, "memfs", id), { recursive: true, force: true });
      return Promise.resolve();
    },
    onChanged: () => changes++,
  });
  nearRef.agents = near;
  link.start();
  await until(() => link.status === "reachable");
  return {
    farBackend,
    nearBackend,
    lan,
    near,
    removed,
    changes: () => changes,
    done: async () => {
      link.stop();
      await lan.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

void test("a Mac with no agents takes the other Mac's, under the same ids and homes", async () => {
  const m = await pair();
  try {
    agent(m.farBackend, FRIDAY, { id: FRIDAY, name: "Friday", model: "openai/gpt-6.1-sol" });
    const applied = await m.near.pull(FAR);
    assert.deepEqual(applied.created, [FRIDAY]);
    assert.equal(readRecord(m.nearBackend, FRIDAY)?.name, "Friday");
    assert.equal(readRecord(m.nearBackend, FRIDAY)?.home_mac, FAR);
    assert.equal(m.changes(), 1);
  } finally {
    await m.done();
  }
});

void test("a rename on the far Mac reaches the near one when the far Mac says its agents changed", async () => {
  const m = await pair();
  try {
    agent(m.farBackend, FRIDAY, { id: FRIDAY, name: "Friday" });
    await m.near.pull(FAR);
    writeRecord(m.farBackend, FRIDAY, stamp({ id: FRIDAY, name: "Friday (work)" }, ["name"], { at: "2026-10-18T10:00:00Z", mac: FAR }));
    m.lan.broadcast({ type: "agents_changed" });
    await until(() => readRecord(m.nearBackend, FRIDAY)?.name === "Friday (work)");
  } finally {
    await m.done();
  }
});

void test("an agent deleted on the far Mac is deleted on the near one", async () => {
  const m = await pair();
  try {
    agent(m.farBackend, FRIDAY, { id: FRIDAY, name: "Friday" });
    await m.near.pull(FAR);
    rmSync(join(m.farBackend, "memfs", FRIDAY), { recursive: true, force: true });
    addTombstone(m.farBackend, { id: FRIDAY, at: "2026-10-18T10:00:00Z", mac: FAR });
    const applied = await m.near.pull(FAR);
    assert.deepEqual(applied.deleted, [FRIDAY]);
    assert.deepEqual(m.removed, [FRIDAY]);
    assert.equal(existsSync(join(m.nearBackend, "memfs", FRIDAY)), false);
  } finally {
    await m.done();
  }
});
