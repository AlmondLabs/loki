import { ownerAgentOf, type AttentionItem, type AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, inboxQueue, type Decision } from "../../../core/attention/queue.ts";
import type { LabelView } from "../../../core/labels.ts";
import { LabelChips } from "../chat/labels";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, Dot, Empty, Meta } from "../components";
import { chipText } from "../chat/suggestion-card";
import { CardFace, CardHead } from "./card-head";
import { avatarUrl } from "./env";
import { keyboard } from "./env";
import { keyFor } from "../shell/keymap";

/** The pieces of a Catch Up card around its Conversation. State lives in CatchUpDeck; these only draw it and call back. */

/**
 * Status → label and colour for an attention item; the phone inbox (app/src/phone/inbox.tsx) uses the same table.
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

/** How long ago a time was, in the Inbox's short words ("just now", "5m", "3h", "2d"); empty for no time. */
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
        <span style={{ marginLeft: 14 }}>
          {chats} {chats === 1 ? "chat" : "chats"}
        </span>
      </span>
    </div>
  );
}

/** That agent's name as its pill says it. */
const pillNameOf = (i: AttentionItem): string => (i.outside ? i.outside.owner_name : i.agent_name) ?? "agent";

/** One pill per agent with chats in the Inbox, busiest first, after All; its name and how many cards, its accounts' included. */
export function agentPills(items: AttentionItem[]): Array<{ agentId: string; name: string; count: number }> {
  const by = new Map<string, { agentId: string; name: string; count: number }>();
  for (const i of inboxQueue(items)) {
    const id = ownerAgentOf(i);
    const p = by.get(id) ?? { agentId: id, name: pillNameOf(i), count: 0 };
    // A chat names its agent better than a card from one of its accounts does.
    if (!i.outside && i.agent_name) p.name = i.agent_name;
    p.count++;
    by.set(id, p);
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
  if (agent && !pills.some((p) => p.agentId === agent)) {
    const one = items.find((i) => ownerAgentOf(i) === agent);
    pills.push({ agentId: agent, name: one ? pillNameOf(one) : "agent", count: 0 });
  }
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

/**
 * No card left: every chat moved past this visit (or none at all). What is still running, what rests (Next rested it,
 * core/attention/rest.ts) with the way to go through those, and what this visit did.
 */
export function CaughtUp({
  items,
  decided,
  replies,
  resting = 0,
  onResting,
}: {
  items: AttentionItem[];
  decided: Decision[];
  replies: number;
  /** Cards Next has rested, not due back yet. */
  resting?: number;
  onResting?: () => void;
}) {
  const running = items.filter((i) => i.status === "running").length;
  return (
    <Empty card title={resting > 0 ? "You're caught up." : decided.length ? "You've been through every chat." : "Nothing in the Inbox."}>
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 8 }}>
        {running > 0 ? `${running} still running` : "no agent is working right now"}
      </div>
      {resting > 0 && (
        <div className="loki-meta loki-meta--wrap" style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span>{resting} resting</span>
          {onResting && (
            <Button bare size="sm" tone="brass" onClick={onResting}>
              go through them
            </Button>
          )}
        </div>
      )}
      {(decided.length > 0 || replies > 0) && (
        <div style={{ fontSize: 12, color: "var(--loki-fg)", marginTop: 10, fontWeight: 600 }}>{passSummary(decided, replies)}</div>
      )}
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 6 }}>
        anything new lands here while this stays open
      </div>
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 18, fontFamily: "var(--loki-mono)" }}>
        {decided.length ? "z undo · " : ""}esc close
      </div>
    </Empty>
  );
}

/** "5 moved past · 2 archived · 1 approved · 1 reply". A label keeps its card, so it moves nothing past. */
export function passSummary(decided: Decision[], replies: number): string {
  return [
    `${decided.filter((d) => d.action !== "label").length} moved past`,
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

/** The props of `CardHeader`: the Inbox card's chat, whether it came back in, and the one-off line it flashes. */
export interface CardHeaderProps {
  current: AttentionItem;
  cameBack: boolean;
  flash: string | null;
  /** The labels' colours (plan 022), for the chat's chips beside when and why. */
  labelList?: readonly LabelView[] | null;
  /** How many suggestions made in this chat wait (plan 052), and the press on its mark that opens them in the card's box. */
  suggestions?: number;
  onSuggestions?: () => void;
}

/**
 * The chat card's header in the Inbox's one shape (plan 073): the agent's face, its name, then the chat's title and
 * when, why it ranks here and the rest; the status badge is the tag. The chat's purpose shows on the title's hover, so
 * the header stays two lines. The mode and model chips sit in the card's last row.
 */
export function CardHeader({ current, cameBack, flash, labelList = null, suggestions = 0, onSuggestions }: CardHeaderProps) {
  const agent = current.agent_name ?? "agent";
  return (
    <CardHead
      face={<CardFace name={agent} src={current.agent_id ? avatarUrl(current.agent_id) : null} />}
      who={agent}
      line={<ChatCardLine current={current} cameBack={cameBack} labelList={labelList} suggestions={suggestions} onSuggestions={onSuggestions} />}
      right={<StatusBadge status={current.status} flash={flash} />}
    />
  );
}

/** A chat card's second line: the chat's title (its purpose on hover), when, why it ranks here, and its marks. */
function ChatCardLine({ current, cameBack, labelList, suggestions, onSuggestions }: Omit<CardHeaderProps, "flash">) {
  /** The one word that explains the card's place in the queue (priority.ts); blocked cards say it with the badge. */
  const reason = REASON_LABEL[current.reason];
  const title = current.title ?? current.id;
  const when = current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.last_message_at)}` : ago(current.last_message_at);
  return (
    <>
      <span className="loki-card-head-what" title={current.purpose ? `${title} — ${current.purpose}` : title}>
        {title}
      </span>
      <Meta>{when}</Meta>
      {reason && <Meta style={current.reason === "focus" ? NOTED : undefined}>{reason}</Meta>}
      {cameBack && <Meta style={NOTED}>back · new since you moved on</Meta>}
      {current.has_draft && <Meta>draft</Meta>}
      {(suggestions ?? 0) > 0 && (
        <Chip tag brass onClick={onSuggestions} aria-haspopup="dialog" title="open them in this card's message box">
          {chipText(suggestions ?? 0, false)}
        </Chip>
      )}
      <LabelChips labels={current.labels} list={labelList ?? null} />
    </>
  );
}

/** A chat's status as its card's tag: a dot in full ink when it waits on the person, a toned chip otherwise. */
function StatusBadge({ status, flash }: { status: AttentionStatus; flash: string | null }) {
  const badge = BADGE[status];
  const label = flash ?? badge.label;
  if (needsYou(status))
    return (
      <Chip static style={{ color: "var(--loki-fg)", fontWeight: 600 }}>
        <Dot color={badge.color} />
        {label}
      </Chip>
    );
  return label ? <Chip tone={badge.color}>{label}</Chip> : null;
}

/** An inbox binding's key in the grammar that applies: its chord while you type, its plain key (the second) when nothing has focus. */
export function deckKey(id: string, typing: boolean): string {
  return keyFor(id, keyboard, typing ? 0 : 1);
}

/**
 * The deck's moves, at the end of the card's last row (the Conversation puts the switchers and approve /
 * deny before them): open, archive, later and read. The kbd hints switch grammar: letters when nothing has focus,
 * ⌘ chords while you type.
 */
export function CardActions({
  current,
  typing,
  read,
  later,
  archive,
  onOpenDesk,
  onClose,
}: {
  current: AttentionItem;
  typing: boolean;
  read: () => void;
  later: () => void;
  archive: () => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onClose: () => void;
}) {
  const main = current.id === "default";
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          onOpenDesk(current.agent_id, current.id);
          onClose();
        }}
        kbd={deckKey("inbox.open", typing)}
      >
        open chat
      </Button>
      <Button
        size="sm"
        onClick={archive}
        disabled={main}
        title={main ? "a main chat cannot be archived" : "done with this chat: it leaves the Inbox"}
        kbd={deckKey("inbox.archive", typing)}
      >
        archive
      </Button>
      <span style={{ flex: 1 }} />
      <Button
        size="sm"
        onClick={later}
        title="keep it unread: the chat comes back in a day, or sooner if something new arrives"
        kbd={deckKey("inbox.later", typing)}
      >
        later
      </Button>
      <Button size="sm" tone="paper" onClick={read} title="mark it read: the chat rests and comes back later" kbd={deckKey("inbox.next", typing)}>
        read
      </Button>
    </>
  );
}

/** The key legend under the deck, in whichever grammar applies right now, for the card on top: a chat, an email or a Slack message. */
export function KeysHint({ typing, current }: { typing: boolean; current?: AttentionItem }) {
  const o = current?.outside;
  const moves = `${deckKey("inbox.next", typing)} read · ${deckKey("inbox.later", typing)} later · ${deckKey("inbox.archive", typing)} archive`;
  const label = o?.provider === "gmail" ? ` · ${keyFor("inbox.label")} label` : "";
  const outside = typing
    ? `enter send, then read · ${moves} (a reply goes first) · esc back to the deck's keys`
    : `${moves}${label} · ${keyFor("inbox.reply")} reply · ${deckKey("inbox.undo", false)} undo · esc close`;
  const chat = typing
    ? `enter send (you stay on the card) · ${moves} · ${keyFor("inbox.approve")} approve · ${keyFor("inbox.deny")} deny · ${keyFor("inbox.open")} open · esc back to the deck's keys`
    : `${moves} · ${deckKey("inbox.approve", false)} approve · ${deckKey("inbox.deny", false)} deny · ${keyFor("inbox.reply")} reply · ${deckKey("inbox.open", false)} open · ${deckKey("inbox.undo", false)} undo · esc close`;
  return (
    <div className="loki-meta loki-meta--wrap" style={{ textAlign: "center", marginTop: 12, fontFamily: "var(--loki-mono)" }}>
      {o ? outside : chat}
    </div>
  );
}

/** How many chats need you right now, whatever this visit has decided. */
export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

/** True when this chat was already moved past in this visit and has come back with something new; a label moves nothing past. */
export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => d.action !== "label" && idOf(d.item) === idOf(current));
