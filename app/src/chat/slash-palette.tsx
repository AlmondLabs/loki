import type { SlashCommand } from "../../../core/attention/commands.ts";
import { Popover, Row, sentence } from "../components";
import { keyboard, type Platform } from "../desk/env";
import { formatKeys, keyFor } from "../shell/keymap";

/** A command's line in the palette: its description, and its action's key when it asks for one (core names no keys). */
export function commandText(c: SlashCommand, os: Platform = keyboard): string {
  return c.withKey && c.action ? `${c.description} (${keyFor(c.action, os)})` : c.description;
}

/**
 * The commands the box can run, hung above it while a "/name" is being typed: the name, its argument
 * hint, what it does, and where it runs. The box keeps focus and the keys; ↑↓ move the highlight
 * here, ↵ runs (or fills in a command that takes arguments), ⇥ fills in, esc puts the palette away.
 * It reads as a Mac's completion list (plan 2026-11-12-1505, U20): the system font at menu sizes, and no line of key
 * hints under it, since the keys are the ones every such list has.
 */
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
    <Popover role="presentation" instant width={420} style={{ top: "auto", bottom: "calc(100% + 6px)", left: 12, maxWidth: "calc(100% - 24px)" }}>
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
                fontSize: "var(--loki-text-body)",
                color: "var(--loki-fg)",
                whiteSpace: "nowrap",
              }}
            >
              /{c.id}
              {c.args && <span style={{ color: "var(--loki-muted)", marginLeft: 6 }}>{c.args}</span>}
            </span>
            <span className="loki-truncate" style={{ fontSize: "var(--loki-text-tag)", color: "var(--loki-muted)" }}>
              {sentence(commandText(c))}
            </span>
            <span style={{ fontSize: "var(--loki-text-micro)", color: "var(--loki-muted)", marginLeft: "auto", whiteSpace: "nowrap", opacity: 0.8 }}>
              {c.where === "loki" ? "loki" : "agent"}
            </span>
          </Row>
        ))}
        {matches.length === 0 && (
          <div role="status" className="loki-meta loki-meta--wrap" style={{ padding: 10 }}>
            {`No command matches. ${formatKeys("enter")} sends it as a message.`}
          </div>
        )}
      </div>
    </Popover>
  );
}
