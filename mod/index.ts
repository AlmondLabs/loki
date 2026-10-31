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
import { RecallStore, isoDay } from "./recall.ts";
import { isPassChat, startLessonViaChats } from "./recall-worker.ts";
import { PassState } from "../daemon/passes-state.ts";
import { readPins, setPin } from "./pins.ts";
import { addRecentModel, readRecentModels } from "./models.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { reflectionState } from "./reflection.ts";
import { memoryDiff, memoryLog, memorySkills, memoryTree, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";
import { conversationDirName, scopeFor } from "../core/desk-core.ts";

import { frameModules, welcomeFrames, type ModuleDeps } from "./frames/index.ts";
import type { UsageDeps } from "./frames/usage.ts";
import { join } from "node:path";
import { attachWs, oauthCallbackRoute, startServer, tokenAuth, type LokiServer } from "./server.ts";
import { Sockets } from "./sockets.ts";
import { chatImageRoute } from "./chat-images.ts";
import { createBridge } from "./bridge.ts";
import { seenChatFrame } from "./frames/seen.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { DeviceStore } from "./devices.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import type { MemoryRepos } from "../daemon/memory-sync.ts";
import { PairingCodes } from "./pairing.ts";
import { LanListener } from "./lan.ts";
import { Tailscale } from "./tailscale.ts";
import { startPeering, type Peering } from "./peering.ts";
import { serialQueue } from "../core/serial.ts";
import { coalesce } from "../core/timers.ts";
import { Suggestions, chatCaller, withSuggestionsOnOpen, type SuggestionRecords } from "./suggestions.ts";
import { bdReader, moveTasks, tasksDir } from "./task-migration.ts";
import { registerTools } from "./tools.ts";
import { initLog, log } from "./log.ts";
import { appVersion, createAnalytics, type Analytics } from "./analytics.ts";
import { messageOf } from "../core/errors.ts";

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
   * The suggestions kept on this Mac's chat records (plan 049, KTD1): reading and writing a chat's list. Absent from a
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

  /** Both listeners, and who each push is for (mod/sockets.ts). */
  const sockets = new Sockets<LanListener>();
  const phones = (): LanListener => sockets.phones();
  /** The paired Macs (mod/peering.ts), told of every push here; built once the chats they read are. */
  let peering: Peering | null = null;
  // Every frame goes to the desktop's tabs and to paired phones alike.
  const broadcast = (msg: object, scope?: Scope) => {
    sockets.push(msg, { scope });
    peering?.pushed((msg as { type?: string }).type ?? "");
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
  // The folder a chat works in, from the daemon's folder index; the task move falls back to it (plan 049, U7).
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
      log("widget:trash-failed", { id, error: messageOf(err) });
      return null;
    }
  };
  // Paired phones and the codes that pair them (mod/devices.ts, mod/pairing.ts); the listener itself follows the bridge.
  const devices = new DeviceStore(paths.devices);
  const codes = new PairingCodes();
  /** Tailscale's view of this Mac and its tailnet, shared by the phone listener and Preferences › Macs. */
  const tailscale = new Tailscale({ port: Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT) });
  // Paired Macs (plan 023, mod/peering.ts): pairing, the links and syncers, and where each chat lives.
  const macs: Peering = startPeering({
    macId: host.macId,
    build: appVersion(paths.root),
    secrets: host.secrets,
    memory: host.memory,
    chats,
    chat: chatBackend,
    seen,
    desks,
    sockets,
    tailscale,
    broadcast,
    local: { desks: listLocalDesks, inbox: listLocalInbox },
    dirs: paths,
    moveTasks: () => moveOpenTasks(),
  });
  peering = macs;
  // Suggestions (plan 049): kept on the records of this Mac's chats and carried out here, sending to the Mac each
  // target lives on and waiting for its answer (mod/suggestions.ts).
  const suggestions = host.suggestions
    ? new Suggestions({
        records: host.suggestions,
        chat: (ref) => {
          const desk = macs.desks().find((d) => d.conversation_id === ref.conversation_id && (d.agent_id ?? ref.agent_id) === ref.agent_id);
          return desk ? { title: desk.title, status: desk.status, has_draft: desk.has_draft === true } : null;
        },
        agentExists: (id) => readLocalAgent(id) !== null,
        agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
        call: chatCaller({ route: macs.router, backend: chatBackend, blocked: (agentId, conversationId) => macs.chatBlocked(agentId, conversationId) }),
        push: (agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }),
        track: (event, properties) => analytics.capture("mod", event, properties),
      })
    : undefined;
  // Tasks retired into suggestions (plan 049, U7): each open task moves to the chat it was filed from once, at start and
  // again when a paired Mac comes into reach, since a chat that lives there moves only while its Mac answers. One run
  // at a time, so two runs never add the same task twice; start does not wait for it.
  const taskMoves = serialQueue();
  const moveOpenTasks = (): Promise<unknown> => {
    if (!suggestions) return Promise.resolve();
    const s = suggestions;
    return taskMoves(() =>
      moveTasks({
        run: bdReader(tasksDir()),
        stateFile: join(paths.state, "migrations.json"),
        route: macs.router,
        suggestions: s,
        folderOf: (c) =>
          macs.desks().find((d) => d.conversation_id === c.conversation_id && (d.agent_id ?? c.agent_id) === c.agent_id)?.cwd ??
          folderFor(c.agent_id, c.conversation_id),
        report: (message) => log("tasks:move", message),
      }),
    ).catch((err: unknown) => log("tasks:move-failed", messageOf(err)));
  };
  void moveOpenTasks();
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
  const usagePush = coalesce(() => broadcast({ type: "usage_changed" }), 2000);
  // An update due after a checkout's code changed (plans 024 and 041): every window offers it.
  const stopRestartDue = host.daemon?.onRestartDue((file) => sockets.push({ type: "restart_due", file }, { to: "desktop" }));
  const stopUsage = host.usage?.onChange(() => usagePush.schedule());

  const moduleDeps: ModuleDeps = {
    store,
    widgets,
    gestures,
    // Every list holds this Mac's chats and every paired Mac's, each of those marked with its Mac (plan 023, U4).
    listDesks: () => macs.desks(),
    listInbox: () => macs.inbox(),
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
    // A chat opens with the suggestions waiting in it (plan 049).
    chat: suggestions ? withSuggestionsOnOpen(chatBackend, suggestions) : chatBackend,
    suggestions,
    decidedBy: (c) => (c.deviceId ? "phone" : c.peerId ? macs.mac(c.peerId).name : "desktop"),
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
    peers: macs.frames,
    chatBlocked: (agentId, conversationId) => macs.chatBlocked(agentId, conversationId),
    titleFrame: (agentId, conversationId) => listing.titleFrame(scopeFor(conversationId, agentId)),
    // Deleting an agent while a Mac out of reach holds its chats would leave them there (KTD6, addendum D5).
    agentDeleteBlocked: (agentId) => macs.agentDeleteBlocked(agentId),
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
    route: macs.router,
  });
  /** A picture not here, from whichever paired Mac in reach holds it (plan 029): the chat it is in lives there. */
  const chatImageFromPeers = (name: string) => macs.chatImage(name);
  const serve = async (): Promise<LokiServer> => {
    const start = () =>
      startServer({
        port: modPort,
        token,
        profile: (agentId) => profilePath(agentId),
        uploads: paths.uploads,
        // Back from signing in to a remote MCP server (daemon/mcp/oauth.ts): only on this loopback server.
        routes: [
          oauthCallbackRoute(MCP_OAUTH_CALLBACK, (params) => host.chat.mcpOauthCallback(params)),
          chatImageRoute({ prefix: "/chat-images/", dir: paths.chatImages, authorize: tokenAuth(token), denied: 403, fetchRemote: chatImageFromPeers }),
        ],
        health: () => ({ desks: store.scopes(), widgets: widgets.entries().length, tabs: sockets.tabs() }),
      });
    try {
      const s = await sockets.serve(start, (started) => attachWs(started.server, token, bridge));
      log("server:listening", { port: s.port });
      return s;
    } catch (err) {
      log("server:failed", messageOf(err));
      api.diagnostics.report({
        message: `loki: server failed to start on ${modPort} (${messageOf(err)})`,
        severity: "error",
      });
      throw err;
    }
  };
  // The desk server is always up while the mod is: the loki app (or a browser tab) connects whenever it likes.
  void serve().catch((err: unknown) => log("server:error", messageOf(err)));

  // --- phones ----------------------------------------------------------
  // A second listener on the LAN, off by default; state/lan.json remembers the switch across /reload.
  // Tailscale, when installed, is the way off the Wi‑Fi (Addendum 3): the QR prefers the tailnet name or
  // the https front `tailscale serve` puts on this port; the CLI is only read, never installed.
  const lanPort = Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT);
  const lan: LanListener = new LanListener({
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
    peers: macs.peers,
    health: () => ({ phones: lan.clientCount() }),
    // The listener's status (addresses, the Tailscale name) and the paired devices are the desktop's settings: they
    // go to its tabs, not to the phones themselves, which never read them.
    onChange: (what, status) => {
      if (what === "status") {
        log("lan:status", status);
        sockets.push({ type: "lan_status", ...status }, { to: "desktop" });
      } else {
        sockets.push({ type: "devices", devices: devices.list() }, { to: "desktop" });
      }
    },
  });
  sockets.attachPhones(lan);
  if (lan.enabled()) void lan.start();
  macs.start();

  // --- events ----------------------------------------------------------
  const eventDisposers: Array<() => void> = [];
  const titleRefreshes = new ScopeDebouncer(1200);
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
      broadcast(seenChatFrame(seen, m.agentId, m.chatId));
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
      titleRefreshes.schedule(scope, () => {
        // A chat's title can come after its first turn; tell tabs when the title or status changes.
        const frame = listing.titleFrame(scope);
        if (frame) broadcast(frame, scope === SHARED_SCOPE ? undefined : scope);
      });
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
    // chat_list and the suggestion tools (plan 049, U3): every list's chats, and each agent with the Mac it lives on.
    chats: suggestions
      ? {
          suggestions,
          agents: async () =>
            (await chatBackend.agents()).map((a) => {
              const mac = macs.mac(a.home_mac || null);
              return { id: a.id, name: a.name, mac: mac.name, reachable: mac.reachable };
            }),
          chats: () => macs.desks(),
          passChat,
        }
      : undefined,
  });

  // --- lifecycle -------------------------------------------------------
  const shutdown = (): void => {
    log("shutdown");
    sockets.stop(); // the sockets only; the phone listener's setting stays so it returns with the mod
    macs.stop(); // the links to other Macs reopen with the mod
    widgets.close();
    titleRefreshes.clear();
    seen.flush(); // the marks' write is coalesced (mod/seen.ts): land the last one
  };
  api.signal.addEventListener("abort", shutdown, { once: true });

  return () => {
    stopUsage?.();
    stopRestartDue?.();
    usagePush.cancel();
    for (const d of eventDisposers) d();
    for (const d of toolDisposers) d();
    stopPersist();
    shutdown();
  };
}
