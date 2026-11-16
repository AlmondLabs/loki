import type { Context } from "@earendil-works/chord";
import { defineExtension, section, type ConversationId, type DocumentReader, type Extension } from "@earendil-works/pi-durable";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { piTool, type ChatTool } from "./chat-tools.ts";
import { SCRIPT_TOOL } from "./scripts.ts";
import type { ChatProjection } from "./chats.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";

export type ChatHistory = Pick<ChatProjection, "thread" | "compactedSince">;

const SCRIPTS_ONLY = ["tools"] as const;

const HITS = 10;
const EXCERPT = 300;
const READ_CHARS = 8000;

const SECTION =
  "Earlier turns of this conversation were summarized; every one is stored. Find them with history_search and read them with history_read, in a script, before you guess.";

async function chatOf(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<{ agentId: string; chatId: string } | null> {
  const [agent, chat] = await Promise.all([read.snapshot(AgentInfoDoc, context), read.snapshot(ChatDoc, conversationId, context)]);
  return agent?.id && chat?.id ? { agentId: agent.id, chatId: chat.id } : null;
}

function speaker(row: TranscriptRow): string {
  if (row.role === "user") return "person";
  if (row.role === "assistant") return "you";
  if (row.role === "tool") return `tool ${row.tool?.name ?? row.text}`;
  return "event";
}

function body(row: TranscriptRow): string {
  if (row.role !== "tool" || !row.tool) return row.text.trim();
  const { input, output, failed, error } = row.tool;
  const parts: string[] = [];
  if (input) parts.push(`input: ${input}`);
  if (failed) parts.push(`failed: ${error ?? output ?? ""}`);
  else if (output) parts.push(`output: ${output}`);
  return parts.length ? parts.join("\n") : row.text.trim();
}

function rowLine(row: TranscriptRow, n: number, words = body(row)): string {
  const at = row.at ? ` ${row.at.slice(0, 16).replace("T", " ")}` : "";
  return `#${n} ${speaker(row)}${at}: ${words}`;
}

function excerpt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - Math.floor((EXCERPT - length) / 2));
  const end = Math.min(text.length, start + EXCERPT);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function searchRows(rows: readonly TranscriptRow[], query: string): string {
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) throw new Error("history_search needs words to look for");
  const word = needle.split(" ").reduce((a, b) => (b.length > a.length ? b : a));
  const hits: string[] = [];
  let found = 0;
  for (let n = rows.length - 1; n >= 0; n--) {
    const row = rows[n];
    const words = row.role === "tool" ? `${row.text} ${body(row)}` : body(row);
    if (!words.toLowerCase().includes(word)) continue;
    const flat = words.replace(/\s+/g, " ");
    const at = flat.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    found++;
    if (hits.length < HITS) hits.push(rowLine(row, n, excerpt(flat, at, needle.length)));
  }
  if (!found) return `No row of this conversation contains "${query.trim()}". Try other words.`;
  const more = found > hits.length ? ` (the newest ${hits.length} shown: search for something narrower, or read around a row with history_read)` : "";
  return `${found} ${found === 1 ? "row contains" : "rows contain"} "${query.trim()}"${more}:\n${hits.join("\n")}`;
}

export function readRows(rows: readonly TranscriptRow[], from: number, to?: number): string {
  const last = rows.length - 1;
  const start = Math.max(0, Math.floor(from));
  if (start > last) return last < 0 ? "This conversation has no rows yet." : `Nothing at #${start}: this conversation's rows are #0 to #${last}.`;
  const end = Math.min(last, to === undefined ? last : Math.floor(to));
  const lines: string[] = [];
  let used = 0;
  for (let n = start; n <= end; n++) {
    const line = rowLine(rows[n], n);
    if (lines.length && used + line.length > READ_CHARS) {
      lines.push(`[stopped before #${n}; read on with history_read from ${n}]`);
      break;
    }
    lines.push(line.length > READ_CHARS ? `${line.slice(0, READ_CHARS)}… [row cut]` : line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export function historyTools(history: ChatHistory): ChatTool[] {
  const rowsOf = async (read: DocumentReader, conversationId: ConversationId, context: Context): Promise<readonly TranscriptRow[]> => {
    const chat = await chatOf(read, conversationId, context);
    if (!chat) throw new Error("this chat belongs to no agent");
    return history.thread(chat.chatId, chat.agentId);
  };
  return [
    {
      kind: "read",
      name: "history_search",
      callers: SCRIPTS_ONLY,
      description:
        "Search this conversation's whole history, including turns a compaction summarized away, for rows containing the words. Newest first, at most 10, each with its row number and an excerpt.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Words to find; case does not matter" } }, required: ["query"] },
      run: async (args, call, context) => {
        const rows = await rowsOf(call.read, call.conversationId, context);
        return { output: [{ type: "text", text: searchRows(rows, typeof args.query === "string" ? args.query : "") }] };
      },
    },
    {
      kind: "read",
      name: "history_read",
      callers: SCRIPTS_ONLY,
      description: "Read rows of this conversation's history by number, as history_search gives them; long reads stop and say where to go on.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "integer", description: "The first row" },
          to: { type: "integer", description: "The last row, included; the conversation's end when left out" },
        },
        required: ["from"],
      },
      run: async (args, call, context) => {
        const rows = await rowsOf(call.read, call.conversationId, context);
        const from = typeof args.from === "number" ? args.from : 0;
        const to = typeof args.to === "number" ? args.to : undefined;
        return { output: [{ type: "text", text: readRows(rows, from, to) }] };
      },
    },
  ];
}

export function historyExtension(history: ChatHistory): Extension {
  return defineExtension({
    name: "loki.history",
    sections: [
      section("history", async (input, context) => {
        if (!input.agent.tools.some((t) => t.name === SCRIPT_TOOL)) return undefined;
        const chat = await chatOf(input.read, input.conversationId, context);
        return chat && history.compactedSince(chat.chatId, chat.agentId, 0) ? SECTION : undefined;
      }),
    ],
    tools: historyTools(history).map(piTool),
  });
}
