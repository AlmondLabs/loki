import { useEffect, useRef } from "react";

/**
 * The four permission modes the app-server knows, per conversation. Set with runtime_start { mode }
 * and persisted by Letta; read back from update_device_status (live) or the persisted map (the mod).
 */
export type PermissionMode = "strict" | "standard" | "acceptEdits" | "unrestricted";

export const MODES: Array<{ id: PermissionMode; label: string; short: string; description: string }> = [
  { id: "strict", label: "Strict", short: "strict", description: "asks before every tool, reads included" },
  { id: "standard", label: "Standard", short: "standard", description: "asks before edits and commands; reads run freely" },
  { id: "acceptEdits", label: "Accept edits", short: "edits ok", description: "file edits run without asking; commands still ask" },
  { id: "unrestricted", label: "Unrestricted", short: "no asking", description: "nothing asks — every tool runs" },
];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === "strict" || v === "standard" || v === "acceptEdits" || v === "unrestricted";
}

export const modeInfo = (m: PermissionMode | null | undefined) => MODES.find((x) => x.id === m) ?? MODES[3];

/** The chip: the mode's short name; brass when nothing will ask, so an open door is never quiet. */
export function ModeChip({ mode, onClick, busy }: { mode: PermissionMode | null; onClick: () => void; busy?: boolean }) {
  const info = modeInfo(mode);
  const loud = info.id === "unrestricted";
  return (
    <button
      onClick={onClick}
      title={`permissions: ${info.label} — ${info.description}. Click to change for this conversation`}
      aria-label="permission mode"
      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", border: `1px solid ${loud ? "var(--loki-accent)" : "var(--loki-border)"}`, borderRadius: 999, background: loud ? "var(--loki-brass-soft)" : "transparent", color: loud ? "var(--loki-accent)" : "var(--loki-muted)", fontFamily: "var(--loki-mono)", fontSize: 10.5, cursor: "pointer", whiteSpace: "nowrap", opacity: busy ? 0.6 : 1 }}
    >
      <Shield mode={info.id} />
      {busy ? "changing…" : info.short}
      <span aria-hidden style={{ fontSize: 9.5 }}>▾</span>
    </button>
  );
}

function Shield({ mode }: { mode: PermissionMode }) {
  // the same shield, filled more the more it asks
  const fill = mode === "strict" ? 1 : mode === "standard" ? 0.6 : mode === "acceptEdits" ? 0.3 : 0;
  return (
    <svg width="10" height="11" viewBox="0 0 10 11" aria-hidden>
      <path d="M5 .8 9 2.3v3.2c0 2.3-1.7 4-4 4.9C2.7 9.5 1 7.8 1 5.5V2.3z" fill="currentColor" fillOpacity={fill} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** The menu: four rows with a line each; ↑↓ / Enter / Esc, or click. */
export function ModeMenu({ open, current, onPick, onClose, anchor = "left" }: { open: boolean; current: PermissionMode | null; onPick: (m: PermissionMode) => void; onClose: () => void; anchor?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const idx = Math.max(0, MODES.findIndex((m) => m.id === (current ?? "unrestricted")));
    el?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[idx]?.focus();
  }, [open, current]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="permission mode"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") items[Math.min(items.length - 1, i + 1)]?.focus();
        else if (e.key === "ArrowUp") items[Math.max(0, i - 1)]?.focus();
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ position: "absolute", top: 30, [anchor]: 8, width: 300, zIndex: 20, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, boxShadow: "var(--loki-shadow-float)", padding: 4 }}
    >
      {MODES.map((m) => (
        <button
          key={m.id}
          role="menuitemradio"
          aria-checked={m.id === (current ?? "unrestricted")}
          onClick={() => onPick(m.id)}
          className="loki-menu-row"
          style={{ display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 8, alignItems: "center", width: "100%", textAlign: "left", padding: "7px 8px", border: "none", borderRadius: 6, background: "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit" }}
        >
          <span style={{ color: m.id === "unrestricted" ? "var(--loki-accent)" : "var(--loki-muted)", display: "grid", placeItems: "center" }}>
            <Shield mode={m.id} />
          </span>
          <span style={{ display: "grid" }}>
            <span style={{ fontSize: 13.5 }}>{m.label}</span>
            <span style={{ fontSize: 10.5, color: "var(--loki-muted)", lineHeight: 1.4 }}>{m.description}</span>
          </span>
          <span style={{ fontSize: 10.5, color: "var(--loki-accent)", fontFamily: "var(--loki-mono)" }}>{m.id === (current ?? "unrestricted") ? "current" : ""}</span>
        </button>
      ))}
      <div style={{ padding: "5px 8px 3px", fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>applies to this conversation · esc</div>
    </div>
  );
}
