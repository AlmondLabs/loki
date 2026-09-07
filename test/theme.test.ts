import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colors, radii, shadows, theme, tracking, type } from "../packages/core/src/theme.ts";

/**
 * app/src/kit/tokens.css is the canvas's source of truth; packages/core/src/theme.ts carries the same
 * values for clients without CSS (the phone). This test keeps them identical, key for key, and checks
 * that the scales docs/design.md lists are the ones theme.ts exports.
 */
const css = readFileSync(join(import.meta.dir, "..", "app", "src", "kit", "tokens.css"), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}", css.indexOf(":root {")));
const camel = (kebab: string) => kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Every `--loki-*: value;` in :root, by name without the prefix (multi-line values collapsed). */
const tokens = new Map<string, string>();
for (const m of root.matchAll(/--loki-([a-z-]+):\s*([^;]+);/g)) tokens.set(m[1], m[2].replace(/\s+/g, " ").trim());

const isColour = (v: string) => /^#[0-9a-f]{3,8}$|^rgba?\(|^hsla?\(/i.test(v);
const cssColours = [...tokens].filter(([, v]) => isColour(v));
const cssShadows = [...tokens].filter(([k]) => k.startsWith("shadow-")).map(([k, v]) => [k.slice("shadow-".length), v] as const);

describe("theme.ts mirrors tokens.css", () => {
  test("the CSS has colour tokens and this test found them", () => {
    expect(cssColours.length).toBeGreaterThan(10);
    expect(cssShadows.map(([k]) => k).sort()).toEqual(["float", "low", "panel", "sheet"]);
  });
  test("every CSS colour token has the same value in theme.colors", () => {
    const off = cssColours.filter(([k, v]) => (colors as Record<string, string>)[camel(k)] !== v).map(([k, v]) => `--loki-${k}: ${v} vs theme.colors.${camel(k)} = ${(colors as Record<string, string>)[camel(k)]}`);
    expect(off).toEqual([]);
  });
  test("theme.colors defines nothing the CSS lacks", () => {
    const cssKeys = new Set(cssColours.map(([k]) => camel(k)));
    expect(Object.keys(colors).filter((k) => !cssKeys.has(k))).toEqual([]);
  });
  test("the four shadows match, and no extra shadows are defined", () => {
    expect(Object.fromEntries(cssShadows)).toEqual({ ...shadows });
  });
  test("--loki-radius is the card radius", () => {
    expect(tokens.get("radius")).toBe(`${radii.card}px`);
  });
  test("the type scale is the one docs/design.md lists", () => {
    expect(Object.values(type).sort((a, b) => a - b)).toEqual([9.5, 10.5, 12, 13.5, 15, 17, 22, 28]);
    expect(type.body).toBe(13.5);
    expect(type.rowTitle).toBe(15);
    expect(type.cardTitle).toBe(17);
  });
  test("the radii are the ones docs/design.md lists", () => {
    expect(Object.values(radii).sort((a, b) => a - b)).toEqual([6, 8, 12, 999]);
  });
  test("tracking is 0.06em (mono meta) and 0.14em (labels), as tokens.css says", () => {
    expect(tracking).toEqual({ meta: 0.06, label: 0.14 });
    expect(css).toContain("letter-spacing: 0.14em");
  });
  test("theme bundles the five scales", () => {
    expect(Object.keys(theme).sort()).toEqual(["colors", "radii", "shadows", "tracking", "type"]);
  });
});
