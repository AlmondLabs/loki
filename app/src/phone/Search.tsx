import { useState } from "react";
import { Field } from "../components";
import { Icon } from "./icons";
import { recentSearches } from "./session";
import { GUTTER, Heading, Scroll } from "./ui";

/**
 * Search, opened from the round button beside the navigation: a field that takes focus at once and
 * stays above the keyboard, and what scrolls beneath it. For now only the recent searches; U7 adds the
 * local results (desks, agents, the loaded inbox, named destinations) and recently visited places.
 * Clearing the field never closes the page — Back does.
 */
export function Search({ onBack, backLabel }: { onBack: () => void; backLabel: string }) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(() => recentSearches.read());
  const submit = () => {
    if (!query.trim()) return;
    recentSearches.add(query);
    setRecent(recentSearches.read());
  };
  return (
    <>
      <header className="loki-phone-search-bar">
        <button type="button" className="loki-phone-icon-btn" aria-label={`back to ${backLabel}`} onClick={onBack}>
          <Icon name="back" size={22} />
        </button>
        <h1 className="loki-phone-sr-only" data-phone-heading tabIndex={-1}>
          Search
        </h1>
        <form
          role="search"
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field
            type="search"
            size="touch"
            name="phone-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search desks and agents"
            aria-label="Search"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            data-1p-ignore
            data-form-type="other"
          />
        </form>
      </header>
      <Scroll memory="search" style={{ padding: `8px ${GUTTER.right} 24px ${GUTTER.left}` }}>
        {recent.length > 0 && (
          <>
            <Heading>Recent searches</Heading>
            <ul aria-label="recent searches" className="loki-phone-list">
              {recent.map((q) => (
                <li key={q}>
                  <button type="button" className="loki-phone-menu-row" onClick={() => setQuery(q)}>
                    <Icon name="clock" size={20} />
                    <span className="loki-phone-menu-row-label">{q}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {recent.length === 0 && <div className="loki-phone-meta" style={{ padding: "32px 4px", textAlign: "center" }}>Search what this phone has loaded: desks and agents.</div>}
      </Scroll>
    </>
  );
}
