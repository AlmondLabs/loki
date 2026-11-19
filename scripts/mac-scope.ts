import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// What a Mac adds over Linux and Windows is how the daemon, the mod and their scripts meet macOS: file watching, its
// temporary folders, processes, the keychain. The React app and the site never run there in CI, and nothing under
// daemon/, mod/, core/ or test-node/ imports them, so a PR that changes only these cannot turn the Mac job red.
const NO_MAC = /^(app\/|site\/|docs\/|LICENSE$|\.github\/ISSUE_TEMPLATE\/|[^/]+\.md$)/;
// A test of the app runs the same on every system: core/ has no file system, processes or platform in it, and reading
// the repository's own files is alike everywhere. One that reaches the daemon's side, starts a process or works in a
// temporary folder meets what differs on macOS.
const TEST = /^test\/[^/]+\.test\.tsx?$/;
const REACHES_MAC = /from\s+["'](\.\.\/)+(daemon|mod|scripts|native|test-node)\/|node:child_process|tmpdir\(|mkdtemp|fs\.watch|\bwatch\(/;

/**
 * Whether a PR's changed files need the Mac job: true unless every one is the app, the site, a doc, or a test of the
 * app alone. `source` gives a test's text, or undefined when the PR deleted it.
 */
export function needsMac(paths: readonly string[], source: (path: string) => string | undefined): boolean {
  return paths.some((path) => {
    if (NO_MAC.test(path)) return false;
    if (!TEST.test(path)) return true;
    const text = source(path);
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
