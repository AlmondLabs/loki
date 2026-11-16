export const LABEL_MAX = 32;
export const LABELS_PER_CHAT = 8;
export const LABEL_COLORS = 8;

export interface LabelView {
  name: string;
  color: number;
  chats: number;
}

export function labelName(raw: string): string | null {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, LABEL_MAX)
    .replace(/-+$/, "");
  return name || null;
}

export function chatLabels(raw: readonly string[]): string[] {
  const names = raw.map(labelName).filter((n): n is string => n !== null);
  return [...new Set(names)].slice(0, LABELS_PER_CHAT);
}

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

export function toggleLabelTerm(raw: string, name: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const on = words.filter((w) => /^label:/i.test(w) && labelName(w.slice(6)) === name);
  return (on.length ? words.filter((w) => !on.includes(w)) : [...words, `label:${name}`]).join(" ");
}
