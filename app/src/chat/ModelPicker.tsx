import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Chip, Dot, Field, Meta, Popover, Row } from "../components";
import { formatKeys } from "../shell/keymap";
import { REASONING_EFFORTS, selectionOf, type ModelEntry, type ModelSelection, type ReasoningEffort } from "../../../core/models.ts";

export type { ModelEntry, ModelSelection, ReasoningEffort } from "../../../core/models.ts";

export interface ModelGroup {
  handle: string;
  entries: ModelEntry[];
  label: string;
  isDefault: boolean;
  isFeatured: boolean;
}

export function groupModelEntries(entries: ModelEntry[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.handle);
    if (existing) {
      existing.entries.push(entry);
      existing.isDefault ||= entry.isDefault === true;
      existing.isFeatured ||= entry.isFeatured === true;
    } else {
      groups.set(entry.handle, {
        handle: entry.handle,
        entries: [entry],
        label: entry.label,
        isDefault: entry.isDefault === true,
        isFeatured: entry.isFeatured === true,
      });
    }
  }
  return [...groups.values()];
}

export function preferredModelEntry(group: ModelGroup, preferredEffort: ReasoningEffort | null): ModelEntry {
  return (
    (preferredEffort ? group.entries.find((entry) => entry.reasoningEffort === preferredEffort) : undefined) ??
    group.entries.find((entry) => entry.isDefault) ??
    group.entries.find((entry) => entry.isFeatured) ??
    group.entries.find((entry) => entry.reasoningEffort === "medium") ??
    group.entries.find((entry) => entry.reasoningEffort === "high") ??
    group.entries[0]
  );
}

export function effortEntriesFor(entries: ModelEntry[], handle: string | null | undefined): ModelEntry[] {
  if (!handle) return [];
  const byEffort = new Map<ReasoningEffort, ModelEntry>();
  for (const entry of entries) {
    if (entry.handle !== handle || !entry.reasoningEffort || byEffort.has(entry.reasoningEffort)) continue;
    byEffort.set(entry.reasoningEffort, entry);
  }
  return REASONING_EFFORTS.flatMap((effort) => {
    const entry = byEffort.get(effort);
    return entry ? [entry] : [];
  });
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
  currentEffort?: ReasoningEffort | null;
  entries: ModelEntry[] | null;
  loading: boolean;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
  anchor?: "left" | "right";
  side?: "below" | "above";
}

function ModelPickerOpen({ current, currentEffort = null, entries, loading, onPick, onClose, anchor = "left", side }: ModelPickerProps) {
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
    const list = groupModelEntries(entries ?? []).filter((group) => !q || group.handle.toLowerCase().includes(q) || group.entries.some((entry) => entry.label.toLowerCase().includes(q)));
    const rank = (group: ModelGroup) => (group.handle === current ? 0 : group.isDefault ? 1 : group.isFeatured ? 2 : 9);
    const pinned = list.filter((group) => rank(group) < 9).sort((a, b) => rank(a) - rank(b) || a.handle.localeCompare(b.handle));
    const rest = list.filter((group) => rank(group) === 9).sort((a, b) => a.handle.localeCompare(b.handle));
    return [...pinned.map((model) => ({ model, provider: "" })), ...rest.map((model) => ({ model, provider: model.handle.split("/")[0] }))].slice(0, 160);
  }, [entries, query, current]);
  const choose = (entry: ModelEntry) => onPick(selectionOf(entry));
  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1));
  }, [rows.length, index]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <Popover role="dialog" aria-label="choose a model" anchor={anchor} side={side} width={360}>
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
            if (r) choose(preferredModelEntry(r.model, currentEffort));
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
        {rows.map(({ model, provider }, i) => {
          const prevGroup = i > 0 ? rows[i - 1].provider : null;
          const selected = preferredModelEntry(model, currentEffort);
          return (
            <div key={model.handle} role="presentation">
              {provider !== prevGroup && provider && <div role="presentation" className="loki-label" style={{ padding: "6px 8px 2px" }}>{provider}</div>}
              <Row dense id={`${listId}-opt-${i}`} role="option" tabIndex={-1} data-index={i} aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => choose(selected)} style={{ alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 12, color: model.handle === current ? "var(--loki-accent)" : "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortModel(model.handle)}</span>
                <span className="loki-meta" style={{ marginLeft: "auto" }}>
                  {model.handle === current ? "current" : model.isDefault ? "default" : model.isFeatured ? "featured" : model.label !== shortModel(model.handle) ? model.label : ""}
                </span>
              </Row>
            </div>
          );
        })}
        {entries && rows.length === 0 && <div role="status" className="loki-meta loki-meta--wrap" style={{ padding: 10 }}>no model matches</div>}
      </div>
      <div role="presentation" style={{ padding: "5px 10px", borderTop: "1px solid var(--loki-border)" }}>
        <Meta>{`↑↓ move · ${formatKeys("enter")} switch this conversation · ${formatKeys("escape")}`}</Meta>
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
      aria-busy={busy || undefined}
      style={{ maxWidth: 180, minWidth: 0, flex: "1 1 80px", overflow: "hidden" }}
    >
      <Dot size={5} color="var(--loki-muted)" aria-hidden />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{busy ? "switching…" : shortModel(model)}</span>
      <span aria-hidden style={{ fontSize: 9.5 }}>▾</span>
    </Chip>
  );
}

/** A separate control beside the model chip, shown only when that model offers a real choice. */
export function EffortChip({ effort, onClick, busy }: { effort: ReasoningEffort | null; onClick: () => void; busy?: boolean }) {
  const label = effort ? effortLabel(effort) : "choose";
  return (
    <Chip
      onClick={onClick}
      title={`reasoning effort: ${label} — click to change for this conversation`}
      aria-label={`reasoning effort: ${label}`}
      aria-busy={busy || undefined}
    >
      <EffortGauge effort={effort} />
      {busy ? "changing…" : `${label} effort`}
      <span aria-hidden style={{ fontSize: 9.5 }}>▾</span>
    </Chip>
  );
}

/** The current model's supported effort levels, independent from choosing the model itself. */
export function EffortMenu({
  open,
  entries,
  current,
  onPick,
  onClose,
  anchor = "left",
  side,
}: {
  open: boolean;
  entries: ModelEntry[];
  current: ReasoningEffort | null;
  onPick: (entry: ModelEntry) => void;
  onClose: () => void;
  anchor?: "left" | "right";
  side?: "below" | "above";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    const index = Math.max(0, entries.findIndex((entry) => entry.reasoningEffort === current));
    items?.[index]?.focus();
  }, [open, entries, current]);
  if (!open) return null;
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label="reasoning effort"
      anchor={anchor}
      side={side}
      width={230}
      style={{ padding: 4 }}
      onKeyDown={(event) => {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === "ArrowDown") items[Math.min(items.length - 1, index + 1)]?.focus();
        else if (event.key === "ArrowUp") items[Math.max(0, index - 1)]?.focus();
        else if (event.key === "Escape") onClose();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {entries.map((entry) => {
        const effort = entry.reasoningEffort!;
        const selected = effort === current;
        return (
          <Row key={effort} dense role="menuitemradio" aria-checked={selected} onClick={() => onPick(entry)} style={{ gap: 8 }}>
            <EffortGauge effort={effort} />
            <span style={{ fontSize: 12 }}>{effortLabel(effort)}</span>
            <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--loki-accent)" }}>{selected ? "current" : ""}</span>
          </Row>
        );
      })}
      <div style={{ padding: "5px 8px 3px" }}>
        <Meta>reasoning for this conversation · esc</Meta>
      </div>
    </Popover>
  );
}

function EffortGauge({ effort }: { effort: ReasoningEffort | null }) {
  const filled = effort ? Math.max(0, REASONING_EFFORTS.indexOf(effort)) : 0;
  return (
    <span aria-hidden style={{ display: "inline-flex", alignItems: "flex-end", gap: 1, height: 10 }}>
      {[2, 5, 8].map((height, index) => (
        <span key={height} style={{ display: "block", width: 2, height, borderRadius: 1, background: "currentColor", opacity: index < Math.ceil(filled / 2) ? 1 : 0.3 }} />
      ))}
    </span>
  );
}

export function effortLabel(effort: ReasoningEffort): string {
  if (effort === "none") return "no reasoning";
  if (effort === "xhigh") return "x-high";
  return effort;
}
