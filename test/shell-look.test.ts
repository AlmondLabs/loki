import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { must } from "./fixtures/must.ts";

// Plan 2026-11-12-1505, U3: the window shell on Liquid Glass. Its rules live in components.css in one :root block laid
// over the plainer rules above it; these read the stylesheet and the shell's markup.

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

describe("search, sheets, menus and the Canvas's chips on Liquid Glass (U7)", () => {
  test("every sheet, popover and type-ahead list is strong glass, and the Canvas's floating chips are glass, from the glass tokens", () => {
    const sheets = must(/\.loki-sheet-card,\s*\.loki-popover,\s*\.loki-mail-suggest,\s*\.loki-title-menu-panel \{([^}]*)\}/.exec(glass), "the sheet rule")[1];
    expect(sheets).toContain("var(--loki-glass-strong)");
    expect(sheets).toContain("var(--loki-glass-blur)");
    const chips = must(/\.loki-chip--float \{([^}]*)\}/.exec(glass), "the chip rule")[1];
    expect(chips).toContain("var(--loki-glass)");
    expect(`${sheets}${chips}`).not.toMatch(/blur\(/);
  });

  test("widgets are sent the page's stylesheet and day or night, so they draw in Liquid Glass's roles", () => {
    const widget = readFileSync(join(APP, "desk", "module-widget.tsx"), "utf8");
    expect(widget).toMatch(/return \{ theme: d\.theme \?\? "dark" \};/);
    expect(widget).toMatch(/attributeFilter: \["data-theme"\]/);
    expect(widget).not.toContain("palette");
  });
});

describe("Preferences and every tab row on Liquid Glass (U8)", () => {
  test("settings sit in a rounded group and a segmented control raises its chosen value", () => {
    expect(must(/\.loki-settings-block \{([^}]*)\}/.exec(glass), "the block rule")[1]).toContain("border-radius: var(--loki-radius-lg)");
    expect(must(/\.loki-segmented > button\[aria-pressed="true"\] \{([^}]*)\}/.exec(glass), "the chosen segment")[1]).toContain("var(--loki-segment)");
  });

  test("a tab row is a track that hugs its tabs, the chosen tab raised; the pane header's track is glass", () => {
    expect(must(/\n\s*\.loki-tabs \{([^}]*)\}/.exec(glass), "the tab row")[1]).toContain("width: fit-content");
    expect(must(/\.loki-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(glass), "the chosen tab")[1]).toContain("var(--loki-segment)");
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
    expect(theme).toMatch(/if \(GLASS_ON\[platform\] === "solid"\) root\.dataset\.glass = "solid";/);
    // the prepaint script says the same before any stylesheet, so Linux never flashes glass
    const html = readFileSync(join(APP, "..", "index.html"), "utf8");
    expect(html).toMatch(/Linux\|X11\|CrOS[^\n]*dataset\.glass = "solid"/);
  });

  test("the ☰ menu on Windows and Linux is the same strong glass as a Mac's menus, solid where glass is off", () => {
    expect(glass).toMatch(/\.loki-title-menu-panel \{[^}]*var\(--loki-glass-strong\)/);
  });
});

describe("one sidebar in place of the rail (U12)", () => {
  test("the places are Chats, Flow, Agents and Learn as rows, with no Preferences row, and Flow's count is grey text", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Places } = await import("../app/src/shell/sidebar.tsx");
    const out = renderToStaticMarkup(createElement(Places, { segment: "desk", onSelect: () => {}, waiting: 2, dueCards: 0 }));
    expect([...out.matchAll(/class="loki-place-label">([^<]+)</g)].map((m) => m[1])).toEqual(["Chats", "Flow", "Agents", "Learn"]);
    expect(out).not.toContain("Preferences");
    expect(out).toContain('aria-label="Flow, 2 waiting"');
    expect(out).toContain('<span aria-hidden="true" class="loki-place-count">2</span>');
    expect(out).not.toContain("--loki-attention");
    expect(must(/\.loki-place-count \{([^}]*)\}/.exec(css), "the count rule")[1]).toContain("var(--loki-muted)");
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
  test("on the Mac the window is transparent with the system's sidebar material; elsewhere it keeps its ground", () => {
    const lib = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
    expect(lib).toMatch(/#\[cfg\(target_os = "macos"\)\]\s*let window = window\.transparent\(true\)\.effects\(/);
    expect(lib).toContain("tauri::window::Effect::Sidebar");
    expect(lib).toMatch(/#\[cfg\(not\(target_os = "macos"\)\)\]\s*let window = window\.background_color\(/);
    const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as { app: { macOSPrivateApi?: boolean } };
    expect(conf.app.macOSPrivateApi).toBe(true);
    expect(readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8")).toMatch(/tauri = \{ version = "2", features = \[[^\]]*"macos-private-api"/);
  });

  test("the page is clear in the Mac app, painted again under Reduce Transparency or Increase Contrast", () => {
    const styles = readFileSync(join(APP, "styles.css"), "utf8");
    // WebKit does not know prefers-reduced-transparency, so the clear rule cannot hang on its no-preference
    expect(styles).not.toContain("prefers-reduced-transparency: no-preference");
    expect(styles).toMatch(/\n:root\[data-vibrant\]:not\(\[data-glass="solid"\]\) \{[\s\S]*?background: transparent;/);
    expect(styles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{\s*:root\[data-vibrant\][\s\S]*?background: var\(--loki-bg\);/,
    );
    const theme = readFileSync(join(APP, "theme.tsx"), "utf8");
    expect(theme).toContain('export const VIBRANT = inTauri && platform === "macos";');
    expect(theme).toContain('if (VIBRANT) root.dataset.vibrant = "on";');
  });

  test("the traffic lights sit inside the inset sidebar, and its toggle is centred on their row", async () => {
    const lib = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
    expect(lib).toContain("traffic_light_position(tauri::LogicalPosition::new(20.0, 22.0))");
    const { GLASS_LIGHTS, sidebarToggleTop, sidebarToggleLeft } = await import("../app/src/shell/sidebar.tsx");
    expect(GLASS_LIGHTS).toEqual({ x: 20, y: 22 });
    // a 28 px toggle centred on 14 pt buttons whose top is at 22
    expect(sidebarToggleTop(true, "macos") + 14).toBe(GLASS_LIGHTS.y + 7);
    expect(sidebarToggleLeft(true, "macos")).toBeGreaterThan(GLASS_LIGHTS.x + 3 * 14 + 2 * 6);
  });

  test("the glass panel is the window's hole onto the material: its ring paints everything else opaque, hidden or shown", () => {
    const hole = must(/&\[data-vibrant\]:not\(\[data-glass="solid"\]\) \.loki-shell-glass \{([^}]*)\}/.exec(glass), "the hole rule")[1];
    expect(hole).toContain("background: transparent");
    expect(hole).toContain("0 0 0 200vmax var(--loki-bg)");
    expect(glass).toMatch(/\.loki-shell-glass\[data-empty\] \{\s*box-shadow: 0 0 0 200vmax var\(--loki-bg\);/);
  });

  test("the chat's moves are toolbar symbols named for the screen reader, and the box has no row of moves under it", async () => {
    const pane = readFileSync(join(APP, "desk", "desk-pane.tsx"), "utf8");
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

describe("the Mac's type scale (U15)", () => {
  const tokens = readFileSync(join(APP, "kit", "tokens.css"), "utf8");
  const scale = (block: string) => Object.fromEntries([...block.matchAll(/--loki-text-(\w+): ([\d.]+)px;/g)].map((m) => [m[1], Number(m[2])]));
  test("the desktop's sizes are AppKit's; the phone keeps a step larger scale for a phone held closer", () => {
    expect(scale(must(/\n:root \{([\s\S]*?)\n\}/.exec(tokens), "the root block")[1])).toEqual({
      micro: 10,
      fine: 10,
      tag: 11,
      meta: 11,
      body: 13,
      row: 13,
      title: 15,
      display: 22,
      hero: 26,
    });
    const phone = readFileSync(join(APP, "phone", "phone.css"), "utf8");
    expect(scale(must(/\n\.loki-phone \{([\s\S]*?)\n\}/.exec(phone), "the phone's root")[1])).toEqual({
      micro: 9.5,
      fine: 10.5,
      tag: 11,
      meta: 12,
      body: 13.5,
      row: 15,
      title: 17,
      display: 22,
      hero: 28,
    });
  });

  test("every desktop size reads a token: no literal font-size or fontSize outside the token files", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? (n === "phone" ? [] : walk(p)) : /\.(tsx|ts|css)$/.test(n) ? [p] : [];
      });
    const hits = walk(APP).flatMap((p) => {
      const text = readFileSync(p, "utf8");
      return [...text.matchAll(/font-size: [\d.]+px|fontSize: [\d.]+\b/g)].map((m) => `${p.slice(APP.length + 1)}: ${m[0]}`);
    });
    expect(hits).toEqual([]);
    const styles = readFileSync(join(APP, "styles.css"), "utf8");
    expect(styles).toContain("--text-body: var(--loki-text-body);");
  });
});

describe("blue for what waits on you, grey for counts and faces (U17)", () => {
  const tokens = readFileSync(join(APP, "kit", "tokens.css"), "utf8");
  const block = (selector: string) => must(new RegExp(`\\n${selector.replace(/[[\]]/g, "\\$&")} \\{([\\s\\S]*?)\\n\\}`).exec(tokens), selector)[1];
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
    const { AgentFace } = await import("../app/src/desk/agent-chip.tsx");
    const out = renderToStaticMarkup(createElement(AgentFace, { name: "friday", src: null }));
    expect(out).toContain("data-monogram");
    expect(out).toContain("var(--loki-monogram-top)");
    expect(out).not.toMatch(/hsl\(\d+ 60% 78%\)/);
  });
});
