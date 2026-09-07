import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The design tokens are a contract: inline styles pick from the scales in app/src/kit/tokens.css
 * and the layers in app/src/kit/layers.ts. This test is the fence that keeps them from drifting again.
 */
const APP = join(import.meta.dir, "..", "app", "src");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const files = tsxFiles(APP).map((p) => ({ path: p.slice(APP.length + 1), text: readFileSync(p, "utf8") }));

/** Type scale (px): micro, meta, small, body, row title, card title, display, hero. */
const FONT_SCALE = new Set([9.5, 10.5, 12, 13.5, 15, 17, 22, 28]);
/** Radii: control, row, card/sheet, pill — plus the geometric ones used for circles and hairlines. */
const RADII = new Set([6, 8, 12, 999, 1, 3, 4, 9, 24]);
const TRACKING = new Set(["0.06em", "0.14em"]);

const findAll = (re: RegExp, pick: (m: RegExpMatchArray) => string) =>
  files.flatMap((f) => [...f.text.matchAll(re)].map((m) => `${f.path}: ${pick(m)}`));

describe("design tokens: inline styles stay on the scales", () => {
  test("no literal colours — every colour is a --loki token", () => {
    const hits = findAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|rgba?\([^)]*\)/g, (m) => m[0]).filter((h) => !h.includes("AgentChip.tsx")); // the agent hue is computed, not a token
    expect(hits).toEqual([]);
  });
  test("font sizes come from the type scale", () => {
    const off = findAll(/fontSize: ([0-9.]+)(?![0-9.])/g, (m) => m[1]).filter((h) => !FONT_SCALE.has(Number(h.split(": ").pop())));
    expect(off).toEqual([]);
  });
  test("radii come from the radius scale", () => {
    const off = findAll(/borderRadius: ([0-9]+)(?![0-9])/g, (m) => m[1]).filter((h) => !RADII.has(Number(h.split(": ").pop())));
    expect(off).toEqual([]);
  });
  test("shadows are the four named shadows", () => {
    const off = findAll(/boxShadow: "([^"]+)"/g, (m) => m[1]).filter((h) => !/var\(--loki-shadow-(sheet|float|panel|low)\)/.test(h));
    expect(off).toEqual([]);
  });
  test("tracking is 0.06em (mono meta) or 0.14em (labels)", () => {
    const off = findAll(/letterSpacing: "([^"]+)"/g, (m) => m[1]).filter((h) => !TRACKING.has(h.split(": ").pop()!));
    expect(off).toEqual([]);
  });
  test("window-level stacking uses LAYER, never a big literal", () => {
    const off = findAll(/zIndex: ([0-9]{3,})/g, (m) => m[1]);
    expect(off).toEqual([]);
  });
});
