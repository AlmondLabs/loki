/**
 * Labels on chats (plan 022): topics the person puts on a chat to find related chats across agents. The rules for a
 * label's name, shared by the daemon that keeps them and the app that types them.
 */

/** The longest a label may be. */
export const LABEL_MAX = 32;
/** The most labels one chat carries. */
export const LABELS_PER_CHAT = 8;
/** How many colours the palette has; a label's colour is an index into it (the app holds the colours themselves). */
export const LABEL_COLORS = 8;

/** One label as Settings › labels and the picker list it: its name, its colour, and how many chats carry it. */
export interface LabelView {
  name: string;
  color: number;
  chats: number;
}

/** A typed word as a label: lowercase letters, digits and dashes ("Client X" → "client-x"); null when nothing is left. */
export function labelName(raw: string): string | null {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, LABEL_MAX)
    .replace(/-+$/, "");
  return name || null;
}

/** A chat's labels as they are kept: each made a label name, blanks and repeats dropped, in order, at most LABELS_PER_CHAT. */
export function chatLabels(raw: readonly string[]): string[] {
  const names = raw.map(labelName).filter((n): n is string => n !== null);
  return [...new Set(names)].slice(0, LABELS_PER_CHAT);
}
