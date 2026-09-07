/**
 * Stacking order, in one place. Inline z-indexes elsewhere are only for stacking inside a component
 * (a picker over its own header); anything that stacks against the window uses these.
 */
export const LAYER = {
  /** The chat panel and its reopen bubble, over the sheet. */
  panel: 100,
  /** The rail, over everything on the sheet. */
  rail: 110,
  /** Sheets and dialogs: the desks tree, the picker, new desk, the task capture. */
  modal: 200,
  /** Notices, briefly, over all of it. */
  toast: 300,
} as const;
