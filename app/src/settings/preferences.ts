import type { Segment } from "../shell/keymap";

export function afterSegmentKey(id: string, now: { segment: Segment; preferences: boolean }): { segment: Segment; preferences: boolean } {
  const under: Segment = now.segment === "settings" ? "desk" : now.segment;
  if (id === "segment.settings") return { segment: under, preferences: !now.preferences };
  const to = id.slice("segment.".length) as Segment;
  return { segment: to === "settings" ? under : to, preferences: false };
}
