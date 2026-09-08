import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Inbox } from "./Inbox";
import { Pair, type Me } from "./Pair";
import { Settings } from "./Settings";
import { TabBar } from "./TabBar";
import { UpdateBar } from "./UpdateBar";
import { lastSeen } from "./model";
import { back, formatRoute, navigate, replace, tabOf, useRoute, type Tab } from "./router";
import { Banner, PhoneStyles, SAFE, tap } from "./ui";

/**
 * Phone mode: the second shell. The mod serves this page over the Wi‑Fi with `__LOKI__.lan` set and
 * lets the device in by cookie. `GET /me` decides between Pair and the app; once paired, the same
 * two hooks the desktop shell uses (useDesk for the mod, useAttention for the app-server tunnel)
 * feed four tabs on a bottom bar — Home (the desks), Inbox (the deck), Agents, Settings — and the
 * full-screen pages over them: a conversation, an agent, a memory file. Routes live in the hash.
 */
type Gate = { kind: "checking" } | { kind: "unpaired" } | { kind: "paired"; me: Me } | { kind: "unreachable" };

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
        <button type="button" onClick={() => void check()} style={{ ...tap("var(--loki-fg)"), marginTop: 18 }}>
          try again
        </button>
      </Splash>
    );
  if (gate.kind === "unpaired") return <Pair onPaired={(me) => setGate({ kind: "paired", me })} />;
  return <Paired me={gate.me} onUnpaired={() => setGate({ kind: "unpaired" })} />;
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
  });
  const route = useRoute();
  /** The tab under the page you are on; where a conversation's back goes when the app opened on it. */
  const lastTab = useRef<Tab>(tabOf(route) ?? "home");
  useEffect(() => {
    const t = tabOf(route);
    if (t) lastTab.current = t;
  }, [route]);

  // A pairing QR opened while already paired: the code is not needed, drop it from the address (the route stays).
  useEffect(() => {
    if (new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname + location.hash);
  }, []);

  // The desks list feeds Home and the conversation titles; ask for it whenever the mod link comes up.
  useEffect(() => {
    if (desk.connection === "open") desk.desks.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);

  // "Mac unreachable, last seen …": both sockets reconnect by themselves; this only says so.
  const linked = desk.connection === "open" && (catchUp.status === "open" || !attention.available);
  const lastLinked = useRef<string | null>(null);
  const [, setTickNow] = useState(0);
  useEffect(() => {
    if (linked) lastLinked.current = new Date().toISOString();
  }, [linked]);
  useEffect(() => {
    const t = setInterval(() => setTickNow((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const unreachable = desk.connection === "closed" || catchUp.status === "closed";
  // A closed mod socket may mean this phone was forgotten in Settings: ask /me once; a 401 sends us back to Pair.
  useEffect(() => {
    if (desk.connection !== "closed") return;
    void fetch(`${modBase()}/me`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => {
        if (r.status === 401) onUnpaired();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);

  const waiting = catchUpQueue(catchUp.items).length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) loki` : "loki";
  }, [waiting]);

  const openItem = (item: AttentionItem) => navigate({ kind: "conversation", agentId: item.agentId, conversationId: item.id, prefill: null });
  const later = (item: AttentionItem) => {
    catchUp.unread(item);
    if (!item.pendingApproval) catchUp.later(item); // approvals never snooze
  };
  const banner = unreachable ? <Banner>Mac unreachable · last seen {lastSeen(lastLinked.current)}</Banner> : null;

  const status = (
    <>
      <span>{me.name}</span>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: linked ? "var(--loki-positive)" : unreachable ? "var(--loki-negative)" : "var(--loki-muted)", flex: "0 0 auto" }} />
      <span>{linked ? "linked" : unreachable ? "reconnecting" : "connecting"}</span>
    </>
  );

  // The conversation on screen, from the route: its title and agent from the desks list, the inbox, or the agent list.
  const conv = route.kind === "conversation" ? route : null;
  const convDesk = conv ? desk.desks.list.find((d) => d.agentId === conv.agentId && d.conversationId === conv.conversationId) : undefined;
  const convItem = conv ? catchUp.items.find((i) => i.agentId === conv.agentId && i.id === conv.conversationId) : undefined;
  const agentNameOf = (id: string) => catchUp.agents.find((a) => a.id === id)?.name ?? desk.desks.list.find((d) => d.agentId === id)?.agentName ?? null;
  const thread: Thread | null = conv
    ? {
        agentId: conv.agentId,
        conversationId: conv.conversationId,
        title: convDesk?.title ?? convItem?.title ?? (conv.conversationId === "default" ? `${agentNameOf(conv.agentId) ?? "agent"} · main chat` : null),
        agentName: convDesk?.agentName ?? convItem?.agentName ?? agentNameOf(conv.agentId),
      }
    : null;
  // A `?prefill=` in the route starts the reply box once, then leaves the address so a reload does not repeat it.
  const prefillKey = conv?.prefill ? formatRoute(conv) : null;
  const prefill = useMemo(() => (conv?.prefill ? { text: conv.prefill, tick: Date.now() } : null), [prefillKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (conv?.prefill) replace({ ...conv, prefill: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);

  const recentFolders = useCallback(() => attention.folders.recent().then((r) => r.byAgent), []); // eslint-disable-line react-hooks/exhaustive-deps
  const onTab = route.kind === "tab";
  const tab = onTab ? route.tab : null;

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)", color: "var(--loki-fg)", fontFamily: "var(--loki-font)" }}>
      <PhoneStyles />
      {thread && (
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
      )}
      {route.kind === "agent" && <AgentPage agentId={route.agentId} name={agentNameOf(route.agentId)} desks={desk.desks.list} api={desk.agents} banner={banner} onBack={() => back({ kind: "tab", tab: "agents" })} />}
      {route.kind === "file" && <FilePage agentId={route.agentId} path={route.path} name={agentNameOf(route.agentId)} api={desk.agents} banner={banner} onBack={() => back({ kind: "agent", agentId: route.agentId })} />}

      {tab === "home" && (
        <Home desks={desk.desks.list} agents={catchUp.agents} items={catchUp.items} sub={status} banner={banner} onRefresh={desk.desks.request} onPin={desk.desks.pin} recentFolders={recentFolders} onCreate={(agentId, folder, name) => catchUp.createDesk(agentId, folder, name).then((rt) => (desk.desks.request(), rt))} />
      )}
      {/* The deck stays mounted under the other tabs and pages so the pass (n of N, dismissed cards) survives the round trip. */}
      <Inbox
        hidden={tab !== "inbox"}
        items={catchUp.items}
        loaded={catchUp.agentsLoaded}
        available={attention.available}
        banner={banner}
        conversation={catchUp.conversation}
        onLoad={(item) => void catchUp.loadHistory(item)}
        onOpen={openItem}
        onApprove={catchUp.approve}
        onSeen={catchUp.seen}
        onLater={later}
        onUnsnooze={catchUp.unsnooze}
        onUndo={(item, via) => (via === "seen" ? catchUp.unread(item) : catchUp.unsnooze(item))}
      />
      {tab === "agents" && <Agents agents={catchUp.agents} loaded={catchUp.agentsLoaded} desks={desk.desks.list} api={desk.agents} sub={status} banner={banner} />}
      {tab === "settings" && <Settings me={me} version={catchUp.server?.version ?? null} modLink={desk.connection} appServerLink={catchUp.status} sub={status} banner={banner} onUnpaired={onUnpaired} />}

      <UpdateBar servedBuild={desk.servedBuild} withTabBar={onTab} />
      {onTab && <TabBar active={tab} waiting={waiting} />}
    </div>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: `calc(24px + ${SAFE.top}) 24px calc(24px + ${SAFE.bottom})`, background: "var(--loki-bg)", color: "var(--loki-muted)", fontSize: 13.5, textAlign: "center", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 360 }}>{children}</div>
    </main>
  );
}
