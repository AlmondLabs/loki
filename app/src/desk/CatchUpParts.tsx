import type { AttentionItem, AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, type Decision } from "../../../core/attention/queue.ts";
import { formatIn, ordinal, type Snooze } from "../../../core/attention/snooze.ts";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, Dot, Empty, Meta } from "../components";
import { ConversationHeader } from "../chat/Conversation";

/** The pieces of a Catch Up card around its Conversation. State lives in CatchUpDeck; these only draw it and call back. */

/**
 * Status → label and colour for an attention item; the phone inbox (app/src/phone/Inbox.tsx) uses the same table.
 * Needs-you statuses take the red attention colour, which is only ever a dot or a badge: their words stay fg.
 */
export const BADGE: Record<AttentionStatus, { label: string; color: string }> = {
  approval: { label: "needs approval", color: "var(--loki-attention)" },
  question: { label: "asked you", color: "var(--loki-attention)" },
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
        <span>Catch up</span>
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
        <div style={{ fontSize: 12, color: "var(--loki-fg)", marginTop: 6 }}>
          {snoozedCount} snoozed · next back in {formatIn(nextDue)} · <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5 }}>S</span> to show them now
        </div>
      )}
      {(decided.length > 0 || replies > 0) && (
        <div style={{ fontSize: 12, color: "var(--loki-fg)", marginTop: 10, fontWeight: 600 }}>{passSummary(decided, replies)}</div>
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

/** The statuses that wait on you: a red dot beside fg words, never red text (red text is not AA). */
export const needsYou = (status: AttentionStatus) => status === "approval" || status === "question";

/** A meta word worth noticing (warm, came back, deferred again): fg semibold instead of the old brass. */
const NOTED = { color: "var(--loki-fg)", fontWeight: 600 } as const;

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
  /** The one word that explains the card's place in the queue (priority.ts); blocked cards say it with the badge. */
  const reason = REASON_LABEL[current.reason];
  return (
    <ConversationHeader title={current.title ?? current.id} agentName={current.agentName} agentId={current.agentId} right={needsYou(current.status) ? <Chip static style={{ color: "var(--loki-fg)", fontWeight: 600 }}><Dot color={badge.color} />{flash ?? badge.label}</Chip> : <Chip tone={badge.color}>{flash ?? badge.label}</Chip>}>
      <Meta>{current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.lastMessageAt)}` : ago(current.lastMessageAt)}</Meta>
      {reason && <Meta style={reason === "warm" ? NOTED : undefined}>{reason}</Meta>}
      {cameBack && <Meta style={NOTED}>back · new since you moved on</Meta>}
      {timesAround > 1 && <Meta style={NOTED}>{ordinal(timesAround)} time around · deferred {ago(priorSnooze!.at)} ago</Meta>}
      {current.snooze && <Meta>snoozed · due in {formatIn(current.snooze.until)}</Meta>}
    </ConversationHeader>
  );
}

/**
 * The deck's moves, at the end of the card's last row (the Conversation puts the switchers and approve /
 * deny before them). The kbd hints switch grammar: letters when nothing has focus, ⌘ chords while you type.
 */
export function CardActions({ current, typing, advance, onOpenDesk, onClose }: { current: AttentionItem; typing: boolean; advance: (action: "seen" | "unread") => void; onOpenDesk: (agentId: string, conversationId: string) => void; onClose: () => void }) {
  return (
    <>
      <Button size="sm" onClick={() => { onOpenDesk(current.agentId, current.id); onClose(); }} kbd={typing ? "⌘O" : "O"}>open desk</Button>
      <span style={{ flex: 1 }} />
      <Button size="sm" onClick={() => advance("unread")} title="not now — comes back later, later each time" kbd={typing ? "⌘[" : "←"}>← later</Button>
      <Button size="sm" tone="paper" onClick={() => advance("seen")} kbd={typing ? "⌘]" : "→"}>next →</Button>
    </>
  );
}

/** The key legend under the deck, in whichever grammar applies right now. */
export function KeysHint({ typing }: { typing: boolean }) {
  return (
    <div style={{ textAlign: "center", marginTop: 12, fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)" }}>
      {typing ? "enter send (you stay on the card) · ⌘] next · ⌘[ later · ⌘↵ approve · ⌘⇧D deny · ⌘O open · ⌘S snoozed · esc back to the deck's keys" : "→ next · ← later · A approve · D deny · R reply · O open · S snoozed · Z undo · esc close"}
    </div>
  );
}

/** How many conversations are live right now, whatever this pass has decided. */
export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

/** True when this conversation was already decided in this pass and has come back with something new. */
export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => idOf(d.item) === idOf(current));
