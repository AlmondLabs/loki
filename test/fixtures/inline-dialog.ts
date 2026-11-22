import { createElement, Fragment, type ReactNode } from "react";

// Outside (Base UI): Base UI portals a dialog into the page once it is mounted, so `renderToStaticMarkup` draws none of
// a sheet. A test that reads a sheet mocks `app/src/ui/dialog.tsx` with these parts, drawn in place.

type PartProps = Record<string, unknown> & { children?: ReactNode };

const divPart =
  (extra: Record<string, unknown> = {}) =>
  ({ initialFocus: _baseUiInitialFocus, finalFocus: _baseUiFinalFocus, ...domProps }: PartProps) =>
    createElement("div", { ...extra, ...domProps });

const passThrough = ({ children }: PartProps) => createElement(Fragment, null, children);

export const Dialog = passThrough;
export const DialogPortal = passThrough;
export const DialogOverlay = divPart();
export const DialogViewport = divPart();
export const DialogPopup = divPart({ role: "dialog", "aria-modal": "true" });
