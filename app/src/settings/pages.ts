/** The pages down Preferences' left side, in order. "letta" gathers what loki runs on: harness, mod, requirements, install. */
export type SettingsPage = "letta" | "inbox" | "providers" | "phone" | "skills" | "learn" | "appearance" | "chat" | "files" | "keys";
export const PAGES: Array<{ id: SettingsPage }> = [{ id: "letta" }, { id: "inbox" }, { id: "providers" }, { id: "phone" }, { id: "skills" }, { id: "learn" }, { id: "appearance" }, { id: "chat" }, { id: "files" }, { id: "keys" }];

/** The page's name in the section list and on its heading: sentence case (Letta is the product's own spelling). */
const TITLES: Record<SettingsPage, string> = { letta: "Letta", inbox: "Inbox", providers: "Providers", phone: "Phone", skills: "Skills", learn: "Learn", appearance: "Appearance", chat: "Chat", files: "Files", keys: "Keys" };
export const pageTitle = (p: SettingsPage): string => TITLES[p];

export function isSettingsPage(v: unknown): v is SettingsPage {
  return PAGES.some((p) => p.id === v);
}
