import { Icon } from "../shared/icons";
import { osWords } from "./os-words";
import { homeMark } from "./sidebar-model";

export function HomeMark({
  row,
  agentHome,
  here,
}: {
  row: { home?: string; home_name?: string; reachable?: boolean };
  agentHome?: string | null;
  here?: string;
}) {
  const mark = homeMark(row, agentHome, here, osWords().machine);
  if (!mark) return null;
  return (
    <span className="loki-meta inline-flex" title={mark.note} style={{ flexShrink: 0 }}>
      <Icon name={mark.kind === "asleep" ? "moon" : "laptop"} size={12} title={mark.note} />
    </span>
  );
}
