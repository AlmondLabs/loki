import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useAttention } from "../../../packages/core/src/attention/useAttention.ts";
import { catchUpQueue } from "../../../packages/core/src/attention/queue.ts";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import { makeTransport } from "../attention/transport";
import { modBase } from "../desk/env";
import { useDesk } from "../desk/useDesk";
import { AgentPage, FilePage } from "./Agent";
import { Agents } from "./Agents";
import { Conversation, type Thread } from "./Conversation";
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
import { Banner, Button } from "../ui";
import { PhoneStyles, SAFE } from "./ui";

/**
 * Phone mode: the second shell. The mod serves this page over the Wi‑Fi with `__LOKI__.lan` set and
 * lets the device in by cookie. `GET /me` decides between Pair and the app; once paired, the same
 * two hooks the desktop shell uses (useDesk for the mod, useAttention for the app-server tunnel)
 * feed four tabs on a bottom bar — Home (the desks), Inbox (the deck), Agents, Settings — and the
 * full-screen pages over them: a conversation, an agent, a memory file. Routes live in the hash.
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
        <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, color: "var(--loki-fg)" }}>The Mac did not answer.</div>
        <div style={{ fontSize: 13.5, color: "var(--loki-muted)", marginTop: 8, lineHeight: 1.5 }}>Same Wi‑Fi, and loki open on the Mac with Settings › phone switched on.</div>
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
  const prefill = useMemo(() => (conv?.prefill ? { text: conv.prefill, tick: Date.now() } : null), [prefillKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (conv?.prefill) replace({ ...conv, prefill: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);
  return prefill;
}

function Paired({ me, onUnpaired }: { me: Me; onUnpaired: () => void }) {
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
  const route = useRoute();
  const lastTab = useLastTab(route);

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
  const recall = useRecall(desk, route.kind === "tab" && route.tab === "recall" ? "recall" : "desk", (m) => setRecallNote(m));
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
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)", color: "var(--loki-fg)", fontFamily: "var(--loki-font)" }}>
      <PhoneStyles />
      {conv && <ConversationPage conv={conv} desk={desk} catchUp={catchUp} banner={banner} lastTab={lastTab} prefill={prefill} />}
      {route.kind === "agent" && <AgentPage agentId={route.agentId} name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)} desks={desk.desks.list} api={desk.agents} banner={banner} onBack={() => back({ kind: "tab", tab: "agents" })} />}
      {route.kind === "file" && <FilePage agentId={route.agentId} path={route.path} name={agentNameOf(catchUp.agents, desk.desks.list, route.agentId)} api={desk.agents} banner={banner} onBack={() => back({ kind: "agent", agentId: route.agentId })} />}

      <Screen tab={tab} me={me} desk={desk} catchUp={catchUp} deck={deck} recall={recall} recallNote={recallNote} banner={banner} recentFolders={recentFolders} onUnpaired={onUnpaired} />

      <UpdateBar servedBuild={desk.servedBuild} withTabBar={onTab} />
      {onTab && <TabBar active={tab} waiting={waiting} due={recall.due} />}
    </div>
  );
}

/** The conversation the route names, full screen over the tabs, wired to the tunnel and the mod's desk list. */
function ConversationPage({ conv, desk, catchUp, banner, lastTab, prefill }: { conv: ConversationRoute; desk: DeskApi; catchUp: CatchUp; banner: ReactNode; lastTab: RefObject<Tab>; prefill: { text: string; tick: number } | null }) {
  const { attention } = desk;
  const convDesk = desk.desks.list.find((d) => d.agentId === conv.agentId && d.conversationId === conv.conversationId);
  const thread: Thread = threadFor(conv, desk.desks.list, catchUp.items, catchUp.agents);
  return (
    <Conversation
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
      onSend={(rt, text, deskTitle) => catchUp.send(rt, text, [], { desk: deskTitle })}
      onSeen={(rt) => attention.markSeen(rt.agent_id, rt.conversation_id)}
    />
  );
}

/** The four tabs. Home, Agents and Settings mount on their tab; the deck stays mounted under the other tabs and pages so the pass (n of N, dismissed cards) survives the round trip. */
function Screen({ tab, me, desk, catchUp, deck, recall, recallNote, banner, recentFolders, onUnpaired }: { tab: Tab | null; me: Me; desk: DeskApi; catchUp: CatchUp; deck: Deck; recall: ReturnType<typeof useRecall>; recallNote: string | null; banner: ReactNode; recentFolders: () => Promise<Record<string, string[]>>; onUnpaired: () => void }) {
  const { attention } = desk;
  const later = (item: AttentionItem) => {
    catchUp.unread(item);
    if (!item.pendingApproval) catchUp.later(item); // approvals never snooze
  };
  return (
    <>
      {tab === "home" && (
        <Home desks={desk.desks.list} agents={catchUp.agents} items={catchUp.items} banner={banner} onRefresh={desk.desks.request} onPin={desk.desks.pin} recentFolders={recentFolders} onCreate={(agentId, folder, name) => catchUp.createDesk(agentId, folder, name).then((rt) => (desk.desks.request(), rt))} />
      )}
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
      {tab === "recall" && <RecallTab recall={recall} banner={recallNote ? <Banner>{recallNote}</Banner> : banner} />}
      {tab === "agents" && <Agents agents={catchUp.agents} loaded={catchUp.agentsLoaded} desks={desk.desks.list} api={desk.agents} banner={banner} />}
      {tab === "settings" && <Settings me={me} version={catchUp.server?.version ?? null} modLink={desk.connection} appServerLink={catchUp.status} banner={banner} onUnpaired={onUnpaired} />}
    </>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: `calc(24px + ${SAFE.top}) 24px calc(24px + ${SAFE.bottom})`, background: "var(--loki-bg)", color: "var(--loki-muted)", fontSize: 13.5, textAlign: "center", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 360 }}>{children}</div>
    </main>
  );
}
