import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Meta } from "../components";
import { caretOffset, fitLeft } from "../shared/caret-offset";

/**
 * Mentioning people in an outside card's reply (plan 082), as Slack and Gmail do: typing `@` and a few letters shows the
 * people who match; ↑ and ↓ move, Enter or Tab takes one and Esc puts the list away. What a pick writes, and what else
 * it does, is the card's to say: a Slack handle, or a mail name that also adds the person to To.
 */

/** Someone the list offers: what it shows, what a pick writes after the `@`, and anything else the pick does. */
export interface MentionChoice {
  key: string;
  label: string;
  sub: string | null;
  insert: string;
  onPick?: () => void;
}

/** Where people come from: at once from what the card holds (mail), or asked of the account's Mac (Slack). */
export interface MentionSource {
  now?: (query: string) => MentionChoice[];
  later?: (query: string) => Promise<MentionChoice[]>;
}

/** The `@` being typed before the caret and the letters after it; null when the caret is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\s@]{1,40})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** The text with the `@` being typed replaced by the pick and a space, and where the caret goes after it. */
export function insertMention(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  const word = `@${insert} `;
  return { text: text.slice(0, start) + word + text.slice(caret), caret: start + word.length };
}

/** How long a search waits after a key before asking, so a name typed fast asks once. */
const SEARCH_WAIT_MS = 150;

/**
 * The mention list for one reply box: the list to draw above the box, the keys it takes while it shows, and what the
 * box tells it of its caret. `ref` is the box, so a pick puts the caret after the name.
 */
export function useMentions({
  text,
  setText,
  source,
  ref,
}: {
  text: string;
  setText: (text: string) => void;
  source: MentionSource | null;
  ref: RefObject<HTMLTextAreaElement | null>;
}): { list: ReactNode; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean; onCaret: (el: HTMLTextAreaElement | null) => void } {
  const [caret, setCaret] = useState<number | null>(null);
  // The `@` the person put away with Esc, so the list stays away until they type another.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [found, setFound] = useState<{ query: string; list: MentionChoice[] }>({ query: "", list: [] });
  const [highlight, setHighlight] = useState<{ query: string; at: number }>({ query: "", at: 0 });
  const pendingCaret = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const token = source && caret !== null && caret <= text.length ? mentionAt(text, caret) : null;
  const active = token && token.start !== dismissed ? token : null;
  const query = active?.query ?? "";
  const later = useEffectEvent((q: string) => source?.later?.(q) ?? Promise.resolve([]));
  const asksLater = !!source?.later;
  useEffect(() => {
    if (!query || !asksLater) return;
    let live = true;
    const timer = setTimeout(() => {
      void later(query)
        .catch(() => [])
        .then((list) => {
          if (live) setFound({ query, list });
        });
    }, SEARCH_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, asksLater]);
  const list = !active ? [] : source?.now ? source.now(query) : found.query === query ? found.list : [];
  const at = highlight.query === query ? Math.min(highlight.at, Math.max(0, list.length - 1)) : 0;

  // A pick sets the text; once it is in the box, the caret goes after the name.
  useLayoutEffect(() => {
    const el = ref.current;
    if (pendingCaret.current === null || !el) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text, ref]);

  // The list hangs from the `@` being typed, as Messages' and Mail's do (plan 2026-11-12-1505, U20), kept inside the
  // box's own width.
  const start = active?.start ?? null;
  const shown = list.length;
  useLayoutEffect(() => {
    const el = ref.current;
    const node = listRef.current;
    const host = node?.offsetParent;
    if (!el || !node || !host || start === null) return;
    const want = el.getBoundingClientRect().left - host.getBoundingClientRect().left + caretOffset(el, start).left;
    node.style.left = `${fitLeft(want, node.offsetWidth, host.clientWidth)}px`;
  }, [ref, start, shown]);

  const pick = (c: MentionChoice) => {
    if (!active || caret === null) return;
    const next = insertMention(text, active.start, caret, c.insert);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    setText(next.text);
    c.onPick?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (list.length === 0 || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight({ query, at: (at + step + list.length) % list.length });
    } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) pick(list[at]);
    else if (e.key === "Escape") setDismissed(active?.start ?? null);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const onCaret = (el: HTMLTextAreaElement | null) => setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);

  const drawn =
    list.length === 0 ? null : (
      <div ref={listRef} className="loki-mail-suggest loki-mention-list" role="listbox" aria-label="People to Mention">
        {list.map((c, i) => (
          <button
            key={c.key}
            type="button"
            role="option"
            aria-selected={i === at}
            className="loki-mail-suggest-row"
            // Before the box's blur, so the caret it knows is where the name goes.
            onPointerDown={(e) => {
              e.preventDefault();
              pick(c);
            }}
          >
            <span className="loki-mail-suggest-name">{c.label}</span>
            {c.sub && <Meta>{c.sub}</Meta>}
          </button>
        ))}
      </div>
    );
  return { list: drawn, onKeyDown, onCaret };
}
