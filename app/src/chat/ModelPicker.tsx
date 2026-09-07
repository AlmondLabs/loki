import { useEffect, useMemo, useRef, useState } from "react";

export interface ModelEntry {
  id: string;
  handle: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
}

/** "anthropic/claude-fable-5" → "claude-fable-5"; the provider is shown as the group. */
export function shortModel(handle: string | null | undefined): string {
  if (!handle) return "model";
  const i = handle.indexOf("/");
  return i > 0 ? handle.slice(i + 1) : handle;
}

/**
 * The model chip's dropdown: type to filter a few hundred handles, grouped by provider, the current one
 * marked, featured and default models first. Enter picks, Esc closes. The change applies to this
 * conversation (the app-server keeps a model per conversation; the main chat's model is the agent's).
 */
export function ModelPicker({
  open,
  current,
  entries,
  loading,
  onPick,
  onClose,
  anchor = "left",
}: {
  open: boolean;
  current: string | null;
  entries: ModelEntry[] | null;
  loading: boolean;
  onPick: (handle: string) => void;
  onClose: () => void;
  anchor?: "left" | "right";
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Pinned first (current, default, featured), then everything else grouped by provider.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (entries ?? []).filter((e) => !q || e.handle.toLowerCase().includes(q) || e.label.toLowerCase().includes(q));
    const rank = (e: ModelEntry) => (e.handle === current ? 0 : e.isDefault ? 1 : e.isFeatured ? 2 : 9);
    const pinned = list.filter((e) => rank(e) < 9).sort((a, b) => rank(a) - rank(b) || a.handle.localeCompare(b.handle));
    const rest = list.filter((e) => rank(e) === 9).sort((a, b) => a.handle.localeCompare(b.handle));
    return [...pinned.map((e) => ({ e, group: "" })), ...rest.map((e) => ({ e, group: e.handle.split("/")[0] }))].slice(0, 160);
  }, [entries, query, current]);
  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1));
  }, [rows.length, index]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="choose a model"
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: 30, [anchor]: 8, width: 360, maxWidth: "calc(100% - 16px)", zIndex: 20, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, boxShadow: "var(--loki-shadow-float)", overflow: "hidden" }}
    >
      <input
        ref={inputRef}
        type="search"
        name="model-search"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const r = rows[index];
            if (r) onPick(r.e.handle);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          e.stopPropagation();
        }}
        placeholder={loading ? "loading models…" : "model… (provider/name)"}
        aria-label="filter models"
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 13.5, background: "transparent", border: "none", borderBottom: "1px solid var(--loki-border)", color: "var(--loki-fg)", outline: "none" }}
      />
      <div ref={listRef} role="listbox" style={{ maxHeight: 320, overflowY: "auto", padding: 4 }}>
        {rows.map(({ e, group }, i) => {
          const prevGroup = i > 0 ? rows[i - 1].group : null;
          return (
            <div key={e.handle}>
              {group !== prevGroup && group && <div className="loki-label" style={{ fontSize: 9.5, padding: "6px 8px 2px" }}>{group}</div>}
              <div
                role="option"
                data-index={i}
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(e.handle)}
                style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer", background: i === index ? "var(--loki-accent-soft)" : "transparent" }}
              >
                <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: e.handle === current ? "var(--loki-accent)" : "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortModel(e.handle)}</span>
                <span style={{ fontSize: 10.5, color: "var(--loki-muted)", marginLeft: "auto", whiteSpace: "nowrap" }}>
                  {e.handle === current ? "current" : e.isDefault ? "default" : e.isFeatured ? "featured" : e.label !== shortModel(e.handle) ? e.label : ""}
                </span>
              </div>
            </div>
          );
        })}
        {entries && rows.length === 0 && <div style={{ padding: 10, fontSize: 12, color: "var(--loki-muted)" }}>no model matches</div>}
      </div>
      <div style={{ padding: "5px 10px", fontSize: 10.5, color: "var(--loki-muted)", borderTop: "1px solid var(--loki-border)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>↑↓ move · ↵ switch this conversation · esc</div>
    </div>
  );
}

/** The chip that opens the picker: the short model name, quiet until hovered. */
export function ModelChip({ model, onClick, busy }: { model: string | null; onClick: () => void; busy?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={model ? `model: ${model} — click to change for this conversation` : "choose a model for this conversation"}
      aria-label="model"
      className="loki-model-chip"
      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", border: "1px solid var(--loki-border)", borderRadius: 999, background: "transparent", color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", fontSize: 10.5, cursor: "pointer", maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: busy ? 0.6 : 1 }}
    >
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: 3, background: "var(--loki-muted)" }} />
      {busy ? "switching…" : shortModel(model)}
      <span aria-hidden style={{ fontSize: 9.5 }}>▾</span>
    </button>
  );
}
