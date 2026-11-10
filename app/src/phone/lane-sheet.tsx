import type { AttentionItem } from "../../../core/attention/model.ts";
import type { ResolvedLane } from "../../../core/attention/lanes.ts";
import type { FlowLane } from "../../../core/attention/use-attention.ts";
import { Button, Sheet, sentence } from "../components";
import { Icon } from "./icons";
import { laneChoices } from "./deck";

/**
 * Flow's title on the phone (plan 085, R11): the active lane's name, "Flow" in Everything, as a button that opens the
 * lane sheet.
 */
export function LaneTitle({ lane, onOpen }: { lane: ResolvedLane | null; onOpen: () => void }) {
  const name = lane ? sentence(lane.name) : "Flow";
  return (
    <button type="button" className="loki-phone-lane-title" aria-haspopup="dialog" aria-label={`${name}, choose a lane`} onClick={onOpen}>
      <span className="loki-phone-lane-title-name">{name}</span>
      <Icon name="chevron-down" size={18} />
    </button>
  );
}

/**
 * The phone's lane sheet (plan 085, U7), opened from Flow's title: Everything, the person's lanes, then a built-in lane
 * for each agent with cards, in sentence case. A pick switches this phone's lane only (R10); lanes are made on a Mac,
 * so there is no entry for a new one (R8). Mounted only while open.
 */
export function LaneSheet({ flow, items, onClose }: { flow: FlowLane; items: AttentionItem[]; onClose: () => void }) {
  return (
    <Sheet label="Choose a lane" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-title">Lanes</div>
      <div role="radiogroup" aria-label="Lanes">
        {laneChoices(flow.lanes, items).map((c) => {
          const chosen = c.id === (flow.lane?.id ?? "");
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={chosen}
              className="loki-phone-menu-row"
              onClick={() => {
                flow.setLaneId(c.id);
                onClose();
              }}
            >
              <span className="loki-phone-menu-row-label">{sentence(c.name)}</span>
              {chosen && <Icon name="check" size={20} />}
            </button>
          );
        })}
      </div>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}
