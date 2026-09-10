import { useEffect, useRef, useState, type RefObject } from "react";
import type { Gesture, Position, Size, WidgetLayout, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { RESIZE_MIN } from "../../../core/desk-core.ts";

/** Keyboard nudge in canvas px: arrows move or (with Alt) resize by a step; Shift takes the long step. */
const NUDGE_STEP = 8;
const NUDGE_STEP_LONG = 32;
/** Keyboard nudges commit at the drag's cadence: at most one gesture per this many ms, with a trailing commit. */
const NUDGE_COMMIT_MS = 50;
/** The live region speaks once a burst of nudges has settled. */
const ANNOUNCE_MS = 300;

/**
 * The frame's keyboard: arrows nudge, Alt+arrows resize, Enter frames it in the camera, Escape lets go.
 * Owns the pending nudge and the timer that commits it, plus the live-region text and the timer that
 * settles it. `lastSentRef` is shared with the drag's throttle so a nudge after a drag keeps the cadence.
 */
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
  // Keyboard nudges: the next position/size waiting to be committed, and the timer that commits them.
  // Committing through `gesture` (the drag's release path) keeps undo honest: the mod collapses commits
  // that land within its burst window into one step, so ⌘Z undoes a press, or a held key, at a time.
  const nudgeRef = useRef<{ position: Position | null; size: Size | null; timer: ReturnType<typeof setTimeout> | null }>({ position: null, size: null, timer: null });
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
    if (n.timer) return; // the pending commit picks up the latest values
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

  // Keys on the frame or its title bar. The body belongs to the widget (an agent's own inputs), so
  // nothing here fires for a target inside it; Enter and Escape act only on the frame itself, so the
  // control buttons keep their native Enter.
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
      else frameRef.current?.focus(); // step out of a control back to the frame
      return;
    }
    if (e.metaKey || e.ctrlKey) return; // ⌘← / ⌘→ place the chat; leave chords to the keymap
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
