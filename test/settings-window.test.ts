import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Plan 2026-11-12-1505, U18: Settings in a window of its own on the Mac, under Liquid Glass. The window itself is the
// shell's (a browser cannot open one), so these read what opens it, what it loads and how the two windows keep step.

const ROOT = join(import.meta.dirname, "..");
const APP = join(ROOT, "app", "src");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("the Settings window", () => {
  test("the shell opens one Settings window, reuses it, and grants it the main window's capability", () => {
    const lib = read(ROOT, "src-tauri", "src", "lib.rs");
    expect(lib).toContain('const SETTINGS_WINDOW: &str = "settings";');
    expect(lib).toMatch(/if let Some\(win\) = app\.get_webview_window\(SETTINGS_WINDOW\)/);
    expect(lib).toContain('app.emit_to(SETTINGS_WINDOW, "loki:settings-page", p)');
    expect(lib).toContain(".initialization_script(settings_script(page.as_deref()))");
    expect(lib).toMatch(/generate_handler!\[[^\]]*open_settings/);
    const caps = JSON.parse(read(ROOT, "src-tauri", "capabilities", "default.json")) as { windows: string[] };
    expect(caps.windows).toEqual(["main", "settings"]);
  });

  test("the page boots the settings-only root in that window, and the shell sends Preferences there under Liquid Glass on the Mac", () => {
    expect(read(APP, "boot.tsx")).toMatch(/window\.__LOKI__\?\.window === "settings"\s*\? \(await import\("\.\/shell\/settings-window"\)\)\.SettingsWindow/);
    const win = read(APP, "shell", "settings-window.tsx");
    expect(win).toContain('export const SETTINGS_WINDOW = inTauri && platform === "macos";');
    expect(win).toContain("<Settings key={opening.n} {...preferencesProps(sources)} windowed initialPage={opening.page} />");
    const shell = read(APP, "shell", "shell.tsx");
    expect(shell).toContain("const settingsWindow = glass && SETTINGS_WINDOW;");
    expect(shell).toContain("if (settingsWindow) return openSettingsWindow(page);");
    expect(shell).toContain('if (settingsWindow && id === "segment.settings") return openSettingsWindow();');
    expect(shell).toContain('if (t.kind === "preferences") return showPreferences(t.page);');
  });

  test("the sheet and the window take Preferences' inputs from one mapping", () => {
    const views = read(APP, "shell", "views.tsx");
    expect(views).toContain("export function preferencesProps(");
    expect(views).toContain("<Preferences onClose={onClose} {...preferencesProps(sources)} />");
  });

  test("the chat layout, the system-wide key and the models follow the other window's storage", () => {
    const layout = read(APP, "shell", "use-chat-layout.ts");
    expect(layout).toContain("useStorageKey(CHAT_WIDTH_KEY,");
    expect(layout).toContain("useStorageKey(CHAT_PLACEMENT_KEY,");
    expect(read(APP, "shell", "use-global-shortcut.ts")).toContain("useStorageKey(KEY,");
    expect(read(APP, "shell", "shell.tsx")).toContain("useStorageKey(MODELS_CHANGED_KEY, () => forgetModels());");
  });
});

describe("a session value kept in localStorage follows another window", () => {
  const saved = { window: (globalThis as { window?: unknown }).window, add: (globalThis as { addEventListener?: unknown }).addEventListener };
  afterEach(() => {
    Object.assign(globalThis, { window: saved.window, addEventListener: saved.add });
    vi.resetModules();
  });

  test("a storage event on its key moves the value and tells its readers; another key or store does not", async () => {
    const heard: Array<(e: { key: string; storageArea: unknown; newValue: string | null }) => void> = [];
    Object.assign(globalThis, { window: globalThis, addEventListener: (_: string, fn: (typeof heard)[number]) => heard.push(fn) });
    vi.resetModules();
    const { createSessionValue } = await import("../app/src/shared/session-value.ts");
    const store = new Map<string, string>();
    const area = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    const value = createSessionValue<"on" | "off">(
      "loki.thread-preview",
      (raw) => (raw === "on" ? "on" : "off"),
      () => area,
    );
    let told = 0;
    value.subscribe(() => told++);
    expect(value.get()).toBe("off");
    for (const fn of heard) fn({ key: "loki.other", storageArea: area, newValue: "on" });
    for (const fn of heard) fn({ key: "loki.thread-preview", storageArea: {}, newValue: "on" });
    expect([value.get(), told]).toEqual(["off", 0]);
    for (const fn of heard) fn({ key: "loki.thread-preview", storageArea: area, newValue: "on" });
    expect([value.get(), told]).toEqual(["on", 1]);
  });
});
