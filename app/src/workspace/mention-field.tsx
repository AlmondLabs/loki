import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ReplyMention } from "../../../core/frame-types.ts";
import { mentionSpans } from "../../../core/mentions.ts";

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

export function MentionMarks({ text, mentions, field }: { text: string; mentions: readonly ReplyMention[]; field: RefObject<HTMLTextAreaElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  const spans = mentionSpans(text, mentions);
  const shown = spans.length > 0;
  useLayoutEffect(() => {
    const box = field.current;
    const marks = layer.current;
    if (!box || !marks) return;
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
    let frame = 0;
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              fit();
            });
          });
    resized?.observe(box);
    return () => {
      box.removeEventListener("scroll", follow);
      if (frame) cancelAnimationFrame(frame);
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
