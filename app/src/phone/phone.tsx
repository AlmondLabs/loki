import { homesOf } from "../shell/desk-sidebar";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { WidgetSourceContext } from "../chat/use-inline-widgets";
import { useAttention } from "../../../core/attention/use-attention.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { modBase } from "../desk/env";
import { useDesk } from "../desk/use-desk";
import { resolveLane, useActiveLaneId } from "../shared/active-lane";
import { savePurpose } from "../desk/rename-desk";
import { AgentPage, FilePage } from "./agent-page";
import { Agents, knownDescription } from "./agents";
import { ConversationScreen, type Thread } from "./conversation-screen";
import { Archive } from "./archive";
import { Home, type ArchiveDesk, type RenameDeskName } from "./home";
import { canRename } from "../shell/sidebar-model";
import { Inbox, useDeck, type Deck } from "./inbox";
import { Pair, type Me } from "./pair";
import { More } from "./more";
import { Search } from "./search";
import { AboutPage, ConnectionPage, Preferences } from "./preferences";
import { UsageScreen } from "./usage";
import { Learn } from "./learn";
import { useRecall } from "../shell/use-recall";
import { useDeckPass } from "../recall/use-deck-pass";
import { TabBar } from "./tab-bar";
import { UpdateBar, useHealthBuild } from "./update-bar";
import { agentNameOf, archiveList, homeCounts, lastSeen, linkState, threadFor, type LinkState } from "./model";
import {
  HOME,
  back,
  backTarget,
  depthOf,
  formatRoute,
  labelOf,
  navigate,
  openConversation,
  replace,
  screenOf,
  showsNav,
  useRouteState,
  type Route,
  type Tab,
} from "./router";
import { draftKey } from "../shared/drafts";
import { nextPrefill, recentPlaces, useFocusOnRoute, type Prefill } from "./session";
import { useKeyboardInset } from "./viewport";
import { useEdgeSwipe } from "./edge-swipe";
import { useModelList } from "../shell/use-model-list";
import { conversationDirName, isMainChat, scopeFor } from "../../../core/desk-core.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import type { ModelSelection } from "../../../core/models.ts";
import type { ModelEntry } from "../chat/model-picker";
import { Banner, Button } from "../components";
import { pageActivity, pageVisibility } from "../shared/page-activity";
import "./phone.css";
import { useLaneFollower } from "../shared/lane-follower";

type Gate = { kind: "checking" } | { kind: "unpaired" } | { kind: "paired"; me: Me } | { kind: "unreachable" };

type DeskApi = ReturnType<typeof useDesk>;
type CatchUp = ReturnType<typeof useAttention>;
type ConversationRoute = Extract<Route, { kind: "conversation" }>;

const closeInbox = () => {
  if (depthOf(history.state) > 0) history.back();
  else replace(HOME, "pop");
};

export function Phone() {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const probe = useCallback(
    () =>
      fetch(`${modBase()}/me`, { credentials: "same-origin", cache: "no-store" })
        .then(async (r) => {
          if (r.ok) setGate({ kind: "paired", me: (await r.json()) as Me });
          else setGate({ kind: r.status === 401 ? "unpaired" : "unreachable" });
        })
        .catch(() => setGate({ kind: "unreachable" })),
    [],
  );
  useEffect(() => {
    void probe();
  }, [probe]);
  const check = () => {
    setGate({ kind: "checking" });
    void probe();
  };

  if (gate.kind === "checking")
    return (
      <Splash>
        <p className="loki-phone-body">Opening…</p>
      </Splash>
    );
  if (gate.kind === "unreachable")
    return (
      <Splash>
        <h1 className="loki-phone-large-title">The Mac did not answer</h1>
        <p className="loki-phone-body loki-phone-splash-line">Same Wi‑Fi, and loki open on the Mac with Preferences › Phone switched on.</p>
        <Button size="touch" tone="paper" onClick={check} className="loki-phone-splash-action">
          Try Again
        </Button>
      </Splash>
    );
  if (gate.kind === "unpaired") return <Pair onPaired={(me) => setGate({ kind: "paired", me })} />;
  return <Paired me={gate.me} onUnpaired={() => setGate({ kind: "unpaired" })} />;
}

function useLinkBanner(desk: DeskApi, catchUp: CatchUp, available: boolean): ReactNode {
  const linked = desk.connection === "open" && (catchUp.status === "open" || !available);
  const [lastLinked, setLastLinked] = useState<string | null>(null);
  const [, setTickNow] = useState(0);
  useEffect(() => {
    if (!linked) return;
    return () => setLastLinked(new Date().toISOString());
  }, [linked]);
  useEffect(() => {
    const t = setInterval(() => setTickNow((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const unreachable = desk.connection === "closed" || catchUp.status === "closed";
  return unreachable ? <Banner>Mac unreachable · last seen {lastSeen(lastLinked)}</Banner> : null;
}

function macAway(catchUp: CatchUp): string | null {
  return catchUp.status === "open" ? null : "Mac unreachable: these wait until it is back";
}

function useUnpairWatch(connection: DeskApi["connection"], onUnpaired: () => void) {
  const unpaired = useEffectEvent(() => onUnpaired());
  useEffect(() => {
    if (connection !== "closed") return;
    void fetch(`${modBase()}/me`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => {
        if (r.status === 401) unpaired();
      })
      .catch(() => {});
  }, [connection]);
}

function usePrefill(conv: ConversationRoute | null) {
  const convKey = conv ? draftKey(conv.agentId, conv.conversationId) : null;
  const prefillText = conv?.prefill ?? null;
  const [held, setHeld] = useState<Prefill | null>(null);
  const [arrived, setArrived] = useState<{ key: string | null; prefill: string | null; tick: number } | null>(null);
  if (arrived?.key !== convKey || arrived.prefill !== prefillText) {
    const tick = (arrived?.tick ?? 0) + 1;
    setArrived({ key: convKey, prefill: prefillText, tick });
    setHeld((h) => nextPrefill(h, conv, tick));
  }
  const tidyAddress = useEffectEvent(() => {
    if (conv?.prefill) replace({ ...conv, prefill: null });
  });
  useEffect(() => tidyAddress(), [convKey, prefillText]);
  return held?.key === convKey ? held : null;
}

function Paired({ me, onUnpaired }: { me: Me; onUnpaired: () => void }) {
  const desk = useDesk();
  const { attention } = desk;
  const screenRef = useRef<string | null>(null);
  const { capture: captureRaw } = attention;
  const capture = useCallback(
    (event: string, properties?: Record<string, unknown>) => captureRaw(event, { ...(screenRef.current ? { $screen: screenRef.current } : {}), ...properties }),
    [captureRaw],
  );
  const [laneId, setLaneId] = useActiveLaneId("phone");
  const catchUp = useAttention({
    lane: { id: laneId, setId: setLaneId, lanes: attention.lanes, setLanes: null, resolve: resolveLane },
    enabled: attention.available,
    makeClient: attention.makeClient,
    seen: attention.seen,
    viewed: attention.viewed,
    focus: attention.focus,
    engage: attention.engage,
    rests: attention.rests,
    rest: attention.rest,
    returnTimes: attention.returnTimes,
    markSeen: attention.markSeen,
    unmarkSeen: attention.unmarkSeen,
    loadLocalHistory: attention.loadHistory,
    loadLocalStep: attention.loadStep,
    listConversations: attention.listInbox,
    capture,
    sent: (rt) => desk.models.sentIn(rt.conversation_id, rt.agent_id),
    activity: pageActivity,
    visibility: pageVisibility,
  });
  useLaneFollower("phone", catchUp.flow);
  const { route, from, arrival } = useRouteState();
  const routeView = screenOf(route);
  const prevView = useRef<string | null>(null);
  useEffect(() => {
    if (prevView.current !== null && prevView.current !== routeView) capture("view_opened", { view: routeView, from: prevView.current });
    prevView.current = routeView;
    screenRef.current = routeView;
  }, [routeView, capture]);

  useEffect(() => {
    if (new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname + location.hash);
  }, []);

  const requestDesks = useEffectEvent(() => desk.desks.request());
  useEffect(() => {
    if (desk.connection === "open") requestDesks();
  }, [desk.connection]);

  const banner = useLinkBanner(desk, catchUp, attention.available);
  const models = useModelList({
    open: catchUp.status === "open",
    version: catchUp.server?.version ?? "",
    listModels: catchUp.listModels,
    recent: desk.models.recent,
  });
  useUnpairWatch(desk.connection, onUnpaired);

  const waiting = catchUpQueue(catchUp.flow.laneItems).length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) loki` : "loki";
  }, [waiting]);

  const deck = useDeck(catchUp.flow.laneItems, catchUp.items);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const recall = useRecall(desk, route.kind === "learn" ? "learn" : "desk", (m) => setRecallNote(m));
  const learnPass = useDeckPass(recall.snap?.cards ?? []);
  useEffect(() => {
    if (!recallNote) return;
    const t = setTimeout(() => setRecallNote(null), 4000);
    return () => clearTimeout(t);
  }, [recallNote]);
  const loadTopThread = useEffectEvent(() => {
    if (deck.current) void catchUp.loadHistory(deck.current);
  });
  useEffect(() => loadTopThread(), [deck.currentId]);

  const beginLesson = (agentId: string, conversationId: string, brief: string, title: string) => {
    openConversation(agentId, conversationId);
    catchUp.send({ agent_id: agentId, conversation_id: conversationId }, brief, [], { desk: title, origin: "lesson" });
  };

  const conv = route.kind === "conversation" ? route : null;
  const prefill = usePrefill(conv);

  const foldersRef = useRef(attention.folders);
  useEffect(() => {
    foldersRef.current = attention.folders;
  });
  const recentFolders = useCallback(() => foldersRef.current.recent().then((r) => r.byAgent), []);
  const tab = route.kind === "tab" ? route.tab : null;
  const nav = showsNav(route) && !(tab === "inbox" && deck.current);
  const inboxFrom = tab === "inbox" && from && formatRoute(from) !== formatRoute(route) ? from : HOME;

  const onBack = () => back(route);
  const backLabel = labelOf(backTarget(route, from));

  const place = formatRoute(conv ? { ...conv, prefill: null } : route);
  const shellRef = useRef<HTMLDivElement>(null);
  useFocusOnRoute(shellRef, place, arrival === "pop");
  useKeyboardInset(shellRef);
  useEdgeSwipe(shellRef, route.kind !== "tab", onBack);
  useEffect(() => {
    if (route.kind !== "tab" && route.kind !== "search") recentPlaces.add(place);
  }, [place, route.kind]);

  const onArchive: ArchiveDesk | null =
    attention.available && catchUp.status === "open"
      ? async (d, archived) => {
          if (!d.conversation_id) return "This chat has no conversation";
          const err = await catchUp.archiveConversation(d.conversation_id, archived, "phone_list", d.agent_id ?? undefined);
          if (!err) desk.desks.request();
          return err;
        }
      : null;
  const onRename: RenameDeskName | null =
    attention.available && catchUp.status === "open"
      ? async (d, name) => {
          if (!d.conversation_id) return "This chat has no conversation";
          const err = await catchUp.renameConversation(d.conversation_id, name);
          if (err) return err;
          desk.setDeskTitle(d.scope, name);
          desk.desks.request();
          return null;
        }
      : null;

  const link = linkState(desk.connection);
  const searchSources = useMemo(
    () => ({ desks: desk.desks.list, agents: catchUp.agents, items: catchUp.items, describe: knownDescription }),
    [desk.desks.list, catchUp.agents, catchUp.items],
  );
  const health = useHealthBuild();
  const update = <UpdateBar servedBuild={desk.servedBuild} health={health} />;
  return (
    <WidgetSourceContext.Provider value={desk}>
      <div ref={shellRef} className="loki-phone loki-phone-shell" data-screen={route.kind}>
        <main className="loki-phone-main">
          {conv && (
            <ConversationPage
              conv={conv}
              desk={desk}
              catchUp={catchUp}
              onRename={onRename}
              onArchive={onArchive}
              models={models.list}
              onLoadModels={models.load}
              banner={banner}
              backLabel={backLabel}
              onBack={onBack}
              prefill={prefill}
            />
          )}
          {route.kind === "learn" && (
            <Learn
              view={route.view}
              recall={recall}
              pass={learnPass}
              banner={recallNote ? <Banner>{recallNote}</Banner> : banner}
              backLabel={backLabel}
              onBack={onBack}
              onBegin={beginLesson}
              onOpen={openConversation}
            />
          )}
          {route.kind === "search" && (
            <Search
              q={route.q ?? ""}
              fresh={arrival !== "pop"}
              sources={searchSources}
              link={link}
              loaded={catchUp.agentsLoaded}
              backLabel={backLabel}
              onBack={onBack}
            />
          )}
          {route.kind === "archive" && (
            <Archive
              desks={desk.desks.list}
              loaded={desk.desks.loaded}
              banner={banner}
              backLabel={backLabel}
              onBack={onBack}
              onArchive={onArchive}
              onRename={onRename}
            />
          )}
          {route.kind === "preferences" && <Preferences banner={banner} backLabel={backLabel} onBack={onBack} />}
          {route.kind === "usage" && <UsageScreen usage={{ ...desk.usage, agents: catchUp.agents }} banner={banner} backLabel={backLabel} onBack={onBack} />}
          {route.kind === "connection" && (
            <ConnectionPage me={me} link={link} modLink={desk.connection} banner={banner} onUnpaired={onUnpaired} backLabel={backLabel} onBack={onBack} />
          )}
          {route.kind === "about" && <AboutPage servedBuild={desk.servedBuild} banner={banner} backLabel={backLabel} onBack={onBack} />}
          {route.kind === "agent" && (
            <AgentPage
              agentId={route.agentId}
              name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)}
              desks={desk.desks.list}
              items={catchUp.items}
              api={desk.agents}
              banner={banner}
              backLabel={backLabel}
              onBack={onBack}
            />
          )}
          {route.kind === "file" && (
            <FilePage
              agentId={route.agentId}
              path={route.path}
              name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)}
              api={desk.agents}
              banner={banner}
              onBack={onBack}
            />
          )}

          <Screen
            tab={tab}
            me={me}
            link={link}
            desk={desk}
            catchUp={catchUp}
            deck={deck}
            due={recall.due}
            banner={banner}
            recentFolders={recentFolders}
            onArchive={onArchive}
            onRename={onRename}
            inboxBack={labelOf(inboxFrom)}
            models={models.list}
            onLoadModels={models.load}
          />
        </main>

        {nav ? (
          <TabBar active={tab} waiting={waiting}>
            {update}
          </TabBar>
        ) : (
          update
        )}
      </div>
    </WidgetSourceContext.Provider>
  );
}

function ConversationPage({
  conv,
  desk,
  catchUp,
  onRename,
  onArchive,
  models,
  onLoadModels,
  banner,
  backLabel,
  onBack,
  prefill,
}: {
  conv: ConversationRoute;
  desk: DeskApi;
  catchUp: CatchUp;
  onRename: RenameDeskName | null;
  onArchive: ArchiveDesk | null;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
  banner: ReactNode;
  backLabel: string;
  onBack: () => void;
  prefill: { text: string; tick: number } | null;
}) {
  const { attention } = desk;
  const convDesk = desk.desks.list.find((d) => d.agent_id === conv.agentId && d.conversation_id === conv.conversationId);
  const thread: Thread = threadFor(conv, desk.desks.list, catchUp.items, catchUp.agents);
  const item = catchUp.items.find((i) => i.agent_id === thread.agentId && i.id === thread.conversationId) ?? null;
  const scope = scopeFor(thread.conversationId, thread.agentId);
  const view = catchUp.conversation(thread.agentId, thread.conversationId);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  const pickModel = async (rt: Runtime, selection: ModelSelection) => {
    const { applied, error } = await catchUp.updateModel(rt, selection);
    if (error || !applied) return setNote(`Model: ${error ?? "the daemon did not return the applied model"}`);
    desk.setDeskModel(scope, applied.handle, applied.reasoning_effort);
    desk.models.used(applied.handle);
  };
  return (
    <ConversationScreen
      thread={thread}
      view={view}
      chats={catchUp}
      model={desk.modelOf(scope)}
      reasoningEffort={desk.reasoningEffortOf(scope)}
      models={models}
      onLoadModels={onLoadModels}
      onPickModel={catchUp.status === "open" ? pickModel : undefined}
      item={item}
      waiting={!!item && catchUpQueue([item]).length > 0}
      banner={note ? <Banner>{note}</Banner> : banner}
      backLabel={backLabel}
      prefill={prefill}
      pinned={convDesk?.status === "live" ? !!convDesk.pinned : null}
      onPin={(p) => desk.desks.pin(thread.agentId, thread.conversationId, p)}
      purpose={convDesk?.purpose ?? item?.purpose ?? null}
      rename={
        convDesk && canRename(convDesk)
          ? {
              name: convDesk.title ?? "",
              onRename: onRename ? (name) => onRename(convDesk, name) : null,
              onPurpose: onRename ? (purpose) => savePurpose(desk, catchUp)(convDesk, purpose) : null,
            }
          : null
      }
      labels={
        convDesk?.status !== "deleted"
          ? {
              current: convDesk?.labels ?? [],
              list: catchUp.labels.list,
              onChange:
                catchUp.status === "open"
                  ? async (next) => {
                      const err = await catchUp.labels.set({ agent_id: thread.agentId, conversation_id: thread.conversationId }, next);
                      if (!err) desk.desks.request();
                      return err;
                    }
                  : null,
            }
          : null
      }
      archive={
        !isMainChat(thread.conversationId) && convDesk?.status !== "deleted"
          ? {
              archived: convDesk?.status === "archived",
              onArchive: onArchive
                ? async (archived) => {
                    const err = await catchUp.archiveConversation(thread.conversationId, archived, "phone_chat", thread.agentId);
                    if (!err) desk.desks.request();
                    return err;
                  }
                : null,
            }
          : null
      }
      folder={
        attention.available && catchUp.status === "open" && convDesk?.status !== "deleted"
          ? {
              load: async () => {
                const r = await attention.folders.recent();
                const current =
                  catchUp.conversation(thread.agentId, thread.conversationId).cwd ??
                  r.byConversation[conversationDirName(thread.conversationId, thread.agentId)] ??
                  null;
                return { current, choices: r.byAgent[thread.agentId] ?? [] };
              },
              onMove: (folder) => catchUp.changeFolder({ agent_id: thread.agentId, conversation_id: thread.conversationId }, folder),
            }
          : null
      }
      onBack={onBack}
      onLoad={(rt) => void catchUp.loadThread(rt)}
      onDecide={catchUp.decide}
      onStop={catchUp.stop}
      onAnswer={catchUp.answer}
      onSend={(rt, text, images, deskTitle) => catchUp.send(rt, text, images, { desk: deskTitle, labels: convDesk?.labels ?? null })}
      onCommand={(rt, id, args) => void catchUp.execute(rt, id, args)}
      onSeen={(rt) => attention.markSeen(rt.agent_id, rt.conversation_id)}
      onNotDone={catchUp.unread}
      onViewed={attention.markViewed}
      suggestions={{ source: catchUp, blocked: macAway(catchUp) }}
      onCloseLink={(rt, id) => void catchUp.links.close(rt, id)}
    />
  );
}

function Screen({
  tab,
  me,
  link,
  desk,
  catchUp,
  deck,
  due,
  banner,
  recentFolders,
  onArchive,
  onRename,
  inboxBack,
  models,
  onLoadModels,
}: {
  tab: Tab | null;
  me: Me;
  link: LinkState;
  desk: DeskApi;
  catchUp: CatchUp;
  deck: Deck;
  due: number;
  banner: ReactNode;
  recentFolders: () => Promise<Partial<Record<string, string[]>>>;
  onArchive: ArchiveDesk | null;
  onRename: RenameDeskName | null;
  inboxBack: string;
  models: ModelEntry[] | null;
  onLoadModels: () => void;
}) {
  const [cardNote, setCardNote] = useState<string | null>(null);
  useEffect(() => {
    if (!cardNote) return;
    const t = setTimeout(() => setCardNote(null), 4000);
    return () => clearTimeout(t);
  }, [cardNote]);
  const cardModel = {
    models,
    onLoad: onLoadModels,
    modelOf: (item: AttentionItem) => desk.modelOf(scopeFor(item.id, item.agent_id)),
    effortOf: (item: AttentionItem) => desk.reasoningEffortOf(scopeFor(item.id, item.agent_id)),
    onPick:
      catchUp.status === "open"
        ? async (item: AttentionItem, selection: ModelSelection) => {
            const { applied, error } = await catchUp.updateModel(item.runtime, selection);
            if (error || !applied) return setCardNote(`Model: ${error ?? "the daemon did not return the applied model"}`);
            desk.setDeskModel(scopeFor(item.id, item.agent_id), applied.handle, applied.reasoning_effort);
            desk.models.used(applied.handle);
          }
        : undefined,
  };
  const { attention } = desk;
  return (
    <>
      <Home
        hidden={tab !== "home"}
        me={me}
        link={link}
        desks={desk.desks.list}
        desksLoaded={desk.desks.loaded}
        agents={catchUp.agents}
        items={catchUp.items}
        laneItems={catchUp.flow.laneItems}
        due={due}
        banner={banner}
        onRefresh={desk.desks.request}
        onPin={desk.desks.pin}
        onArchive={onArchive}
        onRename={onRename}
        onPurpose={attention.available && catchUp.status === "open" ? savePurpose(desk, catchUp) : null}
        recentFolders={recentFolders}
        onCreate={(agentId, folder, name) => catchUp.createDesk(agentId, folder, name).then((rt) => (desk.desks.request(), rt))}
        homes={homesOf(desk.macs.view, catchUp.agents)}
        labelList={catchUp.labels.list}
        onTopCard={deck.hold}
      />
      <Inbox
        hidden={tab !== "inbox"}
        items={catchUp.items}
        labelList={catchUp.labels.list}
        loaded={catchUp.agentsLoaded}
        available={attention.available}
        banner={cardNote ? <Banner>{cardNote}</Banner> : banner}
        chats={catchUp}
        deck={deck}
        backLabel={inboxBack}
        onClose={closeInbox}
        onOpen={(item) => (catchUp.decided(item, "open", "tap"), openConversation(item.agent_id, item.id))}
        onConnection={() => navigate({ kind: "connection" })}
        card={{
          onSend: (item, text, images) => (catchUp.decided(item, "reply", "tap"), catchUp.reply(item, text, images)),
          onAnswer: (item, requestId, answers) => (catchUp.decided(item, "answer", "tap"), catchUp.answer(item.runtime, requestId, answers)),
          onCancelQueued: (item, text) => catchUp.cancelQueued(item.runtime, text),
          onStop: (item) => catchUp.stop(item.runtime),
          model: cardModel,
          suggestions: { source: catchUp, blocked: macAway(catchUp) },
        }}
        onApprove={(item, requestId, behavior) => (
          catchUp.decided(item, behavior !== "deny" ? "approve" : "deny", "tap"),
          catchUp.approve(item, requestId, behavior)
        )}
        onShown={catchUp.shown}
        moves={catchUp}
        onNote={setCardNote}
      />
      {tab === "agents" && (
        <Agents
          agents={catchUp.agents}
          loaded={catchUp.agentsLoaded}
          link={link}
          desks={desk.desks.list}
          items={catchUp.items}
          api={desk.agents}
          banner={banner}
        />
      )}
      {tab === "more" && (
        <More
          me={me}
          link={link}
          agents={catchUp.agents.length}
          running={homeCounts({ items: catchUp.items, due, agents: catchUp.agents, desks: desk.desks.list }).running}
          due={due}
          archived={archiveList(desk.desks.list, null, "").length}
          servedBuild={desk.servedBuild}
          banner={banner}
        />
      )}
    </>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <main className="loki-phone loki-phone-shell loki-phone-splash">
      <div className="loki-phone-splash-inner">{children}</div>
    </main>
  );
}
