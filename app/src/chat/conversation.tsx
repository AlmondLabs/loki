import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import "./chat.css";
import type { PendingApproval, PendingQuestion } from "../../../core/attention/model.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { Button, Chip, Title } from "../components";
import { AgentChip, AgentFace } from "../desk/agent-chip";
import { avatarUrl } from "../desk/env";
import { keyFor } from "../shell/keymap";
import { ApprovalCard } from "./approval-card";
import { QuestionCard } from "./question-card";
import { SuggestionStack, type SuggestionsProps } from "./suggestion-card";
import { ChatInput } from "./chat-input";
import { FindBar } from "./find-bar";
import { SlashPalette } from "./slash-palette";
import { Transcript, useArrivedFrom, type MessageLayout, type TranscriptRow } from "./transcript";
import type { WholeRow } from "../../../core/attention/transcript.ts";
import { ModelPicker, ModelPill, effortEntriesFor, modelName, type ModelEntry } from "./model-picker";
import { ModeSwitch } from "./permission-mode";
import { engineControls } from "./engine-controls";
import type { ChatEngineView } from "../../../core/models.ts";
import { useChatTicks } from "./use-chat-ticks";
import { useDraft, type ControlledDraft } from "./use-draft";
import { useModelAndMode } from "./use-model-and-mode";
import { useSlashPalette } from "./use-slash-palette";
import { useTranscriptScroll } from "./use-transcript-scroll";
import { StepsLoad, StepsTouch } from "./tool-steps";
import { readTurnError, retryMessage } from "./turn-error";

/** What the agent is doing in a chat: nothing, thinking before its reply, or streaming the reply. */
export type ChatStatus = "idle" | "thinking" | "streaming";

/** What a conversation looks like right now. `rows` is undefined until the transcript has loaded. */
export interface ConversationView {
  rows: TranscriptRow[] | undefined;
  status: ChatStatus;
  error?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: string | null;
  /** The ACP agent the chat runs on (plan 020): its models, modes and commands replace loki's; absent on loki's engine. */
  engine?: ChatEngineView | null;
  approval?: PendingApproval | null;
  question?: PendingQuestion | null;
  /** Load the page of history older than `rows` (the reader reached the top); null or absent when there is none. */
  older?: (() => void) | null;
  /** The thread's first page did not come (plan 041): try again. Null or absent while it loads, or once it came. */
  loadFailed?: (() => void) | null;
  /** Fetch what a history page left out of a lean row: a tool row's step (plan 041), an event's detail (plan 043). */
  loadStep?: (row: number) => Promise<WholeRow | null>;
  /** The name of the Mac the chat lives on, when it is another one: the thread says it is loading from there. */
  home?: string | null;
}

/** What can be done to it. A missing handler hides its control: no picker without onPickModel, no approve without onApprove. */
export interface ConversationActions {
  onSend: (text: string, images?: Attachment[]) => void;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onApprove?: (behavior: "allow" | "deny" | "always") => void;
  /** Slash commands the box offers (see core/attention/commands.ts) and their runner. */
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
  onPickModel?: (selection: ModelSelection) => Promise<void>;
  onPickMode?: (mode: string) => Promise<void>;
  onLoadModels?: () => void;
  /** Take back a message typed mid-turn before it went out. */
  onCancelQueued?: (text: string) => void;
  /** Stop the agent's turn where it is, so the person can take over (the harness's abort_message); resolves to an error or null. */
  onStop?: () => Promise<string | null>;
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
 * there), the suggestions its agent made for other chats, the agent's open question or the tool it is paused on, the message box (its bottom row holds "+",
 * the model pill that opens Select model, the permission mode beside it, the mic and send), and a last row with
 * approve / deny when something waits, then whatever actions the host adds on the right. The host owns
 * the frame around it and renders this inside a flex column.
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
  composer = true,
  suggestions = null,
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
  /** Touch-sized controls (the phone); Select model opens as a bottom sheet instead of a popover. */
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
  /** A line between the thread and the box: "atlas is waiting for your reply", the link state. */
  notice?: ReactNode;
  /** The empty box's words, in place of composerPlaceholder's. */
  placeholder?: string;
  /**
   * False keeps only the header, find and the thread: a view that is hidden but must keep its scroll (the
   * desk's Messages tab while the Desk tab shows), so the box, its switchers and the open question or
   * approval are drawn once, by the view on screen.
   */
  composer?: boolean;
  /**
   * The suggestions made in this chat for other chats (plan 049), drawn above the open question or approval and only
   * by the view that draws the box, as they are; null or absent, none.
   */
  suggestions?: SuggestionsProps | null;
}) {
  // The box reads these fields, never `view` itself: `view` is new with every streamed piece (its rows), and the box
  // would be drawn again with each one (plan 032).
  const status = view.status;
  const approval = view.approval ?? null;
  const question = view.question ?? null;
  const model = view.model ?? null;
  const reasoningEffort = view.reasoningEffort ?? null;
  const { mode: currentMode, modes, started, commands } = engineControls(view, actions.commands);
  const g = { ...NO_GUTTER, ...gutter };

  const ownRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = inputRefProp ?? ownRef;
  const threadRef = useRef<ThreadHandle>(null);
  const { draft, setDraft, images, setImages, submit } = useDraft({
    question,
    onAnswer: actions.onAnswer,
    onSend: actions.onSend,
    commands,
    onCommand: actions.onCommand,
    onSent,
    controlled: controlledDraft,
  });
  const { findOpen, setFindOpen, findRef } = useChatTicks({ focusTick, findTick, inputRef });
  const prefillTick = prefill?.tick ?? 0;
  const takePrefill = useEffectEvent(() => {
    if (prefill) setDraft(prefill.text);
  });
  useEffect(() => {
    if (prefillTick <= 0) return;
    takePrefill();
    const t = setTimeout(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => clearTimeout(t);
  }, [prefillTick, inputRef]);
  const controls = useModelAndMode({
    onLoadModels: actions.onLoadModels,
    onPickModel: actions.onPickModel,
    onPickMode: actions.onPickMode,
    modelPickerTick,
    modeMenuTick,
  });
  const palette = useSlashPalette({ draft, onDraft: setDraft, commands: commands ?? [], onCommand: actions.onCommand, inputRef });

  const pillRef = useRef<HTMLButtonElement>(null);
  const hasModelPicker = !!actions.onPickModel;
  // The effort shows in the pill only when the model offers a choice of levels.
  const effort = effortEntriesFor(models ?? [], model).length > 1 ? reasoningEffort : null;
  // An agent that has not run yet has not said what its modes are; the chip waits for them.
  const hasModeMenu = !!actions.onPickMode && (!modes || modes.length > 0);
  const onApprove = approval ? actions.onApprove : undefined;
  const canApprove = !!onApprove;
  const hasFooter = canApprove || !!footer;
  const hasContent = !!draft.trim() || images.length > 0;
  // Stop, asked for and not yet ended: the button waits until the harness says the turn is over.
  const running = status !== "idle";
  const [stopping, setStopping] = useState(false);
  if (stopping && !running) setStopping(false);
  const onStop = actions.onStop;
  const stop = onStop
    ? () => {
        setStopping(true);
        // Refused (the link down, the harness said no): the button comes back so it can be tried again.
        void onStop().then((err) => err && setStopping(false));
      }
    : undefined;
  const waiting = !!approval || !!question;
  const picker = hasModelPicker && (
    <ModelPicker
      open={controls.pickerOpen}
      touch={touch}
      current={model}
      currentEffort={reasoningEffort}
      entries={models}
      started={started}
      loading={!models}
      onPick={(selection) => void controls.pickModel(selection)}
      onClose={controls.closePicker}
      pillRef={pillRef}
    />
  );

  return (
    <>
      {header}
      {findOpen && (
        <FindBar
          fieldRef={findRef}
          onFind={(query) => threadRef.current?.reveal(query)}
          onFound={() => threadRef.current?.unpin()}
          onEscape={() => {
            setFindOpen(false);
            inputRef.current?.focus();
          }}
          onClose={() => setFindOpen(false)}
        />
      )}
      {/* On the phone a run of tools opens as a bottom sheet; on the desktop it unfolds in place (tool-steps.tsx). */}
      <StepsTouch.Provider value={touch}>
        <Thread
          ref={threadRef}
          rows={view.rows}
          status={status}
          error={view.error ?? null}
          agentName={agentName}
          waiting={waiting}
          dim={dim}
          onCancelQueued={actions.onCancelQueued}
          onRetry={(text) => actions.onSend(text)}
          older={view.older ?? null}
          loadFailed={view.loadFailed ?? null}
          loadStep={view.loadStep}
          home={view.home ?? null}
          layout={layout}
          style={{ padding: `16px calc(20px + ${g.right}) 16px calc(20px + ${g.left})` }}
        />
      </StepsTouch.Provider>

      {composer && (
        <>
          {suggestions && <SuggestionStack {...suggestions} touch={touch} />}
          {question && actions.onAnswer && <QuestionCard question={question} onAnswer={actions.onAnswer} touch={touch} />}
          {approval && <ApprovalCard approval={approval} />}
          {notice}

          {/* The message box; a draft that starts with "/" opens the command palette above. */}
          <div
            className="loki-composer"
            style={{ padding: `8px calc(12px + ${g.right}) ${hasFooter ? "8px" : `calc(12px + ${g.bottom})`} calc(12px + ${g.left})` }}
          >
            {palette.open && (
              <SlashPalette matches={palette.matches} index={palette.index} listId={palette.listId} onHover={palette.setIndex} onPick={palette.pick} />
            )}
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
              placeholder={placeholder ?? composerPlaceholder({ status, approval, question }, agentName)}
              touch={touch}
              tools={
                (hasModelPicker || hasModeMenu) && (
                  <>
                    {hasModelPicker && (
                      <ModelPill
                        ref={pillRef}
                        name={modelName(models, model)}
                        effort={effort}
                        busy={controls.switching}
                        open={controls.pickerOpen}
                        onClick={controls.togglePicker}
                      />
                    )}
                    {/* The desktop's popover hangs above the box; the phone's sheet is drawn outside it (below), over the whole screen. */}
                    {!touch && picker}
                    {/* The permission mode beside the model: both say how this conversation's agent works. */}
                    {hasModeMenu && <ModeSwitch mode={currentMode} modes={modes} controls={controls} />}
                  </>
                )
              }
              canSend={hasContent}
              onStop={running ? stop : undefined}
              stopping={stopping}
              sendLabel={status === "idle" ? "Send" : "Queue: sends when this turn ends"}
              sendTitle={status === "idle" ? undefined : "the agent is mid-turn; this is kept and sent when the turn ends"}
              {...palette.aria}
            />
          </div>
          {touch && picker}

          {hasFooter && (
            <div className="loki-conversation-footer" style={{ padding: `0 calc(12px + ${g.right}) calc(12px + ${g.bottom}) calc(12px + ${g.left})` }}>
              {onApprove &&
                (() => {
                  const approve = (
                    <Button
                      key="approve"
                      size={touch ? "touch" : "sm"}
                      tone="positive"
                      className="loki-approve"
                      onClick={() => onApprove("allow")}
                      kbd={hints?.approve}
                    >
                      approve
                    </Button>
                  );
                  const deny = (
                    <Button key="deny" size={touch ? "touch" : "sm"} tone="negative" className="loki-deny" onClick={() => onApprove("deny")} kbd={hints?.deny}>
                      deny
                    </Button>
                  );
                  // Allows this call and every later one of the same tool, in any chat, until taken back in Settings › Chat (not in strict mode).
                  const always = (
                    <Button
                      key="always"
                      size={touch ? "touch" : "sm"}
                      tone="paper"
                      className="loki-approve-always"
                      onClick={() => onApprove("always")}
                      title="allow this tool from now on, in every chat (Preferences › Chat takes it back)"
                    >
                      always allow
                    </Button>
                  );
                  // On touch deny comes first, in reading order as on screen (the phone's two wide buttons); the desk keeps approve first.
                  return touch ? [deny, always, approve] : [approve, always, deny];
                })()}
              {footer}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** What the empty box says: answer the open question, decide the approval, or message the agent — with a note when it will queue. */
export function composerPlaceholder(view: Pick<ConversationView, "status" | "approval" | "question">, agentName: string | null | undefined): string {
  if (view.question) return view.question.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…";
  if (view.approval) return "reply, or approve / deny below…";
  const who = agentName ?? "the agent";
  return view.status === "idle"
    ? `message ${who}… (${keyFor("chat.send")} send · ${keyFor("chat.newline")} new line)`
    : `message ${who}… it goes when this turn ends`;
}

/**
 * The title, the chat's purpose line under it when it has one, then the agent's face and name with whatever else the
 * host says about the conversation; `right` sits at the end of the row.
 */
export function ConversationHeader({
  title,
  purpose,
  agentName,
  agentId,
  children,
  right,
}: {
  title: ReactNode;
  /** The person's one line on what the chat is for (plan 049, R11). */
  purpose?: string | null;
  agentName: string | null | undefined;
  agentId: string | null | undefined;
  children?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        borderBottom: "1px solid var(--loki-border)",
        flex: "0 0 auto",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Title style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</Title>
        {purpose && (
          <div className="loki-chat-purpose" title={purpose}>
            {purpose}
          </div>
        )}
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

/** What a conversation can ask of its thread, for find in page. */
export interface ThreadHandle {
  /** Stop following the bottom (find moved the selection into view; the next delta must not pull it away). */
  unpin: () => void;
  /** Mount the rows above the window that hold `query`, before find searches the page. */
  reveal: (query: string) => void;
}

/** A failed turn: one readable sentence, the harness's own words behind a disclosure, and a way to try again. */
function ThreadError({ error, rows, onRetry }: { error: string; rows: TranscriptRow[]; onRetry?: (text: string) => void }) {
  const e = readTurnError(error);
  const retry = onRetry ? retryMessage(rows) : null;
  return (
    <div className="loki-thread-error" role="alert">
      <span>{e.text}</span>
      {retry && (
        <Button size="sm" onClick={() => onRetry?.(retry.text)}>
          {retry.label}
        </Button>
      )}
      {e.raw && (
        <details className="loki-thread-error-raw">
          <summary>details</summary>
          <pre>{e.raw}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * What scrolls: a note while the thread loads or when it is empty, the rows, then the thinking marker or
 * the error. Follows the bottom only while the reader is there; scrolled up, a "↓ latest" chip offers the
 * way back. The phone's inbox draws this alone inside a swipe card.
 */
export const Thread = forwardRef<
  ThreadHandle,
  {
    rows: TranscriptRow[] | undefined;
    status?: ChatStatus;
    error?: string | null;
    agentName?: string | null;
    waiting?: boolean;
    dim?: boolean;
    onCancelQueued?: (text: string) => void;
    onRetry?: (text: string) => void;
    older?: (() => void) | null;
    loadFailed?: (() => void) | null;
    loadStep?: (row: number) => Promise<WholeRow | null>;
    home?: string | null;
    layout?: MessageLayout;
    style?: CSSProperties;
  }
>(function Thread(
  {
    rows,
    status = "idle",
    error = null,
    agentName,
    waiting = false,
    dim = true,
    onCancelQueued,
    onRetry,
    older = null,
    loadFailed = null,
    loadStep,
    home = null,
    layout,
    style,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = rows ?? EMPTY;
  const arrivedFrom = useArrivedFrom(rows);
  // A long thread mounts its newest rows and reveals older ones as you scroll up (transcript-window.ts).
  const { unpinned, fresh, onScroll, jumpToLatest, unpin, start, above, reveal } = useTranscriptScroll(
    scrollRef,
    list,
    status,
    layout?.dividerAt ?? null,
    layout?.widgets,
    older,
  );
  useImperativeHandle(ref, () => ({ unpin, reveal }), [unpin, reveal]);
  // One stable "take back" handler for the transcript. The host hands a fresh closure on every render; passing
  // that straight down broke the rows' memo and re-parsed a long thread's markdown on every keystroke.
  const cancelQueuedRef = useRef(onCancelQueued);
  useEffect(() => {
    cancelQueuedRef.current = onCancelQueued;
  }, [onCancelQueued]);
  const cancelQueued = useCallback((row: TranscriptRow) => cancelQueuedRef.current?.(row.text), []);
  // The step loader the same way: a fresh one each render would redraw every run of steps through the context.
  const loadStepRef = useRef(loadStep);
  useEffect(() => {
    loadStepRef.current = loadStep;
  }, [loadStep]);
  const stableLoadStep = useCallback((row: number) => loadStepRef.current?.(row) ?? Promise.resolve(null), []);
  const who = agentName ?? "the agent";
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-thread-scroll
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
          // The thread keeps the row being read in place itself (use-transcript-scroll.ts); the browser's own would move it twice.
          overflowAnchor: "none",
          padding: "16px 20px",
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--loki-fg)",
          ...style,
        }}
      >
        {!rows && !loadFailed && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>{home ? `loading from ${home}…` : "loading the thread…"}</div>}
        {!rows && loadFailed && (
          <div className="loki-thread-error" role="alert">
            <span>{home ? `could not load this chat from ${home}` : "could not load this chat"}</span>
            <Button size="sm" onClick={loadFailed}>
              try again
            </Button>
          </div>
        )}
        {rows?.length === 0 && (
          <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>nothing here yet — everything you send lands in {who}'s transcript</div>
        )}
        {rows && (
          <StepsLoad.Provider value={stableLoadStep}>
            <Transcript
              rows={rows}
              streaming={status === "streaming"}
              dim={dim}
              onCancelQueued={onCancelQueued ? cancelQueued : undefined}
              people={layout?.people}
              dividerAt={layout?.dividerAt}
              dividerDay={layout?.dividerDay}
              widgets={layout?.widgets}
              onFrameWidget={layout?.onFrameWidget}
              onShowDesk={layout?.onShowDesk}
              inline={layout?.inline}
              from={start}
              above={above}
              arrivedFrom={arrivedFrom}
              busy={status !== "idle"}
            />
          </StepsLoad.Provider>
        )}
        {status === "thinking" && !waiting && (
          <div className="loki-thinking" role="status">
            thinking
            {/* Three dots that rise in turn, as a typing bubble does (chat.css); read as "thinking". */}
            <span className="loki-thinking-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        {error && <ThreadError error={error} rows={rows ?? []} onRetry={status === "idle" ? onRetry : undefined} />}
      </div>
      {unpinned && (
        <Chip
          float
          onClick={jumpToLatest}
          aria-label={fresh > 0 ? `jump to ${fresh} new ${fresh === 1 ? "message" : "messages"}` : "jump to latest"}
          className="loki-latest-chip"
          style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}
        >
          {/* Keyed by the count: a new message makes a new label, which pops (chat.css). */}
          <span key={fresh}>{fresh > 0 ? `↓ ${fresh} new` : "↓ latest"}</span>
        </Chip>
      )}
    </div>
  );
});
