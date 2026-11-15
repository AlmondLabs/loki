import type { Ref } from "react";

/**
 * Small helpers both halves of the primitives share: the desktop's shadcn controls in index.tsx and the phone's own
 * markup in phone.tsx.
 */

/** Joins the class names that are set. */
export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** What Tab can land on inside a sheet. */
export const FOCUSABLE = 'a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex="-1"])';

/** The first control in a sheet's tab order: one taken out of it (⌘K's scope chip ×) is for the pointer, not for focus. */
export const firstControl = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>("[autofocus]") ??
  [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled")) ??
  null;

/** Hands a node to a ref the caller gave, whichever kind it is. */
export function assignRef<T>(target: Ref<T> | undefined, node: T | null) {
  if (typeof target === "function") target(node);
  else if (target) target.current = node;
}
