import { useState, type RefObject } from "react";
import { Field, IconButton } from "../components";
import { formatKeys } from "../shell/keymap";
import { ChevronUpIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

/**
 * Find in the transcript, on the browser's own text search (window.find) so matches are wherever
 * the text is, wrapping. Enter finds the next match, ⇧Enter the previous, Esc closes and hands
 * focus back to the message box; a hit unpins the transcript so streaming does not pull it away.
 * `onFind` runs first, with the query, so rows outside the transcript's window are on the page to be found.
 */
export function FindBar({
  fieldRef,
  onFind,
  onFound,
  onEscape,
  onClose,
}: {
  fieldRef: RefObject<HTMLInputElement | null>;
  onFind?: (query: string) => void;
  onFound: () => void;
  onEscape: () => void;
  onClose: () => void;
}) {
  const [findQuery, setFindQuery] = useState("");
  const findNext = (backwards = false) => {
    const q = findQuery.trim();
    if (!q) return;
    // A long thread mounts only its newest rows: the host mounts the older ones holding the text first.
    onFind?.(q);
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
    <div
      className="flex items-center gap-1.5"
      style={{
        padding: "6px 12px",
        borderBottom: "1px solid var(--loki-border)",
        background: "var(--loki-panel-header)",
      }}
    >
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
        placeholder={`Find in transcript… (${formatKeys("enter")} next · ${formatKeys("shift+enter")} previous · ${formatKeys("escape")})`}
        aria-label="Find in transcript"
        className="flex-1"
      />
      <IconButton size={24} onClick={() => findNext(true)} label="Previous match">
        <Glyph icon={ChevronUpIcon} />
      </IconButton>
      <IconButton size={24} onClick={() => findNext(false)} label="Next match">
        <Glyph icon={ChevronDownIcon} />
      </IconButton>
      <IconButton size={24} onClick={onClose} label="Close find">
        <Glyph icon={XIcon} />
      </IconButton>
    </div>
  );
}
