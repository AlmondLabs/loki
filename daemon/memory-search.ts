import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

const BINARY_PROBE_BYTES = 512;
const SNIPPET_LIMIT = 200;

export interface SearchRoot {
  root: string;
  prefix: string;
  excludeSkills?: boolean;
}

interface CollectedFile {
  displayPath: string;
  fullPath: string;
  content: string;
  tf: Map<string, number>;
  len: number;
}

export function isBinaryFile(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(BINARY_PROBE_BYTES);
    const read = readSync(fd, buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function memoryWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 || /\d/.test(w));
}

function walkFiles(root: string, dir = root, excludeSkills = false, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (excludeSkills && dir === root && entry.name === "skills") continue;
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) walkFiles(root, full, excludeSkills, out);
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

function clipLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed;
}

function matchingLines(file: CollectedFile, needle: string, tokens: readonly string[]): Array<{ lineNumber: number; text: string }> {
  const lines = file.content.split("\n");
  const scored: Array<{ lineNumber: number; text: string; exact: number; hits: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const exact = line.toLowerCase().includes(needle) ? 1 : 0;
    let hits = 0;
    if (tokens.length > 0) {
      const lineWords = new Set(memoryWords(line));
      for (const t of tokens) if (lineWords.has(t)) hits++;
    }
    if (exact > 0 || hits > 0) scored.push({ lineNumber: i + 1, text: trimmed, exact, hits });
  }
  if (scored.length > 0) {
    scored.sort((a, b) => b.exact - a.exact || b.hits - a.hits || a.lineNumber - b.lineNumber);
    return scored.map(({ lineNumber, text }) => ({ lineNumber, text }));
  }
  const firstIndex = lines.findIndex((l) => l.trim().length > 0);
  if (firstIndex >= 0) return [{ lineNumber: firstIndex + 1, text: lines[firstIndex].trim() }];
  return [{ lineNumber: 1, text: file.displayPath }];
}

export function searchMemory(roots: readonly SearchRoot[], query: string, pathPrefix: string | null, maxHits = 20): string {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  if (!needle) throw new Error("memory_search needs query");

  const files: CollectedFile[] = [];
  for (const r of roots) {
    if (!existsSync(r.root)) continue;
    for (const rel of walkFiles(r.root, r.root, r.excludeSkills === true)) {
      const displayPath = `${r.prefix}${rel}`;
      if (pathPrefix && displayPath !== pathPrefix && !displayPath.startsWith(`${pathPrefix}/`)) continue;
      const fullPath = join(r.root, rel);
      if (isBinaryFile(fullPath)) continue;
      const content = readFileSync(fullPath, "utf8");
      const docWords = memoryWords(`${displayPath}\n${content}`);
      const tf = new Map<string, number>();
      for (const w of docWords) tf.set(w, (tf.get(w) ?? 0) + 1);
      files.push({ displayPath, fullPath, content, tf, len: docWords.length });
    }
  }

  if (!files.length) return `No memory files match "${trimmed}".`;

  const tokens = [...new Set(memoryWords(trimmed))];
  const avg = Math.max(1, files.reduce((n, f) => n + f.len, 0) / files.length);
  const df = new Map<string, number>();
  for (const f of files) for (const t of tokens) if ((f.tf.get(t) ?? 0) > 0) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.2;
  const b = 0.75;
  const candidates: Array<{ file: CollectedFile; score: number; matchedTokens: number; hasExact: boolean }> = [];
  for (const file of files) {
    const hasExact = file.content.toLowerCase().includes(needle) || file.displayPath.toLowerCase().includes(needle);
    let score = hasExact ? 5 : 0;
    let matchedTokens = 0;
    for (const t of tokens) {
      const tf = file.tf.get(t) ?? 0;
      if (!tf) continue;
      matchedTokens++;
      const dfCount = df.get(t) ?? 0;
      const idf = Math.log(1 + (files.length - dfCount + 0.5) / (dfCount + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * file.len) / avg));
    }
    if (matchedTokens > 0 || hasExact) candidates.push({ file, score, matchedTokens, hasExact });
  }

  if (!candidates.length) return `No memory files match "${trimmed}".`;

  const minTokens = tokens.length <= 4 ? tokens.length : Math.ceil(tokens.length * 0.6);
  const strong = tokens.length > 1 ? candidates.filter((c) => c.hasExact || c.matchedTokens >= minTokens) : candidates;
  const ranked = (strong.length > 0 ? strong : candidates).sort((a, b) => b.score - a.score || a.file.displayPath.localeCompare(b.file.displayPath));

  const hits: string[] = [];
  let found = 0;
  for (const { file } of ranked) {
    const matches = matchingLines(file, needle, tokens);
    found += matches.length;
    for (const m of matches) {
      if (hits.length >= maxHits) break;
      hits.push(`${file.displayPath}:${m.lineNumber}: ${clipLine(m.text)}`);
    }
  }

  const more = found > hits.length ? ` (first ${hits.length} of ${found} shown)` : "";
  return `${found} ${found === 1 ? "match" : "matches"} for "${trimmed}"${more}:\n${hits.join("\n")}`;
}
