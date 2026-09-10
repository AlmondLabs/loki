import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { LAYER } from "../kit/layers";
import "./chat.css";
import type { PendingApproval, PendingQuestion } from "../../../packages/core/src/attention/model.ts";
import type { SlashCommand } from "../../../packages/core/src/attention/commands.ts";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import { Transcript, type TranscriptRow } from "./Transcript";
import { Chip } from "../components";
import type { ModelEntry } from "./ModelPicker";
import type { PermissionMode } from "./PermissionMode";
import { ChatHeader } from "./ChatHeader";
import { FindBar } from "./FindBar";
import { Composer } from "./Composer";
import { AttentionStrip } from "./AttentionStrip";
import { useChatTicks } from "./useChatTicks";
import { useModelAndMode } from "./useModelAndMode";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useAttentive } from "./useAttentive";
import { useDraft } from "./useDraft";

export type ChatMessage = TranscriptRow;
export type ChatStatus = "idle" | "thinking" | "streaming";

/**
 * The panel sits on the sheet in one of three places (⌘← / ⌘→ move it): stacked on the left
 * edge, floating centred and wider, or stacked on the right edge. Side placements come in two
 * widths and are viewport insets for the sheet; the centre floats over it.
 */
export type ChatWidth = "narrow" | "wide";
export const CHAT_WIDTHS: Record<ChatWidth, number> = { narrow: 400, wide: 640 };
export type ChatPlacement = "left" | "center" | "right";
export const CHAT_PLACEMENTS: ChatPlacement[] = ["left", "center", "right"];
/** The centred chat has the inbox card's footprint (CatchUp.tsx): the same width and the same insets. */
export const CHAT_CENTER_WIDTH = 1100;

export function ChatWindow({
  messages,
  status,
  error,
  agentName,
  width = "narrow",
  placement = "left",
  onToggleWidth,
  focusTick = 0,
  findTick = 0,
  prefill = null,
  model = null,
  models = null,
  onLoadModels,
  onPickModel,
  modelPickerTick = 0,
  mode = null,
  onPickMode,
  modeMenuTick = 0,
  approval = null,
  onApprove,
  question = null,
  onAnswer,
  onSend,
  commands,
  onCommand,
  onCancelQueued,
  onClose,
}: {
  messages: ChatMessage[];
  /** Take back a message typed mid-turn before it went out. */
  onCancelQueued?: (text: string) => void;
  status: ChatStatus;
  error: string | null;
  /** The agent on the other side. */
  agentName?: string | null;
  width?: ChatWidth;
  placement?: ChatPlacement;
  onToggleWidth?: () => void;
  /** Bumped by the host to put the caret in the message box. */
  focusTick?: number;
  /** Bumped by the host (⌘F) to open the find bar. */
  findTick?: number;
  /** Text the host wants in the box (an "ask the agent to…" from another view); a new tick replaces the draft. */
  prefill?: { text: string; tick: number } | null;
  /** The conversation's model and the switcher (list_models / update_model through the app-server). */
  model?: string | null;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (handle: string) => Promise<void>;
  /** Bumped by the host (⌘⇧M) to open the model picker. */
  modelPickerTick?: number;
  /** The conversation's permission mode and its setter (runtime_start { mode }). */
  mode?: string | null;
  onPickMode?: (mode: PermissionMode) => Promise<void>;
  /** Bumped by the host (⌘⇧P) to open the mode menu. */
  modeMenuTick?: number;
  /** The conversation is paused on a tool permission; the panel shows it inline. */
  approval?: PendingApproval | null;
  onApprove?: (behavior: "allow" | "deny") => void;
  /** The agent asked (AskUserQuestion); rendered as a card, answered in place. */
  question?: PendingQuestion | null;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  /** Slash commands the box offers (see packages/core/src/attention/commands.ts) and their runner. */
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { draft, setDraft, images, setImages, submit } = useDraft({ question, onAnswer, onSend, commands, onCommand });
  const { findOpen, setFindOpen, findRef } = useChatTicks({ focusTick, findTick, inputRef });
  useEffect(() => {
    if (!prefill || prefill.tick <= 0) return;
    setDraft(prefill.text);
    const t = setTimeout(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.tick]);
  const controls = useModelAndMode({ onLoadModels, onPickModel, onPickMode, modelPickerTick, modeMenuTick });
  const waiting = !!approval || !!question;
  const { attentive, setHover, setFocused } = useAttentive({ messageCount: messages.length, status, waiting });
  const { unpinned, onScroll, jumpToLatest, unpin } = useTranscriptScroll(scrollRef, messages, status);
  // One stable "take back" handler for the transcript. The host hands a fresh closure on every render; passing
  // that straight down broke the rows' memo and re-parsed a long thread's markdown on every keystroke.
  const cancelQueuedRef = useRef(onCancelQueued);
  useEffect(() => {
    cancelQueuedRef.current = onCancelQueued;
  }, [onCancelQueued]);
  const cancelQueued = useCallback((row: TranscriptRow) => cancelQueuedRef.current?.(row.text), []);

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      data-attentive={attentive ? "true" : "false"}
      style={panelStyle(placement, width, attentive)}
    >
      <ChatHeader width={width} placement={placement} onToggleWidth={onToggleWidth} onClose={onClose} />

      {findOpen && (
        <FindBar
          fieldRef={findRef}
          onFound={unpin}
          onEscape={() => {
            setFindOpen(false);
            inputRef.current?.focus();
          }}
          onClose={() => setFindOpen(false)}
        />
      )}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 16px", position: "relative", fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)" }}>
        <ThreadBody messages={messages} status={status} error={error} agentName={agentName} waiting={waiting} onCancelQueued={onCancelQueued ? cancelQueued : undefined} />
      </div>
      <AttentionStrip question={question} onAnswer={onAnswer} approval={approval} onApprove={onApprove} />
      {unpinned && (
        <Chip float onClick={jumpToLatest} aria-label="jump to latest" style={{ position: "absolute", bottom: 112, left: "50%", transform: "translateX(-50%)" }}>
          ↓ latest
        </Chip>
      )}

      <Composer
        inputRef={inputRef}
        draft={draft}
        onDraft={setDraft}
        images={images}
        onImages={setImages}
        onSubmit={submit}
        status={status}
        agentName={agentName}
        question={question}
        commands={commands}
        onCommand={onCommand}
        model={model}
        models={models}
        mode={mode}
        hasModelPicker={!!onPickModel}
        hasModeMenu={!!onPickMode}
        controls={controls}
      />
    </div>
  );
}

/**
 * Where the panel sits and how it reads: the three placements differ in edges and border, and the
 * whole thing fades to see-through when nothing is going on in it.
 */
function panelStyle(placement: ChatPlacement, width: ChatWidth, attentive: boolean): CSSProperties {
  return {
    position: "absolute",
    ...(placement === "center"
      ? { top: 20, bottom: 16, left: "50%", transform: "translateX(-50%)", width: CHAT_CENTER_WIDTH, maxWidth: "calc(100% - 48px)", border: "1px solid var(--loki-border)", borderRadius: 12 }
      : placement === "right"
        ? { top: 0, right: 0, bottom: 0, width: CHAT_WIDTHS[width], maxWidth: "100%", borderLeft: "1px solid var(--loki-border)" }
        : { top: 0, left: 0, bottom: 0, width: CHAT_WIDTHS[width], maxWidth: "100%", borderRight: "1px solid var(--loki-border)" }),
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    background: "var(--loki-panel)",
    boxShadow: attentive ? (placement === "center" ? "var(--loki-shadow-sheet)" : placement === "right" ? "var(--loki-shadow-panel)" : "var(--loki-shadow-panel)") : "none",
    overflow: "hidden",
    zIndex: LAYER.panel,
    opacity: attentive ? 1 : 0.6,
    transition: "opacity 220ms ease-out, box-shadow 220ms ease-out, width 200ms ease-out",
  };
}

/** What scrolls: a note when the thread is empty, the rows, and under them the thinking marker or the error. */
function ThreadBody({
  messages,
  status,
  error,
  agentName,
  waiting,
  onCancelQueued,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  agentName: string | null | undefined;
  waiting: boolean;
  onCancelQueued?: (row: TranscriptRow) => void;
}) {
  return (
    <>
      {messages.length === 0 && (
        <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: 8 }}>
          same conversation, different room — everything here lands in {agentName ? `${agentName}'s` : "the"} transcript
        </div>
      )}
      <Transcript rows={messages} streaming={status === "streaming"} onCancelQueued={onCancelQueued} />
      {status === "thinking" && !waiting && (
        <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: "6px 8px" }}>
          thinking…
        </div>
      )}
      {error && (
        <div style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", fontSize: 12, padding: "6px 8px" }}>{error}</div>
      )}
    </>
  );
}

export function ChatBubble({ open, onToggle, alert = false, side = "left" }: { open: boolean; onToggle: () => void; alert?: boolean; side?: "left" | "right" }) {
  return (
    <button
      data-alert={alert || undefined}
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="toggle chat"
      style={{
        position: "absolute",
        ...(side === "right" ? { right: 20 } : { left: 20 }),
        bottom: 20,
        width: 48,
        height: 48,
        borderRadius: 24,
        border: "1px solid var(--loki-border)",
        background: open ? "var(--loki-accent)" : "var(--loki-panel)",
        color: "var(--loki-fg)",
        fontSize: 17,
        cursor: "pointer",
        boxShadow: "var(--loki-shadow-panel)",
        zIndex: LAYER.bubble,
      }}
    >
      {open ? "×" : "✳"}
      {alert && !open && (
        <span
          aria-label="permission waiting"
          style={{ position: "absolute", top: -2, right: -2, width: 12, height: 12, borderRadius: 6, background: "var(--loki-accent)", border: "2px solid var(--loki-bg)" }}
        />
      )}
    </button>
  );
}
