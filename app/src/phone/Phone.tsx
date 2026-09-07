import { useCallback, useEffect, useRef, useState } from "react";
import { useAttention } from "../../../packages/core/src/attention/useAttention.ts";
import { catchUpQueue } from "../../../packages/core/src/attention/queue.ts";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import { makeTransport } from "../attention/transport";
import { modBase } from "../desk/env";
import { useDesk } from "../desk/useDesk";
import { Conversation, type Thread } from "./Conversation";
import { Inbox } from "./Inbox";
import { Pair, type Me } from "./Pair";
import { lastSeen } from "./model";
import { Banner, SAFE, TopBar, tap } from "./ui";

/**
 * Phone mode: the second shell. The mod serves this page over the Wi‑Fi with `__LOKI__.lan` set and
 * lets the device in by cookie. `GET /me` decides between Pair and the inbox; once paired, the same
 * two hooks the desktop shell uses (useDesk for the mod, useAttention for the app-server tunnel)
 * feed a single column: the inbox, and one conversation at a time.
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
  const [thread, setThread] = useState<Thread | null>(null);

  // A pairing QR opened while already paired: the code is not needed, drop it from the address.
  useEffect(() => {
    if (new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname);
  }, []);

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

  const open = (item: AttentionItem) => setThread({ agentId: item.agentId, conversationId: item.id, title: item.title, agentName: item.agentName });
  const later = (item: AttentionItem) => {
    catchUp.unread(item);
    if (!item.pendingApproval) catchUp.later(item); // approvals never snooze
  };
  const banner = unreachable ? <Banner>Mac unreachable · last seen {lastSeen(lastLinked.current)}</Banner> : null;

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)", color: "var(--loki-fg)", fontFamily: "var(--loki-font)" }}>
      {thread ? (
        <Conversation
          thread={thread}
          view={catchUp.conversation(thread.agentId, thread.conversationId)}
          waiting={catchUp.items.some((i) => i.agentId === thread.agentId && i.id === thread.conversationId && catchUpQueue([i]).length > 0)}
          banner={banner}
          onBack={() => setThread(null)}
          onLoad={(rt) => void catchUp.loadThread(rt)}
          onDecide={catchUp.decide}
          onAnswer={catchUp.answer}
          onSend={(rt, text, deskTitle) => catchUp.send(rt, text, [], { desk: deskTitle })}
          onSeen={(rt) => attention.markSeen(rt.agent_id, rt.conversation_id)}
        />
      ) : (
        <>
          <TopBar
            title={waiting > 0 ? `Inbox · ${waiting} waiting` : "Inbox"}
            sub={
              <>
                <span>{me.name}</span>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: linked ? "var(--loki-positive)" : unreachable ? "var(--loki-negative)" : "var(--loki-muted)", flex: "0 0 auto" }} />
                <span>{linked ? "linked" : unreachable ? "reconnecting" : "connecting"}</span>
              </>
            }
          />
          {banner}
          <Inbox items={catchUp.items} loaded={catchUp.agentsLoaded} available={attention.available} onOpen={open} onApprove={catchUp.approve} onSeen={catchUp.seen} onLater={later} onUnsnooze={catchUp.unsnooze} />
        </>
      )}
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
