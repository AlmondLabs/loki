import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ChatInput } from "../chat/ChatInput";
import { SlashPalette } from "../chat/SlashPalette";
import { useSlashPalette } from "../chat/useSlashPalette";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import { AgentChip, AgentFace } from "./AgentChip";
import { avatarUrl } from "./env";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, type Decision } from "../../../core/attention/queue.ts";
import { formatIn, ordinal, type Snooze } from "../../../core/attention/snooze.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import { Button, Chip, Empty, Meta, Title } from "../components";
import { ModelChip, ModelPicker, type ModelEntry } from "../chat/ModelPicker";
import { ModeChip, ModeMenu, isPermissionMode, type PermissionMode } from "../chat/PermissionMode";
import type { AttentionStatus } from "../../../core/attention/model.ts";

/** The pieces of a Catch Up card. State lives in CatchUpDeck; these only draw it and call back. */

/** Status → label and colour for an attention item; the phone inbox (app/src/phone/Inbox.tsx) uses the same table. */
export const BADGE: Record<AttentionStatus, { label: string; color: string }> = {
  approval: { label: "needs approval", color: "var(--loki-accent)" },
  question: { label: "asked you", color: "var(--loki-accent)" },
  failed: { label: "failed", color: "var(--loki-negative)" },
  done: { label: "finished", color: "var(--loki-positive)" },
  running: { label: "running", color: "var(--loki-muted)" },
  idle: { label: "", color: "var(--loki-muted)" },
};

export function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** The title line and the progress bar: where you are in the pass, what is live, what is deferred. */
export function DeckHeader({ current, position, total, left, liveWaiting, snoozedCount, showSnoozed }: { current: AttentionItem | undefined; position: number; total: number; left: number; liveWaiting: number; snoozedCount: number; showSnoozed: boolean }) {
  return (
    <>
      <div className="loki-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 6px 10px" }}>
        <span>catch up</span>
        <span>
          {current ? `${position} of ${total} · ${left} left in this pass` : total ? `${total} of ${total}` : ""}
          <span style={{ marginLeft: 14, color: liveWaiting > 0 ? "var(--loki-fg)" : "var(--loki-muted)" }}>{liveWaiting} waiting</span>
          {snoozedCount > 0 && <span style={{ marginLeft: 14, color: showSnoozed ? "var(--loki-accent)" : "var(--loki-muted)" }}>{snoozedCount} snoozed{showSnoozed ? " · shown" : ""}</span>}
        </span>
      </div>
      {total > 0 && (
        <div aria-hidden style={{ height: 2, margin: "0 6px 10px", background: "var(--loki-border)", borderRadius: 1, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.round(((total - left) / total) * 100)}%`, background: "var(--loki-accent)", transition: "width 240ms ease-out" }} />
        </div>
      )}
    </>
  );
}

/** The card with nothing waiting: what is still running, what is deferred, and what this pass did. */
export function CaughtUp({ items, snoozedCount, nextDue, decided, replies }: { items: AttentionItem[]; snoozedCount: number; nextDue: string | null; decided: Decision[]; replies: number }) {
  const running = items.filter((i) => i.status === "running").length;
  return (
    <Empty card title="You're caught up.">
      <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 8 }}>{running > 0 ? `${running} still running` : "nothing is waiting on you"}</div>
      {snoozedCount > 0 && nextDue && (
        <div style={{ fontSize: 12, color: "var(--loki-accent)", marginTop: 6 }}>
          {snoozedCount} snoozed · next back in {formatIn(nextDue)} · <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5 }}>S</span> to show them now
        </div>
      )}
      {(decided.length > 0 || replies > 0) && (
        <div style={{ fontSize: 12, color: "var(--loki-fg)", marginTop: 10, fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>{passSummary(decided, replies)}</div>
      )}
      <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 6 }}>anything new lands here while this stays open</div>
      <div style={{ marginTop: 18, fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)" }}>{decided.length ? "z undo · " : ""}esc close</div>
    </Empty>
  );
}

/** "3 cleared this pass · 1 approved · 2 for later · 1 reply". */
export function passSummary(decided: Decision[], replies: number): string {
  return [
    `${decided.length} cleared this pass`,
    ...(["approve", "deny", "later"] as const)
      .map((k) => [k, decided.filter((d) => d.via === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k === "approve" ? "approved" : k === "deny" ? "denied" : "for later"}`),
    ...(replies > 0 ? [`${replies} ${replies === 1 ? "reply" : "replies"}`] : []),
  ].join(" · ");
}

/** The open/busy flags of the two chips in the card's last row. They belong to the deck, not the card, so a switch in flight survives a move. */
export function useChipState() {
  const [modelPicker, setModelPicker] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  return { modelPicker, setModelPicker, switching, setSwitching, modeMenu, setModeMenu, changingMode, setChangingMode };
}
export type ChipState = ReturnType<typeof useChipState>;

/** The conversation's switchers on a card: its mode and model, whether each can be changed, and the chips' state. */
export interface ChipControls {
  threadMode: string | null | undefined;
  chips: ChipState;
  modelFor?: (agentId: string, conversationId: string) => string | null;
  models: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (item: AttentionItem, handle: string) => Promise<void>;
  modeFor?: (agentId: string, conversationId: string) => string | null;
  onPickMode?: (item: AttentionItem, mode: PermissionMode) => Promise<void>;
}

export interface CardHeaderProps {
  current: AttentionItem;
  cameBack: boolean;
  timesAround: number;
  priorSnooze: Snooze | undefined;
  flash: string | null;
}

/** Title, who and when, the deferral history, and the status badge. The mode and model chips sit in the card's last row. */
export function CardHeader({ current, cameBack, timesAround, priorSnooze, flash }: CardHeaderProps) {
  const badge = BADGE[current.status];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--loki-border)" }}>
      <div style={{ minWidth: 0 }}>
        <Title style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current.title ?? current.id}</Title>
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
          <AgentFace name={current.agentName} src={avatarUrl(current.agentId)} size={18} />
          <AgentChip name={current.agentName} />
          <Meta>{current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.lastMessageAt)}` : ago(current.lastMessageAt)}</Meta>
          {cameBack && <Meta brass>back · new since you moved on</Meta>}
          {timesAround > 1 && <Meta brass>{ordinal(timesAround)} time around · deferred {ago(priorSnooze!.at)} ago</Meta>}
          {current.snooze && <Meta>snoozed · due in {formatIn(current.snooze.until)}</Meta>}
        </div>
      </div>
      <Chip tone={badge.color}>{flash ?? badge.label}</Chip>
    </div>
  );
}

/** The permission-mode chip and its menu (opening upward) for the card's conversation; the live thread's mode wins over the record's. */
function ModeChips({ current, threadMode, chips, modeFor, onPickMode }: { current: AttentionItem; threadMode: string | null | undefined; chips: ChipState; modeFor: (agentId: string, conversationId: string) => string | null; onPickMode: (item: AttentionItem, mode: PermissionMode) => Promise<void> }) {
  const recorded = modeFor(current.agentId, current.id);
  const mode = isPermissionMode(threadMode) ? threadMode : isPermissionMode(recorded) ? (recorded as PermissionMode) : null;
  return (
    <>
      <ModeChip mode={mode} busy={chips.changingMode} onClick={() => chips.setModeMenu((v) => !v)} />
      <ModeMenu
        open={chips.modeMenu}
        side="above"
        current={mode}
        onClose={() => chips.setModeMenu(false)}
        onPick={(m) => {
          chips.setModeMenu(false);
          chips.setChangingMode(true);
          void onPickMode(current, m).finally(() => chips.setChangingMode(false));
        }}
      />
    </>
  );
}

/** The model chip and its picker (opening upward) for the card's conversation. */
function ModelChips({ current, chips, modelFor, models, onLoadModels, onPickModel }: { current: AttentionItem; chips: ChipState; modelFor: (agentId: string, conversationId: string) => string | null; models: ModelEntry[] | null; onLoadModels?: () => void; onPickModel: (item: AttentionItem, handle: string) => Promise<void> }) {
  return (
    <>
      <ModelChip
        model={modelFor(current.agentId, current.id)}
        busy={chips.switching}
        onClick={() => {
          onLoadModels?.();
          chips.setModelPicker((v) => !v);
        }}
      />
      <ModelPicker
        open={chips.modelPicker}
        side="above"
        current={modelFor(current.agentId, current.id)}
        entries={models}
        loading={!models}
        onClose={() => chips.setModelPicker(false)}
        onPick={(h) => {
          chips.setModelPicker(false);
          chips.setSwitching(true);
          void onPickModel(current, h).finally(() => chips.setSwitching(false));
        }}
      />
    </>
  );
}

/**
 * The reply box and its send button. Esc keeps a draft and hands the keys back, or closes an untouched deck.
 * A draft that starts with "/" opens the same command palette the desk chat has (useSlashPalette).
 */
export function ReplyBox({ current, replyRef, draft, setDraft, images, setImages, sendReply, setTyping, onClose, commands = [], onCommand }: { current: AttentionItem; replyRef: RefObject<HTMLTextAreaElement | null>; draft: string; setDraft: (v: string) => void; images: ImageAttachment[]; setImages: Dispatch<SetStateAction<ImageAttachment[]>>; sendReply: () => void; setTyping: (v: boolean) => void; onClose: () => void; commands?: SlashCommand[]; onCommand?: (id: string, args: string) => void }) {
  const palette = useSlashPalette({ draft, onDraft: setDraft, commands, onCommand, inputRef: replyRef });
  return (
    <div style={{ position: "relative", display: "flex", gap: 8, padding: "12px 12px 8px", borderTop: "1px solid var(--loki-border)", alignItems: "flex-end" }}>
      {palette.open && <SlashPalette matches={palette.matches} index={palette.index} listId={palette.listId} onHover={palette.setIndex} onPick={palette.pick} />}
      <ChatInput
        ref={replyRef}
        value={draft}
        onChange={setDraft}
        onSubmit={sendReply}
        onKeyDown={palette.onKeyDown}
        images={images}
        onImages={setImages}
        onEscape={() => (draft.trim() ? replyRef.current?.blur() : onClose())} // esc: keep a draft and hand keys back, or close an untouched deck
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        placeholder={replyPlaceholder(current)}
        {...palette.aria}
      />
      <Button size="md" tone="brass" onClick={sendReply} disabled={!draft.trim() && !images.length}>send</Button>
    </div>
  );
}

function replyPlaceholder(current: AttentionItem): string {
  if (current.pendingApproval) return "reply, or approve / deny below…";
  if (current.pendingQuestion) return current.pendingQuestion.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…";
  return "reply… (enter to send · ⇧↵ new line)";
}

/**
 * The card's last row: the conversation's model and mode chips on the left (their popovers open upward,
 * as in the desk chat), then the actions. The kbd hints switch grammar: letters when nothing has focus,
 * ⌘ chords while you type.
 */
export function CardFooter({ current, typing, approve, advance, onOpenDesk, onClose, controls }: { current: AttentionItem; typing: boolean; approve: (behavior: "allow" | "deny") => void; advance: (action: "seen" | "unread") => void; onOpenDesk: (agentId: string, conversationId: string) => void; onClose: () => void; controls: ChipControls }) {
  const { threadMode, chips, modelFor, models, onLoadModels, onPickModel, modeFor, onPickMode } = controls;
  return (
    <div style={{ position: "relative", display: "flex", gap: 8, padding: "0 12px 12px", alignItems: "center", flexWrap: "wrap" }}>
      {onPickModel && modelFor && <ModelChips current={current} chips={chips} modelFor={modelFor} models={models} onLoadModels={onLoadModels} onPickModel={onPickModel} />}
      {onPickMode && modeFor && <ModeChips current={current} threadMode={threadMode} chips={chips} modeFor={modeFor} onPickMode={onPickMode} />}
      {current.pendingApproval && (
        <>
          <Button size="sm" tone="positive" onClick={() => approve("allow")} kbd={typing ? "⌘↵" : "A"}>approve</Button>
          <Button size="sm" tone="negative" onClick={() => approve("deny")} kbd={typing ? "⌘⇧D" : "D"}>deny</Button>
        </>
      )}
      <Button size="sm" onClick={() => { onOpenDesk(current.agentId, current.id); onClose(); }} kbd={typing ? "⌘O" : "O"}>open desk</Button>
      <span style={{ flex: 1 }} />
      <Button size="sm" onClick={() => advance("unread")} title="not now — comes back later, later each time" kbd={typing ? "⌘[" : "←"}>← later</Button>
      <Button size="sm" tone="paper" onClick={() => advance("seen")} kbd={typing ? "⌘]" : "→"}>next →</Button>
    </div>
  );
}

/** The key legend under the deck, in whichever grammar applies right now. */
export function KeysHint({ typing }: { typing: boolean }) {
  return (
    <div style={{ textAlign: "center", marginTop: 12, fontSize: 10.5, color: "var(--loki-muted)", letterSpacing: "0.06em", fontFamily: "var(--loki-mono)" }}>
      {typing ? "enter send (you stay on the card) · ⌘] next · ⌘[ later · ⌘↵ approve · ⌘⇧D deny · ⌘O open · ⌘S snoozed · esc back to the deck's keys" : "→ next · ← later · A approve · D deny · R reply · O open · S snoozed · Z undo · esc close"}
    </div>
  );
}

/** How many conversations are live right now, whatever this pass has decided. */
export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

/** True when this conversation was already decided in this pass and has come back with something new. */
export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => idOf(d.item) === idOf(current));
