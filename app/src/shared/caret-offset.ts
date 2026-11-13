/** The styles that decide where a textarea lays out its text; a mirror with the same ones wraps the same way. */
const MIRRORED = [
  "boxSizing",
  "width",
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
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
] as const;

/**
 * Where the character at `index` sits in a textarea, in pixels from the corner of its border box, as it is laid out
 * now (wrapped lines and its scroll included). A textarea does not say where its caret is, so the text before the
 * index is laid out in a hidden copy with the same styles and the place after it is read there. Used to hang a
 * type-ahead list from the word being typed (plan 2026-11-12-1505, U20).
 */
export function caretOffset(el: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const mirror = document.createElement("div");
  const from = getComputedStyle(el);
  for (const name of MIRRORED) mirror.style[name] = from[name];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = el.value.slice(0, index);
  const mark = document.createElement("span");
  // A character to measure at: an empty span at a line's end can sit on either line.
  mark.textContent = el.value.slice(index, index + 1) || ".";
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const at = { left: mark.offsetLeft - el.scrollLeft, top: mark.offsetTop - el.scrollTop };
  mirror.remove();
  return at;
}

/** A list's left edge so it starts at `want` but stays inside a box `room` wide: never past the right edge, never before the left. */
export function fitLeft(want: number, width: number, room: number): number {
  return Math.max(0, Math.min(want, room - width));
}
