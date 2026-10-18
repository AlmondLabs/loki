import { homeNote } from "../../../core/desk-core.ts";
import { Icon } from "../shared/icons";

/**
 * Where a chat lives, as one small icon in its list row (plan 023): a laptop for a chat on another Mac in reach, a
 * broken link while that Mac is out of reach, and the words in its tooltip. Nothing for this Mac's own chats.
 */
export function HomeMark({ row }: { row: { home?: string; home_name?: string; reachable?: boolean } }) {
  const note = homeNote(row);
  if (!note) return null;
  return (
    <span className="loki-meta" title={note} style={{ display: "inline-flex", flexShrink: 0 }}>
      <Icon name={row.reachable === false ? "unlink" : "laptop"} size={12} title={note} />
    </span>
  );
}
