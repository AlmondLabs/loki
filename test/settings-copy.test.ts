import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const DIR = join(import.meta.dirname, "..", "app", "src", "settings");

function helpTexts(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(DIR, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const texts: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
    else if (ts.isTemplateExpression(node)) texts.push(node.head.text + node.templateSpans.map((s) => `x${s.literal.text}`).join(""));
    else if (ts.isJsxText(node)) texts.push(node.text.trim());
    else if (ts.isJsxAttributes(node)) return;
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "help" && node.initializer) collect(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts.filter(Boolean);
}

describe("Preferences' help copy", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

  test("it finds the notes it checks", () => {
    expect(files.flatMap(helpTexts).length).toBeGreaterThan(40);
  });

  test("every note is one sentence", () => {
    const long = files.flatMap((f) =>
      helpTexts(f)
        .filter((t) => /[.!?]\s+\S/.test(t))
        .map((t) => `${f}: ${t}`),
    );
    expect(long).toEqual([]);
  });
});
