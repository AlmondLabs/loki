import { describe, expect, test } from "bun:test";
import { isThemePreference, resolvedTheme, storedTheme, THEME_STORAGE_KEY } from "../app/src/theme.tsx";

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

  test("system resolves with the OS while explicit choices stay fixed", () => {
    expect(resolvedTheme("system", false)).toBe("light");
    expect(resolvedTheme("system", true)).toBe("dark");
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
  });
});
