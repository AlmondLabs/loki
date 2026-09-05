import { useEffect, useRef, useState } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { Gesture } from "../../../shared/desk-core.ts";
import { getPath, mergeData } from "../../../shared/desk-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { ChatBubble, ChatWindow, type ChatLayout } from "../chat/ChatWindow";
import { Plate, TitleBlock } from "./TitleBlock";
import { useDesk, type VisibleWidget } from "./useDesk";
import { Viewport } from "./Viewport";
import { WidgetFrame } from "./WidgetFrame";
import { ModuleWidget, WidgetError } from "./ModuleWidget";
import { DeskSwitcher } from "./DeskSwitcher";
import { CatchUp, catchUpQueue } from "./CatchUp";
import { useAttention } from "../attention/useAttention";
import { AgentChip } from "./AgentChip";
import { scopeFor } from "../../../shared/desk-core.ts";

function WidgetBody({
  w,
  gesture,
  reportError,
}: {
  w: VisibleWidget;
  gesture: (g: Gesture) => void;
  reportError: (id: string, message: string | null) => void;
}) {
  const { entry, overlay } = w;
  if (entry.kind === "module") return <ModuleWidget entry={entry} overlay={overlay} gesture={gesture} onError={reportError} />;
  if (entry.error) return <WidgetError message={entry.error} />;
  const Kit = entry.type ? KIT_COMPONENTS[entry.type] : undefined;
  if (!Kit) return <WidgetError message={`unknown kit type: ${entry.type}`} />;
  const data = mergeData(entry.data, overlay);
  const onSet = (path: string, value: unknown) => gesture({ kind: "set", id: entry.id, path, value, prev: getPath(data, path) });
  return <Kit data={data} onSet={onSet} />;
}

export function Surface() {
  const { scope, title, status, agentName, agentId, conversationId, connection, visible, closed, ownCount, desks, attention, gesture, measure, arrange, trash, reportWidgetError, cameraTarget, chat } = useDesk();
  const [chatOpen, setChatOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [chatLayout, setChatLayout] = useState<ChatLayout>(() => (localStorage.getItem("loci.chatLayout") === "center" ? "center" : "right"));
  const toggleChatLayout = () => {
    const next: ChatLayout = chatLayout === "center" ? "right" : "center";
    setChatLayout(next);
    localStorage.setItem("loci.chatLayout", next);
  };
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [catchUpOpen, setCatchUpOpen] = useState(false);
  const catchUp = useAttention({ enabled: attention.available, tunnelUrl: attention.tunnelUrl, seen: attention.seen, markSeen: attention.markSeen, unmarkSeen: attention.unmarkSeen });
  const waiting = catchUpQueue(catchUp.items).length;
  /** This desk's conversation as Catch Up sees it, so a pending permission shows in the chat panel too. */
  const thisConversation = agentId && conversationId ? catchUp.items.find((i) => i.agentId === agentId && i.id === conversationId) ?? null : null;
  const pendingApproval = thisConversation?.pendingApproval ?? null;

  // The tab title carries the count so it reads from across the room.
  useEffect(() => {
    const base = title ? `${title} · loci` : "loci";
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
  }, [waiting, title]);

  // ⌘K opens the desk switcher, ⌘⇧K opens Catch Up, ⌘⇧A tidies the desk (Ctrl on other platforms).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCatchUpOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((v) => {
          if (!v) desks.request();
          return !v;
        });
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        arrange();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const viewportRef = useRef<ReactZoomPanPinchRef | null>(null);

  // Widgets the camera is pointing at glow for a few seconds, so the eye finds them.
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  /** Focus: bring the widget to the front and zoom so it fills a good part of the viewport. */
  const focusWidget = (id: string) => {
    gesture({ kind: "focus", id });
    const elId = `widget-${id.replace("/", "--")}`;
    const el = document.getElementById(elId);
    const api = viewportRef.current;
    if (!el || !api) return;
    const wrapper = api.instance.wrapperComponent;
    const vw = wrapper?.clientWidth ?? window.innerWidth;
    const vh = wrapper?.clientHeight ?? window.innerHeight;
    const scale = Math.min(2.5, Math.max(0.5, Math.min((vw * 0.6) / el.offsetWidth, (vh * 0.7) / el.offsetHeight)));
    api.zoomToElement(elId, scale, 600, "easeOut");
    setHighlighted(new Set([id]));
    setTimeout(() => setHighlighted((h) => (h.has(id) && h.size === 1 ? new Set() : h)), 2500);
  };

  const trashWidget = (id: string) => {
    const w = visible.find((v) => v.entry.id === id);
    const name = w?.entry.title ?? id;
    if (window.confirm(`Delete "${name}"?\n\nThis removes the widget's file for good. Minimise instead if you may want it back.`)) trash(id);
  };

  // Camera glide when a widget lands or loci_camera asks. One id: zoom to it. Several: fit them all.
  // Elements may mount a beat after the frame arrives, so retry briefly.
  useEffect(() => {
    if (!cameraTarget) return;
    const ids = cameraTarget.widgetIds;
    const elIds = ids.map((id) => `widget-${id.replace("/", "--")}`);
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const els = elIds.map((e) => document.getElementById(e)).filter((e): e is HTMLElement => !!e);
      if (els.length === elIds.length) {
        const api = viewportRef.current;
        if (!api) return;
        if (els.length === 1) {
          api.zoomToElement(elIds[0], 1.15, 600, "easeOut");
        } else {
          // offsetLeft/Top/Width/Height are in canvas units (untransformed content coordinates)
          const left = Math.min(...els.map((e) => e.offsetLeft));
          const top = Math.min(...els.map((e) => e.offsetTop));
          const right = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
          const bottom = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
          const wrapper = api.instance.wrapperComponent;
          const vw = wrapper?.clientWidth ?? window.innerWidth;
          const vh = wrapper?.clientHeight ?? window.innerHeight;
          const pad = 80;
          const scale = Math.min(1.15, Math.max(0.1, Math.min((vw - pad * 2) / (right - left), (vh - pad * 2) / (bottom - top))));
          const x = vw / 2 - ((left + right) / 2) * scale;
          const y = vh / 2 - ((top + bottom) / 2) * scale;
          api.setTransform(x, y, scale, 600, "easeOut");
        }
        setHighlighted(new Set(ids));
      } else if (tries++ < 20) {
        timer = setTimeout(tick, 100);
      }
    };
    timer = setTimeout(tick, 60);
    const clear = setTimeout(() => setHighlighted(new Set()), 4000);
    return () => {
      clearTimeout(timer);
      clearTimeout(clear);
    };
  }, [cameraTarget]);

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        opacity: connection === "open" ? 1 : 0.55,
        transition: "opacity 200ms",
      }}
    >
      <div style={{ position: "absolute", inset: 0 }}>
      <Viewport ref={viewportRef} onScale={setScale}>
        {visible.map((w) => (
          <WidgetFrame
            key={w.entry.id}
            entry={w.entry}
            layout={w.layout}
            highlighted={highlighted.has(w.entry.id)}
            gesture={gesture}
            onMeasure={measure}
            onFocus={focusWidget}
            onTrash={trashWidget}
            getScale={() => viewportRef.current?.instance.state.scale ?? 1}
          >
            <WidgetBody w={w} gesture={gesture} reportError={reportWidgetError} />
          </WidgetFrame>
        ))}
      </Viewport>
      </div>

      <div style={{ position: "absolute", top: 10, right: chatOpen && chatLayout === "right" ? 412 : 12, transition: "right 200ms ease-out", display: "flex", alignItems: "stretch", gap: 8 }}>
        {visible.length > 1 && (
          <Plate onClick={arrange} title="tidy the desk into a grid (⌘⇧A)" ariaLabel="arrange widgets">
            arrange
          </Plate>
        )}
        <TitleBlock
          title={title}
          scope={scope}
          status={status}
          agentName={agentName}
          scale={scale}
          onOpenSwitcher={() => {
            desks.request();
            setSwitcherOpen(true);
          }}
        />
      </div>

      {attention.available && (
        <div style={{ position: "absolute", top: 10, left: 12 }}>
          <Plate onClick={() => setCatchUpOpen(true)} title="catch up on conversations waiting for you (⌘⇧K)" ariaLabel="catch up" accent={waiting > 0}>
            {waiting > 0 ? `${waiting} waiting · catch up` : "catch up"}
          </Plate>
        </div>
      )}

      <CatchUp
        open={catchUpOpen}
        onClose={() => setCatchUpOpen(false)}
        items={catchUp.items}
        onSeen={catchUp.seen}
        onUnread={catchUp.unread}
        onApprove={catchUp.approve}
        onReply={catchUp.reply}
        onOpenDesk={(agentId, conversationId) => desks.switchTo(scopeFor(conversationId, agentId))}
        histories={catchUp.histories}
        loadHistory={(item) => void catchUp.loadHistory(item)}
      />

      <DeskSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} desks={desks.list} current={scope} onSwitch={desks.switchTo} />

      {connection !== "open" && (
        <div className="loci-label" style={{ position: "absolute", bottom: 16, left: 16 }}>
          {connection === "connecting" ? "connecting…" : "disconnected · retrying"}
        </div>
      )}

      {closed.length > 0 && connection === "open" && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: "absolute", bottom: 16, left: 16, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", maxWidth: "60%" }}
          aria-label="minimised widgets"
        >
          <span className="loci-label" style={{ marginRight: 4 }}>minimised</span>
          {closed.map((entry) => (
            <button
              key={entry.id}
              onClick={() => gesture({ kind: "open", id: entry.id })}
              title={`restore ${entry.title}`}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid var(--loci-border)",
                background: "var(--loci-panel)",
                color: "var(--loci-fg)",
                cursor: "pointer",
              }}
            >
              {entry.title}
            </button>
          ))}
        </div>
      )}

      {chatOpen && (
        <ChatWindow
          messages={chat.messages}
          status={chat.status}
          error={chat.error}
          title={title}
          agentName={agentName}
          layout={chatLayout}
          onToggleLayout={toggleChatLayout}
          approval={pendingApproval}
          onApprove={(behavior) => {
            if (thisConversation && pendingApproval) catchUp.approve(thisConversation, pendingApproval.requestId, behavior);
          }}
          onSend={chat.send}
          onClose={() => setChatOpen(false)}
        />
      )}
      {!chatOpen && <ChatBubble open={chatOpen} alert={!!pendingApproval} onToggle={() => setChatOpen((v) => !v)} />}

      {ownCount === 0 && connection === "open" && (
        <div
          data-empty-desk
          style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", zIndex: 5 }}
        >
          <div style={{ textAlign: "center", color: "var(--loci-muted)", maxWidth: 460 }}>
            <div style={{ fontFamily: "var(--loci-display)", fontSize: 22, color: "var(--loci-fg)", lineHeight: 1.25 }}>Nothing on this desk yet.</div>
            <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.6 }}>{agentName ? `Ask ${agentName} to put something here.` : "Ask your agent to put something here."}</div>
            <div className="loci-label" style={{ marginTop: 14, fontSize: 10 }}>widgets are files · ~/.letta/loci/widgets/{scope}/</div>
          </div>
        </div>
      )}
    </div>
  );
}
