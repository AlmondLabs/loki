import { useEffect, useRef } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { getPath, mergeData } from "../../../core/desk-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { ChatBubble, ChatWindow, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import type { ConversationActions, ConversationView } from "../chat/Conversation";
import type { useDesk, VisibleWidget } from "./useDesk";
import type { useAttention } from "../../../core/attention/useAttention.ts";
import { Viewport } from "./Viewport";
import { WidgetFrame } from "./WidgetFrame";
import { ModuleWidget, WidgetError } from "./ModuleWidget";
import { useCamera } from "./useCamera";
import { useChatInset } from "./useChatInset";
import { useDeskChat, type DeskChatModel } from "./useDeskChat";
import { Chip, Empty } from "../components";
import { LOKI_COMMANDS } from "../../../core/attention/commands.ts";
import { runAction } from "../shell/keymap";
import type { ModelSelection } from "../../../core/models.ts";

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

interface SurfaceProps {
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
  onPickModel?: (scope: string, rt: { agent_id: string; conversation_id: string }, selection: ModelSelection) => Promise<void>;
  modelPickerTick?: number;
  /** Set this desk's conversation permission mode; the shell talks to the app-server. */
  onPickMode?: (scope: string, rt: { agent_id: string; conversation_id: string }, mode: string) => Promise<void>;
  modeMenuTick?: number;
}

/**
 * The desk view: the sheet edge to edge, the chat stacked on the left over it. The chat's
 * rectangle is a viewport inset — every framing move (fit all, focus, camera glides) centres
 * in the uncovered part, and opening, closing or widening the chat slides the sheet by the
 * difference so what you were looking at stays in view.
 */
export function Surface(props: SurfaceProps) {
  const { desk, catchUp, chatOpen, onChatOpen, chatWidth, onChatWidth, chatPlacement } = props;
  const { scope, agentName, agentId, conversationId, connection, visible, closed, ownCount, loaded, attention, gesture, measure, arrange, trash, reportWidgetError, cameraTarget } = desk;

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

  const chat = useDeskChat({ agentId, conversationId, connection, chatOpen, catchUp, attention });
  const { pendingApproval, pendingQuestion } = chat;

  const viewportRef = useRef<ReactZoomPanPinchRef | null>(null);
  const { insetRef, bubbleSide, trayLeft } = useChatInset({ chatOpen, chatPlacement, chatWidth, viewportRef, loaded, scope });
  const { highlighted, focusWidget } = useCamera({ viewportRef, insetRef, visible, gesture, cameraTarget, arrange, undo: desk.undo });

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

      {chatOpen && <DeskChat {...props} chat={chat} onToggleWidth={toggleChatWidth} />}
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
}: SurfaceProps & { chat: DeskChatModel; onToggleWidth: () => void }) {
  const { scope, title, agentName, agentId, attention } = desk;
  const { deskRuntime, deskChat, pendingApproval, pendingQuestion, deskFolder } = chat;
  const view: ConversationView = {
    rows: deskChat?.rows ?? [],
    status: deskChat?.status ?? "idle",
    error: !attention.available ? "chat needs Letta's app-server — is a harness running?" : deskChat?.error ?? null,
    model: desk.model,
    reasoningEffort: desk.reasoningEffort,
    mode: deskChat?.mode ?? desk.mode,
    approval: pendingApproval,
    question: pendingQuestion,
  };
  const actions: ConversationActions = {
    onSend: (text, images) => deskRuntime && catchUp.send(deskRuntime, text, images, { folder: deskFolder.current, desk: title, origin: "desk" }),
    onAnswer: (answers) => {
      if (deskRuntime && pendingQuestion) catchUp.answer(deskRuntime, pendingQuestion.requestId, answers);
    },
    onApprove: (behavior) => {
      if (deskRuntime && pendingApproval) catchUp.decide(deskRuntime, pendingApproval.requestId, behavior);
    },
    commands: catchUp.commands,
    onCommand: (id, args) => {
      // loki's own commands are keymap actions; everything else is the harness's, run for this conversation.
      const local = LOKI_COMMANDS.find((c) => c.id === id);
      if (local?.action) runAction(local.action);
      else if (deskRuntime) void catchUp.execute(deskRuntime, id, args);
    },
    onLoadModels,
    onPickModel: deskRuntime && onPickModel ? (selection) => onPickModel(scope, deskRuntime, selection) : undefined,
    onPickMode: deskRuntime && onPickMode ? (m) => onPickMode(scope, deskRuntime, m) : undefined,
    onCancelQueued: (text) => deskRuntime && catchUp.cancelQueued(deskRuntime, text),
  };
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
      onClose={() => onChatOpen(false)}
    />
  );
}
