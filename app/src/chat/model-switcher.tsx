import { useEffect, useMemo, useState } from "react";
import type { SharedModels } from "../shell/command-center";
import { Icon } from "../shared/icons";
import { formatKeys } from "../shell/keymap";
import { REASONING_EFFORTS, harnessOf, harnesses, selectionOf, type Harness, type ModelEntry, type ReasoningEffort } from "../../../core/models.ts";
import { effortEntriesFor, effortTitle, groupModelEntries, modelLists, nameInHarness, preferredModelEntry, type ModelGroup } from "./model-picker";
import "../shell/search-sheet.css";

export interface SwitchRow {
  key: string;
  group: ModelGroup;
  harness: Harness;
  name: string;
  line: string | null;
  off: boolean;
  current: boolean;
  effort?: ReasoningEffort | null;
}

export interface SwitchGroup {
  id: string;
  title: string;
  rows: SwitchRow[];
  hidden: number;
}

export interface UsualChoice {
  handle: string;
  reasoning_effort: ReasoningEffort | null;
}

const PER_HARNESS = 40;

const providerOf = (handle: string) => {
  const at = handle.indexOf("/");
  const p = at > 0 ? handle.slice(0, at) : null;
  return p?.startsWith("acp:") ? null : p;
};

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

function effortsOf(entries: ModelEntry[], handle: string): ReasoningEffort[] {
  const list = effortEntriesFor(entries, handle).flatMap((e) => (e.reasoning_effort ? [e.reasoning_effort] : []));
  return list.length > 1 ? list : [];
}

export function stepEffort(offered: ReasoningEffort[], at: ReasoningEffort | null, step: 1 | -1): ReasoningEffort | null {
  if (!offered.length) return at;
  const i = at ? offered.indexOf(at) : -1;
  const from = i < 0 ? offered.indexOf(offered.find((e) => REASONING_EFFORTS.indexOf(e) >= REASONING_EFFORTS.indexOf("medium")) ?? offered[0]) : i;
  return offered[Math.max(0, Math.min(offered.length - 1, from + step))];
}

const LIST_ID = "loki-model-switch-list";
const optionId = (key: string) => `loki-model-switch-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export type SwitchSource = Pick<SharedModels, "entries" | "current" | "currentEffort" | "started" | "usual" | "pick">;

export function useModelSwitch(src: SwitchSource, query: string) {
  const { entries, current, currentEffort, started, usual } = src;
  const groups = useMemo(
    () => switcherGroups(entries ?? [], current, started, query, usual, currentEffort),
    [entries, current, started, query, usual, currentEffort],
  );
  const live = groups.flatMap((g) => g.rows).filter((r) => !r.off);
  const [activeKey, setActiveKey] = useState<string | null>(null);
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
  const shownEffort =
    !active || !offered.length
      ? null
      : effort && offered.includes(effort)
        ? effort
        : (preferredModelEntry(active.group, currentEffort).reasoning_effort ?? null);

  useEffect(() => {
    if (active) document.getElementById(optionId(active.key))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (row: SwitchRow, at?: ReasoningEffort | null) => {
    if (row.off) return;
    const pickedEffort = at === undefined ? (row === active ? shownEffort : (row.effort ?? null)) : at;
    const entry =
      (pickedEffort ? row.group.entries.find((e) => e.reasoning_effort === pickedEffort) : undefined) ?? preferredModelEntry(row.group, currentEffort);
    src.pick(selectionOf(entry));
  };
  const onKey = (key: string): boolean => {
    if ((key === "ArrowDown" || key === "ArrowUp") && live.length) {
      const i = active ? live.indexOf(active) : -1;
      setActiveKey(live[(i + (key === "ArrowDown" ? 1 : -1) + live.length) % live.length].key);
      return true;
    }
    if ((key === "ArrowLeft" || key === "ArrowRight") && !query && active && offered.length) {
      const to = stepEffort(offered, shownEffort, key === "ArrowRight" ? 1 : -1);
      if (to) setEffortPick({ handle: active.group.handle, effort: to });
      return true;
    }
    return false;
  };
  return { groups, active, offered, shownEffort, pick, onKey, point: setActiveKey, loaded: entries !== null };
}

export type ModelSwitch = ReturnType<typeof useModelSwitch>;

export const modelOptionId = optionId;

export function ModelSwitchList({ sw, query }: { sw: ModelSwitch; query: string }) {
  if (!sw.loaded)
    return (
      <div className="loki-search-empty">
        <p className="loki-search-miss">Loading models…</p>
      </div>
    );
  if (!sw.groups.length)
    return (
      <div className="loki-search-empty">
        <p className="loki-search-miss">{query ? `No model matches “${query}”` : "No models from the harness"}</p>
      </div>
    );
  return (
    <div id={LIST_ID} role="listbox" aria-label="Models">
      {sw.groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.title} className="loki-search-group">
          <div className="loki-search-group-head">
            <span className="loki-search-group-title">{g.title}</span>
            {g.hidden > 0 && <span className="loki-meta">{`${g.hidden} more: type more letters`}</span>}
          </div>
          <ul className="loki-list" role="presentation">
            {g.rows.map((r) => (
              <ModelRow key={r.key} row={r} selected={r === sw.active} onPoint={() => sw.point(r.key)} onPick={() => sw.pick(r)} />
            ))}
          </ul>
        </div>
      ))}
      {!query && <p className="loki-meta loki-model-switch-more">Type to search every model</p>}
    </div>
  );
}

export function ModelRow({ row: r, selected, onPoint, onPick }: { row: SwitchRow; selected: boolean; onPoint: () => void; onPick: () => void }) {
  return (
    <li id={optionId(r.key)} role="option" aria-selected={selected} aria-disabled={r.off || undefined} className="loki-list-item" data-dim={r.off || undefined}>
      <div
        className="loki-list-row loki-search-row"
        onPointerDown={(e) => e.preventDefault()}
        onPointerMove={r.off || selected ? undefined : onPoint}
        onClick={onPick}
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
  );
}

export function ModelSwitchFoot({ sw }: { sw: ModelSwitch }) {
  const { active, offered, shownEffort } = sw;
  return (
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
              onClick={() => sw.pick(active, e)}
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
  );
}
