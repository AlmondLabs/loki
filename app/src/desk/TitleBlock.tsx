import { AgentChip } from "./AgentChip";
import type { DeskStatus } from "./useDesk";

const STATUS: Record<DeskStatus, { label: string; color: string }> = {
  live: { label: "live", color: "var(--loci-positive)" },
  archived: { label: "archived", color: "var(--loci-muted)" },
  deleted: { label: "deleted", color: "var(--loci-negative)" },
  none: { label: "—", color: "var(--loci-muted)" },
};

/** "1:1" at 100 %, "1:2" zoomed out to half, "2:1" zoomed in. Whole ratios only, like a drawing scale. */
export function drawingScale(scale: number): string {
  if (Math.abs(scale - 1) < 0.05) return "1:1";
  if (scale < 1) return `1:${(1 / scale).toFixed(1).replace(/\.0$/, "")}`;
  return `${scale.toFixed(1).replace(/\.0$/, "")}:1`;
}

/**
 * Drafting title block, top-right of the sheet: what this desk is, who drew it,
 * whether the conversation is still open, and the drawing scale. Every cell is
 * a fact about the desk; clicking it opens the desk switcher.
 */
export function TitleBlock({
  title,
  scope,
  status,
  agentName,
  scale,
  onOpenSwitcher,
}: {
  title: string | null;
  scope: string;
  status: DeskStatus;
  agentName: string | null;
  scale: number;
  onOpenSwitcher: () => void;
}) {
  const st = STATUS[status];
  return (
    <div
      role="group"
      aria-label="desk title block"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        alignItems: "stretch",
        border: "1px solid var(--loci-border)",
        background: "var(--loci-panel)",
        color: "var(--loci-fg)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
      }}
    >
      <Cell label="desk" onClick={onOpenSwitcher} title="switch desk (⌘K)" ariaLabel="switch desk" grow first>
        <span style={{ fontFamily: "var(--loci-display)", fontSize: 15, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 360 }}>
          {title ?? scope}
        </span>
      </Cell>
      <Cell label="drawn by" onClick={onOpenSwitcher}>
        {agentName ? <AgentChip name={agentName} /> : <span style={{ color: "var(--loci-muted)" }}>—</span>}
      </Cell>
      <Cell label="status" onClick={onOpenSwitcher}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: st.color, fontFamily: "var(--loci-label)", fontSize: 12, letterSpacing: "0.08em" }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: st.color }} />
          {st.label}
        </span>
      </Cell>
      <Cell label="scale">
        <span data-scale style={{ fontFamily: "var(--loci-mono)", fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 34, display: "inline-block" }}>{drawingScale(scale)}</span>
      </Cell>
    </div>
  );
}

function Cell({
  label,
  children,
  onClick,
  title,
  ariaLabel,
  grow = false,
  first = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  ariaLabel?: string;
  grow?: boolean;
  first?: boolean;
}) {
  const inner = (
    <>
      <span className="loci-label" style={{ fontSize: 9, letterSpacing: "0.16em" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", minHeight: 18 }}>{children}</span>
    </>
  );
  const base: React.CSSProperties = {
    display: "grid",
    gap: 3,
    padding: "6px 12px 7px",
    borderLeft: first ? "none" : "1px solid var(--loci-border)",
    minWidth: 0,
    flex: grow ? "0 1 auto" : "0 0 auto",
    textAlign: "left",
    color: "inherit",
    background: "transparent",
    font: "inherit",
  };
  if (!onClick) return <div style={{ ...base }}>{inner}</div>;
  return (
    <button onClick={onClick} title={title} aria-label={ariaLabel} style={{ ...base, border: "none", borderLeft: first ? "none" : "1px solid var(--loci-border)", cursor: "pointer" }} className="loci-cell">
      {inner}
    </button>
  );
}

/** A small plate for a sheet-level action, sitting beside the title block. */
export function Plate({ children, onClick, title, ariaLabel, accent = false }: { children: React.ReactNode; onClick: () => void; title?: string; ariaLabel?: string; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={ariaLabel}
      className="loci-label loci-plate"
      style={{
        color: accent ? "var(--loci-accent)" : "var(--loci-muted)",
        background: accent ? "var(--loci-brass-soft)" : "var(--loci-panel)",
        border: `1px solid ${accent ? "var(--loci-accent)" : "var(--loci-border)"}`,
        padding: "7px 12px 8px",
        cursor: "pointer",
        fontSize: 11,
        boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
