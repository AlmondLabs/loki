import type { AttentionItem, AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, inboxQueue, type Decision } from "../../../core/attention/queue.ts";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, Dot, Empty, Meta } from "../components";
import { ConversationHeader } from "../chat/Conversation";
import { keyboard } from "./env";
import { keyFor } from "../shell/keymap";

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

/**
 * The title line: what needs you and how many chats are in the Inbox. A chat stays until it is archived, so there
 * is no pass to count down and no progress bar; the counts follow the live list.
 */
export function DeckHeader({ needYou, chats }: { needYou: number; chats: number }) {
  return (
    <div className="loki-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 6px 10px" }}>
      <span>Inbox</span>
      <span>
        <span style={{ color: needYou > 0 ? "var(--loki-fg)" : "var(--loki-muted)" }}>{needYou} need you</span>
        <span style={{ marginLeft: 14 }}>{chats} {chats === 1 ? "chat" : "chats"}</span>
      </span>
    </div>
  );
}

/** One pill per agent with chats in the Inbox, busiest first, after All; its name and how many chats. */
export function agentPills(items: AttentionItem[]): { agentId: string; name: string; count: number }[] {
  const by = new Map<string, { agentId: string; name: string; count: number }>();
  for (const i of inboxQueue(items)) {
    const p = by.get(i.agentId) ?? { agentId: i.agentId, name: i.agentName ?? "agent", count: 0 };
    p.count++;
    by.set(i.agentId, p);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Slack's filter pills over the deck: All, then each agent with something waiting. Shown once two agents
 * wait (one agent is All already), or while a pill is on, which stays with its count at 0 once its cards are
 * cleared, so you can see you are done with it and go back to All.
 */
export function AgentPills({ items, agent, onAgent }: { items: AttentionItem[]; agent: string | null; onAgent: (agent: string | null) => void }) {
  const pills = agentPills(items);
  if (agent && !pills.some((p) => p.agentId === agent)) pills.push({ agentId: agent, name: items.find((i) => i.agentId === agent)?.agentName ?? "agent", count: 0 });
  if (pills.length < 2 && !agent) return null;
  const all = pills.reduce((n, p) => n + p.count, 0);
  return (
    <div role="group" aria-label="Filter by agent" style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 6px 10px" }}>
      <Chip active={!agent} aria-pressed={!agent} onClick={() => onAgent(null)}>
        All <Meta>{all}</Meta>
      </Chip>
      {pills.map((p) => (
        <Chip key={p.agentId} active={agent === p.agentId} aria-pressed={agent === p.agentId} onClick={() => onAgent(agent === p.agentId ? null : p.agentId)}>
          {p.name} <Meta>{p.count}</Meta>
        </Chip>
      ))}
    </div>
  );
}

/** No card left: every chat moved past this visit (or none at all). What is still running, and what this visit did. */
export function CaughtUp({ items, decided, replies }: { items: AttentionItem[]; decided: Decision[]; replies: number }) {
  const running = items.filter((i) => i.status === "running").length;
  return (
    <Empty card title={decided.length ? "You've been through every chat." : "Nothing in the Inbox."}>
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 8 }}>{running > 0 ? `${running} still running` : "no agent is working right now"}</div>
      {(decided.length > 0 || replies > 0) && (
        <div style={{ fontSize: 12, color: "var(--loki-fg)", marginTop: 10, fontWeight: 600 }}>{passSummary(decided, replies)}</div>
      )}
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 6 }}>anything new lands here while this stays open</div>
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 18, fontFamily: "var(--loki-mono)" }}>{decided.length ? "z undo · " : ""}esc close</div>
    </Empty>
  );
}

/** "5 moved past · 2 archived · 1 approved · 1 reply". */
export function passSummary(decided: Decision[], replies: number): string {
  return [
    `${decided.length} moved past`,
    ...(["archive", "approve", "deny"] as const)
      .map((k) => [k, decided.filter((d) => d.via === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k === "approve" ? "approved" : k === "deny" ? "denied" : "archived"}`),
    ...(replies > 0 ? [`${replies} ${replies === 1 ? "reply" : "replies"}`] : []),
  ].join(" · ");
}

/** The statuses that wait on you: a red dot beside fg words, never red text (red text is not AA). */
export const needsYou = (status: AttentionStatus) => status === "approval" || status === "question";

/** A meta word worth noticing (in focus, came back): fg semibold instead of the old brass. */
const NOTED = { color: "var(--loki-fg)", fontWeight: 600 } as const;

export interface CardHeaderProps {
  current: AttentionItem;
  cameBack: boolean;
  flash: string | null;
}

/** Title, who and when, why it ranks here, and the status badge. The mode and model chips sit in the card's last row. */
export function CardHeader({ current, cameBack, flash }: CardHeaderProps) {
  const badge = BADGE[current.status];
  /** The one word that explains the card's place in the queue (priority.ts); blocked cards say it with the badge. */
  const reason = REASON_LABEL[current.reason];
  return (
    <ConversationHeader title={current.title ?? current.id} agentName={current.agentName} agentId={current.agentId} right={needsYou(current.status) ? <Chip static style={{ color: "var(--loki-fg)", fontWeight: 600 }}><Dot color={badge.color} />{flash ?? badge.label}</Chip> : <Chip tone={badge.color}>{flash ?? badge.label}</Chip>}>
      <Meta>{current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.lastMessageAt)}` : ago(current.lastMessageAt)}</Meta>
      {reason && <Meta style={current.reason === "focus" ? NOTED : undefined}>{reason}</Meta>}
      {cameBack && <Meta style={NOTED}>back · new since you moved on</Meta>}
    </ConversationHeader>
  );
}

/** An inbox binding's key in the grammar that applies: its chord while you type, its plain key (the second) when nothing has focus. */
export function deckKey(id: string, typing: boolean): string {
  return keyFor(id, keyboard, typing ? 0 : 1);
}

/**
 * The deck's moves, at the end of the card's last row (the Conversation puts the switchers and approve /
 * deny before them). The kbd hints switch grammar: letters when nothing has focus, ⌘ chords while you type.
 */
export function CardActions({ current, typing, next, archive, onOpenDesk, onClose }: { current: AttentionItem; typing: boolean; next: () => void; archive: () => void; onOpenDesk: (agentId: string, conversationId: string) => void; onClose: () => void }) {
  const main = current.id === "default";
  return (
    <>
      <Button size="sm" onClick={() => { onOpenDesk(current.agentId, current.id); onClose(); }} kbd={deckKey("inbox.open", typing)}>open chat</Button>
      <span style={{ flex: 1 }} />
      <Button size="sm" onClick={archive} disabled={main} title={main ? "a main chat cannot be archived" : "done with this chat: it leaves the Inbox"} kbd={deckKey("inbox.archive", typing)}>archive</Button>
      <Button size="sm" tone="paper" onClick={next} title="read it and move on: the chat stays for your next visit" kbd={deckKey("inbox.next", typing)}>next →</Button>
    </>
  );
}

/** The key legend under the deck, in whichever grammar applies right now. */
export function KeysHint({ typing }: { typing: boolean }) {
  return (
    <div className="loki-meta loki-meta--wrap" style={{ textAlign: "center", marginTop: 12, fontFamily: "var(--loki-mono)" }}>
      {typing ? `enter send (you stay on the card) · ${keyFor("inbox.next")} next · ${keyFor("inbox.archive")} archive · ${keyFor("inbox.approve")} approve · ${keyFor("inbox.deny")} deny · ${keyFor("inbox.open")} open · esc back to the deck's keys` : "→ next · E archive · A approve · D deny · R reply · O open · Z undo · esc close"}
    </div>
  );
}

/** How many chats need you right now, whatever this visit has decided. */
export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

/** True when this chat was already moved past in this visit and has come back with something new. */
export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => idOf(d.item) === idOf(current));
