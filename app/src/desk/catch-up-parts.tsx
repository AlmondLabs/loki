import { ArchiveIcon, ClockIcon, MailOpenIcon, PlusIcon } from "lucide-react";
import { ToolbarGroup, ToolbarTitle } from "../item/toolbar";
import { Fragment, useEffect, useRef, useState } from "react";
import { type AttentionItem, type AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, type Decision } from "../../../core/attention/queue.ts";
import { agentLanes, type AgentLane, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, Empty, Meta, Popover } from "../components";
import { chipText } from "../chat/suggestion-card";
import { keyboard } from "./env";
import { keyFor } from "../shell/keymap";
import { popUpMenu, under, NATIVE_MENUS, type MenuEntry } from "../shell/native-menu";
import { MenuItems, menuKey, menuRows } from "../shell/menu-items";
import { chatItem, type ItemProperty } from "../item/item-view";

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

/** Flow's title as its switcher says it (R11): "Flow" in Everything, "Flow · Work" in a lane, the name as it was typed. */
export const laneTitle = (lane: ResolvedLane | null): string => (lane ? `Flow · ${lane.name}` : "Flow");

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
 * Flow's toolbar, the chat's anatomy (plan 2026-11-14-1300, 3): the lane's name over a grey line of what needs you, how
 * many chats are in the lane and, while a lane is on, the quiet count waiting in the others (R14). The name opens the
 * lane menu, the same list as the sidebar's, for when the sidebar is folded. A chat stays until it is archived, so
 * there is no pass to count down and no progress bar; the counts follow the live list.
 */
export function DeckHeader({ needYou, chats, others, ...lane }: LaneSwitchProps & { needYou: number; chats: number; others: number }) {
  const quiet = othersLine(others);
  const facts: ItemProperty[] = [
    { key: "status", label: `${needYou} need you`, editable: false, ...(needYou > 0 ? { tone: "attention" as const } : {}) },
    { key: "status", label: `${chats} ${chats === 1 ? "chat" : "chats"}`, editable: false },
    ...(quiet ? [{ key: "status" as const, label: quiet, editable: false }] : []),
  ];
  return (
    <header className="loki-pane-header loki-deck-header">
      <div className="loki-pane-header-line" data-tauri-drag-region="deep">
        <ToolbarTitle title={laneTitle(lane.lane)} menu={<LaneSwitch {...lane} />} facts={facts} titleAs="h1" />
      </div>
      {/* No symbols of its own; the side keeps the Update button's room, as every toolbar's does (PaneHeader). */}
      <div className="loki-pane-header-trailing" />
    </header>
  );
}

/** Flow's title as a menu button (R11, plan 087 U6): it names the lane, and opens the menu that switches it. */
function LaneSwitch({ onLane, onNewLane, ...props }: LaneSwitchProps) {
  const [open, setOpen] = useState(false);
  const native = NATIVE_MENUS;
  const close = () => setOpen(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="loki-toolbar-open"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch lane"
        onClick={(e) => {
          // In the Mac app the system's menu hangs from the title (U19).
          if (native)
            void popUpMenu(laneMenuEntries({ ...props, onPick: onLane, onNewLane }), under(e.currentTarget)).catch((err: unknown) =>
              console.warn("loki: lane menu", err),
            );
          else setOpen((v) => !v);
        }}
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "baseline", gap: 4 }}
      >
        {laneTitle(props.lane)}
        <span aria-hidden style={{ fontSize: "var(--loki-text-micro)" }}>
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

/** What the lane menu offers (U19): Everything, the person's lanes, each agent's lane with its count, then New Lane…. */
export function laneMenuEntries({
  lane,
  lanes,
  items,
  onPick,
  onNewLane,
}: Pick<LaneSwitchProps, "lane" | "lanes" | "items" | "onNewLane"> & { onPick: (lane: ResolvedLane | null) => void }): MenuEntry[] {
  const activeId = lane?.id ?? "";
  const agents = listedAgentLanes(items, lane);
  return [
    { type: "item", id: "everything", label: "Everything", checked: activeId === "", run: () => onPick(null) },
    ...(lanes ?? []).map((l): MenuEntry => ({ type: "item", id: `lane-${l.id}`, label: l.name, checked: l.id === activeId, run: () => onPick(l) })),
    { type: "separator" },
    ...agents.map((l): MenuEntry => ({
      type: "item",
      id: `lane-${l.id}`,
      label: l.name,
      detail: String(l.count),
      checked: l.id === activeId,
      run: () => onPick(l),
    })),
    ...(onNewLane ? [{ type: "separator" } as const, { type: "item", id: "new-lane", label: "New Lane…", icon: PlusIcon, run: onNewLane } as const] : []),
  ];
}

/**
 * The lane menu drawn under Flow's title where no native menu pops up: laneMenuEntries. ↑↓ move, Enter picks, Esc or
 * a press outside closes. Every key stays in the menu, so a letter meant for it never moves the card under it.
 */
export function LaneMenu({ onClose, ...props }: Omit<LaneSwitchProps, "onLane"> & { onPick: (lane: ResolvedLane | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const menu = ref.current;
    const anchor = menu?.parentElement ?? null;
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menuRows(menu).at(0))?.focus();
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
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label="Lanes"
      width={240}
      // It hangs from the title's own small wrapper, so the popover's usual cap (its parent's width) would crush it.
      style={{ padding: 4, maxWidth: "none" }}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        e.stopPropagation();
        menuKey(e, ref.current, onClose);
      }}
    >
      <MenuItems entries={laneMenuEntries(props)} onPicked={() => {}} />
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
              Go Through Them
            </Button>
          )}
        </div>
      )}
      {(decided.length > 0 || replies > 0) && (
        <div style={{ fontSize: "var(--loki-text-meta)", color: "var(--loki-fg)", marginTop: 10, fontWeight: 600 }}>{passSummary(decided, replies)}</div>
      )}
      <div className="loki-meta loki-meta--wrap" style={{ marginTop: 6 }}>
        Anything new lands here while this stays open
      </div>
      {onEverything && (
        <div className="loki-meta loki-meta--wrap" style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {quiet && <span>{quiet}</span>}
          <Button bare size="sm" tone="brass" onClick={onEverything}>
            Back to Everything
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

/**
 * A chat card's header as a toolbar (plan 097, U8; plan 2026-11-12-1505, U16): the chat's name over a grey line of its
 * agent, state, folder and labels, then when and why, and the one-off line it flashes; its moves are the toolbar's
 * group rather than a row under the box.
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
  moves: Parameters<typeof CardActions>[0];
}) {
  const view = chatItem({ item: current, live: null, turns: [] }).header;
  const main = current.id === "default";
  const open = () => (moves.onOpenDesk(current.agent_id, current.id), moves.onClose());
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
      <ToolbarGroup
        label="Chat actions"
        moves={[
          { label: "Later", icon: <ClockIcon aria-hidden />, title: `Later (${deckKey("inbox.later", moves.typing)})`, run: moves.later },
          { label: "Mark as Read", icon: <MailOpenIcon aria-hidden />, title: `Mark as Read (${deckKey("inbox.next", moves.typing)})`, run: moves.read },
          {
            label: "Archive",
            icon: <ArchiveIcon aria-hidden />,
            title: main ? "A main chat cannot be archived" : `Archive (${deckKey("inbox.archive", moves.typing)})`,
            disabled: main,
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
        Open Chat
      </Button>
      <Button
        size="sm"
        onClick={archive}
        disabled={main}
        title={main ? "A main chat cannot be archived" : "Done with this chat: it leaves Flow"}
        kbd={deckKey("inbox.archive", typing)}
      >
        Archive
      </Button>
      <span style={{ flex: 1 }} />
      <Button
        size="sm"
        onClick={later}
        title="Keep it unread: the chat comes back in a day, or sooner if something new arrives"
        kbd={deckKey("inbox.later", typing)}
      >
        Later
      </Button>
      <Button size="sm" tone="paper" onClick={read} title="Mark it read: the chat rests and comes back later" kbd={deckKey("inbox.next", typing)}>
        Mark as Read
      </Button>
    </>
  );
}

/** How many chats need you right now, whatever this visit has decided. */
export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

/** True when this chat was already moved past in this visit and has come back with something new; a label moves nothing past. */
export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => d.action !== "label" && idOf(d.item) === idOf(current));
