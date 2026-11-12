import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { inTauri } from "./desk/env";

/** The appearance choices: follow the system, or always light or dark. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
/** An appearance choice. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
/** The appearance in effect, with the system's choice resolved. */
export type ResolvedTheme = Exclude<ThemePreference, "system">;

/**
 * The colour families in kit/tokens.css: loki's own, Tokyo Night, and Liquid Glass (Apple's Human Interface Guidelines,
 * plan 2026-11-12-1505), the new look being built one screen at a time. Each has a day and a night side.
 */
export const PALETTES = ["loki", "tokyo-night", "apple"] as const;
/** One of loki's colour families. */
export type Palette = (typeof PALETTES)[number];
/** Each palette's name as Preferences shows it. */
export const PALETTE_LABEL: Record<Palette, string> = { loki: "loki", "tokyo-night": "tokyo night", apple: "liquid glass" };

/** The localStorage key the appearance choice is kept under. */
export const THEME_STORAGE_KEY = "loki.theme";
/** The localStorage key the palette is kept under. */
export const PALETTE_STORAGE_KEY = "loki.palette";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Whether a value (a stored one, say) is an appearance choice. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Whether a value (a stored one, say) names a palette. */
export function isPalette(value: unknown): value is Palette {
  return typeof value === "string" && (PALETTES as readonly string[]).includes(value);
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

/** The stored appearance choice; "system" when none is stored or it cannot be read. */
export function storedTheme(storage: MaybeStorage = defaultStorage()): ThemePreference {
  return stored(storage, THEME_STORAGE_KEY, isThemePreference, "system");
}

/** The stored palette; loki's own when none is stored or it cannot be read. */
export function storedPalette(storage: MaybeStorage = defaultStorage()): Palette {
  return stored(storage, PALETTE_STORAGE_KEY, isPalette, "loki");
}

/** The appearance in effect: the preference, or the system's when it is "system". */
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

/** The window's appearance and palette and their setters; throws outside ThemeProvider. */
export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used inside ThemeProvider");
  return theme;
}

/** Which look draws the window: Liquid Glass (the apple family, plan 2026-11-12-1505) or today's. */
export type Look = "glass" | "classic";

/**
 * The look in effect, for the few places where it changes words or structure rather than colour: Apple's title case
 * and the approval as a question under Liquid Glass. Outside ThemeProvider (a test rendering one component) it is
 * today's look, so components stay renderable on their own.
 */
export function useLook(): Look {
  const forced = useContext(LookContext);
  const palette = useContext(ThemeContext)?.palette;
  return forced ?? (palette === "apple" ? "glass" : "classic");
}

const LookContext = createContext<Look | null>(null);

/**
 * Draws its children in one look whatever this device has chosen: the Liquid Glass workbench (dev/workbench.tsx)
 * shows the new look without touching the saved palette.
 */
export function LookProvider({ look, children }: { look: Look; children: ReactNode }) {
  return <LookContext.Provider value={look}>{children}</LookContext.Provider>;
}
