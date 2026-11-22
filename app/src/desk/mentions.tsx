import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Meta, sentence } from "../components";
import { caretOffset, fitLeft } from "../shared/caret-offset";

export interface MentionChoice {
  key: string;
  label: string;
  sub: string | null;
  insert: string;
  onPick?: () => void;
}

export interface MentionSource {
  now?: (query: string) => MentionChoice[];
  later?: (query: string) => Promise<{ list: MentionChoice[]; notice?: string | null }>;
}

export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\s@][^\n@]{0,39})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function insertMention(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  const word = `@${insert} `;
  return { text: text.slice(0, start) + word + text.slice(caret), caret: start + word.length };
}

export interface MentionDismissal {
  start: number;
  query: string;
}

export function isDismissed(token: { start: number; query: string }, dismissed: MentionDismissal | null): boolean {
  return dismissed !== null && token.start === dismissed.start && token.query.startsWith(dismissed.query);
}

export interface MentionFieldProps {
  "aria-autocomplete": "list";
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
}

const SEARCH_WAIT_MS = 150;

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
}): {
  list: ReactNode;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onCaret: (el: HTMLTextAreaElement | null) => void;
  field: MentionFieldProps;
} {
  const [caret, setCaret] = useState<number | null>(null);
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

  useLayoutEffect(() => {
    const el = ref.current;
    if (pendingCaret.current === null || !el) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text, ref]);

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
  const start = active?.start ?? null;
  const shown = list.length;
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
    setDismissed({ start: active.start, query: c.insert });
    const next = insertMention(text, active.start, caret, c.insert);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    setText(next.text);
    c.onPick?.();
  };
  const pickBeforeBlur = (c: MentionChoice) => (e: PointerEvent) => {
    e.preventDefault();
    pick(c);
  };

  const listId = useId();
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
      <div ref={listRef} id={listId} className="loki-mail-suggest loki-mention-list" role="listbox" aria-label="People to Mention">
        {list.map((c, i) => (
          <button
            key={c.key}
            id={`${listId}-${i}`}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={i === at}
            className="loki-mail-suggest-row"
            onPointerDown={pickBeforeBlur(c)}
          >
            <span className="loki-mail-suggest-name">{c.label}</span>
            {c.sub && <Meta>{c.sub}</Meta>}
          </button>
        ))}
      </div>
    );
  const field: MentionFieldProps = {
    "aria-autocomplete": "list",
    "aria-controls": list.length > 0 ? listId : undefined,
    "aria-activedescendant": list.length > 0 ? `${listId}-${at}` : undefined,
  };
  return { list: drawn, onKeyDown, onCaret, field };
}
