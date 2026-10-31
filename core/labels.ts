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

/** One label as Preferences › Labels and the picker list it: its name, its colour, and how many chats carry it. */
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

/**
 * A query typed in the sidebar's filter or ⌘K, split into its `label:` terms (each a label name) and the words left
 * over (plan 022, R4): "label:infra deploy" is the label infra and the words "deploy".
 */
export function labelQuery(raw: string): { labels: string[]; text: string } {
  const labels: string[] = [];
  const words: string[] = [];
  for (const word of raw.trim().split(/\s+/)) {
    const term = /^label:(.*)$/i.exec(word);
    const name = term ? labelName(term[1]) : null;
    if (name) labels.push(name);
    else if (word && !term) words.push(word);
  }
  return { labels, text: words.join(" ") };
}

/**
 * The query with the label `name` taken out when it is in force, else added (the phone's label chips, plan 028): the
 * other terms and the words keep their order.
 */
export function toggleLabelTerm(raw: string, name: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const on = words.filter((w) => /^label:/i.test(w) && labelName(w.slice(6)) === name);
  return (on.length ? words.filter((w) => !on.includes(w)) : [...words, `label:${name}`]).join(" ");
}
