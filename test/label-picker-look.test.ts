import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ThemeProvider } from "../app/src/theme.tsx";
import { LabelPicker } from "../app/src/desk/label-picker.tsx";
import { outsideItem } from "./fixtures/outside-item.ts";

// Plan 2026-11-12-1505, U20: an email card's label picker under Liquid Glass is a menu hung over the card from its
// Label move. ThemeProvider reads the palette from storage, so the apple family is put there for the glass cases.

const noop = () => {};
let saved: Storage | undefined;
const withPalette = (palette: string | null) => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "loki.palette" ? palette : null), setItem: noop },
  });
};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));
const picker = () =>
  createElement(LabelPicker, {
    item: outsideItem("Spring timetable"),
    labelsOf: () => Promise.resolve([]),
    onPick: () => Promise.resolve(null),
    onCancel: noop,
  });

beforeEach(() => {
  saved = globalThis.localStorage;
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
});

describe("the label picker under Liquid Glass", () => {
  test("is a popover menu named in title case, with no heading of its own while the labels come", () => {
    withPalette("apple");
    const out = html(picker());
    expect(out).toContain('class="loki-popover loki-label-menu"');
    expect(out).toContain('aria-label="Add a Label"');
    expect(out).toContain("Loading labels…");
    expect(out).not.toContain("add a label");
  });

  test("takes no room in the card: its slot above the moves collapses round it", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");
    const slot = /\.loki-card-picker:has\(> \.loki-label-menu\) \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(slot).toContain("height: 0");
    expect(slot).toContain("padding: 0");
  });

  test("stays the card's own panel in today's look, under its heading", () => {
    withPalette(null);
    const out = html(picker());
    expect(out).not.toContain("loki-label-menu");
    expect(out).toContain("add a label");
    expect(out).toContain("asking for its labels…");
  });
});
