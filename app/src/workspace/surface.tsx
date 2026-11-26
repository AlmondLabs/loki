import { useEffect, useEffectEvent, useRef } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { ModelEntry } from "../chat/model-picker";
import type { Gesture, WidgetManifestEntry } from "../../../core/canvas-core.ts";
import { getPath, mergeData } from "../../../core/canvas-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { ChatBubble, ChatWindow, type ChatPlacement, type ChatWidth } from "../chat/chat-window";
import type { ControlledDraft } from "../chat/use-draft";
import type { useWorkspace, VisibleWidget } from "./use-workspace";
import { useThreadRows, type useAttention } from "../../../core/attention/use-attention.ts";
import { Viewport } from "./viewport";
import { WidgetFrame } from "./widget-frame";
import { ModuleWidget, WidgetError } from "./module-widget";
import { useCamera } from "./use-camera";
import { useChatInset } from "./use-chat-inset";
import type { DeskChatModel } from "./use-workspace-chat";
import { deskConversation, type DeskConversationHandlers } from "./workspace-conversation";
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
  if (entry.kind === "module") return <ModuleWidget entry={entry} overlay={overlay} gesture={gesture} onError={reportError} fill={w.layout.sized === true} />;
  if (entry.error) return <WidgetError message={entry.error} />;
  const Kit = entry.type ? KIT_COMPONENTS[entry.type] : undefined;
  if (!Kit) return <WidgetError message={`unknown kit type: ${entry.type}`} />;
  const data = mergeData(entry.data, overlay);
  const onSet = (path: string, value: unknown) => gesture({ kind: "set", id: entry.id, path, value, prev: getPath(data, path) });
  return <Kit data={data} onSet={onSet} />;
}

const FRAME_SETTLE_MS = 120;

interface SurfaceProps extends DeskConversationHandlers {
  desk: ReturnType<typeof useWorkspace>;
  catchUp: ReturnType<typeof useAttention>;
  chat: DeskChatModel;
  active?: boolean;
  draft?: ControlledDraft;
  frameRequest?: FrameRequest | null;
  chatOpen: boolean;
  onChatOpen: (open: boolean) => void;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  focusChat: number;
  findChat?: number;
  chatPrefill?: { text: string; tick: number } | null;
  models?: ModelEntry[] | null;
  modelPickerTick?: number;
  modeMenuTick?: number;
  suggestionsTick?: number;
}

export function Surface(props: SurfaceProps) {
  const { desk, chat, chatOpen, onChatOpen, chatWidth, onChatWidth, chatPlacement, active = true, frameRequest = null } = props;
  const { scope, agentName, connection, visible, closed, ownCount, loaded, gesture, measure, arrange, trash, reportWidgetError, cameraTarget } = desk;

  const autoOpened = useRef(new Set<string>());
  const emptyCanvas = loaded && connection === "open" && ownCount === 0;
  const openChat = useEffectEvent(() => onChatOpen(true));
  useEffect(() => {
    if (!active || !emptyCanvas || autoOpened.current.has(scope)) return;
    autoOpened.current.add(scope);
    openChat();
  }, [active, emptyCanvas, scope]);
  const toggleChatWidth = () => onChatWidth(chatWidth === "wide" ? "narrow" : "wide");

  const { pendingApproval, pendingQuestion } = chat;

  const viewportRef = useRef<ReactZoomPanPinchRef | null>(null);
  const { insetRef, bubbleSide, trayLeft } = useChatInset({ chatOpen, chatPlacement, chatWidth, viewportRef, loaded, scope });
  const { highlighted, focusWidget } = useCamera({ viewportRef, insetRef, visible, gesture, cameraTarget, arrange, undo: desk.undo, active });

  const framed = useRef(0);
  const frameNonce = frameRequest?.nonce;
  const frameWidgetId = frameRequest?.widgetId;
  const frameWidget = useEffectEvent((id: string) => focusWidget(id));
  useEffect(() => {
    if (!active || frameNonce === undefined || frameWidgetId === undefined || frameNonce === framed.current) return;
    const widgetId = frameWidgetId;
    const nonce = frameNonce;
    const started = Date.now();
    const timer = setInterval(() => {
      const waited = Date.now() - started;
      if (waited < FRAME_SETTLE_MS) return;
      const found = !!document.getElementById(`widget-${widgetId.replace("/", "--")}`);
      if (!found && waited < FRAME_SETTLE_MS + 2000) return;
      clearInterval(timer);
      framed.current = nonce;
      if (found) frameWidget(widgetId);
    }, 60);
    return () => clearInterval(timer);
  }, [active, frameNonce, frameWidgetId]);

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

      {chatOpen && active && <DeskChat key={props.desk.scope} {...props} chat={chat} onToggleWidth={toggleChatWidth} />}
      {!chatOpen && <ChatBubble side={bubbleSide} open={chatOpen} alert={!!pendingApproval || !!pendingQuestion} onToggle={() => onChatOpen(!chatOpen)} />}

      <EmptyDesk show={ownCount === 0 && connection === "open" && !chatOpen} agentName={agentName} scope={scope} />
    </div>
  );
}

function ConnectionLabel({ connection, left }: { connection: ReturnType<typeof useWorkspace>["connection"]; left: number }) {
  if (connection === "open") return null;
  return (
    <div className="loki-label" style={{ position: "absolute", bottom: 30, left }}>
      {connection === "connecting" ? "Connecting…" : "Disconnected · retrying"}
    </div>
  );
}

function MinimisedTray({
  closed,
  connection,
  left,
  gesture,
}: {
  closed: WidgetManifestEntry[];
  connection: ReturnType<typeof useWorkspace>["connection"];
  left: number;
  gesture: (g: Gesture) => void;
}) {
  if (!(closed.length > 0 && connection === "open")) return null;
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="flex flex-wrap items-center gap-2"
      style={{
        position: "absolute",
        bottom: 16,
        left: 0,
        transform: `translateX(${left}px)`,
        maxWidth: "60%",
        transition: "transform 220ms ease-out",
      }}
      aria-label="Minimised widgets"
    >
      <span className="loki-label" style={{ marginRight: 4 }}>
        Minimised
      </span>
      {closed.map((entry) => (
        <Chip key={entry.id} onClick={() => gesture({ kind: "open", id: entry.id })} title={`Restore ${entry.title}`} float>
          {entry.title}
        </Chip>
      ))}
    </div>
  );
}

function EmptyDesk({ show, agentName, scope }: { show: boolean; agentName: string | null; scope: string }) {
  if (!show) return null;
  return (
    <div data-empty-desk className="grid place-items-center" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      <Empty title="Nothing on this canvas yet.">
        <p>{agentName ? `Ask ${agentName} to put something here.` : "Ask your agent to put something here."}</p>
        <div className="loki-label" style={{ marginTop: 12 }}>
          Widgets are files · ~/.loki/widgets/{scope}/
        </div>
      </Empty>
    </div>
  );
}

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
  suggestionsTick = 0,
  draft,
}: SurfaceProps & { chat: DeskChatModel; onToggleWidth: () => void }) {
  const { title, agentName, agentId, conversationId } = desk;
  const purpose = desk.desks.list.find((d) => d.scope === desk.scope)?.purpose ?? null;
  const rows = useThreadRows(catchUp, agentId, conversationId);
  const { view, actions } = deskConversation(desk, catchUp, chat, { onLoadModels, onPickModel, onPickMode }, rows);
  return (
    <ChatWindow
      title={title}
      purpose={purpose}
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
      suggestionsTick={suggestionsTick}
      draft={draft}
      suggestions={agentId && conversationId ? { source: catchUp, rt: { agent_id: agentId, conversation_id: conversationId } } : null}
      onClose={() => onChatOpen(false)}
    />
  );
}
