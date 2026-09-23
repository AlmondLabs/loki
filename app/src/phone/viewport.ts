import { useEffect, type RefObject } from "react";

/**
 * The on-screen keyboard. iOS Safari (and Chrome's default) lay the page out at full height and only
 * shrink the visual viewport when the keyboard comes up, so a fixed shell keeps its composer under the
 * keyboard. Where that happens the shell is fitted to what is visible; where the browser resizes the
 * layout itself, or there is no visualViewport, nothing changes and 100dvh does the work.
 */

type VisualViewportLike = { height: number; offsetTop: number; scale: number };

/**
 * How many CSS pixels of the layout the keyboard takes: the layout height the visual viewport no longer
 * shows. offsetTop is left out on purpose: iOS scrolls the visual viewport to show the caret, which moves
 * where the visible part sits but does not shrink the keyboard. 0 without a visual viewport, when zoomed
 * (pinch shrinks the visual viewport too; that is not a keyboard), and for sub-pixel noise.
 */
export function keyboardInset(layoutHeight: number, vv: VisualViewportLike | null | undefined): number {
  if (!vv || vv.scale > 1.01) return 0;
  const hidden = layoutHeight - vv.height;
  return hidden >= 1 ? Math.round(hidden) : 0;
}

/**
 * Fits the shell to the visible area while the keyboard is up: `data-keyboard` on it, with the visible
 * top and height as --phone-viewport-top / --phone-viewport-height (phone.css). Removed as the keyboard
 * goes. A no-op without visualViewport.
 */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const el = ref.current;
    if (!vv || !el) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const inset = keyboardInset(window.innerHeight, vv);
      if (inset > 0) {
        el.dataset.keyboard = "";
        el.style.setProperty("--phone-viewport-top", `${Math.round(vv.offsetTop)}px`);
        el.style.setProperty("--phone-viewport-height", `${Math.round(vv.height)}px`);
      } else if ("keyboard" in el.dataset) {
        delete el.dataset.keyboard;
        el.style.removeProperty("--phone-viewport-top");
        el.style.removeProperty("--phone-viewport-height");
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    apply();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    };
  }, [ref]);
}
