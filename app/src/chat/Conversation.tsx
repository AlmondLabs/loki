import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import "./chat.css";
import type { PendingApproval, PendingQuestion } from "../../../core/attention/model.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import { selectionOf, type ModelSelection, type ReasoningEffort } from "../../../core/models.ts";
import { Button, Chip, Title } from "../components";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ChatInput } from "./ChatInput";
import { FindBar } from "./FindBar";
import { SlashPalette } from "./SlashPalette";
import { Transcript, type MessageLayout, type TranscriptRow } from "./Transcript";
import { EffortChip, EffortMenu, ModelChip, ModelPicker, effortEntriesFor, type ModelEntry } from "./ModelPicker";
import { ModeChip, ModeMenu, isPermissionMode, type PermissionMode } from "./PermissionMode";
import { useChatTicks } from "./useChatTicks";
import { useDraft, type ControlledDraft } from "./useDraft";
import { useModelAndMode } from "./useModelAndMode";
import { useSlashPalette } from "./useSlashPalette";
import { useTranscriptScroll } from "./useTranscriptScroll";

export type ChatStatus = "idle" | "thinking" | "streaming";

/** What a conversation looks like right now. `rows` is undefined until the transcript has loaded. */
export interface ConversationView {
  rows: TranscriptRow[] | undefined;
  status: ChatStatus;
  error?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: string | null;
  approval?: PendingApproval | null;
  question?: PendingQuestion | null;
}

/** What can be done to it. A missing handler hides its control: no picker without onPickModel, no approve without onApprove. */
export interface ConversationActions {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onApprove?: (behavior: "allow" | "deny") => void;
  /** Slash commands the box offers (see core/attention/commands.ts) and their runner. */
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
  onPickModel?: (selection: ModelSelection) => Promise<void>;
  onPickMode?: (mode: PermissionMode) => Promise<void>;
  onLoadModels?: () => void;
  /** Take back a message typed mid-turn before it went out. */
  onCancelQueued?: (text: string) => void;
}

/** Safe-area insets a host adds inside the thread and under the last row (the phone's notch and home indicator). */
export interface Gutter {
  left?: string;
  right?: string;
  bottom?: string;
}

const EMPTY: TranscriptRow[] = [];
const NO_GUTTER: Required<Gutter> = { left: "0px", right: "0px", bottom: "0px" };

/**
 * One conversation, the same in every room: the desk's chat panel, an inbox card, the phone's thread.
 * Top to bottom — the host's header, find, the thread (newest at the bottom, followed only while you are
 * there), the agent's open question or the tool it is paused on, the message box with send beside it, and
 * a last row with the conversation's switchers (model, effort, permission mode) on the left, approve / deny
 * when something waits, then whatever actions the host adds on the right. The host owns the frame around it
 * and renders this inside a flex column.
 */
export function Conversation({
  view,
  actions,
  models = null,
  agentName,
  header,
  footer,
  hints,
  inputRef: inputRefProp,
  prefill = null,
  focusTick = 0,
  findTick = 0,
  modelPickerTick = 0,
  modeMenuTick = 0,
  touch = false,
  gutter,
  dim = true,
  onTyping,
  onEscapeEmpty,
  onSent,
  draft: controlledDraft,
  layout,
  notice,
  placeholder,
  attach = false,
  icons,
}: {
  view: ConversationView;
  actions: ConversationActions;
  /** list_models, for the picker and to know which efforts the current model offers. */
  models?: ModelEntry[] | null;
  agentName?: string | null;
  /** Above the thread: a ConversationHeader, or the host's own. */
  header?: ReactNode;
  /** The right side of the last row, after the switchers and approve / deny. */
  footer?: ReactNode;
  /** Key legends on approve / deny (the inbox's A / D, ⌘↵ / ⌘⇧D while typing). */
  hints?: { approve?: string; deny?: string };
  /** The message box, when the host needs to focus it (the inbox's R). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Text the host wants in the box (an "ask the agent to…" from another view); a new tick replaces the draft. */
  prefill?: { text: string; tick: number } | null;
  /** Bumped by the host to put the caret in the message box, open find, the model picker, the mode menu. */
  focusTick?: number;
  findTick?: number;
  modelPickerTick?: number;
  modeMenuTick?: number;
  /** Touch-sized controls (the phone). */
  touch?: boolean;
  gutter?: Gutter;
  /** Older rows step back a little; the phone reads them all at full weight. */
  dim?: boolean;
  /** The box gained or lost focus — the inbox switches its key grammar on this. */
  onTyping?: (typing: boolean) => void;
  /** Esc in an empty box, after it has blurred (the inbox closes the deck; a draft is kept and only blurs). */
  onEscapeEmpty?: () => void;
  /** A message or an answer went out from the box. */
  onSent?: () => void;
  /** The host keeps the draft (the phone's per-conversation store); omitted, the box keeps its own, as on the desktop. */
  draft?: ControlledDraft;
  /** The avatar-led message layout and the unread divider (Transcript's MessageLayout); omitted, bubbles. */
  layout?: MessageLayout;
  /** A line between the thread and the box: "friday is waiting for your reply", the link state. */
  notice?: ReactNode;
  /** The empty box's words, in place of composerPlaceholder's. */
  placeholder?: string;
  /** A button in the box that picks images from the device (the phone has no drag and drop). */
  attach?: boolean;
  /** The host's glyphs (the phone's icon set): with `send`, the send button is that icon, named for screen readers, instead of the word. */
  icons?: { send?: ReactNode; attach?: ReactNode; mic?: ReactNode };
}) {
  const approval = view.approval ?? null;
  const question = view.question ?? null;
  const model = view.model ?? null;
  const reasoningEffort = view.reasoningEffort ?? null;
  const currentMode = isPermissionMode(view.mode) ? view.mode : null;
  const g = { ...NO_GUTTER, ...gutter };
  const size = touch ? "touch" : "md";

  const ownRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = inputRefProp ?? ownRef;
  const threadRef = useRef<ThreadHandle>(null);
  const { draft, setDraft, images, setImages, submit } = useDraft({ question, onAnswer: actions.onAnswer, onSend: actions.onSend, commands: actions.commands, onCommand: actions.onCommand, onSent, controlled: controlledDraft });
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
  const controls = useModelAndMode({ onLoadModels: actions.onLoadModels, onPickModel: actions.onPickModel, onPickMode: actions.onPickMode, modelPickerTick, modeMenuTick });
  const palette = useSlashPalette({ draft, onDraft: setDraft, commands: actions.commands ?? [], onCommand: actions.onCommand, inputRef });

  const effortEntries = effortEntriesFor(models ?? [], model);
  const hasModelPicker = !!actions.onPickModel;
  const hasEffortPicker = hasModelPicker && effortEntries.length > 1;
  const hasModeMenu = !!actions.onPickMode;
  const canApprove = !!approval && !!actions.onApprove;
  const hasFooter = hasModelPicker || hasModeMenu || canApprove || !!footer;
  const hasContent = !!draft.trim() || images.length > 0;
  const waiting = !!approval || !!question;

  return (
    <>
      {header}
      {findOpen && (
        <FindBar
          fieldRef={findRef}
          onFound={() => threadRef.current?.unpin()}
          onEscape={() => {
            setFindOpen(false);
            inputRef.current?.focus();
          }}
          onClose={() => setFindOpen(false)}
        />
      )}
      <Thread ref={threadRef} rows={view.rows} status={view.status} error={view.error ?? null} agentName={agentName} waiting={waiting} dim={dim} onCancelQueued={actions.onCancelQueued} layout={layout} style={{ padding: `16px calc(20px + ${g.right}) 16px calc(20px + ${g.left})` }} />

      {question && actions.onAnswer && <QuestionCard question={question} onAnswer={actions.onAnswer} touch={touch} />}
      {approval && <ApprovalCard approval={approval} />}
      {notice}

      {/* The message box with send beside it; a draft that starts with "/" opens the command palette above. */}
      <div className="loki-composer" style={{ position: "relative", display: "flex", gap: 8, padding: `12px calc(12px + ${g.right}) ${hasFooter ? "8px" : `calc(10px + ${g.bottom})`} calc(12px + ${g.left})`, borderTop: "1px solid var(--loki-border)", alignItems: "flex-end" }}>
        {palette.open && <SlashPalette matches={palette.matches} index={palette.index} listId={palette.listId} onHover={palette.setIndex} onPick={palette.pick} />}
        <ChatInput
          ref={inputRef}
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onKeyDown={palette.onKeyDown}
          onEscape={() => {
            inputRef.current?.blur();
            if (!draft.trim()) onEscapeEmpty?.();
          }}
          onFocus={() => onTyping?.(true)}
          onBlur={() => onTyping?.(false)}
          images={images}
          onImages={setImages}
          placeholder={placeholder ?? composerPlaceholder(view, agentName)}
          attach={attach}
          icons={icons}
          {...palette.aria}
        />
        {icons?.send ? (
          <Button size={size} tone={hasContent ? "brass" : "quiet"} onClick={submit} disabled={!hasContent} className="loki-composer-send" aria-label={view.status === "idle" ? "Send" : "Queue: sends when this turn ends"} data-queue={view.status === "idle" ? undefined : "true"}>
            {icons.send}
          </Button>
        ) : (
          <Button size={size} tone={hasContent ? "brass" : "quiet"} onClick={submit} disabled={!hasContent} title={view.status === "idle" ? undefined : "the agent is mid-turn; this is kept and sent when the turn ends"}>
            {view.status === "idle" ? "send" : "queue"}
          </Button>
        )}
      </div>

      {hasFooter && (
        <div className="loki-conversation-footer" style={{ position: "relative", display: "flex", gap: 8, padding: `0 calc(12px + ${g.right}) calc(12px + ${g.bottom}) calc(12px + ${g.left})`, alignItems: "center", flexWrap: "wrap" }}>
          {hasModelPicker && <ModelChip model={model} busy={controls.switching} onClick={controls.togglePicker} />}
          {hasModelPicker && <ModelPicker open={controls.pickerOpen} side="above" current={model} currentEffort={reasoningEffort} entries={models} loading={!models} onPick={(selection) => void controls.pickModel(selection)} onClose={controls.closePicker} />}
          {hasEffortPicker && (
            <>
              <EffortChip effort={reasoningEffort} busy={controls.changingEffort} onClick={controls.toggleEffort} />
              <EffortMenu open={controls.effortOpen} side="above" entries={effortEntries} current={reasoningEffort} onPick={(entry) => void controls.pickEffort(selectionOf(entry))} onClose={controls.closeEffort} />
            </>
          )}
          {hasModeMenu && <ModeChip mode={currentMode} busy={controls.changingMode} onClick={controls.toggleMode} />}
          {hasModeMenu && <ModeMenu open={controls.modeOpen} side="above" current={currentMode} onPick={(m) => void controls.pickMode(m)} onClose={controls.closeMode} />}
          {canApprove &&
            (() => {
              const approve = <Button key="approve" size={touch ? "touch" : "sm"} tone="positive" className="loki-approve" onClick={() => actions.onApprove!("allow")} kbd={hints?.approve}>approve</Button>;
              const deny = <Button key="deny" size={touch ? "touch" : "sm"} tone="negative" className="loki-deny" onClick={() => actions.onApprove!("deny")} kbd={hints?.deny}>deny</Button>;
              // On touch deny comes first, in reading order as on screen (the phone's two wide buttons); the desk keeps approve first.
              return touch ? [deny, approve] : [approve, deny];
            })()}
          {footer}
        </div>
      )}
    </>
  );
}

/** What the empty box says: answer the open question, decide the approval, or message the agent — with a note when it will queue. */
export function composerPlaceholder(view: Pick<ConversationView, "status" | "approval" | "question">, agentName: string | null | undefined): string {
  if (view.question) return view.question.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…";
  if (view.approval) return "reply, or approve / deny below…";
  const who = agentName ?? "the agent";
  return view.status === "idle" ? `message ${who}… (↵ send · ⇧↵ new line)` : `message ${who}… it goes when this turn ends`;
}

/** The title, then the agent's face and name with whatever else the host says about the conversation; `right` sits at the end of the row. */
export function ConversationHeader({ title, agentName, agentId, children, right }: { title: ReactNode; agentName: string | null | undefined; agentId: string | null | undefined; children?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--loki-border)", flex: "0 0 auto" }}>
      <div style={{ minWidth: 0 }}>
        <Title style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</Title>
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <AgentFace name={agentName} src={agentId ? avatarUrl(agentId) : null} size={18} />
          <AgentChip name={agentName} />
          {children}
        </div>
      </div>
      {right}
    </div>
  );
}

export interface ThreadHandle {
  /** Stop following the bottom (find moved the selection into view; the next delta must not pull it away). */
  unpin: () => void;
}

/**
 * What scrolls: a note while the thread loads or when it is empty, the rows, then the thinking marker or
 * the error. Follows the bottom only while the reader is there; scrolled up, a "↓ latest" chip offers the
 * way back. The phone's inbox draws this alone inside a swipe card.
 */
export const Thread = forwardRef<ThreadHandle, { rows: TranscriptRow[] | undefined; status?: ChatStatus; error?: string | null; agentName?: string | null; waiting?: boolean; dim?: boolean; onCancelQueued?: (text: string) => void; layout?: MessageLayout; style?: CSSProperties }>(function Thread({ rows, status = "idle", error = null, agentName, waiting = false, dim = true, onCancelQueued, layout, style }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = rows ?? EMPTY;
  const { unpinned, onScroll, jumpToLatest, unpin } = useTranscriptScroll(scrollRef, list, status);
  useImperativeHandle(ref, () => ({ unpin }), [unpin]);
  // One stable "take back" handler for the transcript. The host hands a fresh closure on every render; passing
  // that straight down broke the rows' memo and re-parsed a long thread's markdown on every keystroke.
  const cancelQueuedRef = useRef(onCancelQueued);
  useEffect(() => {
    cancelQueuedRef.current = onCancelQueued;
  }, [onCancelQueued]);
  const cancelQueued = useCallback((row: TranscriptRow) => cancelQueuedRef.current?.(row.text), []);
  const who = agentName ?? "the agent";
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={scrollRef} onScroll={onScroll} data-thread-scroll style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", padding: "16px 20px", fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)", ...style }}>
        {!rows && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>loading the thread…</div>}
        {rows && rows.length === 0 && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>nothing here yet — everything you send lands in {who}'s transcript</div>}
        {rows && <Transcript rows={rows} streaming={status === "streaming"} dim={dim} onCancelQueued={onCancelQueued ? cancelQueued : undefined} people={layout?.people} dividerAt={layout?.dividerAt} dividerDay={layout?.dividerDay} />}
        {status === "thinking" && !waiting && <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: "6px 0" }}>thinking…</div>}
        {error && <div className="loki-thread-error" style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", fontSize: 12, marginTop: 12, overflowWrap: "anywhere" }}>{error}</div>}
      </div>
      {unpinned && (
        <Chip float onClick={jumpToLatest} aria-label="jump to latest" style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}>
          ↓ latest
        </Chip>
      )}
    </div>
  );
});
