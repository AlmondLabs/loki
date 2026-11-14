import type { ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { AccountProvider } from "../../../core/frame-types.ts";
import { agentLanes, laneItems, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { catchUpQueue, idOf } from "../../../core/attention/queue.ts";
import { ListIcon } from "../components";
import type { IconName } from "../shared/icons";
import type { ContentRow } from "../shell/content-list";
import type { PlaceSources } from "../shell/sidebar";
import { ago } from "./catch-up-parts";
import { senderName } from "./mail-thread";
import { mendLabel, outsideTitle } from "./outside-words";

/** One lane as the sidebar lists it: what choosing it switches to, its name, its kind's symbol and what in it needs you. */
export interface FlowLaneRow {
  /** "" for Everything, else the lane's id. */
  id: string;
  lane: ResolvedLane | null;
  name: string;
  icon: IconName;
  /** The cards in it that need the person: the Flow badge's count, narrowed to the lane. */
  count: number;
}

/**
 * Flow's lanes (plan 2026-11-14-1130, 1), as Mail lists its mailboxes: Everything, the person's lanes, then each agent
 * with cards, busiest first, and the active agent lane even once its cards are cleared, so the person sees where they
 * are. Every count is the cards that need the person, as the badge's.
 */
export function flowLanes(items: AttentionItem[], lane: ResolvedLane | null, lanes: readonly Lane[] | null): FlowLaneRow[] {
  const need = (l: ResolvedLane | null) => catchUpQueue(laneItems(items, l)).length;
  const agents = agentLanes(items);
  if (lane && "agent_id" in lane && !agents.some((l) => l.id === lane.id)) agents.push(lane);
  return [
    { id: "", lane: null, name: "Everything", icon: "inbox", count: need(null) },
    ...(lanes ?? []).map((l): FlowLaneRow => ({ id: l.id, lane: l, name: l.name, icon: "filter", count: need(l) })),
    ...agents.map((l): FlowLaneRow => ({ id: l.id, lane: l, name: l.name, icon: "person", count: need(l) })),
  ];
}

/**
 * Flow's lanes as its sources under its row in the sidebar (plan 2026-11-14-1330, U6): Flow's own row stands for
 * Everything, and the person's lanes and the agents' are listed under it, the active one chosen. Choosing one switches
 * the lane; `face` draws an agent lane's face in place of its symbol.
 */
export function flowSources(
  items: AttentionItem[],
  lane: ResolvedLane | null,
  lanes: readonly Lane[] | null,
  onLane: (lane: ResolvedLane | null) => void,
  face?: (agentId: string, name: string) => ReactNode,
): PlaceSources {
  const rows = flowLanes(items, lane, lanes);
  return {
    items: rows
      .filter((r) => r.id !== "")
      .map((r) => ({
        id: r.id,
        title: r.name,
        icon: r.icon,
        face: r.lane && "agent_id" in r.lane ? face?.(r.lane.agent_id, r.name) : undefined,
        count: r.count,
      })),
    selected: lane?.id ?? "",
    all: "",
    onSelect: (id) => onLane(rows.find((r) => r.id === id)?.lane ?? null),
  };
}

/** Each kind of outside card's symbol in the list: a mail, a Slack channel's sign, a ticket. */
const KIND_ICON: Record<AccountProvider, IconName> = { gmail: "mail", slack: "hash", jira: "ticket" };

/** A line of text's first line with words in it. */
const firstLine = (text: string | null | undefined) =>
  (text ?? "")
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

/**
 * The lane's cards as the list's rows (plan 2026-11-14-1330, U6), in the deck's order: who it is from (the sender, or
 * the chat's agent), what it is about (the subject, the channel, the ticket or the chat's name) and one line of the
 * newest words, with the kind's symbol at the start and, where the card's account needs mending, a muted "Sign In" mark.
 */
export function flowRows(queue: readonly AttentionItem[]): ContentRow[] {
  return queue.map((item): ContentRow => {
    const o = item.outside;
    const from = o ? senderName(o.sender) : (item.agent_name ?? "Chat");
    const about = o ? (o.provider === "slack" ? (o.place ?? "Direct message") : outsideTitle(o)) : item.title || "Chat";
    const line = o ? firstLine(o.lines.at(-1)) : firstLine(item.lastAssistantText);
    const mend = o?.disconnected ? mendLabel(o.disconnected, o.provider) : null;
    return {
      id: idOf(item),
      lead: <ListIcon name={o ? KIND_ICON[o.provider] : "desk"} />,
      title: from,
      preview: (
        <>
          <span className="loki-flow-row-subject">{about}</span>
          {line && <span className="loki-flow-row-line">{line}</span>}
        </>
      ),
      flags: mend && (
        <span className="loki-flow-row-mark" title={mend}>
          Sign In
        </span>
      ),
      time: ago(o ? o.newest_at : item.last_message_at),
      unread: item.unread,
    };
  });
}
