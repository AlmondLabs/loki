import { useCallback, useEffect, useRef, useState } from "react";
import { LAYER } from "../kit/layers";
import { scopeFor } from "../../../packages/core/src/desk-core.ts";
import { useAttention } from "../../../packages/core/src/attention/useAttention.ts";
import { makeTransport } from "../attention/transport";
import { catchUpQueue } from "../../../packages/core/src/attention/queue.ts";
import { CatchUp } from "../desk/CatchUp";
import { NewDesk } from "../desk/NewDesk";
import { Surface } from "../desk/Surface";
import { useDesk } from "../desk/useDesk";
import { inTauri } from "../desk/env";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import { DeskTree } from "./DeskTree";
import { Board } from "../board/Board";
import { Agents } from "../agents/Agents";
import { avatarUrl } from "../desk/env";
import { TaskCapture } from "../board/TaskCapture";
import { dispatchMessage, type Task } from "../board/model";
import type { DeskSummary } from "../desk/useDesk";
import { Settings } from "./Settings";
import { Welcome } from "./Welcome";
import { useBootstrap } from "./bootstrap";
import { welcomeStep } from "../settings/provider-model";
import { Sidebar, SIDEBAR_WIDTH } from "./Sidebar";
import { typingIn, type Segment } from "./shortcuts";
import { menuSpec, registerActions, resolve, runAction } from "./keymap";

const SEGMENT_KEY = "loki.segment";
const CHAT_WIDTH_KEY = "loki.chatWidth";
const CHAT_PLACEMENT_KEY = "loki.chatPlacement";

/**
 * The window: the native title bar, a rail of four segments, and one view
 * in the space they leave. The desk and attention models live here so the desk view, the
 * inbox, the tree and settings all read the same state.
 */
export function Shell() {
  const desk = useDesk();
  const { attention } = desk;
  const catchUp = useAttention({
    enabled: attention.available,
    tunnelUrl: attention.tunnelUrl,
    makeTransport,
    seen: attention.seen,
    snooze: attention.snooze,
    markSeen: attention.markSeen,
    unmarkSeen: attention.unmarkSeen,
    setSnooze: attention.setSnooze,
    clearSnooze: attention.clearSnooze,
    loadLocalHistory: attention.loadHistory,
  });

  // The segment survives a reload of the same window; a refresh mid-pass reopens the inbox.
  const [segment, setSegmentRaw] = useState<Segment>(() => {
    const s = sessionStorage.getItem(SEGMENT_KEY);
    return s === "inbox" || s === "settings" || s === "board" || s === "agents" ? s : "desk";
  });
  const setSegment = useCallback((s: Segment) => {
    setSegmentRaw(s);
    sessionStorage.setItem(SEGMENT_KEY, s);
  }, []);
  const [treeOpen, setTreeOpen] = useState(false);
  const [newDesk, setNewDesk] = useState<{ open: boolean; name: string; agentId: string | null }>({ open: false, name: "", agentId: null });
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidthRaw] = useState<ChatWidth>(() => (localStorage.getItem(CHAT_WIDTH_KEY) === "wide" ? "wide" : "narrow"));
  const setChatWidth = (w: ChatWidth) => {
    setChatWidthRaw(w);
    localStorage.setItem(CHAT_WIDTH_KEY, w);
  };
  // Where the chat sits: left, centre (wider) or right; ⌘← / ⌘→ move it (⌥⌘ inside a text box). An empty desk is a
  // conversation, so its chat is centred until the first widget lands — unless you move it there.
  const [chatPlacement, setChatPlacementRaw] = useState<ChatPlacement>(() => {
    const p = localStorage.getItem(CHAT_PLACEMENT_KEY);
    return p === "center" || p === "right" ? p : "left";
  });
  const setChatPlacement = useCallback((p: ChatPlacement) => {
    setChatPlacementRaw(p);
    localStorage.setItem(CHAT_PLACEMENT_KEY, p);
  }, []);
  const movedOnEmpty = useRef(new Set<string>());
  const emptyDesk = desk.loaded && desk.connection === "open" && desk.ownCount === 0;
  const effectivePlacement: ChatPlacement = emptyDesk && !movedOnEmpty.current.has(desk.scope) ? "center" : chatPlacement;
  const moveChat = (dir: 1 | -1) => {
    const i = CHAT_PLACEMENTS.indexOf(effectivePlacement);
    const next = CHAT_PLACEMENTS[Math.min(CHAT_PLACEMENTS.length - 1, Math.max(0, i + dir))];
    if (emptyDesk) movedOnEmpty.current.add(desk.scope);
    setChatPlacement(next);
    setChatOpen(true);
  };
  /** Bumped to move focus into the chat's message box (opening the chat if it is closed). */
  const [focusChat, setFocusChat] = useState(0);
  /** Bumped by ⌘F to open the chat's find bar. */
  const [findChat, setFindChat] = useState(0);
  // Models: fetched once from the app-server when a picker first opens; switches go per conversation.
  const [models, setModels] = useState<import("../chat/ModelPicker").ModelEntry[] | null>(null);
  const modelsLoading = useRef(false);
  const loadModels = useCallback(() => {
    if (models || modelsLoading.current) return;
    modelsLoading.current = true;
    void catchUp.listModels().then((m) => {
      setModels(m);
      modelsLoading.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);
  /** First launch: nothing to talk to yet. Only while the harness has answered and lists no agents. */
  const boot = useBootstrap();
  const welcome: "letta" | "provider" | "agent" | null =
    boot.status && !boot.status.letta && catchUp.status !== "open"
      ? "letta" // no Letta Code on this Mac and no harness answering: loki is installing one
      : catchUp.status === "open" && catchUp.agentsLoaded
        ? welcomeStep({ agents: catchUp.agents.length, providers: catchUp.providers })
        : null;
  useEffect(() => {
    if (catchUp.status === "open" && catchUp.agentsLoaded && catchUp.agents.length === 0 && catchUp.providers === null) void catchUp.loadProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catchUp.status, catchUp.agentsLoaded, catchUp.agents.length, catchUp.providers === null]);
  const pickModel = async (scope: string, rt: { agent_id: string; conversation_id: string }, handle: string) => {
    const err = await catchUp.updateModel(rt, handle);
    if (err) return notice(`model: ${err}`);
    desk.setDeskModel(scope, handle);
    notice(`${rt.conversation_id === "default" ? "the agent now runs on" : "this conversation now runs on"} ${handle.split("/").pop()}`);
  };
  const [modelPickerTick, setModelPickerTick] = useState(0);
  const [modeMenuTick, setModeMenuTick] = useState(0);
  const pickMode = async (scope: string, rt: { agent_id: string; conversation_id: string }, mode: string) => {
    const err = await catchUp.setMode(rt, mode);
    if (err) return notice(`permissions: ${err}`);
    desk.setDeskMode(scope, mode);
    notice(`permissions for this conversation: ${mode === "acceptEdits" ? "accept edits" : mode}`);
  };
  /** A request another view wants typed into the chat ("ask ira to update this"). */
  const [chatPrefill, setChatPrefill] = useState<{ text: string; tick: number } | null>(null);

  // --- the board -------------------------------------------------------
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const refreshTasks = useCallback(async () => {
    if (desk.connection !== "open") return;
    setTasksLoading(true);
    const r = await desk.board.list(true);
    setTasksLoading(false);
    if (r.ok) {
      setTasks(r.tasks);
      setTasksError(null);
    } else setTasksError(r.message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);
  // Refresh when the mod says the board changed, when the segment opens, and slowly while it shows (Dolt has no file to watch).
  useEffect(() => {
    if (desk.connection === "open") void refreshTasks();
  }, [desk.tasksVersion, desk.connection, refreshTasks]);
  useEffect(() => {
    if (segment !== "board") return;
    void refreshTasks();
    const t = setInterval(() => void refreshTasks(), 20_000);
    return () => clearInterval(t);
  }, [segment, refreshTasks]);
  const openTasks = tasks?.filter((t) => t.status !== "closed").length ?? 0;
  /** ⏎ / ⌘⏎ on the board: which tasks, and whether to dispatch. Consumed by the picker (or a new desk). */
  const [picker, setPicker] = useState<{ ids: string[]; start: boolean } | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const pendingAssign = useRef<{ ids: string[]; start: boolean } | null>(null);
  const [boardNotice, setBoardNotice] = useState<string | null>(null);
  const notice = (m: string) => {
    setBoardNotice(m);
    setTimeout(() => setBoardNotice((cur) => (cur === m ? null : cur)), 4000);
  };

  const waiting = catchUpQueue(catchUp.items).length;
  // The inbox badge ticks when something new starts waiting.
  const [tick, setTick] = useState(false);
  const prevWaiting = useRef(waiting);
  useEffect(() => {
    if (waiting > prevWaiting.current) {
      setTick(true);
      const t = setTimeout(() => setTick(false), 500);
      prevWaiting.current = waiting;
      return () => clearTimeout(t);
    }
    prevWaiting.current = waiting;
  }, [waiting]);

  // In the shell: the tray title and dock badge carry the count; ⌥Space (or a tray click) brings up the inbox.
  useEffect(() => {
    if (!inTauri) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_waiting", { count: waiting })).catch(() => {});
  }, [waiting]);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen("loki:catch-up", () => setSegmentRaw((s) => (s === "inbox" ? "desk" : "inbox")));
    });
    return () => off?.();
  }, []);
  useEffect(() => {
    sessionStorage.setItem(SEGMENT_KEY, segment);
  }, [segment]);
  // The window title is the only chrome: the desk's name on the desk, the inbox with its count, settings.
  // macOS draws it in the native title bar; a browser tab shows it as the tab title.
  useEffect(() => {
    const deskName = desk.title ?? (desk.status === "live" ? "new desk" : desk.scope);
    // "agent · title", the way Letta names a main chat ("ira · main chat"); no repeat when the title already leads with it.
    const who = desk.agentName && !deskName.toLowerCase().startsWith(desk.agentName.toLowerCase()) ? `${desk.agentName} · ` : "";
    const state = desk.status === "archived" ? " · archived" : desk.status === "deleted" ? " · deleted" : "";
    const name = segment === "inbox" ? (waiting > 0 ? `Inbox · ${waiting} waiting` : "Inbox") : segment === "board" ? (openTasks > 0 ? `Board · ${openTasks} open` : "Board") : segment === "agents" ? "Agents" : segment === "settings" ? "Settings" : `${who}${deskName}${state}`;
    document.title = waiting > 0 && segment !== "inbox" ? `(${waiting}) ${name}` : name;
    if (inTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name)).catch((e) => console.warn("loki: window title", e));
  }, [waiting, desk.title, desk.status, desk.scope, desk.agentName, segment, openTasks]);

  // The desks list feeds the tree and ⌘[ ⌘]; ask for it once the mod link is up. The LAN listener's
  // status too, so the rail's brass dot is right before Settings is ever opened.
  useEffect(() => {
    if (desk.connection === "open") {
      desk.desks.request();
      desk.phone.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);

  const openTree = useCallback(() => {
    desk.desks.request();
    setTreeOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openDesk = useCallback(
    (agentId: string, conversationId: string, opts: { chat?: boolean } = {}) => {
      desk.desks.switchTo(scopeFor(conversationId, agentId));
      setSegment("desk");
      if (opts.chat) {
        setChatOpen(true);
        setFocusChat((n) => n + 1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSegment],
  );
  const stepDesk = (dir: 1 | -1) => {
    const live = desk.desks.list.filter((d) => d.status === "live");
    if (live.length < 2) return;
    const i = live.findIndex((d) => d.scope === desk.scope);
    const next = live[(i + dir + live.length) % live.length];
    desk.desks.switchTo(next.scope);
    setSegment("desk");
  };
  const createDesk = async (agent: string, folder: string, name: string) => {
    const rt = await catchUp.createDesk(agent, folder, name);
    setNewDesk({ open: false, name: "", agentId: null });
    const pending = pendingAssign.current;
    pendingAssign.current = null;
    if (pending) {
      // The board asked for a new desk as the target: assign (or dispatch) there, then go.
      const agentName = catchUp.agents.find((a) => a.id === rt.agent_id)?.name ?? null;
      await assignTo({ scope: scopeFor(rt.conversation_id, rt.agent_id), agentId: rt.agent_id, agentName, conversationId: rt.conversation_id, title: name || null }, pending.ids, pending.start);
      return;
    }
    openDesk(rt.agent_id, rt.conversation_id, { chat: true });
  };

  /**
   * Assign: the tasks get the agent as assignee and the conversation in their metadata; the agent hears
   * about them on the user's next message there. Dispatch: assign, then post the tasks so the agent starts now.
   */
  const assignTo = async (target: Pick<DeskSummary, "scope" | "agentId" | "conversationId" | "title"> & { agentName: string | null }, ids: string[], start: boolean) => {
    if (!target.conversationId) return notice("that desk has no conversation to assign to");
    const r = await desk.board.assign(ids, { agentId: target.agentId, agentName: target.agentName, conversationId: target.conversationId, desk: target.scope }, start);
    if (!r.ok) return notice(r.message);
    const assigned = r.tasks.length ? r.tasks : (tasks ?? []).filter((t) => ids.includes(t.id));
    if (start && target.agentId) {
      const rt = { agent_id: target.agentId, conversation_id: target.conversationId };
      catchUp.send(rt, dispatchMessage(assigned), [], { desk: target.title });
      openDesk(target.agentId, target.conversationId, { chat: true });
    } else {
      notice(`${ids.length === 1 ? "task" : `${ids.length} tasks`} assigned to ${target.title ?? target.scope}${target.agentName ? ` · ${target.agentName} hears about it on your next message there` : ""}`);
    }
    void refreshTasks();
  };
  const closeTasks = async (ids: string[]) => {
    const r = await desk.board.close(ids, "done from the board");
    if (!r.ok) notice(r.message);
    void refreshTasks();
  };
  const setTaskStatus = async (ids: string[], status: "open" | "blocked") => {
    const r = await desk.board.setStatus(ids, status);
    if (!r.ok) notice(r.message);
    void refreshTasks();
  };
  const createTask = async (t: { title: string; description?: string; labels?: string[]; priority: number }): Promise<string | null> => {
    const r = await desk.board.create({ ...t, desk: desk.scope, agentId: desk.agentId, agentName: desk.agentName, conversationId: desk.conversationId });
    if (!r.ok) return r.message;
    notice(`filed ${r.tasks[0]?.id ?? "the task"}`);
    void refreshTasks();
    return null;
  };

  // --- the window's actions, by keymap id ------------------------------
  // Views register their own (the sheet's zoom, the deck's decisions, the board's moves). The single
  // key handler below and the native menu both dispatch through the registry.
  const keysRef = useRef({ segment, treeOpen, chatOpen, moveChat, stepDesk });
  keysRef.current = { segment, treeOpen, chatOpen, moveChat, stepDesk };
  useEffect(
    () =>
      registerActions({
        "segment.desk": () => (setSegment("desk"), setTreeOpen(false)),
        "segment.inbox": () => (setSegment("inbox"), setTreeOpen(false)),
        "segment.board": () => (setSegment("board"), setTreeOpen(false)),
        "segment.agents": () => (setSegment("agents"), setTreeOpen(false)),
        "segment.settings": () => (setSegment("settings"), setTreeOpen(false)),
        "tree.toggle": () => (keysRef.current.treeOpen ? setTreeOpen(false) : openTree()),
        "desk.new": () => setNewDesk({ open: true, name: "", agentId: null }),
        "task.new": () => setCaptureOpen(true),
        "desk.prev": () => keysRef.current.stepDesk(-1),
        "desk.next": () => keysRef.current.stepDesk(1),
        "window.hide": () => {
          if (inTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().hide()).catch((e) => console.warn("loki: hide", e));
        },
        "chat.toggle": () => setChatOpen((v) => !v),
        "chat.close": () => setChatOpen(false),
        "chat.focus": () => (setChatOpen(true), setFocusChat((n) => n + 1)),
        "chat.find": () => (setChatOpen(true), setFindChat((n) => n + 1)),
        "chat.model": () => (setChatOpen(true), setModelPickerTick((n) => n + 1)),
        "chat.mode": () => (setChatOpen(true), setModeMenuTick((n) => n + 1)),
        "chat.left": () => keysRef.current.moveChat(-1),
        "chat.right": () => keysRef.current.moveChat(1),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // One key handler for the window: resolve the event against the keymap for the showing segment and run
  // the action. Dialogs and the tree own their keys (except ⌘K, which closes the tree). Esc peels a layer.
  const lastKeyFired = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { segment, treeOpen } = keysRef.current;
      const dialogUp = !!document.querySelector('[role="dialog"]:not([data-tree])');
      if (e.key === "Escape") {
        if (typingIn(e) || dialogUp) return;
        if (treeOpen) {
          e.preventDefault();
          setTreeOpen(false);
        } else if (segment === "settings" || segment === "board" || segment === "agents") {
          e.preventDefault();
          setSegment("desk");
        }
        return;
      }
      if (dialogUp) return;
      const b = resolve(e, segment);
      if (!b) return;
      if (treeOpen && b.id !== "tree.toggle" && !b.id.startsWith("segment.")) return;
      if (runAction(b.id)) {
        e.preventDefault();
        lastKeyFired.current = { id: b.id, at: Date.now() };
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The native menu bar is built from the same keymap. Its clicks arrive as loki:menu with the binding id;
  // when macOS also fires an accelerator we already handled, the id arrives twice within a beat — drop the echo.
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_menu", { menus: menuSpec() })).catch((e) => console.warn("loki: menu", e));
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen<string>("loki:menu", (ev) => {
        const id = ev.payload === "app.settings" ? "segment.settings" : ev.payload;
        const last = lastKeyFired.current;
        if (last && last.id === id && Date.now() - last.at < 250) return;
        if (!runAction(id)) console.warn("loki: menu item without an action", id);
      });
    });
    return () => off?.();
  }, []);

  const deskRuntime = desk.agentId && desk.conversationId ? { agent_id: desk.agentId, conversation_id: desk.conversationId } : null;

  return (
    <div style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--loki-bg)" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <Sidebar segment={segment} onSelect={(s) => (s === "desk" && segment === "desk" ? (treeOpen ? setTreeOpen(false) : openTree()) : (setTreeOpen(false), setSegment(s)))} waiting={waiting} tick={tick} treeOpen={treeOpen} openTasks={openTasks} lanOn={desk.phone.status?.enabled === true} />

        <div style={{ position: "absolute", top: 0, left: SIDEBAR_WIDTH, right: 0, bottom: 0 }}>
          {/* The sheet stays mounted behind the other views so the desk link and camera keep their state. */}
          <div style={{ position: "absolute", inset: 0, visibility: segment === "desk" ? "visible" : "hidden" }} aria-hidden={segment !== "desk"}>
            <Surface
              desk={desk}
              catchUp={catchUp}
              chatOpen={chatOpen}
              onChatOpen={setChatOpen}
              chatWidth={chatWidth}
              onChatWidth={setChatWidth}
              chatPlacement={effectivePlacement}
              focusChat={focusChat}
              findChat={findChat}
              chatPrefill={chatPrefill}
              models={models}
              onLoadModels={loadModels}
              onPickModel={pickModel}
              modelPickerTick={modelPickerTick}
              onPickMode={pickMode}
              modeMenuTick={modeMenuTick}
            />
          </div>

          {segment === "inbox" && (
            <CatchUp
              open
              onClose={() => setSegment("desk")}
              items={catchUp.items}
              onSeen={catchUp.seen}
              onUnread={catchUp.unread}
              onLater={catchUp.later}
              onUnsnooze={catchUp.unsnooze}
              snoozes={catchUp.snoozes}
              onApprove={catchUp.approve}
              onAnswer={(item, requestId, answers) => catchUp.answer(item.runtime, requestId, answers)}
              onReply={catchUp.reply}
              onOpenDesk={(agentId, conversationId) => openDesk(agentId, conversationId, { chat: true })}
              conversation={catchUp.conversation}
              loadHistory={(item) => void catchUp.loadHistory(item)}
              modelFor={(agentId, conversationId) => desk.modelOf(scopeFor(conversationId, agentId))}
              models={models}
              onLoadModels={loadModels}
              onPickModel={(item, handle) => pickModel(scopeFor(item.id, item.agentId), item.runtime, handle)}
              modeFor={(agentId, conversationId) => desk.modeOf(scopeFor(conversationId, agentId))}
              onPickMode={(item, mode) => pickMode(scopeFor(item.id, item.agentId), item.runtime, mode)}
            />
          )}

          {segment === "board" && (
            <Board
              tasks={tasks}
              loading={tasksLoading}
              error={tasksError}
              desks={desk.desks.list}
              onRefresh={() => void refreshTasks()}
              onAssign={(ids, start) => {
                desk.desks.request();
                setPicker({ ids, start });
              }}
              onClose={(ids) => void closeTasks(ids)}
              onStatus={(ids, status) => void setTaskStatus(ids, status)}
              onNew={() => setCaptureOpen(true)}
              active={segment === "board" && !picker && !captureOpen}
            />
          )}

          {segment === "agents" && (
            <Agents
              agents={catchUp.agents}
              api={desk.agents}
              avatar={avatarUrl}
              desks={desk.desks.list}
              tasks={tasks}
              initialAgentId={desk.agentId}
              onOpenDesk={(agentId, conversationId) => openDesk(agentId, conversationId, { chat: true })}
              onAskToUpdate={(agentId, text) => {
                openDesk(agentId, "default", { chat: true });
                setChatPrefill({ text, tick: Date.now() });
              }}
              onUpdateAgent={catchUp.updateAgent}
              write={{ createAgent: catchUp.createAgent, deleteAgent: catchUp.deleteAgent, writeMemory: catchUp.memory.write, removeMemory: catchUp.memory.remove }}
              listModels={catchUp.listModels}
              onShowDesks={openTree}
              onShowBoard={() => setSegment("board")}
            />
          )}

          {segment === "settings" && (
            <Settings appServerStatus={attention.available ? (catchUp.status === "off" ? "connecting" : catchUp.status) : "unavailable"} tunnelUrl={attention.tunnelUrl} modConnection={desk.connection} deskCount={desk.desks.list.filter((d) => d.status === "live").length} chatWidth={chatWidth} onChatWidth={setChatWidth} chatPlacement={chatPlacement} onChatPlacement={setChatPlacement} lettaVersion={catchUp.server?.version ?? null} providers={catchUp.providers} onLoadProviders={catchUp.loadProviders} onConnectProvider={catchUp.connectProvider} onDisconnectProvider={catchUp.disconnectProvider} onModelsChanged={() => setModels(null)} bootstrap={boot.status} onInstallLetta={boot.install} phone={desk.phone} globalSkills={{ list: desk.agents.globalSkills, enable: catchUp.skills.enable, disable: catchUp.skills.disable }} />
          )}

          {welcome && segment !== "settings" && (
            <Welcome
              step={welcome}
              providers={catchUp.providers}
              onLoadProviders={catchUp.loadProviders}
              onConnect={catchUp.connectProvider}
              onDisconnect={catchUp.disconnectProvider}
              onModelsChanged={() => setModels(null)}
              models={models ? models.map((m) => m.handle) : null}
              onLoadModels={loadModels}
              onCreate={catchUp.createAgent}
              onDone={(agentId) => openDesk(agentId, "default", { chat: true })}
              bootstrap={boot.status}
              onInstallLetta={boot.install}
            />
          )}

          {/* The board's target picker: the same tree, choosing instead of switching. */}
          <DeskTree
            open={!!picker}
            onClose={() => setPicker(null)}
            heading={picker ? `${picker.start ? "dispatch" : "assign"} ${picker.ids.length === 1 ? "1 task" : `${picker.ids.length} tasks`} to…${picker.start ? " (the agent starts now)" : ""}` : null}
            desks={desk.desks.list}
            agents={catchUp.agents}
            items={catchUp.items}
            current={desk.scope}
            onSwitch={() => {}}
            onPickDesk={(d) => {
              const p = picker;
              setPicker(null);
              if (p) void assignTo({ scope: d.scope, agentId: d.agentId, agentName: d.agentName, conversationId: d.conversationId, title: d.title }, p.ids, p.start);
            }}
            onNew={
              attention.available
                ? (agentId, name) => {
                    pendingAssign.current = picker;
                    setPicker(null);
                    setNewDesk({ open: true, name, agentId });
                  }
                : undefined
            }
          />

          <DeskTree
            open={treeOpen}
            onClose={() => setTreeOpen(false)}
            desks={desk.desks.list}
            agents={catchUp.agents}
            items={catchUp.items}
            current={desk.scope}
            onSwitch={(scope) => {
              desk.desks.switchTo(scope);
              setSegment("desk");
            }}
            onNew={attention.available ? (agentId, name) => setNewDesk({ open: true, name, agentId }) : undefined}
            onPin={(d, pinned) => {
              if (d.agentId && d.conversationId) desk.desks.pin(d.agentId, d.conversationId, pinned);
            }}
            onArchive={
              attention.available
                ? (d, archived) => {
                    if (!d.conversationId) return;
                    void catchUp.archiveConversation(d.conversationId, archived).then((err) => {
                      if (err) return notice(`archive: ${err}`);
                      notice(`${d.title ?? d.scope} ${archived ? "archived" : "restored"}`);
                      desk.desks.request();
                    });
                  }
                : undefined
            }
          />
        </div>
      </div>

      <TaskCapture open={captureOpen} onClose={() => setCaptureOpen(false)} onCreate={createTask} context={{ desk: desk.scope, agentName: desk.agentName }} />
      {boardNotice && (
        <div role="status" style={{ position: "absolute", left: "50%", bottom: 22, transform: "translateX(-50%)", padding: "8px 14px", borderRadius: 999, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", color: "var(--loki-fg)", fontSize: 12, boxShadow: "var(--loki-shadow-float)", zIndex: LAYER.toast, maxWidth: "70%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {boardNotice}
        </div>
      )}

      <NewDesk
        open={newDesk.open}
        onClose={() => {
          pendingAssign.current = null;
          setNewDesk({ open: false, name: "", agentId: null });
        }}
        agents={catchUp.agents}
        defaultAgentId={newDesk.agentId ?? desk.agentId}
        defaultFolder={deskRuntime ? null : null}
        initialName={newDesk.name}
        folders={attention.folders}
        onCreate={createDesk}
      />
    </div>
  );
}
