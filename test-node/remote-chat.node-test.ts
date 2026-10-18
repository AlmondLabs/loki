/**
 * A chat that lives on another Mac, reached from this one over a real peer link (plan 023, U5): `npm run test:node`.
 * The far Mac's chat handlers stand in for its daemon and record what reaches them; the near Mac routes its clients'
 * frames there and passes the far Mac's pushes back to them.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskSummary } from "../core/frame-types.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { createBridge } from "../mod/bridge.ts";
import { ChatRouter } from "../mod/chat-router.ts";
import { DeviceStore } from "../mod/devices.ts";
import { reply, type FrameHandlers } from "../mod/frames/context.ts";
import { peersFrames } from "../mod/frames/peers.ts";
import { LanListener } from "../mod/lan.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { PeerLink } from "../mod/peer-link.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, mintPeerToken } from "../mod/peers.ts";
import { RemoteChats } from "../mod/remote-chats.ts";
import type { Client } from "../mod/server.ts";

const FAR = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEAR = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IRA = "agent-local-33333333-3333-4333-8333-333333333333";
const CONV = "local-conv-44444444-4444-4444-8444-444444444444";

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

/** A client of the near Mac: a tab, or a phone when `deviceId` is given. */
function client(deviceId?: string): Client & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { scope: CONV, sent, ...(deviceId ? { deviceId } : {}), send: (m) => sent.push(m as Record<string, unknown>) };
}

const IRA_DESK: DeskSummary = {
  scope: CONV,
  title: "plan the week",
  status: "live",
  agent_name: "Ira",
  agent_id: IRA,
  model: null,
  reasoning_effort: null,
  conversation_id: CONV,
  widgets: 0,
  active: false,
  last_active: null,
};

/** The two Macs, linked, with Ira's chat living on the far one. */
async function macs() {
  const root = mkdtempSync(join(tmpdir(), "loki-remote-chat-"));
  const farUploads = join(root, "far-uploads");
  const nearUploads = join(root, "near-uploads");
  const port = await freePort();
  const token = mintPeerToken();
  const reached: Array<Record<string, unknown>> = [];
  let lan: LanListener | null = null;
  const store = new PeerStore(join(root, "far-peers.json"));
  store.add({ mac_id: NEAR, name: "MacBook", host: "near:41415", build: null, protocol: PEER_PROTOCOL }, token);
  const farPeers = new Peers({
    store,
    keys: new PeerKeys(memorySecrets()),
    codes: new PairingCodes(),
    me: () => ({ mac_id: FAR, name: "Mac mini", host: `127.0.0.1:${port}`, build: null, protocol: PEER_PROTOCOL }),
  });
  // The far Mac's daemon, standing in: what reaches it is recorded, and a message makes it push an event.
  const farChat: FrameHandlers = {
    chat_send: (p, ctx) => {
      reached.push({ type: "chat_send", ...p });
      ctx.broadcast({ type: "chat_event", agent_id: p.agent_id, conversation_id: p.conversation_id, events: [] });
      return reply({ accepted: true });
    },
    chat_approve: (p) => (reached.push({ type: "chat_approve", ...p }), reply({ accepted: true })),
    history_get: (p) => reply({ agent_id: p.agent_id, conversation_id: p.conversation_id, messages: [], more: false, widget_log: [] }),
  };
  const farBridge = createBridge({
    modules: [
      farChat,
      peersFrames({
        peers: {
          view: () => ({ me: { mac_id: FAR, name: "Mac mini", host: null }, peers: [] }),
          begin: () => ({ code: "x", host: null, expires_at: "" }),
          join: () => Promise.reject(new Error("no")),
          forget: () => Promise.resolve(false),
          hello: () => farPeers.hello(),
          agents: () => ({ agents: [], tombstones: [] }),
          chats: () => ({ desks: [IRA_DESK], inbox: [] }),
          state: () => ({ marks: {}, pins: {}, labels: {}, learn: {}, mcp: {}, mods: {} }),
          memory: (agentId) => Promise.resolve({ agent_id: agentId, bundle: null }),
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
    handlers: farBridge,
    appDist: null,
    uploads: farUploads,
    peers: farPeers,
    via: () => "tailscale",
  });
  await lan.setPeersNeeded(true);

  // The near Mac: its link to the far one, the far Mac's chats, and the router in front of its own (empty) handlers.
  const heard: Array<{ msg: Record<string, unknown>; scope?: string }> = [];
  const nearStore = new PeerStore(join(root, "near-peers.json"));
  nearStore.add({ mac_id: FAR, name: "Mac mini", host: `127.0.0.1:${port}`, build: null, protocol: PEER_PROTOCOL }, mintPeerToken());
  const nearKeys = new PeerKeys(memorySecrets());
  await nearKeys.set(FAR, token);
  const nearPeers = new Peers({
    store: nearStore,
    keys: nearKeys,
    codes: new PairingCodes(),
    me: () => ({ mac_id: NEAR, name: "MacBook", host: "near:41415", build: null, protocol: PEER_PROTOCOL }),
  });
  const holder: { router: ChatRouter | null } = { router: null };
  const link = new PeerLink({
    macId: FAR,
    url: () => `ws://127.0.0.1:${port}/ws`,
    token: () => Promise.resolve(token),
    protocol: PEER_PROTOCOL,
    onPush: (f) => {
      const relay = holder.router?.relay(FAR, f);
      if (relay) heard.push({ msg: f, ...(relay.scope ? { scope: relay.scope } : {}) });
    },
    minBackoffMs: 20,
  });
  const remote = new RemoteChats({ link: () => link, name: () => "Mac mini", onChange: () => {}, debounceMs: 5 });
  const router = new ChatRouter({
    homeOf: (c, a) => remote.homeOf(c, a),
    homeOfScope: (s) => remote.homeOfScope(s),
    link: () => link,
    name: () => "Mac mini",
    uploadsDir: nearUploads,
    upload: (id, file) => nearPeers.upload(id, file),
  });
  holder.router = router;
  const near = createBridge({ modules: [], broadcast: () => {}, route: router });
  link.start();
  await until(() => link.status === "reachable");
  await remote.refresh(FAR);
  return {
    root,
    farUploads,
    nearUploads,
    reached,
    heard,
    near,
    lan,
    link,
    remote,
    done: async () => {
      link.stop();
      await lan.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

void test("a message to a chat on the far Mac runs there, its answer comes back, and so do its events", async () => {
  const m = await macs();
  try {
    const tab = client();
    m.near.onMessage(tab, { type: "chat_send", request_id: "r1", agent_id: IRA, conversation_id: CONV, text: "hello" });
    await until(() => tab.sent.length > 0);
    assert.deepEqual(tab.sent[0], { type: "chat_accepted", accepted: true, request_id: "r1" });
    assert.equal(m.reached[0]?.text, "hello");
    await until(() => m.heard.some((h) => h.msg.type === "chat_event"));
    assert.equal(m.heard.find((h) => h.msg.type === "chat_event")?.msg.conversation_id, CONV);
  } finally {
    await m.done();
  }
});

void test("history and an approval reach the far Mac, from a tab and from a phone", async () => {
  const m = await macs();
  try {
    const tab = client();
    m.near.onMessage(tab, { type: "history_get", request_id: "h", agent_id: IRA, conversation_id: CONV });
    await until(() => tab.sent.length > 0);
    assert.equal(tab.sent[0].type, "history");
    assert.equal(tab.sent[0].request_id, "h");
    const phone = client("phone-1");
    m.near.onMessage(phone, { type: "chat_approve", request_id: "a", agent_id: IRA, conversation_id: CONV, approval_id: "ap1", allow: true });
    await until(() => phone.sent.length > 0);
    assert.deepEqual(phone.sent[0], { type: "chat_accepted", accepted: true, request_id: "a" });
    assert.equal(m.reached.find((r) => r.type === "chat_approve")?.approval_id, "ap1");
  } finally {
    await m.done();
  }
});

void test("a phone's frame the phone may not send is refused on its own Mac and never reaches the far Mac", async () => {
  const m = await macs();
  try {
    const phone = client("phone-1");
    m.near.onMessage(phone, { type: "gesture", gesture: { id: `${CONV}/w`, kind: "focus" } });
    assert.match(String(phone.sent[0]?.message), /not available on the phone/);
    assert.deepEqual(m.reached, []);
  } finally {
    await m.done();
  }
});

void test("a malformed frame is answered here, and a chat whose Mac is out of reach says it waits for it", async () => {
  const m = await macs();
  try {
    const tab = client();
    m.near.onMessage(tab, { type: "chat_send", request_id: "bad", agent_id: IRA, conversation_id: CONV });
    await until(() => tab.sent.length > 0);
    assert.equal(tab.sent[0].type, "error");
    assert.deepEqual(m.reached, []);
    await m.lan.stop();
    m.remote.setReachable(FAR, false);
    m.near.onMessage(tab, { type: "chat_send", request_id: "r2", agent_id: IRA, conversation_id: CONV, text: "hi" });
    await until(() => tab.sent.length > 1);
    assert.deepEqual(tab.sent[1], { type: "error", request_id: "r2", message: "waiting for Mac mini: this chat lives there" });
    assert.deepEqual(m.reached, []);
  } finally {
    await m.done();
  }
});

void test("a file attached here goes to the far Mac first, and the message names it where it now is", async () => {
  const m = await macs();
  try {
    mkdirSync(join(m.nearUploads, "2026-10-18"), { recursive: true });
    const local = join(m.nearUploads, "2026-10-18", "notes.txt");
    writeFileSync(local, "the notes");
    const tab = client();
    const text = `see this <attachment kind="file" local_path="${local}" name="notes.txt" mime_type="text/plain" size_bytes="9" />`;
    m.near.onMessage(tab, { type: "chat_send", request_id: "f", agent_id: IRA, conversation_id: CONV, text });
    await until(() => tab.sent.length > 0);
    assert.equal(tab.sent[0].type, "chat_accepted");
    const there = /local_path="([^"]*)"/.exec(String(m.reached[0]?.text))?.[1] ?? "";
    assert.ok(there.startsWith(m.farUploads), there);
    assert.ok(existsSync(there));
    assert.equal(readFileSync(there, "utf8"), "the notes");
  } finally {
    await m.done();
  }
});
