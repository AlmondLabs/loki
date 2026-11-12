import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { must } from "./fixtures/must.ts";

// Plan 2026-11-12-1505, U3: the window shell on Liquid Glass. The rules live in components.css under the apple family,
// so every other family keeps today's shell; these read the stylesheet and the shell's markup.

const APP = join(import.meta.dirname, "..", "app", "src");
const css = readFileSync(join(APP, "components", "components.css"), "utf8");
const shell = readFileSync(join(APP, "shell", "shell.tsx"), "utf8");
const sidebar = readFileSync(join(APP, "shell", "sidebar.tsx"), "utf8");
const apple = must(/:root\[data-palette="apple"\] \{([\s\S]*)\n\}\s*$/.exec(css), "the apple block")[1];

describe("the window shell on Liquid Glass", () => {
  test("one glass panel sits under the rail and the list column, shown only in the apple family", () => {
    expect(shell).toMatch(/className="loki-shell-glass glass"/);
    expect(css).toMatch(/\.loki-shell-glass \{\s*display: none;\s*\}/);
    expect(apple).toMatch(/\.loki-shell-glass \{\s*display: block;/);
  });

  test("the rail, the list column and the top strip go clear over it; elsewhere the rail keeps its panel and rule", () => {
    expect(sidebar).toContain('className="loki-sections"');
    expect(sidebar).not.toMatch(/borderRight: "1px solid var\(--loki-border\)",\s*background: "var\(--loki-panel\)"/);
    expect(css).toMatch(/\.loki-sections \{\s*border-right: 1px solid var\(--loki-border\);\s*background: var\(--loki-panel\);/);
    expect(apple).toMatch(/\.loki-title-strip,\s*\.loki-sections,\s*\.loki-column \{\s*background: transparent;\s*border-right: 0;/);
  });

  test("the pane header's tabs are a glass capsule beside the title, drawn from the glass tokens", () => {
    const tabs = must(/\.loki-pane-header \.loki-tabs \{([^}]*)\}/.exec(apple), "the tabs rule")[1];
    expect(tabs).toContain("grid-area: tabs");
    expect(tabs).toContain("var(--loki-glass)");
    expect(tabs).toContain("var(--loki-glass-blur)");
    expect(tabs).not.toMatch(/blur\(/);
  });
});

describe("search, sheets, menus and the Canvas's chips on Liquid Glass (U7)", () => {
  test("every sheet and popover is strong glass, and the Canvas's floating chips are glass, from the glass tokens", () => {
    const sheets = must(/\.loki-sheet-card,\s*\.loki-popover,\s*\.loki-title-menu-panel \{([^}]*)\}/.exec(apple), "the sheet rule")[1];
    expect(sheets).toContain("var(--loki-glass-strong)");
    expect(sheets).toContain("var(--loki-glass-blur)");
    const chips = must(/\.loki-chip--float \{([^}]*)\}/.exec(apple), "the chip rule")[1];
    expect(chips).toContain("var(--loki-glass)");
    expect(`${sheets}${chips}`).not.toMatch(/blur\(/);
  });

  test("widgets are sent the page's palette with its stylesheet, so they draw in Liquid Glass's roles", () => {
    const widget = readFileSync(join(APP, "desk", "module-widget.tsx"), "utf8");
    expect(widget).toMatch(/palette: d\.palette \?\? "loki"/);
    expect(widget).toMatch(/attributeFilter: \["data-theme", "data-palette"\]/);
  });
});

describe("Preferences and every tab row on Liquid Glass (U8)", () => {
  test("settings sit in a rounded group and a segmented control raises its chosen value", () => {
    expect(must(/\.loki-settings-block \{([^}]*)\}/.exec(apple), "the block rule")[1]).toContain("border-radius: var(--loki-radius-lg)");
    expect(must(/\.loki-segmented > button\[aria-pressed="true"\] \{([^}]*)\}/.exec(apple), "the chosen segment")[1]).toContain("var(--loki-segment)");
  });

  test("a tab row is a track that hugs its tabs, the chosen tab raised; the pane header's track is glass", () => {
    expect(must(/\n\s*\.loki-tabs \{([^}]*)\}/.exec(apple), "the tab row")[1]).toContain("width: fit-content");
    expect(must(/\.loki-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(apple), "the chosen tab")[1]).toContain("var(--loki-segment)");
  });

  test("Appearance's values are in Apple's words under Liquid Glass", () => {
    const settings = readFileSync(join(APP, "settings", "settings.tsx"), "utf8");
    expect(settings).toContain('{ system: "System", light: "Light", dark: "Dark" }');
    expect(settings).toContain('apple: "Liquid Glass"');
  });
});

describe("Windows and Linux on Liquid Glass (U10)", () => {
  test("covers AE2: Linux starts on the solid look-alike, the Mac and Windows on glass, from one constant", async () => {
    const { GLASS_ON } = await import("../app/src/theme.tsx");
    expect(GLASS_ON).toEqual({ macos: "glass", windows: "glass", linux: "solid" });
    const theme = readFileSync(join(APP, "theme.tsx"), "utf8");
    expect(theme).toMatch(/if \(GLASS_ON\[platform\] === "solid"\) root\.dataset\.glass = "solid";/);
    // the prepaint script says the same before any stylesheet, so Linux never flashes glass
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    expect(html).toMatch(/Linux\|X11\|CrOS[^\n]*dataset\.glass = "solid"/);
  });

  test("the ☰ menu on Windows and Linux is the same strong glass as a Mac's menus, solid where glass is off", () => {
    expect(apple).toMatch(/\.loki-title-menu-panel \{[^}]*var\(--loki-glass-strong\)/);
  });
});
