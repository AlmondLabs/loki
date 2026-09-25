import { useEffect, type RefObject } from "react";
import { prefersReducedMotion } from "../kit/motion";
import { spring } from "../kit/spring";

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
      // Only a change of height is the keyboard: the visible part scrolling moves the shell without resizing it.
      const before = el.getBoundingClientRect().height;
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
      rideKeyboard(el, before - el.getBoundingClientRect().height);
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

/** Less than this is the page settling (an accessory bar, a scroll), not the keyboard coming or going. */
const KEYBOARD_MIN = 80;

/**
 * The shell's bottom edge moved by `dy` (up is positive) because the keyboard came or went. The browser
 * only says so once the keyboard is already there, so the message box would jump. It is drawn back where it
 * was and springs to its new place instead, as iOS moves a box with the keyboard: transform only, so the
 * thread under it lays out once. A ride already under way starts from where it has got to.
 */
function rideKeyboard(shell: HTMLElement, dy: number): void {
  if (Math.abs(dy) < KEYBOARD_MIN || prefersReducedMotion()) return;
  const box = shell.querySelector<HTMLElement>(".loki-composer");
  if (!box || typeof box.animate !== "function" || !box.getClientRects().length) return;
  let from = dy;
  for (const a of box.getAnimations()) {
    if (a.id !== "loki-keyboard") continue;
    const now = getComputedStyle(box).transform;
    if (now !== "none") from += new DOMMatrixReadOnly(now).m42;
    a.cancel();
  }
  const s = spring("smooth");
  box.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: s.ms, easing: s.easing, id: "loki-keyboard" });
}
