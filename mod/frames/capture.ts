import type { FrameHandlers } from "./context.ts";

/** How many `once` keys are remembered. */
const ONCE_MAX = 500;

/**
 * The app's own analytics events (views, desk switches, sends…). An event every window and phone reports (a
 * permission request each of them saw) carries a `once` key: the first report is kept, the rest dropped, and the key
 * itself is not written.
 */
export function captureFrames(): FrameHandlers {
  /** `once` keys already written, oldest first. */
  const reportedOnce = new Set<string>();
  return {
    capture: ({ event, properties }, ctx) => {
      if (properties && typeof properties.once === "string") {
        if (reportedOnce.has(properties.once)) return;
        reportedOnce.add(properties.once);
        if (reportedOnce.size > ONCE_MAX) reportedOnce.delete(reportedOnce.values().next().value!);
        delete properties.once;
      }
      ctx.track(event, properties);
    },
  };
}
