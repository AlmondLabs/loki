import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NEVER_RUNS_ON_MAC = /^(app\/|site\/|docs\/|LICENSE$|\.github\/ISSUE_TEMPLATE\/|[^/]+\.md$)/;
const VITEST_FILE = /^test\/[^/]+\.test\.tsx?$/;
const REACHES_MAC = /from\s+["'](\.\.\/)+(daemon|mod|scripts|native|test-node)\/|node:child_process|tmpdir\(|mkdtemp|fs\.watch|\bwatch\(/;

export function needsMac(paths: readonly string[], textUnlessDeleted: (path: string) => string | undefined): boolean {
  return paths.some((path) => {
    if (NEVER_RUNS_ON_MAC.test(path)) return false;
    if (!VITEST_FILE.test(path)) return true;
    const text = textUnlessDeleted(path);
    return text !== undefined && REACHES_MAC.test(text);
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const base = process.argv[2] ?? "HEAD^1";
  const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const needed = needsMac(paths, (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined));
  console.log(`needed=${String(needed)}`);
}
