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
import { DeskRegistry, agentHasMemory, lookupLocalAgentName } from "./desks.ts";
import type { ChatSource } from "./chat-source.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { SeenStore } from "./seen.ts";
import { RecallStore, isoDay, recallDir } from "./recall.ts";
import { applyRecall, recallSnapshot } from "./recall-sync.ts";
import { PeerState } from "./peer-state.ts";
import { ChatMoves } from "./chat-moves.ts";
import { isPassChat, startLessonViaChats } from "./recall-worker.ts";
import { PassState } from "../daemon/passes-state.ts";
import { isLearnTitle } from "../core/recall/model.ts";
import { TaskStore, TasksNotice } from "./tasks.ts";
import { applyPinChanges, pinChanges, readPins, setPin } from "./pins.ts";
import { addRecentModel, readRecentModels } from "./models.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { reflectionState } from "./reflection.ts";
import { backendDir, isSubagent, memoryDiff, memoryLog, memorySkills, memoryTree, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";
import { conversationDirName, scopeFor } from "../core/desk-core.ts";

import { sortDesks } from "./frames/desks.ts";
import { frameModules, welcomeFrames, type ModuleDeps } from "./frames/index.ts";
import type { UsageDeps } from "./frames/usage.ts";
import { join } from "node:path";
import { attachWs, oauthCallbackRoute, startServer, type LokiServer, type WsBridge } from "./server.ts";
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
import type { SecretBackend } from "../daemon/credentials.ts";
import { LanListener } from "./lan.ts";
import { Tailscale } from "./tailscale.ts";
import { registerTools } from "./tools.ts";
import { initLog, log } from "./log.ts";
import { appVersion, createAnalytics, type Analytics } from "./analytics.ts";
import { reasoningEffortFromSettings } from "../core/models.ts";
import type { DeskInfo, DeskSummary, InboxRow } from "../core/frame-types.ts";

/**
 * loki — a memory palace your agent builds.
 *
 * The desk is a directory the agent writes into (<widgets>/<desk>/), compiled into the open tab. This mod is loki's
 * own, hosted by loki's daemon (daemon/main.ts) through the mod API (daemon/mods/api.ts): it owns geometry and gesture
 * state, serves the app and the phone over its sockets, tells the agent what the person did on the canvas, and gives
 * the agent its canvas and task tools. The daemon hands it the chats (`chats`, read; `chat`, run).
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
  const passChat = (id: string) => isPassChat(recallStore, id);

  let activeScope: Scope = SHARED_SCOPE;

  let srv: LokiServer | null = null;
  let ws: WsBridge | null = null;
  let starting: Promise<LokiServer> | null = null;
  let lan: LanListener | null = null; // the phone listener, built after the bridge (it serves the same handlers)
  const phones = (): LanListener => {
    if (!lan) throw new Error("the phone listener is not up yet");
    return lan;
  };
  /** The person's state on paired Macs (plan 023, U8), told when a push here says some of it changed. */
  const stateSync: { peerState: PeerState | null } = { peerState: null };
  const STATE_PUSHES = new Set(["seen", "desks", "recall_changed"]);
  // Every frame goes to the desktop's tabs and to paired phones alike.
  const broadcast = (msg: object, scope?: Scope) => {
    ws?.broadcast(msg, scope);
    lan?.broadcast(msg, scope);
    if (STATE_PUSHES.has((msg as { type?: string }).type ?? "")) stateSync.peerState?.changed();
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
  // The task list (beads). Reads are cached so turn_start can attach assigned tasks without waiting on bd.
  const tasks = new TaskStore();
  const folderFor = (agentId: string | null, conversationId: string | null): string | null =>
    conversationId ? (chats.folders().by_conversation[conversationDirName(conversationId, agentId)] ?? null) : null;
  const refreshTasks = () => {
    if (!tasks.ready()) return;
    void tasks.list().catch((err: unknown) => log("tasks:list-error", err instanceof Error ? err.message : String(err)));
  };
  refreshTasks();
  const tasksTimer = setInterval(refreshTasks, 60_000);
  log("tasks:store", { dir: tasks.dir, ready: tasks.ready() });

  // --- transport -------------------------------------------------------
  const deskInfo = (scope: Scope): DeskInfo & { last_active: string | null } => {
    if (scope === SHARED_SCOPE)
      return { title: "shared", status: "none", agent_name: null, agent_id: null, model: null, reasoning_effort: null, last_active: null };
    const rt = desks.get(scope);
    if (!rt) return { title: null, status: "none", agent_name: null, agent_id: null, model: null, reasoning_effort: null, last_active: null };
    const agentName = lookupLocalAgentName(rt.agent_id);
    const agent = readLocalAgent(rt.agent_id);
    const agentModel = agent?.model ?? null;
    const agentEffort = reasoningEffortFromSettings(agent?.model_settings);
    const info = chats.info(rt.conversation_id, rt.agent_id);
    const mode = info?.mode ?? "unrestricted";
    if (!info)
      return {
        title: null,
        status: "deleted",
        agent_name: agentName,
        agent_id: rt.agent_id,
        model: agentModel,
        reasoning_effort: agentEffort,
        mode,
        last_active: null,
      };
    return {
      title: info.title,
      status: info.archived ? "archived" : "live",
      agent_name: agentName,
      agent_id: rt.agent_id,
      model: info.model ?? agentModel,
      reasoning_effort: info.model ? info.reasoningEffort : (info.reasoningEffort ?? agentEffort),
      mode,
      labels: info.labels,
      last_active: info.lastMessageAt,
    };
  };
  /** This Mac's own desks: what another Mac's lists show of this one (plan 023, U4). */
  const listLocalDesks = (): DeskSummary[] => {
    // A subagent's turn may have registered a desk before we knew what it was: evict it, once, here.
    for (const agentId of new Set(desks.all().map((d) => d.agent_id)))
      if (isSubagent(agentId) && desks.forgetAgent(agentId)) log("desks:evict-subagent", { agentId });
    // And the background passes' chats, which an earlier loki listed (Learn's) and kept as desks.
    const evicted = desks.forgetConversations(passChat);
    if (evicted) log("desks:evict-pass-chats", { evicted });
    const scopes = new Set<Scope>([SHARED_SCOPE, ...store.scopes(), ...desks.all().map((d) => d.scope)]);
    for (const e of widgets.entries()) scopes.add(e.scope);
    const pins = readPins();
    // Every conversation of the user's own agents, seen by loki or not (subagents' one-off chats stay out).
    const ownAgents = new Set(desks.all().map((d) => d.agent_id));
    for (const c of chats.list()) {
      // A deleted agent leaves its memory repo behind: its record must still exist too. Hidden conversations stay
      // out, the background passes' among them (reflection's and Learn's): what they did shows as memory changes
      // and cards, not as chats.
      if (c.hidden || passChat(c.conversationId) || !(ownAgents.has(c.agentId) || (agentHasMemory(c.agentId) && readLocalAgent(c.agentId)))) continue;
      // Helper agents have memory folders too: without this, the eviction above was undone on every listing.
      if (isSubagent(c.agentId)) continue;
      scopes.add(desks.remember(c.conversationId, c.agentId));
    }
    return sortDesks(
      [...scopes].map((scope) => {
        const info = deskInfo(scope);
        return {
          scope,
          title: info.title,
          status: info.status,
          agent_name: info.agent_name,
          agent_id: info.agent_id,
          conversation_id: desks.get(scope)?.conversation_id ?? null,
          pinned: pins.has(`${desks.get(scope)?.agent_id ?? ""}/${desks.get(scope)?.conversation_id ?? ""}`),
          model: info.model,
          reasoning_effort: info.reasoning_effort,
          mode: info.mode ?? null,
          labels: info.labels ?? [],
          widgets: widgets.entries(scope).length,
          active: scope === activeScope,
          last_active: info.last_active,
        };
      }),
    );
  };
  /**
   * The inbox's list, from the daemon's chats (its projection): every open conversation of the user's own
   * agents, main chats included, however old — a conversation leaves the inbox by being archived, not by
   * going quiet. Hidden conversations (Learn's writer chats, reflection's, side threads imported from Letta)
   * stay out, as in the tree.
   */
  const listLocalInbox = (): InboxRow[] => {
    const ownAgents = new Set(desks.all().map((d) => d.agent_id));
    const names = new Map<string, string | null>();
    const out: InboxRow[] = [];
    for (const c of chats.list()) {
      if (c.hidden || c.archived) continue;
      if (!(ownAgents.has(c.agentId) || (agentHasMemory(c.agentId) && readLocalAgent(c.agentId)))) continue;
      if (isSubagent(c.agentId)) continue;
      if (!names.has(c.agentId)) names.set(c.agentId, lookupLocalAgentName(c.agentId));
      const info = chats.info(c.conversationId, c.agentId);
      if (isLearnTitle(info?.title)) continue; // a lesson is precisely the thing that can wait: a desk, never an inbox card
      out.push({
        id: c.conversationId,
        agent_id: c.agentId,
        agent_name: names.get(c.agentId) ?? null,
        title: info?.title ?? null,
        last_message_at: c.lastMessageAt,
        archived: false,
        labels: info?.labels ?? [],
        ...chats.digest(c.conversationId, c.agentId),
      });
    }
    return out.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  };
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
  const peersView = () => ({ me: { mac_id: macId, name: thisMacName, host: tailnetHost() }, peers: peerStore.list((id) => links.reachable(id)) });
  // One link to each paired Mac (U2): opened when it pairs, closed when it is forgotten.
  const links: PeerLinks = new PeerLinks({
    token: (id) => peerKeys.get(id),
    defaults: { protocol: PEER_PROTOCOL },
    onStatus: (id, status) => {
      ws?.broadcast({ type: "peers", ...peersView() });
      remoteChats.setReachable(id, status === "reachable");
      // A Mac back in reach: take what changed there while the link was down, agents first, then their memory.
      if (status === "reachable") {
        // Agents, then their memory, then (once, after pairing) the chats of agents that live here (U9).
        void peerAgents
          .pull(id)
          .then(() => peerMemory.pullAll(id))
          .then(() => chatMoves.run(id));
        void peerState.pull(id);
      }
    },
    onPush: (id, frame) => {
      remoteChats.heard(id, frame);
      // A chat or desk that lives there: its clients here hear what it does (U5).
      const relay = router.relay(id, frame);
      if (relay) broadcast(frame, relay.scope);
      if (frame.type === "agents_changed") void peerAgents.pull(id).then((applied) => Promise.all(applied.created.map((a) => peerMemory.pull(id, a))));
      if (frame.type === "memory_changed" && typeof frame.agent_id === "string") void peerMemory.pull(id, frame.agent_id);
      if (frame.type === "state_changed") void peerState.pull(id);
    },
    // The other Mac refused this one's token: ask it once more over HTTP, which forgets it here if it forgot this Mac.
    onRefused: (id) => void peers.contact(id),
  });
  // The paired Macs' own chats, for every list here (U4).
  const remoteChats: RemoteChats = new RemoteChats({
    link: (id) => links.get(id),
    name: (id) => peerStore.get(id)?.name ?? "another Mac",
    onChange: () => broadcast({ type: "lists_changed" }),
  });
  // Each chat answered by the Mac it lives on (U5): frames about another Mac's chats go there.
  const router: ChatRouter = new ChatRouter({
    here: macId,
    peer: (id) => (peerStore.get(id) ? { mac: id, reachable: links.reachable(id) } : null),
    agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
    homeOf: (conv, agent) => remoteChats.homeOf(conv, agent),
    homeOfScope: (scope) => remoteChats.homeOfScope(scope),
    link: (id) => links.get(id),
    name: (id) => peerStore.get(id)?.name ?? "another Mac",
    uploadsDir: paths.uploads,
    upload: (id, file) => peers.upload(id, file),
  });
  // Taking over this Mac's agents' chats from a Mac they were made on, once after pairing (U9).
  const chatMoves: ChatMoves = new ChatMoves({
    chat: chatBackend,
    link: (id) => links.get(id),
    widgetsDir: paths.widgets,
    done: (id) => peerStore.get(id)?.moves_done === true,
    markDone: (id) => peerStore.markMovesDone(id),
    onMoved: (id) => {
      void remoteChats.refresh(id);
      broadcast({ type: "lists_changed" });
    },
  });
  // The person's state on every paired Mac (U8): marks and focus, pins, label colours, Learn.
  const peerState: PeerState = new PeerState({
    snapshot: () => ({ marks: seen.snapshot(), pins: pinChanges(), labels: chatBackend.labelColors(), learn: recallSnapshot(recallDir()) }),
    apply: (id, theirs) => {
      const moved = {
        marks: seen.applyRemote(id, theirs.marks),
        pins: applyPinChanges(theirs.pins),
        labels: chatBackend.applyLabelColors(theirs.labels),
        learn: applyRecall(recallDir(), theirs.learn),
      };
      if (moved.marks) broadcast(seenFrame({ seen }));
      if (moved.pins) broadcast({ type: "desks", desks: listDesks() });
      if (moved.labels) broadcast({ type: "lists_changed" });
      if (moved.learn) broadcast({ type: "recall_changed" });
      return moved;
    },
    link: (id) => links.get(id),
    tell: () => lan?.broadcast({ type: "state_changed" }),
  });
  stateSync.peerState = peerState;
  // The same memory on every paired Mac (U7): told when a repo here moves, asking when one there does.
  const peerMemory: PeerMemory = new PeerMemory({
    backendDir,
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
  const peers: Peers = new Peers({
    store: peerStore,
    keys: peerKeys,
    codes: peerCodes,
    me: () => ({ mac_id: macId, name: thisMacName, host: tailnetHost() ?? "", build, protocol: PEER_PROTOCOL }),
    onChange: () => {
      links.sync(peerStore.list());
      remoteChats.sync(peerStore.list().map((p) => p.mac_id));
      ws?.broadcast({ type: "peers", ...peersView() });
      void lan?.setPeersNeeded(peersNeeded());
    },
    onForget: (id) => {
      lan?.closePeer(id);
      seen.forgetMac(id); // its focus no longer counts here
    },
  });
  // Where each memory skill came from, and the refresh that pulls upstream and reconciles (mod/skill-sources.ts).
  const skillSources = new SkillSources({ sourcesFile: join(paths.state, "skill-sources.json"), stagingDir: join(paths.state, "upstream") });
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
    transcript: (agentId, conversationId, limit) => chats.page(conversationId, agentId, limit),
    widgetLog: (agentId, conversationId) => widgetLog.read(scopeFor(conversationId, agentId)),
    folders: { recent: () => chats.folders(), complete: completeFolder, check: checkFolder, pick: pickFolder },
    setPin: (agentId, conversationId, pinned) => setPin(agentId, conversationId, pinned),
    recentModels: { read: () => readRecentModels(), add: (handle) => addRecentModel(handle) },
    tasks: tasks.ready() ? tasks : undefined,
    folderFor,
    chat: chatBackend,
    usage: host.usage,
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
      begin: () => {
        const { code, expiresAt } = peerCodes.mint();
        peerCodeUntil = Date.parse(expiresAt);
        void phones().setPeersNeeded(true);
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
      state: () => peerState.snapshotNow(),
      moves: {
        candidates: (id) => chatBackend.moveCandidates(id),
        export: (id, agentId, conversationId) => chatMoves.export(id, agentId, conversationId),
        moved: async (agentId, conversationId) => {
          await chatMoves.moved(agentId, conversationId);
          desks.forgetConversations((id) => id === conversationId); // its desk row lives on the other Mac now
          broadcast({ type: "lists_changed" });
        },
      },
      memory: (agentId, have) => peerMemory.bundle(agentId, have).then((bundle) => ({ agent_id: agentId, bundle })),
    },
    chatBlocked: (agentId, conversationId) => chatMoves.blocked(agentId, conversationId),
    // Deleting an agent while a paired Mac is out of reach would leave that Mac's chats with it behind (plan 023, KTD6).
    agentDeleteBlocked: () => {
      const away = peerStore.list((id) => links.reachable(id)).find((p) => !p.reachable);
      return away ? `${away.name} is out of reach: delete this agent once it is back, so its chats there go too` : null;
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
  const ensureServer = async (): Promise<LokiServer> => {
    if (srv) return srv;
    starting ??= startServer({
      port: modPort,
      token,
      profile: (agentId) => profilePath(agentId),
      uploads: paths.uploads,
      // Back from signing in to a remote MCP server (daemon/mcp/oauth.ts): only on this loopback server.
      routes: [oauthCallbackRoute(MCP_OAUTH_CALLBACK, (params) => host.chat.mcpOauthCallback(params))],
      health: () => ({ desks: store.scopes(), widgets: widgets.entries().length, tabs: ws?.clientCount() ?? 0 }),
    }).then((s) => {
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
    tailscale: new Tailscale({ port: lanPort }),
    stateFile: paths.lan,
    devices,
    codes,
    handlers: bridge,
    desktopToken: token,
    profile: (agentId) => profilePath(agentId),
    uploads: paths.uploads,
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
  /** What each conversation was last told about its assigned tasks: the block rides along only when it changes. */
  const tasksNotice = new TasksNotice();
  /** Helper agents' chats and the background passes' own get no desk, and the tab does not follow them. */
  const ignored = (e: ChatRef) => isSubagent(e.agentId) || passChat(e.chatId);

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

  // The person's message, about to be sent: two riders go with it — what they did on the canvas, and the task list's tasks
  // assigned to this conversation (only when those changed since the agent was last told).
  eventDisposers.push(
    api.message.transform((m) => {
      if (isSubagent(m.agentId)) return undefined;
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
      const blocks: string[] = [];
      if (lines.length) blocks.push(formatDeskContext(scope, lines, paths.widgets));
      const tasksBlock = tasksNotice.pending(m.chatId, tasks.cached());
      if (tasksBlock) blocks.push(tasksBlock);
      if (!blocks.length) return undefined;
      if (tasksBlock) tasksNotice.sent(m.chatId, tasksBlock);
      return attachDeskContext(m.content, blocks.join("\n\n"));
    }),
  );

  eventDisposers.push(api.events.on("compact_end", (e) => tasksNotice.forget(e.chatId)));

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
          const info = deskInfo(scope);
          if (info.title)
            broadcast(
              {
                type: "desk_title",
                scope,
                title: info.title,
                status: info.status,
                agent_name: info.agent_name,
                model: info.model,
                reasoning_effort: info.reasoning_effort,
                mode: info.mode ?? null,
              },
              scope === SHARED_SCOPE ? undefined : scope,
            );
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
    tasks: tasks.ready() ? tasks : undefined,
    folderFor,
  });

  // --- lifecycle -------------------------------------------------------
  const shutdown = (): void => {
    log("shutdown");
    ws?.close();
    void srv?.close();
    void lan.stop(); // the socket only; the setting stays so the listener returns with the mod
    links.stop(); // the links to other Macs reopen with the mod
    remoteChats.stop();
    peerMemory.stop();
    peerState.stop();
    ws = null;
    srv = null;
    starting = null;
    widgets.close();
    titleRefreshes.clear();
    clearInterval(tasksTimer);
    seen.flush(); // the marks' write is coalesced (mod/seen.ts): land the last one
  };
  api.signal.addEventListener("abort", shutdown, { once: true });

  return () => {
    stopUsage?.();
    if (usagePush) clearTimeout(usagePush);
    for (const d of eventDisposers) d();
    for (const d of toolDisposers) d();
    stopPersist();
    shutdown();
  };
}
