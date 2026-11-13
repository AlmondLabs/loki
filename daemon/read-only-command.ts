/**
 * Whether a shell command only reads (plan 094, KTD2), so the approval gate can weigh a `bash` call as a read: listing a
 * folder, finding files and searching them were once tools of their own, and asked nothing in the standard modes. The
 * check never runs anything. It splits the command into words as the shell quotes them and accepts only a pipeline of
 * the programs below, by their bare names, with none of the flags that make one write or run another program. Anything
 * else, including any shell syntax it does not follow, is a command: a wrong "command" costs the person a card, a wrong
 * "read" would run something unasked.
 */

/** The programs a read-only command may be made of; none writes a file or starts another program by itself. */
export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set(["ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "pwd"]);

/** Flags that make a listed program write a file or run another program: `find -exec rm …`, `rg --pre cmd`. */
const UNSAFE_FLAGS: Readonly<Partial<Record<string, (word: string) => boolean>>> = {
  find: (w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w),
  rg: (w) => w === "--pre" || w.startsWith("--pre=") || w === "--pre-glob" || w.startsWith("--pre-glob="),
};

/** Characters that, outside quotes, would let a command do more than its words say: lists, redirects, substitutions. */
const SHELL_SYNTAX = new Set([";", "&", ">", "<", "`", "$", "(", ")", "{", "}", "\\", "\n", "\r"]);

/**
 * The command's pipeline as words, one list per piped part; null when it uses anything but plain words, quotes and
 * `|`. Inside double quotes, `$`, a backquote and a backslash still mean something to the shell, so they make it null.
 */
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

/** Whether a `bash` call's command only reads: a pipeline of READ_ONLY_PROGRAMS with no unsafe flag. */
export function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const parts = pipeline(command.trim());
  if (!parts) return false;
  return parts.every((words) => {
    // An empty part is a pipe with nothing on one side, `ls |` or `ls || rm`.
    if (words.length === 0) return false;
    const [program, ...args] = words;
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    const unsafe = UNSAFE_FLAGS[program];
    return !unsafe || !args.some(unsafe);
  });
}
