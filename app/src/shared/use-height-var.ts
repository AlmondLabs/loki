import { useLayoutEffect } from "react";

export type HeightVar = "--loki-header-height" | "--loki-dock-height" | "--phone-top-clearance";

export function useHeightVar(get: () => HTMLElement | null, name: HeightVar): void {
  useLayoutEffect(() => {
    const el = get();
    const host = el?.parentElement;
    if (!el || !host) return;
    let prev = "";
    let frame = 0;
    const set = () => {
      const next = `${el.offsetHeight}px`;
      if (next === prev) return;
      prev = next;
      host.style.setProperty(name, next);
    };
    set();
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        set();
      });
    });
    observer.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      host.style.removeProperty(name);
    };
  }, [get, name]);
}
