import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Meta, sentence } from "../components";
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

/**
 * Where people come from: at once from what the card holds (mail), or asked of the account's Mac (Slack, a reply
 * card's account), with a line to show when the account cannot search by name (plan 2026-11-14-1530, R15).
 */
export interface MentionSource {
  now?: (query: string) => MentionChoice[];
  later?: (query: string) => Promise<{ list: MentionChoice[]; notice?: string | null }>;
}

/**
 * The `@` being typed before the caret and what follows it, spaces included, since a full name has them (plan
 * 2026-11-14-1530, R18): the list stays open while someone matches; null when the caret is not in one.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\s@][^\n@]{0,39})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** The text with the `@` being typed replaced by the pick and a space, and where the caret goes after it. */
export function insertMention(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  const word = `@${insert} `;
  return { text: text.slice(0, start) + word + text.slice(caret), caret: start + word.length };
}

/** An `@` the list was put away for: where it starts and what followed it then. */
export interface MentionDismissal {
  start: number;
  query: string;
}

/**
 * Whether the list stays away for the `@` being typed: the one put away with Esc, or the name just picked, while what
 * follows it still begins with what it held then. A new `@` typed at the same place, or a name edited back, opens the
 * list again, so a person can redo a mention without leaving the card.
 */
export function isDismissed(token: { start: number; query: string }, dismissed: MentionDismissal | null): boolean {
  return dismissed !== null && token.start === dismissed.start && token.query.startsWith(dismissed.query);
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
  // The `@` the person put away with Esc or just picked a name for, so the list stays away while they go on typing.
  const [dismissed, setDismissed] = useState<MentionDismissal | null>(null);
  const [found, setFound] = useState<{ query: string; list: MentionChoice[]; notice: string | null; failed: boolean }>({
    query: "",
    list: [],
    notice: null,
    failed: false,
  });
  const [highlight, setHighlight] = useState<{ query: string; at: number }>({ query: "", at: 0 });
  const pendingCaret = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const token = source && caret !== null && caret <= text.length ? mentionAt(text, caret) : null;
  const active = token && !isDismissed(token, dismissed) ? token : null;
  const query = active?.query ?? "";
  const later = useEffectEvent(
    (q: string): Promise<{ list: MentionChoice[]; notice?: string | null }> => source?.later?.(q.trim()) ?? Promise.resolve({ list: [] }),
  );
  const asksLater = !!source?.later;
  useEffect(() => {
    if (!query || !asksLater) return;
    let live = true;
    const timer = setTimeout(() => {
      void later(query)
        .then(
          (r) => ({ list: r.list, notice: r.notice ?? null, failed: false }),
          () => ({ list: [], notice: null, failed: true }),
        )
        .then((r) => {
          if (live) setFound({ query, ...r });
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

  // What the list says instead of people (plan 2026-11-14-1530, U4): while it searches, when the search failed or the
  // account cannot search by name, and when nobody matches one word; past a space, nobody matching closes it.
  const answered = !asksLater || found.query === query;
  const status = !active
    ? null
    : !answered
      ? "Searching…"
      : found.failed && asksLater
        ? "People could not be searched just now."
        : asksLater && found.notice && list.length === 0
          ? sentence(found.notice)
          : list.length === 0 && !/\s/.test(query.trim())
            ? "No one found"
            : null;
  // The list hangs from the `@` being typed, as Messages' and Mail's do (plan 2026-11-12-1505, U20), kept inside the
  // box's own width.
  const start = active?.start ?? null;
  const shown = list.length;
  // A status line mounts a new node with nothing else changing, so its being there is part of what places it.
  const drawsSomething = shown > 0 || status !== null;
  useLayoutEffect(() => {
    const el = ref.current;
    const node = listRef.current;
    const host = node?.offsetParent;
    if (!el || !node || !host || start === null) return;
    const want = el.getBoundingClientRect().left - host.getBoundingClientRect().left + caretOffset(el, start).left;
    node.style.left = `${fitLeft(want, node.offsetWidth, host.clientWidth)}px`;
  }, [ref, start, shown, drawsSomething]);

  const pick = (c: MentionChoice) => {
    if (!active || caret === null) return;
    // The name just written stays a name: the list does not open again on it.
    setDismissed({ start: active.start, query: c.insert });
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
    else if (e.key === "Escape") setDismissed(active ? { start: active.start, query: active.query } : null);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const onCaret = (el: HTMLTextAreaElement | null) => setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null);

  const drawn =
    list.length === 0 ? (
      status && (
        <div ref={listRef} className="loki-mail-suggest loki-mention-list" role="status">
          <Meta>{status}</Meta>
        </div>
      )
    ) : (
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
