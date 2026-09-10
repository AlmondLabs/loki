import type { SlashCommand } from "../../../core/attention/commands.ts";
import { Meta, Popover, Row } from "../components";

/**
 * The commands the box can run, hung above it while a "/name" is being typed: the name, its argument
 * hint, what it does, and where it runs. The box keeps focus and the keys; ↑↓ move the highlight
 * here, ↵ runs (or fills in a command that takes arguments), ⇥ fills in, esc puts the palette away.
 */
export function SlashPalette({ matches, index, listId, onHover, onPick }: { matches: SlashCommand[]; index: number; listId: string; onHover: (i: number) => void; onPick: (c: SlashCommand) => void }) {
  return (
    <Popover role="presentation" width={420} style={{ top: "auto", bottom: "calc(100% + 6px)", left: 12, maxWidth: "calc(100% - 24px)" }}>
      <div id={listId} role="listbox" aria-label="commands" style={{ maxHeight: 260, overflowY: "auto", padding: 4 }}>
        {matches.map((c, i) => (
          <Row key={c.id} dense id={`${listId}-opt-${i}`} role="option" tabIndex={-1} data-index={i} aria-selected={i === index} onMouseEnter={() => onHover(i)} onClick={() => onPick(c)} style={{ alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)", whiteSpace: "nowrap" }}>
              /{c.id}
              {c.args && <span style={{ color: "var(--loki-muted)", marginLeft: 6 }}>{c.args}</span>}
            </span>
            <span style={{ fontSize: 11, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{c.description}</span>
            <span style={{ fontSize: 9.5, color: "var(--loki-muted)", marginLeft: "auto", whiteSpace: "nowrap", opacity: 0.8 }}>{c.where === "loki" ? "loki" : "letta"}</span>
          </Row>
        ))}
        {matches.length === 0 && <div role="status" style={{ padding: 10, fontSize: 12, color: "var(--loki-muted)" }}>no command matches — ↵ sends it as a message</div>}
      </div>
      <div role="presentation" style={{ padding: "5px 10px", borderTop: "1px solid var(--loki-border)" }}>
        <Meta>↑↓ move · ↵ run · ⇥ fill in · esc</Meta>
      </div>
    </Popover>
  );
}
