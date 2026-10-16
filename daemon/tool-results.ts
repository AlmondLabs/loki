import type { Context } from "@earendil-works/chord";
import type { ConversationId, DocumentReader, EnvTarget } from "@earendil-works/pi-durable";
import { type FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChatDoc } from "./kernel/index.ts";

/**
 * Where a chat's too-big tool results are saved whole: `<loki>/tool-results/<chat>/`, one folder a chat (named for its
 * chat id, or `conversation-<id>` before it has one), so the agent reads them back with its file tools and they outlive
 * the system's temp folder. MCP results (daemon/mcp/results.ts) and bash output past pi-durable's limits (ChatEnv
 * below) both land here.
 */
export async function toolResultsDir(
  lokiDir: string,
  read: Pick<DocumentReader, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<string> {
  const chat = (await read.snapshot(ChatDoc, conversationId, context))?.id || `conversation-${conversationId}`;
  return join(lokiDir, "tool-results", chat.replace(/[^A-Za-z0-9_.-]+/g, "_"));
}

let saved = 0;

/**
 * A chat's execution environment: pi-durable's own, except that the file a command's output spills to once it passes
 * the bash tool's limits (50KB or 2,000 lines, whose tail the model sees with the file's path) goes in the chat's
 * tool-results folder instead of the system's temp folder. If that folder cannot be written, the temp folder still
 * takes it.
 */
export class ChatEnv extends NodeExecutionEnv {
  private readonly resultsDir: string;

  constructor(opts: { cwd: string; resultsDir: string }) {
    super({ cwd: opts.cwd });
    this.resultsDir = opts.resultsDir;
  }

  override async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const file = join(this.resultsDir, `bash-${Date.now().toString(36)}-${++saved}${options?.suffix ?? ".log"}`);
    try {
      await mkdir(this.resultsDir, { recursive: true });
      await writeFile(file, "");
      return ok(file);
    } catch {
      return super.createTempFile(options, context);
    }
  }
}

/** The harness's environment for each chat: a ChatEnv in the chat's folder (home before it has one), saving to `lokiDir`. */
export function chatEnvs(lokiDir: string): (target: EnvTarget, context: Context) => Promise<ChatEnv> {
  return async ({ conversationId, cwd, read }, context) =>
    new ChatEnv({ cwd: cwd ?? homedir(), resultsDir: await toolResultsDir(lokiDir, read, conversationId, context) });
}
