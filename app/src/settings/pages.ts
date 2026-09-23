/** The pages down Preferences' left side, in order. "letta" gathers what loki runs on: harness, mod, requirements, install. */
export type SettingsPage = "letta" | "inbox" | "providers" | "phone" | "skills" | "learn" | "appearance" | "chat" | "files" | "keys";
export const PAGES: Array<{ id: SettingsPage }> = [{ id: "letta" }, { id: "inbox" }, { id: "providers" }, { id: "phone" }, { id: "skills" }, { id: "learn" }, { id: "appearance" }, { id: "chat" }, { id: "files" }, { id: "keys" }];

/** The page's name in the section list and on its heading: sentence case (Letta is the product's own spelling). */
const TITLES: Record<SettingsPage, string> = { letta: "Letta", inbox: "Inbox", providers: "Providers", phone: "Phone", skills: "Skills", learn: "Learn", appearance: "Appearance", chat: "Chat", files: "Files", keys: "Keys" };
export const pageTitle = (p: SettingsPage): string => TITLES[p];

export function isSettingsPage(v: unknown): v is SettingsPage {
  return PAGES.some((p) => p.id === v);
}

/** The page Preferences opens on, kept for the window; ⌘K search sets it to open Preferences on a page. */
export const SETTINGS_PAGE_KEY = "loki.settingsPage";

/** The page an arrow key in the section list moves to (↑↓ wrap, Home, End), or null when the key is not the list's. */
export function pageAfterKey(page: SettingsPage, key: string): SettingsPage | null {
  const at = PAGES.findIndex((p) => p.id === page);
  const to = key === "ArrowDown" ? at + 1 : key === "ArrowUp" ? at - 1 : key === "Home" ? 0 : key === "End" ? PAGES.length - 1 : null;
  return to === null ? null : PAGES[(to + PAGES.length) % PAGES.length].id;
}
