/**
 * A conversation log as Letta Code's local backend writes it (`messages.jsonl`, Pi session format v3): a session
 * header, then entries linked by `parentId`, with Letta's own `id`, `otid` and `metadata` on each message.
 */

const AGENT = "agent-local-test";
const CONV = "local-conv-test";

type Line = Record<string, unknown>;

const meta = (at: string) => ({ created_at: at, updated_at: at, agent_id: AGENT, conversation_id: CONV });

export function userLine(id: string, parentId: string | null, at: string, text: string): Line {
  return {
    type: "message",
    id,
    parentId,
    timestamp: at,
    message: { id: `m-${id}`, role: "user", otid: `o-${id}`, metadata: meta(at), content: [{ type: "text", text }], timestamp: Date.parse(at) },
  };
}

export function assistantLine(id: string, parentId: string, at: string, text: string, calls: Array<{ id: string; name: string; arguments: unknown }> = []): Line {
  return {
    type: "message",
    id,
    parentId,
    timestamp: at,
    message: {
      id: `m-${id}`,
      role: "assistant",
      metadata: meta(at),
      content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }, ...calls.map((c) => ({ type: "toolCall", ...c }))],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-test",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls.length ? "toolUse" : "stop",
      timestamp: Date.parse(at),
    },
  };
}

export function toolResultLine(id: string, parentId: string, at: string, callId: string, name: string, output: string, isError = false): Line {
  return {
    type: "message",
    id,
    parentId,
    timestamp: at,
    message: { id: `m-${id}`, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: output }], isError, metadata: meta(at), timestamp: Date.parse(at) },
  };
}

export function compactionLine(id: string, parentId: string, at: string, summary: string, firstKeptEntryId: string): Line {
  return { type: "compaction", id, parentId, timestamp: at, summary, firstKeptEntryId, tokensBefore: 1000, message: { role: "user" }, details: {} };
}

export const headerLine = (cwd = "/tmp/project"): Line => ({ type: "session", version: 3, id: "s1", timestamp: "2026-10-01T10:00:00.000Z", cwd });

/** A log as text, one JSON line each, with Letta's trailing newline. */
export const logText = (lines: Line[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** A short chat: a question, one tool call and its result, the answer, then a compaction keeping from the answer. */
export function sampleLog(): string {
  return logText([
    headerLine(),
    userLine("e1", null, "2026-10-01T10:00:01.000Z", "What is in the readme?"),
    assistantLine("e2", "e1", "2026-10-01T10:00:02.000Z", "Let me look.", [{ id: "call-1", name: "Read", arguments: { file_path: "README.md" } }]),
    toolResultLine("e3", "e2", "2026-10-01T10:00:03.000Z", "call-1", "Read", "# loki"),
    assistantLine("e4", "e3", "2026-10-01T10:00:04.000Z", "It is the loki readme."),
    compactionLine("e5", "e4", "2026-10-01T10:00:05.000Z", "Asked about the readme.", "e4"),
    userLine("e6", "e5", "2026-10-01T10:00:06.000Z", "Thanks"),
  ]);
}
