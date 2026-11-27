import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { withKind, type KindedTool } from "./tool-kinds.ts";

const run = promisify(execFile);

const GREP_MAX_BUFFER = 8 * 1024 * 1024;
const RIPGREP_NOTHING_MATCHED = 1;
const RIPGREP_ERROR = 2;
const LIMIT = 200;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

async function folderOf(api: ToolExecutionApi, context: Context): Promise<string> {
  return (await api.agent(context)).cwd ?? process.cwd();
}

const at = (cwd: string, p: unknown) => (typeof p === "string" && p ? (isAbsolute(p) ? p : resolve(cwd, p)) : cwd);

async function walk(dir: string, limit: number, followLinks: boolean, maxDepth = Infinity, depth = 1, out: string[] = []): Promise<string[]> {
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
      st = await (followLinks ? stat : lstat)(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (depth >= maxDepth) out.push(`${full}/`);
      else await walk(full, limit, followLinks, maxDepth, depth + 1, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

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
  return glob.includes("/")
    ? (rel) => re.test(rel.replace(/\/$/, ""))
    : (rel) => {
        const clean = rel.replace(/\/$/, "");
        return re.test(clean.split("/").pop() ?? clean);
      };
}

const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });

export function fileToolsExtension(): Extension {
  return defineExtension({ name: "loki.files", tools: fileTools({ followLinks: true }) });
}

export function fileTools({ callers, followLinks }: { callers?: ReadonlyArray<"model" | "tools">; followLinks: boolean }): KindedTool[] {
  const who = callers ? { callers } : {};
  return [
    withKind(
      "read",
      defineTool({
        name: "find",
        ...who,
        description: "Find files by an optional glob (default *) such as **/*.ts or README*, under a folder; pass max_depth: 1 to list direct children.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern such as **/*.ts (default: *)" },
            path: { type: "string", description: "Default: the chat's folder" },
            max_depth: { type: "integer", description: "Maximum folder depth (1 lists only direct children)." },
          },
        } as never,
        execute: async (args, api, context) => {
          const a = args as { pattern?: string; path?: string; max_depth?: number };
          const root = at(await folderOf(api, context), a.path);
          const pattern = typeof a.pattern === "string" && a.pattern.trim() ? a.pattern : "*";
          const maxDepth = typeof a.max_depth === "number" && Number.isInteger(a.max_depth) && a.max_depth >= 1 ? a.max_depth : Infinity;
          const test = globTest(pattern);
          const hits = (await walk(root, 20_000, followLinks, maxDepth))
            .map((f) => {
              const rel = relative(root, f).split(sep).join("/");
              return f.endsWith("/") && rel ? `${rel}/` : rel;
            })
            .filter(test);
          return text(hits.length ? hits.slice(0, LIMIT).join("\n") + (hits.length > LIMIT ? `\n… and ${hits.length - LIMIT} more` : "") : "no files match");
        },
      }),
    ),
    withKind(
      "read",
      defineTool({
        name: "grep",
        ...who,
        description: "Search file contents with a regular expression, under a folder; optionally only files matching a glob.",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } },
          required: ["pattern"],
        } as never,
        execute: async (args, api, context) => {
          const a = args as { pattern: string; path?: string; glob?: string };
          const root = at(await folderOf(api, context), a.path);
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
              { maxBuffer: GREP_MAX_BUFFER, signal: context.abortSignal },
            );
            return answer(stdout, null);
          } catch (error) {
            const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
            const found = typeof e.stdout === "string" ? e.stdout : "";
            const why = typeof e.stderr === "string" ? e.stderr.trim() : "";
            if (e.code === RIPGREP_NOTHING_MATCHED) return text("no matches");
            // Outside (macOS): it keeps Desktop, Mail and the like from a process without access, so ripgrep's error is
            // often one folder it may not read, and what it found elsewhere is still the answer.
            if (e.code === RIPGREP_ERROR && (found || !/regex parse error|error parsing/i.test(why)))
              return answer(found, `(some of it could not be searched: ${why.split("\n")[0] || "ripgrep reported an error"})`);
            if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
              return answer(found, "(stopped early: the output was too large; narrow the pattern or the folder)");
            if (e.code !== "ENOENT") throw error;
          }
          const re = new RegExp(a.pattern);
          const test = a.glob ? globTest(a.glob) : () => true;
          const out: string[] = [];
          for (const file of await walk(root, 20_000, followLinks)) {
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
  ];
}
