import { join } from "node:path";
import type { Scope } from "../core/canvas-core.ts";
import { scopeFor } from "../core/canvas-core.ts";
import type { ChatSummary, FlowRow, LanStatus, TailnetDevice } from "../core/frame-types.ts";
import { stateFolders, type MacAccountView } from "../core/frames.ts";
import { Awake } from "../daemon/awake.ts";
import { applyMcp, isModPath, listModFiles, mcpSnapshot } from "../daemon/config-sync.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import type { MemoryRepos } from "../daemon/memory-sync.ts";
import { homeOf as recordHome, readRecord } from "../daemon/store/agent-sync.ts";
import { PeerAccounts } from "./accounts.ts";
import { backendDir, readLocalAgent } from "./agents.ts";
import { ChatDirectory } from "./chat-directory.ts";
import { ChatMoves } from "./chat-moves.ts";
import { ChatRouter } from "./chat-router.ts";
import type { ChatSource } from "./chat-source.ts";
import type { ChatRegistry } from "./chats.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { sortChats } from "./frames/canvas.ts";
import type { PeersDeps } from "./frames/peers.ts";
import { seenFrame } from "./frames/seen.ts";
import { log } from "./log.ts";
import { PAIRING_TTL_MS, PairingCodes } from "./pairing.ts";
import type { paths } from "./paths.ts";
import { PeerAgents } from "./peer-agents.ts";
import { PeerGroup } from "./peer-group.ts";
import { PeerLinks } from "./peer-link.ts";
import { PeerMemory } from "./peer-memory.ts";
import { PeerState } from "./peer-state.ts";
import { PeerSync } from "./peer-sync.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, macName } from "./peers.ts";
import { applyPinChanges, pinChanges } from "./pins.ts";
import { applyFiles, applyLearn, filesSnapshot, learnSnapshot } from "./learn-sync.ts";
import { learnDir } from "./learn.ts";
import { RemoteChats, peerChatsReply } from "./remote-chats.ts";
import type { SeenStore } from "./seen.ts";
import type { PushTo } from "./sockets.ts";
import { messageOf } from "../core/errors.ts";

export interface PeerListener {
  status(): LanStatus;
  refresh(): Promise<unknown>;
  setPeersNeeded(needed: boolean): Promise<unknown>;
  closePeer(macId: string): number;
}

export interface PeeringDeps {
  macId: string;
  build: string | null;
  secrets: SecretBackend;
  memory: MemoryRepos;
  chats: Pick<ChatSource, "list" | "hasScope">;
  chat: Pick<ChatBackend, "moveCandidates" | "exportChat" | "importChat" | "finishMove" | "removeAgent" | "labelColors" | "applyLabelColors">;
  seen: SeenStore;
  desks: Pick<ChatRegistry, "forgetConversations">;
  sockets: { push(msg: object, opts?: { to?: PushTo; scope?: Scope }): void; phoneListener(): PeerListener | null };
  tailscale: { devices(): TailnetDevice[] };
  broadcast: (msg: object, scope?: Scope) => void;
  local: { chats: () => ChatSummary[]; flow: () => FlowRow[] };
  dirs: Pick<typeof paths, "peers" | "state" | "data" | "widgets" | "uploads">;
}

export interface Peering {
  peers: Peers;
  router: ChatRouter;
  frames: NonNullable<PeersDeps["peers"]>;
  summaries(): ChatSummary[];
  flow(): FlowRow[];
  pushed(type: string): void;
  chatBlocked(agentId: string, conversationId: string): string | null;
  mac(macId: string | null): { name: string; reachable: boolean };
  agentDeleteBlocked(agentId: string): string | null;
  accountHeldBy(accountId: string): string | null;
  accountsElsewhere(): MacAccountView[];
  chatImage(name: string): Promise<Buffer | null>;
  start(): void;
  stop(): void;
}

const STATE_PUSHES = new Set(["seen", "seen_chat", "chats", "learn_changed"]);
const STATE_POLL_MS = 5 * 60_000;

export function startPeering(deps: PeeringDeps): Peering {
  const { macId, chats, chat: chatBackend, seen, sockets, dirs, broadcast } = deps;
  const phones = (): PeerListener => {
    const lan = sockets.phoneListener();
    if (!lan) throw new Error("the phone listener is not up yet");
    return lan;
  };
  const MOD_FILES = { list: listModFiles, safe: isModPath };
  const peerStore = new PeerStore(dirs.peers);
  const peerCodes = new PairingCodes();
  const thisMacName = macName();
  const tailnetHost = (): string | null => {
    const s = sockets.phoneListener()?.status();
    return s?.tailscale?.running && s.tailscale.name ? `${s.tailscale.name}:${s.port}` : null;
  };
  let peerCodeUntil = 0;
  let codeLapse: ReturnType<typeof setTimeout> | null = null;
  const peersNeeded = () => peerStore.size() > 0 || peerCodeUntil > Date.now();
  const peerKeys = new PeerKeys(deps.secrets);
  const peersView = () => {
    const paired = new Set(peerStore.list().map((p) => p.host.replace(/:\d+$/, "").toLowerCase()));
    const tailnet = deps.tailscale
      .devices()
      .filter((d) => /^(macos|linux|windows)$/i.test(d.os))
      .map((d) => ({ ...d, paired: paired.has(d.address) }));
    return { me: { mac_id: macId, name: thisMacName, host: tailnetHost() }, peers: peerStore.list((id) => links.reachable(id)), tailnet };
  };
  const summaries = (): ChatSummary[] => sortChats([...deps.local.chats(), ...remoteChats.summaries()]);
  const flow = (): FlowRow[] => [...deps.local.flow(), ...remoteChats.flow()].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  const links: PeerLinks = new PeerLinks({
    token: (id) => peerKeys.get(id),
    defaults: { protocol: PEER_PROTOCOL },
    onStatus: (id, status) => {
      sockets.push({ type: "peers", ...peersView() }, { to: "desktop" });
      remoteChats.setReachable(id, status === "reachable");
      if (status === "reachable") void sync.reached(id);
    },
    onPush: (id, frame) => {
      remoteChats.heard(id, frame);
      const relay = router.relay(id, frame);
      if (relay) broadcast(frame, relay.scope);
      void sync.heard(id, frame);
    },
    onRefused: (id) => {
      peers.contact(id).catch((err: unknown) => log.error("peers:contact_failed", { mac: id, reason: messageOf(err) }));
    },
  });
  const sync: PeerSync = new PeerSync(
    [
      {
        name: "agents",
        reached: (id) => peerAgents.pull(id),
        pushes: {
          agents_changed: async (id) => {
            const applied = await peerAgents.pull(id);
            await Promise.all(applied.created.map((a) => peerMemory.pull(id, a)));
            const homedHere = [...applied.created, ...applied.updated].some((a) => recordHome(readRecord(backendDir(), a), macId) === macId);
            if (homedHere) await chatMoves.takeOver(id, true);
          },
        },
      },
      {
        name: "memory",
        after: "agents",
        reached: (id) => peerMemory.pullAll(id),
        pushes: { memory_changed: (id, f) => (typeof f.agent_id === "string" ? peerMemory.pull(id, f.agent_id) : undefined) },
      },
      {
        name: "moves",
        after: "memory",
        reached: async (id) => {
          await chatMoves.settle(id);
          await chatMoves.takeOver(id);
        },
      },
      {
        name: "state",
        reached: (id) => peerState.pull(id),
        pushes: { state_changed: (id, f) => peerState.pull(id, stateFolders(f.folders)) },
      },
      {
        name: "group",
        reached: (id) => peerGroup.meshWith(id),
        pushes: { group_changed: (id) => peerGroup.meshWith(id) },
      },
      {
        name: "accounts",
        reached: (id) => peerAccounts.pull(id),
        pushes: { accounts_changed: (id) => peerAccounts.pull(id) },
      },
      {
        name: "directory",
        pushes: {
          chat_left: (id, f) => {
            if (typeof f.conversation_id !== "string" || typeof f.to !== "string") return;
            directory.heard(id, { kind: "left", scope: scopeFor(f.conversation_id, typeof f.agent_id === "string" ? f.agent_id : null), to: f.to });
            if (f.to !== macId) remoteChats.startRefresh(f.to);
          },
        },
      },
    ],
    (syncer, id, err) => log.error("peers:sync-failed", { syncer, mac: id, error: messageOf(err) }),
  );
  const remoteChats: RemoteChats = new RemoteChats({
    link: (id) => links.get(id),
    name: (id) => peerStore.get(id)?.name ?? "another Mac",
    onChange: () => broadcast({ type: "lists_changed" }),
    onListed: (id, scopes) => directory.heard(id, { kind: "holds", scopes }),
  });
  const peerAccounts = new PeerAccounts({ link: (id) => links.get(id), name: (id) => peerStore.get(id)?.name ?? "another Mac" });
  const directory: ChatDirectory = new ChatDirectory({
    here: macId,
    holds: (scope) => (chats.hasScope ? chats.hasScope(scope) : chats.list().some((c) => !c.hidden && scopeFor(c.conversationId, c.agentId) === scope)),
    macs: () => peerStore.list().map((p) => p.mac_id),
    reachable: (id) => links.reachable(id),
    ask: async (id, chat) => {
      const link = links.get(id);
      if (!link) throw new Error("not paired");
      const r = await link.request({ type: "peer_where", agent_id: chat.agent_id ?? null, conversation_id: chat.conversation_id });
      return { held: r.held === true, moved_to: typeof r.moved_to === "string" ? r.moved_to : null };
    },
    tell: (frame) => sockets.push(frame, { to: "macs" }),
  });
  const router: ChatRouter = new ChatRouter({
    here: macId,
    peer: (id) => (peerStore.get(id) ? { mac: id, reachable: links.reachable(id) } : null),
    agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
    directory,
    link: (id) => links.get(id),
    name: (id) => peerStore.get(id)?.name ?? "another Mac",
    uploadsDir: dirs.uploads,
    upload: (id, file) => peers.upload(id, file),
    relist: (id) => remoteChats.refresh(id),
  });
  const awake = new Awake();
  awake.set(peerStore.size() > 0);
  const chatMoves: ChatMoves = new ChatMoves({
    here: macId,
    chat: chatBackend,
    link: (id) => (links.reachable(id) ? links.get(id) : null),
    widgetsDir: dirs.widgets,
    file: join(dirs.state, "chat-moves.json"),
    name: (id) => (id === null ? thisMacName : (peerStore.get(id)?.name ?? null)),
    done: (id) => peerStore.get(id)?.moves_done === true,
    markDone: (id) => peerStore.markMovesDone(id),
    onMoved: (id) => {
      remoteChats.startRefresh(id);
      broadcast({ type: "lists_changed" });
    },
    onLeft: (chat, to) => {
      directory.left(chat, to);
      deps.desks.forgetConversations((id) => id === chat.conversation_id);
      broadcast({ type: "lists_changed" });
    },
  });
  const peerState: PeerState = new PeerState({
    snapshot: (folders) => ({
      marks: seen.snapshot(),
      pins: pinChanges(),
      labels: chatBackend.labelColors(),
      mcp: mcpSnapshot(join(dirs.data, "mcp.json"), join(dirs.state, "mcp-sync.json")),
      ...(folders.includes("learn") ? { learn: learnSnapshot(learnDir()) } : {}),
      ...(folders.includes("mods") ? { mods: filesSnapshot(join(dirs.data, "mods"), MOD_FILES) } : {}),
    }),
    apply: (id, theirs) => {
      const moved = {
        marks: seen.applyRemote(id, theirs.marks),
        pins: applyPinChanges(theirs.pins),
        labels: chatBackend.applyLabelColors(theirs.labels),
        learn: theirs.learn ? applyLearn(learnDir(), theirs.learn) : false,
        mcp: applyMcp(join(dirs.data, "mcp.json"), join(dirs.state, "mcp-sync.json"), theirs.mcp),
        mods: theirs.mods ? applyFiles(join(dirs.data, "mods"), MOD_FILES, theirs.mods) : false,
      };
      if (moved.marks) sockets.push(seenFrame({ seen }));
      if (moved.pins) sockets.push({ type: "chats", chats: summaries() });
      if (moved.labels) sockets.push({ type: "lists_changed" });
      if (moved.learn) sockets.push({ type: "learn_changed" });
      return moved;
    },
    link: (id) => links.get(id),
    tell: (folders) => sockets.push({ type: "state_changed", folders }, { to: "macs" }),
  });
  const statePoll = setInterval(() => {
    for (const p of peerStore.list()) if (links.reachable(p.mac_id)) void peerState.pull(p.mac_id);
  }, STATE_POLL_MS);
  statePoll.unref();
  const peerMemory: PeerMemory = new PeerMemory({
    backendDir,
    repos: deps.memory,
    macId,
    link: (id) => links.get(id),
    homeOf: (agentId) => recordHome(readRecord(backendDir(), agentId), macId),
    tell: (agentId) => sockets.push({ type: "memory_changed", agent_id: agentId }, { to: "macs" }),
    onCloned: () => broadcast({ type: "agents_changed" }),
  });
  peerMemory.start();
  const peerAgents: PeerAgents = new PeerAgents({
    backendDir,
    macId,
    link: (id) => links.get(id),
    remove: (id) => chatBackend.removeAgent(id),
    onChanged: () => broadcast({ type: "agents_changed" }),
  });
  const peerGroup: PeerGroup = new PeerGroup({
    here: macId,
    paired: (id) => peerStore.get(id) !== null,
    forgotten: (id) => peerStore.isForgotten(id),
    link: (id) => links.get(id),
    join: async (host, invite) => {
      await phones().refresh();
      return peers.join(host, invite);
    },
  });
  let known = new Set(peerStore.list().map((p) => p.mac_id));
  const peers: Peers = new Peers({
    store: peerStore,
    keys: peerKeys,
    codes: peerCodes,
    me: () => ({ mac_id: macId, name: thisMacName, host: tailnetHost() ?? "", build: deps.build, protocol: PEER_PROTOCOL }),
    onChange: () => {
      sockets.push({ type: "group_changed" }, { to: "macs" });
      awake.set(peerStore.size() > 0);
      links.sync(peerStore.list());
      remoteChats.sync(peerStore.list().map((p) => p.mac_id));
      peerAccounts.sync(peerStore.list().map((p) => p.mac_id));
      for (const id of known) if (!peerStore.get(id)) directory.forget(id);
      known = new Set(peerStore.list().map((p) => p.mac_id));
      sockets.push({ type: "peers", ...peersView() }, { to: "desktop" });
      void sockets.phoneListener()?.setPeersNeeded(peersNeeded());
    },
    onForget: (id) => {
      sockets.phoneListener()?.closePeer(id);
      seen.forgetMac(id);
    },
  });

  const frames: Peering["frames"] = {
    view: peersView,
    refresh: () => phones().refresh(),
    begin: async () => {
      const { code, expiresAt } = peerCodes.mint();
      peerCodeUntil = Date.parse(expiresAt);
      await phones().setPeersNeeded(true);
      await phones().refresh();
      if (codeLapse) clearTimeout(codeLapse);
      codeLapse = setTimeout(() => void sockets.phoneListener()?.setPeersNeeded(peersNeeded()), PAIRING_TTL_MS + 1000);
      codeLapse.unref();
      log("peers:pair-code", { expiresAt });
      return { code, host: tailnetHost(), expires_at: expiresAt };
    },
    join: async (to, code) => {
      await phones().refresh();
      if (!tailnetHost()) throw new Error("Tailscale is not running on this Mac: open Tailscale and sign in, then pair again");
      return peers.join(to, code);
    },
    forget: (id) => peers.forget(id),
    hello: () => peers.hello(),
    agents: () => peerAgents.snapshot(),
    chats: () => peerChatsReply(deps.local.chats(), deps.local.flow()),
    state: (folders) => peerState.snapshotNow(folders),
    where: (chat) => directory.answer(chat),
    group: {
      macs: () => peerStore.list().map((p) => ({ mac_id: p.mac_id, name: p.name, host: p.host })),
      introduce: (from, id) => peerGroup.introduce(from, id),
      invite: (id) => peers.invite(id),
    },
    moves: chatMoves,
    memory: (agentId, have) => peerMemory.bundle(agentId, have).then((bundle) => ({ agent_id: agentId, bundle })),
  };

  return {
    peers,
    router,
    frames,
    summaries,
    flow,
    pushed: (type) => {
      if (STATE_PUSHES.has(type)) peerState.changed(type === "learn_changed" ? "learn" : undefined);
    },
    chatBlocked: (agentId, conversationId) => chatMoves.blocked(agentId, conversationId),
    mac: (id) =>
      id === null || id === macId ? { name: thisMacName, reachable: true } : { name: peerStore.get(id)?.name ?? "another Mac", reachable: links.reachable(id) },
    agentDeleteBlocked: (agentId) => {
      const away = remoteChats.awayWith(agentId);
      if (away) return `${peerStore.get(away)?.name ?? "another Mac"} is out of reach and has this agent's chats: delete it once that Mac is back`;
      return peerAccounts.deleteBlocked(agentId);
    },
    accountHeldBy: (accountId) => peerAccounts.heldBy(accountId),
    accountsElsewhere: () => peerAccounts.everywhere(),
    chatImage: async (name) => {
      for (const p of peerStore.list()) {
        if (!links.reachable(p.mac_id)) continue;
        const data = await peers.chatImage(p.mac_id, name);
        if (data) return data;
      }
      return null;
    },
    start: () => {
      if (peerStore.size() > 0) void sockets.phoneListener()?.setPeersNeeded(true);
      links.sync(peerStore.list());
    },
    stop: () => {
      links.stop();
      remoteChats.stop();
      peerMemory.stop();
      peerState.stop();
      clearInterval(statePoll);
      if (codeLapse) clearTimeout(codeLapse);
      awake.set(false);
    },
  };
}
