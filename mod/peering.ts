import { join } from "node:path";
import type { Scope } from "../core/desk-core.ts";
import { scopeFor } from "../core/desk-core.ts";
import type { DeskSummary, InboxRow, LanStatus, TailnetDevice } from "../core/frame-types.ts";
import { stateFolders } from "../core/frames.ts";
import { Awake } from "../daemon/awake.ts";
import { applyMcp, isModPath, listModFiles, mcpSnapshot } from "../daemon/config-sync.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import type { MemoryRepos } from "../daemon/memory-sync.ts";
import { homeOf as recordHome, readRecord } from "../daemon/store/agent-sync.ts";
import { backendDir, readLocalAgent } from "./agents.ts";
import { ChatDirectory } from "./chat-directory.ts";
import { ChatMoves } from "./chat-moves.ts";
import { ChatRouter } from "./chat-router.ts";
import type { ChatSource } from "./chat-source.ts";
import type { DeskRegistry } from "./desks.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { sortDesks } from "./frames/desks.ts";
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
import { applyFiles, applyRecall, filesSnapshot, recallSnapshot } from "./recall-sync.ts";
import { recallDir } from "./recall.ts";
import { RemoteChats } from "./remote-chats.ts";
import type { SeenStore } from "./seen.ts";
import type { PushTo } from "./sockets.ts";

/**
 * This Mac and the Macs paired with it (plan 023): pairing, one link to each, the syncers that keep agents, memory and
 * the person's state the same on all of them, where each chat lives and moving chats between them, and the paired
 * Macs' chats in every list here. The mod hands it its sockets and its local lists; it hands back what the listener,
 * the frames and the lists need. Every paired-Mac piece is wired here once, so mod/index.ts keeps only the desk.
 */

/** The phone listener as pairing Macs uses it: the Macs come in on the same listener as the phones (mod/lan.ts). */
export interface PeerListener {
  status(): LanStatus;
  refresh(): Promise<unknown>;
  setPeersNeeded(needed: boolean): Promise<unknown>;
  closePeer(macId: string): number;
}

/** What the mod hands the paired Macs' wiring. */
export interface PeeringDeps {
  /** This Mac's install id, its name to other Macs. */
  macId: string;
  /** This loki's build, told to a Mac pairing with it. */
  build: string | null;
  /** The keychain, for the token this Mac presents to each paired Mac. */
  secrets: SecretBackend;
  /** The daemon's memory repos and their queue (plan 046). */
  memory: MemoryRepos;
  /** The chats here, for which this Mac holds. */
  chats: Pick<ChatSource, "list">;
  /** The daemon's chats, for moves, agents removed elsewhere and label colours. */
  chat: Pick<ChatBackend, "moveCandidates" | "exportChat" | "importChat" | "finishMove" | "removeAgent" | "labelColors" | "applyLabelColors">;
  /** The marks and focus, which travel between Macs. */
  seen: SeenStore;
  /** The desk rows, so a chat that moved away loses its own. */
  desks: Pick<DeskRegistry, "forgetConversations">;
  /** The mod's two listeners (mod/sockets.ts): pushes to the paired Macs and the desktop, and the phone listener. */
  sockets: { push(msg: object, opts?: { to?: PushTo; scope?: Scope }): void; phoneListener(): PeerListener | null };
  /** Tailscale's view of the tailnet, shared with the phone listener. */
  tailscale: { devices(): TailnetDevice[] };
  /** A push to every tab, phone and paired Mac, as the mod sends it. */
  broadcast: (msg: object, scope?: Scope) => void;
  /** This Mac's own chats, as the chat list and the inbox show them. */
  local: { desks: () => DeskSummary[]; inbox: () => InboxRow[] };
  dirs: Pick<typeof paths, "peers" | "state" | "data" | "widgets" | "uploads">;
  /** Move the open tasks into suggestions (plan 049, U7): again when a Mac comes into reach, as its chats move only then. */
  moveTasks: () => Promise<unknown>;
}

/** The paired Macs, as the rest of the mod uses them. */
export interface Peering {
  /** Pairing as the listener answers it over HTTP. */
  peers: Peers;
  /** Each chat answered by the Mac it lives on (U5), for the frame bridge. */
  router: ChatRouter;
  /** Settings › Macs and the frames other Macs send, for the frame modules. */
  frames: NonNullable<PeersDeps["peers"]>;
  /** Every chat in the chat list: this Mac's and each paired Mac's, sorted as one list (U4). */
  desks(): DeskSummary[];
  /** Every inbox row, this Mac's and each paired Mac's, newest first. */
  inbox(): InboxRow[];
  /** A push of `type` went out here: the paired Macs are told when it was some of the person's state (U8, plan 040). */
  pushed(type: string): void;
  /** Why a chat may not be written to now (it is moving), or null. */
  chatBlocked(agentId: string, conversationId: string): string | null;
  /** A Mac by its id, this one for null or its own id: its name, and whether it can be reached now. */
  mac(macId: string | null): { name: string; reachable: boolean };
  /** Why an agent may not be deleted now (a Mac out of reach holds its chats, KTD6), or null. */
  agentDeleteBlocked(agentId: string): string | null;
  /** A picture not here, from whichever paired Mac in reach holds it (plan 029). */
  chatImage(name: string): Promise<Buffer | null>;
  /** The listener is up: keep it up for the paired Macs, and open a link to each. */
  start(): void;
  stop(): void;
}

/** Pushes that change the person's state on a paired Mac; Learn's files travel only when they changed (plan 040). */
const STATE_PUSHES = new Set(["seen", "seen_chat", "desks", "recall_changed"]);
/** An edit to mcp.json or a mod by hand says nothing: every paired Mac's state is asked for again this often. */
const STATE_POLL_MS = 5 * 60_000;

/** Wire the paired Macs: built once, when the mod starts, before the listener they come in on. */
export function startPeering(deps: PeeringDeps): Peering {
  const { macId, chats, chat: chatBackend, seen, sockets, dirs, broadcast } = deps;
  const phones = (): PeerListener => {
    const lan = sockets.phoneListener();
    if (!lan) throw new Error("the phone listener is not up yet");
    return lan;
  };
  /** loki's mods folder as it syncs between Macs (plan 023, U10). */
  const MOD_FILES = { list: listModFiles, safe: isModPath };
  const peerStore = new PeerStore(dirs.peers);
  const peerCodes = new PairingCodes();
  const thisMacName = macName();
  /** This Mac's tailnet address for other Macs, or null when Tailscale is not running here. */
  const tailnetHost = (): string | null => {
    const s = sockets.phoneListener()?.status();
    return s?.tailscale?.running && s.tailscale.name ? `${s.tailscale.name}:${s.port}` : null;
  };
  /** Until when a Mac pairing code may be redeemed: the listener stays up for it. */
  let peerCodeUntil = 0;
  let codeLapse: ReturnType<typeof setTimeout> | null = null;
  const peersNeeded = () => peerStore.size() > 0 || peerCodeUntil > Date.now();
  const peerKeys = new PeerKeys(deps.secrets);
  const peersView = () => {
    const paired = new Set(peerStore.list().map((p) => p.host.replace(/:\d+$/, "").toLowerCase()));
    // Computers only: a phone or a tablet on the tailnet is not a Mac to pair with.
    const tailnet = deps.tailscale
      .devices()
      .filter((d) => /^(macos|linux|windows)$/i.test(d.os))
      .map((d) => ({ ...d, paired: paired.has(d.address) }));
    return { me: { mac_id: macId, name: thisMacName, host: tailnetHost() }, peers: peerStore.list((id) => links.reachable(id)), tailnet };
  };
  const desks = (): DeskSummary[] => sortDesks([...deps.local.desks(), ...remoteChats.desks()]);
  const inbox = (): InboxRow[] =>
    [...deps.local.inbox(), ...remoteChats.inbox()].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  // One link to each paired Mac (U2): opened when it pairs, closed when it is forgotten.
  const links: PeerLinks = new PeerLinks({
    token: (id) => peerKeys.get(id),
    defaults: { protocol: PEER_PROTOCOL },
    onStatus: (id, status) => {
      sockets.push({ type: "peers", ...peersView() }, { to: "desktop" });
      remoteChats.setReachable(id, status === "reachable");
      // A Mac back in reach: take what changed there while the link was down.
      if (status === "reachable") void sync.reached(id);
    },
    onPush: (id, frame) => {
      remoteChats.heard(id, frame);
      // A chat or desk that lives there: its clients here hear what it does (U5).
      const relay = router.relay(id, frame);
      if (relay) broadcast(frame, relay.scope);
      void sync.heard(id, frame);
    },
    // The other Mac refused this one's token: ask it once more over HTTP, which forgets it here if it forgot this Mac.
    onRefused: (id) => void peers.contact(id),
  });
  // What keeps this Mac current with the paired ones: each syncer, what wakes it, and the one it waits for.
  const sync: PeerSync = new PeerSync(
    [
      // Agents first: their memory and chats follow them.
      {
        name: "agents",
        reached: (id) => peerAgents.pull(id),
        pushes: {
          agents_changed: async (id) => {
            const applied = await peerAgents.pull(id);
            await Promise.all(applied.created.map((a) => peerMemory.pull(id, a)));
            // An agent whose home is now this Mac (set on its profile, on either Mac): its chats on that Mac come here.
            const homedHere = [...applied.created, ...applied.updated].some((a) => recordHome(readRecord(backendDir(), a), macId) === macId);
            if (homedHere) await chatMoves.takeOver(id, true);
          },
        },
      },
      {
        name: "memory",
        after: "agents",
        reached: (id) => peerMemory.pullAll(id),
        // Pushes arrive from another Mac unparsed: what they name is checked here.
        pushes: { memory_changed: (id, f) => (typeof f.agent_id === "string" ? peerMemory.pull(id, f.agent_id) : undefined) },
      },
      // Once after pairing, the chats there of agents that live here (U9).
      { name: "moves", after: "memory", reached: (id) => chatMoves.takeOver(id) },
      // Tasks whose chats live there, which could not move into suggestions while it was out of reach (plan 049, U7).
      { name: "tasks", after: "moves", reached: () => deps.moveTasks() },
      {
        name: "state",
        reached: (id) => peerState.pull(id),
        // A Mac from before plan 040 names no folders, which asks for all of them.
        pushes: { state_changed: (id, f) => peerState.pull(id, stateFolders(f.folders)) },
      },
      // Every Mac paired with every other (addendum D): join the Macs that one is paired with and this one is not.
      {
        name: "group",
        reached: (id) => peerGroup.meshWith(id),
        pushes: { group_changed: (id) => peerGroup.meshWith(id) },
      },
      // It let a chat go (addendum B3): frames for it go to the new home now, and that Mac's list has it.
      {
        name: "directory",
        pushes: {
          chat_left: (id, f) => {
            if (typeof f.conversation_id !== "string" || typeof f.to !== "string") return;
            directory.heard(id, { kind: "left", scope: scopeFor(f.conversation_id, typeof f.agent_id === "string" ? f.agent_id : null), to: f.to });
            if (f.to !== macId) void remoteChats.refresh(f.to);
          },
        },
      },
    ],
    (syncer, id, err) => log("peers:sync-failed", { syncer, mac: id, error: err instanceof Error ? err.message : String(err) }),
  );
  // The paired Macs' own chats, for every list here (U4).
  const remoteChats: RemoteChats = new RemoteChats({
    link: (id) => links.get(id),
    name: (id) => peerStore.get(id)?.name ?? "another Mac",
    onChange: () => broadcast({ type: "lists_changed" }),
    // A Mac's list is its word on which chats it holds (addendum B5).
    onListed: (id, scopes) => directory.heard(id, { kind: "holds", scopes }),
  });
  // Where each chat lives (addendum B): this Mac's from its store, each paired Mac's from its own word.
  const directory: ChatDirectory = new ChatDirectory({
    here: macId,
    holds: (scope) => chats.list().some((c) => !c.hidden && scopeFor(c.conversationId, c.agentId) === scope),
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
  // Each chat answered by the Mac it lives on (U5): frames about another Mac's chats go there.
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
  // A paired Mac stays awake on power while loki runs, so its chats can be reached from the other (U11, R14).
  const awake = new Awake();
  awake.set(peerStore.size() > 0);
  // Moving chats between this Mac and the paired ones (U9, addendum A1): the takeover after pairing, and moves by hand.
  const chatMoves: ChatMoves = new ChatMoves({
    here: macId,
    chat: chatBackend,
    link: (id) => (links.reachable(id) ? links.get(id) : null),
    widgetsDir: dirs.widgets,
    name: (id) => (id === null ? thisMacName : (peerStore.get(id)?.name ?? null)),
    done: (id) => peerStore.get(id)?.moves_done === true,
    markDone: (id) => peerStore.markMovesDone(id),
    onMoved: (id) => {
      void remoteChats.refresh(id);
      broadcast({ type: "lists_changed" });
    },
    onLeft: (chat, to) => {
      directory.left(chat, to);
      deps.desks.forgetConversations((id) => id === chat.conversation_id); // its desk row lives on the other Mac now
      broadcast({ type: "lists_changed" });
    },
  });
  // The person's state on every paired Mac (U8): marks and focus, pins, label colours, Learn.
  const peerState: PeerState = new PeerState({
    snapshot: (folders) => ({
      marks: seen.snapshot(),
      pins: pinChanges(),
      labels: chatBackend.labelColors(),
      mcp: mcpSnapshot(join(dirs.data, "mcp.json"), join(dirs.state, "mcp-sync.json")),
      ...(folders.includes("learn") ? { learn: recallSnapshot(recallDir()) } : {}),
      ...(folders.includes("mods") ? { mods: filesSnapshot(join(dirs.data, "mods"), MOD_FILES) } : {}),
    }),
    apply: (id, theirs) => {
      const moved = {
        marks: seen.applyRemote(id, theirs.marks),
        pins: applyPinChanges(theirs.pins),
        labels: chatBackend.applyLabelColors(theirs.labels),
        learn: theirs.learn ? applyRecall(recallDir(), theirs.learn) : false,
        // The daemon follows mcp.json and the mods folder itself: a change written here is picked up there.
        mcp: applyMcp(join(dirs.data, "mcp.json"), join(dirs.state, "mcp-sync.json"), theirs.mcp),
        mods: theirs.mods ? applyFiles(join(dirs.data, "mods"), MOD_FILES, theirs.mods) : false,
      };
      if (moved.marks) broadcast(seenFrame({ seen }));
      if (moved.pins) broadcast({ type: "desks", desks: desks() });
      if (moved.labels) broadcast({ type: "lists_changed" });
      if (moved.learn) broadcast({ type: "recall_changed" });
      return moved;
    },
    link: (id) => links.get(id),
    tell: (folders) => sockets.push({ type: "state_changed", folders }, { to: "macs" }),
  });
  const statePoll = setInterval(() => {
    for (const p of peerStore.list()) if (links.reachable(p.mac_id)) void peerState.pull(p.mac_id);
  }, STATE_POLL_MS);
  statePoll.unref();
  // The same memory on every paired Mac (U7): told when a repo here moves, asking when one there does.
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
  // The same agents on every paired Mac (U3): pulled from a Mac when its link opens or its agents change.
  const peerAgents: PeerAgents = new PeerAgents({
    backendDir,
    macId,
    link: (id) => links.get(id),
    remove: (id) => chatBackend.removeAgent(id),
    onChanged: () => broadcast({ type: "agents_changed" }),
  });
  // Every Mac paired with every other, by introductions through a Mac paired with both (addendum D).
  const peerGroup: PeerGroup = new PeerGroup({
    here: macId,
    paired: (id) => peerStore.get(id) !== null,
    forgotten: (id) => peerStore.isForgotten(id),
    link: (id) => links.get(id),
    join: async (host, invite) => {
      await phones().refresh(); // the other Mac needs this one's tailnet address to reach it back
      return peers.join(host, invite);
    },
  });
  /** The Macs paired at the last change, so one forgotten since leaves the directory too. */
  let known = new Set(peerStore.list().map((p) => p.mac_id));
  const peers: Peers = new Peers({
    store: peerStore,
    keys: peerKeys,
    codes: peerCodes,
    me: () => ({ mac_id: macId, name: thisMacName, host: tailnetHost() ?? "", build: deps.build, protocol: PEER_PROTOCOL }),
    onChange: () => {
      // The Macs this one is paired with changed: they join any they lack (addendum D1).
      sockets.push({ type: "group_changed" }, { to: "macs" });
      awake.set(peerStore.size() > 0);
      links.sync(peerStore.list());
      remoteChats.sync(peerStore.list().map((p) => p.mac_id));
      for (const id of known) if (!peerStore.get(id)) directory.forget(id);
      known = new Set(peerStore.list().map((p) => p.mac_id));
      sockets.push({ type: "peers", ...peersView() }, { to: "desktop" });
      void sockets.phoneListener()?.setPeersNeeded(peersNeeded());
    },
    onForget: (id) => {
      sockets.phoneListener()?.closePeer(id);
      seen.forgetMac(id); // its focus no longer counts here
    },
  });

  const frames: Peering["frames"] = {
    view: peersView,
    refresh: () => phones().refresh(),
    begin: async () => {
      const { code, expiresAt } = peerCodes.mint();
      peerCodeUntil = Date.parse(expiresAt);
      // Bound and Tailscale asked before the address is shown: the other Mac types it.
      await phones().setPeersNeeded(true);
      await phones().refresh();
      // Once the code has lapsed, the listener stays up only for the Macs already paired (or the phone switch).
      if (codeLapse) clearTimeout(codeLapse);
      codeLapse = setTimeout(() => void sockets.phoneListener()?.setPeersNeeded(peersNeeded()), PAIRING_TTL_MS + 1000);
      codeLapse.unref();
      log("peers:pair-code", { expiresAt });
      return { code, host: tailnetHost(), expires_at: expiresAt };
    },
    join: async (to, code) => {
      // The other Mac needs this Mac's tailnet address to reach it back: ask Tailscale now rather than trust a minute-old answer.
      await phones().refresh();
      if (!tailnetHost()) throw new Error("Tailscale is not running on this Mac: open Tailscale and sign in, then pair again");
      return peers.join(to, code);
    },
    forget: (id) => peers.forget(id),
    hello: () => peers.hello(),
    agents: () => peerAgents.snapshot(),
    chats: () => ({ desks: deps.local.desks(), inbox: deps.local.inbox() }),
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
    desks,
    inbox,
    pushed: (type) => {
      if (STATE_PUSHES.has(type)) peerState.changed(type === "recall_changed" ? "learn" : undefined);
    },
    chatBlocked: (agentId, conversationId) => chatMoves.blocked(agentId, conversationId),
    mac: (id) =>
      id === null || id === macId ? { name: thisMacName, reachable: true } : { name: peerStore.get(id)?.name ?? "another Mac", reachable: links.reachable(id) },
    agentDeleteBlocked: (agentId) => {
      const away = remoteChats.awayWith(agentId);
      return away ? `${peerStore.get(away)?.name ?? "another Mac"} is out of reach and has this agent's chats: delete it once that Mac is back` : null;
    },
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
      links.stop(); // the links to other Macs reopen with the mod
      remoteChats.stop();
      peerMemory.stop();
      peerState.stop();
      clearInterval(statePoll);
      if (codeLapse) clearTimeout(codeLapse);
      awake.set(false);
    },
  };
}
