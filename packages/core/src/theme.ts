/**
 * The drafting-table design tokens as plain values, for clients that cannot read
 * app/src/kit/tokens.css (the phone). The CSS stays the source for the canvas;
 * test/theme.test.ts keeps the two identical, key for key.
 *
 * Ink-slate ground, paper-white data, brass for anything that needs you
 * (approvals, unread), verdigris for live/positive, oxblood for failure.
 */

/** `--loki-<kebab>` in tokens.css becomes camelCase here: `--loki-panel-header` → `panelHeader`. */
export const colors = {
  bg: "#12151b",
  panel: "#1a1e27",
  panelHeader: "#1f2430",
  border: "#2b313d",
  fg: "#e7e3d8",
  muted: "#8b909c",
  accent: "#c9a45c",
  accentSoft: "#262c39",
  brassSoft: "rgba(201, 164, 92, 0.1)",
  positive: "#6fb3a4",
  negative: "#c0665b",
  grid: "#2c3240",
  /** Wells (inputs), the agent's bubble, veils and glows: the few surfaces that are not panel or bg. */
  well: "#0f1218",
  bubble: "#20252e",
  veil: "rgba(8, 8, 10, 0.45)",
  brassGlow: "rgba(201, 164, 92, 0.28)",
  hairline: "rgba(255, 255, 255, 0.06)",
} as const;

/** Shadows as the CSS writes them: sheet (modals), float (popovers), panel (the chat), low (small plates). */
export const shadows = {
  sheet: "0 30px 90px rgba(0, 0, 0, 0.6)",
  float: "0 18px 60px rgba(0, 0, 0, 0.55)",
  panel: "0 8px 24px rgba(0, 0, 0, 0.45)",
  low: "0 6px 20px rgba(0, 0, 0, 0.4)",
} as const;

/** Type scale (px): micro (labels, kbd, rail), meta (mono details), small, body, row title, card title, display, hero. */
export const type = {
  micro: 9.5,
  meta: 10.5,
  small: 12,
  body: 13.5,
  rowTitle: 15,
  cardTitle: 17,
  display: 22,
  hero: 28,
} as const;

/** Radii (px): control, row, card / sheet (`--loki-radius`), pill. Circles use half their size. */
export const radii = {
  control: 6,
  row: 8,
  card: 12,
  pill: 999,
} as const;

/** Tracking, in em: mono meta and condensed labels (.loki-label). */
export const tracking = {
  meta: 0.06,
  label: 0.14,
} as const;

export const theme = { colors, shadows, type, radii, tracking } as const;
export type Theme = typeof theme;
