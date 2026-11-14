import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LabelPicker } from "../app/src/desk/label-picker.tsx";
import { outsideItem } from "./fixtures/outside-item.ts";

// Plan 2026-11-12-1505, U20: an email card's label picker is a menu hung over the card from its Label move.

const noop = () => {};
const picker = () =>
  createElement(LabelPicker, {
    item: outsideItem("Spring timetable"),
    labelsOf: () => Promise.resolve([]),
    onPick: () => Promise.resolve(null),
    onCancel: noop,
  });

describe("the label picker", () => {
  test("is a popover menu named in title case, with no heading of its own while the labels come", () => {
    const out = renderToStaticMarkup(picker());
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
});
