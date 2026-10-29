import type { Activity } from "../../../core/attention/active-clock.ts";

/** Whether the page is in front of you: visible and focused. */
const active = () => document.visibilityState !== "hidden" && document.hasFocus();

/** The window's focus and visibility, for useAttention's dwell clock (core/attention/active-clock.ts). */
export const pageActivity: Activity = (set) => {
  const sync = () => set(active());
  sync();
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  return () => {
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
    document.removeEventListener("visibilitychange", sync);
  };
};

/** Whether the page is shown at all (a hidden tab, a minimised window, a phone app in the background), for useAttention's idle timers. */
export const pageVisibility: Activity = (set) => {
  const sync = () => set(document.visibilityState !== "hidden");
  sync();
  document.addEventListener("visibilitychange", sync);
  return () => document.removeEventListener("visibilitychange", sync);
};
