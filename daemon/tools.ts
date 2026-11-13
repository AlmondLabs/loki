import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { withKind } from "./tool-kinds.ts";

/**
 * The file tools pi-durable does not ship (plan 017, U10): `ls`, `find` and `grep`, for scripts only (plan 094). The
 * model does the same with `bash`, whose read-only commands ask nothing in the standard modes
 * (daemon/read-only-command.ts); a script cannot start a process, so these are how it lists, finds and searches. Paths
 * are the chat's folder's, as the built-in tools' are. `grep` uses ripgrep when the machine has it, and walks the folder
 * itself otherwise.
 */

const run = promisify(execFile);

/** The most of ripgrep's output kept; past it the search stops and answers with what it has. */
const GREP_MAX_BUFFER = 8 * 1024 * 1024;
const LIMIT = 200;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

async function folderOf(api: ToolExecutionApi, context: Context): Promise<string> {
  return (await api.agent(context)).cwd ?? process.cwd();
}

const at = (cwd: string, p: unknown) => (typeof p === "string" && p ? (isAbsolute(p) ? p : resolve(cwd, p)) : cwd);

/**
 * Files under `dir`, folders like .git and node_modules left out, at most `limit`. Asynchronous, so a walk of a big
 * folder (an agent's `find` in ~) never holds the daemon's one thread, and every chat with it, for seconds.
 */
async function walk(dir: string, limit: number, out: string[] = []): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (out.length >= limit) break;
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) await walk(full, limit, out);
    else out.push(full);
  }
  return out;
}

/** A glob (`*`, `**`, `?`) as a test on a path relative to the search root. */
export function globTest(glob: string): (rel: string) => boolean {
  const source = glob
    .split("/")
    .map((part) =>
      part === "**"
        ? "(?:.*/)?"
        : part
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]") + "/",
    )
    .join("")
    .replace(/\/$/, "")
    .replace(/\(\?:\.\*\/\)\?$/, ".*");
  const re = new RegExp(`^${source}$`);
  return glob.includes("/") ? (rel) => re.test(rel) : (rel) => re.test(rel.split("/").pop() ?? rel);
}

const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });

/** Who may call the file tools: scripts only, never the model (daemon/scripts.ts, `isScriptOnly`). */
const SCRIPTS_ONLY = ["tools"] as const;

/** The file tools above (`ls`, `find`, `grep`), as one extension every chat selects, offered to its scripts. */
export function fileToolsExtension(): Extension {
  return defineExtension({
    name: "loki.files",
    tools: [
      withKind(
        "read",
        defineTool({
          name: "ls",
          callers: SCRIPTS_ONLY,
          description: "List a folder: its files and folders (folders end with /).",
          parameters: { type: "object", properties: { path: { type: "string", description: "Default: the chat's folder" } } } as never,
          execute: async (args, api, context) => {
            const dir = at(await folderOf(api, context), (args as { path?: string }).path);
            const kept = (await readdir(dir)).filter((n) => !SKIP.has(n)).sort();
            const names = await Promise.all(kept.map(async (n) => ((await stat(join(dir, n)).catch(() => null))?.isDirectory() ? `${n}/` : n)));
            return text(names.length ? names.join("\n") : "(empty)");
          },
        }),
      ),
      withKind(
        "read",
        defineTool({
          name: "find",
          callers: SCRIPTS_ONLY,
          description: "Find files by a glob such as **/*.ts or README*, under a folder.",
          parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } as never,
          execute: async (args, api, context) => {
            const a = args as { pattern: string; path?: string };
            const root = at(await folderOf(api, context), a.path);
            const test = globTest(a.pattern);
            const hits = (await walk(root, 20_000)).map((f) => relative(root, f).split(sep).join("/")).filter(test);
            return text(hits.length ? hits.slice(0, LIMIT).join("\n") + (hits.length > LIMIT ? `\n… and ${hits.length - LIMIT} more` : "") : "no files match");
          },
        }),
      ),
      withKind(
        "read",
        defineTool({
          name: "grep",
          callers: SCRIPTS_ONLY,
          description: "Search file contents with a regular expression, under a folder; optionally only files matching a glob.",
          parameters: {
            type: "object",
            properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } },
            required: ["pattern"],
          } as never,
          execute: async (args, api, context) => {
            const a = args as { pattern: string; path?: string; glob?: string };
            const root = at(await folderOf(api, context), a.path);
            /** The matches as the tool answers them, with a note when ripgrep could not search all of it. */
            const answer = (stdout: string, note: string | null) => {
              const lines = stdout.split("\n").filter(Boolean);
              const shown = lines.slice(0, LIMIT).join("\n") + (lines.length > LIMIT ? `\n… and ${lines.length - LIMIT} more` : "");
              return text([shown || "no matches", note].filter(Boolean).join("\n"));
            };
            try {
              const { stdout } = await run(
                "rg",
                [
                  "--line-number",
                  "--no-heading",
                  "--color=never",
                  "--max-count=50",
                  "--glob",
                  "!**/node_modules/**",
                  ...(a.glob ? ["--glob", a.glob] : []),
                  "--",
                  a.pattern,
                  root,
                ],
                // Stop ends ripgrep too, not only the turn waiting on it.
                { maxBuffer: GREP_MAX_BUFFER, signal: context.abortSignal },
              );
              return answer(stdout, null);
            } catch (error) {
              const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
              const found = typeof e.stdout === "string" ? e.stdout : "";
              const why = typeof e.stderr === "string" ? e.stderr.trim() : "";
              // ripgrep exits 1 when nothing matched; ENOENT means there is no ripgrep.
              if (e.code === 1) return text("no matches");
              // 2 is an error somewhere, often one folder it may not read (macOS keeps Desktop, Mail and the like
              // from a process without access): what it found elsewhere is still the answer. A bad pattern finds
              // nothing and says why.
              if (e.code === 2 && (found || !/regex parse error|error parsing/i.test(why)))
                return answer(found, `(some of it could not be searched: ${why.split("\n")[0] || "ripgrep reported an error"})`);
              // Past the buffer: the matches so far are plenty, as the model reads at most LIMIT of them.
              if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
                return answer(found, "(stopped early: the output was too large; narrow the pattern or the folder)");
              if (e.code !== "ENOENT") throw error;
            }
            // No ripgrep on this machine: walk the folder.
            const re = new RegExp(a.pattern);
            const test = a.glob ? globTest(a.glob) : () => true;
            const out: string[] = [];
            for (const file of await walk(root, 20_000)) {
              if (out.length >= LIMIT) break;
              const rel = relative(root, file).split(sep).join("/");
              if (!test(rel)) continue;
              let body: string;
              try {
                body = await readFile(file, "utf8");
              } catch {
                continue;
              }
              body.split("\n").forEach((line, i) => {
                if (out.length < LIMIT && re.test(line)) out.push(`${file}:${i + 1}:${line}`);
              });
            }
            return text(out.length ? out.join("\n") : "no matches");
          },
        }),
      ),
    ],
  });
}
