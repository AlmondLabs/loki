/**
 * A pull request's title, held to Conventional Commits as docs/STYLE.md §9 has it, since the title becomes the merge
 * commit's message: `type(scope): what changed`. Run by .github/workflows/pr-title.yml with the title in PR_TITLE:
 *   PR_TITLE="feat(tasks): add task from a chat message" node --experimental-strip-types scripts/check-pr-title.ts
 */

/** The kinds of change, as Conventional Commits names them. */
export const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"] as const;

/** loki's areas, as a scope may name them. */
export const SCOPES = [
  "chat",
  "tasks",
  "mcp",
  "learn",
  "phone",
  "desk",
  "inbox",
  "agents",
  "settings",
  "daemon",
  "mod",
  "core",
  "app",
  "shell",
  "release",
  "deps",
  "style",
] as const;

/** The longest title, as a commit subject is kept. */
export const MAX_TITLE = 72;

const SHAPE = /^(?<type>[a-z]+)(?:\((?<scope>[a-z-]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

/** What is wrong with a title, or null when it follows the guide. */
export function titleProblem(title: string): string | null {
  const t = title.trim();
  // GitHub's own revert button titles the PR `Revert "<the original title>"`.
  if (/^Revert ".+"$/.test(t)) return null;
  const m = SHAPE.exec(t);
  if (!m?.groups) return 'the shape is "type(scope): what changed", e.g. "feat(tasks): add task from a chat message"';
  const { type, scope, subject } = m.groups;
  if (!(TYPES as readonly string[]).includes(type)) return `"${type}" is not a type; one of ${TYPES.join(", ")}`;
  if (scope && !(SCOPES as readonly string[]).includes(scope)) return `"${scope}" is not a scope; one of ${SCOPES.join(", ")}, or none`;
  if (/^[A-Z]/.test(subject)) return "what changed starts lowercase (names inside it keep their capitals)";
  if (subject.endsWith(".")) return "no full stop at the end";
  if (t.length > MAX_TITLE) return `${t.length} characters; ${MAX_TITLE} at most`;
  return null;
}

// Run as a script (not imported by its test): check PR_TITLE.
if (process.argv[1]?.endsWith("check-pr-title.ts")) {
  const title = process.env.PR_TITLE ?? "";
  const problem = titleProblem(title);
  if (problem) {
    console.error(`PR title "${title}": ${problem} (docs/STYLE.md §9)`);
    process.exit(1);
  }
  console.log(`PR title "${title}": fine`);
}
