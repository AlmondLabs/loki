/**
 * A message as one line of preview text: the first non-empty line, markdown's marks taken out (bold, italics, code,
 * headings, quotes, list bullets, link targets), runs of space as one. "Use **Next** to step" reads "Use Next to step".
 */
export function previewLine(text: string | null | undefined, max = 160): string | null {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const plain = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? plain.slice(0, max) : null;
}
