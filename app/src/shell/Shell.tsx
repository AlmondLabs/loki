import { useCallback, useEffect, useRef, useState } from "react";
import { Toast } from "../components";
import { scopeFor } from "../../../core/desk-core.ts";
import { useAttention } from "../../../core/attention/useAttention.ts";
import { makeTransport } from "./transport";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { Surface } from "../desk/Surface";
import { useDesk } from "../desk/useDesk";
import { inTauri } from "../desk/env";
import { TaskCapture } from "../board/TaskCapture";
import { useBootstrap, type BootstrapStatus } from "./bootstrap";
import { welcomeStep } from "../settings/provider-model";
import { Sidebar, SIDEBAR_WIDTH } from "./Sidebar";
import type { Segment } from "./shortcuts";
import { useNotice } from "./useNotice";
import { useVisitedDesks } from "./useVisitedDesks";
import { useTray, useWindowTitle } from "./useWindowChrome";
import { useChatLayout } from "./useChatLayout";
import { useBoard } from "./useBoard";
import { useRecall } from "./useRecall";
import { useLokiUpdate } from "./useLokiUpdate";
import { useGlobalShortcut } from "./useGlobalShortcut";
import { useShellKeys } from "./useShellKeys";
import { AgentsView, BoardView, InboxView, NewDeskSheet, PickerTree, SettingsView, SwitcherTree, WelcomeView, type Picker, RecallView } from "./views";
import type { CatchUp, Runtime } from "./types";

const SEGMENT_KEY = "loki.segment";

/** The segment survives a reload of the same window; a refresh mid-pass reopens the inbox. */
function savedSegment(): Segment {
  const s = sessionStorage.getItem(SEGMENT_KEY);
  return s === "inbox" || s === "settings" || s === "board" || s === "agents" || s === "recall" ? s : "desk";
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
    listConversations: attention.listInbox,
  });
  const { message: boardNotice, notice } = useNotice();
  // The inbox lists what is open on disk; when the tree archives or restores a conversation, re-read it now rather than at the next minute.
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
  const [treeOpen, setTreeOpen] = useState(false);
  const [newDesk, setNewDesk] = useState<{ open: boolean; name: string; agentId: string | null }>({ open: false, name: "", agentId: null });
  const chat = useChatLayout(desk);
  const { chatOpen, setChatOpen } = chat;
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
  const pickModel = async (scope: string, rt: Runtime, handle: string) => {
    const err = await catchUp.updateModel(rt, handle);
    if (err) return notice(`model: ${err}`);
    desk.setDeskModel(scope, handle);
    notice(`${rt.conversation_id === "default" ? "the agent now runs on" : "this conversation now runs on"} ${handle.split("/").pop()}`);
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

  // --- the board -------------------------------------------------------
  const board = useBoard(desk, segment, notice, { send: catchUp.send, openDesk });
  const recall = useRecall(desk, segment, notice);
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
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
  useWindowTitle(desk, segment, waiting, board.openTasks, recall.due);

  // The desks list feeds the tree and ⌘[ ⌘]; ask for it once the mod link is up. The LAN listener's
  // status too, so the rail's brass dot is right before Settings is ever opened.
  useEffect(() => {
    if (desk.connection === "open") {
      desk.desks.request();
      desk.phone.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);
  const visited = useVisitedDesks(desk.scope);

  useShellKeys(
    { segment, treeOpen },
    {
      "segment.desk": () => (setSegment("desk"), setTreeOpen(false)),
      "segment.inbox": () => (setSegment("inbox"), setTreeOpen(false)),
      "segment.board": () => (setSegment("board"), setTreeOpen(false)),
      "segment.recall": () => (setSegment("recall"), setTreeOpen(false)),
      "segment.agents": () => (setSegment("agents"), setTreeOpen(false)),
      "segment.settings": () => (setSegment("settings"), setTreeOpen(false)),
      "tree.toggle": () => (treeOpen ? setTreeOpen(false) : openTree()),
      "desk.new": () => setNewDesk({ open: true, name: "", agentId: null }),
      "task.new": () => setCaptureOpen(true),
      "desk.prev": () => stepDesk(-1),
      "desk.next": () => stepDesk(1),
      "window.hide": () => {
        if (inTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().hide()).catch((e) => console.warn("loki: hide", e));
      },
      "chat.toggle": () => setChatOpen((v) => !v),
      "chat.close": () => setChatOpen(false),
      "chat.focus": () => (setChatOpen(true), setFocusChat((n) => n + 1)),
      "chat.find": () => (setChatOpen(true), setFindChat((n) => n + 1)),
      "chat.model": () => (setChatOpen(true), setModelPickerTick((n) => n + 1)),
      "chat.mode": () => (setChatOpen(true), setModeMenuTick((n) => n + 1)),
      "chat.left": () => chat.moveChat(-1),
      "chat.right": () => chat.moveChat(1),
    },
    { closeTree: () => setTreeOpen(false), toDesk: () => setSegment("desk") },
  );

  const switchDesk = (scope: string) => {
    desk.desks.switchTo(scope);
    setSegment("desk");
  };
  const forgetModels = () => setModels(null);

  return (
    <div style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--loki-bg)" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <Sidebar segment={segment} onSelect={(s) => (s === "desk" && segment === "desk" ? (treeOpen ? setTreeOpen(false) : openTree()) : (setTreeOpen(false), setSegment(s)))} waiting={waiting} tick={tick} treeOpen={treeOpen} openTasks={board.openTasks} dueCards={recall.due} lanOn={desk.phone.status?.enabled === true} updateReady={update.newer} />

        <div style={{ position: "absolute", top: 0, left: SIDEBAR_WIDTH, right: 0, bottom: 0 }}>
          {/* The sheet stays mounted behind the other views so the desk link and camera keep their state. */}
          <div style={{ position: "absolute", inset: 0, visibility: segment === "desk" ? "visible" : "hidden" }} aria-hidden={segment !== "desk"}>
            <Surface
              desk={desk}
              catchUp={catchUp}
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
            />
          </div>

          {segment === "inbox" && <InboxView desk={desk} catchUp={catchUp} models={modelList} onLoadModels={loadModels} onPickModel={pickModel} onPickMode={pickMode} onOpenDesk={openDesk} onClose={() => setSegment("desk")} />}

          {segment === "board" && (
            <BoardView
              board={board}
              desks={desk.desks.list}
              onAssign={(ids, start) => {
                desk.desks.request();
                setPicker({ ids, start });
              }}
              onNew={() => setCaptureOpen(true)}
              active={segment === "board" && !picker && !captureOpen}
            />
          )}

          {segment === "recall" && <RecallView recall={recall} active={segment === "recall" && !picker && !captureOpen && !treeOpen} onOpenDesk={openDesk} />}

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
              onShowDesks={openTree}
              onShowBoard={() => setSegment("board")}
            />
          )}

          {segment === "settings" && <SettingsView update={update} shortcut={shortcut} recall={recall} desk={desk} catchUp={catchUp} boot={boot.status} onInstallLetta={boot.install} onCheckLetta={boot.check} onUpdateLetta={boot.update} chatWidth={chat.chatWidth} onChatWidth={chat.setChatWidth} chatPlacement={chat.chatPlacement} onChatPlacement={chat.setChatPlacement} onModelsChanged={forgetModels} />}

          {welcome && segment !== "settings" && <WelcomeView step={welcome} catchUp={catchUp} boot={boot.status} onInstallLetta={boot.install} models={modelList} onLoadModels={loadModels} onModelsChanged={forgetModels} onDone={(agentId) => openDesk(agentId, "default", { chat: true })} />}

          <PickerTree picker={picker} onClose={() => setPicker(null)} desk={desk} catchUp={catchUp} onAssign={board.assignTo} pendingAssignRef={pendingAssign} onNewDesk={(agentId, name) => setNewDesk({ open: true, name, agentId })} />

          <SwitcherTree
            open={treeOpen}
            onClose={() => setTreeOpen(false)}
            desk={desk}
            catchUp={catchUp}
            visited={visited}
            onSwitch={switchDesk}
            onSwitchChat={(scope) => {
              switchDesk(scope);
              setChatOpen(true);
              setFocusChat((n) => n + 1);
            }}
            onNewDesk={(agentId, name) => setNewDesk({ open: true, name, agentId })}
            notice={notice}
          />
        </div>
      </div>

      <TaskCapture open={captureOpen} onClose={() => setCaptureOpen(false)} onCreate={board.createTask} context={{ desk: desk.scope, agentName: desk.agentName }} />
      {boardNotice && <Toast>{boardNotice}</Toast>}

      <NewDeskSheet
        state={newDesk}
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
