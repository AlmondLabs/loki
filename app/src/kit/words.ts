import { Children, type ReactNode } from "react";

/**
 * A label in Liquid Glass's words (plan 2026-11-12-1505, R7): its first letter a capital, the rest as written, so
 * "turn the writer on" reads "Turn the writer on". loki's own name keeps its lowercase; a label that is not plain text
 * is left alone.
 */
export function capitalFirst(text: string): string {
  if (!text || /^loki\b/.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The same for a control's children: plain text, or text leading other parts, gets its capital; anything else is kept. */
export function capitalChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") return capitalFirst(children);
  const parts = Children.toArray(children);
  if (parts.length > 1 && typeof parts[0] === "string") return [capitalFirst(parts[0]), ...parts.slice(1)];
  return children;
}
