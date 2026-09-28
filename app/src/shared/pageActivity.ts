import type { Activity } from "../../../core/attention/activeClock.ts";

/** Whether the page is in front of you: visible and focused. */
const active = () => document.visibilityState !== "hidden" && document.hasFocus();

/** The window's focus and visibility, for useAttention's dwell clock (core/attention/activeClock.ts). */
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
