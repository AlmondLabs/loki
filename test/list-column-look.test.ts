import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentList } from "../app/src/shell/content-list.tsx";
import { must } from "./fixtures/must.ts";

const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");

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

function paddingTop(rule: Map<string, string>): string {
  return rule.get("padding-top") ?? must(/^\S+/.exec(rule.get("padding") ?? ""), "a padding")[0];
}

function paddingSide(rule: Map<string, string>): string {
  const words = (rule.get("padding") ?? "").split(/\s+/);
  return words[1] ?? words[0];
}

const BARS = [".loki-content-list-bar", ".loki-pane-header-line", ".loki-card-toolbar"];

describe("the title bars share one top line (KTD4)", () => {
  test("the list's bar, the pane header's line and the card toolbar are 52 high, their title stacks 6px down (4 of padding, 2 of margin)", () => {
    for (const bar of BARS) {
      const rule = decls(bar);
      expect([bar, rule.get("min-height")]).toEqual([bar, "52px"]);
      expect([bar, paddingTop(rule)]).toEqual([bar, "4px"]);
    }
    for (const stack of [".loki-content-list-head", ".loki-toolbar-title"]) {
      expect([stack, decls(stack).get("margin-top")]).toEqual([stack, "2px"]);
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
      /<div class="loki-content-list-bar" data-drag-region="">([\s\S]*?)<div class="loki-content-list-rows"/.exec(html("Written 2h ago")),
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

describe("Flow's rows are divided", () => {
  const list = (divided: boolean) =>
    renderToStaticMarkup(
      createElement(ContentList, {
        label: "Flow",
        title: "Flow",
        rows: [
          { id: "a", title: "Priya", preview: "Launch review" },
          { id: "b", title: "Sam", preview: "Budget" },
        ],
        selectedId: null,
        onSelect: () => {},
        onEnter: () => {},
        empty: "Caught up.",
        divided,
      }),
    );
  const divided = ".loki-content-list-rows[data-divided]";

  test("only a divided list is marked, and Flow is one", () => {
    expect(list(true)).toContain('class="loki-content-list-rows" data-divided="true"');
    expect(list(false)).not.toContain("data-divided");
    const flow = readFileSync(join(import.meta.dirname, "..", "app", "src", "workspace", "catch-up.tsx"), "utf8");
    expect(flow).toMatch(/rows=\{flowRows\(flow\.rows\)\}\s*divided\s/);
  });
  test("its rows get 8px above and below, and a hairline from the text's edge between them", () => {
    expect(decls(`${divided} .loki-list-row`).get("padding-block")).toBe("8px");
    const line = decls(`${divided} .loki-list-item + .loki-list-item::before`);
    expect(line.get("left")).toBe(`${12 + 20 + 8}px`);
    expect(line.get("right")).toBe(paddingSide(decls(".loki-list-row")));
    expect(line.get("border-top")).toBe("1px solid var(--loki-border)");
  });
  test("the lines beside the selected row go, so its fill is not cut", () => {
    expect(decls(`${divided} .loki-list-item[data-current]::before`).get("border-top-color")).toBe("transparent");
    expect(decls(`${divided} .loki-list-item[data-current] + .loki-list-item::before`).get("border-top-color")).toBe("transparent");
  });
});
