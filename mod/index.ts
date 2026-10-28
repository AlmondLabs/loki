import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Scope, WidgetChange } from "../core/desk-core.ts";
import { SHARED_SCOPE } from "../core/desk-core.ts";
import type { ChatRef, ModApi } from "../daemon/mods/api.ts";
import { ScopeDebouncer } from "./lifecycle-events.ts";
import { DEFAULT_LAN_PORT, DEFAULT_MOD_PORT, MCP_OAUTH_CALLBACK, paths } from "./paths.ts";
import { DeskStore } from "./desk-store.ts";
import { loadDesks, persistDesks } from "./persist.ts";
import { watchWidgets } from "./widgets-fs.ts";
import { WidgetLog, broadcastWidgetChanges } from "./widget-log.ts";
import { GestureLog, attachDeskContext, formatDeskContext } from "./gestures.ts";
import { checkFolder, completeFolder, pickFolder } from "./folders.ts";
import { DeskRegistry } from "./desks.ts";
import { ChatListing } from "./chat-listing.ts";
import type { ChatSource } from "./chat-source.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { SeenStore } from "./seen.ts";
import { RecallStore, isoDay, recallDir } from "./recall.ts";
import { applyFiles, applyRecall, filesSnapshot, recallSnapshot } from "./recall-sync.ts";
import { applyMcp, isModPath, listModFiles, mcpSnapshot } from "../daemon/config-sync.ts";
import { PeerState } from "./peer-state.ts";
import { ChatMoves } from "./chat-moves.ts";
import { PeerSync } from "./peer-sync.ts";
import { Awake } from "../daemon/awake.ts";
import { isPassChat, startLessonViaChats } from "./recall-worker.ts";
import { PassState } from "../daemon/passes-state.ts";
import { applyPinChanges, pinChanges, readPins, setPin } from "./pins.ts";
import { addRecentModel, readRecentModels } from "./models.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { reflectionState } from "./reflection.ts";
import { backendDir, memoryDiff, memoryLog, memorySkills, memoryTree, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";
import { conversationDirName, scopeFor } from "../core/desk-core.ts";

import { sortDesks } from "./frames/desks.ts";
import { frameModules, welcomeFrames, type ModuleDeps } from "./frames/index.ts";
import type { UsageDeps } from "./frames/usage.ts";
import { join } from "node:path";
import { attachWs, oauthCallbackRoute, startServer, tokenAuth, type LokiServer, type WsBridge } from "./server.ts";
import { chatImageRoute } from "./chat-images.ts";
import { createBridge } from "./bridge.ts";
import { seenFrame } from "./frames/seen.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { DeviceStore } from "./devices.ts";
import { PAIRING_TTL_MS, PairingCodes } from "./pairing.ts";
import { PEER_PROTOCOL, PeerKeys, PeerStore, Peers, macName } from "./peers.ts";
import { PeerLinks } from "./peer-link.ts";
import { PeerAgents } from "./peer-agents.ts";
import { PeerMemory } from "./peer-memory.ts";
import { homeOf as recordHome, readRecord } from "../daemon/store/agent-sync.ts";
import { RemoteChats } from "./remote-chats.ts";
import { ChatRouter } from "./chat-router.ts";
import { Suggestions, chatCaller, withSuggestionsOnOpen, type SuggestionRecords } from "./suggestions.ts";
import { bdReader, moveTasks, tasksDir } from "./task-migration.ts";
import { ChatDirectory } from "./chat-directory.ts";
import { PeerGroup } from "./peer-group.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import type { MemoryRepos } from "../daemon/memory-sync.ts";
import { LanListener } from "./lan.ts";
import { Tailscale } from "./tailscale.ts";
import { registerTools } from "./tools.ts";
import { initLog, log } from "./log.ts";
import { appVersion, createAnalytics, type Analytics } from "./analytics.ts";
import type { DeskSummary, InboxRow } from "../core/frame-types.ts";
import { stateFolders } from "../core/frames.ts";

/**
 * loki — a memory palace your agent builds.
 *
 * The desk is a directory the agent writes into (<widgets>/<desk>/), compiled into the open tab. This mod is loki's
 * own, hosted by loki's daemon (daemon/main.ts) through the mod API (daemon/mods/api.ts): it owns geometry and gesture
 * state, serves the app and the phone over its sockets, tells the agent what the person did on the canvas, and gives
 * the agent its canvas and suggestion tools. The daemon hands it the chats (`chats`, read; `chat`, run).
 */

function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(paths.token, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(16).toString("hex");
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.token, token, { mode: 0o600 });
  return token;
}

/** What the daemon hosts the mod with besides the mod API: its chats, to read and to run, and its analytics writer. */
export interface Host {
  chats: ChatSource;
  chat: ChatBackend;
  analytics?: Analytics;
  /** The daemon's usage ledger (daemon/usage.ts), for the usage page; `onChange` returns its unsubscribe. */
  usage?: NonNullable<UsageDeps["usage"]> & { onChange: (listener: () => void) => () => void };
  /** This Mac's install id (state/device-id), its name to other Macs (plan 023). */
  macId: string;
  /** The keychain (or the daemon's stand-in for it), for the tokens this Mac presents to paired Macs. */
  secrets: SecretBackend;
  /**
   * The suggestions kept on this Mac's chat records (plan 047, KTD1): reading and writing a chat's list. Absent from a
   * daemon that predates them, and the suggestion frames say so.
   */
  suggestions?: SuggestionRecords;
  /**
   * The memory repos and their queue (daemon/memory-sync.ts). The mod is bundled apart from the daemon, so it takes
   * them from here: its own copy of the queue would race the daemon's commits and never hear them (plan 046).
   */
  memory: MemoryRepos;
  /**
   * Updating a checkout's loki (plans 024 and 041): the file whose change made an update due (null when none, always in
   * the installed app), hearing when one becomes due, and updating now (a page build, a restart): null once done or
   * under way, else why not.
   */
  daemon?: {
    restartDue: () => string | null;
    onRestartDue: (fn: (file: string) => void) => () => void;
    restart: (anyway: boolean) => Promise<string | null>;
  };
}

/**
 * Starts the mod inside the daemon: the desk server on loopback, the widget watcher, the desks and their state, the
 * frame router behind /ws, the phone listener (off until switched on in Settings), and the chat event handlers.
 * Returns the function that stops all of it.
 */
export default function activate(api: ModApi, host: Host): () => void {
  initLog(paths.modLog);
  // Product analytics, local only (core/analytics.ts; `npm run analytics` reads it). LOKI_ANALYTICS=0 turns it off.
  const analytics =
    host.analytics ??
    createAnalytics({ path: process.env.LOKI_ANALYTICS === "0" ? null : paths.events, statePath: paths.analytics, appVersion: appVersion(paths.root) });
  log("activate", { pid: process.pid, node: process.versions.node, api: api.apiVersion });

  const modPort = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT);
  const token = loadOrCreateToken();

  // --- state -----------------------------------------------------------
  const store = new DeskStore();
  loadDesks(store, paths.state);
  const stopPersist = persistDesks(store, paths.state);
  const gestures = new GestureLog();
  // Learn's cards (daemon/learn.ts writes them; mod/recall.ts reads them), and which chats are the passes' own.
  const recallStore = new RecallStore();
  const passChat = isPassChat;

  let activeScope: Scope = SHARED_SCOPE;

  let srv: LokiServer | null = null;
  let ws: WsBridge | null = null;
  let starting: Promise<LokiServer> | null = null;
  /** Set when the mod stops: a server still starting then closes as soon as it is up, so the next mod can have its port. */
  let stopped = false;
  let lan: LanListener | null = null; // the phone listener, built after the bridge (it serves the same handlers)
  const phones = (): LanListener => {
    if (!lan) throw new Error("the phone listener is not up yet");
    return lan;
  };
  /** loki's mods folder as it syncs between Macs (plan 023, U10). */
  const MOD_FILES = { list: listModFiles, safe: isModPath };
  /** The person's state on paired Macs (plan 023, U8), told when a push here says some of it changed. */
  const stateSync: { peerState: PeerState | null } = { peerState: null };
  const STATE_PUSHES = new Set(["seen", "desks", "recall_changed"]);
  // Every frame goes to the desktop's tabs and to paired phones alike.
  const broadcast = (msg: object, scope?: Scope) => {
    ws?.broadcast(msg, scope);
    lan?.broadcast(msg, scope);
    const type = (msg as { type?: string }).type ?? "";
    // Learn's files travel to a paired Mac only when they changed (plan 040).
    if (STATE_PUSHES.has(type)) stateSync.peerState?.changed(type === "recall_changed" ? "learn" : undefined);
  };

  store.subscribe((scope, state) => broadcast({ type: "state", scope, state }, scope === SHARED_SCOPE ? undefined : scope));

  // --- the agent's half: files ------------------------------------------
  mkdirSync(paths.widgets, { recursive: true });
  const widgetLog = new WidgetLog(join(paths.state, "widget-log"));
  const widgets = watchWidgets(paths.widgets, (diff) => {
    log("widgets:diff", { added: diff.added.map((e) => e.id), changed: diff.changed.map((e) => e.id), removed: diff.removed });
    // Shared widgets first: they appear on every desk, so they claim space before desk widgets flow around them.
    for (const e of [...diff.added].sort((a, b) => Number(b.scope === SHARED_SCOPE) - Number(a.scope === SHARED_SCOPE))) store.seen(e.scope, e.id);
    for (const e of diff.changed) store.fileChanged(e.scope, e.id);
    const scopes = new Set<Scope>([...diff.added.map((e) => e.scope), ...diff.changed.map((e) => e.scope), ...diff.removed.map(scopeOfId)]);
    for (const scope of scopes) {
      broadcast({ type: "widgets", scope, widgets: widgets.entries(scope) }, scope === SHARED_SCOPE ? undefined : scope);
    }
    const landed = diff.added.at(-1);
    if (landed && !landed.error) {
      broadcast({ type: "camera", widget_id: landed.id }, landed.scope === SHARED_SCOPE ? undefined : landed.scope);
    }
    broadcastWidgetChanges(widgetLog, diff, broadcast);
  });

  // --- chats -------------------------------------------------------------
  // Read from the daemon's stores (`chats`), and run by it (`chat`: sending, streaming, models, agents) through the
  // mod's frames; what happens in a chat goes to every client.
  const { chats, chat: chatBackend } = host;
  chatBackend.attach((agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }));
  const desks = new DeskRegistry(join(paths.state, "desks.json"), (id) => chats.agentOf(id));
  const seen = new SeenStore(join(paths.state, "attention.json"));
  // The folder a chat works in, from the daemon's folder index; the task move falls back to it (plan 047, U7).
  const folderFor = (agentId: string | null, conversationId: string | null): string | null =>
    conversationId ? (chats.folders().by_conversation[conversationDirName(conversationId, agentId)] ?? null) : null;

  // --- transport -------------------------------------------------------
  // Which chats show in the chat list and the inbox, and what each row says (mod/chat-listing.ts).
  const listing = new ChatListing({
    chats,
    desks,
    layouts: () => store.scopes(),
    widgets,
    pins: () => readPins(),
    passChats: () => isPassChat,
    activeScope: () => activeScope,
  });
  const deskInfo = (scope: Scope) => listing.info(scope);
  const listLocalDesks = () => listing.desks();
  const listLocalInbox = () => listing.inbox();
  // Every list holds this Mac's chats and every paired Mac's, each of those marked with its Mac (plan 023, U4).
  const listDesks = (): DeskSummary[] => sortDesks([...listLocalDesks(), ...remoteChats.desks()]);
  const listInbox = (): InboxRow[] =>
    [...listLocalInbox(), ...remoteChats.inbox()].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  const deleteWidgetFile = (id: string): string | null => {
    const entry = widgets.get(id);
    if (!entry) return null;
    const abs = join(paths.widgets, entry.file);
    try {
      widgetLog.expect(id, "removed", "you"); // the person's trash, not the agent's removal
      unlinkSync(abs);
      log("widget:trashed", { id, file: abs });
      void widgets.rescan();
      return abs;
    } catch (err) {
      log("widget:trash-failed", { id, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  // Paired phones and the codes that pair them (mod/devices.ts, mod/pairing.ts); the listener itself follows the bridge.
  const devices = new DeviceStore(paths.devices);
  const codes = new PairingCodes();
  // Paired Macs (plan 023, mod/peers.ts), on the same listener over the tailnet, with codes of their own.
  const peerStore = new PeerStore(paths.peers);
  const peerCodes = new PairingCodes();
  const macId = host.macId;
  const thisMacName = macName();
  const build = appVersion(paths.root);
  /** This Mac's tailnet address for other Macs, or null when Tailscale is not running here. */
  const tailnetHost = (): string | null => {
    const s = lan?.status();
    return s?.tailscale?.running && s.tailscale.name ? `${s.tailscale.name}:${s.port}` : null;
  };
  /** Until when a Mac pairing code may be redeemed: the listener stays up for it. */
  let peerCodeUntil = 0;
  const peersNeeded = () => peerStore.size() > 0 || peerCodeUntil > Date.now();
  const peerKeys = new PeerKeys(host.secrets);
  /** Tailscale's view of this Mac and its tailnet, shared by the phone listener and Settings › Macs. */
  const tailscale = new Tailscale({ port: Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT) });
  const peersView = () => {
    const paired = new Set(peerStore.list().map((p) => p.host.replace(/:\d+$/, "").toLowerCase()));
    // Computers only: a phone or a tablet on the tailnet is not a Mac to pair with.
    const tailnet = tailscale
      .devices()
      .filter((d) => /^(macos|linux|windows)$/i.test(d.os))
      .map((d) => ({ ...d, paired: paired.has(d.address) }));
    return { me: { mac_id: macId, name: thisMacName, host: tailnetHost() }, peers: peerStore.list((id) => links.reachable(id)), tailnet };
  };
  // One link to each paired Mac (U2): opened when it pairs, closed when it is forgotten.
  const links: PeerLinks = new PeerLinks({
    token: (id) => peerKeys.get(id),
    defaults: { protocol: PEER_PROTOCOL },
    onStatus: (id, status) => {
      ws?.broadcast({ type: "peers", ...peersView() });
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
      // Tasks whose chats live there, which could not move into suggestions while it was out of reach (plan 047, U7).
      { name: "tasks", after: "moves", reached: () => moveOpenTasks() },
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
    tell: (frame) => lan?.broadcast(frame),
  });
  // Each chat answered by the Mac it lives on (U5): frames about another Mac's chats go there.
  const router: ChatRouter = new ChatRouter({
    here: macId,
    peer: (id) => (peerStore.get(id) ? { mac: id, reachable: links.reachable(id) } : null),
    agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
    directory,
    link: (id) => links.get(id),
    name: (id) => peerStore.get(id)?.name ?? "another Mac",
    uploadsDir: paths.uploads,
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
    widgetsDir: paths.widgets,
    name: (id) => (id === null ? thisMacName : (peerStore.get(id)?.name ?? null)),
    done: (id) => peerStore.get(id)?.moves_done === true,
    markDone: (id) => peerStore.markMovesDone(id),
    onMoved: (id) => {
      void remoteChats.refresh(id);
      broadcast({ type: "lists_changed" });
    },
    onLeft: (chat, to) => {
      directory.left(chat, to);
      desks.forgetConversations((id) => id === chat.conversation_id); // its desk row lives on the other Mac now
      broadcast({ type: "lists_changed" });
    },
  });
  // Suggestions (plan 047): kept on the records of this Mac's chats and carried out here, sending to the Mac each
  // target lives on and waiting for its answer (mod/suggestions.ts).
  const suggestions = host.suggestions
    ? new Suggestions({
        records: host.suggestions,
        chat: (ref) => {
          const desk = listDesks().find((d) => d.conversation_id === ref.conversation_id && (d.agent_id ?? ref.agent_id) === ref.agent_id);
          return desk ? { title: desk.title, status: desk.status, has_draft: desk.has_draft === true } : null;
        },
        agentExists: (id) => readLocalAgent(id) !== null,
        agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
        call: chatCaller({ route: router, backend: chatBackend, blocked: (agentId, conversationId) => chatMoves.blocked(agentId, conversationId) }),
        push: (agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }),
        track: (event, properties) => analytics.capture("mod", event, properties),
      })
    : undefined;
  // Tasks retired into suggestions (plan 047, U7): each open task moves to the chat it was filed from once, at start and
  // again when a paired Mac comes into reach, since a chat that lives there moves only while its Mac answers. One run
  // at a time, so two runs never add the same task twice; start does not wait for it.
  let taskMove: Promise<unknown> = Promise.resolve();
  const moveOpenTasks = (): Promise<unknown> => {
    if (!suggestions) return taskMove;
    const s = suggestions;
    taskMove = taskMove
      .then(() =>
        moveTasks({
          run: bdReader(tasksDir()),
          stateFile: join(paths.state, "migrations.json"),
          route: router,
          suggestions: s,
          folderOf: (c) =>
            listDesks().find((d) => d.conversation_id === c.conversation_id && (d.agent_id ?? c.agent_id) === c.agent_id)?.cwd ??
            folderFor(c.agent_id, c.conversation_id),
          report: (message) => log("tasks:move", message),
        }),
      )
      .catch((err: unknown) => log("tasks:move-failed", err instanceof Error ? err.message : String(err)));
    return taskMove;
  };
  void moveOpenTasks();
  // The person's state on every paired Mac (U8): marks and focus, pins, label colours, Learn.
  const peerState: PeerState = new PeerState({
    snapshot: (folders) => ({
      marks: seen.snapshot(),
      pins: pinChanges(),
      labels: chatBackend.labelColors(),
      mcp: mcpSnapshot(join(paths.data, "mcp.json"), join(paths.state, "mcp-sync.json")),
      ...(folders.includes("learn") ? { learn: recallSnapshot(recallDir()) } : {}),
      ...(folders.includes("mods") ? { mods: filesSnapshot(join(paths.data, "mods"), MOD_FILES) } : {}),
    }),
    apply: (id, theirs) => {
      const moved = {
        marks: seen.applyRemote(id, theirs.marks),
        pins: applyPinChanges(theirs.pins),
        labels: chatBackend.applyLabelColors(theirs.labels),
        learn: theirs.learn ? applyRecall(recallDir(), theirs.learn) : false,
        // The daemon follows mcp.json and the mods folder itself: a change written here is picked up there.
        mcp: applyMcp(join(paths.data, "mcp.json"), join(paths.state, "mcp-sync.json"), theirs.mcp),
        mods: theirs.mods ? applyFiles(join(paths.data, "mods"), MOD_FILES, theirs.mods) : false,
      };
      if (moved.marks) broadcast(seenFrame({ seen }));
      if (moved.pins) broadcast({ type: "desks", desks: listDesks() });
      if (moved.labels) broadcast({ type: "lists_changed" });
      if (moved.learn) broadcast({ type: "recall_changed" });
      return moved;
    },
    link: (id) => links.get(id),
    tell: (folders) => lan?.broadcast({ type: "state_changed", folders }),
  });
  stateSync.peerState = peerState;
  // An edit to mcp.json or a mod by hand says nothing: every paired Mac's state is asked for again every few minutes.
  const statePoll = setInterval(() => {
    for (const p of peerStore.list()) if (links.reachable(p.mac_id)) void peerState.pull(p.mac_id);
  }, 5 * 60_000);
  statePoll.unref();
  // The same memory on every paired Mac (U7): told when a repo here moves, asking when one there does.
  const peerMemory: PeerMemory = new PeerMemory({
    backendDir,
    repos: host.memory,
    macId,
    link: (id) => links.get(id),
    homeOf: (agentId) => recordHome(readRecord(backendDir(), agentId), macId),
    tell: (agentId) => lan?.broadcast({ type: "memory_changed", agent_id: agentId }),
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
    me: () => ({ mac_id: macId, name: thisMacName, host: tailnetHost() ?? "", build, protocol: PEER_PROTOCOL }),
    onChange: () => {
      // The Macs this one is paired with changed: they join any they lack (addendum D1).
      lan?.broadcast({ type: "group_changed" });
      awake.set(peerStore.size() > 0);
      links.sync(peerStore.list());
      remoteChats.sync(peerStore.list().map((p) => p.mac_id));
      for (const id of known) if (!peerStore.get(id)) directory.forget(id);
      known = new Set(peerStore.list().map((p) => p.mac_id));
      ws?.broadcast({ type: "peers", ...peersView() });
      void lan?.setPeersNeeded(peersNeeded());
    },
    onForget: (id) => {
      lan?.closePeer(id);
      seen.forgetMac(id); // its focus no longer counts here
    },
  });
  // Where each memory skill came from, and the refresh that pulls upstream and reconciles (mod/skill-sources.ts).
  const skillSources = new SkillSources({
    sourcesFile: join(paths.state, "skill-sources.json"),
    stagingDir: join(paths.state, "upstream"),
    serial: host.memory.serial,
  });
  // --- recall -----------------------------------------------------------
  // Cards written in the background by the daemon's Learn pass (daemon/learn.ts) from chats that have gone quiet;
  // the person meets them only in the Learn section. Its settings and last run are the daemon's (daemon/passes-state.ts).
  // recallStore and passChat: above, with the state (the desk listing needs them from the start).
  const learnStatus = () => {
    const passes = new PassState(paths.state);
    const s = passes.settings().learn;
    const last = passes.learnLast();
    return {
      enabled: s.enabled,
      daily_cap: s.daily_cap,
      last_run_at: last?.at ?? null,
      last_run_note: last?.note ?? null,
      written_today: passes.writtenOn(isoDay(Date.now())),
    };
  };
  // A lesson's chat is made by the daemon, in process.
  const lessons = { store: recallStore, widgetsDir: paths.widgets, expect: (id: string, change: WidgetChange) => widgetLog.expect(id, change, "loki") };

  // Open usage pages refetch when the ledger counts more; a busy turn's commits come in bursts, so one push in two seconds.
  let usagePush: ReturnType<typeof setTimeout> | null = null;
  // An update due after a checkout's code changed (plans 024 and 041): every window offers it.
  const stopRestartDue = host.daemon?.onRestartDue((file) => ws?.broadcast({ type: "restart_due", file }));
  const stopUsage = host.usage?.onChange(() => {
    usagePush ??= setTimeout(() => {
      usagePush = null;
      broadcast({ type: "usage_changed" });
    }, 2000);
  });

  const moduleDeps: ModuleDeps = {
    store,
    widgets,
    gestures,
    listDesks,
    listInbox,
    recall: {
      store: recallStore,
      status: learnStatus,
      setSettings: async (s) => {
        await chatBackend.setPasses({ learn: s });
      },
      run: async () => {
        await chatBackend.runLearn();
        return { note: learnStatus().last_run_note ?? "nothing new" };
      },
      startLesson: startLessonViaChats(chatBackend, lessons),
      lessonEmpty: (l) => chats.info(l.conversation_id, l.agent_id)?.lastMessageAt == null,
    },
    deskInfo,
    deleteWidgetFile,
    seen,
    transcript: (agentId, conversationId, limit, before) => chats.page(conversationId, agentId, limit, before),
    row: (agentId, conversationId, row) => chats.row(conversationId, agentId, row),
    widgetLog: (agentId, conversationId) => widgetLog.read(scopeFor(conversationId, agentId)),
    folders: { recent: () => chats.folders(), complete: completeFolder, check: checkFolder, pick: pickFolder },
    setPin: (agentId, conversationId, pinned) => setPin(agentId, conversationId, pinned),
    recentModels: { read: () => readRecentModels(), add: (handle) => addRecentModel(handle) },
    // A chat opens with the suggestions waiting in it (plan 047).
    chat: suggestions ? withSuggestionsOnOpen(chatBackend, suggestions) : chatBackend,
    suggestions,
    decidedBy: (c) => (c.deviceId ? "phone" : c.peerId ? (peerStore.get(c.peerId)?.name ?? "another Mac") : "desktop"),
    usage: host.usage,
    daemon: host.daemon,
    lan: {
      status: () => phones().status(),
      refresh: () => phones().refresh(),
      setEnabled: (enabled) => phones().setEnabled(enabled),
      setVia: (via) => phones().setVia(via),
      setServe: (enabled) => phones().setServe(enabled),
      pairBegin: () => {
        const { code, expiresAt } = codes.mint();
        log("lan:pair-code", { expiresAt });
        return { code, url: phones().pairUrl(code), expires_at: expiresAt };
      },
      devices: () => devices.list(),
      forget: (id) => phones().forget(id),
    },
    peers: {
      view: peersView,
      refresh: () => phones().refresh(),
      begin: async () => {
        const { code, expiresAt } = peerCodes.mint();
        peerCodeUntil = Date.parse(expiresAt);
        // Bound and Tailscale asked before the address is shown: the other Mac types it.
        await phones().setPeersNeeded(true);
        await phones().refresh();
        // Once the code has lapsed, the listener stays up only for the Macs already paired (or the phone switch).
        setTimeout(() => void phones().setPeersNeeded(peersNeeded()), PAIRING_TTL_MS + 1000).unref();
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
      chats: () => ({ desks: listLocalDesks(), inbox: listLocalInbox() }),
      state: (folders) => peerState.snapshotNow(folders),
      where: (chat) => directory.answer(chat),
      group: {
        macs: () => peerStore.list().map((p) => ({ mac_id: p.mac_id, name: p.name, host: p.host })),
        introduce: (from, id) => peerGroup.introduce(from, id),
        invite: (id) => peers.invite(id),
      },
      moves: chatMoves,
      memory: (agentId, have) => peerMemory.bundle(agentId, have).then((bundle) => ({ agent_id: agentId, bundle })),
    },
    chatBlocked: (agentId, conversationId) => chatMoves.blocked(agentId, conversationId),
    // Deleting an agent while a paired Mac is out of reach would leave that Mac's chats with it behind (plan 023, KTD6).
    // Deleting an agent while a Mac out of reach holds its chats would leave them there (KTD6, addendum D5).
    agentDeleteBlocked: (agentId) => {
      const away = remoteChats.awayWith(agentId);
      return away ? `${peerStore.get(away)?.name ?? "another Mac"} is out of reach and has this agent's chats: delete it once that Mac is back` : null;
    },
    agents: {
      get: (id) => readLocalAgent(id),
      tree: (id) => memoryTree(id),
      skills: (id) => memorySkills(id),
      skillsInfo: (id) => skillSources.annotate(id, memorySkills(id)),
      refreshSkill: (id, name, spec) => skillSources.refresh(id, name, spec),
      hasProfile: (id) => profilePath(id) !== null,
      read: (id, path) => readMemoryFile(id, path),
      log: (id, opts) => memoryLog(id, opts),
      diff: (id, sha) => memoryDiff(id, sha),
      reflection: (id) => reflectionState(id),
      globalSkills: () => listGlobalSkills().map((g) => ({ ...g, source: skillSources.describeGlobal(g) })),
      install: (id, source, force) => installSkill(source, id, { force }),
    },
  };
  const bridge = createBridge({
    modules: frameModules(moduleDeps),
    welcome: welcomeFrames(moduleDeps),
    broadcast,
    capture: (client, event, properties) => analytics.capture(client.deviceId ? "phone" : "mac", event, properties),
    route: router,
  });
  /** A picture not here, from whichever paired Mac in reach holds it (plan 029): the chat it is in lives there. */
  const chatImageFromPeers = async (name: string): Promise<Buffer | null> => {
    for (const p of peerStore.list()) {
      if (!links.reachable(p.mac_id)) continue;
      const data = await peers.chatImage(p.mac_id, name);
      if (data) return data;
    }
    return null;
  };
  const ensureServer = async (): Promise<LokiServer> => {
    if (srv) return srv;
    starting ??= startServer({
      port: modPort,
      token,
      profile: (agentId) => profilePath(agentId),
      uploads: paths.uploads,
      // Back from signing in to a remote MCP server (daemon/mcp/oauth.ts): only on this loopback server.
      routes: [
        oauthCallbackRoute(MCP_OAUTH_CALLBACK, (params) => host.chat.mcpOauthCallback(params)),
        chatImageRoute({ prefix: "/chat-images/", dir: paths.chatImages, authorize: tokenAuth(token), denied: 403, fetchRemote: chatImageFromPeers }),
      ],
      health: () => ({ desks: store.scopes(), widgets: widgets.entries().length, tabs: ws?.clientCount() ?? 0 }),
    }).then(async (s) => {
      if (stopped) {
        await s.close();
        throw new Error("the mod stopped while its server was starting");
      }
      ws = attachWs(s.server, token, bridge);
      log("server:listening", { port: s.port });
      return (srv = s);
    });
    try {
      return await starting;
    } catch (err) {
      starting = null;
      log("server:failed", err instanceof Error ? err.message : String(err));
      api.diagnostics.report({
        message: `loki: server failed to start on ${modPort} (${err instanceof Error ? err.message : String(err)})`,
        severity: "error",
      });
      throw err;
    }
  };
  // The desk server is always up while the mod is: the loki app (or a browser tab) connects whenever it likes.
  void ensureServer().catch((err: unknown) => log("server:error", err instanceof Error ? err.message : String(err)));

  // --- phones ----------------------------------------------------------
  // A second listener on the LAN, off by default; state/lan.json remembers the switch across /reload.
  // Tailscale, when installed, is the way off the Wi‑Fi (Addendum 3): the QR prefers the tailnet name or
  // the https front `tailscale serve` puts on this port; the CLI is only read, never installed.
  const lanPort = Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT);
  lan = new LanListener({
    port: lanPort,
    tailscale,
    stateFile: paths.lan,
    devices,
    codes,
    handlers: bridge,
    desktopToken: token,
    profile: (agentId) => profilePath(agentId),
    uploads: paths.uploads,
    chatImages: { dir: paths.chatImages, fetchRemote: chatImageFromPeers },
    peers,
    health: () => ({ phones: lan?.clientCount() ?? 0 }),
    // The listener's status (addresses, the Tailscale name) and the paired devices are the desktop's settings: they
    // go to its tabs, not to the phones themselves, which never read them.
    onChange: (what, status) => {
      if (what === "status") {
        log("lan:status", status);
        ws?.broadcast({ type: "lan_status", ...status });
      } else {
        ws?.broadcast({ type: "devices", devices: devices.list() });
      }
    },
  });
  if (lan.enabled()) void lan.start();
  if (peerStore.size() > 0) void lan.setPeersNeeded(true);
  links.sync(peerStore.list());

  // --- events ----------------------------------------------------------
  const eventDisposers: Array<() => void> = [];
  const titleRefreshes = new ScopeDebouncer();
  /** The background passes' own chats get no desk, and the tab does not follow them. */
  const ignored = (e: ChatRef) => passChat(e.chatId);

  eventDisposers.push(
    api.events.on("chat_open", (e) => {
      log("event:chat_open", { id: e.chatId });
      if (ignored(e)) return;
      const next = desks.remember(e.chatId, e.agentId);
      if (next !== activeScope) {
        activeScope = next;
        broadcast({ type: "switch_desk", scope: activeScope }); // the tab follows the conversation
      }
    }),
  );

  // The person's message, about to be sent: what they did on the canvas rides along with it.
  eventDisposers.push(
    api.message.transform((m) => {
      // A background pass's turn is the pass's: no desk, nothing rides along, the tab does not follow it.
      if (passChat(m.chatId)) return undefined;
      const scope = desks.remember(m.chatId, m.agentId);
      activeScope = scope;
      const lines = [...gestures.drain(scope), ...(scope !== SHARED_SCOPE ? gestures.drain(SHARED_SCOPE) : [])];
      log("event:message", { desk: scope, attached: lines.length });
      seen.mark(m.agentId, m.chatId); // you just spoke in this conversation
      // Your message is engagement; a turn with nothing typed (an image alone) is still yours, but not typed words.
      if (m.typed) seen.engage(m.agentId, m.chatId, "message");
      broadcast(seenFrame({ seen }));
      if (!lines.length) return undefined;
      return attachDeskContext(m.content, formatDeskContext(scope, lines, paths.widgets));
    }),
  );

  eventDisposers.push(
    api.events.on("tool_start", (e) => {
      if (e.name.startsWith("desk_") || e.name.startsWith("loki_")) {
        log("event:tool_start", { tool: e.name, args: e.args });
        analytics.capture("mod", "tool_used", { tool: e.name });
      }
    }),
  );
  eventDisposers.push(
    api.events.on("tool_end", (e) => {
      if (e.name.startsWith("desk_") || e.name.startsWith("loki_")) log("event:tool_end", { tool: e.name, failed: e.failed });
    }),
  );

  eventDisposers.push(
    api.events.on("turn_end", (e) => {
      if (ignored(e)) return;
      // The turn itself is measured by the daemon (daemon/telemetry.ts, turn_finished).
      const scope = desks.remember(e.chatId, e.agentId);
      titleRefreshes.schedule(
        scope,
        () => {
          // A chat's title can come after its first turn; tell tabs when the title or status changes.
          const frame = listing.titleFrame(scope);
          if (frame) broadcast(frame, scope === SHARED_SCOPE ? undefined : scope);
        },
        1200,
      );
    }),
  );

  // --- tools -----------------------------------------------------------
  const toolDisposers = registerTools(api, {
    store,
    widgets,
    gestures,
    widgetsDir: paths.widgets,
    activeScope: () => activeScope,
    remember: (conversationId, agentId) => desks.remember(conversationId, agentId ?? null),
    broadcast,
    // chat_list and the suggestion tools (plan 047, U3): every list's chats, and each agent with the Mac it lives on.
    chats: suggestions
      ? {
          suggestions,
          agents: async () =>
            (await chatBackend.agents()).map((a) => {
              const home = a.home_mac && a.home_mac !== macId ? a.home_mac : null;
              return {
                id: a.id,
                name: a.name,
                mac: home ? (peerStore.get(home)?.name ?? "another Mac") : thisMacName,
                reachable: home ? links.reachable(home) : true,
              };
            }),
          chats: listDesks,
          passChat,
        }
      : undefined,
  });

  // --- lifecycle -------------------------------------------------------
  const shutdown = (): void => {
    log("shutdown");
    stopped = true;
    ws?.close();
    void srv?.close();
    void lan.stop(); // the socket only; the setting stays so the listener returns with the mod
    links.stop(); // the links to other Macs reopen with the mod
    remoteChats.stop();
    peerMemory.stop();
    peerState.stop();
    clearInterval(statePoll);
    awake.set(false);
    ws = null;
    srv = null;
    starting = null;
    widgets.close();
    titleRefreshes.clear();
    seen.flush(); // the marks' write is coalesced (mod/seen.ts): land the last one
  };
  api.signal.addEventListener("abort", shutdown, { once: true });

  return () => {
    stopUsage?.();
    stopRestartDue?.();
    if (usagePush) clearTimeout(usagePush);
    for (const d of eventDisposers) d();
    for (const d of toolDisposers) d();
    stopPersist();
    shutdown();
  };
}
