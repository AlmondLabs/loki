export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set(["ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "pwd"]);

const UNSAFE_FLAGS: Readonly<Partial<Record<string, (word: string) => boolean>>> = {
  find: (w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w),
  rg: (w) => w === "--pre" || w.startsWith("--pre=") || w === "--pre-glob" || w.startsWith("--pre-glob="),
};

const SHELL_SYNTAX = new Set([";", "&", ">", "<", "`", "$", "(", ")", "{", "}", "\\", "\n", "\r"]);

function pipeline(command: string): string[][] | null {
  const parts: string[][] = [[]];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (word !== null) parts[parts.length - 1].push(word);
    word = null;
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return null;
      else word = (word ?? "") + ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (ch === "|") {
      end();
      parts.push([]);
    } else if (ch === " " || ch === "\t") end();
    else if (SHELL_SYNTAX.has(ch)) return null;
    else word = (word ?? "") + ch;
  }
  if (quote) return null;
  end();
  return parts;
}

export function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const parts = pipeline(command.trim());
  if (!parts) return false;
  return parts.every((words) => {
    if (words.length === 0) return false;
    const [program, ...args] = words;
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    const unsafe = UNSAFE_FLAGS[program];
    return !unsafe || !args.some(unsafe);
  });
}
