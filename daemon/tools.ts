import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

/**
 * The file tools pi-durable does not ship (plan 017, U10): `ls`, `find`, `grep` and `view_image`, beside its own
 * read, write, edit and bash. Paths are the chat's folder's, as the built-in tools' are. `grep` uses ripgrep when the
 * machine has it, which is what Letta's search used, and walks the folder itself otherwise.
 */

const run = promisify(execFile);
const LIMIT = 200;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);

async function folderOf(api: ToolExecutionApi, context: Context): Promise<string> {
  return (await api.agent(context)).cwd ?? process.cwd();
}

const at = (cwd: string, p: unknown) => (typeof p === "string" && p ? (isAbsolute(p) ? p : resolve(cwd, p)) : cwd);

/** Files under `dir`, folders like .git and node_modules left out, at most `limit`. */
function walk(dir: string, limit: number, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (out.length >= limit) break;
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, limit, out);
    else out.push(full);
  }
  return out;
}

/** A glob (`*`, `**`, `?`) as a test on a path relative to the search root. */
export function globTest(glob: string): (rel: string) => boolean {
  const source = glob
    .split("/")
    .map((part) => (part === "**" ? "(?:.*/)?" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "/"))
    .join("")
    .replace(/\/$/, "")
    .replace(/\(\?:\.\*\/\)\?$/, ".*");
  const re = new RegExp(`^${source}$`);
  return glob.includes("/") ? (rel) => re.test(rel) : (rel) => re.test(rel.split("/").pop() ?? rel);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export function fileToolsExtension(): Extension {
  return defineExtension({
    name: "loki.files",
    tools: [
      defineTool({
        name: "ls",
        description: "List a folder: its files and folders (folders end with /).",
        parameters: { type: "object", properties: { path: { type: "string", description: "Default: the chat's folder" } } } as never,
        execute: async (args, api, context) => {
          const dir = at(await folderOf(api, context), (args as { path?: string }).path);
          const names = readdirSync(dir).filter((n) => !SKIP.has(n)).sort().map((n) => (statSync(join(dir, n)).isDirectory() ? `${n}/` : n));
          return text(names.length ? names.join("\n") : "(empty)");
        },
      }),
      defineTool({
        name: "find",
        description: "Find files by a glob such as **/*.ts or README*, under a folder.",
        parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } as never,
        execute: async (args, api, context) => {
          const a = args as { pattern: string; path?: string };
          const root = at(await folderOf(api, context), a.path);
          const test = globTest(a.pattern);
          const hits = walk(root, 20_000).map((f) => relative(root, f).split(sep).join("/")).filter(test);
          return text(hits.length ? hits.slice(0, LIMIT).join("\n") + (hits.length > LIMIT ? `\n… and ${hits.length - LIMIT} more` : "") : "no files match");
        },
      }),
      defineTool({
        name: "grep",
        description: "Search file contents with a regular expression, under a folder; optionally only files matching a glob.",
        parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } as never,
        execute: async (args, api, context) => {
          const a = args as { pattern: string; path?: string; glob?: string };
          const root = at(await folderOf(api, context), a.path);
          try {
            const { stdout } = await run("rg", ["--line-number", "--no-heading", "--color=never", "--max-count=50", "--glob", "!**/node_modules/**", ...(a.glob ? ["--glob", a.glob] : []), "--", a.pattern, root], { maxBuffer: 8 * 1024 * 1024 });
            const lines = stdout.split("\n").filter(Boolean);
            return text(lines.slice(0, LIMIT).join("\n") + (lines.length > LIMIT ? `\n… and ${lines.length - LIMIT} more` : ""));
          } catch (error) {
            // ripgrep exits 1 when nothing matched; ENOENT means there is no ripgrep.
            const code = (error as { code?: unknown }).code;
            if (code === 1) return text("no matches");
            if (code !== "ENOENT") throw error;
          }
          // No ripgrep on this machine: walk the folder.
          const re = new RegExp(a.pattern);
          const test = a.glob ? globTest(a.glob) : () => true;
          const out: string[] = [];
          for (const file of walk(root, 20_000)) {
            if (out.length >= LIMIT) break;
            const rel = relative(root, file).split(sep).join("/");
            if (!test(rel)) continue;
            let body: string;
            try {
              body = readFileSync(file, "utf8");
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
      defineTool({
        name: "view_image",
        description: "Look at an image file (PNG, JPEG, GIF or WebP).",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
        execute: async (args, api, context) => {
          const file = at(await folderOf(api, context), (args as { path: string }).path);
          const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
          if (!mimeType) throw new Error("not an image this tool can show");
          if (!existsSync(file)) throw new Error(`no such file: ${file}`);
          return { content: [{ type: "image", data: readFileSync(file).toString("base64"), mimeType }] };
        },
      }),
    ],
  });
}
