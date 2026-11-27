import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..", "app", "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const staticImports = (text: string): string[] => [...text.matchAll(/^\s*import\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);

describe("what loads at start (plan 038)", () => {
  test("boot loads only the surface it mounts: neither the desktop nor the phone is imported statically", () => {
    const boot = read("boot.tsx");
    expect(staticImports(boot)).not.toEqual(expect.arrayContaining(["./shell/shell"]));
    expect(staticImports(boot)).not.toEqual(expect.arrayContaining(["./phone/phone"]));
    expect(boot).toContain('import("./shell/shell")');
    expect(boot).toContain('import("./phone/phone")');
  });

  test("the Settings sheet is loaded when it opens", () => {
    const views = read("shell/views.tsx");
    expect(staticImports(views)).not.toContain("../settings/settings");
    expect(views).toContain('import("../settings/settings")');
  });
});
