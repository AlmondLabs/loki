import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, section, type ConversationId, type DocumentReader, type Extension } from "@earendil-works/pi-durable";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";

/**
 * An agent's memory on loki's daemon (plan 017, U9): the git repo at `<backend>/memfs/<agentId>/memory`, Letta's
 * layout. Its `system/` files (or, without that folder, its top-level markdown files) are in the agent's prompt as the
 * `memory` section; everything else is listed by path for the agent to read when it needs it. The memory tools read,
 * write and edit files there, each change a commit, by the agent, or by "Reflection" in a reflection pass, which is
 * how the Agents page tells them apart. A section changes only when memory does, so the prompt cache holds.
 */

const run = promisify(execFile);

/** How much of a memory file a section shows, and how many other files it lists. */
const FILE_LIMIT = 64 * 1024;
const LISTED = 200;

export const MEMORY_TOOLS = ["memory_read", "memory_write", "memory_edit"];

/** A reflection pass's chat (daemon/reflection.ts): its commits are Reflection's. */
export const isReflectionChat = (chatId: string): boolean => chatId.startsWith("reflection-");

export function memoryRoot(backendDir: string, agentId: string): string {
  return join(backendDir, "memfs", agentId, "memory");
}

/** Every file in the repo, `.git` left out, relative and with forward slashes. */
function files(root: string, dir = root, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(root, full, out);
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** The memory section's text: the core files in full, the rest by path. Undefined when the agent has no memory. */
export function memorySection(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const all = files(root);
  const core = all.some((f) => f.startsWith("system/")) ? all.filter((f) => f.startsWith("system/") && f.endsWith(".md")) : all.filter((f) => !f.includes("/") && f.endsWith(".md"));
  const parts = core.map((f) => `<file path="${f}">\n${readFileSync(join(root, f), "utf8").slice(0, FILE_LIMIT).trimEnd()}\n</file>`);
  const rest = all.filter((f) => !core.includes(f));
  if (rest.length) parts.push(`Other memory files (read them with memory_read when you need them):\n${rest.slice(0, LISTED).map((f) => `- ${f}`).join("\n")}${rest.length > LISTED ? `\n- … and ${rest.length - LISTED} more` : ""}`);
  return parts.length ? `This is your memory, kept as files you can change with the memory tools.\n\n${parts.join("\n\n")}` : undefined;
}

/** A path inside the repo, or an error: memory files cannot reach outside it. */
function inside(root: string, path: unknown): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("path required");
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || rel.split(sep)[0] === ".git") throw new Error(`${path} is not a memory file`);
  return full;
}

async function commit(root: string, path: string, message: string, author: { name: string; email: string }): Promise<void> {
  await run("git", ["-C", root, "add", "--", path]);
  await run("git", ["-C", root, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "-m", message, "--", path]);
}

/** A memory file changed from the Agents page: written (or removed, with `content` null) and committed as the person's. */
export async function editMemoryFile(backendDir: string, agentId: string, path: string, content: string | null, message?: string): Promise<void> {
  const root = memoryRoot(backendDir, agentId);
  const full = inside(root, path);
  if (content === null) {
    if (!existsSync(full)) return;
    await run("git", ["-C", root, "rm", "--quiet", "--", full]);
    await run("git", ["-C", root, "-c", "user.name=You", "-c", "user.email=you@loki.local", "commit", "--quiet", "-m", message?.trim() || `Remove ${path}`, "--", full]);
    return;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  await commit(root, full, message?.trim() || `Update ${path}`, { name: "You", email: "you@loki.local" });
}

export function memoryExtension(backendDir: string): Extension {
  const who = async (read: DocumentReader, conversationId: ConversationId, context: Context) => {
    const [agent, chat] = await Promise.all([read.snapshot(AgentInfoDoc, context), read.snapshot(ChatDoc, conversationId, context)]);
    if (!agent?.id) throw new Error("this chat belongs to no agent");
    const reflecting = isReflectionChat(chat?.id ?? "");
    return { root: memoryRoot(backendDir, agent.id), author: reflecting ? { name: "Reflection", email: `reflection+${agent.id}@loki.local` } : { name: agent.name || agent.id, email: `${agent.id}@loki.local` } };
  };
  return defineExtension({
    name: "loki.memory",
    sections: [
      section("memory", async (input, context) => {
        const agent = await input.read.snapshot(AgentInfoDoc, context);
        return agent?.id ? memorySection(memoryRoot(backendDir, agent.id)) : undefined;
      }),
    ],
    tools: [
      defineTool({
        name: "memory_read",
        description: "Read one of your memory files by its path.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
        execute: async (args, api, context) => {
          const { root } = await who(api, api.conversationId, context);
          const full = inside(root, (args as { path?: string }).path);
          if (!existsSync(full)) throw new Error(`no memory file ${(args as { path: string }).path}`);
          return { content: [{ type: "text", text: readFileSync(full, "utf8") }] };
        },
      }),
      defineTool({
        name: "memory_write",
        description: "Write a whole memory file (created if new); the change is committed with your message.",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, message: { type: "string", description: "Why, in a few words" } }, required: ["path", "content"] } as never,
        execute: async (args, api, context) => {
          const a = args as { path: string; content: string; message?: string };
          const { root, author } = await who(api, api.conversationId, context);
          const full = inside(root, a.path);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, a.content);
          await commit(root, full, a.message?.trim() || `Update ${a.path}`, author);
          return { content: [{ type: "text", text: `wrote ${a.path}` }] };
        },
      }),
      defineTool({
        name: "memory_edit",
        description: "Replace one exact passage of a memory file with another; the change is committed with your message.",
        parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, message: { type: "string" } }, required: ["path", "old_text", "new_text"] } as never,
        execute: async (args, api, context) => {
          const a = args as { path: string; old_text: string; new_text: string; message?: string };
          const { root, author } = await who(api, api.conversationId, context);
          const full = inside(root, a.path);
          const text = existsSync(full) ? readFileSync(full, "utf8") : null;
          if (text === null) throw new Error(`no memory file ${a.path}`);
          const at = text.indexOf(a.old_text);
          if (at < 0) throw new Error("that passage is not in the file");
          if (text.indexOf(a.old_text, at + 1) >= 0) throw new Error("that passage is in the file more than once; quote more of it");
          writeFileSync(full, text.slice(0, at) + a.new_text + text.slice(at + a.old_text.length));
          await commit(root, full, a.message?.trim() || `Edit ${a.path}`, author);
          return { content: [{ type: "text", text: `edited ${a.path}` }] };
        },
      }),
    ],
  });
}
