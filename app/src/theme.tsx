import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { inTauri } from "./desk/env";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

/** The colour families in kit/tokens.css: loki's own drafting table, and Tokyo Night. Each has a day and a night side. */
export const PALETTES = ["loki", "tokyo-night"] as const;
export type Palette = (typeof PALETTES)[number];
export const PALETTE_LABEL: Record<Palette, string> = { loki: "loki", "tokyo-night": "tokyo night" };

export const THEME_STORAGE_KEY = "loki.theme";
export const PALETTE_STORAGE_KEY = "loki.palette";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function isPalette(value: unknown): value is Palette {
  return typeof value === "string" && (PALETTES as readonly string[]).includes(value);
}

type Storage_ = Pick<Storage, "getItem"> | null;
const defaultStorage = (): Storage_ => (typeof localStorage === "undefined" ? null : localStorage);

function stored<T>(storage: Storage_, key: string, accept: (value: unknown) => value is T, fallback: T): T {
  if (!storage) return fallback;
  try {
    const value = storage.getItem(key);
    return accept(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storedTheme(storage: Storage_ = defaultStorage()): ThemePreference {
  return stored(storage, THEME_STORAGE_KEY, isThemePreference, "system");
}

export function storedPalette(storage: Storage_ = defaultStorage()): Palette {
  return stored(storage, PALETTE_STORAGE_KEY, isPalette, "loki");
}

export function resolvedTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function systemIsDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

function applyTheme(preference: ThemePreference, palette: Palette): void {
  const theme = resolvedTheme(preference, systemIsDark());
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  root.dataset.palette = palette;
  root.style.colorScheme = theme;
  requestAnimationFrame(() => {
    // the phone redeclares --loki-bg on its own root (phone/phone.css); the status bar strip follows that
    const background = getComputedStyle(document.querySelector(".loki-phone") ?? root).getPropertyValue("--loki-bg").trim();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (background && meta) meta.content = background;
  });
  if (inTauri) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(preference === "system" ? null : preference))
      .catch((error) => console.warn("loki: set native theme", error));
  }
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  palette: Palette;
  setPreference: (preference: ThemePreference) => void;
  setPalette: (palette: Palette) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/** One client keeps one preference and one palette. System mode follows the OS while Loki is open. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => storedTheme());
  const [palette, setPalette] = useState<Palette>(() => storedPalette());
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const resolved = resolvedTheme(preference, systemDark);

  useEffect(() => {
    applyTheme(preference, palette);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
      localStorage.setItem(PALETTE_STORAGE_KEY, palette);
    } catch {
      // A blocked storage API should not prevent the theme from applying for this session.
    }
  }, [preference, palette, systemDark]);

  useEffect(() => {
    const media = matchMedia(DARK_QUERY);
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  // Another tab of the same client changed it: follow.
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setPreference(isThemePreference(event.newValue) ? event.newValue : "system");
      if (event.key === PALETTE_STORAGE_KEY) setPalette(isPalette(event.newValue) ? event.newValue : "loki");
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }, []);

  const value = useMemo<ThemeState>(() => ({ preference, resolved, palette, setPreference, setPalette }), [preference, resolved, palette]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used inside ThemeProvider");
  return theme;
}
