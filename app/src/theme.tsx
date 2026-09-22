import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { inTauri } from "./desk/env";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "loki.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function storedTheme(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): ThemePreference {
  if (!storage) return "system";
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
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
  root.style.colorScheme = theme;
  requestAnimationFrame(() => {
    const background = getComputedStyle(root).getPropertyValue("--loki-bg").trim();
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
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/** One client keeps one preference. System mode follows the OS while Loki is open. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => storedTheme());
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const resolved = resolvedTheme(preference, systemDark);

  useEffect(() => {
    applyTheme(preference);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // A blocked storage API should not prevent the theme from applying for this session.
    }
  }, [preference, systemDark]);

  useEffect(() => {
    const media = matchMedia(DARK_QUERY);
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setPreferenceState(isThemePreference(event.newValue) ? event.newValue : "system");
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }, []);

  const setPreference = setPreferenceState; // the [preference, systemDark] effect applies it

  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used inside ThemeProvider");
  return theme;
}
