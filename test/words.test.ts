import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

/**
 * Words on screen follow Apple's Human Interface Guidelines (docs/style.md §6; plan 2026-11-14-0852, 3): every string the
 * app shows starts with a capital, and a button's label is in title case. Three reviews found lowercase words on
 * screen after each pass that fixed them; this reads the source so the next one does not.
 */

const APP = join(import.meta.dirname, "..", "app", "src");
/** The props whose strings reach the screen or a screen reader. */
const PROPS = new Set(["title", "label", "placeholder", "aria-label", "description", "help"]);
/** Words Apple's title case leaves lowercase inside a label. */
const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);

/**
 * Strings that start lowercase on purpose, by file and their start: a part in the middle of a dotted meta line,
 * example values in a placeholder, a host name.
 */
const ALLOWED: ReadonlyArray<[string, string]> = [
  ["agents/new-agent.tsx", "atlas, scout"],
  ["shell/welcome.tsx", "atlas, scout"],
  ["settings/engines.tsx", "npx"],
  ["settings/mcp.tsx", "npx"],
  ["settings/mcp.tsx", "github"],
  ["desk/catch-up-parts.tsx", "back · new since"],
  ["desk/catch-up-parts.tsx", "draft"],
  ["desk/outside-card.tsx", "in"],
  ["desk/outside-card.tsx", "back · new since"],
];

/** Starts that are never a sentence's: loki's own name, a path or a URL. */
const exempt = (text: string) => /^loki\b/.test(text) || /^[\w.-]+\/|^https?:|^[\w-]+\.(com|org|app|io)\b/.test(text);

/** Every .tsx under app/src but the development workbench and shadcn's upstream files. */
function sources(dir = APP): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "dev" ? [] : sources(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

interface Found {
  where: string;
  text: string;
  button: boolean;
}

/** The on-screen strings in a file: text that opens its element, the string props above, and whether a Button holds it. */
function strings(path: string): Found[] {
  const file = relative(APP, path).replaceAll("\\", "/");
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Found[] = [];
  const add = (node: ts.Node, text: string, button = false) => {
    const t = text.trim().replace(/\s+/g, " ");
    if (!t) return;
    const { line } = src.getLineAndCharacterOfPosition(node.getStart());
    out.push({ where: `${file}:${line + 1}`, text: t, button });
  };
  // A string the prop shows: a literal, a template's opening words, or either side of a choice, however deep.
  const shown = (e: ts.Expression): void => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) add(e, e.text);
    else if (ts.isTemplateExpression(e) && e.head.text.trim()) add(e, e.head.text);
    else if (ts.isConditionalExpression(e)) [e.whenTrue, e.whenFalse].forEach(shown);
    else if (ts.isParenthesizedExpression(e)) shown(e.expression);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && node.text.trim() && ts.isJsxElement(node.parent)) {
      const first = node.parent.children.find((k) => !(ts.isJsxText(k) && !k.text.trim()));
      // Only text that opens its element: text after another child continues a sentence.
      if (first === node) add(node, node.text, node.parent.openingElement.tagName.getText() === "Button");
    }
    if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText()) && node.initializer) {
      const i = node.initializer;
      const e = ts.isJsxExpression(i) ? i.expression : i;
      if (e) shown(e);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

const found = sources().flatMap(strings);

describe("words on screen (docs/style.md §6)", () => {
  test("every string the app shows starts with a capital, but for loki's name, paths and the listed fragments", () => {
    const lower = found.filter(
      ({ where, text }) => /^[a-z]/.test(text) && !exempt(text) && !ALLOWED.some(([f, start]) => where.startsWith(`${f}:`) && text.startsWith(start)),
    );
    expect(lower.map(({ where, text }) => `${where} ${text}`)).toEqual([]);
  });

  test("a button's label is in Apple's title case", () => {
    // A button that reads as a status line ("Queued · sends when this turn ends") is a sentence, and a label that goes on
    // in a value ("Sign In to {name}") may end on a small word.
    const wrong = found.filter(
      ({ button, text }) =>
        button && !exempt(text) && !text.includes("·") && text.split(" ").some((word, i) => /^[a-z][a-z]+$/.test(word) && !(i > 0 && SMALL.has(word))),
    );
    expect(wrong.map(({ where, text }) => `${where} ${text}`)).toEqual([]);
  });
});
