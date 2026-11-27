import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { must } from "./fixtures/must.ts";

const APP = join(import.meta.dirname, "..", "app", "src");
const css = readFileSync(join(APP, "components", "components.css"), "utf8");
const shell = readFileSync(join(APP, "shell", "shell.tsx"), "utf8");
const sidebar = readFileSync(join(APP, "shell", "sidebar.tsx"), "utf8");
const glass = must(/\n:root \{([\s\S]*)\n\}\s*$/.exec(css), "the glass block")[1];

describe("the window shell on Liquid Glass", () => {
  test("one glass panel sits under the sidebar, hidden while the sidebar is", () => {
    expect(shell).toMatch(/className="loki-shell-glass glass"/);
    expect(shell).toContain('data-empty={!sidebarShown ? "" : undefined}');
    expect(glass).toMatch(/\.loki-shell-glass \{\s*display: block;/);
    expect(glass).toMatch(/\.loki-shell-glass\[data-empty\] \{\s*display: none;/);
  });

  test("the list column and the top strip go clear over it", () => {
    expect(glass).toMatch(/\.loki-title-strip,\s*\.loki-column \{\s*background: transparent;\s*border-right: 0;/);
  });

  test("the pane header's tabs are a glass capsule beside the title, drawn from the glass tokens", () => {
    const tabs = must(/\.loki-pane-header \.loki-tabs \{([^}]*)\}/.exec(glass), "the tabs rule")[1];
    expect(tabs).toContain("grid-area: tabs");
    expect(tabs).toContain("var(--loki-glass)");
    expect(tabs).toContain("var(--loki-glass-blur)");
    expect(tabs).not.toMatch(/blur\(/);
  });
});

describe("search, sheets, menus and floating chips on Liquid Glass (U7)", () => {
  test("every sheet, popover and type-ahead list is strong glass, and floating chips are glass, from the glass tokens", () => {
    const sheets = must(/\.loki-sheet-card,\s*\.loki-popover,\s*\.loki-mail-suggest \{([^}]*)\}/.exec(glass), "the sheet rule")[1];
    expect(sheets).toContain("var(--loki-glass-strong)");
    expect(sheets).toContain("var(--loki-glass-blur)");
    const chips = must(/\.loki-chip--float \{([^}]*)\}/.exec(glass), "the chip rule")[1];
    expect(chips).toContain("var(--loki-glass)");
    expect(`${sheets}${chips}`).not.toMatch(/blur\(/);
  });
});

describe("Preferences and every tab row on Liquid Glass (U8)", () => {
  test("settings sit in a rounded group and a segmented control raises its chosen value", () => {
    expect(must(/\.loki-settings-block \{([^}]*)\}/.exec(glass), "the block rule")[1]).toContain("border-radius: var(--radius-xl)");
    expect(must(/\.loki-segmented > button\[aria-pressed="true"\] \{([^}]*)\}/.exec(glass), "the chosen segment")[1]).toContain("var(--loki-segment)");
  });

  test("a tab row is shadcn's Tabs in a capsule that hugs its tabs; the pane header's track is glass, the chosen tab lit", () => {
    const components = readFileSync(join(APP, "components", "index.tsx"), "utf8");
    expect(components).toMatch(/<TabsList aria-label=\{label\} activateOnFocus className="loki-tabs [^"]*rounded-full/);
    expect(readFileSync(join(APP, "ui", "tabs.tsx"), "utf8")).toContain("w-fit");
    expect(must(/\.loki-pane-header \.loki-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(glass), "the chosen tab")[1]).toContain("var(--loki-selection)");
  });

  test("Appearance's values are in Apple's words, and there is no palette to pick", () => {
    const settings = readFileSync(join(APP, "settings", "settings.tsx"), "utf8");
    expect(settings).toContain('{ system: "System", light: "Light", dark: "Dark" }');
    expect(settings).not.toMatch(/palette/i);
  });
});

describe("Windows and Linux on Liquid Glass (U10)", () => {
  test("covers AE2: Linux starts on the solid look-alike, the Mac and Windows on glass, from one constant", async () => {
    const { GLASS_ON } = await import("../app/src/theme.tsx");
    expect(GLASS_ON).toEqual({ macos: "glass", windows: "glass", linux: "solid" });
    const theme = readFileSync(join(APP, "theme.tsx"), "utf8");
    expect(theme).toMatch(/if \(GLASS_ON\[platform\] === "solid" && !inLan\) root\.dataset\.glass = "solid";/);
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    expect(html).toMatch(/Linux\|X11\|CrOS[^\n]*dataset\.glass = "solid"/);
  });

  test("the prepaint starts desktop Linux solid, and never a phone", () => {
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    const line = must(/if \(([^\n]*Linux\|X11\|CrOS[^\n]*)\) document\.documentElement\.dataset\.glass = "solid";/.exec(html), "the prepaint's glass line")[1];
    const [, match, except] = must(
      /^\/([^/]+)\/\.test\(navigator\.userAgent\) && !\/([^/]+)\/\.test\(navigator\.userAgent\)$/.exec(line),
      "the prepaint's test",
    );
    const solid = (userAgent: string) => new RegExp(match).test(userAgent) && !new RegExp(except).test(userAgent);
    expect(solid("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(true);
    expect(solid("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
    expect(solid("Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")).toBe(false);
    expect(solid("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36")).toBe(false);
  });

  test("the ☰ menu on Windows and Linux is the same strong glass as a Mac's menus, solid where glass is off", () => {
    const menu = readFileSync(join(APP, "shell", "title-menu.tsx"), "utf8");
    expect(menu.match(/className=\{?[^>]*loki-popover/g)?.length).toBe(2);
  });
});

describe("one sidebar in place of the rail (U12)", () => {
  test("the places are Chats, Flow, Agents and Learn as rows, with no Preferences row, and Flow's count is grey text", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Places } = await import("../app/src/shell/sidebar.tsx");
    const out = renderToStaticMarkup(createElement(Places, { segment: "chats", onSelect: () => {}, waiting: 2, dueCards: 0 }));
    expect([...out.matchAll(/class="loki-place-label">([^<]+)</g)].map((m) => m[1])).toEqual(["Chats", "Flow", "Agents", "Learn"]);
    expect(out).not.toContain("Preferences");
    expect(out).toContain('aria-label="Flow, 2 waiting"');
    expect(out).toContain('<span aria-hidden="true" class="loki-place-count">2</span>');
    expect(out).not.toContain("--loki-attention");
    expect(must(/\.loki-place-count \{([^}]*)\}/.exec(css), "the count rule")[1]).toContain("var(--loki-muted)");
  });

  test("a place with sources is a grey heading that is not a row, its sources the rows (plan 2026-11-15-1035, R5)", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Places } = await import("../app/src/shell/sidebar.tsx");
    const chats = {
      items: [
        { id: "all", title: "All Chats", icon: "desk" as const, count: 0 },
        { id: "pinned", title: "Pinned", icon: "pin" as const, count: 0 },
        { id: "archived", title: "Archived", icon: "archive" as const, count: 0 },
      ],
      selected: "all",
      onSelect: () => {},
    };
    const out = renderToStaticMarkup(createElement(Places, { segment: "chats", onSelect: () => {}, waiting: 0, sources: { chats } }));
    expect(out).toContain('<span id="loki-place-heading-chats" class="loki-place-heading">Chats</span>');
    expect(out).not.toMatch(/<button[^>]*>[^]*?>Chats</);
    expect([...out.matchAll(/class="loki-place-label">([^<]+)</g)].map((m) => m[1]).slice(0, 3)).toEqual(["All Chats", "Pinned", "Archived"]);
    expect(out).toMatch(/aria-current="page"[^>]*aria-label="All Chats"/);
  });

  test("only the row showing takes the accent; the others' symbols are in the label colour", () => {
    expect(must(/\.loki-place\[aria-current\] \{([^}]*)\}/.exec(css), "the current place")[1]).toContain("var(--loki-accent)");
    expect(must(/\.loki-place-icon \{([^}]*)\}/.exec(css), "the place icon")[1]).not.toContain("var(--loki-accent)");
  });

  test("the place showing is filled, never bold", () => {
    expect(must(/\.loki-place\[aria-current\] \{([^}]*)\}/.exec(css), "the current place")[1]).toContain("var(--loki-selection)");
    expect(must(/\n\.loki-place \{([^}]*)\}/.exec(css), "the place rule")[1]).toContain("font-weight: 400");
  });

  test("the window has no rail: the sections are the places, and Preferences is ⌘, and the menu bar's", async () => {
    expect(shell).not.toMatch(/<Sidebar\b/);
    expect(sidebar).not.toMatch(/export function Sidebar\b/);
    const { SEGMENTS } = await import("../app/src/shell/shortcuts.ts");
    expect(SEGMENTS.map((s) => s.label)).toEqual(["Chats", "Flow", "Agents", "Learn", "Preferences"]);
  });
});

describe("the chat's toolbar and the sidebar's real material (U13)", () => {
  const root = join(APP, "..", "..");
  test("on the Mac the window is transparent with the system's sidebar material; elsewhere it keeps its ground", async () => {
    const { mainWindowOptions, WINDOW_GROUND } = await import("../desktop/windows.ts");
    expect(mainWindowOptions("macos", "/p.cjs")).toMatchObject({ vibrancy: "sidebar", transparent: true });
    expect(mainWindowOptions("windows", "/p.cjs")).toMatchObject({ frame: false, backgroundColor: WINDOW_GROUND });
    expect(mainWindowOptions("linux", "/p.cjs").vibrancy).toBeUndefined();
  });

  test("the page is clear in the Mac app, painted again under Reduce Transparency or Increase Contrast", () => {
    const styles = readFileSync(join(APP, "styles.css"), "utf8");
    // Outside (WebKit): WebKit does not know prefers-reduced-transparency, so the clear rule cannot hang on its
    // no-preference.
    expect(styles).not.toContain("prefers-reduced-transparency: no-preference");
    expect(styles).toMatch(/\n:root\[data-vibrant\]:not\(\[data-glass="solid"\]\) \{[\s\S]*?background: transparent;/);
    expect(styles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{\s*:root\[data-vibrant\][\s\S]*?background: var\(--loki-bg\);/,
    );
    const theme = readFileSync(join(APP, "theme.tsx"), "utf8");
    expect(theme).toContain('export const VIBRANT = inDesktop && platform === "macos";');
    expect(theme).toContain('if (VIBRANT) root.dataset.vibrant = "on";');
  });

  test("the shell places the traffic lights where the page expects them, and the page lines its row up on them", async () => {
    const { TRAFFIC_LIGHTS_AT, trafficLights } = await import("../desktop/tray.ts");
    expect(readFileSync(join(root, "desktop", "windows.ts"), "utf8")).toContain("trafficLightPosition: TRAFFIC_LIGHTS_AT,");
    const boot = readFileSync(join(APP, "boot.tsx"), "utf8");
    expect(boot.indexOf("adoptTrafficLights()")).toBeGreaterThan(-1);
    expect(boot.indexOf("adoptTrafficLights()")).toBeLessThan(boot.indexOf("createRoot("));
    const { GLASS_LIGHTS, adoptTrafficLights, paneTop, sidebarToggleTop, sidebarToggleLeft } = await import("../app/src/shell/sidebar.tsx");
    expect(sidebarToggleTop(true, "macos") + 14).toBe(GLASS_LIGHTS.middle);
    expect(paneTop(true, "macos") + 26).toBe(GLASS_LIGHTS.middle);
    expect(sidebarToggleLeft(true, "macos")).toBe(GLASS_LIGHTS.right + 18);
    expect(trafficLights(TRAFFIC_LIGHTS_AT)).toEqual(GLASS_LIGHTS);
    const before = { ...GLASS_LIGHTS };
    await adoptTrafficLights(() => Promise.resolve({ left: "x", right: 70, middle: 26 }));
    expect(GLASS_LIGHTS).toEqual(before);
    await adoptTrafficLights(() => Promise.reject(new Error("no shell")));
    expect(GLASS_LIGHTS).toEqual(before);
    vi.resetModules();
    const fresh = await import("../app/src/shell/sidebar.tsx");
    await fresh.adoptTrafficLights(() => Promise.resolve({ left: 13.4, right: 66.6, middle: 25.5 }));
    expect(fresh.GLASS_LIGHTS).toEqual({ left: 13, right: 67, middle: 26 });
    expect(fresh.sidebarToggleTop(true, "macos")).toBe(12);
    await fresh.adoptTrafficLights(() => Promise.resolve(before));
  });

  test("with the sidebar shown, the Mac's toggle sits at its trailing end, in line with the counts, clear of the lights", async () => {
    const { GLASS_INSET, GLASS_LIGHTS, LIST_BAR, PLACE_PADDING, PLACES_INSET, sidebarToggleLeft, sidebarToggleLeftShown } =
      await import("../app/src/shell/sidebar.tsx");
    const { SIDEBAR_MIN } = await import("../app/src/shell/columns.ts");
    expect(sidebarToggleLeftShown(280, true, "macos") + 28 - 5).toBe(GLASS_INSET + 280 - PLACES_INSET - PLACE_PADDING);
    const css = readFileSync(join(APP, "components", "components.css"), "utf8");
    expect(css).toMatch(new RegExp(`\\.loki-places \\{[^}]*padding: 0 ${PLACES_INSET}px ${PLACES_INSET}px;`));
    expect(css).toMatch(new RegExp(`\\.loki-place \\{[^}]*padding: 0 ${PLACE_PADDING}px;`));
    expect(css).toMatch(new RegExp(`\\.loki-content-list-bar \\{[^}]*padding: 4px 8px 4px ${LIST_BAR.padding}px;[^}]*\\}`));
    expect(css).toMatch(new RegExp(`\\.loki-content-list-bar \\{[^}]*gap: ${LIST_BAR.gap}px;`));
    expect(sidebarToggleLeftShown(SIDEBAR_MIN, true, "macos")).toBeGreaterThan(GLASS_LIGHTS.right);
    expect(sidebarToggleLeftShown(280, true, "windows")).toBe(sidebarToggleLeft(true, "windows"));
    expect(sidebarToggleLeftShown(280, false, "macos")).toBe(sidebarToggleLeft(false, "macos"));
  });

  test("the glass panel is the window's hole onto the material: its ring paints everything else opaque, hidden or shown", () => {
    const hole = must(/&\[data-vibrant\]:not\(\[data-glass="solid"\]\) \.loki-shell-glass \{([^}]*)\}/.exec(glass), "the hole rule")[1];
    expect(hole).toContain("background: transparent");
    expect(hole).toContain("0 0 0 200vmax var(--loki-bg)");
    expect(glass).toMatch(/\.loki-shell-glass\[data-empty\] \{\s*box-shadow: 0 0 0 200vmax var\(--loki-bg\);/);
  });

  test("the chat's moves are toolbar symbols named for the screen reader, and the box has no row of moves under it", async () => {
    const pane = readFileSync(join(APP, "workspace", "canvas-pane.tsx"), "utf8");
    for (const name of ["Label", "Mark as Read", "Archive"]) expect(pane).toContain(`label: "${name}"`);
    expect(pane).toContain("trailing={toolbarItems}");
    expect(pane).not.toContain("itemMoves");
    expect(pane).not.toContain("footer=");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { PaneHeader } = await import("../app/src/components/index.tsx");
    const out = renderToStaticMarkup(createElement(PaneHeader, { title: "t", trailing: createElement("span", null, "tools") }));
    expect(out).toContain('<div class="loki-pane-header-trailing"><span>tools</span></div>');
  });
});

describe("the detail toolbar band (plan 2026-11-14-1330, U4)", () => {
  test("a header with tab views centres them between two equal sides, the trailing one never narrower than its symbols", () => {
    const centred = must(/\.loki-pane-header:has\(> \[data-slot="tabs"\] > \.loki-tabs\) \{([^}]*)\}/.exec(glass), "the centred rule")[1];
    expect(centred).toContain("grid-template-columns: minmax(0, 1fr) auto minmax(max-content, 1fr)");
  });

  test("every toolbar keeps a trailing side, and none keeps room for an Update button any more (plan 2026-11-15-1035, U7)", async () => {
    const trailing = must(/\.loki-pane-header-trailing \{([^}]*)\}/.exec(glass), "the trailing rule")[1];
    expect(trailing).not.toContain("--loki-toolbar-room");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { PaneHeader } = await import("../app/src/components/index.tsx");
    const out = renderToStaticMarkup(createElement(PaneHeader, { title: "t" }));
    expect(out).toContain('<div class="loki-pane-header-trailing"></div>');
    expect(css).not.toContain("--loki-toolbar-room");
  });

  test("Messages, Workers and Canvas sit in the chat toolbar's centred slot", () => {
    const pane = readFileSync(join(APP, "workspace", "canvas-pane.tsx"), "utf8");
    expect(pane).toContain("tabs={paneTabs(subagents)}");
    expect(glass).toMatch(/\.loki-pane-header \.loki-tabs \{[^}]*grid-area: tabs;/);
  });
});

describe("Tailwind's own type sizes and root (plan 2026-11-15-0030)", () => {
  const styles = readFileSync(join(APP, "styles.css"), "utf8");
  const index = readFileSync(join(APP, "..", "index.html"), "utf8");

  test("loki's theme names no text sizes of its own", () => {
    expect(styles).not.toMatch(/^\s*--text-[\w-]+:/m);
  });

  test("the page keeps Tailwind's root and spacing step: no px root in index.html and no --spacing in styles.css", () => {
    expect(index).not.toMatch(/html \{[^}]*font:\s*[\d.]+px/);
    expect(styles).not.toMatch(/--spacing:/);
  });

  test("the four sizes are always emitted, for the stylesheets that read them outside Tailwind's graph", () => {
    expect(styles).toContain('@source inline("text-xs text-sm text-base text-2xl");');
  });
});

describe("blue for what waits on you, grey for counts and faces (U17)", () => {
  const tokens = readFileSync(join(APP, "kit", "tokens.css"), "utf8");
  const block = (selector: string) => must(new RegExp(`(?:^|\\n)${selector.replace(/[[\]]/g, "\\$&")} \\{([\\s\\S]*?)\\n\\}`).exec(tokens), selector)[1];
  test("attention is the blue of the accent, red only for failures", () => {
    const dark = block(":root");
    const light = block(':root[data-theme="light"]');
    expect(dark).toContain("--loki-attention: #3d9bff;");
    expect(dark).toContain("--loki-accent: #3d9bff;");
    expect(light).toContain("--loki-attention: #0064d6;");
    expect(light).toContain("--loki-accent: #0064d6;");
    expect(dark).toContain("--loki-negative: #ff6961;");
  });

  test("a row's count is grey text with no fill", () => {
    const badge = must(/\n {2}\.loki-list-badge \{([^}]*)\}/.exec(glass), "the glass badge")[1];
    expect(badge).toContain("background: transparent");
    expect(badge).toContain("color: var(--loki-muted)");
  });

  test("an agent with no picture is a grey monogram", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AgentFace } = await import("../app/src/workspace/agent-chip.tsx");
    const out = renderToStaticMarkup(createElement(AgentFace, { name: "friday", src: null }));
    expect(out).toContain("data-monogram");
    expect(out).toContain("var(--loki-monogram-top)");
    expect(out).not.toMatch(/hsl\(\d+ 60% 78%\)/);
  });
});

describe("the list column's slots (plan 2026-11-14-1330, U1 and U3)", () => {
  test("the owner's portal slot lets clicks through to Chats' list while no place owns it", () => {
    const slot = must(/<div ref=\{setListSlot\}[^>]*\/>/.exec(shell), "the owner's list slot")[0];
    expect(slot).toContain('pointerEvents: placeOwner ? undefined : "none"');
  });
});
