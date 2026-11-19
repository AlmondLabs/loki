import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, EmptyPane, Notices, notify } from "../components";
import { RestartNotice } from "./restart-notice";
import { UpdateNotice, chatWorking, runUpdateItem } from "./update-notice";
import { conversationDirName, isMainChat, MAIN_CHAT_ID, scopeFor, SHARED_SCOPE } from "../../../core/desk-core.ts";
import { landing, landingKey } from "./landing";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { DeskPane } from "../desk/desk-pane";
import { NewChat } from "../desk/new-chat";
import { useFirstMessage } from "../desk/use-first-message";
import type { Attachment } from "../../../core/attention/content.ts";
import { useDeskPane } from "../desk/use-desk-pane";
import { chatKeyTarget } from "../desk/pane";
import { useDesk } from "../desk/use-desk";
import { avatarUrl, inTauri } from "../desk/env";
import { agentSources } from "../agents/agents-column";
import { learnSources } from "../recall/learn-column";
import { useLearnView } from "../recall/use-learn-view";
import { flowSources } from "../desk/flow-column";
import { useDaemonStatus, welcomeFor } from "./bootstrap";
import { afterSegmentKey } from "../settings/preferences";
import {
  ColumnToggle,
  GLASS_HEAD,
  GLASS_INSET,
  Places,
  sidebarToggleLeft,
  sidebarToggleLeftShown,
  sidebarToggleTop,
  TitleStrip,
  paneTop,
  sidebarLeadRoom,
} from "./sidebar";
import { commandsFor, runAction, type Segment } from "./keymap";
import { useModelList } from "./use-model-list";
import { hideCurrentWindow, useTray, useWindowTitle } from "./use-window-chrome";
import { useChatLayout } from "./use-chat-layout";
import { useRecall } from "./use-recall";
import { TitleMenu } from "./title-menu";
import { updateItemLabel, useLokiUpdate } from "./use-loki-update";
import { useGlobalShortcut } from "./use-global-shortcut";
import { useShellKeys } from "./use-shell-keys";
import { KeysSheet } from "./keys-sheet";
import { useColumn } from "./use-column";
import { ColumnEdge, ListColumn } from "./list-column";
import { LIST_MAX, LIST_MIN } from "./columns";
import { PlaceSlotsProvider } from "./place-columns";
import { ChatListView } from "./desk-sidebar";
import { leaveList, listStop, type ContentListHandle } from "./content-list";
import { ALL_CHATS, ARCHIVED_CHATS, PINNED_CHATS, chatSources, openIn, sourceHolds, sourceRows, stateRows, type ChatState } from "./sidebar-model";
import { AgentFace } from "../desk/agent-chip";
import type { FlowKind } from "../desk/flow-kinds";
import { AgentsView, InboxView, SettingsView, WelcomeView, RecallView } from "./views";
import { SearchSheet } from "./search-sheet";
import { takeCommandCenter, useSharedModels, type CommandScope } from "./command-center";
import { deskPlace, recentPlaces, sectionPlace, type SearchHit } from "./search-model";
import { agentsHasList, agentsSelection, useAgentsSelection } from "../agents/selection";
import { SETTINGS_PAGE_KEY } from "../settings/pages";
import type { Runtime } from "./types";
import { effortLabel, modelName } from "../chat/model-picker";
import type { ModelSelection } from "../../../core/models.ts";
import { useShellAttention } from "./use-shell-attention";
import { useLaneFollower } from "../shared/lane-follower";
import { MODELS_CHANGED_KEY, openSettingsWindow, SETTINGS_WINDOW } from "./open-settings";
import { useStorageKey } from "../shared/use-storage-key";

const SEGMENT_KEY = "loki.segment";

function savedSegment(): Segment {
  const s = sessionStorage.getItem(SEGMENT_KEY);
  return s === "inbox" || s === "agents" || s === "learn" ? s : "desk";
}

export function Shell() {
  const desk = useDesk();
  const { attention } = desk;
  const screenRef = useRef<Segment | null>(null);
  const { capture: captureRaw } = attention;
  const capture = useCallback(
    (event: string, properties?: Record<string, unknown>) => captureRaw(event, { ...(screenRef.current ? { $screen: screenRef.current } : {}), ...properties }),
    [captureRaw],
  );
  const catchUp = useShellAttention(desk, capture);
  const laneUntil = useLaneFollower("desktop", catchUp.flow);
  const notice = (m: string) => void notify(m);
  const archivedKey = desk.desks.list
    .filter((d) => d.status === "archived")
    .map((d) => d.scope)
    .sort()
    .join("\n");
  const reloadInbox = catchUp.reload;
  useEffect(() => {
    reloadInbox();
  }, [archivedKey, reloadInbox]);

  const [segment, setSegmentRaw] = useState<Segment>(savedSegment);
  const setSegment = useCallback((s: Segment) => {
    setSegmentRaw(s);
    sessionStorage.setItem(SEGMENT_KEY, s);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScope, setSearchScope] = useState<CommandScope>("all");
  const sharedModels = useSharedModels();
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [chatSource, setChatSource] = useState(ALL_CHATS);
  const [chatState, setChatState] = useState<ChatState>("all");
  const [flowKind, setFlowKind] = useState<FlowKind>("all");
  const [unselected, setUnselected] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const prevSegment = useRef<Segment | null>(null);
  useEffect(() => {
    if (prevSegment.current !== null) capture("view_opened", { view: segment, from: prevSegment.current });
    prevSegment.current = segment;
    screenRef.current = segment;
  }, [segment, capture]);
  useEffect(() => {
    capture("desk_switched", { desk: desk.scope });
  }, [desk.scope, capture]);
  const [newChat, setNewChat] = useState<{ agentId: string | null; n: number } | null>(null);
  const chat = useChatLayout(desk);
  const pane = useDeskPane(desk.scope);
  const { chatOpen, setChatOpen } = chat;
  const prevChatOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevChatOpen.current !== null) capture(chatOpen ? "chat_opened" : "chat_closed");
    prevChatOpen.current = chatOpen;
  }, [chatOpen, capture]);
  const [focusChat, setFocusChat] = useState(0);
  const [findChat, setFindChat] = useState(0);
  const [decideChat, setDecideChat] = useState<{ n: number; behavior: "allow" | "deny" }>({ n: 0, behavior: "allow" });
  const {
    list: modelList,
    load: loadModels,
    forget: forgetModels,
  } = useModelList({ open: catchUp.status === "open", version: catchUp.server?.version ?? "", listModels: catchUp.listModels, recent: desk.models.recent });
  useStorageKey(MODELS_CHANGED_KEY, () => forgetModels());
  const daemon = useDaemonStatus();
  const welcome = welcomeFor(daemon.status, catchUp);
  const noProviders = catchUp.providers === null;
  const loadProviders = useEffectEvent(() => {
    if (catchUp.status === "open" && catchUp.agentsLoaded && catchUp.agents.length === 0 && catchUp.providers === null) void catchUp.loadProviders();
  });
  useEffect(() => loadProviders(), [catchUp.status, catchUp.agentsLoaded, catchUp.agents.length, noProviders]);
  useEffect(() => {
    if (welcome === "agent") loadModels();
  }, [welcome, loadModels]);
  const pickModel = async (scope: string, rt: Runtime, selection: ModelSelection) => {
    const { applied, error } = await catchUp.updateModel(rt, selection);
    if (error || !applied) return notice(`model: ${error ?? "the daemon did not return the applied model"}`);
    desk.setDeskModel(scope, applied.handle, applied.reasoning_effort);
    desk.models.used(applied.handle);
    const effort = applied.reasoning_effort ? ` · effort ${effortLabel(applied.reasoning_effort)}` : "";
    notice(
      `${isMainChat(rt.conversation_id) ? "the agent now runs on" : "this conversation now runs on"} ${modelName(modelList ?? null, applied.handle)}${effort}`,
    );
  };
  const [modelPickerTick, setModelPickerTick] = useState(0);
  const [modeMenuTick, setModeMenuTick] = useState(0);
  const [suggestionsTick, setSuggestionsTick] = useState(0);
  const pickMode = async (scope: string, rt: Runtime, mode: string) => {
    const err = await catchUp.setMode(rt, mode);
    if (err) return notice(`permissions: ${err}`);
    desk.setDeskMode(scope, mode);
    notice(`permissions for this conversation: ${mode === "acceptEdits" ? "accept edits" : mode}`);
  };
  const [chatPrefill, setChatPrefill] = useState<{ text: string; tick: number } | null>(null);

  const desksRef = useRef(desk.desks);
  useEffect(() => {
    desksRef.current = desk.desks;
  });
  const openSearch = useCallback((scope: CommandScope = "all") => {
    desksRef.current.request();
    setSearchScope(scope);
    setSearchOpen(true);
  }, []);
  useEffect(() => takeCommandCenter(openSearch), [openSearch]);
  const switchTo = desk.desks.switchTo;
  const paneOpen = pane.open;
  const deskList = desk.desks.list;
  const agentList = catchUp.agents;
  const openDesk = useCallback(
    (agentId: string, conversationId: string, _opts: { chat?: boolean } = {}) => {
      const scope = scopeFor(conversationId, agentId);
      const to = openIn({ scope, agent_id: agentId }, { source: chatSource, query: sidebarQuery }, deskList, agentList);
      setChatSource(to.source);
      setSidebarQuery(to.query);
      const rows = sourceRows(deskList, catchUp.items, { source: to.source, query: to.query, agents: agentList });
      if (!stateRows(rows, chatState).some((r) => r.desk.scope === scope)) setChatState("all");
      setUnselected(false);
      switchTo(scope);
      paneOpen(scope);
      setSegment("desk");
      setNewChat(null);
      setFocusChat((n) => n + 1);
    },
    [setSegment, paneOpen, switchTo, chatSource, chatState, sidebarQuery, deskList, agentList, catchUp.items],
  );
  const beginLesson = (agentId: string, conversationId: string, brief: string, title: string) => {
    openDesk(agentId, conversationId, { chat: true });
    catchUp.send({ agent_id: agentId, conversation_id: conversationId }, brief, [], { desk: title, origin: "lesson" });
  };

  const recall = useRecall(desk, segment, notice);
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  const [keysOpen, setKeysOpen] = useState(false);

  const startNewChat = (agentId: string | null) => {
    setNewChat((was) => ({ agentId, n: (was?.n ?? 0) + 1 }));
    setPrefsOpen(false);
    setSegment("desk");
  };
  const queueFirst = useFirstMessage(desk.scope, desk.connection, (m) =>
    catchUp.send(m.runtime, m.text, m.images, { desk: null, labels: null, origin: "desk" }),
  );
  const startChat = async ({ agentId, folder, home, text, images }: { agentId: string; folder: string; home?: string; text: string; images: Attachment[] }) => {
    const rt = await catchUp.createDesk(agentId, folder, "", home);
    queueFirst({ scope: scopeFor(rt.conversation_id, rt.agent_id), runtime: rt, text, images });
    openDesk(rt.agent_id, rt.conversation_id, { chat: true });
  };

  const waiting = catchUpQueue(catchUp.flow.laneItems).length;
  const toggleInbox = useCallback(() => setSegmentRaw((s) => (s === "inbox" ? "desk" : "inbox")), []);
  useTray(waiting, toggleInbox);
  useEffect(() => {
    sessionStorage.setItem(SEGMENT_KEY, segment);
  }, [segment]);
  useWindowTitle(desk, prefsOpen ? "settings" : segment, waiting, recall.due, catchUp.flow.lane?.name ?? null, laneUntil);

  const linkUp = useEffectEvent(() => {
    desk.desks.request();
    desk.phone.refresh();
  });
  useEffect(() => {
    if (desk.connection === "open") linkUp();
  }, [desk.connection]);
  const [landed, setLanded] = useState(false);
  const where = landed
    ? null
    : landing({
        scope: desk.scope,
        onChats: segment === "desk" && newChat === null,
        ready: desk.desks.loaded && catchUp.status === "open" && catchUp.agentsLoaded,
        desks: desk.desks.list,
        waiting,
      });
  const whereKey = where ? landingKey(where) : null;
  const land = useEffectEvent(() => {
    if (!where) return;
    setLanded(true);
    if (where.kind === "flow") setSegment("inbox");
    else if (where.kind === "chat") {
      setChatSource(where.source);
      setUnselected(false);
      desk.desks.switchTo(where.scope);
      pane.open(where.scope);
    }
  });
  useEffect(() => {
    if (!whereKey) return;
    const frame = requestAnimationFrame(() => land());
    return () => cancelAnimationFrame(frame);
  }, [whereKey]);
  useEffect(() => {
    if (segment === "desk") {
      if (desk.scope !== "shared") recentPlaces.add(deskPlace(desk.scope));
    } else if (segment !== "settings") recentPlaces.add(sectionPlace(segment));
  }, [segment, desk.scope]);
  const placeOwners: Partial<Record<Segment, ReactNode>> = {
    inbox: (
      <InboxView
        desk={desk}
        catchUp={catchUp}
        notice={notice}
        models={modelList}
        onLoadModels={loadModels}
        onPickModel={pickModel}
        onPickMode={pickMode}
        onOpenDesk={openDesk}
        onClose={() => setSegment("desk")}
        onPass={(pass) => capture("inbox_pass_completed", pass)}
        kind={flowKind}
        onKind={setFlowKind}
      />
    ),
    agents: (
      <AgentsView
        desk={desk}
        catchUp={catchUp}
        onOpenDesk={openDesk}
        onAskToUpdate={(agentId, text) => {
          openDesk(agentId, MAIN_CHAT_ID, { chat: true });
          setChatPrefill({ text, tick: Date.now() });
        }}
        onShowDesks={() => setSegment("desk")}
      />
    ),
    learn: <RecallView recall={recall} active={!searchOpen} onOpenDesk={openDesk} onBegin={beginLesson} />,
  };
  const placeOwner = placeOwners[segment];
  const agentsState = useAgentsSelection();
  const hasList = segment === "desk" || (segment === "agents" ? agentsHasList(agentsState, agentList.length) : placeOwner !== undefined);
  const [listSlot, setListSlot] = useState<HTMLElement | null>(null);
  const [detailSlot, setDetailSlot] = useState<HTMLElement | null>(null);
  const column = useColumn(segment, hasList);
  const { layout } = column;
  const sources = useMemo(() => chatSources(deskList, catchUp.items, agentList), [deskList, catchUp.items, agentList]);
  const allWaiting = sources.reduce((n, x) => (x.agentId ? n + x.waiting : n), 0);
  const source =
    chatSource === ALL_CHATS
      ? { id: ALL_CHATS, title: "All Chats", agentId: null, waiting: allWaiting }
      : (sources.find((x) => x.id === chatSource) ?? { id: ALL_CHATS, title: "All Chats", agentId: null, waiting: allWaiting });
  const filtering = chatSource !== ARCHIVED_CHATS;
  const shownState: ChatState = filtering ? chatState : "all";
  const chatRows = useMemo(
    () => stateRows(sourceRows(deskList, catchUp.items, { source: source.id, query: sidebarQuery, agents: agentList }), shownState),
    [deskList, catchUp.items, source.id, sidebarQuery, agentList, shownState],
  );
  const chooseSource = (id: string) => {
    column.dismiss();
    setChatSource(id);
    setPrefsOpen(false);
    setSegment("desk");
    const open = deskList.find((d) => d.scope === desk.scope);
    setUnselected(!open || !sourceHolds(id, open));
  };
  const lanes = flowSources(catchUp.items, catchUp.flow.lane, catchUp.flow.lanes, (lane) => catchUp.flow.setLaneId(lane?.id ?? ""));
  const chooseLane = (id: string) => {
    column.dismiss();
    setPrefsOpen(false);
    setSegment("inbox");
    lanes.onSelect(id);
  };
  const agentPlaces = agentSources({
    agents: agentList,
    desks: deskList,
    items: catchUp.items,
    initialAgentId: desk.agentId,
    state: agentsState,
    face: (agentId, name) => <AgentFace name={name} src={avatarUrl(agentId)} size={16} />,
  });
  const chooseAgent = (id: string) => {
    column.dismiss();
    setPrefsOpen(false);
    setSegment("agents");
    agentPlaces.onSelect(id);
  };
  const [learnView, setLearnView] = useLearnView();
  const learnPlaces = learnSources({ snap: recall.snap, due: recall.due, view: learnView, onView: setLearnView });
  const chooseView = (id: string) => {
    column.dismiss();
    setPrefsOpen(false);
    setSegment("learn");
    learnPlaces.onSelect(id);
  };
  const chooseChatState = (state: ChatState) => {
    setChatState(state);
    const rows = stateRows(sourceRows(deskList, catchUp.items, { source: source.id, query: sidebarQuery, agents: agentList }), state);
    setUnselected(!rows.some((r) => r.desk.scope === desk.scope));
  };
  const showLabel = (name: string) => {
    chooseSource(ALL_CHATS);
    setSidebarQuery(`label:${name}`);
  };
  const drafting = newChat !== null && segment === "desk";
  const onChat = segment === "desk" && !drafting;
  const noChat = desk.scope === SHARED_SCOPE || unselected;
  const listSelected = noChat ? null : desk.scope;
  const sidebarShown = layout.sidebarShown;
  const leadRoom = sidebarShown && !layout.sidebarOver ? 0 : sidebarLeadRoom();
  const lead = (on: boolean) => (on && leadRoom ? { "data-lead": "", style: { "--loki-lead": `${leadRoom}px` } as CSSProperties } : { style: {} });
  const listLead = lead(layout.listShown);
  const detailLead = lead(!layout.listShown);
  const sidebarLayer = layout.sidebarOver ? 1 : undefined;
  const settingsWindow = SETTINGS_WINDOW;
  const showPreferences = (page?: string | null) => {
    if (settingsWindow) return openSettingsWindow(page);
    if (page) sessionStorage.setItem(SETTINGS_PAGE_KEY, page);
    setPrefsOpen(true);
  };
  const working = chatWorking(catchUp.items);
  const updateLabel = updateItemLabel(update.status);
  const chatKey = (id: string, run: (inset: boolean) => void) => {
    const to = chatKeyTarget(id, pane.tab);
    if (to) run(to === "inset");
  };

  const selectChat = (scope: string) => {
    desk.desks.switchTo(scope);
    pane.open(scope);
    setSegment("desk");
    setNewChat(null);
    setUnselected(false);
  };
  const enterChat = () => setFocusChat((n) => n + 1);
  const chatList = useRef<ContentListHandle>(null);
  const chatSlot = useRef<HTMLDivElement>(null);
  const listColumn = useRef<HTMLDivElement>(null);
  const toList = () => {
    if (!layout.listShown) return;
    listStop(segment === "desk" ? chatSlot.current : listSlot)?.focus();
  };

  const segmentKey = (id: string) => {
    if (settingsWindow && id === "segment.settings") return openSettingsWindow();
    const next = afterSegmentKey(id, { segment, preferences: prefsOpen });
    setPrefsOpen(next.preferences);
    setSegment(next.segment);
  };
  useShellKeys(
    { segment },
    {
      "segment.desk": () => segmentKey("segment.desk"),
      "segment.inbox": () => segmentKey("segment.inbox"),
      "segment.learn": () => segmentKey("segment.learn"),
      "segment.agents": () => segmentKey("segment.agents"),
      "segment.settings": () => segmentKey("segment.settings"),
      "search.open": () => (searchOpen ? setSearchOpen(false) : openSearch()),
      "desk.new": () => startNewChat(source.agentId),
      "keys.sheet": () => setKeysOpen((v) => !v),
      "desk.prev": () => chatList.current?.step(-1),
      "desk.next": () => chatList.current?.step(1),
      "column.toggle": () => {
        if (column.has) column.toggle();
      },
      "list.toggle": () => {
        if (layout.listShown)
          leaveList(listColumn.current, document.querySelector("main"), document.activeElement instanceof HTMLElement ? document.activeElement : null);
        column.toggleList();
      },
      "window.hide": () => {
        if (inTauri) hideCurrentWindow();
      },
      "chat.toggle": () => chatKey("chat.toggle", () => setChatOpen((v) => !v)),
      "chat.close": () => chatKey("chat.close", () => setChatOpen(false)),
      "chat.focus": () => chatKey("chat.focus", (inset) => (inset && setChatOpen(true), setFocusChat((n) => n + 1))),
      "chat.find": () => chatKey("chat.find", (inset) => (inset && setChatOpen(true), setFindChat((n) => n + 1))),
      "chat.allow": () => setDecideChat((d) => ({ n: d.n + 1, behavior: "allow" })),
      "chat.deny": () => setDecideChat((d) => ({ n: d.n + 1, behavior: "deny" })),
      "chat.model": () => chatKey("chat.model", (inset) => (inset && setChatOpen(true), setModelPickerTick((n) => n + 1))),
      "chat.mode": () => chatKey("chat.mode", (inset) => (inset && setChatOpen(true), setModeMenuTick((n) => n + 1))),
      "chat.suggestions": () => chatKey("chat.suggestions", (inset) => (inset && setChatOpen(true), setSuggestionsTick((n) => n + 1))),
      "chat.left": () => chatKey("chat.left", () => chat.moveChat(-1)),
      "chat.right": () => chatKey("chat.right", () => chat.moveChat(1)),
      "app.update": () => runUpdateItem(update, working, () => showPreferences("loki")),
    },
    { toList, toMessages: pane.escape, closePreferences: () => setPrefsOpen(false) },
    { "app.update": updateLabel },
  );

  const searchSources = useMemo(
    () => ({ desks: desk.desks.list, agents: catchUp.agents, items: catchUp.items, labels: catchUp.labels.list }),
    [desk.desks.list, catchUp.agents, catchUp.items, catchUp.labels.list],
  );
  const openHit = ({ target: t }: SearchHit) => {
    setSearchOpen(false);
    if (t.kind === "preferences") return showPreferences(t.page);
    setPrefsOpen(false);
    if (t.kind === "label") return showLabel(t.name);
    if (t.kind === "desk") return openDesk(t.agentId, t.conversationId);
    if (t.kind === "agent") {
      agentsSelection.pickAgent(t.agentId);
      return setSegment("agents");
    }
    setSegment(t.segment);
  };

  return (
    <div className="loki-shell" style={{ position: "relative", height: "100%", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div
          aria-hidden
          className="loki-shell-glass glass"
          data-empty={!sidebarShown ? "" : undefined}
          style={{
            position: "absolute",
            zIndex: sidebarLayer,
            left: GLASS_INSET,
            top: GLASS_INSET,
            bottom: GLASS_INSET,
            width: sidebarShown ? column.sidebar : 0,
            borderRadius: "var(--radius-xl)",
          }}
        />
        <TitleStrip menuLabels={{ "app.update": updateLabel }} />
        {column.has && (
          <span
            style={{
              position: "absolute",
              top: sidebarToggleTop(),
              left: sidebarShown ? sidebarToggleLeftShown(column.sidebar) : sidebarToggleLeft(),
              zIndex: 2,
            }}
            className="flex gap-1"
          >
            <ColumnToggle open={column.open} onToggle={column.toggle} />
            {!inTauri && <TitleMenu className="loki-browser-menu" labels={{ "app.update": updateLabel }} />}
          </span>
        )}

        <ListColumn
          shown={sidebarShown}
          width={column.sidebar}
          onWidth={column.setSidebar}
          layer={sidebarLayer}
          left={GLASS_INSET}
          top={GLASS_INSET + GLASS_HEAD}
          head={
            <Places
              segment={segment}
              onSelect={(s) => {
                column.dismiss();
                setSegment(s);
              }}
              waiting={waiting}
              dueCards={recall.due}
              sources={{
                desk: {
                  items: [
                    { id: ALL_CHATS, title: "All Chats", icon: "desk", count: allWaiting },
                    ...sources
                      .filter((x) => x.id === PINNED_CHATS || x.id === ARCHIVED_CHATS)
                      .map((x) => ({ id: x.id, title: x.title, icon: x.id === PINNED_CHATS ? ("pin" as const) : ("archive" as const), count: x.waiting })),
                  ],
                  selected: source.id,
                  onSelect: chooseSource,
                },
                inbox: { ...lanes, onSelect: chooseLane },
                agents: { ...agentPlaces, onSelect: chooseAgent },
                learn: { ...learnPlaces, onSelect: chooseView },
              }}
            />
          }
        />

        <div
          ref={listColumn}
          className="loki-list-column"
          aria-hidden={!layout.listShown}
          data-lead={listLead["data-lead"]}
          style={{
            ...listLead.style,
            position: "absolute",
            top: paneTop(),
            left: layout.listLeft,
            width: Math.max(layout.list, LIST_MIN),
            bottom: 0,
            visibility: layout.listShown ? "visible" : "hidden",
          }}
        >
          <div
            ref={chatSlot}
            className="loki-list-column-slot"
            style={{ position: "absolute", inset: 0, visibility: segment === "desk" ? undefined : "hidden" }}
          >
            <ChatListView
              ref={chatList}
              desk={desk}
              catchUp={catchUp}
              notice={notice}
              rows={chatRows}
              stateFilter={filtering ? { state: chatState, onState: chooseChatState } : undefined}
              source={source}
              selected={listSelected}
              shown={segment === "desk"}
              onSelect={selectChat}
              onEnter={enterChat}
              onNew={startNewChat}
              query={sidebarQuery}
              onQuery={setSidebarQuery}
              drafting={drafting}
            />
          </div>
          <div ref={setListSlot} className="loki-list-column-slot" style={{ position: "absolute", inset: 0, pointerEvents: placeOwner ? undefined : "none" }} />
          {layout.listShown && <ColumnEdge label="Resize list" min={LIST_MIN} max={LIST_MAX} width={layout.list} onWidth={column.setList} />}
        </div>

        <main
          data-lead={detailLead["data-lead"]}
          style={{ ...detailLead.style, position: "absolute", top: paneTop(), left: layout.detailLeft, right: 0, bottom: 0 }}
        >
          {(hasList || placeOwner !== undefined) && <div ref={setDetailSlot} style={{ position: "absolute", inset: 0 }} />}
          <PlaceSlotsProvider slots={{ list: listSlot, detail: detailSlot }}>{placeOwner}</PlaceSlotsProvider>
          <div style={{ position: "absolute", inset: 0, visibility: onChat && !noChat ? "visible" : "hidden" }} aria-hidden={!onChat || noChat}>
            <DeskPane
              desk={desk}
              onOpenChat={openDesk}
              catchUp={catchUp}
              active={onChat && !unselected}
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
              decideChat={decideChat}
              chatPrefill={chatPrefill}
              models={modelList}
              onLoadModels={loadModels}
              onPickModel={pickModel}
              modelPickerTick={modelPickerTick}
              onPickMode={pickMode}
              modeMenuTick={modeMenuTick}
              suggestionsTick={suggestionsTick}
              onShowLabel={showLabel}
            />
          </div>

          {onChat && noChat && (
            <EmptyPane icon="desk" title="No Chat Selected" style={{ position: "absolute", inset: 0 }}>
              <p className="loki-meta">Choose a chat in the list, or start one.</p>
              <div>
                <Button tone="positive" onClick={() => startNewChat(null)}>
                  New Chat
                </Button>
              </div>
            </EmptyPane>
          )}

          {drafting && (
            <div style={{ position: "absolute", inset: 0 }}>
              <NewChat
                key={newChat.n}
                agents={catchUp.agents}
                avatar={avatarUrl}
                defaultAgentId={newChat.agentId ?? desk.agentId}
                currentAgentId={desk.agentId}
                currentConversationKey={desk.conversationId ? conversationDirName(desk.conversationId, desk.agentId) : null}
                folders={desk.attention.folders}
                macs={desk.macs.view}
                requirements={desk.attention.requirements}
                onStart={startChat}
                onClose={() => setNewChat(null)}
                focusTick={newChat.n + focusChat}
              />
            </div>
          )}

          {welcome && !prefsOpen && (
            <WelcomeView
              step={welcome}
              catchUp={catchUp}
              daemon={daemon.status}
              onRetryDaemon={daemon.retry}
              onInstallTools={daemon.installTools}
              models={modelList}
              onLoadModels={loadModels}
              onModelsChanged={forgetModels}
              onDone={(agentId) => openDesk(agentId, MAIN_CHAT_ID, { chat: true })}
            />
          )}
        </main>
      </div>

      {searchOpen && (
        <SearchSheet
          sources={searchSources}
          here={segment === "desk" ? deskPlace(desk.scope) : segment === "settings" ? null : sectionPlace(segment)}
          avatar={avatarUrl}
          onOpen={openHit}
          onClose={() => setSearchOpen(false)}
          scope={searchScope}
          onScope={setSearchScope}
          models={sharedModels}
          commands={commandsFor(segment)}
          onCommand={(id) => void runAction(id)}
        />
      )}
      {keysOpen && <KeysSheet segment={segment} onClose={() => setKeysOpen(false)} onSettings={() => (setKeysOpen(false), showPreferences("keys"))} />}
      {prefsOpen && (
        <SettingsView
          onClose={() => setPrefsOpen(false)}
          update={update}
          shortcut={shortcut}
          recall={recall}
          desk={desk}
          catchUp={catchUp}
          daemon={daemon.status}
          chatWidth={chat.chatWidth}
          onChatWidth={chat.setChatWidth}
          chatPlacement={chat.chatPlacement}
          onChatPlacement={chat.setChatPlacement}
          onModelsChanged={forgetModels}
        />
      )}
      <Notices />
      <RestartNotice due={desk.daemon.restartDue} restart={desk.daemon.restart} />
      <UpdateNotice update={update} working={working} />
    </div>
  );
}
