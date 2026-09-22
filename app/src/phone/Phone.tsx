import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAttention } from "../../../core/attention/useAttention.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { makeTransport } from "../shell/transport";
import { modBase } from "../desk/env";
import { useDesk } from "../desk/useDesk";
import { AgentPage, FilePage } from "./Agent";
import { Agents, knownDescription } from "./Agents";
import { ConversationScreen, type Thread } from "./Conversation";
import { Archive } from "./Archive";
import { Home, type ArchiveDesk } from "./Home";
import { Inbox, useDeck, type Deck } from "./Inbox";
import { Pair, type Me } from "./Pair";
import { More } from "./More";
import { Search } from "./Search";
import { AboutPage, ConnectionPage, Preferences } from "./Settings";
import { Recall as RecallTab } from "./Recall";
import { useRecall } from "../shell/useRecall";
import { useDeckPass } from "../recall/useDeckPass";
import { TabBar } from "./TabBar";
import { UpdateBar } from "./UpdateBar";
import { agentNameOf, archiveList, homeCounts, lastSeen, linkState, threadFor, type LinkState } from "./model";
import { HOME, back, backTarget, depthOf, formatRoute, labelOf, navigate, replace, screenOf, showsNav, useRouteState, type Route, type Tab } from "./router";
import { recentPlaces, useFocusOnRoute } from "./session";
import { useKeyboardInset } from "./viewport";
import { Banner, Button } from "../components";
import "./phone.css";

/**
 * Phone mode: the second shell. The mod serves this page over the Wi‑Fi with `__LOKI__.lan` set and
 * lets the device in by cookie. `GET /me` decides between Pair and the app; once paired, the same
 * two hooks the desktop shell uses (useDesk for the mod, useAttention for the app-server tunnel)
 * feed four tabs in a floating capsule — Home, Inbox, Agents, More, with Search beside it — and the
 * full-screen pages over them: Search, Learn, Archive, Preferences, the connection, About, a
 * conversation, an agent, and a memory file. Routes live in the hash; each page knows where it was opened from (router.ts), and
 * what a person was in the middle of — drafts, scroll, the control they left from — is kept by session.ts.
 */
type Gate = { kind: "checking" } | { kind: "unpaired" } | { kind: "paired"; me: Me } | { kind: "unreachable" };

type DeskApi = ReturnType<typeof useDesk>;
type CatchUp = ReturnType<typeof useAttention>;
type ConversationRoute = Extract<Route, { kind: "conversation" }>;

/** An inbox card, opened: its conversation, full screen. */
const openItem = (item: AttentionItem) => navigate({ kind: "conversation", agentId: item.agentId, conversationId: item.id, prefill: null });

/** Out of the Inbox pass: back where it was opened from, or Home when the app was opened on it. */
const closeInbox = () => {
  if (depthOf(history.state) > 0) history.back();
  else replace(HOME, "pop");
};

export function Phone() {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const check = useCallback(async () => {
    setGate({ kind: "checking" });
    try {
      const r = await fetch(`${modBase()}/me`, { credentials: "same-origin", cache: "no-store" });
      if (r.ok) setGate({ kind: "paired", me: (await r.json()) as Me });
      else setGate({ kind: "unpaired" }); // 401: no cookie, or a forgotten one
    } catch {
      setGate({ kind: "unreachable" });
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);

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
        <p className="loki-phone-body loki-phone-splash-line">Same Wi‑Fi, and loki open on the Mac with Settings › phone switched on.</p>
        <Button size="touch" tone="paper" onClick={() => void check()} className="loki-phone-splash-action">
          Try again
        </Button>
      </Splash>
    );
  if (gate.kind === "unpaired") return <Pair onPaired={(me) => setGate({ kind: "paired", me })} />;
  return <Paired me={gate.me} onUnpaired={() => setGate({ kind: "unpaired" })} />;
}

/**
 * "Mac unreachable, last seen …": both sockets reconnect by themselves; this only says so. Owns the
 * time of the last moment both were up and a half-minute tick so the words age; the banner is null
 * while the link is fine.
 */
function useLinkBanner(desk: DeskApi, catchUp: CatchUp, available: boolean): ReactNode {
  const linked = desk.connection === "open" && (catchUp.status === "open" || !available);
  const [lastLinked, setLastLinked] = useState<string | null>(null);
  const [, setTickNow] = useState(0);
  useEffect(() => {
    if (linked) setLastLinked(new Date().toISOString());
  }, [linked]);
  useEffect(() => {
    const t = setInterval(() => setTickNow((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const unreachable = desk.connection === "closed" || catchUp.status === "closed";
  return unreachable ? <Banner>Mac unreachable · last seen {lastSeen(lastLinked)}</Banner> : null;
}

/** A closed mod socket may mean this phone was forgotten in Settings: ask /me once; a 401 sends us back to Pair. */
function useUnpairWatch(connection: DeskApi["connection"], onUnpaired: () => void) {
  useEffect(() => {
    if (connection !== "closed") return;
    void fetch(`${modBase()}/me`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => {
        if (r.status === 401) onUnpaired();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);
}

/** A `?prefill=` in the route starts the reply box once, then leaves the address so a reload does not repeat it. */
function usePrefill(conv: ConversationRoute | null) {
  const prefillKey = conv?.prefill ? formatRoute(conv) : null;
  // The route arriving is the event: it becomes the prefill (with a fresh tick) and leaves the address.
  const [prefill, setPrefill] = useState<{ text: string; tick: number } | null>(null);
  useEffect(() => {
    if (!conv?.prefill) return;
    setPrefill({ text: conv.prefill, tick: Date.now() });
    replace({ ...conv, prefill: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);
  return prefill;
}

function Paired({ me, onUnpaired }: { me: Me; onUnpaired: () => void }) {
  const desk = useDesk();
  const { attention } = desk;
  // Analytics (core/analytics.ts): every event the phone sends carries the tab or page on screen as $screen.
  const screenRef = useRef<string | null>(null);
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
  const { route, from, arrival } = useRouteState();
  // Analytics: the tab or page on screen, an event on change (a conversation page is "conversation", not which one).
  const routeView = screenOf(route);
  const prevView = useRef<string | null>(null);
  useEffect(() => {
    if (prevView.current !== null && prevView.current !== routeView) capture("view_opened", { view: routeView, from: prevView.current });
    prevView.current = routeView;
    screenRef.current = routeView;
  }, [routeView, capture]);

  // A pairing QR opened while already paired: the code is not needed, drop it from the address (the route stays).
  useEffect(() => {
    if (new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname + location.hash);
  }, []);

  // The desks list feeds Home and the conversation titles; ask for it whenever the mod link comes up.
  useEffect(() => {
    if (desk.connection === "open") desk.desks.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);

  const banner = useLinkBanner(desk, catchUp, attention.available);
  useUnpairWatch(desk.connection, onUnpaired);

  const waiting = catchUpQueue(catchUp.items).length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) loki` : "loki";
  }, [waiting]);

  // The deck's pass (what was swiped, what is on top) lives here, beside the data: the top card's
  // thread is fetched once when it arrives, and live rows stream in on top.
  const deck = useDeck(catchUp.items);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const recall = useRecall(desk, route.kind === "learn" ? "learn" : "desk", (m) => setRecallNote(m));
  // Learn's sitting (the card under your hands, the ones answered) lives here, above the routes, so
  // leaving Learn for Home or More and coming back resumes the same pass instead of starting over.
  const learnPass = useDeckPass(recall.snap?.cards ?? []);
  useEffect(() => {
    if (!recallNote) return;
    const t = setTimeout(() => setRecallNote(null), 4000);
    return () => clearTimeout(t);
  }, [recallNote]);
  useEffect(() => {
    if (deck.current) void catchUp.loadHistory(deck.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.currentId]);

  // The conversation on screen, from the route: its title and agent from the desks list, the inbox, or the agent list.
  const conv = route.kind === "conversation" ? route : null;
  const prefill = usePrefill(conv);

  const recentFolders = useCallback(() => attention.folders.recent().then((r) => r.byAgent), []); // eslint-disable-line react-hooks/exhaustive-deps
  const tab = route.kind === "tab" ? route.tab : null;
  // A card up in the Inbox is a focused pass: it takes the whole screen, as Slack's Catch Up does, and its
  // own back chevron leaves it. With no card (caught up, loading, the Mac away) the navigation is back.
  const nav = showsNav(route) && !(tab === "inbox" && deck.current);
  const inboxFrom = tab === "inbox" && from && formatRoute(from) !== formatRoute(route) ? from : HOME;

  // Back from the page on screen, and what its control says: where it was opened from, else its parent.
  const onBack = () => back(route);
  const backLabel = labelOf(backTarget(route, from));

  // Where a page is, without a one-shot prefill: the key for focus and for the recently visited list.
  const place = formatRoute(conv ? { ...conv, prefill: null } : route);
  // Focus follows the route: the control you left from when you come back, the new screen's heading otherwise.
  const shellRef = useRef<HTMLDivElement>(null);
  useFocusOnRoute(shellRef, place, arrival === "pop");
  // The on-screen keyboard: where it only shrinks the visual viewport, the shell fits what is visible (viewport.ts).
  useKeyboardInset(shellRef);
  // Pages opened go on the device's recent list, for Search (which drops ones that no longer resolve).
  useEffect(() => {
    if (!nav && route.kind !== "search") recentPlaces.add(place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  // Archive and restore go through the app-server, the way the desktop tree does; null while it cannot take them.
  const onArchive: ArchiveDesk | null =
    attention.available && catchUp.status === "open"
      ? async (d, archived) => {
          if (!d.conversationId) return "this desk has no conversation";
          const err = await catchUp.archiveConversation(d.conversationId, archived);
          if (!err) desk.desks.request();
          return err;
        }
      : null;

  const link = linkState(desk.connection, catchUp.status, attention.available);
  // What Search looks through: only what the phone already holds (searchIndex.ts), agent descriptions from the Agents cache.
  const searchSources = useMemo(() => ({ desks: desk.desks.list, agents: catchUp.agents, items: catchUp.items, describe: knownDescription }), [desk.desks.list, catchUp.agents, catchUp.items]);
  const update = <UpdateBar servedBuild={desk.servedBuild} />;
  return (
    <div ref={shellRef} className="loki-phone loki-phone-shell">
      {/* The one main landmark, whatever is on screen; the navigation and the update strip sit outside it. */}
      <main className="loki-phone-main">
        {conv && <ConversationPage conv={conv} desk={desk} catchUp={catchUp} banner={banner} backLabel={backLabel} onBack={onBack} prefill={prefill} />}
        {route.kind === "learn" && <RecallTab recall={recall} pass={learnPass} banner={recallNote ? <Banner>{recallNote}</Banner> : banner} backLabel={backLabel} onBack={onBack} />}
        {route.kind === "search" && <Search q={route.q ?? ""} fresh={arrival !== "pop"} sources={searchSources} link={link} loaded={catchUp.agentsLoaded} backLabel={backLabel} onBack={onBack} />}
        {route.kind === "archive" && <Archive desks={desk.desks.list} loaded={desk.desks.loaded} banner={banner} backLabel={backLabel} onBack={onBack} onArchive={onArchive} />}
        {route.kind === "preferences" && <Preferences banner={banner} backLabel={backLabel} onBack={onBack} />}
        {route.kind === "connection" && <ConnectionPage me={me} link={link} modLink={desk.connection} appServerLink={catchUp.status} banner={banner} onUnpaired={onUnpaired} backLabel={backLabel} onBack={onBack} />}
        {route.kind === "about" && <AboutPage version={catchUp.server?.version ?? null} servedBuild={desk.servedBuild} banner={banner} backLabel={backLabel} onBack={onBack} />}
        {route.kind === "agent" && <AgentPage agentId={route.agentId} name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)} desks={desk.desks.list} items={catchUp.items} api={desk.agents} banner={banner} backLabel={backLabel} onBack={onBack} />}
        {route.kind === "file" && <FilePage agentId={route.agentId} path={route.path} name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)} api={desk.agents} banner={banner} onBack={onBack} />}

        <Screen tab={tab} me={me} link={link} desk={desk} catchUp={catchUp} deck={deck} due={recall.due} banner={banner} recentFolders={recentFolders} onArchive={onArchive} inboxBack={labelOf(inboxFrom)} />
      </main>

      {nav ? (
        <TabBar active={tab} waiting={waiting}>
          {update}
        </TabBar>
      ) : (
        update
      )}
    </div>
  );
}

/** The conversation the route names, full screen over the tabs, wired to the tunnel and the mod's desk list. */
function ConversationPage({ conv, desk, catchUp, banner, backLabel, onBack, prefill }: { conv: ConversationRoute; desk: DeskApi; catchUp: CatchUp; banner: ReactNode; backLabel: string; onBack: () => void; prefill: { text: string; tick: number } | null }) {
  const { attention } = desk;
  const convDesk = desk.desks.list.find((d) => d.agentId === conv.agentId && d.conversationId === conv.conversationId);
  const thread: Thread = threadFor(conv, desk.desks.list, catchUp.items, catchUp.agents);
  const item = catchUp.items.find((i) => i.agentId === thread.agentId && i.id === thread.conversationId) ?? null;
  return (
    <ConversationScreen
      thread={thread}
      view={catchUp.conversation(thread.agentId, thread.conversationId)}
      item={item}
      waiting={!!item && catchUpQueue([item]).length > 0}
      banner={banner}
      backLabel={backLabel}
      prefill={prefill}
      pinned={convDesk && convDesk.status === "live" ? !!convDesk.pinned : null}
      onPin={(p) => desk.desks.pin(thread.agentId, thread.conversationId, p)}
      onBack={onBack}
      onLoad={(rt) => void catchUp.loadThread(rt)}
      onDecide={catchUp.decide}
      onAnswer={catchUp.answer}
      onSend={(rt, text, images, deskTitle) => catchUp.send(rt, text, images, { desk: deskTitle })}
      onSeen={(rt) => attention.markSeen(rt.agent_id, rt.conversation_id)}
    />
  );
}

/**
 * The four tabs. Home and the deck stay mounted under other tabs and pages, so their filters, the
 * current pass and the draft survive a round trip; Agents and More mount with their tab and get their
 * place back from the scroll memory (their data is cached above them).
 */
function Screen({ tab, me, link, desk, catchUp, deck, due, banner, recentFolders, onArchive, inboxBack }: { tab: Tab | null; me: Me; link: LinkState; desk: DeskApi; catchUp: CatchUp; deck: Deck; due: number; banner: ReactNode; recentFolders: () => Promise<Record<string, string[]>>; onArchive: ArchiveDesk | null; inboxBack: string }) {
  const { attention } = desk;
  const later = (item: AttentionItem) => {
    catchUp.unread(item);
    if (!item.pendingApproval) catchUp.later(item); // approvals never snooze
  };
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
        due={due}
        banner={banner}
        onRefresh={desk.desks.request}
        onPin={desk.desks.pin}
        onArchive={onArchive}
        recentFolders={recentFolders}
        onCreate={(agentId, folder, name) => catchUp.createDesk(agentId, folder, name).then((rt) => (desk.desks.request(), rt))}
      />
      <Inbox
        hidden={tab !== "inbox"}
        items={catchUp.items}
        loaded={catchUp.agentsLoaded}
        available={attention.available}
        banner={banner}
        conversation={catchUp.conversation}
        deck={deck}
        backLabel={inboxBack}
        onClose={closeInbox}
        onOpen={openItem}
        onConnection={() => navigate({ kind: "connection" })}
        card={{
          onSend: (item, text, images) => catchUp.reply(item, text, images),
          onAnswer: (item, requestId, answers) => catchUp.answer(item.runtime, requestId, answers),
          onCancelQueued: (item, text) => catchUp.cancelQueued(item.runtime, text),
        }}
        onApprove={catchUp.approve}
        onSeen={catchUp.seen}
        onLater={later}
        onUnsnooze={catchUp.unsnooze}
        onUndo={(item, via) => (via === "seen" ? catchUp.unread(item) : catchUp.unsnooze(item))}
      />
      {tab === "agents" && <Agents agents={catchUp.agents} loaded={catchUp.agentsLoaded} link={link} desks={desk.desks.list} items={catchUp.items} api={desk.agents} banner={banner} />}
      {tab === "more" && <More me={me} link={link} agents={catchUp.agents.length} running={homeCounts({ items: catchUp.items, due, agents: catchUp.agents, desks: desk.desks.list }).running} due={due} archived={archiveList(desk.desks.list, null, "").length} servedBuild={desk.servedBuild} banner={banner} />}
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
