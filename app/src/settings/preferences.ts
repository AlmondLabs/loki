import type { Segment } from "../shell/keymap";

/**
 * Preferences is a sheet over the section you were in, not a section (KTD11). The segment keys act on the
 * pair: ⌘, (and ⌘6, the same binding) opens it over whatever shows and closes it again; ⌘1-5 close it and
 * go to their section. "settings" is never the segment underneath: a window that saved it (before the sheet)
 * lands on the desk.
 */
export function afterSegmentKey(id: string, now: { segment: Segment; preferences: boolean }): { segment: Segment; preferences: boolean } {
  const under: Segment = now.segment === "settings" ? "desk" : now.segment;
  if (id === "segment.settings") return { segment: under, preferences: !now.preferences };
  const to = id.slice("segment.".length) as Segment;
  return { segment: to === "settings" ? under : to, preferences: false };
}
