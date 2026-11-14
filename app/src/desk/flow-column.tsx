import type { AttentionItem } from "../../../core/attention/model.ts";
import { agentLanes, laneItems, type Lane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { IconButton, ListIcon, ListRow } from "../components";
import { Icon, type IconName } from "../shared/icons";
import { ColumnHeader } from "../shell/list-column";

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
 * Flow's lanes as sidebar rows (plan 2026-11-14-1130, 1), the same list as the title's menu (laneMenuEntries):
 * Everything, the person's lanes, then each agent with cards, busiest first, and the active agent lane even once its
 * cards are cleared, so the person sees where they are. Every count is the cards that need the person, as the badge's.
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
 * Flow's sidebar (plan 2026-11-14-1130, 1): its lanes as rows with what needs you in each, as Mail lists its mailboxes,
 * the active one chosen; choosing a row switches the lane, as the title's menu does. New Lane… opens Preferences › Flow.
 */
export function FlowColumn({
  items,
  lane,
  lanes,
  onLane,
  onNewLane,
}: {
  items: AttentionItem[];
  lane: ResolvedLane | null;
  lanes: readonly Lane[] | null;
  onLane: (lane: ResolvedLane | null) => void;
  onNewLane?: () => void;
}) {
  const active = lane?.id ?? "";
  return (
    <>
      <ColumnHeader
        title="Lanes"
        actions={
          onNewLane && (
            <IconButton label="New lane" title="New lane" onClick={onNewLane}>
              <Icon name="plus" size={16} />
            </IconButton>
          )
        }
      />
      <div className="loki-column-scroll">
        {/* One heading, the column's: a section heading under it would say "Lanes" twice. */}
        <ul className="loki-list" aria-label="Lanes">
          {flowLanes(items, lane, lanes).map((row) => (
            <ListRow
              key={row.id || "everything"}
              lead={<ListIcon name={row.icon} />}
              title={row.name}
              time={row.count > 0 ? String(row.count) : null}
              label={`${row.name}, ${row.count} ${row.count === 1 ? "needs" : "need"} you`}
              current={row.id === active}
              onOpen={() => onLane(row.lane)}
            />
          ))}
        </ul>
      </div>
    </>
  );
}
