import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advisorChatId } from "../core/advisor.ts";
import type { ChatSummary } from "../core/frame-types.ts";
import { scopeFor } from "../core/canvas-core.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { createBridge } from "../mod/bridge.ts";
import { ChatDirectory } from "../mod/chat-directory.ts";
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
const ADVISOR = advisorChatId(CONV);

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

function client(): Client & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { scope: CONV, sent, send: (m) => sent.push(m as Record<string, unknown>) };
}

const DESK: ChatSummary = {
  scope: CONV,
  title: "fix the flaky test",
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

async function macs() {
  const root = mkdtempSync(join(tmpdir(), "loki-advisor-remote-"));
  const port = await freePort();
  const token = mintPeerToken();
  const reached: Array<Record<string, unknown>> = [];
  const rows = [
    { conversationId: CONV, agentId: IRA, hidden: false },
    { conversationId: ADVISOR, agentId: IRA, hidden: true },
  ];
  let lan: LanListener | null = null;
  const store = new PeerStore(join(root, "far-peers.json"));
  store.add({ mac_id: NEAR, name: "MacBook", host: "near:41415", build: null, protocol: PEER_PROTOCOL }, token);
  const farPeers = new Peers({
    store,
    keys: new PeerKeys(memorySecrets()),
    codes: new PairingCodes(),
    me: () => ({ mac_id: FAR, name: "Mac mini", host: `127.0.0.1:${port}`, build: null, protocol: PEER_PROTOCOL }),
  });
  const farDirectory = new ChatDirectory({
    here: FAR,
    holds: (scope) => rows.some((c) => !c.hidden && scopeFor(c.conversationId, c.agentId) === scope),
    macs: () => [],
    reachable: () => false,
    ask: () => Promise.resolve({ held: false, moved_to: null }),
    tell: () => {},
  });
  const farRouter = new ChatRouter({ directory: farDirectory, link: () => null, name: () => "MacBook", uploadsDir: root, upload: () => Promise.resolve(null) });
  const farChat: FrameHandlers = {
    chat_open: (p) => (
      reached.push({ type: "chat_open", ...p }),
      reply({ agent_id: p.agent_id, conversation_id: p.conversation_id, loop: "running", mode: "standard", cwd: null, advisor: null })
    ),
    chat_send: (p, ctx) => {
      reached.push({ type: "chat_send", ...p });
      ctx.broadcast({ type: "chat_event", agent_id: p.agent_id, conversation_id: p.conversation_id, events: [{ kind: "loop", state: "running" }] });
      return reply({ accepted: true });
    },
    history_get: (p) => (
      reached.push({ type: "history_get", ...p }),
      reply({
        agent_id: p.agent_id,
        conversation_id: p.conversation_id,
        messages: [{ role: "user", text: "is the lock the cause?" }],
        more: false,
        start: 0,
        widget_log: [],
      })
    ),
  };
  const farBridge = createBridge({
    modules: [
      farChat,
      peersFrames({
        peers: {
          view: () => ({ me: { mac_id: FAR, name: "Mac mini", host: null }, peers: [] }),
          begin: () => Promise.resolve({ code: "x", host: null, expires_at: "" }),
          join: () => Promise.reject(new Error("no")),
          forget: () => Promise.resolve(false),
          hello: () => farPeers.hello(),
          agents: () => ({ agents: [], tombstones: [] }),
          chats: () => ({ chats: [DESK], flow: [] }),
          state: () => ({ marks: {}, pins: {}, labels: {}, learn: {}, mcp: {}, mods: {} }),
          memory: (agentId) => Promise.resolve({ agent_id: agentId, bundle: null }),
          where: (chat) => farDirectory.answer(chat),
        },
      }),
    ],
    broadcast: (msg) => lan?.broadcast(msg),
    route: {
      target: () => null,
      redirect: (msg) => farRouter.redirect(msg),
      forward: () => Promise.resolve({ ok: false as const, message: "the far Mac sends nothing on" }),
    },
  });
  lan = new LanListener({
    port,
    stateFile: join(root, "lan.json"),
    devices: new DeviceStore(join(root, "devices.json")),
    codes: new PairingCodes(),
    handlers: farBridge,
    appDist: null,
    uploads: join(root, "far-uploads"),
    peers: farPeers,
    via: () => "tailscale",
  });
  await lan.setPeersNeeded(true);

  const heard: Array<Record<string, unknown>> = [];
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
      if (holder.router?.relay(FAR, f)) heard.push(f);
    },
    minBackoffMs: 20,
  });
  const directory = new ChatDirectory({
    here: NEAR,
    holds: () => false,
    macs: () => [FAR],
    reachable: () => link.status === "reachable",
    ask: async (_mac, chat) => {
      const r = await link.request({ type: "peer_where", agent_id: chat.agent_id ?? null, conversation_id: chat.conversation_id });
      return { held: r.held === true, moved_to: typeof r.moved_to === "string" ? r.moved_to : null };
    },
    tell: () => {},
  });
  const remote = new RemoteChats({
    link: () => link,
    name: () => "Mac mini",
    onChange: () => {},
    onListed: (mac, scopes) => directory.heard(mac, { kind: "holds", scopes }),
    debounceMs: 5,
  });
  const router = new ChatRouter({
    directory,
    link: (id) => (id === FAR ? link : null),
    name: () => "Mac mini",
    uploadsDir: join(root, "near-uploads"),
    upload: (id, file) => nearPeers.upload(id, file),
  });
  holder.router = router;
  const near = createBridge({ modules: [], broadcast: () => {}, route: router });
  link.start();
  await until(() => link.status === "reachable");
  await remote.refresh(FAR);
  return {
    rows,
    reached,
    heard,
    near,
    remote,
    done: async () => {
      link.stop();
      await lan.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function exchange(near: { onMessage: (c: Client, m: Record<string, unknown>) => void }, tab: ReturnType<typeof client>, frame: Record<string, unknown>) {
  const before = tab.sent.length;
  near.onMessage(tab, frame);
  await until(() => tab.sent.length > before);
  return tab.sent[before];
}

void test("from a second Mac, a chat's advisor chat opens, reads its thread and takes a message on the Mac its chat lives on (R12, KTD11)", async () => {
  const m = await macs();
  try {
    const tab = client();
    assert.deepEqual(await exchange(m.near, tab, { type: "chat_open", request_id: "o", agent_id: IRA, conversation_id: ADVISOR, mode: null }), {
      type: "chat_state",
      request_id: "o",
      agent_id: IRA,
      conversation_id: ADVISOR,
      loop: "running",
      mode: "standard",
      cwd: null,
      advisor: null,
    });
    const thread = await exchange(m.near, tab, { type: "history_get", request_id: "h", agent_id: IRA, conversation_id: ADVISOR });
    assert.equal(thread.type, "history");
    assert.deepEqual(thread.messages, [{ role: "user", text: "is the lock the cause?" }]);
    assert.deepEqual(await exchange(m.near, tab, { type: "chat_send", request_id: "s", agent_id: IRA, conversation_id: ADVISOR, text: "and the retry?" }), {
      type: "chat_accepted",
      accepted: true,
      request_id: "s",
    });
    assert.deepEqual(
      m.reached.map((r) => [r.type, r.conversation_id]),
      [
        ["chat_open", ADVISOR],
        ["history_get", ADVISOR],
        ["chat_send", ADVISOR],
      ],
    );
    await m.remote.refresh(FAR);
    await until(() => m.heard.some((h) => h.type === "chat_event" && h.conversation_id === ADVISOR));
  } finally {
    await m.done();
  }
});

void test("the copy a move leaves behind does not answer for its advisor chat", async () => {
  const m = await macs();
  try {
    m.rows[0].hidden = true;
    const tab = client();
    assert.deepEqual(await exchange(m.near, tab, { type: "chat_send", request_id: "s", agent_id: IRA, conversation_id: ADVISOR, text: "still there?" }), {
      type: "error",
      request_id: "s",
      message: "this chat is not on any of your Macs",
    });
    assert.deepEqual(m.reached, []);
  } finally {
    await m.done();
  }
});
