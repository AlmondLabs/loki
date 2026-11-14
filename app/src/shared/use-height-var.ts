import { useLayoutEffect } from "react";

/** The heights Liquid Glass lays the thread under (tokens.css defines both, 0 by default). */
export type HeightVar = "--loki-header-height" | "--loki-dock-height";

/**
 * Keeps an element's height in a custom property on its parent (plan 2026-11-12-1505, U4): the chat pane's header and its dock of decisions, box and moves float over the thread, which pads itself by these so
 * its first and last rows are never hidden beneath them. Measured by a ResizeObserver, so it follows the box growing
 * or an approval arriving without a render of its own; the property is removed when the element goes.
 */
export function useHeightVar(get: () => HTMLElement | null, name: HeightVar): void {
  useLayoutEffect(() => {
    const el = get();
    const host = el?.parentElement;
    if (!el || !host) return;
    const set = () => host.style.setProperty(name, `${el.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => {
      observer.disconnect();
      host.style.removeProperty(name);
    };
  }, [get, name]);
}
