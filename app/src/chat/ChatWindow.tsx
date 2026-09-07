import { useEffect, useRef, useState } from "react";
import { LAYER } from "../kit/layers";
import "./chat.css";
import { ChatInput } from "./ChatInput";
import type { PendingApproval, PendingQuestion } from "../attention/model";
import { QuestionCard } from "./QuestionCard";
import type { ImageAttachment } from "../attention/content";
import { ApprovalCard } from "./ApprovalCard";
import { Transcript, type TranscriptRow } from "./Transcript";
import { btn } from "./ui";
import { ModelChip, ModelPicker, type ModelEntry } from "./ModelPicker";
import { ModeChip, ModeMenu, isPermissionMode, type PermissionMode } from "./PermissionMode";

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
export const CHAT_CENTER_WIDTH = 760;

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
  onClose,
}: {
  messages: ChatMessage[];
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
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTick > 0) setTimeout(() => inputRef.current?.focus(), 0);
  }, [focusTick]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (modelPickerTick > 0 && onPickModel) {
      onLoadModels?.();
      setPickerOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPickerTick]);
  const [modeOpen, setModeOpen] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  useEffect(() => {
    if (modeMenuTick > 0 && onPickMode) setModeOpen(true);
  }, [modeMenuTick, onPickMode]);
  const pickMode = async (m: PermissionMode) => {
    if (!onPickMode) return;
    setModeOpen(false);
    setChangingMode(true);
    await onPickMode(m);
    setChangingMode(false);
  };
  const pickModel = async (handle: string) => {
    if (!onPickModel) return;
    setPickerOpen(false);
    setSwitching(true);
    await onPickModel(handle);
    setSwitching(false);
  };
  useEffect(() => {
    if (prefill && prefill.tick > 0) {
      setDraft(prefill.text);
      setTimeout(() => {
        const el = inputRef.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.tick]);
  // Find in the transcript: the browser's own text search, scoped by starting from the transcript and
  // wrapping. Enter finds the next match, ⇧Enter the previous, Esc closes.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (findTick > 0) {
      setFindOpen(true);
      setTimeout(() => findRef.current?.select(), 0);
    }
  }, [findTick]);
  const findNext = (backwards = false) => {
    const q = findQuery.trim();
    if (!q) return;
    const w = window as Window & { find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrap?: boolean) => boolean };
    const found = w.find?.(q, false, backwards, true) ?? false;
    if (found) {
      const sel = document.getSelection();
      const node = sel?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      el?.scrollIntoView({ block: "center" });
      pinnedRef.current = false;
      setUnpinned(true);
    }
    findRef.current?.focus();
  };

  // The panel is see-through unless you are using it: hovered, focused, or a reply is arriving.
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    setRecent(true);
    const t = setTimeout(() => setRecent(false), 2500);
    return () => clearTimeout(t);
  }, [messages.length, status]);
  const attentive = hover || focused || recent || status !== "idle" || !!approval || !!question;

  // Follow the bottom only while the reader is there. Scrolling up to read
  // older messages must survive streaming deltas; sending a message re-pins.
  const pinnedRef = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = pinned;
    setUnpinned(!pinned);
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnpinned(false);
    el.scrollTo({ top: el.scrollHeight });
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (pinnedRef.current || last?.role === "user") {
      pinnedRef.current = true;
      setUnpinned(false);
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status]);

  const submit = () => {
    const text = draft.trim();
    if ((!text && !images.length) || status !== "idle") return;
    setDraft("");
    setImages([]);
    // A typed reply while one question is open is the answer to it.
    if (question && onAnswer && question.questions.length === 1 && text && !images.length) {
      onAnswer({ [question.questions[0].question]: text });
      return;
    }
    onSend(text, images);
  };

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
      style={{
        position: "absolute",
        ...(placement === "center"
          ? { top: 12, bottom: 12, left: "50%", transform: "translateX(-50%)", width: CHAT_CENTER_WIDTH, maxWidth: "calc(100% - 48px)", border: "1px solid var(--loki-border)", borderRadius: 12 }
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
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          padding: "2px 8px 2px 12px",
          minHeight: 28,
          borderBottom: "1px solid var(--loki-border)",
          position: "relative",
          zIndex: 2,
        }}
      >
        {/* The model chip on the left (the desk's name is in the title bar), the two controls on the right. */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, position: "relative" }}>
          {onPickModel && (
            <ModelChip
              model={model}
              busy={switching}
              onClick={() => {
                onLoadModels?.();
                setPickerOpen((v) => !v);
              }}
            />
          )}
          {onPickMode && <ModeChip mode={isPermissionMode(mode) ? mode : null} busy={changingMode} onClick={() => setModeOpen((v) => !v)} />}
          <span className="loki-label" style={{ fontSize: 9.5, color: "var(--loki-muted)", opacity: 0.7 }}>{status === "thinking" ? "thinking…" : status === "streaming" ? "replying…" : ""}</span>
        </span>
        <ModeMenu open={modeOpen} current={isPermissionMode(mode) ? mode : null} onPick={(m) => void pickMode(m)} onClose={() => setModeOpen(false)} />
        <ModelPicker open={pickerOpen} current={model} entries={models} loading={!models} onPick={(h) => void pickModel(h)} onClose={() => setPickerOpen(false)} />
        <span style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {onToggleWidth && placement !== "center" && (
            <button
              onClick={onToggleWidth}
              aria-label={width === "wide" ? "narrow chat" : "wide chat"}
              title={width === "wide" ? "narrow (⌘⇧/)" : "wide (⌘⇧/)"}
              style={{ border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 6 }}
            >
              {width === "wide" ? (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6.5 2.5v11" /></svg>
              ) : (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10.5 2.5v11" /></svg>
              )}
            </button>
          )}
        <button
          onClick={onClose}
          aria-label="close chat"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--loki-muted)",
            cursor: "pointer",
            fontSize: 13.5,
          }}
        >
          ×
        </button>
        </span>
      </div>

      {findOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--loki-border)", background: "var(--loki-panel-header)" }}>
          <input
            ref={findRef}
            type="search"
            name="find-in-transcript"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findNext(e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setFindOpen(false);
                inputRef.current?.focus();
              }
            }}
            placeholder="find in transcript… (↵ next · ⇧↵ previous · esc)"
            aria-label="find in transcript"
            style={{ flex: 1, padding: "5px 8px", fontSize: 12, background: "var(--loki-bg)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" }}
          />
          <button onClick={() => findNext(true)} aria-label="previous match" style={{ border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer" }}>↑</button>
          <button onClick={() => findNext(false)} aria-label="next match" style={{ border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer" }}>↓</button>
          <button onClick={() => setFindOpen(false)} aria-label="close find" style={{ border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer" }}>×</button>
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 16px", position: "relative", fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)" }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: 8 }}>
            same conversation, different room — everything here lands in {agentName ? `${agentName}'s` : "the"} transcript
          </div>
        )}
        <Transcript rows={messages} streaming={status === "streaming"} />
        {status === "thinking" && !approval && !question && (
          <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: "6px 8px" }}>
            thinking…
          </div>
        )}
        {error && (
          <div style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", fontSize: 12, padding: "6px 8px" }}>{error}</div>
        )}
      </div>
      {question && onAnswer && <QuestionCard question={question} onAnswer={onAnswer} />}
      {approval && (
        <ApprovalCard
          approval={approval}
          actions={
            onApprove && (
              <>
                <button onClick={() => onApprove("allow")} style={btn("var(--loki-positive)")}>approve</button>
                <button onClick={() => onApprove("deny")} style={btn("var(--loki-negative)")}>deny</button>
              </>
            )
          }
        />
      )}
      {unpinned && (
        <button
          onClick={jumpToLatest}
          aria-label="jump to latest"
          style={{ position: "absolute", bottom: 84, left: "50%", transform: "translateX(-50%)", padding: "4px 10px", borderRadius: 999, border: "1px solid var(--loki-border)", background: "var(--loki-panel)", color: "var(--loki-muted)", fontSize: 10.5, fontFamily: "var(--loki-mono)", cursor: "pointer", boxShadow: "var(--loki-shadow-low)" }}
        >
          ↓ latest
        </button>
      )}

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loki-border)", alignItems: "flex-end" }}>
        <ChatInput
          ref={inputRef}
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onEscape={() => inputRef.current?.blur()}
          images={images}
          onImages={setImages}
          placeholder={question ? (question.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…") : status === "idle" ? `message ${agentName ?? "the agent"}… (shift+enter for a new line)` : "waiting…"}
        />
        <button
          onClick={submit}
          disabled={status !== "idle" || (!draft.trim() && !images.length)}
          style={{ ...btn(status === "idle" && (draft.trim() || images.length) ? "var(--loki-accent)" : "var(--loki-muted)"), cursor: status === "idle" ? "pointer" : "default", opacity: status === "idle" && (draft.trim() || images.length) ? 1 : 0.6 }}
        >
          send
        </button>
      </div>
    </div>
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
        zIndex: LAYER.panel + 1,
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
