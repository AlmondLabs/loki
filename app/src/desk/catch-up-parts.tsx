import { ArchiveIcon, CheckIcon, ClockIcon, MailOpenIcon, XIcon } from "lucide-react";
import { ToolbarGroup, ToolbarTitle, type ToolbarMove } from "../item/toolbar";
import { Fragment } from "react";
import { type AttentionItem, type AttentionStatus } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, type Decision } from "../../../core/attention/queue.ts";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { Button, Chip, EmptyPane, LeadRoom, Meta } from "../components";
import { chipText } from "../chat/suggestion-card";
import { keyboard } from "./env";
import { keyFor } from "../shell/keymap";
import { chatItem } from "../item/item-view";
import { isMainChat } from "../../../core/desk-core.ts";

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

const othersLine = (others: number) => (others > 0 ? `${others} waiting in other lanes` : "");

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
  others?: number;
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

const NOTED = { color: "var(--loki-fg)", fontWeight: 600 } as const;

interface ChatCardFacts {
  current: AttentionItem;
  cameBack: boolean;
  suggestions?: number;
  onSuggestions?: () => void;
}

export function ChatCardMeta({ current, cameBack, suggestions, onSuggestions }: ChatCardFacts) {
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

export interface ChatMoves {
  current: AttentionItem;
  typing: boolean;
  read: () => void;
  later: () => void;
  archive: () => void;
  approve?: (behavior: "allow" | "deny") => void;
  off?: boolean;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onClose: () => void;
}

export function ChatItemHeader({
  current,
  cameBack,
  flash,
  suggestions = 0,
  onSuggestions,
  moves,
}: ChatCardFacts & {
  flash: string | null;
  moves: ChatMoves;
}) {
  const view = chatItem({ item: current, live: null, turns: [] }).header;
  const main = isMainChat(current.id);
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
      <LeadRoom />
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

export function deckKey(id: string, typing: boolean): string {
  return keyFor(id, keyboard, typing ? 0 : 1);
}

export const liveWaitingCount = (items: AttentionItem[]) => catchUpQueue(items).length;

export const cameBackIn = (decided: Decision[], current: AttentionItem) => decided.some((d) => d.action !== "label" && idOf(d.item) === idOf(current));
