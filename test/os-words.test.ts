import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { KEYMAP, keyRows, labelOf } from "../app/src/shell/keymap.ts";
import { keysFor } from "../app/src/shell/KeysSheet.tsx";
import { lokiUpgrade, osWords } from "../app/src/shell/osWords.ts";
import type { Platform } from "../app/src/desk/env.ts";
import { machineWord } from "../mod/skill-sources.ts";

/**
 * Words for each system (plan 014 U8): copy that names the machine, its file manager or the way to upgrade reads
 * right on Windows and Linux, and the Mac's reads as it did.
 */
describe("the words table", () => {
  test("machine and file manager per system", () => {
    expect([osWords("macos").machine, osWords("windows").machine, osWords("linux").machine]).toEqual(["this Mac", "this PC", "this computer"]);
    expect([osWords("macos").fileManager, osWords("windows").fileManager, osWords("linux").fileManager]).toEqual(["Finder", "File Explorer", "the file manager"]);
  });

  test("the upgrade line: the cask on the Mac, the release download elsewhere", () => {
    expect(lokiUpgrade("loki", "macos")).toBe("brew upgrade --cask loki, or the .dmg on the release page");
    expect(lokiUpgrade("loki-nightly", "macos")).toBe("brew upgrade --cask loki-nightly, or the .dmg on the release page");
    for (const os of ["windows", "linux"] as const) {
      expect(lokiUpgrade("loki", os)).not.toMatch(/brew|cask|\.dmg/);
      expect(lokiUpgrade("loki", os)).toContain("release page");
    }
    expect(lokiUpgrade("loki", "linux")).toContain("download");
    expect(lokiUpgrade("loki", "windows")).toContain("-setup.exe");
  });

  test("the Mac keeps its old words for beads, the folder example and the system line", () => {
    const mac = osWords("macos");
    expect(mac.beadsInstall).toBe("brew install beads");
    expect(mac.folderExample).toBe("~/Documents/…");
    expect(mac.system).toBe("macOS 13 or later; the shell picks folders with osascript");
    expect(osWords("windows").folderExample).toBe("~\\Documents\\…");
    for (const os of ["windows", "linux"] as const) {
      expect(osWords(os).beadsInstall).not.toContain("brew");
      expect(osWords(os).system).not.toMatch(/macOS|lsof|osascript/);
    }
  });

  test("the mod's own machine word", () => {
    expect([machineWord("darwin"), machineWord("win32"), machineWord("linux")]).toEqual(["this Mac", "this PC", "this computer"]);
  });
});

describe("Hide loki off the Mac is Minimise loki", () => {
  const hide = KEYMAP.find((b) => b.id === "window.hide")!;
  test("the label per system, and the listings carry it", () => {
    expect(labelOf(hide, "macos")).toBe("Hide loki");
    expect(labelOf(hide, "windows")).toBe("Minimise loki");
    expect(labelOf(hide, "linux")).toBe("Minimise loki");
    expect(keyRows("windows").find((b) => b.id === "window.hide")?.label).toBe("Minimise loki");
    expect(keyRows("macos").find((b) => b.id === "window.hide")?.label).toBe("Hide loki");
    const sheet = (os: Platform) => keysFor("inbox", KEYMAP, os).flatMap((g) => g.rows).find((b) => b.id === "window.hide")?.label;
    expect(sheet("linux")).toBe("Minimise loki");
    expect(sheet("macos")).toBe("Hide loki");
  });
});

/**
 * No string the app shows names this Mac or Finder outside the words table and the views of Mac-only features
 * (the phone, which pairs with a Mac; Settings › phone), plus the Mac-only lines inside shared views, listed
 * one by one. Comments are not strings.
 */
describe("the machine comes from the words table", () => {
  const APP = join(import.meta.dirname, "..", "app", "src");
  const ALLOW = ["shell/osWords.ts", "phone/", "settings/Phone.tsx"];
  /** Phone pairing is on the Mac only (U3): the rail's Settings label says so only while it is on. */
  const MAC_ONLY_LINES = ["shell/Sidebar.tsx: , phones can reach this Mac"];
  const MAC_WORDS = /\b[Tt]his Mac\b|\bFinder\b/;
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.tsx?$/.test(n) && !n.endsWith(".d.ts") ? [join(dir, n)] : []));
  const strings = (path: string, source: string): string[] => {
    const src = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) && MAC_WORDS.test(n.text)) {
        out.push(`${path}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text.trim()}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    return out;
  };
  test("the scan sees strings and JSX text, not comments", () => {
    expect(strings("x.tsx", '// this Mac\nconst a = "on this Mac";\nconst b = <i title="in Finder">This Mac</i>;').map((s) => s.split(": ")[1])).toEqual(["on this Mac", "in Finder", "This Mac"]);
  });
  test("no string outside the table and the Mac-only views", () => {
    const hits = walk(APP)
      .map((p) => ({ path: p.slice(APP.length + 1).replaceAll("\\", "/"), text: readFileSync(p, "utf8") })) // "/" on Windows too, as ALLOW names them
      .filter((f) => !ALLOW.some((a) => f.path.startsWith(a)))
      .flatMap((f) => strings(f.path, f.text))
      .filter((h) => !MAC_ONLY_LINES.includes(h.replace(/:\d+: /, ": ")));
    expect(hits).toEqual([]);
  });
});
