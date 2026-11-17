import { useEffect, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import { Chip, Field, IconButton, Meta, Row, Sheet, sentence } from "../components";
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

export interface ModelGroup {
  handle: string;
  entries: ModelEntry[];
  label: string;
  isDefault: boolean;
  isFeatured: boolean;
  available: boolean;
  recent?: number;
}

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

const status = (text: string) => (
  <p role="status" className="loki-model-status">
    {text}
  </p>
);

const stopEvent = (e: { stopPropagation: () => void }) => e.stopPropagation();

const SHORT_MAX = 5;
const SHORT_FALLBACK = 4;
const MORE_CAP = 160;
const EFFORT_SUFFIX = /\s*[([]?\b(none|no reasoning|minimal|low|medium|high|x-?high|max)\b[)\]]?\s*$/i;

function groupName(group: ModelGroup): string {
  const efforts = group.entries.filter((entry) => entry.reasoning_effort).length;
  return (efforts > 1 && group.label.replace(EFFORT_SUFFIX, "")) || group.label || shortModel(group.handle);
}

export function modelName(entries: ModelEntry[] | null, handle: string | null | undefined): string {
  if (!handle) return "Model";
  const group = groupModelEntries(entries ?? []).find((g) => g.handle === handle);
  return group ? groupName(group) : shortModel(handle);
}

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

export function modelLine(group: ModelGroup): string | null {
  const described = group.entries.find((entry) => entry.description)?.description;
  if (described) return described;
  return groupName(group) !== group.handle ? group.handle : null;
}

function agentLine(group: ModelGroup): string | null {
  return group.entries.find((entry) => entry.description)?.description ?? null;
}

export function pickerKey(key: string, at: number, count: number): { focus: number } | { close: true } | null {
  if (key === "Escape") return { close: true };
  if (count === 0) return null;
  if (key === "ArrowDown") return { focus: Math.min(count - 1, at + 1) };
  if (key === "ArrowUp") return { focus: Math.max(0, at - 1) };
  if (key === "Home") return { focus: 0 };
  if (key === "End") return { focus: count - 1 };
  return null;
}

export function returnsFocus(active: unknown, picker: { contains: (node: never) => boolean } | null, body: unknown): boolean {
  return !active || active === body || !!picker?.contains(active as never);
}

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

export type PickerView = "models" | "more";

export function nameInHarness(group: ModelGroup, harness: Harness): string {
  const name = groupName(group);
  if (harness.id === null) return name;
  if (name === harness.name) return "Default";
  return name.startsWith(`${harness.name} · `) ? name.slice(harness.name.length + 3) : name;
}

export interface ModelChoicesProps {
  view: PickerView;
  entries: ModelEntry[] | null;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  started?: boolean;
  harness?: string | null;
  loading: boolean;
  query: string;
  touch?: boolean;
  onView: (view: PickerView) => void;
  onHarness?: (harness: string | null) => void;
  onQuery: (query: string) => void;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
}

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
                  title={t.locked ? "Fixed once the chat has started; start a new chat to change" : undefined}
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

export function effortTitle(effort: ReasoningEffort): string {
  return effortLabel(effort).replace(/(^|[\s-])([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase());
}

interface ModelPickerProps {
  touch?: boolean;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  entries: ModelEntry[] | null;
  started?: boolean;
  loading: boolean;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
  pillRef: RefObject<HTMLButtonElement | null>;
}

export function ModelPicker({ open, ...props }: ModelPickerProps & { open: boolean }) {
  if (!open) return null;
  return <ModelPickerOpen {...props} />;
}

function ModelPickerOpen({ touch = false, current, currentEffort, entries, started = false, loading, onPick, onClose, pillRef }: ModelPickerProps) {
  const [view, setView] = useState<PickerView>("models");
  const [harness, setHarness] = useState<string | null>(() => harnessOf(current));
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const loaded = entries !== null;
  useEffect(() => {
    const node = ref.current;
    const target =
      node?.querySelector<HTMLElement>(view === "more" ? "input" : '[data-model-item][aria-checked="true"]') ??
      node?.querySelector<HTMLElement>("[data-model-item]");
    target?.focus({ preventScroll: true });
  }, [view, loaded]);
  useEffect(() => {
    const node = ref.current;
    if (!document.activeElement?.closest('[role="tablist"]')) return;
    node?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [harness]);
  useEffect(() => {
    const node = ref.current;
    const pill = pillRef.current;
    return () => {
      if (returnsFocus(document.activeElement, node, document.body)) pill?.focus({ preventScroll: true });
    };
  }, [pillRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("input, [data-model-item]") ?? [])];
    const inField = e.target instanceof HTMLInputElement;
    if (inField && e.key === "Enter") {
      e.preventDefault();
      items.find((el) => el.hasAttribute("data-model-item"))?.click();
      return;
    }
    if (inField && (e.key === "Home" || e.key === "End")) return;
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
    <div className="contents" onPointerDown={stopEvent} onPointerMove={stopEvent} onPointerUp={stopEvent} onPointerCancel={stopEvent}>
      {sheet}
    </div>
  );
}
