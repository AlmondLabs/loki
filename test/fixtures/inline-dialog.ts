import { createElement, Fragment, type ReactNode } from "react";

/**
 * shadcn's Dialog parts drawn in place, for a static render: Base UI portals a dialog into the page once it is mounted,
 * so `renderToStaticMarkup` draws none of a desktop sheet. A test that reads what a sheet holds mocks `app/src/ui/dialog.tsx`
 * with this module (`vi.mock("../app/src/ui/dialog.tsx", () => import("./fixtures/inline-dialog.ts"))`).
 */

type PartProps = Record<string, unknown> & { children?: ReactNode };

/** A part as a div with its props, minus Base UI's own (focus targets, the open state). */
const part =
  (extra: Record<string, unknown> = {}) =>
  ({ initialFocus: _i, finalFocus: _f, ...rest }: PartProps) =>
    createElement("div", { ...extra, ...rest });

const passThrough = ({ children }: PartProps) => createElement(Fragment, null, children);

export const Dialog = passThrough;
export const DialogPortal = passThrough;
export const DialogOverlay = part();
export const DialogViewport = part();
export const DialogPopup = part({ role: "dialog", "aria-modal": "true" });
