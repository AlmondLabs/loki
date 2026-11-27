import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, EnvTarget } from "@earendil-works/pi-durable";
import { type FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChatDoc } from "./kernel/index.ts";

export async function toolResultsDir(
  lokiDir: string,
  read: Pick<DocumentReader, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<string> {
  return resultsDirOf(lokiDir, (await read.snapshot(ChatDoc, conversationId, context))?.id || `conversation-${conversationId}`);
}

export const resultsDirOf = (lokiDir: string, chatId: string): string => join(lokiDir, "tool-results", chatId.replace(/[^A-Za-z0-9_.-]+/g, "_"));

let saved = 0;

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

export function chatEnvs(lokiDir: string): (target: EnvTarget, context: Context) => Promise<ChatEnv> {
  return async ({ conversationId, cwd, read }, context) =>
    new ChatEnv({ cwd: cwd ?? homedir(), resultsDir: await toolResultsDir(lokiDir, read, conversationId, context) });
}
