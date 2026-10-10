import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Scope, WidgetChange } from "../core/desk-core.ts";
import { SHARED_SCOPE } from "../core/desk-core.ts";
import type { ChatRef, ModApi } from "../daemon/mods/api.ts";
import { ScopeDebouncer } from "./lifecycle-events.ts";
import { DEFAULT_LAN_PORT, DEFAULT_MOD_PORT, paths } from "./paths.ts";
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
import { RecallStore, clampTickMinutes, DEFAULT_TICK_MINUTES } from "./recall.ts";
import { RecallWorker, askViaChats, startLessonViaChats } from "./recall-worker.ts";
import { isLearnTitle } from "../core/recall/model.ts";
import { TaskBoard, TasksNotice } from "./tasks.ts";
import { readPins, setPin } from "./pins.ts";
import { addRecentModel, readRecentModels } from "./models.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { reflectionState } from "./reflection.ts";
import { isSubagent, memoryDiff, memoryLog, memorySkills, memoryTree, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";
import { conversationDirName, scopeFor } from "../core/desk-core.ts";

import { sortDesks } from "./frames/desks.ts";
import { frameModules, welcomeFrames, type ModuleDeps } from "./frames/index.ts";
import { join } from "node:path";
import { attachWs, startServer, type LokiServer, type WsBridge } from "./server.ts";
import { wsSource } from "./ws.ts";
import { createBridge } from "./bridge.ts";
import { seenFrame } from "./frames/seen.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { DeviceStore } from "./devices.ts";
import { PairingCodes } from "./pairing.ts";
import { LanListener } from "./lan.ts";
import { Tailscale } from "./tailscale.ts";
import { registerTools } from "./tools.ts";
import { initLog, log } from "./log.ts";
import { appVersion, createAnalytics } from "./analytics.ts";
import { reasoningEffortFromSettings } from "../core/models.ts";
import type { DeskInfo, DeskSummary, InboxRow } from "../core/frame-types.ts";

/**
 * loki — a memory palace your agent builds.
 *
 * The desk is a directory the agent writes into (<widgets>/<desk>/), compiled into the open tab. This mod is loki's
 * own, hosted by loki's daemon (daemon/main.ts) through the mod API (daemon/mods/api.ts): it owns geometry and gesture
 * state, serves the app and the phone over its sockets, tells the agent what the person did on the canvas, and gives
 * the agent its canvas and board tools. The daemon hands it the chats (`chats`, read; `chat`, run).
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

/** What the daemon hosts the mod with besides the mod API: its chats, to read and to run. */
export type Host = { chats: ChatSource; chat: ChatBackend };

export default function activate(api: ModApi, host: Host): () => void {
  initLog(paths.modLog);
  // Product analytics, local only (core/analytics.ts; `bun run analytics` reads it). LOKI_ANALYTICS=0 turns it off.
  const analytics = createAnalytics({ path: process.env.LOKI_ANALYTICS === "0" ? null : paths.events, statePath: paths.analytics, appVersion: appVersion(paths.root) });
  log("activate", { pid: process.pid, node: process.versions.node, ws: wsSource, api: api.apiVersion });

  const modPort = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT);
  const token = loadOrCreateToken();

  // --- state -----------------------------------------------------------
  const store = new DeskStore();
  loadDesks(store, paths.state);
  const stopPersist = persistDesks(store, paths.state);
  const gestures = new GestureLog();

  let activeScope: Scope = SHARED_SCOPE;

  let srv: LokiServer | null = null;
  let ws: WsBridge | null = null;
  let starting: Promise<LokiServer> | null = null;
  let lan: LanListener | null = null; // the phone listener, built after the bridge (it serves the same handlers)
  // Every frame goes to the desktop's tabs and to paired phones alike.
  const broadcast = (msg: object, scope?: Scope) => {
    ws?.broadcast(msg, scope);
    lan?.broadcast(msg, scope);
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
    const scopes = new Set<Scope>([
      ...diff.added.map((e) => e.scope),
      ...diff.changed.map((e) => e.scope),
      ...diff.removed.map(scopeOfId),
    ]);
    for (const scope of scopes) {
      broadcast({ type: "widgets", scope, widgets: widgets.entries(scope) }, scope === SHARED_SCOPE ? undefined : scope);
    }
    const landed = diff.added[diff.added.length - 1];
    if (landed && !landed.error) {
      broadcast({ type: "camera", widgetId: landed.id }, landed.scope === SHARED_SCOPE ? undefined : landed.scope);
    }
    broadcastWidgetChanges(widgetLog, diff, broadcast);
  });

  // --- chats -------------------------------------------------------------
  // Read from the daemon's stores (`chats`), and run by it (`chat`: sending, streaming, models, agents) through the
  // mod's frames; what happens in a chat goes to every client.
  const { chats, chat: chatBackend } = host;
  chatBackend.attach((agentId, conversationId, events) => broadcast({ type: "chat_event", agentId, conversationId, events }));
  const desks = new DeskRegistry(join(paths.state, "desks.json"), (id) => chats.agentOf(id));
  const seen = new SeenStore(join(paths.state, "attention.json"));
  // The board (beads). Reads are cached so turn_start can attach assigned tasks without waiting on bd.
  const tasks = new TaskBoard();
  const folderFor = (agentId: string | null, conversationId: string | null): string | null => (conversationId ? chats.folders().byConversation[conversationDirName(conversationId, agentId)] ?? null : null);
  const refreshTasks = () => {
    if (!tasks.ready()) return;
    void tasks.list().catch((err) => log("tasks:list-error", err instanceof Error ? err.message : String(err)));
  };
  refreshTasks();
  const tasksTimer = setInterval(refreshTasks, 60_000);
  log("tasks:board", { dir: tasks.dir, ready: tasks.ready() });

  // --- transport -------------------------------------------------------
  const deskInfo = (scope: Scope): DeskInfo & { lastActive: string | null } => {
    if (scope === SHARED_SCOPE) return { title: "shared", status: "none", agentName: null, agentId: null, model: null, reasoningEffort: null, lastActive: null };
    const rt = desks.get(scope);
    if (!rt) return { title: null, status: "none", agentName: null, agentId: null, model: null, reasoningEffort: null, lastActive: null };
    const agentName = lookupLocalAgentName(rt.agent_id);
    const agent = readLocalAgent(rt.agent_id);
    const agentModel = agent?.model ?? null;
    const agentEffort = reasoningEffortFromSettings(agent?.modelSettings);
    const info = chats.info(rt.conversation_id, rt.agent_id);
    const mode = info?.mode ?? "unrestricted";
    if (!info) return { title: null, status: "deleted", agentName, agentId: rt.agent_id, model: agentModel, reasoningEffort: agentEffort, mode, lastActive: null };
    return { title: info.title, status: info.archived ? "archived" : "live", agentName, agentId: rt.agent_id, model: info.model ?? agentModel, reasoningEffort: info.model ? info.reasoningEffort : info.reasoningEffort ?? agentEffort, mode, lastActive: info.lastMessageAt };
  };
  const listDesks = (): DeskSummary[] => {
    // A subagent's turn may have registered a desk before we knew what it was: evict it, once, here.
    for (const agentId of new Set(desks.all().map((d) => d.agent_id))) if (isSubagent(agentId) && desks.forgetAgent(agentId)) log("desks:evict-subagent", { agentId });
    const scopes = new Set<Scope>([SHARED_SCOPE, ...store.scopes(), ...desks.all().map((d) => d.scope)]);
    for (const e of widgets.entries()) scopes.add(e.scope);
    const pins = readPins();
    // Every conversation of the user's own agents, seen by loki or not (subagents' one-off chats stay out).
    const ownAgents = new Set(desks.all().map((d) => d.agent_id));
    for (const c of chats.list()) {
      // A deleted agent leaves its memory repo behind: its record must still exist too. Hidden conversations stay
      // out, except the recall worker's: those are desks you can open to read what it asked and what the agent said.
      if ((c.hidden && !recall.owns(c.conversationId)) || !(ownAgents.has(c.agentId) || (agentHasMemory(c.agentId) && readLocalAgent(c.agentId)))) continue;
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
          agentName: info.agentName,
          agentId: info.agentId,
          conversationId: desks.get(scope)?.conversation_id ?? null,
          pinned: pins.has(`${desks.get(scope)?.agent_id ?? ""}/${desks.get(scope)?.conversation_id ?? ""}`),
          model: info.model,
          reasoningEffort: info.reasoningEffort,
          mode: info.mode ?? null,
          widgets: widgets.entries(scope).length,
          active: scope === activeScope,
          lastActive: info.lastActive,
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
  const listInbox = (): InboxRow[] => {
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
      out.push({ id: c.conversationId, agentId: c.agentId, agentName: names.get(c.agentId) ?? null, title: info?.title ?? null, lastMessageAt: c.lastMessageAt, archived: false, ...chats.digest(c.conversationId, c.agentId) });
    }
    return out.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  };
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
  // Where each memory skill came from, and the refresh that pulls upstream and reconciles (mod/skill-sources.ts).
  const skillSources = new SkillSources({ sourcesFile: join(paths.state, "skill-sources.json"), stagingDir: join(paths.state, "upstream") });
  // --- recall -----------------------------------------------------------
  // Cards written in the background from conversations that have gone quiet, asked of the agent through the
  // harness in a hidden conversation of its own; the person meets them only in the Recall section (mod/recall-worker.ts).
  const recallStore = new RecallStore();
  const recall = new RecallWorker({ store: recallStore, listInbox, readSince: (c, a, from) => chats.since(c, a, from), ask: askViaChats(chatBackend) });
  const recallTick = () => void recall.tick().then((r) => log("recall:tick", r)).catch((err) => log("recall:tick-error", err instanceof Error ? err.message : String(err)));
  const recallFirst = setTimeout(recallTick, 90_000); // once the daemon has settled
  // The sweep timer: every `tickMinutes` (Settings › learn; ten by default), reset when the setting changes.
  let recallTimer: ReturnType<typeof setInterval> | null = null;
  const scheduleRecall = (minutes: number) => {
    if (recallTimer) clearInterval(recallTimer);
    recallTimer = setInterval(recallTick, clampTickMinutes(minutes) * 60_000);
    log("recall:schedule", { minutes: clampTickMinutes(minutes) });
  };
  scheduleRecall(recallStore.worker().tickMinutes ?? DEFAULT_TICK_MINUTES);
  // A lesson's chat is made by the daemon, in process.
  const lessons = { store: recallStore, widgetsDir: paths.widgets, expect: (id: string, change: WidgetChange) => widgetLog.expect(id, change, "loki") };

  const moduleDeps: ModuleDeps = {
    store,
    widgets,
    gestures,
    listDesks,
    listInbox,
    recall: {
      store: recallStore,
      run: () => recall.tick(),
      reschedule: scheduleRecall,
      startLesson: startLessonViaChats(chatBackend, lessons),
      lessonEmpty: (l) => chats.info(l.conversationId, l.agentId)?.lastMessageAt == null,
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
    lan: {
      status: () => lan!.status(),
      refresh: () => lan!.refresh(),
      setEnabled: (enabled) => lan!.setEnabled(enabled),
      setVia: (via) => lan!.setVia(via),
      setServe: (enabled) => lan!.setServe(enabled),
      pairBegin: () => {
        const { code, expiresAt } = codes.mint();
        log("lan:pair-code", { expiresAt });
        return { code, url: lan!.pairUrl(code), expiresAt };
      },
      devices: () => devices.list(),
      forget: (id) => lan!.forget(id),
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
      reflection: (id) => reflectionState(id, (c) => chats.info(c, id)?.title ?? null),
      globalSkills: () => listGlobalSkills().map((g) => ({ ...g, source: skillSources.describeGlobal(g) })),
      install: (id, source, force) => installSkill(source, id, { force }),
    },
  };
  const bridge = createBridge({
    modules: frameModules(moduleDeps),
    welcome: welcomeFrames(moduleDeps),
    broadcast,
    capture: (client, event, properties) => analytics.capture(client.deviceId ? "phone" : "mac", event, properties),
  });
  const ensureServer = async (): Promise<LokiServer> => {
    if (srv) return srv;
    starting ??= startServer({
      port: modPort,
      token,
      profile: (agentId) => profilePath(agentId),
      uploads: paths.uploads,
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
  void ensureServer().catch((err) => log("server:error", err instanceof Error ? err.message : String(err)));

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
    health: () => ({ phones: lan?.clientCount() ?? 0 }),
    onChange: (what, status) => {
      if (what === "status") {
        log("lan:status", status);
        broadcast({ type: "lan_status", ...status });
      } else {
        broadcast({ type: "devices", devices: devices.list() });
      }
    },
  });
  if (lan.enabled()) void lan.start();

  // --- events ----------------------------------------------------------
  const eventDisposers: Array<() => void> = [];
  const titleRefreshes = new ScopeDebouncer();
  /** When each desk's running turn began, for turn_finished's duration. */
  const turnsBegun = new Map<string, number>();
  /** What each conversation was last told about its board tasks: the block rides along only when it changes. */
  const tasksNotice = new TasksNotice();
  /** Helper agents' chats and the recall worker's own get no desk, and the tab does not follow them. */
  const ignored = (e: ChatRef) => isSubagent(e.agentId) || recall.owns(e.chatId);

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

  // The person's message, about to be sent: two riders go with it — what they did on the canvas, and the board's tasks
  // assigned to this conversation (only when those changed since the agent was last told).
  eventDisposers.push(
    api.message.transform((m) => {
      if (isSubagent(m.agentId)) return undefined;
      // The recall worker's conversation is a desk you can open, but its turns are the worker's: nothing rides along,
      // the tab does not follow it, and it is never marked seen.
      if (recall.owns(m.chatId)) {
        desks.remember(m.chatId, m.agentId);
        return undefined;
      }
      const scope = desks.remember(m.chatId, m.agentId);
      activeScope = scope;
      analytics.capture("mod", "turn_started", { desk: scope });
      turnsBegun.set(scope, Date.now());
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
      const scope = desks.remember(e.chatId, e.agentId);
      // The turn's end, for how long you take to come back to it (the report's time to respond).
      const begun = turnsBegun.get(scope);
      turnsBegun.delete(scope);
      analytics.capture("mod", "turn_finished", { desk: scope, duration_ms: begun === undefined ? null : Date.now() - begun });
      titleRefreshes.schedule(scope, () => {
        // A chat's title can come after its first turn; tell tabs when the title or status changes.
        const info = deskInfo(scope);
        if (info.title) broadcast({ type: "desk_title", scope, title: info.title, status: info.status, agentName: info.agentName, model: info.model, reasoningEffort: info.reasoningEffort, mode: info.mode ?? null }, scope === SHARED_SCOPE ? undefined : scope);
      }, 1200);
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
    void lan?.stop(); // the socket only; the setting stays so the listener returns with the mod
    ws = null;
    srv = null;
    starting = null;
    widgets.close();
    titleRefreshes.clear();
    clearInterval(tasksTimer);
    clearTimeout(recallFirst);
    if (recallTimer) clearInterval(recallTimer);
    seen.flush(); // the marks' write is coalesced (mod/seen.ts): land the last one
  };
  api.signal.addEventListener("abort", shutdown, { once: true });

  return () => {
    for (const d of eventDisposers) d();
    for (const d of toolDisposers) d();
    stopPersist();
    shutdown();
  };
}
