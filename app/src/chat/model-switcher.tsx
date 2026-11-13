import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "../components";
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
import { effortEntriesFor, effortTitle, groupModelEntries, modelLists, nameInHarness, preferredModelEntry, type ModelGroup } from "./model-picker";
import "../shell/search-sheet.css";

/** One row of the switcher: a model under its harness, whether the chat can move to it, and what it is matched on. */
export interface SwitchRow {
  key: string;
  group: ModelGroup;
  harness: Harness;
  name: string;
  /** The muted line: the model's own words, else its provider; never the bare handle. */
  line: string | null;
  /** This account cannot reach the model. */
  off: boolean;
  current: boolean;
  /** A usual configuration's own effort, which a pick takes as it is; absent, the effort shown at the foot. */
  effort?: ReasoningEffort | null;
}

/** One block of rows under its title: the agent's usual configurations, or one harness's models. */
export interface SwitchGroup {
  id: string;
  title: string;
  rows: SwitchRow[];
  /** How many more matched than are shown. */
  hidden: number;
}

/** One of the agent's usual configurations as the app holds it (mod/usual-models.ts): a model and its effort. */
export interface UsualChoice {
  handle: string;
  reasoning_effort: ReasoningEffort | null;
}

/** The most rows a harness shows for a query: the rest are a few more letters away. */
const PER_HARNESS = 40;

/** "anthropic/claude-x" → "anthropic"; null for a handle with no provider. */
const providerOf = (handle: string) => {
  const at = handle.indexOf("/");
  const p = at > 0 ? handle.slice(0, at) : null;
  return p?.startsWith("acp:") ? null : p;
};

/**
 * What the switcher lists (plan 2026-11-12-1505, U19): the chat's harness first, then the others in their order, each
 * under its name. With nothing typed, loki's quick picks (and an agent's every model); typed, every model whose name,
 * provider or harness holds each word, names that start with the query first. Once the chat has started, only its
 * own harness: switching models and effort happens there, and another harness is a new chat's choice. With nothing
 * typed, the agent's usual configurations lead (plan 2026-11-13-1240), each with its effort, ones the chat can take.
 */
export function switcherGroups(
  entries: ModelEntry[],
  current: string | null,
  started: boolean,
  query: string,
  usual: readonly UsualChoice[] = [],
  currentEffort: ReasoningEffort | null = null,
): SwitchGroup[] {
  const chatHarness = harnessOf(current);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tabs = harnesses(entries, chatHarness, started);
  // Once the chat has started only its own harness is offered (plan 020, KD4): its history lives there.
  const open = tabs.filter((t) => !t.locked);
  const ordered = [...open.filter((t) => t.id === chatHarness), ...open.filter((t) => t.id !== chatHarness)];
  const all = groupModelEntries(entries);
  const usualRows = words.length
    ? []
    : usual.flatMap((u): SwitchRow[] => {
        const harness = open.find((t) => t.id === harnessOf(u.handle));
        const group = all.find((g) => g.handle === u.handle);
        if (!harness || !group) return [];
        const name = nameInHarness(group, harness);
        const where = [u.reasoning_effort && effortsOf(entries, u.handle).length ? `${effortTitle(u.reasoning_effort)} effort` : null, harness.name]
          .filter(Boolean)
          .join(" · ");
        return [
          {
            key: `usual:${u.handle}:${u.reasoning_effort ?? ""}`,
            group,
            harness,
            name,
            line: where,
            off: !group.available,
            current: group.handle === current && (u.reasoning_effort ?? null) === (effortsOf(entries, u.handle).length ? currentEffort : null),
            effort: u.reasoning_effort,
          },
        ];
      });
  const lead: SwitchGroup[] = usualRows.length ? [{ id: "usual", title: "Usual", rows: usualRows, hidden: 0 }] : [];
  return [
    ...lead,
    ...ordered.flatMap((harness): SwitchGroup[] => {
      const inHarness = entries.filter((e) => harnessOf(e.handle) === harness.id);
      const groups = !words.length && harness.id === null ? modelLists(inHarness, current).short : groupModelEntries(inHarness);
      const rows = groups.map((group): SwitchRow => {
        const name = nameInHarness(group, harness);
        const described = group.entries.find((e) => e.description)?.description ?? null;
        return {
          key: `${harness.id ?? "loki"}:${group.handle}`,
          group,
          harness,
          name,
          line: described ?? providerOf(group.handle),
          off: harness.locked || !group.available,
          current: group.handle === current,
        };
      });
      const hay = (r: SwitchRow) => `${r.name} ${r.group.handle} ${r.harness.name} ${r.line ?? ""}`.toLowerCase();
      const matched = words.length
        ? rows
            .filter((r) => words.every((w) => hay(r).includes(w)))
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(words[0])) - Number(!b.name.toLowerCase().startsWith(words[0])))
        : rows;
      if (!matched.length) return [];
      return [{ id: harness.id ?? "loki", title: harness.name, rows: matched.slice(0, PER_HARNESS), hidden: Math.max(0, matched.length - PER_HARNESS) }];
    }),
  ];
}

/** The efforts a model offers, in REASONING_EFFORTS order; empty when it offers one or none. */
function effortsOf(entries: ModelEntry[], handle: string): ReasoningEffort[] {
  const list = effortEntriesFor(entries, handle).flatMap((e) => (e.reasoning_effort ? [e.reasoning_effort] : []));
  return list.length > 1 ? list : [];
}

/** The next effort the model offers from `at`, one step left or right, staying at the ends. */
export function stepEffort(offered: ReasoningEffort[], at: ReasoningEffort | null, step: 1 | -1): ReasoningEffort | null {
  if (!offered.length) return at;
  const i = at ? offered.indexOf(at) : -1;
  const from = i < 0 ? offered.indexOf(offered.find((e) => REASONING_EFFORTS.indexOf(e) >= REASONING_EFFORTS.indexOf("medium")) ?? offered[0]) : i;
  return offered[Math.max(0, Math.min(offered.length - 1, from + step))];
}

const NO_USUAL: readonly UsualChoice[] = [];
const LIST_ID = "loki-model-switch-list";
const optionId = (key: string) => `loki-model-switch-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/**
 * Switch model, ⌘K's way (U19): a floating panel near the top of the window with nothing dimmed behind it, the field
 * focused at once. Type to filter every harness and provider; ↑↓ move, Return switches, Esc or a click outside
 * closes. The highlighted model's efforts sit at the foot: ←→ (while the field is empty) or a click on one.
 */
export function ModelSwitcher({
  entries,
  current,
  currentEffort,
  started = false,
  usual = NO_USUAL,
  onPick,
  onClose,
}: {
  entries: ModelEntry[] | null;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  started?: boolean;
  /** The agent's usual configurations, most used first; they lead the list with nothing typed. */
  usual?: readonly UsualChoice[];
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => switcherGroups(entries ?? [], current, started, query, usual, currentEffort),
    [entries, current, started, query, usual, currentEffort],
  );
  const rows = groups.flatMap((g) => g.rows);
  const live = rows.filter((r) => !r.off);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The highlight: the one pointed at or moved to, else the current model, else the first that can be picked.
  const first = live.at(0) ?? null;
  const active = live.find((r) => r.key === activeKey) ?? (query ? first : (live.find((r) => r.current) ?? first));
  const offered = active ? effortsOf(entries ?? [], active.group.handle) : [];
  const [effortPick, setEffortPick] = useState<{ handle: string; effort: ReasoningEffort } | null>(null);
  const effort =
    active && effortPick?.handle === active.group.handle
      ? effortPick.effort
      : active?.effort !== undefined
        ? active.effort
        : active?.current
          ? currentEffort
          : null;
  // The effort shown: the one chosen here, else the chat's for its own model, else the one a pick would take.
  const shownEffort =
    !active || !offered.length
      ? null
      : effort && offered.includes(effort)
        ? effort
        : (preferredModelEntry(active.group, currentEffort).reasoning_effort ?? null);

  useEffect(() => {
    if (active) document.getElementById(optionId(active.key))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (row: SwitchRow, at: ReasoningEffort | null = row === active ? shownEffort : (row.effort ?? null)) => {
    if (row.off) return;
    const entry = (at ? row.group.entries.find((e) => e.reasoning_effort === at) : undefined) ?? preferredModelEntry(row.group, currentEffort);
    onPick(selectionOf(entry));
  };
  const move = (step: 1 | -1) => {
    if (!live.length) return;
    const i = active ? live.indexOf(active) : -1;
    setActiveKey(live[(i + step + live.length) % live.length].key);
  };

  // Drawn at the page's root, as the other sheets are: the composer's glass would otherwise frame it.
  const sheet = (
    <Sheet label="Switch model" onClose={onClose} width={560} top="12vh" clear className="loki-search loki-model-switch">
      <form role="search" className="loki-search-bar" onSubmit={(e) => (e.preventDefault(), active && pick(active))}>
        <Icon name="search" size={18} className="loki-search-glass" />
        <input
          className="loki-search-input"
          value={query}
          onChange={(e) => (setQuery(e.target.value.slice(0, 100)), setActiveKey(null))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !query && active && offered.length) {
              e.preventDefault();
              const next = stepEffort(offered, shownEffort, e.key === "ArrowRight" ? 1 : -1);
              if (next) setEffortPick({ handle: active.group.handle, effort: next });
            }
          }}
          placeholder="Switch model"
          aria-label="Switch model"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active.key) : undefined}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-form-type="other"
        />
      </form>
      <div className="loki-search-body">
        {!entries ? (
          <div className="loki-search-empty">
            <p className="loki-search-miss">Loading models…</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="loki-search-empty">
            <p className="loki-search-miss">{query ? `No model matches “${query}”` : "No models from the harness"}</p>
          </div>
        ) : (
          <div id={LIST_ID} role="listbox" aria-label="Models">
            {groups.map((g) => (
              <div key={g.id} role="group" aria-label={g.title} className="loki-search-group">
                <div className="loki-search-group-head">
                  <span className="loki-search-group-title">{g.title}</span>
                  {g.hidden > 0 && <span className="loki-meta">{`${g.hidden} more: type more letters`}</span>}
                </div>
                <ul className="loki-list" role="presentation">
                  {g.rows.map((r) => (
                    <li
                      key={r.key}
                      id={optionId(r.key)}
                      role="option"
                      aria-selected={r === active}
                      aria-disabled={r.off || undefined}
                      className="loki-list-item"
                      data-dim={r.off || undefined}
                    >
                      {/* The field keeps focus: a press would take it, so the row picks on click without being focused. */}
                      <div
                        className="loki-list-row loki-search-row"
                        onPointerDown={(e) => e.preventDefault()}
                        onPointerMove={r.off || r === active ? undefined : () => setActiveKey(r.key)}
                        onClick={() => pick(r)}
                      >
                        <span className="loki-list-row-copy">
                          <span className="loki-list-row-title">
                            <span className="loki-list-row-name">{r.name}</span>
                          </span>
                          {r.line && <span className="loki-list-row-preview">{r.line}</span>}
                        </span>
                        {r.current && <Icon name="check" size={16} className="loki-model-switch-check" />}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!query && <p className="loki-meta loki-model-switch-more">Type to search every model</p>}
          </div>
        )}
      </div>
      <div className="loki-model-switch-foot">
        {offered.length > 0 && active ? (
          <div role="radiogroup" aria-label={`Effort for ${active.name}`} className="loki-model-switch-efforts">
            <span className="loki-meta">Effort</span>
            {offered.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={e === shownEffort}
                tabIndex={-1}
                className="loki-model-switch-effort"
                onPointerDown={(ev) => ev.preventDefault()}
                onClick={() => pick(active, e)}
              >
                {effortTitle(e)}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <span className="loki-meta">{`↑↓ ${offered.length ? "· ←→ effort " : ""}· ${formatKeys("enter")} switch · ${formatKeys("escape")}`}</span>
      </div>
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
