export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set(["ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "pwd"]);

const UNSAFE_FLAGS: Readonly<Partial<Record<string, (word: string) => boolean>>> = {
  find: (w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w),
  rg: (w) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(w),
};

const SHELL_SYNTAX = new Set([";", "&", ">", "<", "`", "$", "(", ")", "{", "}", "\\", "\n", "\r"]);

const GLOB = new Set(["*", "?", "["]);

export interface CommandWord {
  text: string;
  glob: boolean;
}

function pipeline(command: string): CommandWord[][] | null {
  const parts: CommandWord[][] = [[]];
  let word: CommandWord | null = null;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (word !== null) parts[parts.length - 1].push(word);
    word = null;
  };
  const add = (ch: string, glob = false) => {
    word ??= { text: "", glob: false };
    word.text += ch;
    word.glob ||= glob;
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return null;
      else add(ch);
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= { text: "", glob: false };
    } else if (ch === "|") {
      end();
      parts.push([]);
    } else if (ch === " " || ch === "\t") end();
    else if (SHELL_SYNTAX.has(ch)) return null;
    else add(ch, GLOB.has(ch));
  }
  if (quote) return null;
  end();
  return parts;
}

export function commandWords(command: unknown): CommandWord[][] | null {
  return typeof command === "string" && command.trim() ? pipeline(command.trim()) : null;
}

export function isReadOnlyCommand(command: unknown): boolean {
  const parts = commandWords(command);
  if (!parts) return false;
  return parts.every((words) => {
    if (words.length === 0) return false;
    const [program, ...args] = words.map((w) => w.text);
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    const unsafe = UNSAFE_FLAGS[program];
    return !unsafe || !args.some(unsafe);
  });
}
