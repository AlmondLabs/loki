import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The design tokens are a contract: inline styles pick from the scales in app/src/kit/tokens.css
 * and the layers in app/src/kit/layers.ts. This test is the fence that keeps them from drifting again.
 *
 * It reads every .tsx, .ts and .css under app/src (the first version read .tsx only, and the drift
 * moved into chat/ui.ts and chat.css), plus the page's own colour in index.html and the manifest.
 */
const APP = join(import.meta.dir, "..", "app", "src");
const TOKENS = join(APP, "kit", "tokens.css");

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}
const read = (p: string) => ({ path: p.slice(APP.length + 1), text: readFileSync(p, "utf8") });
const files = walk(APP, (n) => /\.(tsx|ts|css)$/.test(n) && !n.endsWith(".d.ts")).map(read);
const code = files.filter((f) => !f.path.endsWith(".css"));
const css = files.filter((f) => f.path.endsWith(".css"));
const tokens = readFileSync(TOKENS, "utf8");

/** Type scale (px): micro, meta, label (.loki-label), small, body, row title, card title, display, hero. */
const FONT_SCALE = new Set([9.5, 10.5, 11, 12, 13.5, 15, 17, 22, 28]);
/** Radii: control, row, card/sheet, pill — plus the geometric ones used for circles and hairlines. */
const RADII = new Set([6, 8, 12, 999, 1, 3, 4, 9, 24]);
const TRACKING = new Set(["0.06em", "0.14em"]);
/** The agent's hue is computed, not a token; its glyph size is derived from the face size. */
const COMPUTED = (hit: string) => hit.startsWith("desk/AgentChip.tsx:");

const findAll = (list: typeof files, re: RegExp, pick: (m: RegExpMatchArray) => string) =>
  list.flatMap((f) => [...f.text.matchAll(re)].map((m) => `${f.path}: ${pick(m)}`));
const numbers = (expr: string) => [...expr.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const value = (hit: string) => hit.slice(hit.indexOf(": ") + 2);

describe("design tokens: every style stays on the scales", () => {
  test("no literal colours — every colour is a --loki token", () => {
    const re = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
    const hits = findAll(files, re, (m) => m[0]).filter((h) => !COMPUTED(h) && !h.startsWith("kit/tokens.css"));
    expect(hits).toEqual([]);
  });
  test("font sizes come from the type scale (inline, px strings, expressions, css)", () => {
    const inline = findAll(code, /fontSize: ([^,}\n]+)/g, (m) => m[1].trim()).filter((h) => !COMPUTED(h));
    const off = inline.filter((h) => numbers(value(h)).some((n) => !FONT_SCALE.has(n)));
    const inCss = findAll(files, /font-size:\s*([\d.]+)px/g, (m) => m[1]).filter((h) => !FONT_SCALE.has(Number(value(h))));
    expect([...off, ...inCss]).toEqual([]);
  });
  test("radii come from the radius scale", () => {
    const inline = findAll(code, /borderRadius: ([^,}\n]+)/g, (m) => m[1].trim());
    const off = inline.filter((h) => numbers(value(h).replace(/50%/g, "")).some((n) => n !== 0 && !RADII.has(n)));
    const inCss = findAll(files, /border-radius:\s*([\d.]+)px/g, (m) => m[1]).filter((h) => !RADII.has(Number(value(h))));
    expect([...off, ...inCss]).toEqual([]);
  });
  test("shadows are the four named shadows", () => {
    const off = findAll(code, /boxShadow: "([^"]+)"/g, (m) => m[1]).filter((h) => !/var\(--loki-shadow-(sheet|float|panel|low)\)/.test(h));
    expect(off).toEqual([]);
  });
  test("tracking is 0.06em (mono meta) or 0.14em (labels)", () => {
    const inline = findAll(code, /letterSpacing: "([^"]+)"/g, (m) => m[1]).filter((h) => !TRACKING.has(value(h)));
    const inCss = findAll(files, /letter-spacing:\s*([\d.]+em)/g, (m) => m[1]).filter((h) => !TRACKING.has(value(h)));
    expect([...inline, ...inCss]).toEqual([]);
  });
  test("faces are the four --loki fonts", () => {
    const off = findAll(code, /fontFamily: "([^"]+)"/g, (m) => m[1]).filter((h) => !/^var\(--loki-(font|display|label|mono)\)$|^inherit$/.test(value(h)));
    expect(off).toEqual([]);
  });
  test("window-level stacking uses LAYER, never a big literal or arithmetic on one", () => {
    const big = findAll(code, /zIndex: ([0-9]{3,})/g, (m) => m[1]);
    const math = findAll(code, /zIndex: (LAYER\.\w+ [+-] \d+)/g, (m) => m[1]);
    expect([...big, ...math]).toEqual([]);
  });
  test("nothing turns the focus outline off — the brass ring in tokens.css is the one focus style", () => {
    const inline = findAll(code, /outline: "none"/g, (m) => m[0]);
    const inCss = findAll(css, /outline:\s*none/g, (m) => m[0]);
    expect([...inline, ...inCss]).toEqual([]);
  });
});

describe("design tokens: definitions and uses agree", () => {
  const defined = new Set([...tokens.matchAll(/^\s*(--loki-[a-z0-9-]+):/gm)].map((m) => m[1]));
  test("every var(--loki-*) used is defined in tokens.css", () => {
    const used = new Set(files.filter((f) => f.path !== "kit/tokens.css").flatMap((f) => [...f.text.matchAll(/var\((--loki-[a-z0-9-]+)\)/g)].map((m) => m[1])));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });
  test("every token defined is used somewhere", () => {
    const rest = files.filter((f) => f.path !== "kit/tokens.css").map((f) => f.text).join("\n");
    expect([...defined].filter((t) => !rest.includes(`var(${t})`))).toEqual([]);
  });
  test("every loki-* class a component names has a rule", () => {
    // Components name classes in className=…; the primitives in ui/ build them from string maps, so every loki-* string there counts.
    const named = new Set(code.flatMap((f) => [...f.text.matchAll(f.path.startsWith("ui/") ? /"(loki-[a-z0-9-]+)"/g : /className=(?:"[^"]*"|\{[^}]*\})/g)].flatMap((m) => [...m[0].matchAll(/loki-[a-z0-9-]+/g)].map((c) => c[0]))));
    const ruled = new Set(files.flatMap((f) => [...f.text.matchAll(/\.(loki-[a-z0-9-]+)/g)].map((m) => m[1])));
    expect([...named].filter((c) => !ruled.has(c))).toEqual([]);
  });
  test("the page's own colour is --loki-bg in index.html and the manifest", () => {
    const bg = tokens.match(/--loki-bg:\s*(#[0-9a-fA-F]{6})/)![1];
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    const manifest = readFileSync(join(APP, "..", "public", "manifest.webmanifest"), "utf8");
    expect(html.match(/name="theme-color" content="(#[0-9a-fA-F]{6})"/)?.[1]).toBe(bg);
    expect(html.match(/html \{ background: (#[0-9a-fA-F]{6})/)?.[1]).toBe(bg); // the fallback's ground, before any stylesheet
    expect([...manifest.matchAll(/"(?:background_color|theme_color)":\s*"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1])).toEqual([bg, bg]);
  });
});
