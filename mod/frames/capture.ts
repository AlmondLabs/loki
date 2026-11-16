import type { FrameHandlers } from "./context.ts";

const ONCE_MAX = 500;

export function captureFrames(): FrameHandlers {
  const reportedOnce = new Set<string>();
  return {
    capture: ({ event, properties }, ctx) => {
      if (properties && typeof properties.once === "string") {
        if (reportedOnce.has(properties.once)) return;
        reportedOnce.add(properties.once);
        if (reportedOnce.size > ONCE_MAX) {
          const oldest = reportedOnce.values().next().value;
          if (oldest !== undefined) reportedOnce.delete(oldest);
        }
        delete properties.once;
      }
      ctx.track(event, properties);
    },
  };
}
