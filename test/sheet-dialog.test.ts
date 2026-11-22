import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../app/src/ui/dialog.tsx", () => import("./fixtures/inline-dialog.ts"));
const { Sheet, sheetCloses } = await import("../app/src/components/index.tsx");

const noop = () => {};

describe("a desktop sheet", () => {
  test("is a modal dialog named by its label, in the veil and the card, sized and placed as asked", () => {
    const out = renderToStaticMarkup(createElement(Sheet, { label: "Rename chat", onClose: noop, width: 440, top: "18vh", children: "Body" }));
    expect(out).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Rename chat"/);
    expect(out).toContain('class="loki-sheet-veil"');
    expect(out).toContain('class="loki-sheet-viewport"');
    expect(out).toContain("--sheet-top:18vh");
    expect(out).toMatch(/class="loki-sheet loki-sheet-card"[^>]*style="width:440px"/);
    expect(out).toContain(">Body</div>");
  });

  test("a clear sheet dims nothing, and a tall one scrolls its viewport", () => {
    const out = renderToStaticMarkup(createElement(Sheet, { label: "Keys", onClose: noop, clear: true, scroll: true, children: "x" }));
    expect(out).toContain("loki-sheet-veil loki-sheet-veil--clear");
    expect(out).toContain("loki-sheet-viewport loki-sheet-viewport--scroll");
  });

  test("Esc closes it only when it lets Esc; a click outside whenever it can close; Welcome on neither", () => {
    expect(sheetCloses("escape-key", { canClose: true, escape: true })).toBe(true);
    expect(sheetCloses("escape-key", { canClose: true, escape: false })).toBe(false);
    expect(sheetCloses("outside-press", { canClose: true, escape: false })).toBe(true);
    expect(sheetCloses("outside-press", { canClose: false, escape: false })).toBe(false);
    expect(sheetCloses("escape-key", { canClose: false, escape: true })).toBe(false);
  });
});

describe("the phone's bottom sheet", () => {
  test("keeps its own veil and card, outside the Dialog", () => {
    const out = renderToStaticMarkup(
      createElement(Sheet, { label: "Labels", onClose: noop, placement: "bottom", className: "loki-phone-sheet", children: "x" }),
    );
    expect(out).toContain('class="loki-veil loki-veil--bottom"');
    expect(out).toContain("loki-sheet loki-sheet-card loki-sheet-card--bottom loki-phone-sheet");
    expect(out).not.toContain("loki-sheet-viewport");
  });
});
