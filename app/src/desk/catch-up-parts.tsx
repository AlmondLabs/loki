import { ArchiveIcon, CheckIcon, ClockIcon, MailOpenIcon, XIcon } from "lucide-react";
import { ToolbarGroup, ToolbarTitle, type ToolbarMove } from "../item/toolbar";
import { Fragment } from "react";
import { type AttentionItem, type AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, type Decision } from "../../../core/attention/queue.ts";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, EmptyPane, Meta } from "../components";
import { chipText } from "../chat/suggestion-card";
import { keyboard } from "./env";
import { keyFor } from "../shell/keymap";
import { chatItem } from "../item/item-view";

/** The pieces of Flow's list and its detail around a card's Conversation. State lives in useFlowDeck; these only draw it and call back. */

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

/** The quiet line of R14: how many cards need the person in other lanes, never a red badge. Empty at 0. */
const othersLine = (others: number) => (others > 0 ? `${others} waiting in other lanes` : "");

/**
 * The list with no row left (plan 2026-11-14-1330, R12): "You're caught up", and Go Through Them while cards Next has
 * rested wait (core/attention/rest.ts), which brings them in, sorted afresh.
 */
export function FlowCaughtUp({ resting, onResting }: { resting: number; onResting?: () => void }) {
  return (
    <>
      <p className="loki-content-list-empty-title">You're caught up</p>
      {resting > 0 && (
        <>
          <p className="loki-meta loki-meta--wrap">{resting} resting</p>
          {onResting && <Button onClick={onResting}>Go Through Them</Button>}
        </>
      )}
    </>
  );
}

/**
 * The detail with no card left (R12): what this visit did ("5 moved past · 2 archived · 1 approved · 1 reply"), what is
 * still running, and, in a lane, how many cards wait in the other lanes with the way back to Everything (R20).
 */
export function VisitSummary({
  items,
  decided,
  replies,
  others = 0,
  onEverything,
}: {
  items: AttentionItem[];
  decided: Decision[];
  replies: number;
  /** Cards needing the person in other lanes (R14); 0 in Everything. */
  others?: number;
  /** Back to Everything; given only while a lane is on. */
  onEverything?: () => void;
}) {
  const quiet = othersLine(others);
  const running = items.filter((i) => i.status === "running").length;
  const did = decided.length > 0 || replies > 0;
  return (
    <EmptyPane icon="inbox" title={did ? "This Visit" : "Nothing Needs You"} style={{ position: "absolute", inset: 0 }}>
      {did && <p className="loki-empty-pane-summary">{passSummary(decided, replies)}</p>}
      <p className="loki-meta loki-meta--wrap">{running > 0 ? `${running} still running` : "No agent is working right now"}</p>
      <p className="loki-meta loki-meta--wrap">Anything new lands in the list while Flow stays open</p>
      {onEverything && (
        <div className="loki-empty-pane-row">
          {quiet && <span className="loki-meta">{quiet}</span>}
          <Button onClick={onEverything}>Back to Everything</Button>
        </div>
      )}
    </EmptyPane>
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

/** A meta word worth noticing (in focus, came back): fg semibold instead of the old brass. */
const NOTED = { color: "var(--loki-fg)", fontWeight: 600 } as const;

/** What a Flow chat card's header shows of its chat: whether it came back in, and how many suggestions wait. */
interface ChatCardFacts {
  current: AttentionItem;
  cameBack: boolean;
  /** How many suggestions made in this chat wait (plan 052), and the press on its mark that opens them in the card's box. */
  suggestions?: number;
  onSuggestions?: () => void;
}

/**
 * A chat card's words after its title, in the toolbar's grey line: when, why it ranks here, whether it came back, a
 * draft, and its suggestions' mark, joined by dots.
 */
export function ChatCardMeta({ current, cameBack, suggestions, onSuggestions }: ChatCardFacts) {
  /** The one word that explains the card's place in the queue (priority.ts); blocked cards say it with the badge. */
  const reason = REASON_LABEL[current.reason];
  const when = current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.last_message_at)}` : ago(current.last_message_at);
  const parts = [
    <Meta key="when">{when}</Meta>,
    reason && (
      <Meta key="reason" style={current.reason === "focus" ? NOTED : undefined}>
        {reason}
      </Meta>
    ),
    cameBack && (
      <Meta key="back" style={NOTED}>
        back · new since you moved on
      </Meta>
    ),
    current.has_draft && <Meta key="draft">draft</Meta>,
    (suggestions ?? 0) > 0 && (
      <Chip key="suggestions" tag brass onClick={onSuggestions} aria-haspopup="dialog" title="Open them in this card's message box">
        {chipText(suggestions ?? 0, false)}
      </Chip>
    ),
  ].filter(Boolean);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && " · "}
      {part}
    </Fragment>
  ));
}

/** A chat card's moves, as the deck makes them on the selected card. */
export interface ChatMoves {
  current: AttentionItem;
  /** Whether the reply box has focus: the tooltips then name the ⌘ chords rather than the plain keys. */
  typing: boolean;
  read: () => void;
  later: () => void;
  archive: () => void;
  /** Answer the card's approval; given, an approval card's toolbar shows Approve and Deny. */
  approve?: (behavior: "allow" | "deny") => void;
  /** The card was answered elsewhere (R11): its moves stay in view, every one of them off. */
  off?: boolean;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onClose: () => void;
}

/**
 * A chat card's header as a toolbar (plan 097, U8; plan 2026-11-12-1505, U16; plan 2026-11-14-1330, R10): the chat's
 * name over a grey line of its agent, state, folder and labels, then when and why, and the one-off line it flashes. Its
 * moves are the toolbar's symbols: Approve and Deny while an approval waits, then Later, Mark as Read and Archive, the
 * one prominent item.
 */
export function ChatItemHeader({
  current,
  cameBack,
  flash,
  suggestions = 0,
  onSuggestions,
  moves,
}: ChatCardFacts & {
  /** The one-off line the card flashes after a move. */
  flash: string | null;
  moves: ChatMoves;
}) {
  const view = chatItem({ item: current, live: null, turns: [] }).header;
  const main = current.id === "default";
  const off = moves.off ?? false;
  const open = () => (moves.onOpenDesk(current.agent_id, current.id), moves.onClose());
  const { approve } = moves;
  const decide: ToolbarMove[] =
    current.pendingApproval && approve
      ? [
          {
            label: "Approve",
            icon: <CheckIcon aria-hidden />,
            title: `Approve (${deckKey("inbox.approve", moves.typing)})`,
            disabled: off,
            run: () => approve("allow"),
          },
          { label: "Deny", icon: <XIcon aria-hidden />, title: `Deny (${deckKey("inbox.deny", moves.typing)})`, disabled: off, run: () => approve("deny") },
        ]
      : [];
  return (
    <div data-item-header className="loki-card-toolbar">
      <ToolbarTitle
        title={view.title}
        facts={view.properties}
        onOpen={open}
        openTitle={`Open Chat (${deckKey("inbox.open", moves.typing)})`}
        extra={
          <>
            {" · "}
            <ChatCardMeta current={current} cameBack={cameBack} suggestions={suggestions} onSuggestions={onSuggestions} />
            {flash && (
              <>
                {" · "}
                <Meta style={NOTED}>{flash}</Meta>
              </>
            )}
          </>
        }
      />
      {decide.length > 0 && <ToolbarGroup label="Decision" moves={decide} />}
      <ToolbarGroup
        label="Chat actions"
        moves={[
          { label: "Later", icon: <ClockIcon aria-hidden />, title: `Later (${deckKey("inbox.later", moves.typing)})`, disabled: off, run: moves.later },
          {
            label: "Mark as Read",
            icon: <MailOpenIcon aria-hidden />,
            title: `Mark as Read (${deckKey("inbox.next", moves.typing)})`,
            disabled: off,
            run: moves.read,
          },
          {
            label: "Archive",
            icon: <ArchiveIcon aria-hidden />,
            title: main ? "A main chat cannot be archived" : `Archive (${deckKey("inbox.archive", moves.typing)})`,
            disabled: main || off,
            prominent: true,
            run: moves.archive,
          },
        ]}
      />
    </div>
  );
}

/** An inbox binding's key in the grammar that applies: its chord while you type, its plain key (the second) when nothing has focus. */
export function deckKey(id: string, typing: boolean): string {
  return keyFor(id, keyboard, typing ? 0 : 1);
}

/** How many chats need you right now, whatever this visit has decided. */
export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

/** True when this chat was already moved past in this visit and has come back with something new; a label moves nothing past. */
export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => d.action !== "label" && idOf(d.item) === idOf(current));
