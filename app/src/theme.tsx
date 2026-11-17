import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { inLan, inTauri, platform, type Platform } from "./desk/env";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "loki.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export const GLASS_ON: Record<Platform, "glass" | "solid"> = { macos: "glass", windows: "glass", linux: "solid" };

export const VIBRANT = inTauri && platform === "macos";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

type MaybeStorage = Pick<Storage, "getItem"> | null;
const defaultStorage = (): MaybeStorage => (typeof localStorage === "undefined" ? null : localStorage);

function stored<T>(storage: MaybeStorage, key: string, accept: (value: unknown) => value is T, fallback: T): T {
  if (!storage) return fallback;
  try {
    const value = storage.getItem(key);
    return accept(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storedTheme(storage: MaybeStorage = defaultStorage()): ThemePreference {
  return stored(storage, THEME_STORAGE_KEY, isThemePreference, "system");
}

export function resolvedTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function systemIsDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

function applyTheme(preference: ThemePreference): void {
  const theme = resolvedTheme(preference, systemIsDark());
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  if (GLASS_ON[platform] === "solid" && !inLan) root.dataset.glass = "solid";
  if (VIBRANT) root.dataset.vibrant = "on";
  root.style.colorScheme = theme;
  requestAnimationFrame(() => {
    const background = getComputedStyle(document.querySelector(".loki-phone") ?? root)
      .getPropertyValue("--loki-bg")
      .trim();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (background && meta) meta.content = background;
  });
  if (inTauri) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(preference === "system" ? null : preference))
      .catch((error: unknown) => console.warn("loki: set native theme", error));
  }
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => storedTheme());
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const resolved = resolvedTheme(preference, systemDark);

  useEffect(() => {
    applyTheme(preference);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {}
  }, [preference, systemDark]);

  useEffect(() => {
    const media = matchMedia(DARK_QUERY);
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setPreference(isThemePreference(event.newValue) ? event.newValue : "system");
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }, []);

  const value = useMemo<ThemeState>(() => ({ preference, resolved, setPreference }), [preference, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used inside ThemeProvider");
  return theme;
}
