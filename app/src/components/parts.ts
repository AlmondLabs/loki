import type { Ref } from "react";

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const FOCUSABLE = 'a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex="-1"])';

export const firstControl = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>("[autofocus]") ??
  [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled")) ??
  null;

export function assignRef<T>(target: Ref<T> | undefined, node: T | null) {
  if (typeof target === "function") target(node);
  else if (target) target.current = node;
}
