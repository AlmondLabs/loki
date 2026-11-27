import type { Context } from "@earendil-works/chord/context";
import { defineExtension, section, type ConversationId, type DocumentReader, type Extension } from "@earendil-works/pi-durable";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { piTool, type ChatTool } from "./chat-tools.ts";
import { SCRIPT_TOOL } from "./scripts.ts";
import type { ChatProjection } from "./chats.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";

export type ChatHistory = Pick<ChatProjection, "thread" | "compactedSince"> & Partial<Pick<ChatProjection, "ensureLoaded">>;

const SCRIPTS_ONLY = ["tools"] as const;

const HITS = 10;
const EXCERPT = 300;
const READ_CHARS = 8000;

const SUMMARIZED = "Earlier turns of this conversation were summarized; every one is stored.";
const IN_A_SCRIPT = `${SUMMARIZED} Find them with history_search and read them with history_read, in a script, before you guess.`;
const DIRECT = `${SUMMARIZED} Find them with history_search and read them with history_read before you guess.`;

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

interface SearchHitItem {
  row: number;
  speaker: string;
  at: string | null;
  excerpt: string;
}

function searchStructured(rows: readonly TranscriptRow[], query: string): { text: string; total: number; hits: SearchHitItem[] } {
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) throw new Error("history_search needs words to look for");
  const word = needle.split(" ").reduce((a, b) => (b.length > a.length ? b : a));
  const hitLines: string[] = [];
  const hits: SearchHitItem[] = [];
  let found = 0;
  for (let n = rows.length - 1; n >= 0; n--) {
    const row = rows[n];
    const words = row.role === "tool" ? `${row.text} ${body(row)}` : body(row);
    if (!words.toLowerCase().includes(word)) continue;
    const flat = words.replace(/\s+/g, " ");
    const at = flat.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    found++;
    if (hits.length < HITS) {
      const part = excerpt(flat, at, needle.length);
      hitLines.push(rowLine(row, n, part));
      hits.push({ row: n, speaker: speaker(row), at: row.at ?? null, excerpt: part });
    }
  }
  if (!found) return { text: `No row of this conversation contains "${query.trim()}". Try other words.`, total: 0, hits: [] };
  const more = found > hits.length ? ` (the newest ${hits.length} shown: search for something narrower, or read around a row with history_read)` : "";
  return { text: `${found} ${found === 1 ? "row contains" : "rows contain"} "${query.trim()}"${more}:\n${hitLines.join("\n")}`, total: found, hits };
}

export function searchRows(rows: readonly TranscriptRow[], query: string): string {
  return searchStructured(rows, query).text;
}

interface ReadRowItem {
  row: number;
  speaker: string;
  at: string | null;
  text: string;
}

function readStructured(
  rows: readonly TranscriptRow[],
  from: number,
  to?: number,
): { text: string; from: number; to: number | null; nextFrom: number | null; items: ReadRowItem[] } {
  const last = rows.length - 1;
  const start = Math.max(0, Math.floor(from));
  if (start > last) {
    return {
      text: last < 0 ? "This conversation has no rows yet." : `Nothing at #${start}: this conversation's rows are #0 to #${last}.`,
      from: start,
      to: null,
      nextFrom: null,
      items: [],
    };
  }
  const end = Math.min(last, to === undefined ? last : Math.floor(to));
  const lines: string[] = [];
  const items: ReadRowItem[] = [];
  let used = 0;
  let nextFrom: number | null = null;
  let actualEnd = start - 1;
  for (let n = start; n <= end; n++) {
    const line = rowLine(rows[n], n);
    if (lines.length && used + line.length > READ_CHARS) {
      lines.push(`[stopped before #${n}; read on with history_read from ${n}]`);
      nextFrom = n;
      break;
    }
    lines.push(line.length > READ_CHARS ? `${line.slice(0, READ_CHARS)}… [row cut]` : line);
    items.push({ row: n, speaker: speaker(rows[n]), at: rows[n].at ?? null, text: body(rows[n]) });
    actualEnd = n;
    used += line.length + 1;
  }
  if (nextFrom === null && actualEnd < last) nextFrom = actualEnd + 1;
  return { text: lines.join("\n"), from: start, to: actualEnd >= start ? actualEnd : null, nextFrom, items };
}

export function readRows(rows: readonly TranscriptRow[], from: number, to?: number): string {
  return readStructured(rows, from, to).text;
}

export function historyTools(history: ChatHistory): ChatTool[] {
  const rowsOf = async (
    read: DocumentReader,
    conversationId: ConversationId,
    targetConversationId: unknown,
    context: Context,
  ): Promise<{ chatId: string; rows: readonly TranscriptRow[] }> => {
    const chat = await chatOf(read, conversationId, context);
    if (!chat) throw new Error("this chat belongs to no agent");
    const targetId = typeof targetConversationId === "string" && targetConversationId.trim() ? targetConversationId.trim() : chat.chatId;
    await history.ensureLoaded?.(targetId, chat.agentId);
    return { chatId: targetId, rows: history.thread(targetId, chat.agentId) };
  };
  return [
    {
      kind: "read",
      name: "history_search",
      callers: SCRIPTS_ONLY,
      outputSchema: { type: "object" },
      description:
        "Search this conversation's (or another chat's belonging to this agent via `conversation_id`) whole history, including turns a compaction summarized away, for rows containing the words. Newest first, at most 10, each with its row number and an excerpt.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to find; case does not matter" },
          conversation_id: { type: "string", description: "Optional conversation id belonging to this agent; omit for this chat." },
        },
        required: ["query"],
      },
      run: async (args, call, context) => {
        const query = typeof args.query === "string" ? args.query : "";
        const { chatId, rows } = await rowsOf(call.read, call.conversationId, args.conversation_id, context);
        const found = searchStructured(rows, query);
        return {
          output: [{ type: "text", text: found.text }],
          structuredOutput: {
            conversation_id: chatId,
            query: query.trim(),
            total: found.total,
            hits: found.hits.map((h) => ({ row: h.row, speaker: h.speaker, at: h.at, excerpt: h.excerpt })),
          },
        };
      },
    },
    {
      kind: "read",
      name: "history_read",
      callers: SCRIPTS_ONLY,
      outputSchema: { type: "object" },
      description:
        "Read rows of this conversation's (or another chat's belonging to this agent via `conversation_id`) history by number, as history_search gives them; long reads stop and say where to go on.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "integer", description: "The first row" },
          to: { type: "integer", description: "The last row, included; the conversation's end when left out" },
          conversation_id: { type: "string", description: "Optional conversation id belonging to this agent; omit for this chat." },
        },
        required: ["from"],
      },
      run: async (args, call, context) => {
        const { chatId, rows } = await rowsOf(call.read, call.conversationId, args.conversation_id, context);
        const from = typeof args.from === "number" ? args.from : 0;
        const to = typeof args.to === "number" ? args.to : undefined;
        const res = readStructured(rows, from, to);
        return {
          output: [{ type: "text", text: res.text }],
          structuredOutput: {
            conversation_id: chatId,
            from: res.from,
            to: res.to,
            next_from: res.nextFrom,
            rows: res.items.map((r) => ({ row: r.row, speaker: r.speaker, at: r.at, text: r.text })),
          },
        };
      },
    },
  ];
}

export function historyExtension(history: ChatHistory): Extension {
  return defineExtension({
    name: "loki.history",
    sections: [
      section("history", async (input, context) => {
        const offered = (name: string) => input.agent.tools.some((t) => t.name === name);
        const note = offered(SCRIPT_TOOL) ? IN_A_SCRIPT : offered("history_search") ? DIRECT : undefined;
        if (!note) return undefined;
        const chat = await chatOf(input.read, input.conversationId, context);
        return chat && history.compactedSince(chat.chatId, chat.agentId, 0) ? note : undefined;
      }),
    ],
    tools: historyTools(history).map(piTool),
  });
}
