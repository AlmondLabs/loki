import { createSessionValue } from "../../shared/session-value";

/**
 * Whether this Mac draws the desktop thread on loki's new components (plan 094), chosen in Preferences › Appearance.
 * Off by default and kept per device, so it can ship in a nightly and be turned off without a restart. The phone never
 * reads it: its thread moves with its own plan.
 */
export const threadPreview = createSessionValue<"on" | "off">(
  "loki.thread-preview",
  (raw) => (raw === "on" ? "on" : "off"),
  () => localStorage,
);
