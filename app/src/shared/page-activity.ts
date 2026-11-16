import type { Activity } from "../../../core/attention/active-clock.ts";

const active = () => document.visibilityState !== "hidden" && document.hasFocus();

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

export const pageVisibility: Activity = (set) => {
  const sync = () => set(document.visibilityState !== "hidden");
  sync();
  document.addEventListener("visibilitychange", sync);
  return () => document.removeEventListener("visibilitychange", sync);
};
