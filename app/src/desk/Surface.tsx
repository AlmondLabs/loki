import { useEffect, useRef } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { getPath, mergeData } from "../../../core/desk-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { ChatBubble, ChatWindow, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import type { ControlledDraft } from "../chat/useDraft";
import type { useDesk, VisibleWidget } from "./useDesk";
import type { useAttention } from "../../../core/attention/useAttention.ts";
import { Viewport } from "./Viewport";
import { WidgetFrame } from "./WidgetFrame";
import { ModuleWidget, WidgetError } from "./ModuleWidget";
import { useCamera } from "./useCamera";
import { useChatInset } from "./useChatInset";
import type { DeskChatModel } from "./useDeskChat";
import { deskConversation, type DeskConversationHandlers } from "./deskConversation";
import type { FrameRequest } from "./pane";
import { Chip, Empty } from "../components";

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

/** How long the Desk tab's layout takes to settle (the sidebar hides, the canvas widens) before a frame request is framed. */
const FRAME_SETTLE_MS = 120;

interface SurfaceProps extends DeskConversationHandlers {
  desk: ReturnType<typeof useDesk>;
  catchUp: ReturnType<typeof useAttention>;
  /** The desk's conversation (useDeskChat), shared with the Messages tab. */
  chat: DeskChatModel;
  /**
   * The Desk tab is on screen. While it is not, the sheet stays mounted but its chat panel is not drawn
   * (the Messages tab has the box), an empty desk does not open its chat, and the sheet's keys stand down.
   */
  active?: boolean;
  /** The desk's draft, the same one the Messages tab edits. */
  draft?: ControlledDraft;
  /** Frame one widget once the tab has settled (a widget row in the thread asks; see desk/pane.ts). */
  frameRequest?: FrameRequest | null;
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
  modelPickerTick?: number;
  modeMenuTick?: number;
}

/**
 * The desk view: the sheet edge to edge, the chat stacked on the left over it. The chat's
 * rectangle is a viewport inset — every framing move (fit all, focus, camera glides) centres
 * in the uncovered part, and opening, closing or widening the chat slides the sheet by the
 * difference so what you were looking at stays in view.
 */
export function Surface(props: SurfaceProps) {
  const { desk, chat, chatOpen, onChatOpen, chatWidth, onChatWidth, chatPlacement, active = true, frameRequest = null } = props;
  const { scope, agentName, connection, visible, closed, ownCount, loaded, gesture, measure, arrange, trash, reportWidgetError, cameraTarget } = desk;

  // An empty desk on its Desk tab is a conversation, not a canvas: the chat opens by itself (the shell
  // centres it). Not while the Messages tab shows: a hidden chat is neither opened nor centred.
  const autoOpened = useRef(new Set<string>());
  const emptyDesk = loaded && connection === "open" && ownCount === 0;
  useEffect(() => {
    if (!active || !emptyDesk || autoOpened.current.has(scope)) return;
    autoOpened.current.add(scope);
    onChatOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, emptyDesk, scope]);
  const toggleChatWidth = () => onChatWidth(chatWidth === "wide" ? "narrow" : "wide");

  const { pendingApproval, pendingQuestion } = chat;

  const viewportRef = useRef<ReactZoomPanPinchRef | null>(null);
  const { insetRef, bubbleSide, trayLeft } = useChatInset({ chatOpen, chatPlacement, chatWidth, viewportRef, loaded, scope });
  const { highlighted, focusWidget } = useCamera({ viewportRef, insetRef, visible, gesture, cameraTarget, arrange, undo: desk.undo, active });

  // A frame request (a widget row chosen in the thread): once the Desk tab shows and its layout has settled
  // (the sidebar hides, so the canvas is wider than it was), frame the widget; it may mount a beat later.
  const framed = useRef(0);
  useEffect(() => {
    if (!active || !frameRequest || frameRequest.nonce === framed.current) return;
    const { widgetId, nonce } = frameRequest;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const go = () => {
      if (document.getElementById(`widget-${widgetId.replace("/", "--")}`)) {
        framed.current = nonce;
        focusWidget(widgetId);
      } else if (tries++ < 20) timer = setTimeout(go, 100);
      else framed.current = nonce;
    };
    timer = setTimeout(go, FRAME_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, frameRequest?.nonce]);

  const trashWidget = (id: string) => {
    const w = visible.find((v) => v.entry.id === id);
    const name = w?.entry.title ?? id;
    if (window.confirm(`Delete "${name}"?\n\nThis removes the widget's file for good. Minimise instead if you may want it back.`)) trash(id);
  };

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

      <ConnectionLabel connection={connection} left={trayLeft} />
      <MinimisedTray closed={closed} connection={connection} left={trayLeft} gesture={gesture} />

      {chatOpen && active && <DeskChat {...props} chat={chat} onToggleWidth={toggleChatWidth} />}
      {!chatOpen && <ChatBubble side={bubbleSide} open={chatOpen} alert={!!pendingApproval || !!pendingQuestion} onToggle={() => onChatOpen(!chatOpen)} />}

      <EmptyDesk show={ownCount === 0 && connection === "open" && !chatOpen} agentName={agentName} scope={scope} />
    </div>
  );
}

/** While the socket is not open: a small label where the tray would be. */
function ConnectionLabel({ connection, left }: { connection: ReturnType<typeof useDesk>["connection"]; left: number }) {
  if (connection === "open") return null;
  return (
    <div className="loki-label" style={{ position: "absolute", bottom: 30, left }}>
      {connection === "connecting" ? "Connecting…" : "Disconnected · retrying"}
    </div>
  );
}

/** Minimised widgets as chips along the bottom; a click restores one. */
function MinimisedTray({ closed, connection, left, gesture }: { closed: WidgetManifestEntry[]; connection: ReturnType<typeof useDesk>["connection"]; left: number; gesture: (g: Gesture) => void }) {
  if (!(closed.length > 0 && connection === "open")) return null;
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", bottom: 16, left, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", maxWidth: "60%", transition: "left 220ms ease-out" }}
      aria-label="minimised widgets"
    >
      <span className="loki-label" style={{ marginRight: 4 }}>Minimised</span>
      {closed.map((entry) => (
        <Chip key={entry.id} onClick={() => gesture({ kind: "open", id: entry.id })} title={`restore ${entry.title}`} float>
          {entry.title}
        </Chip>
      ))}
    </div>
  );
}

/** The first-run hint over a desk with nothing on it and the chat closed. */
function EmptyDesk({ show, agentName, scope }: { show: boolean; agentName: string | null; scope: string }) {
  if (!show) return null;
  return (
    <div data-empty-desk style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", zIndex: 5 }}>
      <Empty title="Nothing on this desk yet.">
        <p>{agentName ? `Ask ${agentName} to put something here.` : "Ask your agent to put something here."}</p>
        <div className="loki-label" style={{ marginTop: 14 }}>Widgets are files · ~/.letta/loki/widgets/{scope}/</div>
      </Empty>
    </div>
  );
}

/** The desk's chat window, wired to the conversation model and the shell's model and mode switchers. */
function DeskChat({
  chat,
  onToggleWidth,
  desk,
  catchUp,
  onChatOpen,
  chatWidth,
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
  draft,
}: SurfaceProps & { chat: DeskChatModel; onToggleWidth: () => void }) {
  const { title, agentName, agentId } = desk;
  const { view, actions } = deskConversation(desk, catchUp, chat, { onLoadModels, onPickModel, onPickMode });
  return (
    <ChatWindow
      title={title}
      agentName={agentName}
      agentId={agentId}
      view={view}
      actions={actions}
      models={models}
      width={chatWidth}
      placement={chatPlacement}
      onToggleWidth={onToggleWidth}
      focusTick={focusChat}
      findTick={findChat}
      prefill={chatPrefill}
      modelPickerTick={modelPickerTick}
      modeMenuTick={modeMenuTick}
      draft={draft}
      onClose={() => onChatOpen(false)}
    />
  );
}
