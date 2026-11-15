import type { IconName } from "../shared/icons";
/** The pages down Preferences' left side. "loki" is About: its version, the mod, requirements, install. */
export type SettingsPage =
  "loki" | "usage" | "inbox" | "accounts" | "providers" | "engines" | "mcp" | "phone" | "macs" | "skills" | "learn" | "appearance" | "chat" | "labels" | "keys";

/** One of Preferences' groups: a grey heading down its left side over its pages' rows (plan 2026-11-15-1035, R10). */
export interface SettingsGroup {
  title: string;
  pages: readonly SettingsPage[];
}

/** Preferences' groups, in the order its left side lists them, each with its pages in the order of their rows. */
export const GROUPS: readonly SettingsGroup[] = [
  { title: "General", pages: ["appearance", "chat", "keys"] },
  { title: "Models and tools", pages: ["providers", "engines", "mcp", "skills"] },
  { title: "Your devices", pages: ["macs", "phone"] },
  { title: "Flow and Learn", pages: ["inbox", "accounts", "learn"] },
  { title: "Labels", pages: ["labels"] },
  { title: "loki", pages: ["loki", "usage"] },
];

/** Preferences' pages, in the order its left side lists them: the groups' pages, one group after another. */
export const PAGES: Array<{ id: SettingsPage }> = GROUPS.flatMap((g) => g.pages.map((id) => ({ id })));

/** The page's name in the section list and on its heading: sentence case (loki is the product's own spelling). */
const TITLES: Record<SettingsPage, string> = {
  loki: "About",
  usage: "Usage",
  inbox: "Flow",
  accounts: "Accounts",
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

/**
 * Each page's symbol in its row, white-on-colour in a rounded square as System Settings draws them (plan 2026-11-15-1035,
 * R10). The colour is one of the eight chat-label tokens, which hold their contrast in day and night; the symbol is
 * drawn in the ground's colour, so it reads on the light label colours of the dark theme as on the dark ones of the light.
 */
export const PAGE_ICON: Record<SettingsPage, { icon: IconName; tint: string }> = {
  appearance: { icon: "palette", tint: "var(--loki-label-5)" },
  chat: { icon: "desk", tint: "var(--loki-label-3)" },
  keys: { icon: "keyboard", tint: "var(--loki-label-6)" },
  providers: { icon: "cpu", tint: "var(--loki-label-5)" },
  engines: { icon: "terminal", tint: "var(--loki-label-7)" },
  mcp: { icon: "plug", tint: "var(--loki-label-1)" },
  skills: { icon: "skill", tint: "var(--loki-label-4)" },
  macs: { icon: "laptop", tint: "var(--loki-label-5)" },
  phone: { icon: "phone", tint: "var(--loki-label-3)" },
  inbox: { icon: "inbox", tint: "var(--loki-label-5)" },
  accounts: { icon: "mail", tint: "var(--loki-label-0)" },
  learn: { icon: "learn", tint: "var(--loki-label-2)" },
  labels: { icon: "tag", tint: "var(--loki-label-1)" },
  loki: { icon: "info", tint: "var(--loki-label-4)" },
  usage: { icon: "chart", tint: "var(--loki-label-6)" },
};

/** Other words a page is found by, in the list's filter and in ⌘K search. */
export const PAGE_WORDS: Partial<Record<SettingsPage, string[]>> = {
  loki: ["loki", "daemon", "node", "mod", "version", "update", "install", "files", "folders", "logs"],
  usage: ["cost", "spend", "tokens", "price"],
  inbox: ["inbox", "order", "score", "focus", "archive", "lane", "lanes"],
  accounts: ["gmail", "email", "mail", "slack", "connect", "google", "jira", "atlassian", "token"],
  providers: ["models", "api key", "openai", "anthropic"],
  engines: ["claude code", "acp", "agents"],
  mcp: ["tools"],
  phone: ["pairing", "wi-fi", "lan", "tailscale"],
  macs: ["pairing", "tailscale", "mesh"],
  appearance: ["theme", "dark mode", "light mode", "colours"],
  chat: ["panel", "width", "always allowed", "approvals", "chat links", "links"],
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
 * A saved page as Preferences opens on it: "files" (folded into the loki page by plan 031) is About; anything
 * unknown is the first page.
 */
export function savedPage(v: unknown): SettingsPage {
  if (v === "files") return "loki";
  return isSettingsPage(v) ? v : PAGES[0].id;
}

/**
 * The page an arrow key in the page list moves to (plan 2026-11-15-1035, KTD8): ↑↓ the page before or after, stopping at
 * the ends as System Settings' list does, Home and End the first and last, among the pages the filter left (`pages`);
 * null when the key is not the list's or there is nowhere to go.
 */
export function pageAfterKey(page: SettingsPage, key: string, pages: readonly SettingsPage[] = PAGES.map((p) => p.id)): SettingsPage | null {
  if (!pages.length) return null;
  const at = pages.indexOf(page);
  const to =
    key === "ArrowDown"
      ? at < 0
        ? 0
        : Math.min(at + 1, pages.length - 1)
      : key === "ArrowUp"
        ? at < 0
          ? pages.length - 1
          : Math.max(at - 1, 0)
        : key === "Home"
          ? 0
          : key === "End"
            ? pages.length - 1
            : null;
  return to === null || pages[to] === page ? null : pages[to];
}
