import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListIcon, Sheet } from "../components";
import { AgentFace } from "../desk/AgentChip";
import { Icon } from "../shared/icons";
import { cleanQuery } from "../shared/search";
import { COVERAGE, buildIndex, flatHits, recentPlaceHits, recentPlaces, search, type SearchHit, type SearchSources } from "./searchModel";
import { formatKeys } from "./keymap";
import "./searchSheet.css";

const LIST_ID = "loki-search-results";
const optionId = (key: string) => `loki-search-opt-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/**
 * ⌘K, Slack's switcher (plan 013 U9): a sheet near the top of the window, the field focused at once. Before
 * typing, the recent places (searchModel.ts drops ones that no longer resolve); while typing, Desks,
 * Agents, Waiting and Pages, each group placed by its best hit, so the first row is the top result.
 * ↑ ↓ move the highlight (focus stays in the field: a combobox over one listbox), Enter opens it, Esc and
 * ⌘K again close. The line at the foot says what is searched, so no one takes it for message search.
 */
export function SearchSheet({ sources, here, avatar, onOpen, onClose }: { sources: SearchSources; /** The place showing (a recent-places key), left out of the recents. */ here: string | null; avatar: (agentId: string) => string | null; onOpen: (hit: SearchHit) => void; onClose: () => void }) {
  // No autoFocus on the field: Sheet notes the element focused before it (to hand focus back on close), then focuses the field, its first control.
  const [query, setQuery] = useState("");
  const [placeKeys, setPlaceKeys] = useState(() => recentPlaces.read());
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  const typed = cleanQuery(query);
  const index = useMemo(() => buildIndex(sources), [sources]);
  const groups = useMemo(() => search(index, typed), [index, typed]);
  const places = useMemo(() => (typed ? [] : recentPlaceHits(placeKeys.filter((k) => k !== here), sources)), [typed, placeKeys, here, sources]);
  const rows = typed ? flatHits(groups) : places;
  const found = groups.reduce((n, g) => n + g.total, 0);
  const current = rows[Math.min(active, rows.length - 1)] ?? null;

  // A new query starts at the top result (the highlight resets as it is typed, below).
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [typed]);
  useEffect(() => {
    if (current) document.getElementById(optionId(current.key))?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const open = (hit: SearchHit) => {
    recentPlaces.add(hit.place);
    onOpen(hit);
  };
  const row = (h: SearchHit, i: number) => <HitRow key={h.key} hit={h} selected={h === current} avatar={avatar} onPoint={() => setActive(i)} onOpen={() => open(h)} />;

  const starts = groupStarts(groups); // each group's first row in `rows`
  return (
    <Sheet label="Search" onClose={onClose} width={640} top="10vh" className="loki-search" cardProps={{ "data-search": "" }}>
      <form role="search" className="loki-search-bar" onSubmit={(e) => (e.preventDefault(), current && open(current))}>
        <Icon name="search" size={18} className="loki-search-glass" />
        <input
          className="loki-search-input"
          value={query}
          onChange={(e) => (setQuery(e.target.value.slice(0, 200)), setActive(0))}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            if (rows.length) setActive((a) => (Math.min(a, rows.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
          }}
          placeholder="Search desks, agents and pages"
          aria-label="Search"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current.key) : undefined}
          aria-describedby="loki-search-coverage"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-form-type="other"
        />
        <span className="loki-meta">esc</span>
      </form>
      <p className="sr-only" aria-live="polite">
        {typed ? (found ? `${found} ${found === 1 ? "result" : "results"}` : "No results") : ""}
      </p>
      <div ref={scroller} className="loki-search-body">
        {!typed && places.length > 0 && (
          // The recents' heading sits outside the listbox: its Clear is a button, not an option.
          <div className="loki-search-group-head">
            <span id="loki-search-recent" className="loki-search-group-title">
              Recent
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="loki-search-clear" onClick={() => (recentPlaces.clear(), setPlaceKeys([]))}>
              Clear
            </button>
          </div>
        )}
        <div id={LIST_ID} role="listbox" aria-label={typed ? "Results" : undefined} aria-labelledby={typed ? undefined : "loki-search-recent"}>
          {typed ? (
            groups.map((g, gi) => (
              <Group key={g.id} title={g.title} note={g.total > g.hits.length ? `${g.hits.length} of ${g.total}` : null}>
                {g.hits.map((h, i) => row(h, starts[gi] + i))}
              </Group>
            ))
          ) : (
            <ul className="loki-list" role="presentation">
              {places.map((h, i) => row(h, i))}
            </ul>
          )}
        </div>
        {typed && groups.length === 0 && (
          <div className="loki-search-empty">
            <p className="loki-search-miss">No matches for “{typed}”</p>
          </div>
        )}
        {!typed && places.length === 0 && (
          <div className="loki-search-empty">
            <p className="loki-search-miss">Search loki</p>
            <p className="loki-meta loki-meta--wrap">Desks and pages you open show here.</p>
          </div>
        )}
      </div>
      <p id="loki-search-coverage" className="loki-meta loki-meta--wrap loki-search-coverage">
        {COVERAGE} ↑ ↓ to move, {formatKeys("enter")} to open.
      </p>
    </Sheet>
  );
}

/** Where each group's rows start in the flat list, the groups in order (a counter in render keeps the React Compiler off). */
function groupStarts(groups: ReadonlyArray<{ hits: readonly unknown[] }>): number[] {
  const out: number[] = [];
  let at = 0;
  for (const g of groups) {
    out.push(at);
    at += g.hits.length;
  }
  return out;
}

/** A group of options: a quiet heading, and how many of how many when capped, over its rows. */
function Group({ title, note, children }: { title: string; note?: string | null; children: ReactNode }) {
  const id = `loki-search-group-${title.toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={id} className="loki-search-group">
      <div className="loki-search-group-head">
        <span id={id} className="loki-search-group-title">
          {title}
        </span>
        {note && <span className="loki-meta">{note}</span>}
      </div>
      <ul className="loki-list" role="presentation">
        {children}
      </ul>
    </div>
  );
}

/** One result: ListRow's anatomy as a listbox option — the lead, the title over its line; highlighted while chosen. */
function HitRow({ hit, selected, avatar, onPoint, onOpen }: { hit: SearchHit; selected: boolean; avatar: (agentId: string) => string | null; onPoint: () => void; onOpen: () => void }) {
  const lead = "agent" in hit.lead ? <AgentFace name={hit.lead.agent.name} src={avatar(hit.lead.agent.id)} /> : <ListIcon name={hit.lead.icon} />;
  return (
    <li id={optionId(hit.key)} role="option" aria-selected={selected} className="loki-list-item" data-dim={hit.dim || undefined} data-launch={hit.key}>
      {/* The field keeps focus; a press would take it, so the row opens on click without ever being focused. */}
      <div className="loki-list-row loki-search-row" onPointerDown={(e) => e.preventDefault()} onPointerMove={selected ? undefined : onPoint} onClick={onOpen}>
        <span className="loki-list-row-lead">{lead}</span>
        <span className="loki-list-row-copy">
          <span className="loki-list-row-title">
            <span className="loki-list-row-name">{hit.title}</span>
          </span>
          <span className="loki-list-row-preview">{hit.preview}</span>
        </span>
        {selected && <span className="loki-meta" aria-hidden>{formatKeys("enter")}</span>}
      </div>
    </li>
  );
}
