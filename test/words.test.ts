import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const APP = join(import.meta.dirname, "..", "app", "src");
const PROPS = new Set(["title", "label", "placeholder", "aria-label", "description", "help"]);
const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);

const ALLOWED: ReadonlyArray<[string, string]> = [
  ["agents/new-agent.tsx", "atlas, scout"],
  ["shell/welcome.tsx", "atlas, scout"],
  ["settings/engines.tsx", "npx"],
  ["settings/mcp.tsx", "npx"],
  ["settings/mcp.tsx", "github"],
  ["workspace/catch-up-parts.tsx", "back · new since"],
  ["workspace/catch-up-parts.tsx", "draft"],
  ["workspace/outside-toolbar.tsx", "in"],
  ["workspace/outside-toolbar.tsx", "back · new since"],
  ["chat/tool-steps.tsx", "failed"],
  ["item/work.tsx", "failed"],
];

const exempt = (text: string) => /^loki\b/.test(text) || /^[\w.-]+\/|^https?:|^[\w-]+\.(com|org|app|io)\b/.test(text);

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
  const shown = (e: ts.Expression): void => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) add(e, e.text);
    else if (ts.isTemplateExpression(e) && e.head.text.trim()) add(e, e.head.text);
    else if (ts.isConditionalExpression(e)) [e.whenTrue, e.whenFalse].forEach(shown);
    else if (ts.isParenthesizedExpression(e)) shown(e.expression);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && node.text.trim() && ts.isJsxElement(node.parent)) {
      const first = node.parent.children.find((k) => !(ts.isJsxText(k) && !k.text.trim()));
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
    const wrong = found.filter(
      ({ button, text }) =>
        button && !exempt(text) && !text.includes("·") && text.split(" ").some((word, i) => /^[a-z][a-z]+$/.test(word) && !(i > 0 && SMALL.has(word))),
    );
    expect(wrong.map(({ where, text }) => `${where} ${text}`)).toEqual([]);
  });

  test("a label that leads on ends in the ellipsis character, never three periods (plan 2026-11-15-1035, R4)", () => {
    expect(found.filter(({ text }) => text.includes("...")).map(({ where, text }) => `${where} ${text}`)).toEqual([]);
  });
});
