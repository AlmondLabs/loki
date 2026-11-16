import { useLayoutEffect } from "react";

export type HeightVar = "--loki-header-height" | "--loki-dock-height";

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
