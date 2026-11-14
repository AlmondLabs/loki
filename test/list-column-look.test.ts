import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentList } from "../app/src/shell/content-list.tsx";
import { must } from "./fixtures/must.ts";

// Plan 2026-11-14-2224, U4: the list column has one text edge and one box edge (KTD5), and its title shares a top line
// with the detail's (KTD4). These read components.css, where the glass block's rules come after and win.

const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");

/** Every declaration given to `selector` alone, in stylesheet order, so a later one wins as in the cascade. */
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

/** The first value of a padding shorthand, or `padding-top` when set after it. */
function paddingTop(rule: Map<string, string>): string {
  return rule.get("padding-top") ?? must(/^\S+/.exec(rule.get("padding") ?? ""), "a padding")[0];
}

/** The side value of a padding shorthand: its second word, else its first. */
function paddingSide(rule: Map<string, string>): string {
  const words = (rule.get("padding") ?? "").split(/\s+/);
  return words[1] ?? words[0];
}

const BARS = [".loki-content-list-bar", ".loki-pane-header-line", ".loki-card-toolbar"];

describe("the title bars share one top line (KTD4)", () => {
  test("the list's bar, the pane header's line and the card toolbar are 52 high with a 6px top padding", () => {
    for (const bar of BARS) {
      const rule = decls(bar);
      expect([bar, rule.get("min-height")]).toEqual([bar, "52px"]);
      expect([bar, paddingTop(rule)]).toEqual([bar, "6px"]);
    }
  });
  test("each bar centres its buttons and puts its title stack at the top", () => {
    for (const bar of BARS) expect([bar, decls(bar).get("align-items")]).toEqual([bar, "center"]);
    for (const stack of [".loki-content-list-head", ".loki-toolbar-title"]) {
      expect([stack, decls(stack).get("align-self")]).toEqual([stack, "flex-start"]);
    }
  });
  test("no rule puts a pane header's line back on 48 or a toolbar title's 52 of its own", () => {
    expect(css).not.toMatch(/\.loki-pane-header-line:has\(> \.loki-toolbar-title\)/);
  });
});

describe("the list's bar holds its grey line", () => {
  const html = (line?: string) =>
    renderToStaticMarkup(
      createElement(ContentList, {
        label: "All Cards",
        title: "All Cards",
        line,
        rows: [{ id: "a", title: "Budget" }],
        selectedId: null,
        onSelect: () => {},
        onEnter: () => {},
        empty: "No cards yet.",
      }),
    );
  test("the line sits in the bar's title stack, under the title, inside the drag region", () => {
    const bar = must(
      /<div class="loki-content-list-bar" data-tauri-drag-region="deep">([\s\S]*?)<div class="loki-content-list-rows"/.exec(html("Written 2h ago")),
      "the bar",
    )[1];
    expect(bar).toMatch(
      /<div class="loki-content-list-head">[\s\S]*<h2 class="loki-content-list-title">All Cards<\/h2>[\s\S]*<p class="loki-content-list-line">Written 2h ago<\/p><\/div>/,
    );
  });
  test("without a line the stack holds the title alone", () => {
    expect(html()).not.toContain("loki-content-list-line");
  });
});

describe("the list column's edges (KTD5)", () => {
  test("the search field's box and the rows' highlight start 4 in; the rows' text another 12", () => {
    expect(paddingSide(decls(".loki-content-list-search"))).toBe("4px");
    expect(paddingSide(decls(".loki-content-list-rows"))).toBe("4px");
    expect(paddingSide(decls(".loki-list-row"))).toBe("12px");
    expect(decls(".loki-content-list-search .loki-field").get("padding-inline")).toBe("calc(12px - 1px)");
  });
  test("the bar's title starts 16 in, as the rows' text does", () => {
    expect(decls(".loki-content-list-bar").get("padding")?.split(/\s+/)[3]).toBe("16px");
  });
});
