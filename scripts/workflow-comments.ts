import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { markerVerdict } from "../eslint-comments.mjs";

export interface CommentProblem {
  line: number;
  message: string;
}

const PINNED_VERSION = /^#\s*v\d+(\.\d+)*\s*$/;
const LINK = /https?:\/\//;

function commentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) return i;
  }
  return -1;
}

export function workflowCommentProblems(text: string): CommentProblem[] {
  const problems: CommentProblem[] = [];
  const lines = text.split("\n");
  let groupOpen = false;
  lines.forEach((line, index) => {
    const at = commentStart(line);
    if (at < 0) {
      groupOpen = false;
      return;
    }
    const comment = line.slice(at);
    const ownLine = line.slice(0, at).trim() === "";
    if (ownLine && groupOpen) return;
    groupOpen = ownLine;
    if (PINNED_VERSION.test(comment) || LINK.test(comment)) return;
    const marker = markerVerdict(comment.replace(/^#\s?/, ""));
    if (marker === "listed") return;
    problems.push({
      line: index + 1,
      message:
        marker === "none"
          ? "say this with a step's name or a clearer command (docs/style.md §5); a comment stays only as `Outside (<what>): …`, a link, or a pinned action's `# vX.Y.Z`"
          : `\`${marker}\` is not on the list of outside things in eslint-comments.mjs`,
    });
  });
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
