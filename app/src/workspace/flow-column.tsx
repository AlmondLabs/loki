import type { AttentionItem } from "../../../core/attention/model.ts";
import type { AccountProvider } from "../../../core/frame-types.ts";
import { agentLanes, laneItems, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { catchUpQueue, idOf } from "../../../core/attention/queue.ts";
import { HashIcon, InboxIcon, MailIcon, MessagesSquareIcon, TicketIcon } from "lucide-react";
import { ListIcon } from "../components";
import type { FilterPill } from "../shell/filter-pills";
import { offeredKinds, type FlowKind } from "./flow-kinds";
import type { IconName } from "../shared/icons";
import type { ContentRow } from "../shell/content-list";
import type { PlaceSources } from "../shell/sidebar";
import { ago } from "./catch-up-parts";
import { senderName } from "./mail-thread";
import { mendLabel, outsideTitle } from "./outside-words";

export interface FlowLaneRow {
  id: string;
  lane: ResolvedLane | null;
  name: string;
  icon: IconName;
  count: number;
}

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

export function flowSources(
  items: AttentionItem[],
  lane: ResolvedLane | null,
  lanes: readonly Lane[] | null,
  onLane: (lane: ResolvedLane | null) => void,
): PlaceSources {
  const need = (l: ResolvedLane | null) => catchUpQueue(laneItems(items, l)).length;
  const rows: FlowLaneRow[] = [
    { id: "", lane: null, name: "Everything", icon: "inbox", count: need(null) },
    ...(lanes ?? []).map((l): FlowLaneRow => ({ id: l.id, lane: l, name: l.name, icon: "filter", count: need(l) })),
  ];
  return {
    items: rows.map((r) => ({ id: r.id, title: r.name, icon: r.icon, count: r.count })),
    selected: lane?.id ?? "",
    onSelect: (id) => onLane(rows.find((r) => r.id === id)?.lane ?? null),
  };
}

const KIND_ICON: Record<AccountProvider, IconName> = { gmail: "mail", slack: "hash", jira: "ticket" };

const KIND_PILL: Record<FlowKind, Omit<FilterPill<FlowKind>, "value">> = {
  all: { label: "All", icon: InboxIcon },
  chat: { label: "Chats", icon: MessagesSquareIcon },
  gmail: { label: "Mail", icon: MailIcon },
  slack: { label: "Slack", icon: HashIcon },
  jira: { label: "Jira", icon: TicketIcon },
};

export function kindPills(items: readonly AttentionItem[], chosen: FlowKind): Array<FilterPill<FlowKind>> {
  return offeredKinds(items, chosen).map((value) => ({ value, ...KIND_PILL[value] }));
}

const firstLine = (text: string | null | undefined) =>
  (text ?? "")
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

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
          <span className="loki-flow-row-line">{line || "\u00a0"}</span>
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
