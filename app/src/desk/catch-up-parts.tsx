import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AttentionItem, AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, type Decision } from "../../../core/attention/queue.ts";
import { agentLanes, type AgentLane, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import type { LabelView } from "../../../core/labels.ts";
import { LabelChips } from "../chat/labels";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, Dot, Empty, Meta, Popover, Row } from "../components";
import { chipText } from "../chat/suggestion-card";
import { CardFace, CardHead } from "./card-head";
import { avatarUrl } from "./env";
import { keyboard } from "./env";
import { formatKeys, keyFor } from "../shell/keymap";

/** The pieces of a Flow card around its Conversation, and the title with its lane switcher. State lives in CatchUpDeck; these only draw it and call back. */

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

/** Flow's title as its switcher says it (R11): "flow" in Everything, "flow · Work" in a lane, the name as it was typed. */
export const laneTitle = (lane: ResolvedLane | null): string => (lane ? `flow · ${lane.name}` : "flow");

/** The quiet line of R14: how many cards need the person in other lanes, never a red badge. Empty at 0. */
const othersLine = (others: number) => (others > 0 ? `${others} waiting in other lanes` : "");

/** The props of the title line and its switcher: the active lane, the person's lanes, and every card in Flow. */
export interface LaneSwitchProps {
  /** The active lane, null for Everything. */
  lane: ResolvedLane | null;
  /** The lanes the person made, null until they first come. */
  lanes: Lane[] | null;
  /** Every card in Flow, whatever the lane: the agent lanes are listed from them (KTD5). */
  items: AttentionItem[];
  /** A lane picked, null for Everything. */
  onLane: (lane: ResolvedLane | null) => void;
  /** Open Preferences › Flow to make a lane; left out, the menu has no "new lane…". */
  onNewLane?: () => void;
}

/**
 * The title line: the lane switcher, then what needs you and how many chats are in the lane, and while a lane is on,
 * the quiet count of cards waiting in the others (R14). A chat stays until it is archived, so there is no pass to
 * count down and no progress bar; the counts follow the live list.
 */
export function DeckHeader({ needYou, chats, others, ...lane }: LaneSwitchProps & { needYou: number; chats: number; others: number }) {
  const quiet = othersLine(others);
  return (
    <div className="loki-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 6px 10px" }}>
      <LaneSwitch {...lane} />
      <span>
        {quiet && <span style={{ marginRight: 14 }}>{quiet}</span>}
        <span style={{ color: needYou > 0 ? "var(--loki-fg)" : "var(--loki-muted)" }}>{needYou} need you</span>
        <span style={{ marginLeft: 14 }}>
          {chats} {chats === 1 ? "chat" : "chats"}
        </span>
      </span>
    </div>
  );
}

/** Flow's title as a menu button (R11, plan 087 U6): it names the lane, and opens the menu that switches it. */
function LaneSwitch({ onLane, onNewLane, ...props }: LaneSwitchProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="loki-label"
        aria-haspopup="menu"
        aria-expanded={open}
        title="switch lane"
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "baseline", gap: 4 }}
      >
        {laneTitle(props.lane)}
        <span aria-hidden style={{ fontSize: 9.5 }}>
          ▾
        </span>
      </button>
      {open && (
        <LaneMenu {...props} onPick={(lane) => (close(), onLane(lane))} onNewLane={onNewLane ? () => (close(), onNewLane()) : undefined} onClose={close} />
      )}
    </span>
  );
}

/**
 * The agent lanes the menu lists (R18, KTD5): one per agent with cards in Flow, and the active one
 * even once its cards are cleared, so the person sees where they are; it leaves the list when they switch away (R20).
 */
function listedAgentLanes(items: AttentionItem[], lane: ResolvedLane | null): AgentLane[] {
  const listed = agentLanes(items);
  if (lane && "agent_id" in lane && !listed.some((l) => l.id === lane.id)) listed.push(lane);
  return listed;
}

const menuItems = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];

/**
 * The lane menu under Flow's title: everything, the person's lanes, then each agent's built-in lane, each a radio
 * item, and "new lane…". ↑↓ move, Enter picks, Esc or a press outside closes. Every key stays in the menu, so a
 * letter meant for it never moves the card under it.
 */
export function LaneMenu({
  lane,
  lanes,
  items,
  onPick,
  onNewLane,
  onClose,
}: Omit<LaneSwitchProps, "onLane"> & { onPick: (lane: ResolvedLane | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const menu = ref.current;
    const anchor = menu?.parentElement ?? null;
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menuItems(menu).at(0))?.focus();
    const away = (e: PointerEvent) => {
      if (!anchor?.contains(e.target as Node)) closeRef.current();
    };
    // Capture phase: the deck stops pointerdown from bubbling, and a press on it must still close the menu.
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      const a = document.activeElement;
      if (!a || a === document.body || menu?.contains(a)) anchor?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
  }, []);
  const activeId = lane?.id ?? "";
  const radio = (key: string, on: boolean, pick: () => void, body: ReactNode) => (
    <Row key={key} dense role="menuitemradio" aria-checked={on} onClick={pick} style={{ display: "flex", justifyContent: "space-between" }}>
      {body}
    </Row>
  );
  const agents = listedAgentLanes(items, lane);
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label="lanes"
      width={240}
      // It hangs from the title's own small wrapper, so the popover's usual cap (its parent's width) would crush it.
      style={{ padding: 4, maxWidth: "none" }}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        e.stopPropagation();
        const all = menuItems(ref.current);
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") all[Math.min(all.length - 1, i + 1)]?.focus();
        else if (e.key === "ArrowUp") all[Math.max(0, i - 1)]?.focus();
        else if (e.key === "Home") all[0]?.focus();
        else if (e.key === "End") all.at(-1)?.focus();
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
      }}
    >
      {radio("", activeId === "", () => onPick(null), <span>everything</span>)}
      {(lanes ?? []).map((l) => radio(l.id, l.id === activeId, () => onPick(l), <span>{l.name}</span>))}
      {agents.length > 0 && <hr className="loki-title-menu-sep" />}
      {agents.map((l) =>
        radio(
          l.id,
          l.id === activeId,
          () => onPick(l),
          <>
            <span>{l.name}</span> <Meta>{l.count}</Meta>
          </>,
        ),
      )}
      {onNewLane && (
        <>
          <hr className="loki-title-menu-sep" />
          <Row dense role="menuitem" onClick={onNewLane}>
            new lane…
          </Row>
        </>
      )}
    </Popover>
  );
}

/**
 * No card left: every chat moved past this visit (or none at all). What is still running, what rests (Next rested it,
 * core/attention/rest.ts) with the way to go through those, and what this visit did. In a lane, also how many cards
 * wait in the other lanes and the way back to everything (R20).
 */
export function CaughtUp({
  items,
  decided,
  replies,
  resting = 0,
  onResting,
  others = 0,
  onEverything,
}: {
  items: AttentionItem[];
  decided: Decision[];
  replies: number;
  /** Cards Next has rested, not due back yet. */
  resting?: number;
  onResting?: () => void;
  /** Cards needing the person in other lanes (R14); 0 in Everything. */
  others?: number;
  /** Back to Everything; given only while a lane is on. */
  onEverything?: () => void;
}) {
  const quiet = othersLine(others);
  const running = items.filter((i) => i.status === "running").length;
  return (
    <Empty card title={resting > 0 ? "You're caught up." : decided.length ? "You've been through every chat." : "Nothing in Flow."}>
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
      {onEverything && (
        <div className="loki-meta loki-meta--wrap" style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {quiet && <span>{quiet}</span>}
          <Button bare size="sm" tone="brass" onClick={onEverything}>
            back to everything
          </Button>
        </div>
      )}
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
        title={main ? "a main chat cannot be archived" : "done with this chat: it leaves Flow"}
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
  const mail = o?.provider === "gmail";
  const label = mail ? ` · ${keyFor("inbox.label")} label` : "";
  // A mail sends on ⌘Enter and is held for its undo (plan 076); ⇧R and F switch it to the sender alone or to a forward.
  const outside = typing
    ? `${mail ? `${formatKeys("cmd+enter")} send, then read · ${formatKeys("cmd+shift+c")} recipients` : "enter send, then read"} · ${moves} (a reply goes first) · esc back to the deck's keys`
    : `${moves}${label} · ${keyFor("inbox.reply")} reply${mail ? ` · ${keyFor("inbox.reply_sender")} reply to sender · ${keyFor("inbox.forward")} forward` : ""} · ${deckKey("inbox.undo", false)} undo · esc close`;
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
