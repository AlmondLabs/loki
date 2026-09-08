import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Chip, Dot, Field, Meta, Popover, Row } from "../ui";

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
export function ModelPicker({ open, ...props }: ModelPickerProps & { open: boolean }) {
  // Closed: nothing mounted, so each opening starts with an empty filter and the caret in the box.
  if (!open) return null;
  return <ModelPickerOpen {...props} />;
}

interface ModelPickerProps {
  current: string | null;
  entries: ModelEntry[] | null;
  loading: boolean;
  onPick: (handle: string) => void;
  onClose: () => void;
  anchor?: "left" | "right";
}

function ModelPickerOpen({ current, entries, loading, onPick, onClose, anchor = "left" }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** The listbox's id; each option is `${listId}-opt-${index}` so the input can point at the highlighted one. */
  const listId = useId();

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

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

  return (
    <Popover role="dialog" aria-label="choose a model" anchor={anchor} width={360}>
      <Field
        ref={inputRef}
        bare
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
        role="combobox"
        aria-expanded={true}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={rows.length > 0 ? `${listId}-opt-${index}` : undefined}
      />
      <div ref={listRef} id={listId} role="listbox" aria-label="models" style={{ maxHeight: 320, overflowY: "auto", padding: 4 }}>
        {rows.map(({ e, group }, i) => {
          const prevGroup = i > 0 ? rows[i - 1].group : null;
          return (
            <div key={e.handle} role="presentation">
              {group !== prevGroup && group && <div role="presentation" className="loki-label" style={{ fontSize: 9.5, padding: "6px 8px 2px" }}>{group}</div>}
              <Row dense id={`${listId}-opt-${i}`} role="option" tabIndex={-1} data-index={i} aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => onPick(e.handle)} style={{ alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: e.handle === current ? "var(--loki-accent)" : "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortModel(e.handle)}</span>
                <span style={{ fontSize: 10.5, color: "var(--loki-muted)", marginLeft: "auto", whiteSpace: "nowrap" }}>
                  {e.handle === current ? "current" : e.isDefault ? "default" : e.isFeatured ? "featured" : e.label !== shortModel(e.handle) ? e.label : ""}
                </span>
              </Row>
            </div>
          );
        })}
        {entries && rows.length === 0 && <div role="status" style={{ padding: 10, fontSize: 12, color: "var(--loki-muted)" }}>no model matches</div>}
      </div>
      <div role="presentation" style={{ padding: "5px 10px", borderTop: "1px solid var(--loki-border)" }}>
        <Meta>↑↓ move · ↵ switch this conversation · esc</Meta>
      </div>
    </Popover>
  );
}

/** The chip that opens the picker: the short model name, quiet until hovered. */
export function ModelChip({ model, onClick, busy }: { model: string | null; onClick: () => void; busy?: boolean }) {
  return (
    <Chip
      onClick={onClick}
      title={model ? `model: ${model} — click to change for this conversation` : "choose a model for this conversation"}
      aria-label="model"
      aria-busy={busy || undefined} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}
    >
      <Dot size={5} color="var(--loki-muted)" aria-hidden />
      {busy ? "switching…" : shortModel(model)}
      <span aria-hidden style={{ fontSize: 9.5 }}>▾</span>
    </Chip>
  );
}
