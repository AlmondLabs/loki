import { describe, expect, test } from "bun:test";
import { isPalette, isThemePreference, PALETTE_STORAGE_KEY, PALETTES, resolvedTheme, storedPalette, storedTheme, THEME_STORAGE_KEY } from "../app/src/theme.tsx";

describe("theme preference", () => {
  test("accepts only the three preferences", () => {
    expect(["system", "light", "dark"].map(isThemePreference)).toEqual([true, true, true]);
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  test("reads storage and falls back to system", () => {
    expect(storedTheme({ getItem: (key) => (key === THEME_STORAGE_KEY ? "light" : null) })).toBe("light");
    expect(storedTheme({ getItem: () => "sepia" })).toBe("system");
    expect(storedTheme({ getItem: () => { throw new Error("blocked"); } })).toBe("system");
    expect(storedTheme(null)).toBe("system");
  });

  test("the palette is a known family and falls back to loki's own", () => {
    expect(PALETTES.map(isPalette)).toEqual([true, true]);
    expect(isPalette("dracula")).toBe(false);
    expect(storedPalette({ getItem: (key) => (key === PALETTE_STORAGE_KEY ? "tokyo-night" : null) })).toBe("tokyo-night");
    expect(storedPalette({ getItem: () => "dracula" })).toBe("loki");
    expect(storedPalette({ getItem: () => { throw new Error("blocked"); } })).toBe("loki");
    expect(storedPalette(null)).toBe("loki");
  });

  test("system resolves with the OS while explicit choices stay fixed", () => {
    expect(resolvedTheme("system", false)).toBe("light");
    expect(resolvedTheme("system", true)).toBe("dark");
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
  });
});
