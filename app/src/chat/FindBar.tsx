import { useState, type RefObject } from "react";
import { Field, IconButton } from "../components";

/**
 * Find in the transcript, on the browser's own text search (window.find) so matches are wherever
 * the text is, wrapping. Enter finds the next match, ⇧Enter the previous, Esc closes and hands
 * focus back to the message box; a hit unpins the transcript so streaming does not pull it away.
 */
export function FindBar({ fieldRef, onFound, onEscape, onClose }: { fieldRef: RefObject<HTMLInputElement | null>; onFound: () => void; onEscape: () => void; onClose: () => void }) {
  const [findQuery, setFindQuery] = useState("");
  const findNext = (backwards = false) => {
    const q = findQuery.trim();
    if (!q) return;
    const w = window as Window & { find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrap?: boolean) => boolean };
    const found = w.find?.(q, false, backwards, true) ?? false;
    if (found) {
      const sel = document.getSelection();
      const node = sel?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      el?.scrollIntoView({ block: "center" });
      onFound();
    }
    fieldRef.current?.focus();
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--loki-border)", background: "var(--loki-panel-header)" }}>
      <Field
        ref={fieldRef}
        size="sm"
        type="search"
        name="find-in-transcript"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        value={findQuery}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            findNext(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onEscape();
          }
        }}
        placeholder="find in transcript… (↵ next · ⇧↵ previous · esc)"
        aria-label="find in transcript"
        style={{ flex: 1 }}
      />
      <IconButton size={24} onClick={() => findNext(true)} label="previous match">↑</IconButton>
      <IconButton size={24} onClick={() => findNext(false)} label="next match">↓</IconButton>
      <IconButton size={24} onClick={onClose} label="close find">×</IconButton>
    </div>
  );
}
