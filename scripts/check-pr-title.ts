export const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"] as const;

export const SCOPES = [
  "chat",
  "history",
  "acp",
  "mcp",
  "memory",
  "learn",
  "phone",
  "desk",
  "inbox",
  "agents",
  "settings",
  "peers",
  "motion",
  "daemon",
  "mod",
  "core",
  "app",
  "shell",
  "release",
  "deps",
  "style",
] as const;

export const MAX_TITLE = 72;

const SHAPE = /^(?<type>[a-z]+)(?:\((?<scope>[a-z-]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

export function titleProblem(title: string): string | null {
  const t = title.trim();
  // GitHub's own revert button titles the PR `Revert "<the original title>"`.
  if (/^Revert ".+"$/.test(t)) return null;
  const m = SHAPE.exec(t);
  if (!m?.groups) return 'the shape is "type(scope): what changed", e.g. "feat(chat): suggest work for another chat"';
  const { type, scope, subject } = m.groups;
  if (!(TYPES as readonly string[]).includes(type)) return `"${type}" is not a type; one of ${TYPES.join(", ")}`;
  if (scope && !(SCOPES as readonly string[]).includes(scope)) return `"${scope}" is not a scope; one of ${SCOPES.join(", ")}, or none`;
  if (/^[A-Z]/.test(subject)) return "what changed starts lowercase (names inside it keep their capitals)";
  if (subject.endsWith(".")) return "no full stop at the end";
  if (t.length > MAX_TITLE) return `${t.length} characters; ${MAX_TITLE} at most`;
  return null;
}

if (process.argv[1]?.endsWith("check-pr-title.ts")) {
  const title = process.env.PR_TITLE ?? "";
  const problem = titleProblem(title);
  if (problem) {
    console.error(`PR title "${title}": ${problem} (docs/style.md §9)`);
    process.exit(1);
  }
  console.log(`PR title "${title}": fine`);
}
