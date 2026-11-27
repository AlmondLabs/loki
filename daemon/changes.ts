import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { messageOf } from "../core/errors.ts";
import { isRecord, withKind } from "./tool-kinds.ts";

export const CHANGES_TOOL = "changes_read";

export interface GitExecOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  maxBuffer: number;
  encoding: "utf8";
  signal?: AbortSignal;
}

export type GitExec = (file: string, args: readonly string[], options: GitExecOptions) => Promise<{ stdout: string; stderr: string }>;

export interface GitDeps {
  exec?: GitExec;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

const run = promisify(execFile);
const nodeExec: GitExec = (file, args, options) => run(file, [...args], options);

const MAX_BUFFER = 64 * 1024 * 1024;
const SPILL_BYTES = 50 * 1024;
const SPILL_LINES = 2000;
const LIST_MAX = 200;

// Outside (git): Git for Windows cannot open Node's `\\.\nul` as a config file but reads "/dev/null" as its null device,
// and a path it cannot find counts as no config and no hooks, so this one spelling works everywhere.
const NO_FILE = "/dev/null";

const GLOBAL_FLAGS = ["--no-pager", "--no-optional-locks"];

const SWITCHES: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", NO_FILE],
  ["core.pager", ""],
  ["diff.external", ""],
  ["log.showSignature", "false"],
  ["format.pretty", "medium"],
  ["gpg.program", ""],
  ["gpg.openpgp.program", ""],
  ["gpg.x509.program", ""],
  ["gpg.ssh.program", ""],
  ["protocol.allow", "never"],
  ["status.submoduleSummary", "false"],
];

type Subcommand = "config" | "rev-parse" | "status" | "diff" | "log" | "show";

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];

const SUBCOMMAND_FLAGS: Readonly<Record<Subcommand, readonly string[]>> = {
  config: [],
  "rev-parse": [],
  status: ["--ignore-submodules=all"],
  diff: DIFF_FLAGS,
  log: [...DIFF_FLAGS, "--no-show-signature"],
  show: [...DIFF_FLAGS, "--no-show-signature"],
};

const keysOf = (listing: string) => new Set(listing.split("\0").map((entry) => entry.split("\n", 1)[0] ?? ""));

function filterDrivers(listing: string): Set<string> {
  const names = new Set<string>();
  for (const key of keysOf(listing)) {
    const found = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (found?.[1]) names.add(found[1]);
  }
  return names;
}

function gitEnv(base: Readonly<Record<string, string | undefined>>, drivers: ReadonlySet<string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) if (!/^git_/i.test(key)) env[key] = value;
  const pairs: Array<readonly [string, string]> = [...SWITCHES];
  for (const name of drivers)
    pairs.push([`filter.${name}.clean`, ""], [`filter.${name}.smudge`, ""], [`filter.${name}.process`, ""], [`filter.${name}.required`, "false"]);
  // Outside (git): `-c` splits its argument at the first "=", which a filter's name may hold, so every pair goes in the environment.
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return {
    ...env,
    GIT_CONFIG_COUNT: String(pairs.length),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NO_FILE,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

type Git = (subcommand: Subcommand, rest: readonly string[]) => Promise<string>;

async function gitIn(folder: string, deps: GitDeps): Promise<Git> {
  const exec = deps.exec ?? nodeExec;
  const base = deps.env ?? process.env;
  const call = async (env: Record<string, string | undefined>, subcommand: Subcommand, rest: readonly string[]) =>
    (
      await exec("git", [...GLOBAL_FLAGS, subcommand, ...SUBCOMMAND_FLAGS[subcommand], ...rest], {
        cwd: folder,
        env,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    ).stdout;
  const listing = await call(gitEnv(base, new Set()), "config", ["--null", "--list", "--includes"]);
  if (keysOf(listing).has("core.worktree")) throw new Error(MOVED_WORK_TREE);
  const env = gitEnv(base, filterDrivers(listing));
  const git: Git = (subcommand, rest) => call(env, subcommand, rest);
  if (!(await holds((await git("rev-parse", ["--show-toplevel"])).trim(), folder))) throw new Error(MOVED_WORK_TREE);
  return git;
}

const MOVED_WORK_TREE = "changes_read refused: this folder's git config moves its work tree (core.worktree), which can lead outside the folder.";

const realOf = (path: string) => realpath(path).catch(() => resolve(path));

async function holds(top: string, folder: string): Promise<boolean> {
  const rel = relative(await realOf(top), await realOf(folder));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const KINDS = ["status", "diff", "log", "show"] as const;
type ChangesKind = (typeof KINDS)[number];

interface KindRules {
  options: readonly RegExp[];
  named: string;
  revisions: number;
}

const RULES: Readonly<Record<ChangesKind, KindRules>> = {
  status: {
    options: [/^--(short|branch)$/, /^--untracked-files=(no|normal|all)$/],
    named: "--short, --branch and --untracked-files=<no|normal|all>",
    revisions: 0,
  },
  diff: {
    options: [/^--(staged|cached|stat|numstat|shortstat|name-only|name-status)$/, /^-U\d{1,3}$/, /^--unified=\d{1,3}$/],
    named: "--staged, --cached, --stat, --numstat, --shortstat, --name-only, --name-status and -U<n>",
    revisions: 2,
  },
  log: {
    options: [
      /^--(oneline|stat|numstat|shortstat|name-only|name-status|patch|first-parent|no-merges)$/,
      /^-p$/,
      /^-n\d{1,4}$/,
      /^--max-count=\d{1,4}$/,
      /^-U\d{1,3}$/,
    ],
    named: "--oneline, --stat, --numstat, --shortstat, --name-only, --name-status, --patch, --first-parent, --no-merges, -n<n> and -U<n>",
    revisions: 1,
  },
  show: {
    options: [/^--(oneline|stat|numstat|shortstat|name-only|name-status|no-patch)$/, /^-U\d{1,3}$/],
    named: "--oneline, --stat, --numstat, --shortstat, --name-only, --name-status, --no-patch and -U<n>",
    revisions: 1,
  },
};

const REVISION = /^[A-Za-z0-9@][A-Za-z0-9._/@{}^~-]{0,199}$/;

const isKind = (v: unknown): v is ChangesKind => KINDS.some((k) => k === v);

function strings(value: unknown, what: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) return `${what} must be a list of strings`;
  return value;
}

function changesArgv(args: unknown): { subcommand: ChangesKind; rest: string[] } | { refused: string } {
  const given = isRecord(args) ? args : {};
  const kind = given.kind;
  if (!isKind(kind)) return { refused: "kind is one of status, diff, log or show" };
  const rules = RULES[kind];
  const options = strings(given.options, "options");
  const revisions = strings(given.revisions, "revisions");
  const paths = strings(given.paths, "paths");
  if (typeof options === "string") return { refused: options };
  if (typeof revisions === "string") return { refused: revisions };
  if (typeof paths === "string") return { refused: paths };
  const unknown = options.find((o) => !rules.options.some((r) => r.test(o)));
  if (unknown !== undefined) return { refused: `"${unknown}" is not an option changes_read takes for ${kind}; it takes ${rules.named}` };
  if (rules.revisions === 0 && revisions.length) return { refused: `${kind} takes no revisions` };
  if (revisions.length > rules.revisions) return { refused: `${kind} takes at most ${rules.revisions} revision${rules.revisions === 1 ? "" : "s"}` };
  const badRevision = revisions.find((r) => !REVISION.test(r));
  if (badRevision !== undefined) return { refused: `"${badRevision}" is not a revision: a branch, tag, commit or range such as main..HEAD` };
  const badPath = paths.find((p) => !p || p.includes("\0"));
  if (badPath !== undefined) return { refused: "a path must be a non-empty name" };
  return { subcommand: kind, rest: [...options, ...revisions, "--", ...paths] };
}

function failureText(error: unknown): string {
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr.trim()) return error.stderr.trim();
  return messageOf(error);
}

export async function readChanges(folder: string, args: unknown, deps: GitDeps = {}): Promise<{ text: string; failed: boolean }> {
  const argv = changesArgv(args);
  if ("refused" in argv) return { text: `changes_read refused: ${argv.refused}.`, failed: true };
  try {
    const git = await gitIn(folder, deps);
    const out = await git(argv.subcommand, argv.rest);
    return { text: out || "git printed nothing.", failed: false };
  } catch (error) {
    return { text: failureText(error), failed: true };
  }
}

export async function fullOutputFile(env: ExecutionEnv, text: string, context: Context): Promise<string | null> {
  if (Buffer.byteLength(text, "utf8") <= SPILL_BYTES && text.split("\n").length <= SPILL_LINES) return null;
  const file = await env.createTempFile({ prefix: "changes-", suffix: ".txt" }, context);
  if (!file.ok) return null;
  const written = await env.writeFile(file.value, text, context);
  return written.ok ? file.value : null;
}

export interface ChangedFile {
  path: string;
  added: number | null;
  deleted: number | null;
}

export interface Commit {
  hash: string;
  subject: string;
}

export type ChangeList =
  | { kind: "no_folder" }
  | { kind: "not_a_checkout" }
  | { kind: "uncommitted"; files: ChangedFile[]; more: number }
  | { kind: "unpushed"; upstream: string; commits: Commit[]; files: ChangedFile[]; more: number }
  | { kind: "nothing_changed" };

function statusPaths(porcelain: string): string[] {
  const parts = porcelain.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/^[RC]/.test(entry)) i++;
  }
  return paths;
}

function numstat(out: string): Map<string, { added: number | null; deleted: number | null }> {
  const parts = out.split("\0");
  const stats = new Map<string, { added: number | null; deleted: number | null }>();
  for (let i = 0; i < parts.length; i++) {
    const found = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i] ?? "");
    if (!found) continue;
    let path = found[3];
    if (!path) {
      path = parts[i + 2] ?? "";
      i += 2;
    }
    const count = (n: string | undefined) => (n === undefined || n === "-" ? null : Number(n));
    stats.set(path, { added: count(found[1]), deleted: count(found[2]) });
  }
  return stats;
}

function filesWithStats(paths: readonly string[], ...stats: Array<Map<string, { added: number | null; deleted: number | null }>>): ChangedFile[] {
  return paths.map((path) => {
    const found = stats.map((s) => s.get(path)).filter((s) => s !== undefined);
    const sum = (key: "added" | "deleted") =>
      found.length && found.every((s) => s[key] !== null) ? found.reduce((total, s) => total + (s[key] ?? 0), 0) : null;
    return { path, added: sum("added"), deleted: sum("deleted") };
  });
}

const capped = (files: ChangedFile[]) => ({ files: files.slice(0, LIST_MAX), more: Math.max(0, files.length - LIST_MAX) });

export async function changeList(folder: string | undefined, deps: GitDeps = {}): Promise<ChangeList> {
  if (!folder) return { kind: "no_folder" };
  let git: Git;
  try {
    git = await gitIn(folder, deps);
    if ((await git("rev-parse", ["--is-inside-work-tree"])).trim() !== "true") return { kind: "not_a_checkout" };
  } catch {
    return { kind: "not_a_checkout" };
  }
  const changed = statusPaths(await git("status", ["--porcelain=v1", "-z", "--untracked-files=all"]));
  if (changed.length) {
    const [unstaged, staged] = await Promise.all([git("diff", ["--numstat", "-z"]), git("diff", ["--numstat", "-z", "--cached"])]);
    return { kind: "uncommitted", ...capped(filesWithStats(changed, numstat(unstaged), numstat(staged))) };
  }
  let upstream: string;
  try {
    upstream = (await git("rev-parse", ["--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
  } catch {
    return { kind: "nothing_changed" };
  }
  const commits = (await git("log", ["--format=%h%x1f%s", "@{upstream}..HEAD"]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", subject = ""] = line.split("\u001f");
      return { hash, subject };
    });
  if (!commits.length) return { kind: "nothing_changed" };
  const stats = numstat(await git("diff", ["--numstat", "-z", "@{upstream}...HEAD"]));
  return { kind: "unpushed", upstream, commits, ...capped(filesWithStats([...stats.keys()], stats)) };
}

/**
 * The `changes_read` tool, offered only to a chat whose tool list adds it (a read-only subagent). Arguments:
 * - `kind`: `status`, `diff`, `log` or `show`.
 * - `options`: flags from that kind's fixed list; anything else is refused.
 * - `revisions`: branches, tags, commits or ranges, never starting with `-` (diff at most 2, log and show at most 1, status none).
 * - `paths`: passed after `--`, so they are only ever paths.
 */
export function changesExtension(deps: Omit<GitDeps, "signal"> = {}): Extension {
  return defineExtension({
    name: "loki.changes",
    tools: [
      withKind(
        "read",
        defineTool({
          name: CHANGES_TOOL,
          deferred: true,
          callers: ["model"],
          description:
            "Read the chat folder's git changes: its status, a diff (unstaged, --staged, or between revisions), a log, or one commit. git runs with every program the folder's git config names switched off. Each kind takes only the options its list names; paths go after the revisions.",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...KINDS], description: "status, diff, log or show" },
              options: {
                type: "array",
                items: { type: "string" },
                description: `status: ${RULES.status.named}. diff: ${RULES.diff.named}. log: ${RULES.log.named}. show: ${RULES.show.named}.`,
              },
              revisions: {
                type: "array",
                items: { type: "string" },
                description: "Branches, tags, commits or ranges (main..HEAD). diff takes up to 2, log and show 1, status none.",
              },
              paths: { type: "array", items: { type: "string" }, description: "Limit to these files or folders" },
            },
            required: ["kind"],
          } as never,
          execute: async (args, api, context) => {
            const { cwd } = await api.agent(context);
            if (!cwd) return { output: [{ type: "text", text: "This chat has no folder, so it has no git changes to read." }], isError: true };
            const result = await readChanges(cwd, args, { ...deps, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
            const saved = !result.failed && api.env ? await fullOutputFile(api.env, result.text, context) : null;
            if (saved) api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${saved}` });
            return { output: [{ type: "text", text: result.text }], ...(result.failed ? { isError: true } : {}) };
          },
        }),
      ),
    ],
  });
}
