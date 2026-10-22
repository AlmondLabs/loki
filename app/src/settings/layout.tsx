import { useState } from "react";
import { Button, sentence } from "../components";

/**
 * One fact on a Preferences page, on the template's row: its name on the left, the value on the right (mono for paths
 * and ids). A Setting is for something you change; a Fact is for something loki reports.
 */
export function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 24, padding: "12px 0" }}>
      <div style={{ flex: "none", minWidth: 120, fontSize: 13.5, fontWeight: 600, color: "var(--loki-fg)" }}>{label}</div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "right",
          color: "var(--loki-fg)",
          fontFamily: mono ? "var(--loki-mono)" : undefined,
          fontSize: mono ? 12 : 13.5,
          lineHeight: 1.5,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---- The page template (plan 031) ----------------------------------------------------------------

/**
 * A part of a Preferences page: an optional heading, and a line on what the part is for, over its settings, each
 * divided from the next by a hairline.
 */
export function Block({ title, help, children }: { title?: string; help?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid" }}>
      {title && (
        <h4 className="loki-title" style={{ margin: 0, fontSize: 15 }}>
          {title}
        </h4>
      )}
      {help && (
        <div className="loki-meta loki-meta--wrap" style={{ marginTop: 2, lineHeight: 1.45 }}>
          {sentence(help)}
        </div>
      )}
      <div className="loki-settings-block">{children}</div>
    </section>
  );
}

/** One setting: its name, and its help in muted type under it, on the left; its control on the right. A mono name is an id (a tool's). */
export function Setting({ label, help, mono = false, children }: { label: string; help?: React.ReactNode; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "12px 0", minHeight: 32 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={
            mono
              ? { fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)", overflowWrap: "anywhere" }
              : { fontSize: 13.5, fontWeight: 600, color: "var(--loki-fg)" }
          }
        >
          {label}
        </div>
        {help && (
          <div className="loki-meta loki-meta--wrap" style={{ marginTop: 2, lineHeight: 1.45 }}>
            {help}
          </div>
        )}
      </div>
      {children !== undefined && <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8 }}>{children}</div>}
    </div>
  );
}

/** Two to four named values, one chosen, side by side in one track: a setting with a few values. */
export function Segmented<T extends string>({
  options,
  value,
  onPick,
  labels = {},
  label,
}: {
  options: readonly T[];
  value: T;
  onPick: (v: T) => void;
  labels?: Partial<Record<T, string>>;
  /** What is being chosen, for a screen reader. */
  label: string;
}) {
  return (
    <span role="group" aria-label={label} className="loki-segmented">
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onPick(o)}>
          {labels[o] ?? o}
        </button>
      ))}
    </span>
  );
}

/** A Block folded shut until asked: reference a page keeps for when it is wanted (how the Inbox orders, where files are). */
export function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section style={{ display: "grid" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h4 className="loki-title" style={{ margin: 0, fontSize: 15, flex: 1 }}>
          {title}
        </h4>
        <Button size="sm" bare onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "hide" : "show"}
        </Button>
      </div>
      {open && <div className="loki-settings-block">{children}</div>}
    </section>
  );
}
