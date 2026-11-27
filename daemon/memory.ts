import type { Context } from "@earendil-works/chord/context";
import { defineExtension, section, type ConversationId, type DocumentReader, type Extension } from "@earendil-works/pi-durable";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { piTool, type ChatTool } from "./chat-tools.ts";
import { isBinaryFile, searchMemory } from "./memory-search.ts";
import { serial } from "./repo-queue.ts";
import { sections } from "./section-cache.ts";
import { briefDescription, skillDescription } from "../mod/skills.ts";

const run = promisify(execFile);

const FILE_LIMIT = 64 * 1024;
const READ_LIMIT = 40 * 1024;
const LISTED = 200;

export const MEMORY_TOOLS = ["memory_read", "memory_search", "memory_write", "memory_edit"];
export const SHARED_PREFIX = "shared/";
export const SHARED_BUDGET = 6 * 1024;

export const isReflectionChat = (chatId: string): boolean => chatId.startsWith("reflection-");
export const isDoctorChat = (chatId: string): boolean => chatId.startsWith("doctor-");
export const ACP_PASS_SUFFIX = "-acp";

export function memoryRoot(backendDir: string, agentId: string): string {
  return join(backendDir, "memfs", agentId, "memory");
}

export function sharedMemoryRoot(backendDir: string): string {
  return join(backendDir, "shared-memory");
}

function files(root: string, dir = root, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) files(root, full, out);
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

function coreOf(all: string[]): string[] {
  return all.some((f) => f.startsWith("system/"))
    ? all.filter((f) => f.startsWith("system/") && f.endsWith(".md"))
    : all.filter((f) => !f.includes("/") && f.endsWith(".md"));
}

export const CORE_BUDGET = 12 * 1024;

export function coreSize(root: string): { bytes: number; files: Array<{ path: string; bytes: number }> } | undefined {
  if (!existsSync(root)) return undefined;
  const sized = coreOf(files(root))
    .map((path) => ({ path, bytes: statSync(join(root, path)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  return { bytes: sized.reduce((n, f) => n + f.bytes, 0), files: sized };
}

export function sharedSize(sharedRoot: string): { bytes: number; files: Array<{ path: string; bytes: number }> } | undefined {
  if (!existsSync(sharedRoot)) return undefined;
  const sized = files(sharedRoot)
    .filter((f) => f.endsWith(".md") && !isBinaryFile(join(sharedRoot, f)))
    .map((f) => ({ path: `${SHARED_PREFIX}${f}`, bytes: statSync(join(sharedRoot, f)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  if (!sized.length) return undefined;
  return { bytes: sized.reduce((n, f) => n + f.bytes, 0), files: sized };
}

export const FAILURE_RULE = `A failed tool call ([failed …] in a conversation, with [then … worked] when the next try did) is worth a note when the same mistake comes back in more than one conversation, or when it shows a fact about this Mac and its tools that will still be true tomorrow: a command that does not exist and what to use instead, where a file lives, the right flag of a command. Write the lesson as what to do (use python3; that folder is at …), in a note outside system/ whose description says when it applies. A failure memory cannot prevent is no lesson: a provider's error, a slow service, a test that failed because the code was wrong; an expired sign-in is a lesson only as "ask the person to renew it, do not retry". Keep such a lesson until memory shows it is no longer true.`;

export const CORE_RULE = `Your core notes (system/) are in every conversation in full, so keep them to who you are, agent-specific boundaries, and rules that hold for any task of this agent. Cross-agent preferences about how the person communicates, decides, approves work, or formats answers belong in shared/ (for example shared/preferences.md), which every agent reads in full; keep private personal, health, finance, or project-specific facts out of shared/. Write preferences as short, scannable "when X -> do Y" bullet rules rather than dense prose paragraphs. Every note outside system/ and shared/ starts with front matter whose description says in one line when the note is worth reading (---, description: …, ---): every conversation already sees that path and description list, so write it as when to read, not as a title, add one when missing, and never keep stub files inside system/ just to point to those notes.`;

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function overBudget(root: string, sharedRoot?: string): string | null {
  const notes: string[] = [];
  const size = coreSize(root);
  if (size && size.bytes > CORE_BUDGET) {
    const biggest = size.files.slice(0, 5).map((f) => `- ${f.path} (${kb(f.bytes)})`);
    notes.push(
      `Also: your core notes (system/) come to ${kb(size.bytes)}, over their budget of ${kb(CORE_BUDGET)}. Move what is not needed in every conversation into notes outside system/, each with a description, and delete redundant routing stubs in system/ (notes outside system/ are already listed in every chat). Never drop durable user preferences to make room for project pointers. The biggest:\n${biggest.join("\n")}`,
    );
  }
  const shared = sharedRoot ? sharedSize(sharedRoot) : undefined;
  if (shared && shared.bytes > SHARED_BUDGET) {
    const biggest = shared.files.slice(0, 5).map((f) => `- ${f.path} (${kb(f.bytes)})`);
    notes.push(
      `Also: your shared notes (shared/) come to ${kb(shared.bytes)}, over their budget of ${kb(SHARED_BUDGET)}. Keep only durable cross-agent user preferences there, as short scannable rules. The biggest:\n${biggest.join("\n")}`,
    );
  }
  return notes.length ? notes.join("\n\n") : null;
}

const HEAD_BYTES = 8192;
const descriptionCache = new Map<string, { mtimeMs: number; size: number; description: string | null }>();

function readHead(file: string, size: number): string {
  if (size <= HEAD_BYTES) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function descriptionOf(file: string): string | null {
  try {
    const st = statSync(file);
    const cached = descriptionCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.description;
    const description = skillDescription(readHead(file, st.size));
    if (descriptionCache.size >= 1000) descriptionCache.clear();
    descriptionCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, description });
    return description;
  } catch {
    return null;
  }
}

function listed(root: string, path: string, shown: string): string {
  const description = path.endsWith(".md") ? descriptionOf(join(root, path)) : null;
  return `- ${shown}${description ? ` — ${briefDescription(description)}` : ""}`;
}

const MEMORY_INTRO = {
  tools: "This is your memory, kept as files you can change with the memory tools.",
  read: "This is your memory. You are advising here, so read it with memory_read but never change it: what you see while advising stays out of memory.",
  files: "This is your memory, kept as files by loki, which updates them from your conversations; read them, but do not edit them.",
};

export function memorySection(root: string, how: keyof typeof MEMORY_INTRO = "tools", sharedRoot?: string): string | undefined {
  const parts: string[] = [];
  if (sharedRoot && existsSync(sharedRoot)) {
    const sharedFiles = files(sharedRoot).filter((f) => f.endsWith(".md") && !isBinaryFile(join(sharedRoot, f)));
    for (const f of sharedFiles) {
      parts.push(`<file path="${SHARED_PREFIX}${f}">\n${readFileSync(join(sharedRoot, f), "utf8").slice(0, FILE_LIMIT).trimEnd()}\n</file>`);
    }
  }
  if (existsSync(root)) {
    const all = files(root);
    const core = coreOf(all);
    const coreSet = new Set(core);
    for (const f of core) {
      parts.push(`<file path="${f}">\n${readFileSync(join(root, f), "utf8").slice(0, FILE_LIMIT).trimEnd()}\n</file>`);
    }
    const rest = all.filter((f) => !coreSet.has(f) && !f.startsWith("skills/") && !isBinaryFile(join(root, f)));
    if (rest.length)
      parts.push(
        `Other memory files (${how === "files" ? "read one at its path" : "read one with memory_read"} when its description fits what you are doing):\n${rest
          .slice(0, LISTED)
          .map((f) => listed(root, f, how === "files" ? join(root, f) : f))
          .join("\n")}${rest.length > LISTED ? `\n- … and ${rest.length - LISTED} more` : ""}`,
      );
  }
  return parts.length ? `${MEMORY_INTRO[how]}\n\n${parts.join("\n\n")}` : undefined;
}

/**
 * Files that steer git itself rather than hold memory: `.git` anywhere (the Mac's disk ignores case, so
 * `.GIT/config` is the repo's config), and `.gitattributes` / `.gitmodules`, which can name filters and
 * submodules git would run on the next add.
 */
const gitOwned = (segment: string): boolean => [".git", ".gitattributes", ".gitmodules"].includes(segment.toLowerCase());

function inside(root: string, path: unknown): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("path required");
  const full = resolve(root, path);
  const rel = relative(root, full);
  // Outside (Windows): a path on another drive is relative to nothing: `relative` gives it back absolute, with no "..".
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).some(gitOwned)) throw new Error(`${path} is not a memory file`);
  return full;
}

interface MemoryTarget {
  root: string;
  full: string;
  displayPath: string;
  shared: boolean;
}

function resolveMemoryTarget(backendDir: string, agentId: string, rawPath: unknown): MemoryTarget {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("path required");
  const stripped = rawPath.trim().replace(/^[/\\]+/, "");
  if (stripped === "shared" || stripped === "shared/" || stripped === "shared\\") {
    throw new Error(`${rawPath} is not a memory file`);
  }
  if (stripped.startsWith("shared/") || stripped.startsWith("shared\\")) {
    const inner = stripped.slice(SHARED_PREFIX.length);
    const root = sharedMemoryRoot(backendDir);
    const full = inside(root, inner);
    const rel = relative(root, full).split(sep).join("/");
    return { root, full, displayPath: `${SHARED_PREFIX}${rel}`, shared: true };
  }
  const root = memoryRoot(backendDir, agentId);
  const full = inside(root, rawPath);
  const rel = relative(root, full).split(sep).join("/");
  return { root, full, displayPath: rel, shared: false };
}

/**
 * git in a memory repo, with no hooks (whatever is in the repo, a commit runs nothing of it) and no line-ending
 * conversion: Windows' git turns LF into CRLF on checkout by default, and a revert checks files out, so a reverted
 * file came back with CRLF and the agent's memory_edit of an LF passage no longer matched it. Git's tidying after a
 * commit runs inside the call (`autoDetach=false`), so no process of git's outlives it in the repo.
 */
const git = (root: string, ...args: string[]) =>
  run("git", [
    "-C",
    root,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.autocrlf=false",
    "-c",
    "maintenance.autoDetach=false",
    "-c",
    "gc.autoDetach=false",
    ...args,
  ]);

export { serial } from "./repo-queue.ts";

async function ensureGitRepo(root: string): Promise<void> {
  if (existsSync(join(root, ".git"))) return;
  mkdirSync(root, { recursive: true });
  await git(root, "init", "--quiet");
}

function hasStagedChanges(root: string, paths: readonly string[]): Promise<boolean> {
  return git(root, "diff", "--cached", "--quiet", "--", ...paths).then(
    () => false,
    () => true,
  );
}

function commit(root: string, path: string, message: string, author: { name: string; email: string }): Promise<void> {
  return commitMemoryFiles(root, [path], message, author);
}

export function commitMemoryFiles(root: string, paths: readonly string[], message: string, author: { name: string; email: string }): Promise<void> {
  return serial(root, async () => {
    await ensureGitRepo(root);
    await git(root, "add", "--", ...paths);
    if (!(await hasStagedChanges(root, paths))) return;
    await git(root, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "-m", message, "--", ...paths);
  });
}

function removeMemoryFile(root: string, full: string, message: string, author: { name: string; email: string }): Promise<void> {
  return serial(root, async () => {
    await ensureGitRepo(root);
    await git(root, "rm", "--quiet", "--", full);
    await git(root, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "-m", message, "--", full);
  });
}

export function memoryDump(root: string, limit = 80_000, sharedRoot?: string): { text: string; files: number; chars: number } {
  const entries: Array<{ displayPath: string; fullPath: string; priority: number }> = [];
  if (sharedRoot && existsSync(sharedRoot)) {
    for (const f of files(sharedRoot)) {
      const fullPath = join(sharedRoot, f);
      if (isBinaryFile(fullPath)) continue;
      entries.push({ displayPath: `${SHARED_PREFIX}${f}`, fullPath, priority: 0 });
    }
  }
  if (existsSync(root)) {
    const all = files(root).filter((f) => !f.startsWith("skills/") && !isBinaryFile(join(root, f)));
    const coreSet = new Set(coreOf(all));
    for (const f of all) {
      const priority = coreSet.has(f) ? 1 : f.startsWith("reference/human/") ? 2 : 3;
      entries.push({ displayPath: f, fullPath: join(root, f), priority });
    }
  }
  if (!entries.length) return { text: "", files: 0, chars: 0 };

  entries.sort((a, b) => a.priority - b.priority || a.displayPath.localeCompare(b.displayPath));
  const parts: string[] = [];
  const later: string[] = [];
  let room = limit;
  let chars = 0;
  for (const entry of entries) {
    const body = readFileSync(entry.fullPath, "utf8");
    chars += body.length;
    if (body.length <= room) {
      parts.push(`<file path="${entry.displayPath}" chars="${body.length}">\n${body.trimEnd()}\n</file>`);
      room -= body.length;
    } else {
      const desc = entry.displayPath.endsWith(".md") ? descriptionOf(entry.fullPath) : null;
      later.push(`- ${entry.displayPath} (${body.length} chars)${desc ? ` — ${briefDescription(desc)}` : ""}`);
    }
  }
  if (later.length) parts.push(`Not shown here, too long to fit (read each with memory_read):\n${later.join("\n")}`);
  return { text: parts.join("\n\n"), files: entries.length, chars };
}

export async function revertMemoryCommit(backendDir: string, agentId: string, sha: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("not a commit");
  const root = memoryRoot(backendDir, agentId);
  if (!existsSync(join(root, ".git"))) throw new Error("this agent's memory has no history");
  await serial(root, async () => {
    try {
      await git(root, "-c", "user.name=You", "-c", "user.email=you@loki.local", "revert", "--no-edit", sha);
    } catch (error) {
      await git(root, "revert", "--abort").catch(() => {});
      const detail = String((error as { stderr?: string }).stderr ?? error);
      throw new Error(
        /conflict/i.test(detail) ? "a later change touched the same lines; revert that one first" : `could not revert: ${detail.trim().split("\n")[0]}`,
      );
    }
  });
}

export async function editMemoryFile(backendDir: string, agentId: string, path: string, content: string | null, message?: string): Promise<void> {
  const target = resolveMemoryTarget(backendDir, agentId, path);
  if (content === null) {
    if (!existsSync(target.full)) return;
    await removeMemoryFile(target.root, target.full, message?.trim() || `Remove ${target.displayPath}`, { name: "You", email: "you@loki.local" });
    return;
  }
  mkdirSync(dirname(target.full), { recursive: true });
  writeFileSync(target.full, content);
  await commit(target.root, target.full, message?.trim() || `Update ${target.displayPath}`, { name: "You", email: "you@loki.local" });
}

function readMemoryText(full: string, displayPath: string, offset?: number, limit?: number): string {
  const text = readFileSync(full, "utf8");
  if (offset === undefined && limit === undefined && text.length <= READ_LIMIT) return text;
  const lines = text.split("\n");
  const total = lines.length;
  const start = Math.min(total + 1, offset ?? 1);
  if (start > total) return `[Line ${start} is past end of ${displayPath} (${total} lines).]`;
  const maxLines = limit ?? total - start + 1;
  const collected: string[] = [];
  let usedChars = 0;
  for (let i = start - 1; i < total && collected.length < maxLines; i++) {
    const line = lines[i];
    const nextCost = (collected.length > 0 ? 1 : 0) + line.length;
    if (collected.length > 0 && usedChars + nextCost > READ_LIMIT) break;
    if (collected.length === 0 && line.length > READ_LIMIT) {
      collected.push(line.slice(0, READ_LIMIT));
      usedChars = READ_LIMIT;
      break;
    }
    collected.push(line);
    usedChars += nextCost;
  }
  const end = start + collected.length - 1;
  const body = collected.join("\n");
  if (start === 1 && end === total && body.length === text.length) return text;
  const more = end < total ? ` Pass offset=${end + 1} to read more.` : "";
  return `${body}\n\n[Showing lines ${start}–${end} of ${total} (${displayPath}).${more}]`;
}

function parseLineArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : undefined;
}

export function memoryTools(backendDir: string): ChatTool[] {
  const who = async (read: DocumentReader, conversationId: ConversationId, context: Context) => {
    const [agent, chat] = await Promise.all([read.snapshot(AgentInfoDoc, context), read.snapshot(ChatDoc, conversationId, context)]);
    if (!agent?.id) throw new Error("this chat belongs to no agent");
    const id = chat?.id ?? "";
    const author = isReflectionChat(id)
      ? { name: "Reflection", email: `reflection+${agent.id}@loki.local` }
      : isDoctorChat(id)
        ? { name: "Doctor", email: `doctor+${agent.id}@loki.local` }
        : { name: agent.name || agent.id, email: `${agent.id}@loki.local` };
    return { agentId: agent.id, root: memoryRoot(backendDir, agent.id), author };
  };
  return [
    {
      kind: "read",
      name: "memory_read",
      description: "Read a memory or shared/ file by path, with optional line offset and limit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1, description: "Start line (1-based)" },
          limit: { type: "integer", minimum: 1, description: "Max lines" },
        },
        required: ["path"],
      },
      run: async (args, call, context) => {
        const a = args as { path?: unknown; offset?: unknown; limit?: unknown };
        const { agentId } = await who(call.read, call.conversationId, context);
        const target = resolveMemoryTarget(backendDir, agentId, a.path);
        if (!existsSync(target.full)) throw new Error(`no memory file ${String(a.path)}`);
        if (isBinaryFile(target.full)) throw new Error(`${String(a.path)} is not a text file`);
        return { output: [{ type: "text", text: readMemoryText(target.full, target.displayPath, parseLineArg(a.offset), parseLineArg(a.limit)) }] };
      },
    },
    {
      kind: "read",
      name: "memory_search",
      description: "Search memory and shared/ by keywords or phrase, optionally under path.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words or phrase" },
          path: { type: "string", description: "Folder prefix" },
        },
        required: ["query"],
      },
      run: async (args, call, context) => {
        const a = args as { query?: unknown; path?: unknown };
        const { agentId, root } = await who(call.read, call.conversationId, context);
        let prefix: string | null = null;
        if (typeof a.path === "string" && a.path.trim()) {
          const stripped = a.path.trim().replace(/^[/\\]+/, "");
          if (stripped === "shared" || stripped === "shared/" || stripped === "shared\\") prefix = "shared";
          else prefix = resolveMemoryTarget(backendDir, agentId, stripped).displayPath;
        }
        const text = searchMemory(
          [
            { root: sharedMemoryRoot(backendDir), prefix: SHARED_PREFIX },
            { root, prefix: "", excludeSkills: true },
          ],
          typeof a.query === "string" ? a.query : "",
          prefix,
        );
        return { output: [{ type: "text", text }] };
      },
    },
    {
      kind: "read",
      name: "memory_write",
      description: "Write a memory or shared/ file (content: null deletes); committed with message.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: ["string", "null"], description: "File contents, or null to delete" },
          message: { type: "string", description: "Short reason" },
        },
        required: ["path", "content"],
      },
      run: async (args, call, context) => {
        const a = args as { path: string; content: string | null; message?: string };
        const { agentId, author } = await who(call.read, call.conversationId, context);
        const target = resolveMemoryTarget(backendDir, agentId, a.path);
        if (a.content === null) {
          if (!existsSync(target.full)) throw new Error(`no memory file ${a.path}`);
          await removeMemoryFile(target.root, target.full, a.message?.trim() || `Remove ${target.displayPath}`, author);
          return { output: [{ type: "text", text: `deleted ${target.displayPath}` }] };
        }
        mkdirSync(dirname(target.full), { recursive: true });
        writeFileSync(target.full, a.content);
        await commit(target.root, target.full, a.message?.trim() || `Update ${target.displayPath}`, author);
        return { output: [{ type: "text", text: `wrote ${target.displayPath}` }] };
      },
    },
    {
      kind: "read",
      name: "memory_edit",
      description: "Replace an exact passage in a memory or shared/ file; committed with message.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, message: { type: "string" } },
        required: ["path", "old_text", "new_text"],
      },
      run: async (args, call, context) => {
        const a = args as { path: string; old_text: string; new_text: string; message?: string };
        const { agentId, author } = await who(call.read, call.conversationId, context);
        const target = resolveMemoryTarget(backendDir, agentId, a.path);
        const text = existsSync(target.full) ? readFileSync(target.full, "utf8") : null;
        if (text === null) throw new Error(`no memory file ${a.path}`);
        const at = text.indexOf(a.old_text);
        if (at < 0) throw new Error("that passage is not in the file");
        if (text.includes(a.old_text, at + 1)) throw new Error("that passage is in the file more than once; quote more of it");
        writeFileSync(target.full, text.slice(0, at) + a.new_text + text.slice(at + a.old_text.length));
        await commit(target.root, target.full, a.message?.trim() || `Edit ${target.displayPath}`, author);
        return { output: [{ type: "text", text: `edited ${target.displayPath}` }] };
      },
    },
  ];
}

export function memoryExtension(backendDir: string): Extension {
  const sharedRoot = sharedMemoryRoot(backendDir);
  return defineExtension({
    name: "loki.memory",
    sections: [
      section("memory", async (input, context) => {
        const agent = await input.read.snapshot(AgentInfoDoc, context);
        if (!agent?.id) return undefined;
        const root = memoryRoot(backendDir, agent.id);
        return sections.get(`memory\u0000${root}\u0000${sharedRoot}`, () => memorySection(root, "tools", sharedRoot));
      }),
    ],
    tools: memoryTools(backendDir).map(piTool),
  });
}
