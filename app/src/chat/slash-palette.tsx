import type { SlashCommand } from "../../../core/attention/commands.ts";
import { Row, sentence } from "../components";
import { keyboard, type Platform } from "../desk/env";
import { formatKeys, keyFor } from "../shell/keymap";

export function commandText(c: SlashCommand, os: Platform = keyboard): string {
  return c.withKey && c.action ? `${c.description} (${keyFor(c.action, os)})` : c.description;
}

export function SlashPalette({
  matches,
  index,
  listId,
  onHover,
  onPick,
}: {
  matches: SlashCommand[];
  index: number;
  listId: string;
  onHover: (i: number) => void;
  onPick: (c: SlashCommand) => void;
}) {
  return (
    <div
      role="presentation"
      className="loki-popover loki-popover--above"
      style={{ left: 12, width: 420, maxWidth: "calc(100% - 24px)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div id={listId} role="listbox" aria-label="Commands" style={{ maxHeight: 260, overflowY: "auto", padding: 4 }}>
        {matches.map((c, i) => (
          <Row
            key={c.id}
            dense
            id={`${listId}-opt-${i}`}
            role="option"
            tabIndex={-1}
            data-index={i}
            aria-selected={i === index}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(c)}
            style={{ alignItems: "baseline", gap: 8 }}
          >
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--loki-fg)",
                whiteSpace: "nowrap",
              }}
            >
              /{c.id}
              {c.args && <span style={{ color: "var(--loki-muted)", marginLeft: 4 }}>{c.args}</span>}
            </span>
            <span className="loki-meta loki-truncate">{sentence(commandText(c))}</span>
            <span className="loki-meta shrink-0" style={{ marginLeft: "auto" }}>
              {c.where === "loki" ? "loki" : "agent"}
            </span>
          </Row>
        ))}
        {matches.length === 0 && (
          <div role="status" className="loki-meta loki-meta--wrap" style={{ padding: 8 }}>
            {`No command matches. ${formatKeys("enter")} sends it as a message.`}
          </div>
        )}
      </div>
    </div>
  );
}
