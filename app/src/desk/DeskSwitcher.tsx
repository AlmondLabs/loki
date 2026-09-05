import { useEffect, useMemo, useRef, useState } from "react";
import type { Scope } from "../../../shared/desk-core.ts";
import type { DeskSummary } from "./useDesk";
import { AgentChip } from "./AgentChip";

/**
 * ⌘K / Ctrl+K: jump to another conversation's desk from the canvas. Type to
 * filter by title or id, arrows to move, Enter to switch, Esc to close.
 */
export function DeskSwitcher({
  open,
  onClose,
  desks,
  current,
  onSwitch,
}: {
  open: boolean;
  onClose: () => void;
  desks: DeskSummary[];
  current: Scope;
  onSwitch: (scope: Scope) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live desks, then archived, then deleted, each under a divider. The filter also matches the group words.
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return desks.filter((d) => !q || (d.title ?? "").toLowerCase().includes(q) || d.scope.toLowerCase().includes(q) || d.status.includes(q));
  }, [desks, query]);
  const groupLabel = (s: DeskSummary["status"]) => (s === "archived" ? "archived" : s === "deleted" ? "deleted conversation — files remain on disk" : null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (index >= items.length) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  if (!open) return null;

  const choose = (d: DeskSummary | undefined) => {
    if (!d) return;
    onClose();
    if (d.scope !== current) onSwitch(d.scope);
  };

  const when = (iso: string | null) => {
    if (!iso) return "";
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  };

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)", display: "grid", placeItems: "start center", paddingTop: "12vh", zIndex: 200000 }}
    >
      <div
        style={{
          width: 480,
          maxWidth: "90vw",
          background: "var(--loci-panel)",
          border: "1px solid var(--loci-border)",
          borderRadius: 12,
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="switch desk…"
          aria-label="switch desk"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "12px 14px",
            fontSize: 14,
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--loci-border)",
            color: "var(--loci-fg)",
            outline: "none",
          }}
        />
        <div role="listbox" aria-label="desks" style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
          {items.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "var(--loci-muted)" }}>no desks match</div>}
          {items.map((d, i) => (
            <div key={d.scope}>
              {groupLabel(d.status) && (i === 0 || items[i - 1].status !== d.status) && (
                <div style={{ padding: "10px 10px 4px", fontSize: 10, letterSpacing: "0.1em", color: d.status === "deleted" ? "var(--loci-negative)" : "var(--loci-muted)", fontFamily: "var(--loci-mono)" }}>
                  {groupLabel(d.status)}
                </div>
              )}
            <div
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(d)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                background: i === index ? "var(--loci-accent-soft)" : "transparent",
                opacity: d.status === "archived" || d.status === "deleted" ? 0.7 : 1,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                <span style={{ fontFamily: "var(--loci-display)", fontSize: 14, color: "var(--loci-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.title ?? d.scope}
                  {d.agentName && <span style={{ marginLeft: 8, display: "inline-flex", verticalAlign: "middle" }}><AgentChip name={d.agentName} size={10} /></span>}
                  {d.scope === current && <span style={{ color: "var(--loci-muted)", marginLeft: 8, fontSize: 11 }}>· here</span>}
                  {d.active && d.scope !== current && <span style={{ color: "var(--loci-accent)", marginLeft: 8, fontSize: 11 }}>· active</span>}
                </span>
                {d.title && d.title !== d.scope && (
                  <span style={{ fontSize: 10, color: "var(--loci-muted)", fontFamily: "var(--loci-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.scope}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 11, color: "var(--loci-muted)", fontFamily: "var(--loci-mono)", whiteSpace: "nowrap" }}>
                {d.widgets} {d.widgets === 1 ? "widget" : "widgets"}
                {d.lastActive ? ` · ${when(d.lastActive)}` : ""}
              </span>
            </div>
            </div>
          ))}
        </div>
        <div style={{ padding: "6px 12px", fontSize: 10, color: "var(--loci-muted)", borderTop: "1px solid var(--loci-border)", letterSpacing: "0.06em" }}>
          ↑↓ move · ↵ switch · esc close
        </div>
      </div>
    </div>
  );
}
