/**
 * Stacking order, in one place. Inline z-indexes elsewhere are only for stacking inside a component
 * (a picker over its own header); anything that stacks against the window uses these.
 */
export const LAYER = {
  /** The chat panel, over the sheet. */
  panel: 100,
  /** The chat's toggle bubble, over the panel's edge. */
  bubble: 101,
  /** The rail, over everything on the sheet. */
  rail: 110,
  /** Sheets and dialogs: the desks tree, the picker, new desk. */
  modal: 200,
  /** The task capture (⌘T works from anywhere, the desks tree included), so it sits over a sheet. */
  capture: 210,
  /** Notices, briefly, over all of it. */
  toast: 300,
} as const;
