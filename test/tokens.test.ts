import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { must } from "./fixtures/must.ts";
import { LAYER } from "../app/src/kit/layers.ts";

/**
 * The design tokens are a contract: inline styles pick from the scales in app/src/kit/tokens.css
 * and the layers in app/src/kit/layers.ts. This test is the fence that keeps them from drifting again.
 *
 * It reads every .tsx, .ts and .css under app/src (the first version read .tsx only, and the drift
 * moved into chat/ui.ts and chat.css), plus the page's own colour in index.html and the manifest.
 */
const APP = join(import.meta.dirname, "..", "app", "src");
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
/**
 * A stylesheet on one line, every run of whitespace one space and none just inside parentheses: the rules however
 * Prettier lays them out, matched as rules.
 */
const flat = (text: string) => text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");

type Rgb = [number, number, number];
type Theme = "dark" | "light";
/** Liquid Glass, loki's one look (plan 2026-11-12-1505): night is the bare :root, day sits under data-theme="light". */
const THEMES: Theme[] = ["dark", "light"];
const selectorFor = (theme: Theme) => `:root${theme === "light" ? '[data-theme="light"]' : ""}`;
const themeBlock = (theme: Theme) => {
  const start = tokens.indexOf(`${selectorFor(theme)} {`);
  if (start < 0) throw new Error(`no block for ${selectorFor(theme)}`);
  return tokens.slice(start, tokens.indexOf("\n}", start));
};
const themeColor = (theme: Theme, name: string): Rgb => {
  const raw = new RegExp(`--loki-${name}:\\s*([^;]+)`).exec(themeBlock(theme))?.[1].trim();
  if (!raw) throw new Error(`missing --loki-${name} in ${theme}`);
  return parseColor(raw);
};
const parseColor = (raw: string): Rgb => {
  if (raw.startsWith("#")) return [1, 3, 5].map((i) => Number.parseInt(raw.slice(i, i + 2), 16) / 255) as Rgb;
  const hit = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)/.exec(raw);
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
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((v) => Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))) as Rgb;
};
const luminance = (rgb: Rgb) =>
  rgb.reduce((sum, value, i) => sum + [0.2126, 0.7152, 0.0722][i] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4), 0);
const contrast = (a: Rgb, b: Rgb) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

/** Type scale (px): micro, meta, label (.loki-label), small, body, row title, card title, display, hero. */
const FONT_SCALE = new Set([9.5, 10.5, 11, 12, 13.5, 15, 17, 22, 28]);
/**
 * Spacing (px), the desktop's padding, margins and gaps: a hairline, then loki's 4px grid with 20 for the pane inset.
 * They are Tailwind's steps 0, px, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10 and 12, because styles.css sets one step to 4px.
 * The phone keeps its own scale, --phone-space-1 to 6.
 */
const SPACE = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48]);
/** The spacing steps a gap, space, padding or margin class may name; anything else, an arbitrary value included, is off the scale. */
const SPACE_STEPS = new Set(["0", "px", "0.5", "1", "1.5", "2", "3", "4", "5", "6", "8", "10", "12"]);
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
const COMPUTED = (hit: string) => hit.startsWith("desk/agent-chip.tsx:");

const findAll = (list: typeof files, re: RegExp, pick: (m: RegExpMatchArray) => string) =>
  list.flatMap((f) => [...f.text.matchAll(re)].map((m) => `${f.path}: ${pick(m)}`));
const numbers = (expr: string) => [...expr.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const value = (hit: string) => hit.slice(hit.indexOf(": ") + 2);
/** An expression without its var() and env() calls, innermost first so a fallback's own var() goes too: those are tokens, not literals. */
const withoutCalls = (expr: string) => {
  let out = expr;
  for (let last = ""; last !== out;) [last, out] = [out, out.replace(/\b(?:var|env)\([^()]*\)/g, "")];
  return out;
};
/** A line number in a file, from an offset into it. */
const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length;

/**
 * The px lengths in a padding, margin or gap value that leave the spacing scale. A bare number counts as px (React's
 * inline styles); a percentage, an em or a token does not, and a negative counts as its size.
 */
const offSpace = (expr: string) =>
  [...withoutCalls(expr).matchAll(/(?<![\w.$])(\d+(?:\.\d+)?)(?:px)?(?![\w%.])/g)].map((m) => Number(m[1])).filter((n) => !SPACE.has(n));

/** Padding, margin and gap declarations in a stylesheet whose px terms leave the scale, as "path:line: declaration". */
const offSpaceCss = (path: string, text: string) => {
  // comments become blanks of the same shape, so a line number still points at its line
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  return [...bare.matchAll(/(?<![\w-])((?:padding|margin)(?:-[a-z-]+)?|gap|row-gap|column-gap)\s*:\s*([^;{}]+)/g)]
    .filter((m) => offSpace(m[2]).length > 0)
    .map((m) => `${path}:${lineAt(bare, m.index)}: ${m[1]}: ${m[2].trim().replace(/\s+/g, " ")}`);
};

/**
 * Padding, margin and gap in a desktop view's inline styles whose literals leave the scale, as "path:line: value". A
 * value runs to the next comma or brace outside its quotes, so a template literal's commas stay inside it; a named
 * constant is not a literal and passes, and a phone token on one side of a ternary is a var() and goes.
 */
const offSpaceInline = (path: string, text: string) =>
  [
    ...text.matchAll(
      /\b(?:gap|rowGap|columnGap|(?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block)?(?:Start|End)?): ((?:`[^`]*`|"[^"]*"|'[^']*'|[^,}\n"'`])+)/g,
    ),
  ]
    .filter((m) => offSpace(m[1]).length > 0)
    .map((m) => `${path}:${lineAt(text, m.index)}: ${m[1].trim()}`);

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
  test("the inline spacing fence fails an off-scale literal and passes tokens, names and the phone's ternaries", () => {
    expect(offSpaceInline("x.tsx", 'const s = { padding: "14px 28px" };')).toHaveLength(1);
    expect(offSpaceInline("x.tsx", "const s = { marginTop: 10, gap: 8 };")).toHaveLength(1);
    expect(offSpaceInline("x.tsx", "const s = { paddingInlineStart: `${x}px 18px`, margin: -12 };")).toHaveLength(1);
    expect(offSpaceInline("x.tsx", "const s = { padding: `calc(${a}px, 14px)` };")).toHaveLength(1);
    expect(
      offSpaceInline(
        "x.tsx",
        'const s = { padding: 20, margin: "0 auto", paddingLeft: MAIL_INDENT, gap: touch ? "var(--phone-space-3)" : 8, marginTop: "calc(100% - 8px)" };',
      ),
    ).toEqual([]);
    expect(offSpaceInline("x.tsx", "const s = { padding: `${SPACE_2}px 12px`, margin: -4 };")).toEqual([]);
  });
  test("desktop padding, margins and gaps in views come from the spacing scale (a value from the phone's scale on touch is the phone's)", () => {
    // .tsx only: a gap: in plain .ts is an argument, not a style (chat/use-transcript-scroll.ts)
    const desktop = code.filter((f) => f.path.endsWith(".tsx") && !f.path.startsWith("phone/") && !f.path.startsWith("ui/"));
    expect(desktop.flatMap((f) => offSpaceInline(f.path, f.text))).toEqual([]);
  });
  test("the stylesheet spacing fence fails an off-scale px term and passes auto, tokens and on-scale calc", () => {
    expect(offSpaceCss("x.css", ".a { padding: 10px; }")).toHaveLength(1);
    expect(offSpaceCss("x.css", ".a { margin: 0 14px; }")).toHaveLength(1);
    expect(offSpaceCss("x.css", ".a {\n  gap: 8px;\n  row-gap: 3px;\n}")).toEqual(["x.css:3: row-gap: 3px"]);
    expect(offSpaceCss("x.css", ".a { margin-left: -6px; padding-inline: calc(36px + 10px); }")).toHaveLength(1);
    expect(
      offSpaceCss(
        "x.css",
        [
          ".a { margin: 0 auto; padding: calc(var(--loki-header-height) + 20px); }",
          ".b { padding-left: env(safe-area-inset-left); margin-top: -12px; padding: 50% 0; }",
          ".c { padding-inline: calc(12px - 1px); column-gap: var(--x, 10px); --loki-gap: 10px; scroll-padding: 10px; }",
          "/* margin: 10px in a comment */",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
  test("desktop stylesheets keep padding, margins and gaps on the spacing scale (the phone keeps its own)", () => {
    const desktopCss = css.filter((f) => f.path === "kit/tokens.css" || ["components/", "chat/", "shell/"].some((dir) => f.path.startsWith(dir)));
    expect(desktopCss.map((f) => f.path)).toEqual(expect.arrayContaining(["kit/tokens.css", "components/components.css", "chat/chat.css"]));
    expect(desktopCss.flatMap((f) => offSpaceCss(f.path, f.text))).toEqual([]);
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
    const off = findAll(code, /fontFamily: ([^,}\n]+)/g, (m) => m[1].trim()).filter((h) => !/^"var\(--loki-(font|mono)\)"$|^"inherit"$/.test(value(h)));
    expect(off).toEqual([]);
    expect(findAll(code, /var\(--loki-(display|label)\)/g, (m) => m[0])).toEqual([]);
  });
  test("desktop views set mono and a one-line ellipsis with their classes, loki-mono and loki-truncate, never inline", () => {
    // the phone keeps its own inline styles and .loki-phone-ellipsis; shadcn's files are upstream
    const desktop = code.filter((f) => f.path.endsWith(".tsx") && !f.path.startsWith("phone/") && !f.path.startsWith("ui/"));
    const mono = findAll(desktop, /fontFamily: [^,}\n]*--loki-mono/g, (m) => m[0]);
    const ellipsis = findAll(desktop, /textOverflow: "ellipsis"/g, (m) => m[0]);
    expect([...mono, ...ellipsis]).toEqual([]);
  });
  test("labels are shown as written: no uppercase transform inline, nor in a desktop stylesheet", () => {
    const inline = findAll(code, /textTransform: ([^,}\n]+)/g, (m) => m[1].trim()).filter((h) => value(h).includes("uppercase"));
    // the phone keeps two of its own: a pairing code typed in capitals, and a kicker's first letter
    const inCss = findAll(
      css.filter((f) => !f.path.startsWith("phone/")),
      /text-transform:\s*uppercase/g,
      (m) => m[0],
    );
    expect([...inline, ...inCss]).toEqual([]);
  });
  test("stylesheets never name the retired display or label faces, and keep mono for code, data and keys", () => {
    const aliases = findAll(
      css.filter((f) => f.path !== "kit/tokens.css"),
      /font-family:\s*(var\(--loki-(?:display|label)\))/g,
      (m) => m[1],
    );
    expect(aliases).toEqual([]);
    const desktopCss = css.filter((f) => !f.path.startsWith("phone/"));
    const mono = desktopCss.flatMap((f) =>
      [...f.text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*var\(--loki-mono\)/g)].map((m) => `${f.path}: ${m[1].trim()}`),
    );
    // Tailwind's @theme only aliases the token (font-loki-mono); it presents nothing. .loki-mono is the one class a
    // view puts on code, data and keys.
    expect(mono.filter((h) => !/\b(code|pre|kbd)\b|--mono\b|@theme inline$|^\.loki-mono$/.test(value(h)))).toEqual([]);
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
    const rest = files
      .filter((f) => f.path !== "kit/tokens.css")
      .map((f) => f.text)
      .join("\n");
    expect([...defined].filter((t) => !rest.includes(`var(${t})`))).toEqual([]);
  });
  test("every loki-* class a component names has a rule", () => {
    // Components name classes in className=…; the primitives in ui/ build them from string maps, so every loki-* string there counts.
    const named = new Set(
      code.flatMap((f) =>
        [...f.text.matchAll(f.path.startsWith("ui/") ? /"(loki-[a-z0-9-]+)"/g : /className=(?:"[^"]*"|\{[^}]*\})/g)].flatMap((m) =>
          // A class starts with loki-; text-loki-muted is a Tailwind utility and --loki-bg a variable, neither a class.
          [...m[0].matchAll(/(?<![\w-])loki-[a-z0-9-]+/g)].map((c) => c[0]),
        ),
      ),
    );
    const ruled = new Set(files.flatMap((f) => [...f.text.matchAll(/\.(loki-[a-z0-9-]+)/g)].map((m) => m[1])));
    expect([...named].filter((c) => !ruled.has(c))).toEqual([]);
  });
  test("the page's own colour is --loki-bg in index.html, the manifest and the native window, on both sides", () => {
    const ground = (theme: Theme) => must(/--loki-bg:\s*(#[0-9a-fA-F]{6})/.exec(themeBlock(theme)), `--loki-bg in ${theme}`)[1];
    const bg = ground("dark");
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    const manifest = readFileSync(join(APP, "..", "public", "manifest.webmanifest"), "utf8");
    const rust = readFileSync(join(APP, "..", "..", "src-tauri", "src", "lib.rs"), "utf8");
    expect(/name="theme-color" content="(#[0-9a-fA-F]{6})"/.exec(html)?.[1]).toBe(bg);
    // the prepaint script picks the theme-color per theme, before any stylesheet
    const grounds = /var grounds = \{ dark: "(#[0-9a-fA-F]{6})", light: "(#[0-9a-fA-F]{6})" \}/.exec(html);
    expect(grounds?.slice(1)).toEqual([ground("dark"), ground("light")]);
    // the fallback stylesheet's ground, for a page whose CSS never arrived
    for (const theme of THEMES) {
      const selector = `html${theme === "light" ? '\\[data-theme="light"\\]' : ""}`;
      expect(new RegExp(`${selector} \\{ background: (#[0-9a-fA-F]{6})`).exec(html)?.[1]).toBe(ground(theme));
    }
    expect([...manifest.matchAll(/"(?:background_color|theme_color)":\s*"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1])).toEqual([bg, bg]);
    // the window is created in the dark ground; the page applies the saved preference after it loads
    const native = /background_color\(tauri::window::Color\(0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0xff\)\)/i.exec(rust);
    expect(`#${native?.slice(1, 4).join("")}`.toLowerCase()).toBe(bg.toLowerCase());
  });
});

describe("design tokens: the desktop's faces, focus and radii", () => {
  const root = themeBlock("dark");
  const rule = (selector: string) => {
    const hit = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()*+?^$|\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(tokens);
    if (!hit) throw new Error(`no rule for ${selector}`);
    return hit[1];
  };
  test("display and label faces are the sans stack; no serif or condensed face anywhere in tokens.css", () => {
    for (const face of ["font", "display", "label"]) {
      const raw = new RegExp(`--loki-${face}:\\s*([^;]+);`).exec(root)?.[1] ?? "";
      expect(raw).not.toBe("");
      expect(raw).not.toMatch(RETIRED_FACE);
      expect(raw).not.toMatch(/mono/i);
    }
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(RETIRED_FACE);
  });
  test(".loki-label is sentence-case sans: no caps, no tracking, the meta size, semibold muted", () => {
    const label = rule(".loki-label");
    expect(label).not.toMatch(/text-transform:\s*uppercase/);
    expect(label).not.toMatch(/letter-spacing/);
    expect(label).toMatch(/font-size:\s*var\(--loki-text-meta\)/);
    expect(label).toMatch(/font-weight:\s*600/);
    expect(label).toMatch(/color:\s*var\(--loki-muted\)/);
  });
  test("focus flashes: a 2px accent ring that fades in a second, to a muted ring on controls and to nothing on text fields", () => {
    // the flash is the ring's colour animating from the accent; what it settles to is the rule's own outline
    expect(flat(tokens)).toMatch(/@keyframes loki-focus-flash \{ from \{ outline-color: var\(--loki-focus-flash, var\(--loki-accent\)\); \} \}/);
    const control = /\[tabindex\]:focus-visible \{([^}]*)\}/.exec(flat(tokens))?.[1] ?? "";
    expect(control).toMatch(/outline: 2px solid var\(--loki-muted\)/);
    expect(control).toMatch(/animation: loki-focus-flash 1s ease-out/);
    const field = /textarea\):focus-visible \{([^}]*)\}/.exec(flat(tokens))?.[1] ?? "";
    expect(field).toMatch(/outline: 2px solid transparent/);
    expect(tokens).not.toMatch(/outline: 1px solid/);
  });
  test("text fields never blink: the caret shows focus; the flash is for controls only", () => {
    const field = /textarea\):focus-visible \{([^}]*)\}/.exec(flat(tokens))?.[1] ?? "";
    expect(field).toMatch(/animation: none/);
    const phone = flat(readFileSync(join(import.meta.dirname, "..", "app", "src", "phone", "phone.css"), "utf8"));
    const chat = flat(readFileSync(join(import.meta.dirname, "..", "app", "src", "chat", "chat.css"), "utf8"));
    for (const [css, sel] of [
      [phone, ".loki-phone :is(input, textarea):focus-visible"],
      [phone, ".loki-phone-search-field:focus-within"],
      [chat, ".loki-composer-box:has(.loki-composer-text:focus-visible)"],
    ] as const) {
      const rule = /\{([^}]*)\}/.exec(css.slice(css.indexOf(sel)))?.[1] ?? "";
      expect(rule, sel).toMatch(/animation: none/);
    }
  });
  test("radius roles are named on :root: sm 6 · md 8 · lg 12 · pill 999", () => {
    const radius = (name: string) => Number(new RegExp(`--loki-radius-${name}:\\s*([\\d.]+)px`).exec(root)?.[1]);
    expect([radius("sm"), radius("md"), radius("lg"), radius("pill")]).toEqual([6, 8, 12, 999]);
  });
  test("no literal brass left in tokens.css", () => {
    expect(tokens).not.toMatch(/201,\s*164,\s*92/);
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\bbrass\b(?!-(soft|glow))/i); // only the kept token names
  });
});

describe("design tokens: Liquid Glass stays readable on both sides", () => {
  const colourTokens = [...themeBlock("dark").matchAll(/--loki-([a-z-]+):/g)]
    .map((m) => m[1])
    .filter((t) => !t.startsWith("radius") && !t.startsWith("text-") && !["font", "display", "label", "mono"].includes(t));
  /** The roles beside the accent: what waits on you (blue, as Mail's unread dot) and the affirmative fill, each with its ink. */
  const ROLES = ["attention", "on-attention", "affirm", "on-affirm"];
  {
    for (const theme of THEMES) {
      const color = (name: string) => themeColor(theme, name);

      test(`${theme}: defines every colour token night does`, () => {
        const defined = new Set([...themeBlock(theme).matchAll(/--loki-([a-z-]+):/g)].map((m) => m[1]));
        expect([...colourTokens, ...ROLES].filter((t) => !defined.has(t))).toEqual([]);
      });

      test(`${theme}: the badge and the affirmative fill carry AA ink and stand off the ground (3:1)`, () => {
        expect(contrast(color("on-attention"), color("attention"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color("on-affirm"), color("affirm"))).toBeGreaterThanOrEqual(4.5);
        for (const surface of ["bg", "panel"]) expect(contrast(color("attention"), color(surface))).toBeGreaterThanOrEqual(3);
        expect(contrast(color("affirm"), color("bg"))).toBeGreaterThanOrEqual(3);
        // the accent is a blue: its hue is nearer blue than the retired brass yellow
        const [r, g, b] = color("accent");
        expect(b).toBeGreaterThan(r);
        expect(b).toBeGreaterThan(g * 0.9);
      });

      test(`${theme}: text and semantic colors meet AA on working surfaces`, () => {
        const surfaces = ["bg", "panel", "panel-header", "well"];
        const inks = ["fg", "muted", "accent", "positive", "negative"];
        const failures = inks
          .flatMap((ink) => surfaces.map((surface) => ({ pair: `${ink}/${surface}`, ratio: contrast(color(ink), color(surface)) })))
          .filter(({ ratio }) => ratio < 4.5);
        expect(failures).toEqual([]);
      });

      test(`${theme}: controls and special surfaces keep their intended contrast`, () => {
        expect(contrast(color("control-border"), color("panel"))).toBeGreaterThanOrEqual(3);
        expect(contrast(color("control-border"), color("well"))).toBeGreaterThanOrEqual(3);
        for (const surface of ["bubble", "user-bubble", "hover", "selection"]) {
          expect(contrast(color("fg"), color(surface))).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(color("accent"), color("brass-soft"))).toBeGreaterThanOrEqual(4.5);
        // A monogram's initial is small text, so it holds AA even at the gradient's lighter end.
        expect(contrast(color("on-monogram"), color("monogram-top"))).toBeGreaterThanOrEqual(4.5);
      });

      test(`${theme}: every label colour reads as a mark on the surfaces chips sit on`, () => {
        const failures = Array.from({ length: 8 }, (_, i) => `label-${i}`)
          .flatMap((label) => ["bg", "panel", "well"].map((surface) => ({ pair: `${label}/${surface}`, ratio: contrast(color(label), color(surface)) })))
          .filter(({ ratio }) => ratio < 3);
        expect(failures).toEqual([]);
      });
    }
  }

  test("the open list row's preview and time take full ink, since the muted grey falls under AA on the selection", () => {
    const css = flat(readFileSync(join(APP, "components", "components.css"), "utf8"));
    for (const part of ["preview", "time"]) {
      expect(css).toMatch(new RegExp(`\\.loki-list-row\\[aria-current\\] \\.loki-list-row-${part}[^{]*\\{[^}]*color: var\\(--loki-fg\\)`));
    }
  });

  test("a focused list's selection is the affirmative blue under its white ink, the pair held to AA above", () => {
    const css = flat(readFileSync(join(APP, "components", "components.css"), "utf8"));
    const focused = String.raw`\.loki-content-list-rows:focus-within \.loki-list-item\[data-current\]`;
    expect(css).toMatch(new RegExp(`${focused} > \\.loki-list-row,[^{]*\\{ background: var\\(--loki-affirm\\); color: var\\(--loki-on-affirm\\); \\}`));
    for (const part of ["preview", "time", "badge"]) {
      const cls = part === "badge" ? "loki-list-badge" : `loki-list-row-${part}`;
      expect(css).toMatch(new RegExp(`${focused} \\.${cls}[^{]*\\{[^}]*color: var\\(--loki-on-affirm\\)`));
    }
  });
});

/**
 * The phone's Liquid Glass system (app/src/phone/phone.css): the same --loki-* roles in iOS's colours, redeclared on
 * the phone root element so everything inside inherits them, since an element's own declaration beats an inherited
 * one regardless of specificity. Night is the bare root class; day is the root class under data-theme="light".
 */
describe("phone tokens: one system under the phone root", () => {
  const PHONE = join(APP, "phone", "phone.css");
  const phone = existsSync(PHONE) ? readFileSync(PHONE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") : "";
  const PHONE_SELECTOR: Record<Theme, string> = { dark: ".loki-phone", light: ':root[data-theme="light"] .loki-phone' };
  const blockOf = (selector: string) => {
    const start = phone.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`no phone block for ${selector}`);
    return phone.slice(start, phone.indexOf("\n}", start + 1));
  };
  const phoneBlock = (theme: Theme) => blockOf(PHONE_SELECTOR[theme]);
  const raw = (theme: Theme, name: string) => {
    const hit = new RegExp(`\\s(--(?:loki|phone)-${name}):\\s*([^;]+);`).exec(phoneBlock(theme))?.[2].trim();
    if (!hit) throw new Error(`missing ${name} in phone ${theme}`);
    return hit;
  };
  // The glass material, the monogram and the segmented control's chosen segment are the desktop's; the phone inherits
  // them from :root rather than restating them.
  const DESKTOP_ONLY = /^(glass|monogram|on-monogram|segment)/;
  const desktopColours = [...themeBlock("dark").matchAll(/--loki-([a-z-]+):/g)]
    .map((m) => m[1])
    .filter((t) => !t.startsWith("radius") && !t.startsWith("text-") && !["font", "display", "label", "mono"].includes(t) && !DESKTOP_ONLY.test(t));
  /** The phone's roles that loki has no token for: links, the unread badge and its ink, presence, the affirmative button and its ink. */
  const PHONE_ROLES = ["link", "unread", "on-unread", "presence", "affirm", "on-affirm"];

  test("phone.css exists and is imported by the phone shell, not injected", () => {
    expect(phone.length).toBeGreaterThan(0);
    const shell = readFileSync(join(APP, "phone", "phone.tsx"), "utf8");
    const ui = readFileSync(join(APP, "phone", "ui.tsx"), "utf8");
    expect(shell).toContain('import "./phone.css"');
    expect(ui).not.toContain("<style>");
  });

  for (const theme of THEMES) {
    const color = (_theme: Theme, name: string) => parseColor(raw(theme, name));
    test(`${theme}: defines every colour role the desktop does, plus the phone's own`, () => {
      const block = phoneBlock(theme);
      const defined = new Set([...block.matchAll(/--(?:loki|phone)-([a-z-]+):/g)].map((m) => m[1]));
      expect([...desktopColours, ...PHONE_ROLES].filter((t) => !defined.has(t))).toEqual([]);
    });

    test(`${theme}: text, links and states meet AA on every working surface`, () => {
      const surfaces = ["bg", "panel", "panel-header", "well"];
      const inks = ["fg", "muted", "accent", "link", "positive", "negative"];
      const failures = inks
        .flatMap((ink) => surfaces.map((surface) => ({ pair: `${ink}/${surface}`, ratio: contrast(color(theme, ink), color(theme, surface)) })))
        .filter(({ ratio }) => ratio < 4.5);
      expect(failures).toEqual([]);
      for (const surface of ["bubble", "user-bubble", "hover", "selection"])
        expect(contrast(color(theme, "fg"), color(theme, surface))).toBeGreaterThanOrEqual(4.5);
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

  test("the phone keys on nothing but day or night, and its tokens sit on the phone element rather than :root", () => {
    expect(phone).not.toContain("data-palette");
    const declaring = [...phone.matchAll(/(?:^|\n)([^\n{}@]+?)\s*\{[^}]*--loki-bg:/g)].map((m) => m[1].trim());
    expect(declaring.sort()).toEqual(Object.values(PHONE_SELECTOR).sort());
  });

  test("the gates and the paired shell all carry the phone root class", () => {
    const shell = readFileSync(join(APP, "phone", "phone.tsx"), "utf8");
    const pair = readFileSync(join(APP, "phone", "pair.tsx"), "utf8");
    expect(shell.match(/className="loki-phone loki-phone-shell/g)?.length ?? 0).toBeGreaterThanOrEqual(2); // splash and paired
    expect(pair).toMatch(/className="loki-phone loki-phone-shell/);
  });

  test("presentation classes drop mono and condensed caps inside the phone; mono stays for code", () => {
    for (const cls of ["loki-label", "loki-meta", "loki-chip", "loki-banner", "loki-title"])
      expect(phone).toMatch(new RegExp(`\\.loki-phone \\.${cls}\\b[^{]*\\{[^}]*font-family: var\\(--loki-font\\)`));
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
    const bare = [...phone.matchAll(/(?:^|\n|\})\s*([^{}@/]+?)\s*\{/g)]
      .map((m) => m[1].trim())
      .flatMap((sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim()))
      .filter((s) => s && !s.startsWith("from") && !s.startsWith("to") && !/^\d+%$/.test(s));
    expect(bare.filter((s) => !s.includes(".loki-phone") && !s.startsWith("@"))).toEqual([]);
    expect(phone).toContain("100svh");
    expect(phone).toContain("100dvh");
    expect(phone).toMatch(/\.loki-phone [^{]*:focus-visible[^{]*\{[^}]*outline: 2px solid/);
    // the phone flashes in its own link colour, through the same keyframes
    expect(phone).toMatch(/--loki-focus-flash: var\(--phone-focus\)/);
    // a page heading is where focus lands on arrival (tabindex -1, never tabbed to): it carries no ring and no flash
    expect(flat(phone)).toMatch(/\.loki-phone \[data-phone-heading\]:focus-visible \{ outline-color: transparent; animation: none; \}/);
    // an animation beats a plain declaration, so every ring turned off must stop the flash too
    const off = [...phone.matchAll(/\{([^}]*outline-color: transparent[^}]*)\}/g)].map((m) => m[1]);
    expect(off.filter((b) => !b.includes("animation: none"))).toEqual([]);
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
      if (
        !table &&
        (ts.isStringLiteral(n) ||
          ts.isNoSubstitutionTemplateLiteral(n) ||
          ts.isTemplateHead(n) ||
          ts.isTemplateMiddle(n) ||
          ts.isTemplateTail(n) ||
          ts.isJsxText(n)) &&
        MAC_KEYS.test(n.text)
      ) {
        out.push(`${path}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text.trim()}`);
      }
      ts.forEachChild(n, (c) => visit(c, table));
    };
    visit(src, false);
    return out;
  };
  test("the scan sees strings, templates and JSX text, and skips comments and the table", () => {
    const sample = [
      "// ⌘K in a comment",
      "/** ⌘K */",
      'const MAC_SYMBOL = { cmd: "⌘" };',
      'const a = "⌘K";',
      "const b = `x ${a} ⌥`;",
      'const c = <b title="⇧">↵ send</b>;',
    ].join("\n");
    expect(strings("x.tsx", sample).map((s) => s.split(": ")[1])).toEqual(["⌘", "⌘K", "⌥", "⇧", "↵ send"]);
    expect(strings(TABLE.file, 'const MAC_SYMBOL = { cmd: "⌘" };')).toEqual([]);
  });
  test("every shortcut a user reads is formatted by the keymap", () => {
    const hits = code.flatMap((f) => strings(f.path, f.text));
    expect(hits).toEqual([]);
  });
});

/**
 * shadcn on loki's tokens (plan 096, U2). shadcn's colour names are loki's roles under other names, declared once in
 * tokens.css; the pairs shadcn draws text on meet AA in every family and side; its stacking repeats LAYER. Tailwind's
 * default theme stays for the agents' widgets, so loki's own class strings are fenced here instead: no default palette
 * colour, no default text size, no arbitrary size, radius, layer or tracking, no weight outside 400 · 600 · 700.
 */
describe("shadcn reads loki's tokens, and loki's class strings stay on its scales", () => {
  const styles = readFileSync(join(APP, "styles.css"), "utf8");
  const start = tokens.indexOf(":root,\n.loki-phone {");
  const shadcnBlock = start < 0 ? "" : tokens.slice(start, tokens.indexOf("\n}", start));
  const shadcn = new Map([...shadcnBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*var\(--loki-([a-z0-9-]+)\);/gm)].map((m) => [m[1], m[2]]));

  test("every shadcn variable is a loki token, declared on :root and the phone", () => {
    expect(shadcnBlock).not.toBe("");
    const lines = [...shadcnBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)];
    expect(lines.filter((m) => !/^var\(--loki-[a-z0-9-]+\)$/.test(m[2].trim())).map((m) => m[1])).toEqual([]);
    const loki = new Set([...tokens.matchAll(/^\s*--loki-([a-z0-9-]+):/gm)].map((m) => m[1]));
    expect([...shadcn].filter(([, role]) => !loki.has(role)).map(([name]) => name)).toEqual([]);
  });

  test("every shadcn colour utility names a declared shadcn variable", () => {
    const utilities = [...styles.matchAll(/--color-([a-z0-9-]+):\s*var\((--[a-z0-9-]+)\)/g)].filter((m) => !m[2].startsWith("--loki-"));
    expect(utilities.length).toBeGreaterThan(20);
    expect(utilities.filter((m) => !shadcn.has(m[2])).map((m) => m[1])).toEqual([]);
  });

  /** The surfaces shadcn draws text on, each with the ink it draws there. */
  const PAIRS: Array<[string, string]> = [
    ["--foreground", "--background"],
    ["--card-foreground", "--card"],
    ["--popover-foreground", "--popover"],
    ["--primary-foreground", "--primary"],
    ["--secondary-foreground", "--secondary"],
    ["--muted-foreground", "--muted"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--card"],
    ["--accent-foreground", "--accent"],
    ["--destructive", "--background"],
    ["--destructive", "--card"],
    ["--sidebar-foreground", "--sidebar"],
    ["--sidebar-primary-foreground", "--sidebar-primary"],
    ["--sidebar-accent-foreground", "--sidebar-accent"],
  ];
  {
    for (const theme of THEMES) {
      test(`${theme}: every shadcn ink meets AA on its surface`, () => {
        const color = (name: string) => themeColor(theme, must(shadcn.get(name), name));
        const failures = PAIRS.map(([ink, surface]) => ({ pair: `${ink} on ${surface}`, ratio: contrast(color(ink), color(surface)) })).filter(
          ({ ratio }) => ratio < 4.5,
        );
        expect(failures).toEqual([]);
      });
    }
  }

  test("the layer variables repeat LAYER, and each has its z-* utility", () => {
    const declared = Object.fromEntries([...tokens.matchAll(/--loki-layer-([a-z]+):\s*(\d+);/g)].map((m) => [m[1], Number(m[2])]));
    expect(declared).toEqual({ ...LAYER });
    for (const name of Object.keys(LAYER)) expect(styles).toContain(`@utility z-${name} {\n  z-index: var(--loki-layer-${name});`);
  });

  /** Class-shaped words that leave loki's scales; Tailwind still knows them, for the widgets. */
  const OFF_SCALE: Array<[string, RegExp]> = [
    [
      "a default palette colour",
      /\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|placeholder|caret|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?(?:\/\d+)?\b/,
    ],
    ["a default text size", /\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/],
    ["an arbitrary size, radius, layer, weight or line height", /\b(?:text|z|font|leading|shadow)-\[|\brounded(?:-[trblse]{1,2})?-\[(?!(?:1|3|4|9|24)px\])/],
    // small numbers stack inside one component, which the design allows; 50 and up is window-level stacking
    ["a numbered window layer", /\bz-(?:[5-9]\d|\d{3,})\b/],
    ["tracking", /\btracking-[a-z0-9[(]/],
    ["a weight outside 400 · 600 · 700", /\bfont-(?:thin|extralight|light|medium|extrabold|black)\b/],
    ["outline-none, which hides the focus ring tokens.css draws", /(?:^|\s)(?:\S*:)?outline-none(?=\s|$)/],
    ["a default shadow", /\bshadow-(?:2xs|xs|sm|md|lg|xl|2xl)\b/],
    ["a radius off the scale", /\brounded(?:-[trblse]{1,2})?-(?:xs|2xl|3xl|4xl)\b/],
  ];
  const classStrings = (path: string, text: string): Array<{ at: string; text: string }> => {
    const src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: Array<{ at: string; text: string }> = [];
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        out.push({ at: `${path}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`, text: n.text });
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    return out;
  };
  /**
   * A gap, space, padding or margin class whose step is off the spacing scale; shadcn's own files in ui/ keep theirs.
   * classStrings reads every string, so a padding or margin class counts only when its step looks like one (a number,
   * px, auto or a bracketed value): "my-macbook-pro.local" and a template head "m-${id}" are not classes. Tailwind's
   * trailing ! is importance, not part of the step.
   */
  const offSpacing = (path: string, text: string): boolean => {
    if (path.startsWith("ui/")) return false;
    const steps = (re: RegExp) => [...text.matchAll(re)].map((m) => m[1].replace(/!$/, ""));
    const gaps = steps(/(?:^|[\s:])!?(?:gap(?:-[xy])?|space-[xy])-(\S+)/g);
    const boxes = steps(/(?:^|[\s:])!?-?(?:p|m)[xytrblse]?-(\d+(?:\.\d+)?!?|px!?|auto!?|\[[^\]\s]*\]!?)(?=\s|$)/g);
    return gaps.some((s) => !SPACE_STEPS.has(s)) || boxes.some((s) => s !== "auto" && !SPACE_STEPS.has(s));
  };
  const offScale = (path: string, text: string) =>
    classStrings(path, text).flatMap((s) => [
      ...OFF_SCALE.filter(([, re]) => re.test(s.text)).map(([why]) => `${s.at}: ${why} in "${s.text}"`),
      ...(offSpacing(path, s.text) ? [`${s.at}: spacing off the scale in "${s.text}"`] : []),
    ]);

  test("the fence catches what it should and passes loki's names", () => {
    expect(offScale("x.tsx", 'const a = <b className="bg-blue-500 text-sm z-50 tracking-widest font-medium focus-visible:outline-none" />;')).toHaveLength(6);
    expect(offScale("x.tsx", 'const a = <b className="text-[13px] rounded-[5px] bg-black/10" />;')).toHaveLength(2);
    expect(offScale("x.tsx", 'const a = <b className="bg-primary text-body text-muted-foreground rounded-md z-modal shadow-float font-semibold" />;')).toEqual(
      [],
    );
  });

  test("the fence holds gap and space classes to the spacing scale, outside shadcn's own files", () => {
    expect(offScale("x.tsx", 'const a = <b className="flex gap-7" />;')).toHaveLength(1);
    expect(offScale("x.tsx", 'const a = <b className="grid gap-x-2.5" />;')).toHaveLength(1);
    expect(offScale("x.tsx", 'const a = <b className="flex gap-[10px]" />;')).toHaveLength(1);
    expect(offScale("x.tsx", 'const a = <b className="flex gap-1.5 gap-px space-y-2 sm:gap-3 gap-y-0.5" />;')).toEqual([]);
    expect(offScale("ui/x.tsx", 'const a = <b className="flex gap-2.5" />;')).toEqual([]);
  });

  test("the fence holds padding and margin classes to the spacing scale, and reads only what looks like a class", () => {
    expect(offScale("x.tsx", 'const a = <b className="p-2.5" />;')).toHaveLength(1);
    expect(offScale("x.tsx", 'const a = <b className="flex mt-7" />;')).toHaveLength(1);
    expect(offScale("x.tsx", 'const a = <b className="hover:-ml-[10px]" />;')).toHaveLength(1);
    expect(offScale("x.tsx", 'const a = <b className="mx-auto px-5 py-5 px-4! -mt-2 ps-px m-0" />;')).toEqual([]);
    expect(offScale("x.tsx", 'const host = "my-macbook-pro.local";')).toEqual([]);
    expect(offScale("x.tsx", "const id = `m-${n}`;")).toEqual([]);
    expect(offScale("ui/x.tsx", 'const a = <b className="p-2.5" />;')).toEqual([]);
  });

  test("no class string in loki's source leaves the scales", () => {
    expect(code.flatMap((f) => offScale(f.path, f.text))).toEqual([]);
  });
});

describe("Liquid Glass: the material and its solid fallback (plan 2026-11-12-1505, U1)", () => {
  const styles = readFileSync(join(APP, "styles.css"), "utf8");
  const solid = (block: string) => /--loki-glass:\s*var\(--loki-panel\)/.test(block) && /--loki-glass-blur:\s*none/.test(block);

  test("the glass utilities read only the glass tokens, so one switch turns every surface solid", () => {
    for (const name of ["glass", "glass-strong"]) {
      const body = must(new RegExp(`@utility ${name} \\{([^}]*)\\}`).exec(styles), `@utility ${name}`)[1];
      expect(body).toContain("var(--loki-glass-blur)");
      expect(body).not.toMatch(/blur\(/);
    }
  });

  test("night and day draw glass: a translucent material with its blur", () => {
    for (const theme of THEMES) {
      const block = themeBlock(theme);
      expect(block).toMatch(/--loki-glass:\s*rgba\(/);
      expect(block).toMatch(/--loki-glass-blur:\s*blur\(/);
    }
  });

  test("Reduce Transparency, Increase Contrast and data-glass=solid each turn the glass solid", () => {
    const media = must(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{([\s\S]*?)\n\}/.exec(tokens), "the media block")[1];
    expect(media).toContain(':root[data-theme="light"]');
    expect(solid(media)).toBe(true);
    const forced = must(/:root\[data-glass="solid"\],[^{]*\{([^}]*)\}/.exec(tokens), "the data-glass block")[1];
    expect(solid(forced)).toBe(true);
  });
});
