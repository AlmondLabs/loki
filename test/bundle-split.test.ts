import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHART_HEIGHT, ChartCard } from "../app/src/kit/index.tsx";

/**
 * What the page loads at start (plan 038): a module imported statically from one of these files is in the chunk every
 * client parses before it draws, so the surfaces, the chart library and the Settings sheet are reached only by import().
 */
const SRC = resolve(import.meta.dirname, "..", "app", "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
/** The modules a file imports statically (`import … from "x"`, `import "x"`), not those it loads with import(). */
const staticImports = (text: string): string[] => [...text.matchAll(/^\s*import\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);

describe("what loads at start (plan 038)", () => {
  test("boot loads only the surface it mounts: neither the desktop nor the phone is imported statically", () => {
    const boot = read("boot.tsx");
    expect(staticImports(boot)).not.toEqual(expect.arrayContaining(["./shell/shell"]));
    expect(staticImports(boot)).not.toEqual(expect.arrayContaining(["./phone/phone"]));
    expect(boot).toContain('import("./shell/shell")');
    expect(boot).toContain('import("./phone/phone")');
  });

  test("the widget kit reaches recharts only through the chart's own module", () => {
    expect(staticImports(read("kit/index.tsx"))).not.toContain("recharts");
    expect(staticImports(read("kit/chart-view.tsx"))).toContain("recharts");
    expect(read("kit/index.tsx")).toContain('import("./chart-view")');
  });

  test("the Settings sheet is loaded when it opens", () => {
    const views = read("shell/views.tsx");
    expect(staticImports(views)).not.toContain("../settings/settings");
    expect(views).toContain('import("../settings/settings")');
  });

  test("a chart card holds its height while its chart loads", () => {
    const html = renderToStaticMarkup(createElement(ChartCard, { data: { points: [{ x: 1, y: 2 }] }, onSet: () => {} }));
    expect(html).toBe(`<div class="loki-widget-body" style="height:${CHART_HEIGHT}px"></div>`);
  });
});
