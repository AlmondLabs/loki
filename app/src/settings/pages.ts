/** The pages down Preferences' left side. "loki" is About: its version, the mod, requirements, install. */
export type SettingsPage =
  "loki" | "usage" | "inbox" | "providers" | "engines" | "mcp" | "phone" | "macs" | "skills" | "learn" | "appearance" | "chat" | "labels" | "keys";

/** One of Preferences' groups: a row down its left side, and a page whose tabs are the group's pages (plan 031). */
export interface SettingsGroup {
  title: string;
  pages: readonly SettingsPage[];
}

/** Preferences' groups, in the order its left side lists them, each with its pages in the order of its tabs. */
export const GROUPS: readonly SettingsGroup[] = [
  { title: "General", pages: ["appearance", "chat", "keys"] },
  { title: "Models and tools", pages: ["providers", "engines", "mcp", "skills"] },
  { title: "Your devices", pages: ["macs", "phone"] },
  { title: "Inbox and Learn", pages: ["inbox", "learn"] },
  { title: "Labels", pages: ["labels"] },
  { title: "loki", pages: ["loki", "usage"] },
];

/** The group a page is a tab of. */
export const groupOf = (page: SettingsPage): SettingsGroup => GROUPS.find((g) => g.pages.includes(page)) ?? GROUPS[0];

/** Preferences' pages, in the order its left side lists them: the groups' pages, one group after another. */
export const PAGES: Array<{ id: SettingsPage }> = GROUPS.flatMap((g) => g.pages.map((id) => ({ id })));

/** The page's name in the section list and on its heading: sentence case (loki is the product's own spelling). */
const TITLES: Record<SettingsPage, string> = {
  loki: "About",
  usage: "Usage",
  inbox: "Inbox",
  providers: "Providers",
  engines: "Engines",
  mcp: "MCP servers",
  phone: "Phone",
  macs: "Macs",
  skills: "Skills",
  learn: "Learn",
  appearance: "Appearance",
  chat: "Chat",
  labels: "Labels",
  keys: "Keyboard shortcuts",
};
/** The page's name in the section list and on its heading. */
export const pageTitle = (p: SettingsPage): string => TITLES[p];

/** Other words a page is found by, in the list's filter and in ⌘K search. */
export const PAGE_WORDS: Partial<Record<SettingsPage, string[]>> = {
  loki: ["loki", "daemon", "node", "mod", "version", "update", "install", "import", "letta", "files", "folders", "logs"],
  usage: ["cost", "spend", "tokens", "price"],
  inbox: ["order", "score", "focus", "archive"],
  providers: ["models", "api key", "openai", "anthropic"],
  engines: ["claude code", "acp", "agents"],
  mcp: ["tools"],
  phone: ["pairing", "wi-fi", "lan", "tailscale"],
  macs: ["pairing", "tailscale", "mesh"],
  appearance: ["theme", "dark mode", "light mode", "palette", "colours"],
  chat: ["panel", "width", "always allowed", "approvals"],
  learn: ["recall", "cards"],
  keys: ["keys", "shortcuts", "keyboard"],
};

/** The pages a filter leaves, in list order: those whose name, group or words hold it, case aside; all for none. */
export function pagesMatching(query: string): SettingsPage[] {
  const q = query.trim().toLowerCase();
  return GROUPS.flatMap((g) => g.pages.filter((p) => !q || [pageTitle(p), g.title, ...(PAGE_WORDS[p] ?? [])].some((w) => w.toLowerCase().includes(q))));
}

/** Whether a value (a saved page, say) names a Preferences page. */
export function isSettingsPage(v: unknown): v is SettingsPage {
  return PAGES.some((p) => p.id === v);
}

/** The page Preferences opens on, kept for the window; ⌘K search sets it to open Preferences on a page. */
export const SETTINGS_PAGE_KEY = "loki.settingsPage";

/**
 * A saved page as Preferences opens on it: "letta" (the loki page's old id) and "files" (folded into it by plan 031)
 * are About; anything unknown is the first page.
 */
export function savedPage(v: unknown): SettingsPage {
  if (v === "letta" || v === "files") return "loki";
  return isSettingsPage(v) ? v : PAGES[0].id;
}

/**
 * The page an arrow key in the group list moves to (↑↓ wrap, Home, End): the first page, of those the filter left
 * (`pages`), in the group before or after the chosen page's; null when the key is not the list's.
 */
export function pageAfterKey(page: SettingsPage, key: string, pages: readonly SettingsPage[] = PAGES.map((p) => p.id)): SettingsPage | null {
  const groups = GROUPS.map((g) => g.pages.filter((p) => pages.includes(p))).filter((g) => g.length > 0);
  if (!groups.length) return null;
  const at = groups.findIndex((g) => groupOf(g[0]) === groupOf(page));
  const to =
    key === "ArrowDown" ? at + 1 : key === "ArrowUp" ? (at < 0 ? groups.length - 1 : at - 1) : key === "Home" ? 0 : key === "End" ? groups.length - 1 : null;
  return to === null ? null : groups[(to + groups.length) % groups.length][0];
}
