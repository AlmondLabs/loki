import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommentProblem {
  line: number;
  message: string;
}

const TODO_COMMENT = /\b(?:TODO|FIXME)\b/;

function commentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && !/\w/.test(line[i - 1] ?? "")) quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) return i;
  }
  return -1;
}

export function workflowCommentProblems(text: string): CommentProblem[] {
  const problems: CommentProblem[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const at = commentStart(line);
    if (at < 0) continue;
    const comment = line.slice(at);
    if (TODO_COMMENT.test(comment)) {
      problems.push({ line: index + 1, message: "remove TODO/FIXME comments from workflows (docs/style.md §5)" });
    }
  }
  return problems;
}

export function workflowFiles(root: string): string[] {
  return readdirSync(join(root, ".github"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".yml"))
    .map((name) => join(".github", name));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const files = given.length > 0 ? given : workflowFiles(process.cwd());
  let failed = false;
  for (const file of files) {
    for (const p of workflowCommentProblems(readFileSync(file, "utf8"))) {
      console.error(`${file}:${String(p.line)}: ${p.message}`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
