/**
 * Three Macs over real sockets (plan 023, addendum D), under Node's own test runner: `npm run test:node`. Each "Mac" is
 * a tailnet listener with its own pairing, its frame answers and its links to the Macs it is paired with. The MacBook
 * and the mini pair by code, the mini and a third Mac pair by code, and the MacBook then joins the third Mac through
 * the mini, with no code of its own.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySecrets } from "../daemon/credentials.ts";
import { createBridge } from "../mod/bridge.ts";
import { DeviceStore } from "../mod/devices.ts";
import { peersFrames } from "../mod/frames/peers.ts";
import { LanListener } from "../mod/lan.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PeerGroup } from "../mod/peer-group.ts";
import { PeerLinks } from "../mod/peer-link.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers } from "../mod/peers.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const THIRD = "cccccccc-3333-4333-8333-333333333333";

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One Mac: its listener on an ephemeral port, its pairing, its group and its links. */
async function mac(name: string, macId: string) {
  const dir = mkdtempSync(join(tmpdir(), `loki-group-${name}-`));
  const store = new PeerStore(join(dir, "peers.json"));
  const keys = new PeerKeys(memorySecrets());
  const codes = new PairingCodes();
  let lan: LanListener | null = null;
  const peers: Peers = new Peers({
    store,
    keys,
    codes,
    me: () => ({ mac_id: macId, name, host: `127.0.0.1:${lan?.status().port ?? 0}`, build: "b1", protocol: PEER_PROTOCOL }),
    timeoutMs: 2000,
    onChange: () => links.sync(store.list()),
  });
  const links: PeerLinks = new PeerLinks({ token: (id) => keys.get(id), defaults: { protocol: PEER_PROTOCOL, minBackoffMs: 20 } });
  const group = new PeerGroup({
    here: macId,
    paired: (id) => store.get(id) !== null,
    forgotten: (id) => store.isForgotten(id),
    link: (id) => links.get(id),
    join: (host, code) => peers.join(host, code),
  });
  const none = () => Promise.reject(new Error("not in this test"));
  const bridge = createBridge({
    modules: [
      peersFrames({
        peers: {
          view: () => ({ me: { mac_id: macId, name, host: null }, peers: store.list() }),
          begin: none,
          join: none,
          forget: none,
          hello: () => peers.hello(),
          agents: () => ({ agents: [], tombstones: [] }),
          chats: () => ({ desks: [], inbox: [] }),
          state: () => ({ marks: {}, pins: {}, labels: {}, learn: {}, mcp: {}, mods: {} }),
          memory: (agentId) => Promise.resolve({ agent_id: agentId, bundle: null }),
          group: {
            macs: () => store.list().map((p) => ({ mac_id: p.mac_id, name: p.name, host: p.host })),
            introduce: (from, id) => group.introduce(from, id),
            invite: (id) => peers.invite(id),
          },
        },
      }),
    ],
    broadcast: (msg) => lan?.broadcast(msg),
  });
  lan = new LanListener({
    port: 0,
    stateFile: join(dir, "lan.json"),
    devices: new DeviceStore(join(dir, "devices.json")),
    codes: new PairingCodes(),
    handlers: bridge,
    appDist: null,
    peers,
    via: () => "tailscale",
  });
  await lan.setPeersNeeded(true);
  const host = `127.0.0.1:${lan.status().port}`;
  return {
    macId,
    host,
    store,
    peers,
    codes,
    links,
    group,
    /** Pair with `other` by a code it shows, as the person would. */
    pairWith: (other: { host: string; codes: PairingCodes }) => peers.join(other.host, other.codes.mint().code),
    done: async () => {
      links.stop();
      await lan.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

void test("a Mac joins the Mac its paired Mac is paired with, through it, with no code; the third Mac joins nothing twice", async () => {
  const book = await mac("MacBook", BOOK);
  const mini = await mac("Mac mini", MINI);
  const third = await mac("Studio", THIRD);
  try {
    await book.pairWith(mini);
    await third.pairWith(mini);
    await until(() => book.links.reachable(MINI) && mini.links.reachable(BOOK) && mini.links.reachable(THIRD) && third.links.reachable(MINI));
    // The third Mac has the higher id: it waits to be joined.
    assert.deepEqual(await third.group.meshWith(MINI), []);
    assert.deepEqual(await book.group.meshWith(MINI), [THIRD]);
    assert.ok(book.store.get(THIRD) && third.store.get(BOOK));
    // The new pairing works both ways: each Mac's link to the other opens with its own token.
    await until(() => book.links.reachable(THIRD) && third.links.reachable(BOOK));
    assert.deepEqual(await book.group.meshWith(MINI), []);
  } finally {
    await Promise.all([book.done(), mini.done(), third.done()]);
  }
});

void test("a Mac the third forgot on purpose is not invited back through the mini", async () => {
  const book = await mac("MacBook", BOOK);
  const mini = await mac("Mac mini", MINI);
  const third = await mac("Studio", THIRD);
  try {
    await book.pairWith(mini);
    await third.pairWith(mini);
    await book.pairWith(third);
    await until(() => book.links.reachable(MINI) && third.store.get(BOOK) !== null);
    await third.peers.forget(BOOK);
    assert.equal(book.store.get(THIRD), null); // told, and forgotten there too
    assert.deepEqual(await book.group.meshWith(MINI), []);
    assert.equal(book.store.get(THIRD), null);
  } finally {
    await Promise.all([book.done(), mini.done(), third.done()]);
  }
});
