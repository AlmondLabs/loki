import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { avatarUrl } from "../desk/env";
import { Icon } from "./icons";
import type { LinkState } from "./model";
import { navigate, rewrite } from "./router";
import { Avatar, PhoneRow, RowIcon, RowSection } from "./rows";
import { cleanQuery, isPlace, recentPlaceHits, search, type GroupId, type Hit, type SearchSources } from "./searchIndex";
import { recentPlaces, recentSearches, scrollMemory, useScrollMemory } from "./session";

/** What Search covers, said plainly wherever it would otherwise look like message search. */
const COVERAGE = "Searches desk titles, agents, waiting items and pages on this phone — not message text.";
const GROUP_ICON = { desks: "desk", agents: "agents", inbox: "inbox", pages: "more" } as const satisfies Record<GroupId, string>;

/**
 * Search, opened from the round button beside the navigation, Slack's grammar: the field at the top takes
 * focus at once and stays above the keyboard (the shell fits the visible viewport, viewport.ts); what
 * scrolls beneath it is the one scroll owner. Before typing: recent searches and recently visited places
 * (searchIndex.ts drops ones that no longer resolve). While typing: Desks, Agents, Inbox and Pages, from what the
 * phone already holds — no Mac calls. A result opens its usual page with Search as the origin; the query
 * is written into this entry first, so Back comes back to the same query and scroll. Clearing the field
 * keeps focus there and never leaves — Back does.
 */
export function Search({ q, fresh, sources, link, loaded, onBack, backLabel }: { q: string; /** Opened anew (not come back to): start at the top. */ fresh: boolean; sources: SearchSources; link: LinkState; /** The agent list has arrived from the Mac. */ loaded: boolean; onBack: () => void; backLabel: string }) {
  const [query, setQuery] = useState(q);
  const [recent, setRecent] = useState(() => recentSearches.read());
  const [placesTick, setPlacesTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // A fresh Search starts at the top; one come back to keeps its place (scroll memory "search").
  useState(() => fresh && scrollMemory.save("search", 0));
  useScrollMemory(scroller, "search");

  const typed = cleanQuery(query);
  const groups = useMemo(() => search(sources, typed), [sources, typed]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const places = useMemo(() => recentPlaceHits(recentPlaces.read((h) => isPlace(h, sources)), sources), [sources, placesTick]);
  const found = groups.reduce((n, g) => n + g.total, 0);

  // A new query starts its results at the top.
  const lastTyped = useRef(typed);
  useEffect(() => {
    if (lastTyped.current === typed) return;
    lastTyped.current = typed;
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [typed]);

  const remember = () => {
    if (!typed) return;
    recentSearches.add(typed);
    setRecent(recentSearches.read());
  };
  // Opening anything: the query goes on the recent list and into this entry, then the page opens from here.
  const open = (hit: Hit) => {
    remember();
    rewrite(typed ? { kind: "search", q: typed } : { kind: "search" });
    navigate(hit.route);
  };
  const clear = () => {
    setQuery("");
    rewrite({ kind: "search" });
    input.current?.focus();
  };

  const partial = link === "online" && !loaded ? "Still loading from the Mac; more may show up." : link === "connecting" ? "Connecting to the Mac; showing what this phone already has." : null;
  return (
    <div className="loki-phone-page">
      <header className="loki-phone-search-bar">
        <button type="button" className="loki-phone-icon-btn" aria-label={`back to ${backLabel}`} onClick={onBack}>
          <Icon name="back" size={22} />
        </button>
        <h1 className="loki-phone-sr-only" data-phone-heading tabIndex={-1}>
          Search
        </h1>
        <form
          role="search"
          className="loki-phone-search-field"
          onSubmit={(e) => {
            e.preventDefault();
            remember();
            if (typed) rewrite({ kind: "search", q: typed });
            input.current?.blur(); // Search on the keyboard: put it away so the results show
          }}
        >
          <Icon name="search" size={18} className="loki-phone-search-glass" />
          <input
            ref={input}
            type="search"
            className="loki-phone-search-input"
            name="phone-search"
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 200))}
            placeholder="Search"
            aria-label="Search"
            aria-describedby="loki-phone-search-coverage"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            data-1p-ignore
            data-form-type="other"
          />
          {query && (
            // pointerdown would take focus from the field and drop the keyboard; the tap clears and keeps it
            <button type="button" className="loki-phone-search-clear" aria-label="Clear search" onPointerDown={(e) => e.preventDefault()} onClick={clear}>
              <Icon name="close" size={16} />
            </button>
          )}
        </form>
      </header>
      <p id="loki-phone-search-coverage" className="loki-phone-sr-only">
        {COVERAGE}
      </p>
      <p className="loki-phone-sr-only" aria-live="polite">
        {typed ? (found ? `${found} ${found === 1 ? "result" : "results"}` : "No results") : ""}
      </p>
      <div ref={scroller} className="loki-phone-scroll loki-phone-scroll--flush">
        {link === "offline" && <p className="loki-phone-search-note">The Mac is unreachable. Searching what this phone already loaded.</p>}
        {partial && <p className="loki-phone-search-note">{partial}</p>}
        {typed ? (
          groups.length > 0 ? (
            <>
              {groups.map((g) => (
                <RowSection key={g.id} icon={GROUP_ICON[g.id]} title={g.title} count={g.total}>
                  <ul aria-label={g.title} className="loki-phone-list">
                    {g.hits.map((h) => (
                      <HitRow key={h.key} hit={h} onOpen={() => open(h)} />
                    ))}
                  </ul>
                  {g.total > g.hits.length && (
                    <p className="loki-phone-search-note">
                      Showing {g.hits.length} of {g.total}. Keep typing to narrow.
                    </p>
                  )}
                </RowSection>
              ))}
              <p className="loki-phone-search-coverage">{COVERAGE}</p>
            </>
          ) : (
            <div className="loki-phone-empty">
              <p className="loki-phone-headline loki-phone-search-miss">No matches for “{typed}”</p>
              <p>{COVERAGE}</p>
            </div>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <Recents
                title="Recent searches"
                onClear={() => {
                  recentSearches.clear();
                  setRecent([]);
                }}
              >
                {recent.map((r) => (
                  <li key={r} className="loki-phone-row-item">
                    <button type="button" className="loki-phone-row loki-phone-row--quiet" onClick={() => (setQuery(r), recentSearches.add(r), setRecent(recentSearches.read()))}>
                      <RowIcon name="clock" />
                      <span className="loki-phone-row-copy">
                        <span className="loki-phone-row-title">
                          <span className="loki-phone-ellipsis">{r}</span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="loki-phone-icon-btn loki-phone-search-remove"
                      aria-label={`Remove “${r}” from recent searches`}
                      onClick={() => {
                        recentSearches.remove(r);
                        setRecent(recentSearches.read());
                      }}
                    >
                      <Icon name="close" size={18} />
                    </button>
                  </li>
                ))}
              </Recents>
            )}
            {places.length > 0 && (
              <Recents
                title="Recently visited"
                onClear={() => {
                  recentPlaces.clear();
                  setPlacesTick((n) => n + 1);
                }}
              >
                {places.map((h) => (
                  <HitRow key={h.key} hit={h} onOpen={() => open(h)} />
                ))}
              </Recents>
            )}
            {recent.length === 0 && places.length === 0 ? (
              <div className="loki-phone-empty">
                <p className="loki-phone-headline">Search this phone</p>
                <p>{COVERAGE}</p>
              </div>
            ) : (
              <p className="loki-phone-search-coverage">{COVERAGE}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** A recents list: a quiet heading with Clear on the right, then its rows. */
function Recents({ title, onClear, children }: { title: string; onClear: () => void; children: ReactNode }) {
  return (
    <section className="loki-phone-search-recents" aria-label={title}>
      <div className="loki-phone-search-head">
        <h2 className="loki-phone-search-head-title">{title}</h2>
        <button type="button" className="loki-phone-search-clear-all" aria-label={`Clear ${title.toLowerCase()}`} onClick={onClear}>
          Clear
        </button>
      </div>
      <ul aria-label={title} className="loki-phone-list">
        {children}
      </ul>
    </section>
  );
}

/** One result: the same row as the list it came from — an agent's face, or the desk's # or the page's icon. */
function HitRow({ hit, onOpen }: { hit: Hit; onOpen: () => void }) {
  const lead = "agent" in hit.lead ? <Avatar name={hit.lead.agent.name} src={avatarUrl(hit.lead.agent.id)} /> : <RowIcon name={hit.lead.icon} />;
  return <PhoneRow lead={lead} title={hit.title} preview={hit.preview} dim={hit.dim} label={`${hit.title}, ${hit.preview}`} launch={hit.key} onOpen={onOpen} />;
}
