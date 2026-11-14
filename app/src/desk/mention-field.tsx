import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ReplyMention } from "../../../core/frame-types.ts";
import { mentionSpans } from "../../../core/mentions.ts";

/**
 * Mentions on a reply card (plan 2026-11-14-1530, KTD9): each person the reply mentions drawn by the full name the
 * service shows, as it will notify them. In quoted text a mention takes the mention look; in the editor, which stays a
 * plain text box, a mark under each name follows the text, and editing inside a name drops its mark, which shows the
 * mention is gone.
 */

/** Text with each mention still in it drawn in the mention look, the rest as written. */
export function MentionText({ text, mentions }: { text: string; mentions: readonly ReplyMention[] }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of mentionSpans(text, mentions)) {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <span key={s.start} className="loki-mention" data-mention={s.mention.id ?? s.mention.address ?? ""}>
        {text.slice(s.start, s.end)}
      </span>,
    );
    at = s.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** What a text box's backdrop copies so its words lie where the box's do. */
const COPIED = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const;

/**
 * The marks under a text box's mentions: a layer over the box, its words invisible and laid out as the box's are, with
 * a bar under each name. It lets every pointer through, follows the box's scrolling, and is hidden from assistive
 * technology, which reads the names in the text itself.
 */
export function MentionMarks({ text, mentions, field }: { text: string; mentions: readonly ReplyMention[]; field: RefObject<HTMLTextAreaElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  const spans = mentionSpans(text, mentions);
  const shown = spans.length > 0;
  useLayoutEffect(() => {
    const box = field.current;
    const marks = layer.current;
    if (!box || !marks) return;
    // The layer is sized from the box's client width plus its borders, not its offset width, so a scroll bar the box
    // draws (Windows' classic ones) narrows the layer's words as it narrows the box's. It sizes again whenever the box
    // does, since a resized window rewraps the box's words without a key being typed.
    const fit = () => {
      const style = getComputedStyle(box);
      for (const k of COPIED) marks.style[k] = style[k];
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      marks.style.width = `${String(box.clientWidth + borders)}px`;
      marks.style.height = `${String(box.offsetHeight)}px`;
      marks.scrollTop = box.scrollTop;
    };
    fit();
    const follow = () => {
      marks.scrollTop = box.scrollTop;
    };
    box.addEventListener("scroll", follow);
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resized?.observe(box);
    return () => {
      box.removeEventListener("scroll", follow);
      resized?.disconnect();
    };
  }, [field, text, shown]);
  if (!shown) return null;
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <mark key={s.start} className="loki-mention-mark">
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  out.push(`${text.slice(at)}\n`);
  return (
    <div ref={layer} className="loki-mention-marks" aria-hidden="true">
      {out}
    </div>
  );
}
