import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toast } from "../components";
import { scopeFor } from "../../../core/desk-core.ts";
import { useAttention } from "../../../core/attention/useAttention.ts";
import { makeTransport } from "./transport";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { DeskPane } from "../desk/DeskPane";
import { useDeskPane } from "../desk/useDeskPane";
import { chatKeyTarget, sidebarHidden } from "../desk/pane";
import { useDesk } from "../desk/useDesk";
import { avatarUrl, inTauri } from "../desk/env";
import { AgentsColumn } from "../agents/Agents";
import { BoardColumn } from "../board/BoardColumn";
import { LearnColumn } from "../recall/LearnColumn";
import { TaskCapture } from "../board/TaskCapture";
import { useBootstrap, type BootstrapStatus } from "./bootstrap";
import { welcomeStep } from "../settings/provider-model";
import { afterSegmentKey } from "../settings/preferences";
import { Sidebar, SIDEBAR_WIDTH, TitleStrip, TITLEBAR_HEIGHT } from "./Sidebar";
import type { Segment } from "./shortcuts";
import { useNotice } from "./useNotice";
import { useTray, useWindowTitle } from "./useWindowChrome";
import { useChatLayout } from "./useChatLayout";
import { useBoard } from "./useBoard";
import { useRecall } from "./useRecall";
import { useLokiUpdate } from "./useLokiUpdate";
import { useGlobalShortcut } from "./useGlobalShortcut";
import { useScratch } from "./useScratch";
import { useShellKeys } from "./useShellKeys";
import { KeysSheet } from "./KeysSheet";
import { useColumn } from "./useColumn";
import { ListColumn } from "./ListColumn";
import { DeskSidebarView } from "./DeskSidebar";
import { AgentsView, BoardView, InboxView, NewDeskSheet, PickerTree, SettingsView, WelcomeView, type Picker, RecallView } from "./views";
import { SearchSheet } from "./SearchSheet";
import { deskPlace, recentPlaces, sectionPlace, type SearchHit } from "./searchModel";
import { agentsSelection } from "../agents/selection";
import { SETTINGS_PAGE_KEY } from "../settings/pages";
import type { CatchUp, Runtime } from "./types";
import { effortLabel } from "../chat/ModelPicker";
import type { ModelSelection } from "../../../core/models.ts";

const SEGMENT_KEY = "loki.segment";

/** The segment survives a reload of the same window; a refresh mid-pass reopens the inbox. Settings is a sheet now, not a segment: a saved "settings" lands on the desk. */
function savedSegment(): Segment {
  const s = sessionStorage.getItem(SEGMENT_KEY);
  return s === "inbox" || s === "board" || s === "agents" || s === "learn" ? s : "desk";
}

/** First launch: nothing to talk to yet. Only while the harness has answered and lists no agents. */
function welcomeFor(boot: BootstrapStatus | null, catchUp: Pick<CatchUp, "status" | "agentsLoaded" | "agents" | "providers">): "letta" | "provider" | "agent" | null {
  return boot && !boot.letta && catchUp.status !== "open"
    ? "letta" // no Letta Code on this Mac and no harness answering: loki is installing one
    : catchUp.status === "open" && catchUp.agentsLoaded
      ? welcomeStep({ agents: catchUp.agents.length, providers: catchUp.providers })
      : null;
}

/**
 * The window: loki's own top strip (the native title bar is hidden), a rail of segments under it, the
 * section's list column (ListColumn; Desk, Board, Agents, Learn) and one view in the space they leave. The desk and attention models live here so the desk view, the
 * inbox, ⌘K search and settings all read the same state.
 */
export function Shell() {
  const desk = useDesk();
  const { attention } = desk;
  // Analytics (core/analytics.ts): every event the Mac sends carries the view on screen as $screen.
  const screenRef = useRef<Segment | null>(null);
  const { capture: captureRaw } = attention;
  const capture = useCallback((event: string, properties?: Record<string, unknown>) => captureRaw(event, { ...(screenRef.current ? { $screen: screenRef.current } : {}), ...properties }), [captureRaw]);
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
    ladder: attention.ladder,
    loadLocalHistory: attention.loadHistory,
    listConversations: attention.listInbox,
    capture,
  });
  const { message: boardNotice, notice } = useNotice();
  // The inbox lists what is open on disk; when the sidebar or the desk header archives or restores a conversation, re-read it now rather than at the next minute.
  const archivedKey = desk.desks.list.filter((d) => d.status === "archived").map((d) => d.scope).sort().join("\n");
  const reloadInbox = catchUp.reload;
  useEffect(() => {
    reloadInbox();
  }, [archivedKey, reloadInbox]);

  const [segment, setSegmentRaw] = useState<Segment>(savedSegment);
  const setSegment = useCallback((s: Segment) => {
    setSegmentRaw(s);
    sessionStorage.setItem(SEGMENT_KEY, s);
  }, []);
  /** ⌘K search (SearchSheet): a sheet over whatever shows. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** Preferences: the Settings sheet over the section showing (KTD11). The rail keeps that section highlighted underneath. */
  const [prefsOpen, setPrefsOpen] = useState(false);
  // The view on screen, the desk under it, the chat open or closed — an event on each change.
  const prevSegment = useRef<Segment | null>(null);
  useEffect(() => {
    if (prevSegment.current !== null) capture("view_opened", { view: segment, from: prevSegment.current });
    prevSegment.current = segment;
    screenRef.current = segment;
  }, [segment, capture]);
  useEffect(() => {
    capture("desk_switched", { desk: desk.scope });
  }, [desk.scope, capture]);
  const [newDesk, setNewDesk] = useState<{ open: boolean; name: string; agentId: string | null }>({ open: false, name: "", agentId: null });
  const chat = useChatLayout(desk);
  // The desk pane: Messages or the Desk tab, per desk; every open lands on Messages (desk/pane.ts).
  const pane = useDeskPane(desk.scope);
  const { chatOpen, setChatOpen } = chat;
  const prevChatOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevChatOpen.current !== null) capture(chatOpen ? "chat_opened" : "chat_closed");
    prevChatOpen.current = chatOpen;
  }, [chatOpen, capture]);
  /** Bumped to move focus into the chat's message box (opening the chat if it is closed). */
  const [focusChat, setFocusChat] = useState(0);
  /** Bumped by ⌘F to open the chat's find bar. */
  const [findChat, setFindChat] = useState(0);
  // Models: fetched once from the app-server when a picker first opens; switches go per conversation.
  // The model list belongs to one harness: it is kept with the link's identity (open, and which Letta Code), so a
  // reconnect — an update restarting the harness — or a different version reads as no list and the next open refetches.
  const harnessKey = `${catchUp.status === "open"}:${catchUp.server?.version ?? ""}`;
  const [models, setModels] = useState<{ key: string; list: import("../chat/ModelPicker").ModelEntry[] } | null>(null);
  const modelList = models && models.key === harnessKey ? models.list : null;
  const modelsLoading = useRef<string | null>(null);
  const loadModels = useCallback(() => {
    if (modelList || modelsLoading.current === harnessKey) return;
    modelsLoading.current = harnessKey;
    void catchUp.listModels().then((m) => {
      setModels({ key: harnessKey, list: m });
      if (modelsLoading.current === harnessKey) modelsLoading.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelList, harnessKey]);
  const boot = useBootstrap();
  const welcome = welcomeFor(boot.status, catchUp);
  useEffect(() => {
    if (catchUp.status === "open" && catchUp.agentsLoaded && catchUp.agents.length === 0 && catchUp.providers === null) void catchUp.loadProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catchUp.status, catchUp.agentsLoaded, catchUp.agents.length, catchUp.providers === null]);
  // The first agent's form offers the model list; ask for it as soon as that step shows (Welcome's "skip" asks too).
  useEffect(() => {
    if (welcome === "agent") loadModels();
  }, [welcome, loadModels]);
  const pickModel = async (scope: string, rt: Runtime, selection: ModelSelection) => {
    const { applied, error } = await catchUp.updateModel(rt, selection);
    if (error || !applied) return notice(`model: ${error ?? "the app-server did not return the applied model"}`);
    desk.setDeskModel(scope, applied.handle, applied.reasoningEffort);
    const effort = applied.reasoningEffort ? ` · effort ${effortLabel(applied.reasoningEffort)}` : "";
    notice(`${rt.conversation_id === "default" ? "the agent now runs on" : "this conversation now runs on"} ${applied.handle.split("/").pop()}${effort}`);
  };
  const [modelPickerTick, setModelPickerTick] = useState(0);
  const [modeMenuTick, setModeMenuTick] = useState(0);
  const pickMode = async (scope: string, rt: Runtime, mode: string) => {
    const err = await catchUp.setMode(rt, mode);
    if (err) return notice(`permissions: ${err}`);
    desk.setDeskMode(scope, mode);
    notice(`permissions for this conversation: ${mode === "acceptEdits" ? "accept edits" : mode}`);
  };
  /** A request another view wants typed into the chat ("ask ira to update this"). */
  const [chatPrefill, setChatPrefill] = useState<{ text: string; tick: number } | null>(null);

  const openSearch = useCallback(() => {
    desk.desks.request(); // the freshest desk titles to search
    setSearchOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * Open a desk from anywhere (the Inbox, Learn, Agents, Welcome, search, a new desk): its Messages tab with the box focused.
   * `_opts.chat` predates the tabs and is kept for callers. `switchTo` is a dependency: it compares against the desk showing,
   * and a stale copy took the desk it was made on for the current one, so opening that desk again did nothing.
   */
  const switchTo = desk.desks.switchTo;
  const paneOpen = pane.open;
  const openDesk = useCallback(
    (agentId: string, conversationId: string, _opts: { chat?: boolean } = {}) => {
      const scope = scopeFor(conversationId, agentId);
      switchTo(scope);
      paneOpen(scope);
      setSegment("desk");
      setFocusChat((n) => n + 1);
    },
    [setSegment, paneOpen, switchTo],
  );
  /** A lesson begins: the desk opens with the chat, and the brief goes out as the person's first message, the way a dispatched task does. */
  const beginLesson = (agentId: string, conversationId: string, brief: string, title: string) => {
    openDesk(agentId, conversationId, { chat: true });
    catchUp.send({ agent_id: agentId, conversation_id: conversationId }, brief, [], { desk: title, origin: "lesson" });
  };
  const stepDesk = (dir: 1 | -1) => {
    const live = desk.desks.list.filter((d) => d.status === "live");
    if (live.length < 2) return;
    const i = live.findIndex((d) => d.scope === desk.scope);
    const next = live[(i + dir + live.length) % live.length];
    desk.desks.switchTo(next.scope);
    setSegment("desk");
  };

  // --- the board -------------------------------------------------------
  const board = useBoard(desk, segment, notice, { send: catchUp.send, openDesk });
  const recall = useRecall(desk, segment, notice);
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  const scratch = useScratch();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  /** The `?` cheat sheet for the view showing. */
  const [keysOpen, setKeysOpen] = useState(false);
  const pendingAssign = useRef<Picker | null>(null);
  const createDesk = async (agent: string, folder: string, name: string) => {
    const rt = await catchUp.createDesk(agent, folder, name);
    setNewDesk({ open: false, name: "", agentId: null });
    const pending = pendingAssign.current;
    pendingAssign.current = null;
    if (pending) {
      // The board asked for a new desk as the target: assign (or dispatch) there, then go.
      const agentName = catchUp.agents.find((a) => a.id === rt.agent_id)?.name ?? null;
      await board.assignTo({ scope: scopeFor(rt.conversation_id, rt.agent_id), agentId: rt.agent_id, agentName, conversationId: rt.conversation_id, title: name || null }, pending.ids, pending.start);
      return;
    }
    openDesk(rt.agent_id, rt.conversation_id, { chat: true });
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
  const toggleInbox = useCallback(() => setSegmentRaw((s) => (s === "inbox" ? "desk" : "inbox")), []);
  useTray(waiting, toggleInbox);
  useEffect(() => {
    sessionStorage.setItem(SEGMENT_KEY, segment);
  }, [segment]);
  useWindowTitle(desk, prefsOpen ? "settings" : segment, waiting, board.openTasks, recall.due);

  // The desks list feeds the sidebar, search and ⌘[ ⌘]; ask for it once the mod link is up. The LAN listener's
  // status too, so the rail's green dot is right before Settings is ever opened.
  useEffect(() => {
    if (desk.connection === "open") {
      desk.desks.request();
      desk.phone.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);
  // Search's recent places: every desk opened and every section visited, not only what search opened.
  useEffect(() => {
    if (segment === "desk") {
      if (desk.scope !== "shared") recentPlaces.add(deskPlace(desk.scope));
    } else if (segment !== "settings") recentPlaces.add(sectionPlace(segment));
  }, [segment, desk.scope]);
  // The list column between the rail and the main pane (Desk, Board, Agents, Learn); the pane starts where it ends.
  const column = useColumn(segment);
  // The Desk tab gives the canvas the window: the column hides (its bodies stay mounted, scroll kept), the rail stays.
  const immersive = sidebarHidden(segment, pane.tab);
  const columnShown = column.shown && !immersive;
  const paneLeft = SIDEBAR_WIDTH + (columnShown ? column.width : 0);
  /** A chat key acts on the view showing: Messages, or the Desk tab's inset (desk/pane.ts); the inset's own keys wait for its tab. */
  const chatKey = (id: string, run: (inset: boolean) => void) => {
    const to = chatKeyTarget(id, pane.tab);
    if (to) run(to === "inset");
  };

  /** ⌘1-6 and ⌘,: ⌘, (⌘6) toggles Preferences over the section; the others close it and go (settings/preferences.ts). */
  const segmentKey = (id: string) => {
    const next = afterSegmentKey(id, { segment, preferences: prefsOpen });
    setPrefsOpen(next.preferences);
    setSegment(next.segment);
  };
  useShellKeys(
    { segment },
    {
      "segment.desk": () => segmentKey("segment.desk"),
      "segment.inbox": () => segmentKey("segment.inbox"),
      "segment.board": () => segmentKey("segment.board"),
      "segment.learn": () => segmentKey("segment.learn"),
      "segment.agents": () => segmentKey("segment.agents"),
      "segment.settings": () => segmentKey("segment.settings"),
      "search.open": () => (searchOpen ? setSearchOpen(false) : openSearch()),
      "desk.new": () => setNewDesk({ open: true, name: "", agentId: null }),
      "task.new": () => setCaptureOpen(true),
      "keys.sheet": () => setKeysOpen((v) => !v),
      "desk.prev": () => stepDesk(-1),
      "desk.next": () => stepDesk(1),
      "column.toggle": () => {
        if (column.has && !immersive) column.toggle();
      },
      "window.hide": () => {
        if (inTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().hide()).catch((e) => console.warn("loki: hide", e));
      },
      "chat.toggle": () => chatKey("chat.toggle", () => setChatOpen((v) => !v)),
      "chat.close": () => chatKey("chat.close", () => setChatOpen(false)),
      "chat.focus": () => chatKey("chat.focus", (inset) => (inset && setChatOpen(true), setFocusChat((n) => n + 1))),
      "chat.find": () => chatKey("chat.find", (inset) => (inset && setChatOpen(true), setFindChat((n) => n + 1))),
      "chat.model": () => chatKey("chat.model", (inset) => (inset && setChatOpen(true), setModelPickerTick((n) => n + 1))),
      "chat.mode": () => chatKey("chat.mode", (inset) => (inset && setChatOpen(true), setModeMenuTick((n) => n + 1))),
      "chat.left": () => chatKey("chat.left", () => chat.moveChat(-1)),
      "chat.right": () => chatKey("chat.right", () => chat.moveChat(1)),
    },
    { toDesk: () => setSegment("desk"), toMessages: pane.escape, closePreferences: () => setPrefsOpen(false) },
  );

  /** A desk chosen in the sidebar: an open, so its Messages tab with the box focused. */
  const switchDesk = (scope: string) => {
    desk.desks.switchTo(scope);
    pane.open(scope);
    setSegment("desk");
    setFocusChat((n) => n + 1);
  };
  const forgetModels = () => setModels(null);

  /** A search result: its section, and for a desk or a waiting item the desk on Messages (searchModel.ts SearchTarget). */
  const searchSources = useMemo(() => ({ desks: desk.desks.list, agents: catchUp.agents, items: catchUp.items }), [desk.desks.list, catchUp.agents, catchUp.items]);
  const openHit = ({ target: t }: SearchHit) => {
    setSearchOpen(false);
    if (t.kind === "preferences") {
      // Preferences mounts on its saved page: set it first.
      if (t.page) sessionStorage.setItem(SETTINGS_PAGE_KEY, t.page);
      setPrefsOpen(true);
      return;
    }
    setPrefsOpen(false);
    if (t.kind === "desk") return openDesk(t.agentId, t.conversationId);
    if (t.kind === "agent") {
      agentsSelection.pickAgent(t.agentId);
      return setSegment("agents");
    }
    setSegment(t.segment);
  };

  return (
    <div style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--loki-bg)" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <TitleStrip />
        <Sidebar segment={segment} onSelect={(s) => (s === "settings" ? setPrefsOpen(true) : setSegment(s))} waiting={waiting} tick={tick} openTasks={board.openTasks} dueCards={recall.due} lanOn={desk.phone.status?.enabled === true} updateReady={update.newer} column={column.has && !immersive ? { open: column.open, onToggle: column.toggle } : null} />

        <ListColumn
          segment={segment}
          shown={columnShown}
          width={column.width}
          onWidth={column.setWidth}
          sections={{
            desk: <DeskSidebarView desk={desk} catchUp={catchUp} notice={notice} onOpen={switchDesk} onNew={(agentId) => setNewDesk({ open: true, name: "", agentId })} />,
            board: <BoardColumn tasks={board.tasks} onNew={() => setCaptureOpen(true)} />,
            agents: <AgentsColumn agents={catchUp.agents} desks={desk.desks.list} items={catchUp.items} avatar={avatarUrl} initialAgentId={desk.agentId} />,
            learn: <LearnColumn recall={recall} />,
          }}
        />

        {/* The main pane: one main landmark for whichever section shows; the rail is the navigation, the list column the sidebar. */}
        <main style={{ position: "absolute", top: TITLEBAR_HEIGHT, left: paneLeft, right: 0, bottom: 0 }}>
          {/* The desk pane stays mounted behind the other views so the desk link, the camera and the thread's scroll keep their state. */}
          <div style={{ position: "absolute", inset: 0, visibility: segment === "desk" ? "visible" : "hidden" }} aria-hidden={segment !== "desk"}>
            <DeskPane
              desk={desk}
              catchUp={catchUp}
              active={segment === "desk"}
              tab={pane.tab}
              onTab={pane.setTab}
              frameRequest={pane.frameRequest}
              onFrameWidget={pane.frame}
              chatOpen={chatOpen}
              onChatOpen={setChatOpen}
              chatWidth={chat.chatWidth}
              onChatWidth={chat.setChatWidth}
              chatPlacement={chat.effectivePlacement}
              focusChat={focusChat}
              findChat={findChat}
              chatPrefill={chatPrefill}
              models={modelList}
              onLoadModels={loadModels}
              onPickModel={pickModel}
              modelPickerTick={modelPickerTick}
              onPickMode={pickMode}
              modeMenuTick={modeMenuTick}
              notice={notice}
            />
          </div>

          {segment === "inbox" && <InboxView desk={desk} catchUp={catchUp} models={modelList} onLoadModels={loadModels} onPickModel={pickModel} onPickMode={pickMode} onOpenDesk={openDesk} onClose={() => setSegment("desk")} onPass={(pass) => capture("inbox_pass_completed", pass)} />}

          {segment === "board" && (
            <BoardView
              board={board}
              desks={desk.desks.list}
              onAssign={(ids, start) => {
                desk.desks.request();
                setPicker({ ids, start });
              }}
              onNew={() => setCaptureOpen(true)}
              active={segment === "board" && !picker && !captureOpen && !searchOpen}
            />
          )}

          {segment === "learn" && <RecallView recall={recall} active={segment === "learn" && !picker && !captureOpen && !searchOpen} onOpenDesk={openDesk} onBegin={beginLesson} />}

          {segment === "agents" && (
            <AgentsView
              desk={desk}
              catchUp={catchUp}
              tasks={board.tasks}
              onOpenDesk={openDesk}
              onAskToUpdate={(agentId, text) => {
                openDesk(agentId, "default", { chat: true });
                setChatPrefill({ text, tick: Date.now() });
              }}
              onShowDesks={() => setSegment("desk")}
              onShowBoard={() => setSegment("board")}
            />
          )}

          {welcome && !prefsOpen && <WelcomeView step={welcome} catchUp={catchUp} boot={boot.status} onInstallLetta={boot.install} models={modelList} onLoadModels={loadModels} onModelsChanged={forgetModels} onDone={(agentId) => openDesk(agentId, "default", { chat: true })} />}

          <PickerTree picker={picker} onClose={() => setPicker(null)} desk={desk} catchUp={catchUp} onAssign={board.assignTo} pendingAssignRef={pendingAssign} onNewDesk={(agentId, name) => setNewDesk({ open: true, name, agentId })} />

        </main>
      </div>

      <TaskCapture open={captureOpen} onClose={() => setCaptureOpen(false)} onCreate={board.createTask} context={{ desk: desk.scope, agentName: desk.agentName }} />
      {searchOpen && <SearchSheet sources={searchSources} here={segment === "desk" ? deskPlace(desk.scope) : segment === "settings" ? null : sectionPlace(segment)} avatar={avatarUrl} onOpen={openHit} onClose={() => setSearchOpen(false)} />}
      {keysOpen && <KeysSheet segment={segment} onClose={() => setKeysOpen(false)} onSettings={() => (setKeysOpen(false), sessionStorage.setItem(SETTINGS_PAGE_KEY, "keys"), setPrefsOpen(true))} />}
      {/* Preferences covers the whole window, rail included, like Slack's. */}
      {prefsOpen && <SettingsView onClose={() => setPrefsOpen(false)} update={update} shortcut={shortcut} recall={recall} scratch={scratch} desk={desk} catchUp={catchUp} boot={boot.status} onInstallLetta={boot.install} onCheckLetta={boot.check} onUpdateLetta={boot.update} chatWidth={chat.chatWidth} onChatWidth={chat.setChatWidth} chatPlacement={chat.chatPlacement} onChatPlacement={chat.setChatPlacement} onModelsChanged={forgetModels} />}
      {boardNotice && <Toast>{boardNotice}</Toast>}

      <NewDeskSheet
        state={newDesk}
        inheritCurrentDesk={segment === "desk"}
        onClose={() => {
          pendingAssign.current = null;
          setNewDesk({ open: false, name: "", agentId: null });
        }}
        desk={desk}
        catchUp={catchUp}
        onCreate={createDesk}
      />
    </div>
  );
}
