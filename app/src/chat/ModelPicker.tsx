import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import { Chip, Field, IconButton, Meta, Popover, Row, Sheet, sentence } from "../components";
import { Icon } from "../shared/icons";
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


export function effortLabel(effort: ReasoningEffort): string {
  if (effort === "none") return "no reasoning";
  if (effort === "xhigh") return "x-high";
  return effort;
}

/** How many models the short list shows when the harness marks none as featured. */
const SHORT_FALLBACK = 4;
/** The long list's cap: a harness can offer a few hundred handles; the filter finds the rest. */
const MORE_CAP = 160;
/** A preset's label may carry its effort ("GPT-5 Low"); the group's name is the model's, the effort is shown on its own. */
const EFFORT_SUFFIX = /\s*[([]?\b(none|no reasoning|minimal|low|medium|high|x-?high|max)\b[)\]]?\s*$/i;

/** A group's name: its presets' label, without the effort word when it offers several. */
function groupName(group: ModelGroup): string {
  const efforts = group.entries.filter((entry) => entry.reasoningEffort).length;
  return (efforts > 1 && group.label.replace(EFFORT_SUFFIX, "")) || group.label || shortModel(group.handle);
}

/** What the pill calls the conversation's model: its presets' label, else the handle's short form; "Model" when unknown. */
export function modelName(entries: ModelEntry[] | null, handle: string | null | undefined): string {
  if (!handle) return "Model";
  const group = groupModelEntries(entries ?? []).find((g) => g.handle === handle);
  return group ? groupName(group) : shortModel(handle);
}

/**
 * The picker's two lists: the short one (the featured models, else the first few, and the current model so its
 * check is in view) in the harness's order, and More models, the rest, by handle.
 */
export function modelLists(entries: ModelEntry[] | null, current: string | null): { short: ModelGroup[]; more: ModelGroup[] } {
  const groups = groupModelEntries(entries ?? []);
  const featured = groups.filter((group) => group.isFeatured);
  const base = featured.length ? featured : groups.slice(0, SHORT_FALLBACK);
  const short = groups.filter((group) => base.includes(group) || group.handle === current);
  const more = groups.filter((group) => !short.includes(group)).sort((a, b) => a.handle.localeCompare(b.handle));
  return { short, more };
}

/** A row's muted line: the model's own description, else its handle when the name is not already the handle; no line otherwise. */
export function modelLine(group: ModelGroup): string | null {
  const described = group.entries.find((entry) => entry.description)?.description;
  if (described) return described;
  return groupName(group) !== group.handle ? group.handle : null;
}

/** The picker's keys over its items (the filter field counts as one): ↑↓ move, Home and End jump, Esc closes. */
export function pickerKey(key: string, at: number, count: number): { focus: number } | { close: true } | null {
  if (key === "Escape") return { close: true };
  if (count === 0) return null;
  if (key === "ArrowDown") return { focus: Math.min(count - 1, at + 1) };
  if (key === "ArrowUp") return { focus: Math.max(0, at - 1) };
  if (key === "Home") return { focus: 0 };
  if (key === "End") return { focus: count - 1 };
  return null;
}

/** On close, focus goes back to the pill when it was inside the picker or dropped with it; a click elsewhere keeps its own. */
export function returnsFocus(active: unknown, picker: { contains: (node: never) => boolean } | null, body: unknown): boolean {
  return !active || active === body || !!picker?.contains(active as never);
}

/**
 * The pill in the message box's bottom row: the model in the foreground, the effort after it in the muted colour
 * (only when the model offers a choice), a chevron. It opens Select model.
 */
export function ModelPill({ ref, name, effort, busy, open, onClick }: { ref?: Ref<HTMLButtonElement>; name: string; effort: ReasoningEffort | null; busy?: boolean; open: boolean; onClick: () => void }) {
  const said = effort ? sentence(effortLabel(effort)) : null;
  return (
    <Chip
      ref={ref}
      className="loki-model-pill"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={busy || undefined}
      aria-label={`Model: ${name}${effort ? `, ${effortLabel(effort)}${effort === "none" ? "" : " effort"}` : ""}`}
      title="Choose the model for this conversation"
    >
      {busy ? (
        <span className="loki-model-pill-name">Switching…</span>
      ) : (
        <>
          <span className="loki-model-pill-name">{name}</span>
          {said && <span className="loki-model-pill-effort">{said}</span>}
        </>
      )}
      <Icon name="chevron-down" size={12} className="loki-model-pill-chev" />
    </Chip>
  );
}

export type PickerView = "models" | "effort" | "more";

export interface ModelChoicesProps {
  view: PickerView;
  entries: ModelEntry[] | null;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  loading: boolean;
  /** More models' filter. */
  query: string;
  /** The phone's sheet: a grip and a round close; the desktop's popover has neither (Esc and a click away close it). */
  touch?: boolean;
  onView: (view: PickerView) => void;
  onQuery: (query: string) => void;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
}

/**
 * What Select model shows, the same in the phone's sheet and the desktop's popover: a card of the short list (the
 * model's name, its line, a check on the current one), then Effort › (that model's levels) and More models › (the
 * rest, filtered by provider/name). Every choice applies to this conversation.
 */
export function ModelChoices({ view, entries, current, currentEffort, loading, query, touch = false, onView, onQuery, onPick, onClose }: ModelChoicesProps) {
  const { short, more } = modelLists(entries, current);
  const efforts = effortEntriesFor(entries ?? [], current);
  const title = view === "effort" ? "Effort" : view === "more" ? "More models" : "Select model";
  const glyph = touch ? 20 : 16;
  const option = (id: string, name: string, line: string | null, checked: boolean, pick: () => void) => (
    <Row key={id} flush role="menuitemradio" aria-checked={checked} data-choice={id} data-model-item="" onClick={pick} className="loki-model-row">
      <span className="loki-model-copy">
        <span className="loki-model-name">{name}</span>
        {line && <span className="loki-model-line">{line}</span>}
      </span>
      {checked && <Icon name="check" size={glyph} className="loki-model-check" />}
    </Row>
  );
  const groupOption = (group: ModelGroup) => option(group.handle, groupName(group), modelLine(group), group.handle === current, () => onPick(selectionOf(preferredModelEntry(group, currentEffort))));
  const link = (id: "effort" | "more", label: string, aside: string | null) => (
    <div key={id} className="loki-model-card">
      <Row flush role="menuitem" data-choice={id} data-model-item="" onClick={() => onView(id)} className="loki-model-row">
        <span className="loki-model-link-label">{label}</span>
        {aside && <span className="loki-model-aside">{aside}</span>}
        <Icon name="chevron-right" size={glyph} className="loki-model-chev" />
      </Row>
    </div>
  );
  const status = (text: string) => (
    <p role="status" className="loki-model-status">
      {text}
    </p>
  );

  let content;
  if (!entries) content = status(loading ? "Loading models…" : "No models from the harness");
  else if (view === "effort") {
    content = <div className="loki-model-card" role="group" aria-label="Effort">{efforts.map((entry) => option(entry.reasoningEffort!, sentence(effortLabel(entry.reasoningEffort!)), null, entry.reasoningEffort === currentEffort, () => onPick(selectionOf(entry))))}</div>;
  } else if (view === "more") {
    const q = query.trim().toLowerCase();
    const shown = more.filter((group) => !q || group.handle.toLowerCase().includes(q) || group.label.toLowerCase().includes(q)).slice(0, MORE_CAP);
    content = (
      <>
        <Field size={touch ? "touch" : "sm"} type="search" name="model-search" autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Filter by provider or name" aria-label="Filter models" />
        {shown.length === 0 ? (
          status("No model matches")
        ) : (
          <div className="loki-model-card" role="group" aria-label="More models">
            {shown.flatMap((group, i) => {
              const provider = group.handle.split("/")[0];
              const heading = i === 0 || shown[i - 1].handle.split("/")[0] !== provider;
              return [heading && provider !== group.handle && <div key={`${provider}-label`} role="presentation" className="loki-label loki-model-provider">{provider}</div>, groupOption(group)];
            })}
          </div>
        )}
      </>
    );
  } else {
    content = (
      <>
        <div className="loki-model-card" role="group" aria-label="Models">{short.map(groupOption)}</div>
        {efforts.length > 1 && link("effort", "Effort", currentEffort ? sentence(effortLabel(currentEffort)) : null)}
        {more.length > 0 && link("more", "More models", null)}
      </>
    );
  }

  return (
    <div className="loki-model">
      <div className="loki-model-head">
        {touch && <span aria-hidden className="loki-model-grip" />}
        <div className="loki-model-bar">
          {view !== "models" ? (
            <IconButton size={touch ? 36 : 24} label="Back to models" className="loki-model-close" onClick={() => onView("models")}>
              <Icon name="back" size={glyph} />
            </IconButton>
          ) : touch ? (
            <IconButton size={36} label="Close" className="loki-model-close" onClick={onClose}>
              <Icon name="close" size={glyph} />
            </IconButton>
          ) : (
            <span aria-hidden className="loki-model-spacer" />
          )}
          <h2 className="loki-model-title">{title}</h2>
          <span aria-hidden className="loki-model-spacer" />
        </div>
      </div>
      <div className="loki-model-body" role="menu" aria-label={title}>
        {content}
      </div>
      {!touch && (
        <div role="presentation" className="loki-model-foot">
          <Meta>{`For this conversation · ↑↓ ${formatKeys("enter")} · ${formatKeys("escape")}`}</Meta>
        </div>
      )}
    </div>
  );
}

interface ModelPickerProps {
  touch?: boolean;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  entries: ModelEntry[] | null;
  loading: boolean;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
  /** The pill: focus goes back to it on close, and a press on it is not a click away. */
  pillRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Select model, framed for where it opens: a bottom sheet on the phone (the Sheet's veil, Escape and focus return),
 * a popover over the message box on the desktop (↑↓ Home End between the items, Esc, a click away; focus returns
 * to the pill). ⌘⇧M (chat.model) opens it too. Closed, nothing is mounted, so each opening starts on the short list.
 */
export function ModelPicker({ open, ...props }: ModelPickerProps & { open: boolean }) {
  if (!open) return null;
  return <ModelPickerOpen {...props} />;
}

function ModelPickerOpen({ touch = false, current, currentEffort, entries, loading, onPick, onClose, pillRef }: ModelPickerProps) {
  const [view, setView] = useState<PickerView>("models");
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const loaded = entries !== null;
  // Each view starts on its natural place: the filter in More models, else the checked row, else the first.
  useEffect(() => {
    const node = ref.current;
    const target = node?.querySelector<HTMLElement>(view === "more" ? "input" : '[data-model-item][aria-checked="true"]') ?? node?.querySelector<HTMLElement>("[data-model-item]");
    target?.focus({ preventScroll: true });
  }, [view, loaded]);
  // Closing hands focus back to the pill (a tap on a phone never focused it, so the sheet's own return may have
  // nothing to go to). The popover also closes on a press outside it and the pill.
  useEffect(() => {
    const node = ref.current;
    const pill = pillRef.current; // the pill stays in the box while the picker opens and closes
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!node?.contains(target) && !pill?.contains(target)) closeRef.current();
    };
    // capture: the rail, the list column and other popovers stop pointerdown from bubbling
    if (!touch) window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      if (returnsFocus(document.activeElement, node, document.body)) pill?.focus({ preventScroll: true });
    };
  }, [touch, pillRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("input, [data-model-item]") ?? [])];
    const inField = e.target instanceof HTMLInputElement;
    // In the filter, Enter takes the first match and Home / End stay the caret's.
    if (inField && e.key === "Enter") {
      e.preventDefault();
      items.find((el) => el.hasAttribute("data-model-item"))?.click();
      return;
    }
    if (inField && (e.key === "Home" || e.key === "End")) return;
    const move = pickerKey(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    if ("close" in move) onClose();
    else items[move.focus]?.focus();
  };

  const body = <ModelChoices view={view} entries={entries} current={current} currentEffort={currentEffort} loading={loading} query={query} touch={touch} onView={setView} onQuery={setQuery} onPick={onPick} onClose={onClose} />;
  if (touch) {
    const sheet = (
      <Sheet label="Select model" onClose={onClose} placement="bottom" className="loki-phone-sheet loki-model-sheet">
        <div ref={ref} onKeyDown={onKeyDown}>
          {body}
        </div>
      </Sheet>
    );
    // Drawn at the phone's root, not where the pill is: the Inbox card moves by transform, and a transformed
    // ancestor becomes a fixed sheet's frame, so the sheet filled the card instead of the screen. The root keeps
    // the phone's styles, which are scoped under .loki-phone.
    const root = typeof document === "undefined" ? null : (document.querySelector(".loki-phone") ?? document.body);
    if (!root) return sheet;
    // React still bubbles a portal's events through the tree it came from: without this a drag in the sheet would
    // swipe the card underneath.
    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
    return createPortal(
      <div style={{ display: "contents" }} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onPointerCancel={stop}>
        {sheet}
      </div>,
      root,
    );
  }
  return (
    <Popover ref={ref} role="dialog" aria-label="Select model" side="above" width={340} className="loki-model-popover" onKeyDown={onKeyDown}>
      {body}
    </Popover>
  );
}
