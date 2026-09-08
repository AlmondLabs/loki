import { useEffect, useRef, useState } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { Gesture } from "../../../packages/core/src/desk-core.ts";
import { conversationDirName, getPath, mergeData } from "../../../packages/core/src/desk-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { CHAT_WIDTHS, ChatBubble, ChatWindow, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import type { useDesk, VisibleWidget } from "./useDesk";
import type { useAttention } from "../../../packages/core/src/attention/useAttention.ts";
import { Viewport } from "./Viewport";
import { WidgetFrame } from "./WidgetFrame";
import { ModuleWidget, WidgetError } from "./ModuleWidget";
import { registerActions } from "../shell/keymap";

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

/** Bounds of a set of widget elements in canvas units (offset* are untransformed content coordinates). */
function boundsOf(els: HTMLElement[]) {
  const left = Math.min(...els.map((e) => e.offsetLeft));
  const top = Math.min(...els.map((e) => e.offsetTop));
  const right = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
  const bottom = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
  return { left, top, right, bottom, w: right - left, h: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/**
 * The desk view: the sheet edge to edge, the chat stacked on the left over it. The chat's
 * rectangle is a viewport inset — every framing move (fit all, focus, camera glides) centres
 * in the uncovered part, and opening, closing or widening the chat slides the sheet by the
 * difference so what you were looking at stays in view.
 */
export function Surface({
  desk,
  catchUp,
  chatOpen,
  onChatOpen,
  chatWidth,
  onChatWidth,
  chatPlacement,
  focusChat,
  findChat = 0,
  chatPrefill = null,
  models = null,
  onLoadModels,
  onPickModel,
  modelPickerTick = 0,
  onPickMode,
  modeMenuTick = 0,
}: {
  desk: ReturnType<typeof useDesk>;
  catchUp: ReturnType<typeof useAttention>;
  chatOpen: boolean;
  onChatOpen: (open: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  /** Where the panel sits; the shell owns it (⌘← / ⌘→) and centres it on an empty desk. */
  chatPlacement: ChatPlacement;
  /** Bumped by the shell to put the caret in the message box. */
  focusChat: number;
  /** Bumped by the shell (⌘F) to open the chat's find bar. */
  findChat?: number;
  chatPrefill?: { text: string; tick: number } | null;
  models?: import("../chat/ModelPicker").ModelEntry[] | null;
  onLoadModels?: () => void;
  /** Switch this desk's conversation to a model; the shell talks to the app-server. */
  onPickModel?: (scope: string, rt: { agent_id: string; conversation_id: string }, handle: string) => Promise<void>;
  modelPickerTick?: number;
  /** Set this desk's conversation permission mode; the shell talks to the app-server. */
  onPickMode?: (scope: string, rt: { agent_id: string; conversation_id: string }, mode: string) => Promise<void>;
  modeMenuTick?: number;
}) {
  const { scope, title, status, agentName, agentId, conversationId, connection, visible, closed, ownCount, loaded, attention, gesture, measure, arrange, trash, reportWidgetError, cameraTarget } = desk;
  const [deskFolder, setDeskFolder] = useState<string | null>(null);

  // An empty desk is a conversation, not a canvas: the chat opens by itself (the shell centres it).
  const autoOpened = useRef(new Set<string>());
  const emptyDesk = loaded && connection === "open" && ownCount === 0;
  useEffect(() => {
    if (!emptyDesk || autoOpened.current.has(scope)) return;
    autoOpened.current.add(scope);
    onChatOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyDesk, scope]);
  const toggleChatWidth = () => onChatWidth(chatWidth === "wide" ? "narrow" : "wide");

  // The desk's conversation, from the same model the inbox uses: subscribed while the desk is open,
  // transcript loaded when the chat opens, streaming rows and approvals shared with the deck.
  const deskRuntime = agentId && conversationId ? { agent_id: agentId, conversation_id: conversationId } : null;
  const deskChat = deskRuntime ? catchUp.conversation(deskRuntime.agent_id, deskRuntime.conversation_id) : null;
  const pendingApproval = deskChat?.pending ?? null;
  const pendingQuestion = deskChat?.question ?? null;
  useEffect(() => {
    if (deskRuntime && catchUp.status === "open") void catchUp.subscribe(deskRuntime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, catchUp.status]);
  useEffect(() => {
    if (!deskRuntime) return setDeskFolder(null);
    void attention.folders.recent().then((r) => setDeskFolder(r.byConversation[conversationDirName(deskRuntime.conversation_id, deskRuntime.agent_id)] ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, connection]);
  useEffect(() => {
    if (chatOpen && deskRuntime && catchUp.status === "open") void catchUp.loadThread(deskRuntime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, agentId, conversationId, catchUp.status]);

  const viewportRef = useRef<ReactZoomPanPinchRef | null>(null);

  // The sheet's actions, by keymap id: the shell's one key handler (and the menu bar) dispatch to these.
  useEffect(
    () =>
      registerActions({
        "view.fit": () => fitAllRef.current(),
        "view.reset": () => resetZoomRef.current(),
        "view.zoomIn": () => zoomBy(1.25),
        "view.zoomOut": () => zoomBy(1 / 1.25),
        "desk.arrange": () => arrange(),
        "desk.undo": () => {
          if (!desk.undo()) console.info("loki: nothing to undo on the sheet");
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** How much of the viewport's left and right edges the chat covers right now (a centred chat floats: no inset). */
  const sideWidth = chatOpen && chatPlacement !== "center" ? CHAT_WIDTHS[chatWidth] : 0;
  const inset = chatPlacement === "left" ? sideWidth : 0;
  const insetRight = chatPlacement === "right" ? sideWidth : 0;
  const insetRef = useRef({ left: inset, right: insetRight });
  insetRef.current = { left: inset, right: insetRight };
  // Slide the sheet with the chat on the left: open → content moves right by the chat's width, close → back.
  const prevInset = useRef(inset);
  useEffect(() => {
    const delta = inset - prevInset.current;
    prevInset.current = inset;
    const api = viewportRef.current;
    if (!delta || !api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    api.setTransform(positionX + delta, positionY, s, 220, "easeOut");
  }, [inset]);

  // Each desk starts at 1:1 with the sheet's origin at the chat's edge, so a layout that
  // begins at x = 0 is never born under the panel.
  const cameraReset = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || cameraReset.current === scope) return;
    cameraReset.current = scope;
    viewportRef.current?.setTransform(insetRef.current.left, 0, 1, 0);
  }, [loaded, scope]);

  /** The visible part of the viewport: everything the chat does not cover. */
  const stage = () => {
    const api = viewportRef.current;
    const wrapper = api?.instance.wrapperComponent;
    const vw = wrapper?.clientWidth ?? window.innerWidth;
    const vh = wrapper?.clientHeight ?? window.innerHeight;
    const { left, right } = insetRef.current;
    return { left, w: Math.max(200, vw - left - right), h: vh };
  };
  /** Move the camera so `els` sit centred in the stage at scale `s`. */
  const frameAt = (els: HTMLElement[], s: number, ms = 600) => {
    const api = viewportRef.current;
    if (!api) return;
    const st = stage();
    const b = boundsOf(els);
    api.setTransform(st.left + st.w / 2 - b.cx * s, st.h / 2 - b.cy * s, s, ms, "easeOut");
  };
  const widgetEls = (ids: string[]) => ids.map((id) => document.getElementById(`widget-${id.replace("/", "--")}`)).filter((e): e is HTMLElement => !!e);

  // Widgets the camera is pointing at glow for a few seconds, so the eye finds them.
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  /** Fit every visible widget into the stage (⌘0). */
  const fitAll = () => {
    const els = widgetEls(visible.map((w) => w.entry.id));
    if (!els.length) return;
    const st = stage();
    const b = boundsOf(els);
    const pad = 80;
    frameAt(els, Math.min(1.5, Math.max(0.1, Math.min((st.w - pad * 2) / b.w, (st.h - pad * 2) / b.h))));
  };
  /** Zoom about the stage centre by a factor (⌘= / ⌘-). */
  const zoomBy = (factor: number) => {
    const api = viewportRef.current;
    if (!api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    const next = Math.min(4, Math.max(0.1, s * factor));
    const k = next / s;
    const st = stage();
    const cx = st.left + st.w / 2;
    const cy = st.h / 2;
    api.setTransform(cx - (cx - positionX) * k, cy - (cy - positionY) * k, next, 180, "easeOut");
  };
  /** Back to 1:1 around the stage centre (⌘⇧0). */
  const resetZoom = () => {
    const api = viewportRef.current;
    if (!api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    const st = stage();
    const cx = st.left + st.w / 2;
    const cy = st.h / 2;
    // keep the canvas point under the centre where it is
    api.setTransform(cx - (cx - positionX) / s, cy - (cy - positionY) / s, 1, 500, "easeOut");
  };
  const fitAllRef = useRef(fitAll);
  fitAllRef.current = fitAll;
  const resetZoomRef = useRef(resetZoom);
  resetZoomRef.current = resetZoom;

  /** Focus: bring the widget to the front and zoom so it fills a good part of the stage. */
  const focusWidget = (id: string) => {
    gesture({ kind: "focus", id });
    const els = widgetEls([id]);
    if (!els.length) return;
    const st = stage();
    const el = els[0];
    frameAt(els, Math.min(2.5, Math.max(0.5, Math.min((st.w * 0.6) / el.offsetWidth, (st.h * 0.7) / el.offsetHeight))));
    setHighlighted(new Set([id]));
    setTimeout(() => setHighlighted((h) => (h.has(id) && h.size === 1 ? new Set() : h)), 2500);
  };

  const trashWidget = (id: string) => {
    const w = visible.find((v) => v.entry.id === id);
    const name = w?.entry.title ?? id;
    if (window.confirm(`Delete "${name}"?\n\nThis removes the widget's file for good. Minimise instead if you may want it back.`)) trash(id);
  };

  // Camera glide when a widget lands or loki_camera asks. One id: zoom to it. Several: fit them all.
  // Elements may mount a beat after the frame arrives, so retry briefly.
  useEffect(() => {
    if (!cameraTarget) return;
    const ids = cameraTarget.widgetIds;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const els = widgetEls(ids);
      if (els.length === ids.length) {
        if (els.length === 1) {
          frameAt(els, 1.15);
        } else {
          const st = stage();
          const b = boundsOf(els);
          const pad = 80;
          frameAt(els, Math.min(1.15, Math.max(0.1, Math.min((st.w - pad * 2) / b.w, (st.h - pad * 2) / b.h))));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraTarget]);

  /** The reopen bubble sits on the chat's side; the minimised tray keeps clear of both. */
  const bubbleSide = chatPlacement === "right" ? "right" : "left";
  const trayLeft = inset + (chatOpen ? 16 : bubbleSide === "left" ? 80 : 16);

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
        <Viewport ref={viewportRef}>
          {visible.map((w, i) => (
            <WidgetFrame
              key={w.entry.id}
              order={i}
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

      {connection !== "open" && (
        <div className="loki-label" style={{ position: "absolute", bottom: 30, left: trayLeft }}>
          {connection === "connecting" ? "connecting…" : "disconnected · retrying"}
        </div>
      )}

      {closed.length > 0 && connection === "open" && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{ position: "absolute", bottom: 16, left: trayLeft, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", maxWidth: "60%", transition: "left 220ms ease-out" }}
          aria-label="minimised widgets"
        >
          <span className="loki-label" style={{ marginRight: 4 }}>minimised</span>
          {closed.map((entry) => (
            <button
              key={entry.id}
              onClick={() => gesture({ kind: "open", id: entry.id })}
              title={`restore ${entry.title}`}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid var(--loki-border)",
                background: "var(--loki-panel)",
                color: "var(--loki-fg)",
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
          messages={deskChat?.rows ?? []}
          status={deskChat?.status ?? "idle"}
          error={!attention.available ? "chat needs Letta's app-server — is a harness running?" : deskChat?.error ?? null}
          agentName={agentName}
          width={chatWidth}
          placement={chatPlacement}
          onToggleWidth={toggleChatWidth}
          focusTick={focusChat}
          findTick={findChat}
          prefill={chatPrefill}
          model={desk.model}
          models={models}
          onLoadModels={onLoadModels}
          onPickModel={deskRuntime && onPickModel ? (h) => onPickModel(scope, deskRuntime, h) : undefined}
          modelPickerTick={modelPickerTick}
          mode={deskChat?.mode ?? desk.mode}
          onPickMode={deskRuntime && onPickMode ? (m) => onPickMode(scope, deskRuntime, m) : undefined}
          modeMenuTick={modeMenuTick}
          approval={pendingApproval}
          question={pendingQuestion}
          onAnswer={(answers) => {
            if (deskRuntime && pendingQuestion) catchUp.answer(deskRuntime, pendingQuestion.requestId, answers);
          }}
          onApprove={(behavior) => {
            if (deskRuntime && pendingApproval) catchUp.decide(deskRuntime, pendingApproval.requestId, behavior);
          }}
          onSend={(text, images) => deskRuntime && catchUp.send(deskRuntime, text, images, { folder: deskFolder, desk: title })}
          onCancelQueued={(text) => deskRuntime && catchUp.cancelQueued(deskRuntime, text)}
          onClose={() => onChatOpen(false)}
        />
      )}
      {!chatOpen && <ChatBubble side={bubbleSide} open={chatOpen} alert={!!pendingApproval || !!pendingQuestion} onToggle={() => onChatOpen(!chatOpen)} />}

      {ownCount === 0 && connection === "open" && !chatOpen && (
        <div data-empty-desk style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", zIndex: 5 }}>
          <div style={{ textAlign: "center", color: "var(--loki-muted)", maxWidth: 460 }}>
            <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, color: "var(--loki-fg)", lineHeight: 1.25 }}>Nothing on this desk yet.</div>
            <div style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.6 }}>{agentName ? `Ask ${agentName} to put something here.` : "Ask your agent to put something here."}</div>
            <div className="loki-label" style={{ marginTop: 14, fontSize: 10.5 }}>widgets are files · ~/.letta/loki/widgets/{scope}/</div>
          </div>
        </div>
      )}
    </div>
  );
}
