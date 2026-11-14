import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { inTauri, platform, type Platform } from "./desk/env";

/** The appearance choices: follow the system, or always light or dark. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
/** An appearance choice. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
/** The appearance in effect, with the system's choice resolved. */
export type ResolvedTheme = Exclude<ThemePreference, "system">;

/** The localStorage key the appearance choice is kept under. */
export const THEME_STORAGE_KEY = "loki.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Where Liquid Glass may blur (plan 2026-11-12-1505, KTD6): a constant in one place, moved only by measurement against
 * the speed budget, never probed at launch. Linux's web view blurs slowly, so it starts on the solid look-alike; the
 * Mac and Windows start on glass. The system's Reduce Transparency and Increase Contrast turn glass solid everywhere.
 */
export const GLASS_ON: Record<Platform, "glass" | "solid"> = { macos: "glass", windows: "glass", linux: "solid" };

/**
 * Whether this window has the Mac's own sidebar material behind a transparent page (plan 2026-11-12-1505, U13): the
 * Mac app's window only. Liquid Glass lets it through the sidebar (components.css); a browser tab has none.
 */
export const VIBRANT = inTauri && platform === "macos";

/** Whether a value (a stored one, say) is an appearance choice. */
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

/** The stored appearance choice; "system" when none is stored or it cannot be read. */
export function storedTheme(storage: MaybeStorage = defaultStorage()): ThemePreference {
  return stored(storage, THEME_STORAGE_KEY, isThemePreference, "system");
}

/** The appearance in effect: the preference, or the system's when it is "system". */
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
  if (GLASS_ON[platform] === "solid") root.dataset.glass = "solid";
  // The Mac's window carries the system's sidebar material behind the page (src-tauri lib.rs, U13).
  if (VIBRANT) root.dataset.vibrant = "on";
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
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/** One client keeps one preference. System mode follows the OS while Loki is open. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => storedTheme());
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

  // Another tab of the same client changed it: follow.
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

/** The window's appearance and its setter; throws outside ThemeProvider. */
export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used inside ThemeProvider");
  return theme;
}
