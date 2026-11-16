import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_ROW_PADDING, NAV_TEXT_INSET } from "../app/src/settings/page-list.tsx";
import { PANE_INSET } from "../app/src/settings/settings.tsx";

const APP = join(import.meta.dirname, "..", "app", "src");
const css = readFileSync(join(APP, "components", "components.css"), "utf8");
const settings = readFileSync(join(APP, "settings", "settings.tsx"), "utf8");
const pageList = readFileSync(join(APP, "settings", "page-list.tsx"), "utf8");

function decls(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
      const at = d.indexOf(":");
      if (at > 0) out.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
    }
  }
  return out;
}

function paddingLeft(padding: string): number {
  const w = padding.split(/\s+/);
  return parseFloat(w.length === 4 ? w[3] : w.length > 1 ? w[1] : w[0]);
}

const borderWidth = (border: string) => parseFloat(border);

describe("Preferences' pane starts at the detail panes' 20px edge", () => {
  test("the header's line and the body both pad 20 on the left, and no page has a tab track (plan 2026-11-15-1035, R10)", () => {
    expect(PANE_INSET).toBe(20);
    expect(settings).toMatch(/className="loki-pane-header-line[ "]/);
    expect(paddingLeft(decls(".loki-pane-header-line").get("padding") ?? "")).toBe(PANE_INSET);
    expect(settings).toContain("padding: `24px ${PANE_INSET}px 48px`");
    expect(settings).not.toContain("<TabRow");
  });
});

describe("Preferences' nav has one text edge", () => {
  test("the title's left padding puts it on the page names' text edge, the row's padding and border", () => {
    const row = decls(".loki-nav");
    expect(NAV_ROW_PADDING).toBe(paddingLeft(row.get("padding") ?? ""));
    expect(NAV_TEXT_INSET).toBe(NAV_ROW_PADDING + borderWidth(row.get("border") ?? ""));
    expect(settings).toContain("padding: `4px ${NAV_TEXT_INSET}px 12px`");
  });
  test("the search field's text starts there too: its border is the row's, and it takes the row's padding", () => {
    expect(borderWidth(decls(".loki-field").get("border") ?? "")).toBe(NAV_TEXT_INSET - NAV_ROW_PADDING);
    expect(pageList).toContain("style={{ paddingInline: NAV_ROW_PADDING }}");
  });
});
