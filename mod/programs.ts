import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Finding and running the programs the mod calls (letta, bd, tailscale) on every system. PATH splits on
 * the system's delimiter (`;` on Windows); Windows tries each PATHEXT name (npm's shims are `letta.cmd`),
 * and a `.cmd` or `.bat` runs through cmd.exe, which Node insists on for those since CVE-2024-27980 —
 * with every character quoted so cmd.exe reads none of them as syntax.
 */

/** The system and environment to look in; tests pass Windows' on any machine. */
export interface Look {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

/** Windows' own list when PATHEXT is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** An environment variable by name; on Windows names ignore case (`Path`, `PATH`). */
export function envVar(name: string, look: Look = {}): string | undefined {
  const env = look.env ?? process.env;
  if ((look.platform ?? process.platform) !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Every path PATH says `name` could be, in order: each folder, and on Windows each PATHEXT name within it. */
export function onPath(name: string, look: Look = {}): string[] {
  const windows = (look.platform ?? process.platform) === "win32";
  const p = windows ? win32 : posix;
  const dirs = (envVar("PATH", look) ?? "")
    .split(p.delimiter)
    .map((d) => d.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const exts = (envVar("PATHEXT", look) ?? DEFAULT_PATHEXT).split(";").filter(Boolean).map((e) => e.toLowerCase());
  const names = windows && !exts.includes(p.extname(name).toLowerCase()) ? exts.map((e) => name + e) : [name];
  return dirs.flatMap((d) => names.map((n) => p.join(d, n)));
}

/** The first of `candidates` that exists. */
export function firstExisting(candidates: Array<string | undefined>, look: Look = {}): string | null {
  const exists = look.exists ?? existsSync;
  return candidates.find((c): c is string => !!c && exists(c)) ?? null;
}

// cmd.exe's metacharacters, each escaped with ^ (the approach of cross-spawn, which npm tooling relies on).
const META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCommand(path: string): string {
  return path.replace(META, "^$1");
}

/**
 * One argument for a command line cmd.exe reads: quoted for the program's own parser (backslashes before a
 * quote doubled, the quote escaped), then every metacharacter ^-escaped. `twice` for npm's shims, which hand
 * `%*` through a second parse.
 */
export function escapeArgument(arg: string, twice: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(META, "^$1");
  return twice ? a.replace(META, "^$1") : a;
}

/** How to run `bin` with `args` here: directly, or for a Windows `.cmd`/`.bat` as one escaped line for the shell. */
export function commandFor(bin: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; shell: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, shell: false };
  return { file: [escapeCommand(bin), ...args.map((a) => escapeArgument(a, true))].join(" "), args: [], shell: true };
}

/** execFile, but a Windows `.cmd` runs through the shell (commandFor). Output as text. */
export function execProgram(bin: string, args: string[], options: ExecFileOptions, callback: (err: ExecFileException | null, stdout: string, stderr: string) => void): void {
  const c = commandFor(bin, args);
  execFile(c.file, c.args, { windowsHide: true, ...options, encoding: "utf8", ...(c.shell ? { shell: true } : {}) }, (err, stdout, stderr) => callback(err, String(stdout), String(stderr)));
}
