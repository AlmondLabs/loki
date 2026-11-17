import { useEffect, useRef, useState, type RefObject } from "react";
import type { Gesture, Position, Size, WidgetLayout, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { RESIZE_MIN } from "../../../core/desk-core.ts";

const NUDGE_STEP = 8;
const NUDGE_STEP_LONG = 32;
const NUDGE_COMMIT_MS = 50;
const ANNOUNCE_MS = 300;

export function useFrameKeyboard({
  entry,
  layout,
  sized,
  gesture,
  onFocus,
  frameRef,
  lastSentRef,
}: {
  entry: WidgetManifestEntry;
  layout: WidgetLayout;
  sized: boolean;
  gesture: (g: Gesture) => void;
  onFocus?: (id: string) => void;
  frameRef: RefObject<HTMLDivElement | null>;
  lastSentRef: RefObject<number>;
}) {
  const nudgeRef = useRef<{ position: Position | null; size: Size | null; timer: ReturnType<typeof setTimeout> | null }>({
    position: null,
    size: null,
    timer: null,
  });
  const [announcement, setAnnouncement] = useState("");
  const announceRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
  useEffect(
    () => () => {
      if (nudgeRef.current.timer) clearTimeout(nudgeRef.current.timer);
      if (announceRef.current.timer) clearTimeout(announceRef.current.timer);
    },
    [],
  );

  const commitNudge = () => {
    const n = nudgeRef.current;
    n.timer = null;
    lastSentRef.current = performance.now();
    if (n.position) {
      const position = n.position;
      n.position = null;
      gesture({ kind: "move", id: entry.id, position });
    }
    if (n.size) {
      const size = n.size;
      n.size = null;
      gesture({ kind: "resize", id: entry.id, size });
    }
  };
  const scheduleNudge = () => {
    const n = nudgeRef.current;
    if (n.timer) return;
    n.timer = setTimeout(commitNudge, Math.max(0, NUDGE_COMMIT_MS - (performance.now() - lastSentRef.current)));
  };
  const announce = (text: string) => {
    const a = announceRef.current;
    a.text = text;
    if (a.timer) clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      a.timer = null;
      setAnnouncement(a.text);
    }, ANNOUNCE_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const onFrame = target === e.currentTarget;
    if (!onFrame && target.closest(".loki-frame-body")) return;
    if (e.key === "Enter") {
      if (!onFrame) return;
      e.preventDefault();
      e.stopPropagation();
      onFocus?.(entry.id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (onFrame) frameRef.current?.blur();
      else frameRef.current?.focus();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? NUDGE_STEP_LONG : NUDGE_STEP;
    const n = nudgeRef.current;
    if (e.altKey) {
      const el = frameRef.current;
      const base = n.size ?? (sized && layout.size ? layout.size : { w: el?.offsetWidth ?? RESIZE_MIN.w, h: el?.offsetHeight ?? RESIZE_MIN.h });
      const size = { w: Math.round(Math.max(RESIZE_MIN.w, base.w + dx * step)), h: Math.round(Math.max(RESIZE_MIN.h, base.h + dy * step)) };
      n.size = size;
      announce(`resized to ${size.w}×${size.h}`);
    } else {
      const base = n.position ?? layout.position;
      const position = { x: Math.round(base.x + dx * step), y: Math.round(base.y + dy * step) };
      n.position = position;
      announce(`moved to ${position.x}, ${position.y}`);
    }
    scheduleNudge();
  };

  return { onKeyDown, announcement };
}
