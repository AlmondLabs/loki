import type { AttentionItem } from "../../../core/attention/model.ts";
import { createSessionValue } from "../shared/session-value";
import { Icon } from "./icons";

export const FLOW_HINT_KEY = "loki.phone.flowHint";

export type HintState = "unseen" | "seen";

export function createFlowHint(storage: () => Storage = () => localStorage) {
  return createSessionValue<HintState>(FLOW_HINT_KEY, (raw) => (raw === "seen" ? "seen" : "unseen"), storage);
}

const flowHint = createFlowHint();

export function hintShows(state: HintState, item: AttentionItem | undefined): boolean {
  return state === "unseen" && !!item && !item.pendingApproval;
}

export function useFlowHint(item: AttentionItem | undefined): { shown: boolean; dismiss: () => void } {
  const [state, set] = flowHint.use();
  return { shown: hintShows(state, item), dismiss: () => set("seen") };
}

export function FlowHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="loki-phone-flow-hint" role="note">
      <span>Drag the reply box: right for Read, left for Later, up to Archive.</span>
      <button type="button" className="loki-phone-flow-hint-close" onClick={onDismiss} aria-label="Dismiss Hint">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
