import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const CORE = resolve(import.meta.dirname, "..", "core");
const LEAKS = /(?<![\w-])window\.|(?<![\w-])document\.|localStorage|(?<![\w-])navigator\.|@tauri-apps/;
const ALLOWED_BARE = new Set(["react"]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = tsFiles(CORE).map((p) => ({ path: relative(CORE, p), abs: p, text: readFileSync(p, "utf8") }));

const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm)].map((m) => m[1]);

describe("core/ is portable", () => {
  test("the package has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  test("no browser or Tauri references", () => {
    const hits = files.flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => LEAKS.test(line))
        .map(({ line, i }) => `${f.path}:${i + 1}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });
  test("imports stay inside the package (or are React)", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const spec of specifiers(f.text)) {
        if (spec.startsWith(".")) {
          const target = resolve(dirname(f.abs), spec);
          if (relative(CORE, target).startsWith("..")) bad.push(`${f.path} → ${spec} (outside core/)`);
          else if (!spec.endsWith(".ts")) bad.push(`${f.path} → ${spec} (needs an explicit .ts extension)`);
          else if (!existsSync(target)) bad.push(`${f.path} → ${spec} (missing)`);
        } else if (!ALLOWED_BARE.has(spec)) {
          bad.push(`${f.path} → ${spec} (bare import not allowed)`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
