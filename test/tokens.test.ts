import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

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
// paths as "kit/tokens.css" on every system: the filters below name them with "/", and Windows joins with "\\"
const read = (p: string) => ({ path: p.slice(APP.length + 1).replaceAll("\\", "/"), text: readFileSync(p, "utf8") });
const files = walk(APP, (n) => /\.(tsx|ts|css)$/.test(n) && !n.endsWith(".d.ts")).map(read);
const code = files.filter((f) => !f.path.endsWith(".css"));
const css = files.filter((f) => f.path.endsWith(".css"));
const tokens = readFileSync(TOKENS, "utf8");

type Rgb = [number, number, number];
type Theme = "dark" | "light";
/** The colour families in tokens.css; loki's own is the bare :root, the others sit under data-palette. */
const PALETTES = ["loki", "tokyo-night"] as const;
type Palette = (typeof PALETTES)[number];
const THEMES: Theme[] = ["dark", "light"];
const selectorFor = (palette: Palette, theme: Theme) => `:root${palette === "loki" ? "" : `[data-palette="${palette}"]`}${theme === "light" ? '[data-theme="light"]' : ""}`;
const themeBlock = (palette: Palette, theme: Theme) => {
  const start = tokens.indexOf(`${selectorFor(palette, theme)} {`);
  if (start < 0) throw new Error(`no block for ${selectorFor(palette, theme)}`);
  return tokens.slice(start, tokens.indexOf("\n}", start));
};
const themeColor = (palette: Palette, theme: Theme, name: string): Rgb => {
  const raw = themeBlock(palette, theme).match(new RegExp(`--loki-${name}:\\s*([^;]+)`))?.[1].trim();
  if (!raw) throw new Error(`missing --loki-${name} in ${palette} ${theme}`);
  return parseColor(raw);
};
const parseColor = (raw: string): Rgb => {
  if (raw.startsWith("#")) return [1, 3, 5].map((i) => Number.parseInt(raw.slice(i, i + 2), 16) / 255) as Rgb;
  const hit = raw.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
  if (!hit) throw new Error(`cannot read ${raw}`);
  const lightness = Number(hit[1]) / 100;
  const chroma = Number(hit[2]);
  const hue = (Number(hit[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l0 = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m0 = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s0 = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = l0 ** 3;
  const m = m0 ** 3;
  const s = s0 ** 3;
  const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return linear.map((v) => Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))) as Rgb;
};
const luminance = (rgb: Rgb) => rgb.reduce((sum, value, i) => sum + [0.2126, 0.7152, 0.0722][i] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4), 0);
const contrast = (a: Rgb, b: Rgb) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

/** Type scale (px): micro, meta, label (.loki-label), small, body, row title, card title, display, hero. */
const FONT_SCALE = new Set([9.5, 10.5, 11, 12, 13.5, 15, 17, 22, 28]);
/** Radii: control, row, card/sheet, pill — plus the geometric ones used for circles and hairlines. */
const RADII = new Set([6, 8, 12, 999, 1, 3, 4, 9, 24]);
/**
 * Tracking. The Slack direction (2026-09-23) sets no letter-spacing: labels are sentence-case sans and meta is
 * the reading face. Neither stylesheets nor inline styles allow any (the desktop sweep removed the last of it).
 */
const TRACKING = new Set<string>([]);
/** Serif, condensed and narrow faces have no place in either presentation. */
const RETIRED_FACE = /(?<!sans-)serif|New York|Iowan|Georgia|Avenir|Condensed|Narrow/i;
/** The agent's hue is computed, not a token; its glyph size is derived from the face size. */
const COMPUTED = (hit: string) => hit.startsWith("desk/AgentChip.tsx:");

const findAll = (list: typeof files, re: RegExp, pick: (m: RegExpMatchArray) => string) =>
  list.flatMap((f) => [...f.text.matchAll(re)].map((m) => `${f.path}: ${pick(m)}`));
const numbers = (expr: string) => [...expr.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const value = (hit: string) => hit.slice(hit.indexOf(": ") + 2);

describe("design tokens: every style stays on the scales", () => {
  test("no literal colours — every colour is a --loki token", () => {
    const re = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
    // the phone's token file holds its own literals, only in custom property declarations (fenced below)
    const hits = findAll(files, re, (m) => m[0]).filter((h) => !COMPUTED(h) && !h.startsWith("kit/tokens.css") && !h.startsWith("phone/phone.css"));
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
  test("a radius that has a role is named, not a number (the phone keeps its own scale)", () => {
    const outside = (list: typeof files) => list.filter((f) => !f.path.startsWith("phone/"));
    const inline = findAll(outside(code), /borderRadius: (\d+)\b/g, (m) => m[1]).filter((h) => [6, 8, 12, 999].includes(Number(value(h))));
    const inCss = findAll(outside(css), /border-radius:\s*(\d+)px/g, (m) => m[1]).filter((h) => [6, 8, 12, 999].includes(Number(value(h))));
    expect([...inline, ...inCss]).toEqual([]);
  });
  test("a small muted or negative line is .loki-meta, not a hand-set fontSize and colour", () => {
    const off = findAll(code, /fontSize: (?:12|10\.5), color: "var\(--loki-(?:muted|negative)\)"/g, (m) => m[0]);
    expect(off).toEqual([]);
  });
  test("shadows are the four named shadows", () => {
    const off = findAll(code, /boxShadow: "([^"]+)"/g, (m) => m[1]).filter((h) => !/var\(--loki-shadow-(sheet|float|panel|low)\)/.test(h));
    expect(off).toEqual([]);
  });
  test("no tracking anywhere: no letterSpacing inline, no letter-spacing in a stylesheet", () => {
    const inline = findAll(code, /letterSpacing: ([^,}\n]+)/g, (m) => m[1].trim()).filter((h) => !TRACKING.has(value(h)));
    const inCss = findAll(files, /letter-spacing:\s*([\d.]+em)/g, (m) => m[1]).filter((h) => !TRACKING.has(value(h)));
    expect([...inline, ...inCss]).toEqual([]);
  });
  test("inline faces are the reading face or mono — never the retired display or label aliases", () => {
    const off = findAll(code, /fontFamily: ([^,}\n]+)/g, (m) => m[1].trim()).filter((h) => !/^"var\(--loki-(font|mono)\)"$|^"inherit"$|^mono \? "var\(--loki-mono\)" : undefined$/.test(value(h)));
    expect(off).toEqual([]);
    expect(findAll(code, /var\(--loki-(display|label)\)/g, (m) => m[0])).toEqual([]);
  });
  test("labels are shown as written: no uppercase transform inline, nor in a desktop stylesheet", () => {
    const inline = findAll(code, /textTransform: ([^,}\n]+)/g, (m) => m[1].trim()).filter((h) => /uppercase/.test(value(h)));
    // the phone keeps two of its own: a pairing code typed in capitals, and a kicker's first letter
    const inCss = findAll(css.filter((f) => !f.path.startsWith("phone/")), /text-transform:\s*uppercase/g, (m) => m[0]);
    expect([...inline, ...inCss]).toEqual([]);
  });
  test("stylesheets never name the retired display or label faces, and keep mono for code, data and keys", () => {
    const aliases = findAll(css.filter((f) => f.path !== "kit/tokens.css"), /font-family:\s*(var\(--loki-(?:display|label)\))/g, (m) => m[1]);
    expect(aliases).toEqual([]);
    const desktopCss = css.filter((f) => !f.path.startsWith("phone/"));
    const mono = desktopCss.flatMap((f) => [...f.text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*var\(--loki-mono\)/g)].map((m) => `${f.path}: ${m[1].trim()}`));
    // Tailwind's @theme only aliases the token (font-loki-mono); it presents nothing
    expect(mono.filter((h) => !/\b(code|pre|kbd)\b|--mono\b|@theme inline$/.test(value(h)))).toEqual([]);
  });
  test("window-level stacking uses LAYER, never a big literal or arithmetic on one", () => {
    const big = findAll(code, /zIndex: ([0-9]{3,})/g, (m) => m[1]);
    const math = findAll(code, /zIndex: (LAYER\.\w+ [+-] \d+)/g, (m) => m[1]);
    expect([...big, ...math]).toEqual([]);
  });
  test("nothing turns the focus outline off — the blue ring in tokens.css is the one focus style", () => {
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
  test("the page's own colour is --loki-bg in index.html, the manifest and the native window, for every family and both sides", () => {
    const ground = (palette: Palette, theme: Theme) => themeBlock(palette, theme).match(/--loki-bg:\s*(#[0-9a-fA-F]{6})/)![1];
    const bg = ground("loki", "dark");
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    const manifest = readFileSync(join(APP, "..", "public", "manifest.webmanifest"), "utf8");
    const rust = readFileSync(join(APP, "..", "..", "src-tauri", "src", "lib.rs"), "utf8");
    expect(html.match(/name="theme-color" content="(#[0-9a-fA-F]{6})"/)?.[1]).toBe(bg);
    for (const palette of PALETTES) {
      // the prepaint script picks the theme-color per family and theme, before any stylesheet
      const grounds = html.match(new RegExp(`"${palette}": \\{ dark: "(#[0-9a-fA-F]{6})", light: "(#[0-9a-fA-F]{6})" \\}`));
      expect(grounds?.slice(1)).toEqual([ground(palette, "dark"), ground(palette, "light")]);
      // the fallback stylesheet's ground, for a page whose CSS never arrived
      for (const theme of THEMES) {
        const selector = `html${palette === "loki" ? "" : `\\[data-palette="${palette}"\\]`}${theme === "light" ? '\\[data-theme="light"\\]' : ""}`;
        expect(html.match(new RegExp(`${selector} \\{ background: (#[0-9a-fA-F]{6})`))?.[1]).toBe(ground(palette, theme));
      }
    }
    expect([...manifest.matchAll(/"(?:background_color|theme_color)":\s*"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1])).toEqual([bg, bg]);
    // the window is created in the dark ground; the page applies the saved preference after it loads
    const native = rust.match(/background_color\(tauri::window::Color\(0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0xff\)\)/i);
    expect(`#${native?.slice(1, 4).join("")}`.toLowerCase()).toBe(bg.toLowerCase());
  });
});

describe("design tokens: the desktop's Slack direction (2026-09-23)", () => {
  const root = themeBlock("loki", "dark");
  const rule = (selector: string) => {
    const hit = tokens.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()*+?^$|\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    if (!hit) throw new Error(`no rule for ${selector}`);
    return hit[1];
  };
  test("display and label faces are the sans stack; no serif or condensed face anywhere in tokens.css", () => {
    for (const face of ["font", "display", "label"]) {
      const raw = root.match(new RegExp(`--loki-${face}:\\s*([^;]+);`))?.[1] ?? "";
      expect(raw).not.toBe("");
      expect(raw).not.toMatch(RETIRED_FACE);
      expect(raw).not.toMatch(/mono/i);
    }
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(RETIRED_FACE);
  });
  test(".loki-label is sentence-case sans: no caps, no tracking, 12px semibold muted", () => {
    const label = rule(".loki-label");
    expect(label).not.toMatch(/text-transform:\s*uppercase/);
    expect(label).not.toMatch(/letter-spacing/);
    expect(label).toMatch(/font-size:\s*12px/);
    expect(label).toMatch(/font-weight:\s*600/);
    expect(label).toMatch(/color:\s*var\(--loki-muted\)/);
  });
  test("focus flashes: a 2px accent ring that fades in a second, to a muted ring on controls and to nothing on text fields", () => {
    // the flash is the ring's colour animating from the accent; what it settles to is the rule's own outline
    expect(tokens).toMatch(/@keyframes loki-focus-flash \{ from \{ outline-color: var\(--loki-focus-flash, var\(--loki-accent\)\); \} \}/);
    const control = tokens.match(/\[tabindex\]:focus-visible \{([^}]*)\}/)?.[1] ?? "";
    expect(control).toMatch(/outline: 2px solid var\(--loki-muted\)/);
    expect(control).toMatch(/animation: loki-focus-flash 1s ease-out/);
    const field = tokens.match(/textarea\):focus-visible \{([^}]*)\}/)?.[1] ?? "";
    expect(field).toMatch(/outline: 2px solid transparent/);
    expect(tokens).not.toMatch(/outline: 1px solid/);
  });
  test("radius roles are named on :root: sm 6 · md 8 · lg 12 · pill 999", () => {
    const radius = (name: string) => Number(root.match(new RegExp(`--loki-radius-${name}:\\s*([\\d.]+)px`))?.[1]);
    expect([radius("sm"), radius("md"), radius("lg"), radius("pill")]).toEqual([6, 8, 12, 999]);
  });
  test("no literal brass left in tokens.css", () => {
    expect(tokens).not.toMatch(/201,\s*164,\s*92/);
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\bbrass\b(?!-(soft|glow))/i); // only the kept token names
  });
});

describe("design tokens: every family remains readable on both sides", () => {
  const colourTokens = [...themeBlock("loki", "dark").matchAll(/--loki-([a-z-]+):/g)].map((m) => m[1]).filter((t) => !t.startsWith("radius") && !["font", "display", "label", "mono"].includes(t));
  /** Slack's roles beside the accent: the red unread / needs-you badge and the green affirmative fill, each with its ink. */
  const ROLES = ["attention", "on-attention", "affirm", "on-affirm"];
  for (const palette of PALETTES) {
    for (const theme of THEMES) {
      const color = (name: string) => themeColor(palette, theme, name);

      test(`${palette} ${theme}: defines every colour token the default does`, () => {
        const defined = new Set([...themeBlock(palette, theme).matchAll(/--loki-([a-z-]+):/g)].map((m) => m[1]));
        expect([...colourTokens, ...ROLES].filter((t) => !defined.has(t))).toEqual([]);
      });

      test(`${palette} ${theme}: the badge and the affirmative fill carry AA ink and stand off the ground (3:1)`, () => {
        expect(contrast(color("on-attention"), color("attention"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color("on-affirm"), color("affirm"))).toBeGreaterThanOrEqual(4.5);
        for (const surface of ["bg", "panel"]) expect(contrast(color("attention"), color(surface))).toBeGreaterThanOrEqual(3);
        expect(contrast(color("affirm"), color("bg"))).toBeGreaterThanOrEqual(3);
        // the accent is a blue: its hue is nearer blue than the retired brass yellow
        const [r, g, b] = color("accent");
        expect(b).toBeGreaterThan(r);
        expect(b).toBeGreaterThan(g * 0.9);
      });

      test(`${palette} ${theme}: text and semantic colors meet AA on working surfaces`, () => {
        const surfaces = ["bg", "panel", "panel-header", "well"];
        const inks = ["fg", "muted", "accent", "positive", "negative"];
        const failures = inks.flatMap((ink) => surfaces.map((surface) => ({ pair: `${ink}/${surface}`, ratio: contrast(color(ink), color(surface)) }))).filter(({ ratio }) => ratio < 4.5);
        expect(failures).toEqual([]);
      });

      test(`${palette} ${theme}: controls and special surfaces keep their intended contrast`, () => {
        expect(contrast(color("control-border"), color("panel"))).toBeGreaterThanOrEqual(3);
        expect(contrast(color("control-border"), color("well"))).toBeGreaterThanOrEqual(3);
        for (const surface of ["bubble", "user-bubble", "hover", "selection"]) {
          expect(contrast(color("fg"), color(surface))).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(color("accent"), color("brass-soft"))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/**
 * The phone's Slack-mode system (app/src/phone/phone.css): the same --loki-* roles, redeclared on the
 * phone root element so everything inside inherits them — whatever :root's data-palette says, since an
 * element's own declaration beats an inherited one regardless of specificity. Night is the bare root
 * class; day is the root class under data-theme="light".
 */
describe("phone tokens: one Slack-like system under the phone root", () => {
  const PHONE = join(APP, "phone", "phone.css");
  const phone = existsSync(PHONE) ? readFileSync(PHONE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") : "";
  const PHONE_SELECTOR: Record<Theme, string> = { dark: ".loki-phone", light: ':root[data-theme="light"] .loki-phone' };
  const phoneBlock = (theme: Theme) => {
    const start = phone.indexOf(`\n${PHONE_SELECTOR[theme]} {`);
    if (start < 0) throw new Error(`no phone block for ${PHONE_SELECTOR[theme]}`);
    return phone.slice(start, phone.indexOf("\n}", start + 1));
  };
  const raw = (theme: Theme, name: string) => {
    const hit = phoneBlock(theme).match(new RegExp(`\\s(--(?:loki|phone)-${name}):\\s*([^;]+);`))?.[2].trim();
    if (!hit) throw new Error(`missing ${name} in phone ${theme}`);
    return hit;
  };
  const color = (theme: Theme, name: string) => parseColor(raw(theme, name));
  const desktopColours = [...themeBlock("loki", "dark").matchAll(/--loki-([a-z-]+):/g)].map((m) => m[1]).filter((t) => !t.startsWith("radius") && !["font", "display", "label", "mono"].includes(t));
  /** Slack's roles that loki has no token for: links, the unread badge and its ink, presence, the affirmative button and its ink. */
  const PHONE_ROLES = ["link", "unread", "on-unread", "presence", "affirm", "on-affirm"];

  test("phone.css exists and is imported by the phone shell, not injected", () => {
    expect(phone.length).toBeGreaterThan(0);
    const shell = readFileSync(join(APP, "phone", "Phone.tsx"), "utf8");
    const ui = readFileSync(join(APP, "phone", "ui.tsx"), "utf8");
    expect(shell).toContain('import "./phone.css"');
    expect(ui).not.toContain("<style>");
  });

  for (const theme of THEMES) {
    test(`${theme}: defines every colour role the desktop does, plus the phone's own`, () => {
      const block = phoneBlock(theme);
      const defined = new Set([...block.matchAll(/--(?:loki|phone)-([a-z-]+):/g)].map((m) => m[1]));
      expect([...desktopColours, ...PHONE_ROLES].filter((t) => !defined.has(t))).toEqual([]);
    });

    test(`${theme}: text, links and states meet AA on every working surface`, () => {
      const surfaces = ["bg", "panel", "panel-header", "well"];
      const inks = ["fg", "muted", "accent", "link", "positive", "negative"];
      const failures = inks.flatMap((ink) => surfaces.map((surface) => ({ pair: `${ink}/${surface}`, ratio: contrast(color(theme, ink), color(theme, surface)) }))).filter(({ ratio }) => ratio < 4.5);
      expect(failures).toEqual([]);
      for (const surface of ["bubble", "user-bubble", "hover", "selection"]) expect(contrast(color(theme, "fg"), color(theme, surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(theme, "on-unread"), color(theme, "unread"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(theme, "on-affirm"), color(theme, "affirm"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(theme, "accent"), color(theme, "brass-soft"))).toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme}: controls, presence and badges stay visible against their ground (3:1)`, () => {
      for (const surface of ["panel", "well"]) expect(contrast(color(theme, "control-border"), color(theme, surface))).toBeGreaterThanOrEqual(3);
      for (const mark of ["presence", "unread"]) expect(contrast(color(theme, mark), color(theme, "bg"))).toBeGreaterThanOrEqual(3);
    });

  }

  test("the display and label faces are the sans stack for both sides — no serif, condensed or mono presentation", () => {
    // declared once on the root class; the day block only changes colours
    for (const face of ["font", "display", "label"]) expect(raw("dark", face)).not.toMatch(/(?<!sans-)serif|New York|Iowan|Georgia|Condensed|Narrow|mono/i);
    expect(phoneBlock("light")).not.toMatch(/--loki-(font|display|label):/);
  });

  test("the phone never keys on data-palette, and its tokens sit on the phone element rather than :root", () => {
    expect(phone).not.toContain("data-palette");
    const declaring = [...phone.matchAll(/(?:^|\n)([^\n{}@]+?)\s*\{[^}]*--loki-bg:/g)].map((m) => m[1].trim());
    expect(declaring.sort()).toEqual(Object.values(PHONE_SELECTOR).sort());
  });

  test("the gates and the paired shell all carry the phone root class", () => {
    const shell = readFileSync(join(APP, "phone", "Phone.tsx"), "utf8");
    const pair = readFileSync(join(APP, "phone", "Pair.tsx"), "utf8");
    expect(shell.match(/className="loki-phone loki-phone-shell/g)?.length ?? 0).toBeGreaterThanOrEqual(2); // splash and paired
    expect(pair).toMatch(/className="loki-phone loki-phone-shell/);
  });

  test("presentation classes drop mono and condensed caps inside the phone; mono stays for code", () => {
    for (const cls of ["loki-label", "loki-meta", "loki-chip", "loki-banner", "loki-title"]) expect(phone).toMatch(new RegExp(`\\.loki-phone \\.${cls}\\b[^{]*\\{[^}]*font-family: var\\(--loki-font\\)`));
    expect(phone).toMatch(/\.loki-phone \.loki-label\b[^{]*\{[^}]*text-transform: none/);
    const monoRules = [...phone.matchAll(/([^{}]+)\{[^}]*var\(--loki-mono\)/g)].map((m) => m[1].trim());
    expect(monoRules.filter((sel) => !/\b(code|pre|kbd)\b/.test(sel))).toEqual([]);
  });

  test("literal colours appear only in custom property declarations", () => {
    const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/;
    const off = phone.split("\n").filter((line) => re.test(line) && !/^\s*--[a-z0-9-]+:/.test(line));
    expect(off).toEqual([]);
  });

  test("the phone's type scale and radii are named, and stay on a scale", () => {
    const PHONE_TEXT = new Set([11, 13, 15, 17, 20, 28]);
    const texts = [...phone.matchAll(/--phone-text-[a-z-]+:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(texts.length).toBeGreaterThanOrEqual(5);
    expect(texts.filter((n) => !PHONE_TEXT.has(n))).toEqual([]);
    const radii = [...phone.matchAll(/--phone-radius-[a-z-]+:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(radii.length).toBeGreaterThanOrEqual(3);
    expect(radii.filter((n) => !RADII.has(n))).toEqual([]);
    // rules pick sizes from the scale, never a literal px
    expect([...phone.matchAll(/(?<!-)font-size:\s*([\d.]+px)/g)].map((m) => m[1])).toEqual([]);
  });

  test("the page pinning, shell height, focus and motion rules exist, and none of them reach the desktop", () => {
    // the document never scrolls on the phone, but only while a phone shell is on the page
    expect(phone).toMatch(/html:has\(\.loki-phone-shell\)/);
    const bare = [...phone.matchAll(/(?:^|\n|\})\s*([^{}@/]+?)\s*\{/g)].map((m) => m[1].trim()).flatMap((sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim())).filter((s) => s && !s.startsWith("from") && !s.startsWith("to") && !/^\d+%$/.test(s));
    expect(bare.filter((s) => !s.includes(".loki-phone") && !s.startsWith("@"))).toEqual([]);
    expect(phone).toContain("100svh");
    expect(phone).toContain("100dvh");
    expect(phone).toMatch(/\.loki-phone [^{]*:focus-visible[^{]*\{[^}]*outline: 2px solid/);
    // the phone flashes in its own link colour, through the same keyframes
    expect(phone).toMatch(/--loki-focus-flash: var\(--phone-focus\)/);
    // a page heading is where focus lands on arrival (tabindex -1, never tabbed to): it carries no ring and no flash
    expect(phone).toMatch(/\.loki-phone \[data-phone-heading\]:focus-visible \{ outline-color: transparent; animation: none; \}/);
    // an animation beats a plain declaration, so every ring turned off must stop the flash too
    const off = [...phone.matchAll(/\{([^}]*outline-color: transparent[^}]*)\}/g)].map((m) => m[1]);
    expect(off.filter((b) => !/animation: none/.test(b))).toEqual([]);
    expect(phone).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

/**
 * Keys read per system (plan 014 U2, KTD2): shortcut text comes from the keymap, so a Mac symbol in any string
 * the app shows would read wrong on Windows and Linux. The scan reads every string, template and JSX text under
 * app/src (comments are not strings), less the keymap's own symbol table.
 */
describe("keys come from the keymap: no Mac key symbol in a string outside its symbol table", () => {
  const MAC_KEYS = /[⌘⌥⇧⌃⌫↵⏎⇥]/;
  /** The one table the symbols live in: keymap.ts's MAC_SYMBOL. */
  const TABLE = { file: "shell/keymap.ts", name: "MAC_SYMBOL" };
  const strings = (path: string, text: string): string[] => {
    const src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (n: ts.Node, inTable: boolean) => {
      const table = inTable || (path === TABLE.file && ts.isVariableDeclaration(n) && n.name.getText(src) === TABLE.name);
      if (!table && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) && MAC_KEYS.test(n.text)) {
        out.push(`${path}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text.trim()}`);
      }
      ts.forEachChild(n, (c) => visit(c, table));
    };
    visit(src, false);
    return out;
  };
  test("the scan sees strings, templates and JSX text, and skips comments and the table", () => {
    const sample = ['// ⌘K in a comment', '/** ⌘K */', 'const MAC_SYMBOL = { cmd: "⌘" };', 'const a = "⌘K";', "const b = `x ${a} ⌥`;", "const c = <b title=\"⇧\">↵ send</b>;"].join("\n");
    expect(strings("x.tsx", sample).map((s) => s.split(": ")[1])).toEqual(["⌘", "⌘K", "⌥", "⇧", "↵ send"]);
    expect(strings(TABLE.file, 'const MAC_SYMBOL = { cmd: "⌘" };')).toEqual([]);
  });
  test("every shortcut a user reads is formatted by the keymap", () => {
    const hits = code.flatMap((f) => strings(f.path, f.text));
    expect(hits).toEqual([]);
  });
});
