import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Button, EmptyPane, Notices, notify } from "../components";
import { RestartNotice } from "./restart-notice";
import { SHARED_SCOPE, conversationDirName, scopeFor } from "../../../core/desk-core.ts";
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
import { AgentsColumn } from "../agents/agents-column";
import { LearnColumn } from "../recall/learn-column";
import { FlowColumn } from "../desk/flow-column";
import { useDaemonStatus, type DaemonStatus } from "./bootstrap";
import { welcomeStep } from "../settings/provider-model";
import { afterSegmentKey } from "../settings/preferences";
import { ColumnToggle, GLASS_HEAD, GLASS_INSET, Places, sidebarToggleLeft, sidebarToggleTop, TitleStrip, TITLEBAR_HEIGHT, UpdateRow } from "./sidebar";
import { commandsFor, runAction, type Segment } from "./keymap";
import { useModelList } from "./use-model-list";
import { hideCurrentWindow, useTray, useWindowTitle } from "./use-window-chrome";
import { useChatLayout } from "./use-chat-layout";
import { useRecall } from "./use-recall";
import { useLokiUpdate } from "./use-loki-update";
import { useGlobalShortcut } from "./use-global-shortcut";
import { useShellKeys } from "./use-shell-keys";
import { KeysSheet } from "./keys-sheet";
import { useColumn } from "./use-column";
import { ListColumn } from "./list-column";
import { DeskSidebarView } from "./desk-sidebar";
import { AgentsView, InboxView, SettingsView, WelcomeView, RecallView } from "./views";
import { SearchSheet } from "./search-sheet";
import { takeCommandCenter, useSharedModels, type CommandScope } from "./command-center";
import { deskPlace, recentPlaces, sectionPlace, type SearchHit } from "./search-model";
import { agentsSelection } from "../agents/selection";
import { SETTINGS_PAGE_KEY } from "../settings/pages";
import type { CatchUp, Runtime } from "./types";
import { effortLabel, modelName } from "../chat/model-picker";
import type { ModelSelection } from "../../../core/models.ts";
import { useShellAttention } from "./use-shell-attention";
import { MODELS_CHANGED_KEY, openSettingsWindow, SETTINGS_WINDOW } from "./settings-window";
import { useStorageKey } from "../shared/use-storage-key";

const SEGMENT_KEY = "loki.segment";

/** The segment survives a reload of the same window; a refresh mid-pass reopens the inbox. Settings is a sheet now, not a segment: a saved "settings" lands on the desk. */
function savedSegment(): Segment {
  const s = sessionStorage.getItem(SEGMENT_KEY);
  return s === "inbox" || s === "agents" || s === "learn" ? s : "desk";
}

/** First launch: nothing to talk to yet. Only while the daemon could not start, or has answered and lists no agents. */
function welcomeFor(
  daemon: DaemonStatus | null,
  catchUp: Pick<CatchUp, "status" | "agentsLoaded" | "agents" | "providers">,
): "node" | "provider" | "agent" | null {
  return daemon?.error && catchUp.status !== "open"
    ? "node" // the daemon could not start (no new-enough Node, or another reason) and nothing answers
    : catchUp.status === "open" && catchUp.agentsLoaded
      ? welcomeStep({ agents: catchUp.agents.length, providers: catchUp.providers })
      : null;
}

/**
 * The window: loki's own top strip (the native title bar is hidden), a rail of segments under it, the
 * section's list column (ListColumn; Desk, Agents, Learn) and one view in the space they leave. The desk and attention models live here so the desk view, the
 * inbox, ⌘K search and settings all read the same state.
 */
export function Shell() {
  const desk = useDesk();
  const { attention } = desk;
  // Analytics (core/analytics.ts): every event the Mac sends carries the view on screen as $screen.
  const screenRef = useRef<Segment | null>(null);
  const { capture: captureRaw } = attention;
  const capture = useCallback(
    (event: string, properties?: Record<string, unknown>) => captureRaw(event, { ...(screenRef.current ? { $screen: screenRef.current } : {}), ...properties }),
    [captureRaw],
  );
  // This Mac's lane (plan 087): Flow, the sidebar, the window title, the dock and the tray count only its cards.
  const catchUp = useShellAttention(desk, capture);
  /** A line at the bottom of the window for four seconds (Notices). */
  const notice = (m: string) => void notify(m);
  // The inbox lists what is open on disk; when the sidebar or the desk header archives or restores a conversation, re-read it now rather than at the next minute.
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
  /** ⌘K (SearchSheet): a panel over whatever shows, on a scope (U23): everything, or the open chat's models. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScope, setSearchScope] = useState<CommandScope>("all");
  const sharedModels = useSharedModels();
  /** The Chats sidebar's filter, held here so a label chip or ⌘K can set it to `label:<name>` (plan 022, R4). */
  const [sidebarQuery, setSidebarQuery] = useState("");
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
  /**
   * ⌘N (plan 2026-11-12-1505, U20): a chat not started yet, shown in place of the open one. `n` counts
   * the asks, so asking again starts over on the agent asked for and puts the caret back in its box.
   */
  const [newChat, setNewChat] = useState<{ agentId: string | null; n: number } | null>(null);
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
  // Allow Step and Deny Step from the Chat menu or their keys: a counter with the answer, for the chat pane (U5).
  const [decideChat, setDecideChat] = useState<{ n: number; behavior: "allow" | "deny" }>({ n: 0, behavior: "allow" });
  const {
    list: modelList,
    load: loadModels,
    forget: forgetModels,
  } = useModelList({ open: catchUp.status === "open", version: catchUp.server?.version ?? "", listModels: catchUp.listModels, recent: desk.models.recent });
  // A provider connected or dropped in the Settings window (U18): this window's model list is asked for again.
  useStorageKey(MODELS_CHANGED_KEY, () => forgetModels());
  const daemon = useDaemonStatus();
  const welcome = welcomeFor(daemon.status, catchUp);
  const noProviders = catchUp.providers === null;
  const loadProviders = useEffectEvent(() => {
    if (catchUp.status === "open" && catchUp.agentsLoaded && catchUp.agents.length === 0 && catchUp.providers === null) void catchUp.loadProviders();
  });
  useEffect(() => loadProviders(), [catchUp.status, catchUp.agentsLoaded, catchUp.agents.length, noProviders]);
  // The first agent's form offers the model list; ask for it as soon as that step shows (Welcome's "skip" asks too).
  useEffect(() => {
    if (welcome === "agent") loadModels();
  }, [welcome, loadModels]);
  const pickModel = async (scope: string, rt: Runtime, selection: ModelSelection) => {
    const { applied, error } = await catchUp.updateModel(rt, selection);
    if (error || !applied) return notice(`model: ${error ?? "the daemon did not return the applied model"}`);
    desk.setDeskModel(scope, applied.handle, applied.reasoning_effort);
    desk.models.used(applied.handle);
    const effort = applied.reasoning_effort ? ` · effort ${effortLabel(applied.reasoning_effort)}` : "";
    // The model as the pill names it ("Claude Code", "claude-fable-5"), not the last part of its handle.
    notice(
      `${rt.conversation_id === "default" ? "the agent now runs on" : "this conversation now runs on"} ${modelName(modelList ?? null, applied.handle)}${effort}`,
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
  /** A request another view wants typed into the chat ("ask ira to update this"). */
  const [chatPrefill, setChatPrefill] = useState<{ text: string; tick: number } | null>(null);

  // Stable for the keymap and the rail, and always the current link's: desk.desks is a fresh object each render.
  const desksRef = useRef(desk.desks);
  useEffect(() => {
    desksRef.current = desk.desks;
  });
  const openSearch = useCallback((scope: CommandScope = "all") => {
    desksRef.current.request(); // the freshest desk titles to search
    setSearchScope(scope);
    setSearchOpen(true);
  }, []);
  // The model pill and ⌘⇧M open ⌘K on the open chat's models (command-center.ts).
  useEffect(() => takeCommandCenter(openSearch), [openSearch]);
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
      setNewChat(null);
      setFocusChat((n) => n + 1);
    },
    [setSegment, paneOpen, switchTo],
  );
  /** A lesson begins: the desk opens with the chat, and the brief goes out as the person's first message. */
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

  const recall = useRecall(desk, segment, notice);
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  /** The `?` cheat sheet for the view showing. */
  const [keysOpen, setKeysOpen] = useState(false);

  // A new chat opens in place and is created by its first message (plan 2026-11-12-1505, U20).
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
    // The message goes once the pane is on the new chat and its link is open (use-first-message.ts).
    queueFirst({ scope: scopeFor(rt.conversation_id, rt.agent_id), runtime: rt, text, images });
    openDesk(rt.agent_id, rt.conversation_id, { chat: true });
  };

  // The badges count the active lane's cards (R15); search, the sidebar and agents keep every card (R16).
  const waiting = catchUpQueue(catchUp.flow.laneItems).length;
  const toggleInbox = useCallback(() => setSegmentRaw((s) => (s === "inbox" ? "desk" : "inbox")), []);
  useTray(waiting, toggleInbox);
  useEffect(() => {
    sessionStorage.setItem(SEGMENT_KEY, segment);
  }, [segment]);
  useWindowTitle(desk, prefsOpen ? "settings" : segment, waiting, recall.due, catchUp.flow.lane?.name ?? null);

  // The desks list feeds the sidebar, search and ⌘[ ⌘]; ask for it once the mod link is up. The LAN listener's
  // status too, so the rail's green dot is right before Settings is ever opened.
  const linkUp = useEffectEvent(() => {
    desk.desks.request();
    desk.phone.refresh();
  });
  useEffect(() => {
    if (desk.connection === "open") linkUp();
  }, [desk.connection]);
  // A window with no chat to show lands somewhere real once it can tell where (plan 2026-11-14-1300, 1): Flow when
  // something waits, else the latest chat; with neither, the pane says "No Chat Selected". Once per window, so a person
  // who leaves a chat for nothing later is not moved.
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
  // As a string, so the effect below runs when the landing changes, not on every render's new object.
  const whereKey = where ? landingKey(where) : null;
  const land = useEffectEvent(() => {
    if (!where) return;
    setLanded(true);
    if (where.kind === "flow") setSegment("inbox");
    else if (where.kind === "chat") {
      desk.desks.switchTo(where.scope);
      pane.open(where.scope);
    }
  });
  useEffect(() => {
    if (!whereKey) return;
    // A landing is a navigation, made on the next frame once the window has painted what it has, and dropped if the
    // window moves on first.
    const frame = requestAnimationFrame(() => land());
    return () => cancelAnimationFrame(frame);
  }, [whereKey]);
  // Search's recent places: every desk opened and every section visited, not only what search opened.
  useEffect(() => {
    if (segment === "desk") {
      if (desk.scope !== "shared") recentPlaces.add(deskPlace(desk.scope));
    } else if (segment !== "settings") recentPlaces.add(sectionPlace(segment));
  }, [segment, desk.scope]);
  // The list column is the window's one sidebar (U12), beside every section, its places on top; the pane starts where it
  // ends.
  const column = useColumn(segment);
  /** A label's chats: the sidebar filtered to it, on Chats with its column open. */
  const showLabel = (name: string) => {
    setSidebarQuery(`label:${name}`);
    setPrefsOpen(false);
    setSegment("desk");
    if (!column.open) column.toggle();
  };
  // A chat not started yet shows in place of the open one, which stays mounted behind it and takes no keys meanwhile.
  const drafting = newChat !== null && segment === "desk";
  const onChat = segment === "desk" && !drafting;
  /** The window holds no chat: the desk's shared scope is the canvas's own, never a chat to draw. */
  const noChat = desk.scope === SHARED_SCOPE;
  // The sidebar stays on every tab, the Canvas one too, as Finder's does whatever the view (plan 2026-11-14-1130, 2);
  // ⌃⌘S folds it for a wider canvas.
  const columnShown = column.shown;
  // The sidebar floats GLASS_INSET in from the window's edges; hidden, the pane clears the lights and the toggle.
  const paneLeft = columnShown ? GLASS_INSET * 2 + column.width : sidebarToggleLeft() + 36;
  // In the Mac app Preferences is a window of its own (plan 2026-11-12-1505, U18); elsewhere the sheet.
  const settingsWindow = SETTINGS_WINDOW;
  const showPreferences = (page?: string | null) => {
    if (settingsWindow) return openSettingsWindow(page);
    if (page) sessionStorage.setItem(SETTINGS_PAGE_KEY, page);
    setPrefsOpen(true);
  };
  const openPrefs = () => showPreferences();
  /** A chat key acts on the view showing: Messages, or the Desk tab's inset (desk/pane.ts); the inset's own keys wait for its tab. */
  const chatKey = (id: string, run: (inset: boolean) => void) => {
    const to = chatKeyTarget(id, pane.tab);
    if (to) run(to === "inset");
  };

  /** ⌘1-6 and ⌘,: ⌘, (⌘6) toggles Preferences over the section; the others close it and go (settings/preferences.ts). */
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
      "desk.new": () => startNewChat(null),
      "keys.sheet": () => setKeysOpen((v) => !v),
      "desk.prev": () => stepDesk(-1),
      "desk.next": () => stepDesk(1),
      "column.toggle": () => {
        if (column.has) column.toggle();
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
    },
    { toDesk: () => setSegment("desk"), toMessages: pane.escape, closePreferences: () => setPrefsOpen(false) },
  );

  /** A desk chosen in the sidebar: an open, so its Messages tab with the box focused. */
  const switchDesk = (scope: string) => {
    desk.desks.switchTo(scope);
    pane.open(scope);
    setSegment("desk");
    setNewChat(null);
    setFocusChat((n) => n + 1);
  };

  /** A search result: its section, and for a desk or a waiting item the desk on Messages (search-model.ts SearchTarget). */
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
        {/* The sidebar (plan 2026-11-12-1505, U3): one glass panel, inset from the window's edge, under the list column,
            which goes clear over it (components.css). */}
        <div
          aria-hidden
          className="loki-shell-glass glass"
          data-empty={!columnShown ? "" : undefined}
          style={{
            position: "absolute",
            left: GLASS_INSET,
            top: GLASS_INSET,
            bottom: GLASS_INSET,
            width: columnShown ? column.width : 0,
            borderRadius: "var(--loki-radius-lg)",
          }}
        />
        <TitleStrip />
        {column.has && (
          <span style={{ position: "absolute", top: sidebarToggleTop(), left: sidebarToggleLeft(), zIndex: 2 }}>
            <ColumnToggle open={column.open} onToggle={column.toggle} />
          </span>
        )}

        <ListColumn
          segment={segment}
          shown={columnShown}
          width={column.width}
          onWidth={column.setWidth}
          left={GLASS_INSET}
          top={GLASS_INSET + GLASS_HEAD}
          head={<Places segment={segment} onSelect={setSegment} waiting={waiting} dueCards={recall.due} />}
          foot={update.newer ? <UpdateRow onOpen={openPrefs} /> : null}
          sections={{
            desk: (
              <DeskSidebarView
                desk={desk}
                catchUp={catchUp}
                notice={notice}
                onOpen={switchDesk}
                onNew={startNewChat}
                query={sidebarQuery}
                onQuery={setSidebarQuery}
                drafting={drafting}
              />
            ),
            agents: <AgentsColumn agents={catchUp.agents} desks={desk.desks.list} items={catchUp.items} avatar={avatarUrl} initialAgentId={desk.agentId} />,
            learn: <LearnColumn recall={recall} />,
            inbox: (
              <FlowColumn
                items={catchUp.items}
                lane={catchUp.flow.lane}
                lanes={catchUp.flow.lanes}
                onLane={(lane) => catchUp.flow.setLaneId(lane?.id ?? "")}
                onNewLane={() => showPreferences("inbox")}
              />
            ),
          }}
        />

        {/* The main pane: one main landmark for whichever section shows; the sidebar is the navigation. */}
        <main style={{ position: "absolute", top: TITLEBAR_HEIGHT, left: paneLeft, right: 0, bottom: 0 }}>
          {/* The desk pane stays mounted behind the other views so the desk link, the camera and the thread's scroll keep their state. */}
          <div style={{ position: "absolute", inset: 0, visibility: onChat && !noChat ? "visible" : "hidden" }} aria-hidden={!onChat || noChat}>
            <DeskPane
              desk={desk}
              catchUp={catchUp}
              active={onChat}
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

          {/* No chat to show: say so, as Messages and Mail do, rather than draw an empty room (plan 2026-11-14-1300, 1). */}
          {onChat && noChat && (
            <EmptyPane icon="desk" title="No Chat Selected" style={{ position: "absolute", inset: 0 }}>
              <span className="loki-meta">Choose a chat in the sidebar, or start one.</span>
              <Button tone="positive" onClick={() => startNewChat(null)}>
                New Chat
              </Button>
            </EmptyPane>
          )}

          {/* A chat not started yet takes the open chat's place (U20); keyed by the ask, so ⌘N again starts over. */}
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
                focusTick={newChat.n}
              />
            </div>
          )}

          {segment === "inbox" && (
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
            />
          )}

          {segment === "learn" && <RecallView recall={recall} active={!searchOpen} onOpenDesk={openDesk} onBegin={beginLesson} />}

          {segment === "agents" && (
            <AgentsView
              desk={desk}
              catchUp={catchUp}
              onOpenDesk={openDesk}
              onAskToUpdate={(agentId, text) => {
                openDesk(agentId, "default", { chat: true });
                setChatPrefill({ text, tick: Date.now() });
              }}
              onShowDesks={() => setSegment("desk")}
            />
          )}

          {welcome && !prefsOpen && (
            <WelcomeView
              step={welcome}
              catchUp={catchUp}
              daemon={daemon.status}
              onRetryDaemon={daemon.retry}
              models={modelList}
              onLoadModels={loadModels}
              onModelsChanged={forgetModels}
              onDone={(agentId) => openDesk(agentId, "default", { chat: true })}
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
      {/* Preferences covers the whole window, rail included, like Slack's. */}
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
    </div>
  );
}
