import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Scope } from "../packages/core/src/desk-core.ts";
import { SHARED_SCOPE, scopeFor } from "../packages/core/src/desk-core.ts";
import type { ConversationOpenEvent, EventContext, LettaMod, TurnStartEvent } from "./letta-types.ts";
import { DEFAULT_LAN_PORT, DEFAULT_MOD_PORT, paths } from "./paths.ts";
import { DeskStore } from "./desk-store.ts";
import { loadDesks, persistDesks } from "./persist.ts";
import { watchWidgets } from "./widgets-fs.ts";
import { GestureLog, attachDeskContext, formatDeskContext } from "./gestures.ts";
import { discoverAppServer } from "./app-server.ts";
import { checkFolder, completeFolder, pickFolder, recentFolders } from "./folders.ts";
import { DeskRegistry, agentHasMemory, digestLocalConversation, listLocalConversations, lookupLocalAgentName, lookupLocalConversation, readLocalTranscript, type InboxRow } from "./desks.ts";
import { SeenStore } from "./seen.ts";
import { RecallStore } from "./recall.ts";
import { QUIET_MS, RecallWorker, askViaAppServer } from "./recall-worker.ts";
import { TaskBoard, formatTasksContext } from "./tasks.ts";
import { readPins, setPin } from "./pins.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { isSubagent, memoryDiff, memoryLog, memorySkills, memoryTree, permissionModeOf, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";
import { conversationDirName } from "../packages/core/src/desk-core.ts";
import type { DeskInfo, DeskSummary } from "./bridge.ts";
import { sortDesks } from "./bridge.ts";
import { join } from "node:path";
import { attachWs, startServer, type LokiServer, type WsBridge } from "./server.ts";
import { createBridge, scopeOfId } from "./bridge.ts";
import { DeviceStore } from "./devices.ts";
import { PairingCodes } from "./pairing.ts";
import { LanListener } from "./lan.ts";
import { Tailscale } from "./tailscale.ts";
import { registerTools } from "./tools.ts";
import { initLog, log } from "./log.ts";

/**
 * loki — a memory palace your agent builds.
 *
 * The desk is a directory the agent writes into (app/src/widgets/<desk>/).
 * Vite compiles those files into the open tab. This mod is the part only a
 * mod can be: it owns geometry and gesture state, tells the agent what the
 * user did on the desk, and tunnels the browser to Letta's app-server.
 *
 * Loaded straight from source (Node strips types): ~/.letta/mods/loki.ts is a
 * shim that dynamic-imports mod/index.ts with a cache-busting query.
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

export default function activate(letta: LettaMod): (() => void) | void {
  if (!letta.capabilities?.tools && !letta.capabilities?.events) return; // nothing a desk needs
  initLog(paths.modLog);
  log("activate", { pid: process.pid, node: process.versions.node, capabilities: letta.capabilities });

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
  });

  // --- app-server ---------------------------------------------------------
  // Conversations live in the browser (app/src/attention), which reaches Letta's
  // app-server through this mod's tunnel. The mod only has to find the server.
  const desks = new DeskRegistry(join(paths.state, "desks.json"));
  let appServerUrl: string | null = null;
  const seen = new SeenStore(join(paths.state, "attention.json"));
  // The board (beads). Reads are cached so turn_start can attach assigned tasks without waiting on bd.
  const tasks = new TaskBoard();
  const folderFor = (agentId: string | null, conversationId: string | null): string | null => (conversationId ? recentFolders().byConversation[conversationDirName(conversationId, agentId)] ?? null : null);
  const refreshTasks = () => {
    if (!tasks.ready()) return;
    void tasks.list().catch((err) => log("tasks:list-error", err instanceof Error ? err.message : String(err)));
  };
  refreshTasks();
  const tasksTimer = setInterval(refreshTasks, 60_000);
  log("tasks:board", { dir: tasks.dir, ready: tasks.ready() });
  let discovering: Promise<void> | null = null;
  const discover = (): Promise<void> => {
    if (appServerUrl) return Promise.resolve();
    discovering ??= discoverAppServer({ exclude: [modPort], explicitUrl: process.env.LOKI_APP_SERVER_URL })
      .then((url) => {
        if (!url) {
          log("app-server:not-found");
          return;
        }
        appServerUrl = url;
        log("app-server:found", { url });
        broadcast({ type: "config", appServer: true }); // tabs already open can connect now
      })
      .catch((err) => log("app-server:discovery-error", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        discovering = null;
      });
    return discovering;
  };
  void discover();

  // --- transport -------------------------------------------------------
  const deskInfo = (scope: Scope): DeskInfo & { lastActive: string | null } => {
    if (scope === SHARED_SCOPE) return { title: "shared", status: "none", agentName: null, agentId: null, model: null, lastActive: null };
    const rt = desks.get(scope);
    if (!rt) return { title: null, status: "none", agentName: null, agentId: null, model: null, lastActive: null };
    const agentName = lookupLocalAgentName(rt.agent_id);
    const agentModel = readLocalAgent(rt.agent_id)?.model ?? null;
    const info = lookupLocalConversation(rt.conversation_id, rt.agent_id);
    const mode = permissionModeOf(rt.agent_id, rt.conversation_id);
    if (!info) return { title: null, status: "deleted", agentName, agentId: rt.agent_id, model: agentModel, mode, lastActive: null };
    return { title: info.title, status: info.archived ? "archived" : "live", agentName, agentId: rt.agent_id, model: info.model ?? agentModel, mode, lastActive: info.lastMessageAt };
  };
  const listDesks = (): DeskSummary[] => {
    // A subagent's turn may have registered a desk before we knew what it was: evict it, once, here.
    for (const agentId of new Set(desks.all().map((d) => d.agent_id))) if (isSubagent(agentId) && desks.forgetAgent(agentId)) log("desks:evict-subagent", { agentId });
    const scopes = new Set<Scope>([SHARED_SCOPE, ...store.scopes(), ...desks.all().map((d) => d.scope)]);
    for (const e of widgets.entries()) scopes.add(e.scope);
    const pins = readPins();
    // Every conversation of the user's own agents, seen by loki or not (subagents' one-off chats stay out).
    const ownAgents = new Set(desks.all().map((d) => d.agent_id));
    for (const c of listLocalConversations()) {
      // A deleted agent leaves its memory repo behind: its record must still exist too. Hidden conversations stay
      // out, except the recall worker's: those are desks you can open to read what it asked and what the agent said.
      if ((c.hidden && !recall.owns(c.conversationId)) || !(ownAgents.has(c.agentId) || (agentHasMemory(c.agentId) && readLocalAgent(c.agentId)))) continue;
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
          mode: info.mode ?? null,
          widgets: widgets.entries(scope).length,
          active: scope === activeScope,
          lastActive: info.lastActive,
        };
      }),
    );
  };
  /**
   * The inbox's list, straight from disk: every open conversation of the user's own agents, main
   * chats included, however old — a conversation leaves the inbox by being archived, not by going
   * quiet. Hidden conversations (the app-server's one-off side threads) stay out, as in the tree.
   */
  const listInbox = (): InboxRow[] => {
    const ownAgents = new Set(desks.all().map((d) => d.agent_id));
    const names = new Map<string, string | null>();
    const out: InboxRow[] = [];
    for (const c of listLocalConversations()) {
      if (c.hidden || c.archived) continue;
      if (!(ownAgents.has(c.agentId) || (agentHasMemory(c.agentId) && readLocalAgent(c.agentId)))) continue;
      if (isSubagent(c.agentId)) continue;
      if (!names.has(c.agentId)) names.set(c.agentId, lookupLocalAgentName(c.agentId));
      const info = lookupLocalConversation(c.conversationId, c.agentId);
      out.push({ id: c.conversationId, agentId: c.agentId, agentName: names.get(c.agentId) ?? null, title: info?.title ?? null, lastMessageAt: c.lastMessageAt, archived: false, ...digestLocalConversation(c.conversationId, c.agentId) });
    }
    return out.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  };
  const deleteWidgetFile = (id: string): string | null => {
    const entry = widgets.get(id);
    if (!entry) return null;
    const abs = join(paths.widgets, entry.file);
    try {
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
  const recall = new RecallWorker({ store: recallStore, listInbox, ask: askViaAppServer({ url: () => appServerUrl, store: recallStore }) });
  const recallTick = () => void recall.tick().then((r) => log("recall:tick", r)).catch((err) => log("recall:tick-error", err instanceof Error ? err.message : String(err)));
  const recallFirst = setTimeout(recallTick, 90_000); // once the harness and the app-server link have settled
  const recallTimer = setInterval(recallTick, QUIET_MS);

  const bridge = createBridge({
    store,
    widgets,
    gestures,
    broadcast,
    listDesks,
    listInbox,
    recall: { store: recallStore, run: () => recall.tick() },
    deskInfo,
    deleteWidgetFile,
    seen,
    appServerAvailable: () => appServerUrl !== null,
    appServerUrl: () => appServerUrl,
    transcript: (agentId, conversationId) => readLocalTranscript(conversationId, agentId, 400),
    folders: { recent: () => recentFolders(), complete: completeFolder, check: checkFolder, pick: pickFolder },
    setPin: (agentId, conversationId, pinned) => setPin(agentId, conversationId, pinned),
    tasks: tasks.ready() ? tasks : undefined,
    folderFor,
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
      globalSkills: () => listGlobalSkills().map((g) => ({ ...g, source: skillSources.describeGlobal(g) })),
      install: (id, source, force) => installSkill(source, id, { force }),
    },
  });
  const ensureServer = async (): Promise<LokiServer> => {
    if (srv) return srv;
    starting ??= startServer({
      port: modPort,
      token,
      profile: (agentId) => profilePath(agentId),
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
      letta.diagnostics?.report({
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
  const eventDisposers: Array<(() => void) | void> = [];
  const track = (name: string, handler: (event: unknown, ctx: EventContext) => unknown) => {
    try {
      eventDisposers.push(letta.events?.on(name, handler));
    } catch {
      // events capability absent — the mod still serves desks and tools
    }
  };
  let titleTimer: ReturnType<typeof setTimeout> | null = null;

  track("conversation_open", (event, ctx) => {
    log("event:conversation_open", { id: (event as ConversationOpenEvent | undefined)?.conversationId ?? ctx?.conversation?.id ?? null });
    const id = (event as ConversationOpenEvent | undefined)?.conversationId ?? ctx?.conversation?.id ?? null;
    if (id && recall.owns(id)) return; // the recall worker's own conversation: no desk follows it
    const next = scopeFor(id);
    if (next !== activeScope) {
      activeScope = next;
      broadcast({ type: "switch_desk", scope: activeScope }); // the tab follows the conversation
    }
  });

  track("turn_start", (event, ctx) => {
    const ev = event as TurnStartEvent | undefined;
    const convId = ev?.conversationId ?? ctx?.conversation?.id ?? null;
    // Letta's own helper agents get no desk: their turn still runs, it just is not furnished or listed.
    if (ev?.agentId && isSubagent(ev.agentId)) return;
    // The recall worker's conversation is a desk you can open, but its turns are the worker's: no context rides
    // along, the tab does not follow it, and it is never marked seen.
    if (convId && recall.owns(convId)) {
      desks.remember(convId, ev?.agentId ?? null);
      return;
    }
    const scope = convId ? desks.remember(convId, ev?.agentId ?? null) : SHARED_SCOPE;
    activeScope = scope;
    // The return path: everything the user did on this desk (and the shared desk) rides along.
    const lines = [...gestures.drain(scope), ...(scope !== SHARED_SCOPE ? gestures.drain(SHARED_SCOPE) : [])];
    log("event:turn_start", { desk: scope, attached: lines.length });
    if (convId) {
      seen.mark(ev?.agentId ?? null, convId); // you just spoke in this conversation
      broadcast({ type: "seen", seen: seen.all(), snooze: seen.snoozes(), appServer: appServerUrl !== null });
    }
    // Two riders on the user's message: what they did on the desk, and the board's tasks assigned to this conversation.
    const blocks: string[] = [];
    if (lines.length) blocks.push(formatDeskContext(scope, lines, paths.widgets));
    const tasksBlock = convId ? formatTasksContext(tasks.cached(), { conversation: convId }) : null;
    if (tasksBlock) blocks.push(tasksBlock);
    if (blocks.length && ev && Array.isArray(ev.input)) {
      ev.input = attachDeskContext(ev.input, blocks.join("\n\n"));
      return { input: ev.input };
    }
    return undefined;
  });

  // Diagnostics: see whether Letta reaches the mod-tool dispatch at all.
  track("tool_start", (event) => {
    const e = event as { toolName?: string; args?: unknown } | undefined;
    if (e?.toolName?.startsWith("desk_") || e?.toolName?.startsWith("loki_")) log("event:tool_start", { tool: e.toolName, args: e.args });
    return undefined;
  });
  track("tool_end", (event) => {
    const e = event as { toolName?: string; status?: string } | undefined;
    if (e?.toolName?.startsWith("desk_") || e?.toolName?.startsWith("loki_")) log("event:tool_end", { tool: e.toolName, status: e.status });
    return undefined;
  });

  track("turn_end", () => {
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      const scope = activeScope;
      // Letta names conversations lazily; tell tabs when the title or status changes.
      const info = deskInfo(scope);
      if (info.title) broadcast({ type: "desk_title", scope, title: info.title, status: info.status, agentName: info.agentName, model: info.model, mode: info.mode ?? null }, scope === SHARED_SCOPE ? undefined : scope);
    }, 1200);
  });

  // --- tools -----------------------------------------------------------
  const toolDisposers = registerTools(letta, {
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
    if (titleTimer) clearTimeout(titleTimer);
    clearInterval(tasksTimer);
    clearTimeout(recallFirst);
    clearInterval(recallTimer);
  };
  letta.signal?.addEventListener("abort", shutdown, { once: true });

  return () => {
    for (const d of eventDisposers) d?.();
    for (const d of toolDisposers) d?.();
    stopPersist();
    shutdown();
  };
}
