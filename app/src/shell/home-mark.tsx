import { Icon } from "../shared/icons";
import { osWords } from "./os-words";
import { homeMark } from "./sidebar-model";

/**
 * Where a chat lives, as one small icon in its list row (plan 023, sidebar-model.ts homeMark): a laptop for a chat
 * living away from its agent's Mac, a moon while its Mac is asleep or off, and the words in its tooltip.
 */
export function HomeMark({
  row,
  agentHome,
  here,
}: {
  row: { home?: string; home_name?: string; reachable?: boolean };
  /** The Mac the chat's agent lives on, when Macs are paired. */
  agentHome?: string | null;
  /** This Mac's id, with `agentHome`. */
  here?: string;
}) {
  const mark = homeMark(row, agentHome, here, osWords().machine);
  if (!mark) return null;
  return (
    <span className="loki-meta" title={mark.note} style={{ display: "inline-flex", flexShrink: 0 }}>
      <Icon name={mark.kind === "asleep" ? "moon" : "laptop"} size={12} title={mark.note} />
    </span>
  );
}
