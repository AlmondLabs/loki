import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Scope } from "../shared/desk-core.ts";
import { SHARED_SCOPE, scopeFor } from "../shared/desk-core.ts";
import type { ConversationHandle, ConversationOpenEvent, EventContext, LettaMod, TurnStartEvent } from "./letta-types.ts";
import { DEFAULT_APP_PORT, DEFAULT_MOD_PORT, paths } from "./paths.ts";
import { DeskStore } from "./desk-store.ts";
import { loadDesks, persistDesks } from "./persist.ts";
import { watchWidgets } from "./widgets-fs.ts";
import { GestureLog, attachDeskContext, formatDeskContext } from "./gestures.ts";
import { createChatBridge, messagesToChatHistory } from "./chat.ts";
import { createLegacyChatTransport, type ChatTransport } from "./chat-transport.ts";
import { createAppServerChat } from "./chat-appserver.ts";
import { AppServerClient, discoverAppServer } from "./app-server.ts";
import { DeskRegistry, lookupLocalAgentName, lookupLocalConversation, readLocalTranscript } from "./desks.ts";
import { SeenStore } from "./seen.ts";
import type { DeskInfo, DeskSummary } from "./bridge.ts";
import { sortDesks } from "./bridge.ts";
import { join } from "node:path";
import { attachWs, startServer, type LociServer, type WsBridge } from "./server.ts";
import { createBridge, scopeOfId } from "./bridge.ts";
import { registerTools } from "./tools.ts";
import { ensureDevServer } from "./dev-server.ts";
import { initLog, log } from "./log.ts";

/**
 * loci — a memory palace your agent builds.
 *
 * The desk is a directory the agent writes into (app/src/widgets/<desk>/).
 * Vite compiles those files into the open tab. This mod is the part only a
 * mod can be: it owns geometry and gesture state, tells the agent what the
 * user did on the desk, and bridges canvas chat into the live conversation.
 *
 * Loaded straight from source (Node strips types): ~/.letta/mods/loci.ts is a
 * shim that dynamic-imports mod/mod.ts with a cache-busting query.
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
  if (!letta.capabilities?.commands) return;
  initLog(paths.modLog);
  log("activate", { pid: process.pid, node: process.versions.node, capabilities: letta.capabilities });

  const modPort = Number(process.env.LOCI_PORT ?? DEFAULT_MOD_PORT);
  const appPort = Number(process.env.LOCI_APP_PORT ?? DEFAULT_APP_PORT);
  const token = loadOrCreateToken();

  // --- state -----------------------------------------------------------
  const store = new DeskStore();
  loadDesks(store, paths.state);
  const stopPersist = persistDesks(store, paths.state);
  const gestures = new GestureLog();

  let activeConversation: ConversationHandle | null = null;
  let activeScope: Scope = SHARED_SCOPE;
  let mainBusy = false;

  let srv: LociServer | null = null;
  let ws: WsBridge | null = null;
  let starting: Promise<LociServer> | null = null;
  const broadcast = (msg: object, scope?: Scope) => ws?.broadcast(msg, scope);

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

  // --- chat -------------------------------------------------------------
  // Preferred: mirror the conversation live through Letta's app-server (streaming,
  // shared transcript, Letta-owned queue). Fallback: direct sends on the captured
  // conversation handle, replies as a block.
  const desks = new DeskRegistry(join(paths.state, "desks.json"));
  const legacyChat = createChatBridge({
    getConversation: () => activeConversation,
    isMainBusy: () => mainBusy,
  });
  const chatBroadcast = (frame: object, scope: Scope) => broadcast(frame, scope === SHARED_SCOPE ? undefined : scope);
  let transport: ChatTransport = createLegacyChatTransport(legacyChat, chatBroadcast);
  let appServer: AppServerClient | null = null;
  const seen = new SeenStore(join(paths.state, "attention.json"));
  let discovering: Promise<void> | null = null;
  const discover = (): Promise<void> => {
    if (appServer) return Promise.resolve();
    discovering ??= discoverAppServer({ exclude: [modPort], explicitUrl: process.env.LOCI_APP_SERVER_URL })
      .then((url) => {
        if (!url) {
          log("app-server:not-found", { mode: transport.mode });
          return;
        }
        appServer = new AppServerClient(url);
        transport = createAppServerChat({
          client: appServer,
          desks,
          broadcast: chatBroadcast,
          history: async (scope) => {
            // The desk's conversation so far. The local backend log has the whole
            // transcript (compaction-proof); the app-server list is the fallback
            // and only holds what is still in context.
            const rt = desks.get(scope);
            if (!rt || !appServer) return scope === activeScope ? legacyChat.history() : [];
            const local = readLocalTranscript(rt.conversation_id, rt.agent_id);
            if (local.length) return local;
            try {
              const res = await appServer.request("conversation_messages_list", {
                conversation_id: rt.conversation_id,
                agent_id: rt.agent_id,
                query: { limit: 200, order: "desc" },
              });
              const messages = (res.messages as Array<Record<string, unknown>> | undefined) ?? [];
              return messagesToChatHistory([...messages].reverse());
            } catch (err) {
              log("chat:history-error", { scope, error: err instanceof Error ? err.message : String(err) });
              return [];
            }
          },
          cwd: process.cwd(),
        });
        log("chat:mode", { mode: transport.mode, url });
        broadcast({ type: "config", appServer: true }); // tabs already open can start Catch Up now
      })
      .catch((err) => log("app-server:discovery-error", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        discovering = null;
      });
    return discovering;
  };
  void discover();
  const chat = legacyChat; // busy tracking + history for the legacy path

  // --- transport -------------------------------------------------------
  const deskInfo = (scope: Scope): DeskInfo & { lastActive: string | null } => {
    if (scope === SHARED_SCOPE) return { title: "shared", status: "none", agentName: null, agentId: null, lastActive: null };
    const rt = desks.get(scope);
    if (!rt) return { title: null, status: "none", agentName: null, agentId: null, lastActive: null };
    const agentName = lookupLocalAgentName(rt.agent_id);
    const info = lookupLocalConversation(rt.conversation_id, rt.agent_id);
    if (!info) return { title: null, status: "deleted", agentName, agentId: rt.agent_id, lastActive: null };
    return { title: info.title, status: info.archived ? "archived" : "live", agentName, agentId: rt.agent_id, lastActive: info.lastMessageAt };
  };
  const listDesks = (): DeskSummary[] => {
    const scopes = new Set<Scope>([SHARED_SCOPE, ...store.scopes(), ...desks.all().map((d) => d.scope)]);
    for (const e of widgets.entries()) scopes.add(e.scope);
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
          widgets: widgets.entries(scope).length,
          active: scope === activeScope,
          lastActive: info.lastActive,
        };
      }),
    );
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
  const bridge = createBridge({
    store,
    widgets,
    gestures,
    chat: () => transport,
    broadcast,
    listDesks,
    deskInfo,
    deleteWidgetFile,
    seen,
    appServerAvailable: () => appServer !== null,
    appServerUrl: () => appServer?.url ?? null,
  });
  const ensureServer = async (): Promise<LociServer> => {
    if (srv) return srv;
    starting ??= startServer({
      port: modPort,
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
        message: `loci: server failed to start on ${modPort} (${err instanceof Error ? err.message : String(err)})`,
        severity: "error",
      });
      throw err;
    }
  };
  void ensureServer().catch(() => {}); // eager: tabs reconnect across /reload

  // --- events ----------------------------------------------------------
  const eventDisposers: Array<(() => void) | void> = [];
  const track = (name: string, handler: (event: unknown, ctx: EventContext) => unknown) => {
    try {
      eventDisposers.push(letta.events?.on(name, handler));
    } catch {
      // events capability absent — /canvas still captures the conversation
    }
  };
  let historyTimer: ReturnType<typeof setTimeout> | null = null;

  track("conversation_open", (event, ctx) => {
    log("event:conversation_open", { id: (event as ConversationOpenEvent | undefined)?.conversationId ?? ctx?.conversation?.id ?? null });
    if (ctx?.conversation?.id) activeConversation = ctx.conversation;
    const id = (event as ConversationOpenEvent | undefined)?.conversationId ?? ctx?.conversation?.id ?? null;
    const next = scopeFor(id);
    if (next !== activeScope) {
      activeScope = next;
      broadcast({ type: "switch_desk", scope: activeScope }); // the tab follows the conversation
    }
  });

  track("turn_start", (event, ctx) => {
    mainBusy = true;
    chat.onMainBusy();
    if (ctx?.conversation?.id) activeConversation = ctx.conversation;
    const ev = event as TurnStartEvent | undefined;
    const convId = ev?.conversationId ?? ctx?.conversation?.id ?? null;
    const scope = convId ? desks.remember(convId, ev?.agentId ?? null) : SHARED_SCOPE;
    activeScope = scope;
    // The return path: everything the user did on this desk (and the shared desk) rides along.
    const lines = [...gestures.drain(scope), ...(scope !== SHARED_SCOPE ? gestures.drain(SHARED_SCOPE) : [])];
    log("event:turn_start", { desk: scope, attached: lines.length });
    if (convId) {
      seen.mark(ev?.agentId ?? null, convId); // you just spoke in this conversation
      broadcast({ type: "seen", seen: seen.all(), appServer: appServer !== null });
    }
    if (lines.length && ev && Array.isArray(ev.input)) {
      ev.input = attachDeskContext(ev.input, formatDeskContext(scope, lines, paths.widgets));
      return { input: ev.input };
    }
    return undefined;
  });

  // Diagnostics: see whether Letta reaches the mod-tool dispatch at all.
  track("tool_start", (event) => {
    const e = event as { toolName?: string; args?: unknown } | undefined;
    if (e?.toolName?.startsWith("desk_") || e?.toolName?.startsWith("loci_")) log("event:tool_start", { tool: e.toolName, args: e.args });
    return undefined;
  });
  track("tool_end", (event) => {
    const e = event as { toolName?: string; status?: string } | undefined;
    if (e?.toolName?.startsWith("desk_") || e?.toolName?.startsWith("loci_")) log("event:tool_end", { tool: e.toolName, status: e.status });
    return undefined;
  });

  track("turn_end", () => {
    mainBusy = false;
    chat.onMainIdle();
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      const scope = activeScope;
      // Letta names conversations lazily; tell tabs when the title or status changes.
      const info = deskInfo(scope);
      if (info.title) broadcast({ type: "desk_title", scope, title: info.title, status: info.status, agentName: info.agentName }, scope === SHARED_SCOPE ? undefined : scope);
      void chat
        .history()
        .then((messages) => {
          if (messages.length) broadcast({ type: "chat_history", messages }, scope === SHARED_SCOPE ? undefined : scope);
        })
        .catch(() => {});
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
  });

  // --- /canvas ---------------------------------------------------------
  const disposeCommand = letta.commands.register({
    id: "canvas",
    description: "Open the loci canvas — this conversation's widget desk",
    async run(ctx) {
      if (ctx?.conversation?.id) {
        activeConversation = ctx.conversation;
        activeScope = desks.remember(ctx.conversation.id, ctx.agent?.id ?? null);
      }
      log("command:canvas", { desk: activeScope, chat: transport.mode });
      await ensureServer();
      await discover();
      await widgets.rescan();
      const dev = await ensureDevServer({
        port: appPort,
        modPort,
        viteBin: paths.viteBin,
        viteConfig: paths.viteConfig,
        cwd: paths.root,
        logPath: paths.viteLog,
        widgetsDir: paths.widgets,
      });
      const url = `${dev.url}/?t=${token}&desk=${activeScope}`;
      if (process.platform === "darwin" && !process.env.LOCI_NO_OPEN) {
        spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      }
      return {
        type: "output",
        output: `loci canvas: ${url}${dev.adopted ? "" : "  (started vite)"}\nwidgets: ${paths.widgets}/${activeScope}/`,
      };
    },
  });

  // --- lifecycle -------------------------------------------------------
  const shutdown = (): void => {
    log("shutdown");
    appServer?.close();
    ws?.close();
    void srv?.close();
    ws = null;
    srv = null;
    starting = null;
    widgets.close();
    if (historyTimer) clearTimeout(historyTimer);
  };
  letta.signal?.addEventListener("abort", shutdown, { once: true });

  return () => {
    disposeCommand?.();
    for (const d of eventDisposers) d?.();
    for (const d of toolDisposers) d?.();
    stopPersist();
    shutdown();
  };
}
