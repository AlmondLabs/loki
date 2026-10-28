import { useEffect, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import { Chip, Field, IconButton, Meta, Popover, Row, Sheet, sentence } from "../components";
import { Icon } from "../shared/icons";
import { formatKeys } from "../shell/keymap";
import {
  REASONING_EFFORTS,
  harnessOf,
  harnesses,
  selectionOf,
  type Harness,
  type ModelEntry,
  type ModelSelection,
  type ReasoningEffort,
} from "../../../core/models.ts";

export type { ModelEntry, ModelSelection, ReasoningEffort } from "../../../core/models.ts";

/** One model as the picker lists it: the entries for its handle (one per reasoning effort it offers) folded into one row. */
export interface ModelGroup {
  handle: string;
  entries: ModelEntry[];
  label: string;
  isDefault: boolean;
  isFeatured: boolean;
  /** This account can reach it (list_models' available_handles); true when the harness did not say. */
  available: boolean;
  /** Its place among the models used lately, 0 the latest; undefined when not among them. */
  recent?: number;
}

/**
 * The entries folded into one group per handle, in the order the handles first appear; a group is the default, featured
 * or recent if any of its entries is, and available only if all are.
 */
export function groupModelEntries(entries: ModelEntry[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.handle);
    if (existing) {
      existing.entries.push(entry);
      existing.isDefault ||= entry.is_default === true;
      existing.isFeatured ||= entry.is_featured === true;
      existing.available &&= entry.available !== false;
      if (entry.recent !== undefined) existing.recent = Math.min(existing.recent ?? entry.recent, entry.recent);
    } else {
      groups.set(entry.handle, {
        handle: entry.handle,
        entries: [entry],
        label: entry.label,
        isDefault: entry.is_default === true,
        isFeatured: entry.is_featured === true,
        available: entry.available !== false,
        ...(entry.recent !== undefined ? { recent: entry.recent } : {}),
      });
    }
  }
  return [...groups.values()];
}

/** The entry to pick when a model is chosen: the one at `preferredEffort`, else the default, the featured, medium, high, or the first. */
export function preferredModelEntry(group: ModelGroup, preferredEffort: ReasoningEffort | null): ModelEntry {
  return (
    (preferredEffort ? group.entries.find((entry) => entry.reasoning_effort === preferredEffort) : undefined) ??
    group.entries.find((entry) => entry.is_default) ??
    group.entries.find((entry) => entry.is_featured) ??
    group.entries.find((entry) => entry.reasoning_effort === "medium") ??
    group.entries.find((entry) => entry.reasoning_effort === "high") ??
    group.entries[0]
  );
}

/** The entries for one handle, one per reasoning effort in REASONING_EFFORTS order; empty with no handle. */
export function effortEntriesFor(entries: ModelEntry[], handle: string | null | undefined): ModelEntry[] {
  if (!handle) return [];
  const byEffort = new Map<ReasoningEffort, ModelEntry>();
  for (const entry of entries) {
    if (entry.handle !== handle || !entry.reasoning_effort || byEffort.has(entry.reasoning_effort)) continue;
    byEffort.set(entry.reasoning_effort, entry);
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

/** A reasoning effort as the picker writes it ("no reasoning", "x-high", else its own name). */
export function effortLabel(effort: ReasoningEffort): string {
  if (effort === "none") return "no reasoning";
  if (effort === "xhigh") return "x-high";
  return effort;
}

/** A line in place of the list: loading, nothing found, nothing listed yet. */
const status = (text: string) => (
  <p role="status" className="loki-model-status">
    {text}
  </p>
);

/** Keep an event from bubbling further. */
const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** How many models the quick picks hold (the current model may make one more). */
const SHORT_MAX = 5;
/** How many models the short list shows when nothing is recent or featured. */
const SHORT_FALLBACK = 4;
/** The long list's cap: a harness can offer a few hundred handles; the filter finds the rest. */
const MORE_CAP = 160;
/** A preset's label may carry its effort ("GPT-5 Low"); the group's name is the model's, the effort is shown on its own. */
const EFFORT_SUFFIX = /\s*[([]?\b(none|no reasoning|minimal|low|medium|high|x-?high|max)\b[)\]]?\s*$/i;

/** A group's name: its presets' label, without the effort word when it offers several. */
function groupName(group: ModelGroup): string {
  const efforts = group.entries.filter((entry) => entry.reasoning_effort).length;
  return (efforts > 1 && group.label.replace(EFFORT_SUFFIX, "")) || group.label || shortModel(group.handle);
}

/** What the pill calls the conversation's model: its presets' label, else the handle's short form; "Model" when unknown. */
export function modelName(entries: ModelEntry[] | null, handle: string | null | undefined): string {
  if (!handle) return "Model";
  const group = groupModelEntries(entries ?? []).find((g) => g.handle === handle);
  return group ? groupName(group) : shortModel(handle);
}

/**
 * The picker's two lists. The quick picks: the models you used lately, latest first (mod/models.ts), then the
 * harness's featured models in its order to fill up to five, only ones this account can reach; with neither,
 * the first few it can reach; and the current model, so its check is in view. More models: the rest, by handle,
 * unreachable ones included (the filter finds anything).
 */
export function modelLists(entries: ModelEntry[] | null, current: string | null): { short: ModelGroup[]; more: ModelGroup[] } {
  const groups = groupModelEntries(entries ?? []);
  const reachable = groups.filter((group) => group.available);
  const recent = reachable.filter((group) => group.recent !== undefined).sort((a, b) => (a.recent ?? 0) - (b.recent ?? 0));
  const featured = reachable.filter((group) => group.isFeatured && !recent.includes(group));
  const picks = [...recent, ...featured].slice(0, SHORT_MAX);
  const base = picks.length ? picks : reachable.slice(0, SHORT_FALLBACK);
  const now = groups.find((group) => group.handle === current);
  const short = now && !base.includes(now) ? [...base, now] : base;
  const more = groups.filter((group) => !short.includes(group)).sort((a, b) => a.handle.localeCompare(b.handle));
  return { short, more };
}

/** A row's muted line: the model's own description, else its handle when the name is not already the handle; no line otherwise. */
export function modelLine(group: ModelGroup): string | null {
  const described = group.entries.find((entry) => entry.description)?.description;
  if (described) return described;
  return groupName(group) !== group.handle ? group.handle : null;
}

/** An ACP agent's row's muted line: only what the agent said of the model; its handle would only repeat the tab. */
function agentLine(group: ModelGroup): string | null {
  return group.entries.find((entry) => entry.description)?.description ?? null;
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
export function ModelPill({
  ref,
  name,
  effort,
  busy,
  open,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  name: string;
  effort: ReasoningEffort | null;
  busy?: boolean;
  open: boolean;
  onClick: () => void;
}) {
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

/** Which page of the model picker shows: the chosen harness's models, or more of loki's. */
export type PickerView = "models" | "more";

/** A model's name inside its harness's tab: an ACP agent's "Claude Code · Sonnet" is "Sonnet" there, its default "Default". */
export function nameInHarness(group: ModelGroup, harness: Harness): string {
  const name = groupName(group);
  if (harness.id === null) return name;
  if (name === harness.name) return "Default";
  return name.startsWith(`${harness.name} · `) ? name.slice(harness.name.length + 3) : name;
}

/** The props of `ModelChoices`, the picker's content shared by the phone's sheet and the desktop's popover. */
export interface ModelChoicesProps {
  view: PickerView;
  entries: ModelEntry[] | null;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  /** Something has been said: the chat stays on its harness, and the other tabs are locked (plan 020, KD4). */
  started?: boolean;
  /** The harness tab showing; undefined shows the chat's own. */
  harness?: string | null;
  loading: boolean;
  /** More models' filter. */
  query: string;
  /** The phone's sheet: a grip and a round close; the desktop's popover has neither (Esc and a click away close it). */
  touch?: boolean;
  onView: (view: PickerView) => void;
  onHarness?: (harness: string | null) => void;
  onQuery: (query: string) => void;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
}

/**
 * What Select model shows, the same in the phone's sheet and the desktop's popover (plan 021): the harnesses as
 * tabs when there is more than one, the chosen one's models with a check on the current one (loki's as its quick
 * picks, then More models ›), and under them the checked model's effort levels when it offers several. Every choice
 * applies to this conversation.
 */
export function ModelChoices({
  view,
  entries,
  current,
  currentEffort,
  started = false,
  harness,
  loading,
  query,
  touch = false,
  onView,
  onHarness = () => {},
  onQuery,
  onPick,
  onClose,
}: ModelChoicesProps) {
  const chatHarness = harnessOf(current);
  const tabs = harnesses(entries ?? [], chatHarness, started);
  const shownId = harness === undefined ? chatHarness : harness;
  const shown = tabs.find((t) => t.id === shownId) ?? tabs.at(0) ?? { id: null, name: "loki", locked: false };
  const inShown = (entries ?? []).filter((entry) => harnessOf(entry.handle) === shown.id);
  const { short, more } = shown.id === null ? modelLists(inShown, current) : { short: groupModelEntries(inShown), more: [] };
  const efforts = harnessOf(current) === shown.id ? effortEntriesFor(entries ?? [], current) : [];
  const title = view === "more" ? "More models" : "Select model";
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
  const groupOption = (group: ModelGroup) =>
    option(group.handle, nameInHarness(group, shown), shown.id === null ? modelLine(group) : agentLine(group), group.handle === current, () =>
      onPick(selectionOf(preferredModelEntry(group, currentEffort))),
    );
  let content;
  if (!entries) content = status(loading ? "Loading models…" : "No models from the harness");
  else if (view === "more") {
    const q = query.trim().toLowerCase();
    const found = more.filter((group) => !q || group.handle.toLowerCase().includes(q) || group.label.toLowerCase().includes(q)).slice(0, MORE_CAP);
    content = (
      <>
        <Field
          size={touch ? "touch" : "sm"}
          type="search"
          name="model-search"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter by provider or name"
          aria-label="Filter models"
        />
        {found.length === 0 ? (
          status("No model matches")
        ) : (
          <div className="loki-model-card" role="group" aria-label="More models">
            {found.flatMap((group, i) => {
              const provider = group.handle.split("/")[0];
              const heading = i === 0 || found[i - 1].handle.split("/")[0] !== provider;
              return [
                heading && provider !== group.handle && (
                  <div key={`${provider}-label`} role="presentation" className="loki-label loki-model-provider">
                    {provider}
                  </div>
                ),
                groupOption(group),
              ];
            })}
          </div>
        )}
      </>
    );
  } else {
    content = (
      <>
        {tabs.length > 1 && (
          <div role="tablist" aria-label="Harness" className="loki-model-tabs">
            {tabs.map((t) => {
              const on = t.id === shown.id;
              return (
                <button
                  key={t.id ?? "loki"}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-disabled={t.locked || undefined}
                  tabIndex={on ? 0 : -1}
                  data-harness={t.id ?? "loki"}
                  {...(on ? { "data-model-item": "" } : {})}
                  className="loki-model-tab"
                  title={t.locked ? "fixed once the chat has started; start a new chat to change" : undefined}
                  onClick={() => !t.locked && onHarness(t.id)}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        )}
        {short.length === 0 ? (
          status(`${shown.name} has not listed its models yet`)
        ) : (
          <div className="loki-model-card" role="group" aria-label={`${shown.name} models`}>
            {short.map(groupOption)}
          </div>
        )}
        {more.length > 0 && (
          <div className="loki-model-card">
            <Row flush role="menuitem" data-choice="more" data-model-item="" onClick={() => onView("more")} className="loki-model-row">
              <span className="loki-model-link-label">More models</span>
              <Icon name="chevron-right" size={glyph} className="loki-model-chev" />
            </Row>
          </div>
        )}
        {efforts.length > 1 && (
          <div role="radiogroup" aria-label="Effort" className="loki-model-efforts">
            <span aria-hidden className="loki-label loki-model-efforts-label">
              Effort
            </span>
            {efforts.map((entry) => {
              const effort = entry.reasoning_effort;
              if (!effort) return null;
              const on = effort === currentEffort;
              return (
                <button
                  key={effort}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-choice={effort}
                  data-model-item=""
                  className="loki-model-effort"
                  onClick={() => onPick(selectionOf(entry))}
                >
                  {sentence(effortLabel(effort))}
                </button>
              );
            })}
          </div>
        )}
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
          <Meta>{`For this conversation · ${tabs.filter((t) => !t.locked).length > 1 && view === "models" ? "←→ harness · " : ""}↑↓ ${formatKeys("enter")} · ${formatKeys("escape")}`}</Meta>
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
  /** Something has been said in the chat: its harness is fixed. */
  started?: boolean;
  loading: boolean;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
  /** The pill: focus goes back to it on close, and a press on it is not a click away. */
  pillRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Select model, framed for where it opens: a bottom sheet on the phone (the Sheet's veil, Escape and focus return),
 * a popover over the message box on the desktop (↑↓ Home End between the items, Esc, a click away; focus returns
 * to the pill). ⌘⇧M (chat.model) opens it too. Closed, nothing is mounted, so each opening starts on the chat's own
 * harness and its short list.
 */
export function ModelPicker({ open, ...props }: ModelPickerProps & { open: boolean }) {
  if (!open) return null;
  return <ModelPickerOpen {...props} />;
}

function ModelPickerOpen({ touch = false, current, currentEffort, entries, started = false, loading, onPick, onClose, pillRef }: ModelPickerProps) {
  const [view, setView] = useState<PickerView>("models");
  const [harness, setHarness] = useState<string | null>(() => harnessOf(current));
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
    const target =
      node?.querySelector<HTMLElement>(view === "more" ? "input" : '[data-model-item][aria-checked="true"]') ??
      node?.querySelector<HTMLElement>("[data-model-item]");
    target?.focus({ preventScroll: true });
  }, [view, loaded]);
  // A tab chosen from the keyboard keeps the focus, so ←→ can go on to the next.
  useEffect(() => {
    const node = ref.current;
    if (!document.activeElement?.closest('[role="tablist"]')) return;
    node?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [harness]);
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
    // ←→ on a harness tab move to the next one the chat can go to, and show it.
    const tab = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[role="tab"]') : null;
    if (tab && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const open = [...(ref.current?.querySelectorAll<HTMLElement>('[role="tab"]:not([aria-disabled="true"])') ?? [])];
      const at = open.indexOf(tab);
      const next = open.at((at + (e.key === "ArrowRight" ? 1 : -1) + open.length) % open.length);
      const id = next?.dataset.harness;
      if (id && next !== tab) setHarness(id === "loki" ? null : id);
      return;
    }
    const move = pickerKey(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    if ("close" in move) onClose();
    else items[move.focus]?.focus();
  };

  const body = (
    <ModelChoices
      view={view}
      entries={entries}
      current={current}
      currentEffort={currentEffort}
      started={started}
      harness={harness}
      loading={loading}
      query={query}
      touch={touch}
      onView={setView}
      onHarness={setHarness}
      onQuery={setQuery}
      onPick={onPick}
      onClose={onClose}
    />
  );
  if (touch) {
    const sheet = (
      <Sheet label="Select model" onClose={onClose} placement="bottom" className="loki-phone-sheet loki-model-sheet">
        <div ref={ref} onKeyDown={onKeyDown}>
          {body}
        </div>
      </Sheet>
    );
    // The Sheet draws itself at the phone shell's root, out of the Inbox card's transform. React still bubbles a
    // portal's events through the tree it came from: without this a drag in the sheet would swipe the card underneath.
    return (
      <div style={{ display: "contents" }} onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent} onPointerCancel={stopEvent}>
        {sheet}
      </div>
    );
  }
  return (
    <Popover ref={ref} role="dialog" aria-label="Select model" side="above" width={340} className="loki-model-popover" onKeyDown={onKeyDown}>
      {body}
    </Popover>
  );
}
