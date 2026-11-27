import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import "./chat.css";
import { useHeightVar } from "../shared/use-height-var";
import { useFold } from "../shared/use-fold";
import { offersAlways, type PendingApproval, type PendingQuestion } from "../../../core/attention/model.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { Button, Chip, Title, sentence } from "../components";
import { AgentChip, AgentFace } from "../workspace/agent-chip";
import { avatarUrl } from "../workspace/env";
import { ApprovalCard } from "./approval-card";
import { QuestionCard } from "./question-card";
import { LinkCard } from "./link-card";
import { linkAskOf, type LinkSeen } from "../../../core/chat-links.ts";
import type { SubagentView } from "../../../core/subagents.ts";
import { QuickReplies, lastReplies } from "./quick-replies";
import { SuggestionChip, type SuggestionsProps } from "./suggestion-card";
import { ReplyProposalCards, type ReplySource } from "../workspace/reply-proposal-card";
import { ChatInput } from "./chat-input";
import { FindBar } from "./find-bar";
import { SlashPalette } from "./slash-palette";
import { Transcript, useArrivedFrom, type MessageLayout, type TranscriptRow } from "./transcript";
import type { WholeRow } from "../../../core/attention/transcript.ts";
import { ModelPicker, ModelPill, effortEntriesFor, modelName, type ModelEntry } from "./model-picker";
import type { UsualChoice } from "./model-switcher";
import { openCommandCenter, useShareModels, type CommandScope } from "../shell/command-center";
import { MODES, ModeSwitch, selectedMode, titleCase } from "./permission-mode";
import { engineControls } from "./engine-controls";
import type { ChatEngineView } from "../../../core/models.ts";
import { useChatTicks } from "./use-chat-ticks";
import { useDraft, type ControlledDraft } from "./use-draft";
import { useModelAndMode } from "./use-model-and-mode";
import { useSlashPalette } from "./use-slash-palette";
import { useTranscriptScroll } from "./use-transcript-scroll";
import { StepsLoad, StepsTouch } from "./tool-steps";
import { ThreadError } from "./thread-error";
import { ThreadAnnouncer } from "./thread-announcer";
import { Composer } from "../item/composer";
import { ApprovalProposal, QuestionProposal, QuickReplyChips, ReplyProposals } from "../item/proposal";
import { Timeline } from "../item/timeline";

export type ChatStatus = "idle" | "thinking" | "streaming";

export interface ConversationView {
  rows: TranscriptRow[] | undefined;
  status: ChatStatus;
  error?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: string | null;
  engine?: ChatEngineView | null;
  approval?: PendingApproval | null;
  question?: PendingQuestion | null;
  older?: (() => void) | null;
  loadFailed?: (() => void) | null;
  loadStep?: (row: number) => Promise<WholeRow | null>;
  home?: string | null;
  links?: LinkSeen[];
  subagents?: SubagentView[];
  blank?: boolean;
}

export interface ConversationActions {
  onSend: (text: string, images?: Attachment[]) => void;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onApprove?: (behavior: "allow" | "deny" | "always") => void;
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
  onPickModel?: (selection: ModelSelection) => Promise<void>;
  onPickMode?: (mode: string) => Promise<void>;
  onLoadModels?: () => void;
  onCancelQueued?: (text: string) => void;
  onStop?: () => Promise<string | null>;
  onCloseLink?: (linkId: string) => Promise<string | null>;
  onKeepHere?: () => Promise<string | null>;
}

export interface Gutter {
  left?: string;
  right?: string;
  bottom?: string;
}

const EMPTY: TranscriptRow[] = [];
const NO_GUTTER: Required<Gutter> = { left: "0px", right: "0px", bottom: "0px" };

export function Conversation({
  view,
  actions,
  models = null,
  usualModels,
  agentName,
  header,
  hints,
  inputRef: inputRefProp,
  prefill = null,
  focusTick = 0,
  findTick = 0,
  modelPickerTick = 0,
  modeMenuTick = 0,
  suggestionsTick = 0,
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
  fold = false,
  describe,
}: {
  fold?: boolean;
  describe?: string;
  view: ConversationView;
  actions: ConversationActions;
  models?: ModelEntry[] | null;
  usualModels?: readonly UsualChoice[];
  agentName?: string | null;
  header?: ReactNode;
  hints?: { approve?: string; deny?: string };
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  prefill?: { text: string; tick: number } | null;
  focusTick?: number;
  findTick?: number;
  modelPickerTick?: number;
  modeMenuTick?: number;
  suggestionsTick?: number;
  touch?: boolean;
  gutter?: Gutter;
  dim?: boolean;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  onSent?: () => void;
  draft?: ControlledDraft;
  layout?: MessageLayout;
  notice?: ReactNode;
  placeholder?: string;
  composer?: boolean;
  suggestions?: (SuggestionsProps & { source: Partial<ReplySource> }) | null;
}) {
  const status = view.status;
  const proposals = !touch;
  const queuedRows = proposals ? (view.rows ?? EMPTY).filter((r) => r.queued) : EMPTY;
  const approval = view.approval ?? null;
  const question = view.question ?? null;
  const linkAsk = question ? linkAskOf(question.input) : null;
  const model = view.model ?? null;
  const reasoningEffort = view.reasoningEffort ?? null;
  const { mode: currentMode, modes, started, commands } = engineControls(view, actions.commands);
  const g = { ...NO_GUTTER, ...gutter };

  const ownRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = inputRefProp ?? ownRef;
  const folding = useFold(fold, suggestionsTick);
  const describedBy = useId();
  const threadRef = useRef<ThreadHandle>(null);
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);
  const dock = useCallback(() => dockEl, [dockEl]);
  useHeightVar(dock, "--loki-dock-height");
  const { draft, setDraft, images, setImages, submit } = useDraft({
    question,
    onAnswer: actions.onAnswer,
    onSend: actions.onSend,
    commands,
    onCommand: actions.onCommand,
    onSent: () => {
      folding.close();
      onSent?.();
    },
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
  const effort = effortEntriesFor(models ?? [], model).length > 1 ? reasoningEffort : null;
  const hasModeMenu = !!actions.onPickMode && (!modes || modes.length > 0);
  const onApprove = approval ? actions.onApprove : undefined;
  const canApprove = !!onApprove;
  const hasFooter = canApprove && !proposals;
  const hasContent = !!draft.trim() || images.length > 0;
  const running = status !== "idle";
  const [stopping, setStopping] = useState(false);
  if (stopping && !running) setStopping(false);
  const onStop = actions.onStop;
  const stop = onStop
    ? () => {
        setStopping(true);
        void onStop().then((err) => err && setStopping(false));
      }
    : undefined;
  const waiting = !!approval || !!question;
  const replies = status === "idle" && !waiting ? lastReplies(view.rows) : null;
  const sendReply = (text: string) => {
    actions.onSend(text);
    onSent?.();
  };
  const onBoxKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    return palette.onKeyDown(e);
  };
  const inCommand = !touch && hasModelPicker;
  const modesInCommand = !touch && hasModeMenu;
  const modeList = modes ?? MODES;
  useShareModels(
    inCommand || modesInCommand
      ? {
          entries: models,
          current: model,
          currentEffort: reasoningEffort,
          started,
          usual: usualModels ?? NO_USUAL,
          agentName: agentName ?? null,
          pick: (selection) => void controls.pickModel(selection),
          modes: modesInCommand
            ? {
                current: selectedMode(currentMode, modeList),
                list: modeList.map((m) => ({ id: m.id, label: titleCase(m.label), description: sentence(m.description) })),
                pick: (m) => void controls.pickMode(m),
              }
            : null,
        }
      : null,
  );
  const picker =
    hasModelPicker &&
    (inCommand ? (
      <OpenScope scope="models" open={controls.pickerOpen} onOpened={controls.closePicker} />
    ) : (
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
    ));

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
      <StepsTouch.Provider value={touch}>
        <Thread
          ref={threadRef}
          phone={touch}
          rows={view.rows}
          status={status}
          error={view.error ?? null}
          agentName={agentName}
          waiting={waiting}
          dim={dim}
          onCancelQueued={actions.onCancelQueued}
          onRetry={(text) => actions.onSend(text)}
          onKeepHere={actions.onKeepHere}
          older={view.older ?? null}
          loadFailed={view.loadFailed ?? null}
          loadStep={view.loadStep}
          home={view.home ?? null}
          blank={view.blank}
          layout={layout}
          tail={
            composer &&
            replies &&
            (proposals ? (
              <QuickReplyChips options={replies} onPick={sendReply} />
            ) : (
              <QuickReplies options={replies} onPick={sendReply} touch={touch} column={!!layout?.people} />
            ))
          }
          style={{ padding: `16px calc(20px + ${g.right}) 16px calc(20px + ${g.left})` }}
        />
      </StepsTouch.Provider>

      {composer && (
        <div ref={setDockEl} className={proposals ? "loki-dock px-5" : "loki-dock"}>
          <div className={proposals ? "mx-auto flex w-full max-w-3xl flex-col gap-2 empty:hidden" : "contents"}>
            {question &&
              actions.onAnswer &&
              (() => {
                const card = linkAsk ? (
                  <LinkCard requestId={question.requestId} ask={linkAsk} onAnswer={actions.onAnswer} touch={touch} />
                ) : (
                  <QuestionCard question={question} onAnswer={actions.onAnswer} touch={touch} />
                );
                return proposals ? (
                  <QuestionProposal where={linkAsk ? "a link to another chat" : `${agentName ?? "the agent"} asks`}>{card}</QuestionProposal>
                ) : (
                  card
                );
              })()}
            {approval &&
              (proposals && onApprove ? (
                <ApprovalProposal approval={approval} onApprove={onApprove} hints={hints} who={agentName ?? undefined} />
              ) : (
                <ApprovalCard approval={approval} />
              ))}
            {suggestions &&
              (proposals ? (
                <ReplyProposals source={suggestions.source} rt={suggestions.rt} blocked={suggestions.blocked ?? null} />
              ) : (
                <ReplyProposalCards source={suggestions.source} rt={suggestions.rt} blocked={suggestions.blocked ?? null} touch={touch} />
              ))}
          </div>
          {notice}

          <div
            {...folding.props}
            className={proposals ? "relative" : "loki-composer"}
            style={proposals ? undefined : { padding: `8px calc(12px + ${g.right}) ${hasFooter ? "8px" : `calc(12px + ${g.bottom})`} calc(12px + ${g.left})` }}
          >
            {describe && (
              <span id={describedBy} className="sr-only">
                {describe}
              </span>
            )}
            {palette.open &&
              (() => {
                const list = (
                  <SlashPalette matches={palette.matches} index={palette.index} listId={palette.listId} onHover={palette.setIndex} onPick={palette.pick} />
                );
                return proposals ? <div className="relative mx-auto w-full max-w-3xl">{list}</div> : list;
              })()}
            {(() => {
              const Box = proposals ? Composer : ChatInput;
              return (
                <Box
                  ref={inputRef}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={submit}
                  onKeyDown={onBoxKey}
                  onEscape={() => {
                    inputRef.current?.blur();
                    if (!draft.trim()) onEscapeEmpty?.();
                  }}
                  onFocus={() => onTyping?.(true)}
                  onBlur={() => onTyping?.(false)}
                  images={images}
                  onImages={setImages}
                  placeholder={placeholder ?? boxPlaceholder({ status, approval, question }, agentName, touch)}
                  touch={touch}
                  {...(proposals ? {} : { folded: folding.folded, ...(describe ? { "aria-describedby": describedBy } : {}) })}
                  tools={
                    touch &&
                    (hasModelPicker || hasModeMenu || suggestions) && (
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
                        {hasModeMenu && <ModeSwitch mode={currentMode} modes={modes} controls={controls} />}
                        {suggestions && <SuggestionChip {...suggestions} touch={touch} tick={suggestionsTick} />}
                      </>
                    )
                  }
                  canSend={hasContent}
                  onStop={running ? stop : undefined}
                  stopping={stopping}
                  sendLabel={status === "idle" ? "Send" : "Queue: sends when this turn ends"}
                  sendTitle={status === "idle" ? undefined : "the agent is mid-turn; this is kept and sent when the turn ends"}
                  {...palette.aria}
                  {...(proposals ? { queued: queuedRows, onCancelQueued: actions.onCancelQueued } : {})}
                  {...(proposals ? { extras: suggestions && <SuggestionChip {...suggestions} touch={touch} tick={suggestionsTick} /> } : {})}
                />
              );
            })()}
          </div>
          {picker}
          {modesInCommand && <OpenScope scope="permissions" open={controls.modeOpen} onOpened={controls.closeMode} />}

          {onApprove && !proposals && (
            <div className="loki-conversation-footer" style={{ padding: `0 calc(12px + ${g.right}) calc(12px + ${g.bottom}) calc(12px + ${g.left})` }}>
              {(() => {
                const approve = (
                  <Button key="approve" size="touch" tone="positive" className="loki-approve" onClick={() => onApprove("allow")} kbd={hints?.approve}>
                    Approve
                  </Button>
                );
                const deny = (
                  <Button key="deny" size="touch" tone="negative" className="loki-deny" onClick={() => onApprove("deny")} kbd={hints?.deny}>
                    Deny
                  </Button>
                );
                const always = (
                  <Button
                    key="always"
                    size="touch"
                    tone="paper"
                    className="loki-approve-always"
                    onClick={() => onApprove("always")}
                    title="Allow this tool from now on, in every chat (Preferences › Chat takes it back)"
                  >
                    Always Allow
                  </Button>
                );
                const more = approval && offersAlways(approval) ? [always] : [];
                return [deny, ...more, approve];
              })()}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function boxPlaceholder(view: Pick<ConversationView, "status" | "approval" | "question">, agentName: string | null | undefined, touch = false): string {
  if (view.question) return "Answer in your own words, or pick above";
  if (view.approval) return touch ? "Reply, or approve or deny the step" : "Reply, or allow or deny the step";
  const who = agentName ?? "the agent";
  return view.status === "idle" ? `Message ${who}` : `Message ${who} — sends when this turn ends`;
}

export function ConversationHeader({
  title,
  purpose,
  agentName,
  agentId,
  children,
  below,
  right,
}: {
  title: ReactNode;
  purpose?: string | null;
  agentName: string | null | undefined;
  agentId: string | null | undefined;
  children?: ReactNode;
  below?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      className="flex flex-none items-center justify-between gap-3"
      style={{
        padding: "12px 20px",
        borderBottom: "1px solid var(--loki-border)",
      }}
    >
      <div className="min-w-0">
        <Title className="loki-truncate">{title}</Title>
        {purpose && (
          <div className="loki-chat-purpose" title={purpose}>
            {purpose}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2" style={{ marginTop: 4 }}>
          <AgentFace name={agentName} src={agentId ? avatarUrl(agentId) : null} size={18} />
          <AgentChip name={agentName} />
          {children}
        </div>
        {below && <div style={{ marginTop: 4 }}>{below}</div>}
      </div>
      {right}
    </div>
  );
}

export interface ThreadHandle {
  unpin: () => void;
  reveal: (query: string) => void;
}

export interface ThreadProps {
  rows: TranscriptRow[] | undefined;
  status?: ChatStatus;
  error?: string | null;
  agentName?: string | null;
  waiting?: boolean;
  dim?: boolean;
  onCancelQueued?: (text: string) => void;
  onRetry?: (text: string) => void;
  onKeepHere?: () => Promise<string | null>;
  older?: (() => void) | null;
  loadFailed?: (() => void) | null;
  loadStep?: (row: number) => Promise<WholeRow | null>;
  home?: string | null;
  blank?: boolean;
  layout?: MessageLayout;
  tail?: ReactNode;
  style?: CSSProperties;
  phone?: boolean;
}

export const Thread = forwardRef<ThreadHandle, ThreadProps>(function Thread({ phone = false, ...props }, ref) {
  return phone ? <PhoneThread ref={ref} {...props} /> : <Timeline ref={ref} {...props} />;
});

const PhoneThread = forwardRef<ThreadHandle, Omit<ThreadProps, "phone">>(function PhoneThread(
  {
    rows,
    status = "idle",
    error = null,
    agentName,
    waiting = false,
    dim = true,
    onCancelQueued,
    onRetry,
    onKeepHere,
    older = null,
    loadFailed = null,
    loadStep,
    home = null,
    blank = false,
    layout,
    tail,
    style,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = rows ?? EMPTY;
  const arrivedFrom = useArrivedFrom(rows);
  const { unpinned, fresh, onScroll, jumpToLatest, unpin, start, above, reveal } = useTranscriptScroll(
    scrollRef,
    list,
    status,
    layout?.dividerAt ?? null,
    older,
  );
  useImperativeHandle(ref, () => ({ unpin, reveal }), [unpin, reveal]);
  const cancelQueuedRef = useRef(onCancelQueued);
  useEffect(() => {
    cancelQueuedRef.current = onCancelQueued;
  }, [onCancelQueued]);
  const cancelQueued = useCallback((row: TranscriptRow) => cancelQueuedRef.current?.(row.text), []);
  const loadStepRef = useRef(loadStep);
  useEffect(() => {
    loadStepRef.current = loadStep;
  }, [loadStep]);
  const stableLoadStep = useCallback((row: number) => loadStepRef.current?.(row) ?? Promise.resolve(null), []);
  const who = agentName ?? "the agent";
  return (
    <div className="flex flex-1 flex-col" style={{ position: "relative", minHeight: 0 }}>
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
          // Outside (Chrome): its scroll anchoring would move the row being read a second time, after the thread's own.
          overflowAnchor: "none",
          padding: "16px 20px",
          fontSize: "var(--text-sm)",
          lineHeight: 1.5,
          color: "var(--loki-fg)",
          ...style,
        }}
      >
        {!rows && !loadFailed && (
          <div style={{ color: "var(--loki-muted)", fontSize: "var(--text-xs)" }}>{home ? `Loading from ${home}…` : "Loading the thread…"}</div>
        )}
        {!rows && loadFailed && (
          <div className="loki-thread-error" role="alert">
            <span>{home ? `Could not load this chat from ${home}` : "Could not load this chat"}</span>
            <Button size="sm" onClick={loadFailed}>
              Try Again
            </Button>
          </div>
        )}
        {rows?.length === 0 && !blank && (
          <div style={{ color: "var(--loki-muted)", fontSize: "var(--text-xs)" }}>Nothing here yet — everything you send lands in {who}'s transcript</div>
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
              from={start}
              above={above}
              arrivedFrom={arrivedFrom}
              busy={status !== "idle"}
            />
          </StepsLoad.Provider>
        )}
        {tail}
        {status === "thinking" && !waiting && (
          <div className="loki-thinking">
            Thinking
            <span className="loki-thinking-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        {error && <ThreadError error={error} rows={rows ?? []} onRetry={status === "idle" ? onRetry : undefined} onKeepHere={onKeepHere} />}
        <ThreadAnnouncer status={status} waiting={waiting} rows={list} who={layout?.people?.assistant.name ?? agentName ?? "the agent"} />
      </div>
      {unpinned && (
        <Chip
          float
          onClick={jumpToLatest}
          aria-label={fresh > 0 ? `Jump to ${fresh} new ${fresh === 1 ? "message" : "messages"}` : "Jump to latest"}
          className="loki-latest-chip"
          style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}
        >
          <span key={fresh}>{fresh > 0 ? `↓ ${fresh} new` : "↓ latest"}</span>
        </Chip>
      )}
    </div>
  );
});

const NO_USUAL: readonly UsualChoice[] = [];

function OpenScope({ scope, open, onOpened }: { scope: CommandScope; open: boolean; onOpened: () => void }) {
  const opened = useRef(onOpened);
  useEffect(() => {
    opened.current = onOpened;
  });
  useEffect(() => {
    if (!open) return;
    openCommandCenter(scope);
    opened.current();
  }, [open, scope]);
  return null;
}
