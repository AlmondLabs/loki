import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useAttention } from "../../../core/attention/useAttention.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { makeTransport } from "../shell/transport";
import { modBase } from "../desk/env";
import { useDesk } from "../desk/useDesk";
import { AgentPage, FilePage } from "./Agent";
import { Agents } from "./Agents";
import { ConversationScreen, type Thread } from "./Conversation";
import { Home } from "./Home";
import { Inbox, useDeck, type Deck } from "./Inbox";
import { Pair, type Me } from "./Pair";
import { Settings } from "./Settings";
import { Recall as RecallTab } from "./Recall";
import { useRecall } from "../shell/useRecall";
import { TabBar } from "./TabBar";
import { UpdateBar } from "./UpdateBar";
import { agentNameOf, lastSeen, threadFor } from "./model";
import { back, formatRoute, navigate, replace, tabOf, useRoute, type Route, type Tab } from "./router";
import { Banner, Button } from "../components";
import "./phone.css";

/**
 * Phone mode: the second shell. The mod serves this page over the Wi‑Fi with `__LOKI__.lan` set and
 * lets the device in by cookie. `GET /me` decides between Pair and the app; once paired, the same
 * two hooks the desktop shell uses (useDesk for the mod, useAttention for the app-server tunnel)
 * feed four tabs on a bottom bar — Home, Inbox, Agents, You — and the full-screen pages over them:
 * Learn, a conversation, an agent, and a memory file. Routes live in the hash.
 */
type Gate = { kind: "checking" } | { kind: "unpaired" } | { kind: "paired"; me: Me } | { kind: "unreachable" };

type DeskApi = ReturnType<typeof useDesk>;
type CatchUp = ReturnType<typeof useAttention>;
type ConversationRoute = Extract<Route, { kind: "conversation" }>;

/** An inbox card, opened: its conversation, full screen. */
const openItem = (item: AttentionItem) => navigate({ kind: "conversation", agentId: item.agentId, conversationId: item.id, prefill: null });

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

  if (gate.kind === "checking") return <Splash>opening…</Splash>;
  if (gate.kind === "unreachable")
    return (
      <Splash>
        <h1 className="loki-phone-large-title">The Mac did not answer.</h1>
        <div className="loki-phone-body" style={{ color: "var(--loki-muted)", marginTop: 8 }}>Same Wi‑Fi, and loki open on the Mac with Settings › phone switched on.</div>
        <Button size="touch" tone="paper" onClick={() => void check()} style={{ marginTop: 18 }}>
          try again
        </Button>
      </Splash>
    );
  if (gate.kind === "unpaired") return <Pair onPaired={(me) => setGate({ kind: "paired", me })} />;
  return <Paired me={gate.me} onUnpaired={() => setGate({ kind: "unpaired" })} />;
}

/** The tab under the page you are on; where a conversation's back goes when the app opened on it. */
function useLastTab(route: Route) {
  const lastTab = useRef<Tab>(tabOf(route) ?? "home");
  useEffect(() => {
    const t = tabOf(route);
    if (t) lastTab.current = t;
  }, [route]);
  return lastTab;
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
  const route = useRoute();
  const lastTab = useLastTab(route);
  // Analytics: the tab or page on screen, an event on change (a conversation page is "conversation", not which one).
  const routeView = route.kind === "tab" ? route.tab : route.kind;
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
  const onTab = route.kind === "tab";
  const tab = onTab ? route.tab : null;

  return (
    <div className="loki-phone loki-phone-shell">
      {conv && <ConversationPage conv={conv} desk={desk} catchUp={catchUp} banner={banner} lastTab={lastTab} prefill={prefill} />}
      {route.kind === "learn" && <RecallTab recall={recall} banner={recallNote ? <Banner>{recallNote}</Banner> : banner} onBack={() => back({ kind: "tab", tab: "home" })} />}
      {route.kind === "agent" && <AgentPage agentId={route.agentId} name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)} desks={desk.desks.list} api={desk.agents} banner={banner} onBack={() => back({ kind: "tab", tab: "agents" })} />}
      {route.kind === "file" && <FilePage agentId={route.agentId} path={route.path} name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)} api={desk.agents} banner={banner} onBack={() => back({ kind: "agent", agentId: route.agentId })} />}

      <Screen tab={tab} me={me} desk={desk} catchUp={catchUp} deck={deck} due={recall.due} banner={banner} recentFolders={recentFolders} onUnpaired={onUnpaired} />

      <UpdateBar servedBuild={desk.servedBuild} withTabBar={onTab} />
      {onTab && <TabBar active={tab} waiting={waiting} />}
    </div>
  );
}

/** The conversation the route names, full screen over the tabs, wired to the tunnel and the mod's desk list. */
function ConversationPage({ conv, desk, catchUp, banner, lastTab, prefill }: { conv: ConversationRoute; desk: DeskApi; catchUp: CatchUp; banner: ReactNode; lastTab: RefObject<Tab>; prefill: { text: string; tick: number } | null }) {
  const { attention } = desk;
  const convDesk = desk.desks.list.find((d) => d.agentId === conv.agentId && d.conversationId === conv.conversationId);
  const thread: Thread = threadFor(conv, desk.desks.list, catchUp.items, catchUp.agents);
  return (
    <ConversationScreen
      thread={thread}
      view={catchUp.conversation(thread.agentId, thread.conversationId)}
      waiting={catchUp.items.some((i) => i.agentId === thread.agentId && i.id === thread.conversationId && catchUpQueue([i]).length > 0)}
      banner={banner}
      backLabel={lastTab.current}
      prefill={prefill}
      pinned={convDesk && convDesk.status === "live" ? !!convDesk.pinned : null}
      onPin={(p) => desk.desks.pin(thread.agentId, thread.conversationId, p)}
      onBack={() => back({ kind: "tab", tab: lastTab.current })}
      onLoad={(rt) => void catchUp.loadThread(rt)}
      onDecide={catchUp.decide}
      onAnswer={catchUp.answer}
      onSend={(rt, text, images, deskTitle) => catchUp.send(rt, text, images, { desk: deskTitle })}
      onSeen={(rt) => attention.markSeen(rt.agent_id, rt.conversation_id)}
    />
  );
}

/** The four tabs. The deck stays mounted under other tabs and pages so the current pass survives a round trip. */
function Screen({ tab, me, desk, catchUp, deck, due, banner, recentFolders, onUnpaired }: { tab: Tab | null; me: Me; desk: DeskApi; catchUp: CatchUp; deck: Deck; due: number; banner: ReactNode; recentFolders: () => Promise<Record<string, string[]>>; onUnpaired: () => void }) {
  const { attention } = desk;
  const later = (item: AttentionItem) => {
    catchUp.unread(item);
    if (!item.pendingApproval) catchUp.later(item); // approvals never snooze
  };
  return (
    <>
      <Home hidden={tab !== "home"} desks={desk.desks.list} agents={catchUp.agents} items={catchUp.items} waiting={catchUpQueue(catchUp.items).length} due={due} banner={banner} onOpenInbox={() => navigate({ kind: "tab", tab: "inbox" })} onOpenLearn={() => navigate({ kind: "learn" })} onRefresh={desk.desks.request} onPin={desk.desks.pin} recentFolders={recentFolders} onCreate={(agentId, folder, name) => catchUp.createDesk(agentId, folder, name).then((rt) => (desk.desks.request(), rt))} />
      <Inbox
        hidden={tab !== "inbox"}
        items={catchUp.items}
        loaded={catchUp.agentsLoaded}
        available={attention.available}
        banner={banner}
        conversation={catchUp.conversation}
        deck={deck}
        onOpen={openItem}
        onApprove={catchUp.approve}
        onSeen={catchUp.seen}
        onLater={later}
        onUnsnooze={catchUp.unsnooze}
        onUndo={(item, via) => (via === "seen" ? catchUp.unread(item) : catchUp.unsnooze(item))}
      />
      {tab === "agents" && <Agents agents={catchUp.agents} loaded={catchUp.agentsLoaded} desks={desk.desks.list} api={desk.agents} banner={banner} />}
      {tab === "you" && <Settings me={me} version={catchUp.server?.version ?? null} modLink={desk.connection} appServerLink={catchUp.status} banner={banner} onUnpaired={onUnpaired} />}
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
