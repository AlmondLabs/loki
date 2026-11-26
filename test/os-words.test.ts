import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { KEYMAP, keyRows, labelOf } from "../app/src/shell/keymap.ts";
import { keysFor } from "../app/src/shell/keys-sheet.tsx";
import { osWords, toolsWords } from "../app/src/shell/os-words.ts";
import type { Platform } from "../app/src/workspace/env.ts";
import { machineWord } from "../mod/skill-sources.ts";
import { must } from "./fixtures/must.ts";

describe("the words table", () => {
  test("machine and file manager per system", () => {
    expect([osWords("macos").machine, osWords("windows").machine, osWords("linux").machine]).toEqual(["this Mac", "this PC", "this computer"]);
    expect([osWords("macos").fileManager, osWords("windows").fileManager, osWords("linux").fileManager]).toEqual([
      "Finder",
      "File Explorer",
      "the file manager",
    ]);
  });

  test("the Mac keeps its old words for the folder example and the system line", () => {
    const mac = osWords("macos");
    expect(mac.folderExample).toBe("~/Documents/…");
    expect(mac.system).toBe("macOS 13.3 or later; the shell picks folders with osascript");
    expect(osWords("windows").folderExample).toBe("~\\Documents\\…");
    for (const os of ["windows", "linux"] as const) {
      expect(osWords(os).system).not.toMatch(/macOS|lsof|osascript/);
    }
  });

  test("the tools step: the Mac's command line tools with their install button, Linux's package commands", () => {
    const mac = toolsWords("macos");
    expect(mac.needed).toContain("Apple's command line tools");
    expect(mac.install).toBe("Install Command Line Tools");
    expect(mac.commands).toEqual([]);
    const linux = toolsWords("linux");
    expect(linux.install).toBeNull();
    expect(linux.commands).toEqual(["sudo apt install git", "sudo dnf install git"]);
    expect(`${linux.needed} ${linux.where ?? ""}`).not.toMatch(/macOS|Apple|xcode/i);
  });

  test("the mod's own machine word", () => {
    expect([machineWord("darwin"), machineWord("win32"), machineWord("linux")]).toEqual(["this Mac", "this PC", "this computer"]);
  });
});

describe("Hide loki off the Mac is Minimise loki", () => {
  const hide = must(
    KEYMAP.find((b) => b.id === "window.hide"),
    "the window.hide binding",
  );
  test("the label per system, and the listings carry it", () => {
    expect(labelOf(hide, "macos")).toBe("Hide loki");
    expect(labelOf(hide, "windows")).toBe("Minimise loki");
    expect(labelOf(hide, "linux")).toBe("Minimise loki");
    expect(keyRows("windows").find((b) => b.id === "window.hide")?.label).toBe("Minimise loki");
    expect(keyRows("macos").find((b) => b.id === "window.hide")?.label).toBe("Hide loki");
    const sheet = (os: Platform) =>
      keysFor("flow", KEYMAP, os)
        .flatMap((g) => g.rows)
        .find((b) => b.id === "window.hide")?.label;
    expect(sheet("linux")).toBe("Minimise loki");
    expect(sheet("macos")).toBe("Hide loki");
  });
});

describe("the machine comes from the words table", () => {
  const APP = join(import.meta.dirname, "..", "app", "src");
  const ALLOW = ["shell/os-words.ts", "phone/", "settings/phone.tsx"];
  const MAC_ONLY_LINES = ["shell/sidebar.tsx: , phones can reach this Mac"];
  const MAC_WORDS = /\b[Tt]his Mac\b|\bFinder\b|\b[Cc]ommand [Ll]ine [Tt]ools\b|\bsudo (?:apt|dnf)\b/;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) =>
      statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.tsx?$/.test(n) && !n.endsWith(".d.ts") ? [join(dir, n)] : [],
    );
  const strings = (path: string, source: string): string[] => {
    const src = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        (ts.isStringLiteral(n) ||
          ts.isNoSubstitutionTemplateLiteral(n) ||
          ts.isTemplateHead(n) ||
          ts.isTemplateMiddle(n) ||
          ts.isTemplateTail(n) ||
          ts.isJsxText(n)) &&
        MAC_WORDS.test(n.text)
      ) {
        out.push(`${path}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text.trim()}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    return out;
  };
  test("the scan sees strings and JSX text, not comments", () => {
    expect(strings("x.tsx", '// this Mac\nconst a = "on this Mac";\nconst b = <i title="in Finder">This Mac</i>;').map((s) => s.split(": ")[1])).toEqual([
      "on this Mac",
      "in Finder",
      "This Mac",
    ]);
    expect(strings("y.ts", 'const c = "Install Command Line Tools";\nconst d = `sudo apt install git`;').map((s) => s.split(": ")[1])).toEqual([
      "Install Command Line Tools",
      "sudo apt install git",
    ]);
  });
  test("no string outside the table and the Mac-only views", () => {
    const hits = walk(APP)
      .map((p) => ({ path: p.slice(APP.length + 1).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }))
      .filter((f) => !ALLOW.some((a) => f.path.startsWith(a)))
      .flatMap((f) => strings(f.path, f.text))
      .filter((h) => !MAC_ONLY_LINES.includes(h.replace(/:\d+: /, ": ")));
    expect(hits).toEqual([]);
  });
});
