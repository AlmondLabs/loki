import type { AttentionItem } from "../../../core/attention/model.ts";
import type { ResolvedLane } from "../../../core/attention/lanes.ts";
import type { FlowLane } from "../../../core/attention/use-attention.ts";
import { Button, Sheet, sentence } from "../components";
import { Icon } from "./icons";
import { laneChoices } from "./deck";

export function LaneTitle({ lane, onOpen }: { lane: ResolvedLane | null; onOpen: () => void }) {
  const name = lane ? sentence(lane.name) : "Flow";
  return (
    <button type="button" className="loki-phone-lane-title" aria-haspopup="dialog" aria-label={`${name}, choose a lane`} onClick={onOpen}>
      <span className="loki-phone-lane-title-name">{name}</span>
      <Icon name="chevron-down" size={18} />
    </button>
  );
}

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
