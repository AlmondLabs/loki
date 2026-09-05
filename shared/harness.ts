/**
 * Letta's harness injects machinery into transcripts as ordinary messages:
 * system reminders, background-task notifications, compaction notes, and
 * loci's own desk-activity block. Both halves of loci need to recognise them:
 * the mod for the chat mirror, the browser for the Catch Up thread.
 */

export function stripHarnessMarkup(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-alert>[\s\S]*?<\/system-alert>/g, "")
    .replace(/<loci-desk[^>]*>[\s\S]*?<\/loci-desk>/g, "")
    .replace(/<channel-notification[^>]*>[\s\S]*?<\/channel-notification>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/^\s*Full transcript available at: \S+\s*$/gm, "")
    .replace(/^\s*\{"type":\s*"system_alert"[\s\S]*?\}\s*$/gm, "");
}

/** Undo the HTML escaping Letta applies inside task-notification results. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface HarnessEvent {
  /** e.g. "background task bash_24 completed" */
  text: string;
  /** e.g. the task's summary line */
  summary: string | null;
  /** the raw result, decoded, for a disclosure */
  detail: string | null;
}

/** Pull the harness-injected events (task notifications, compaction notes) out of a user message. */
export function extractHarnessEvents(text: string): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    const tag = (name: string) => body.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim() ?? null;
    const id = tag("task-id");
    const status = tag("status");
    const summary = tag("summary");
    const result = tag("result");
    out.push({
      text: `background task${id ? ` ${id}` : ""}${status ? ` ${status}` : ""}`,
      summary: summary ? decodeEntities(summary) : null,
      detail: result ? decodeEntities(result) : null,
    });
  }
  for (const m of text.matchAll(/^\s*(\{"type":\s*"system_alert"[\s\S]*?\})\s*$/gm)) {
    try {
      const alert = JSON.parse(m[1]) as { message?: string };
      const msg = typeof alert.message === "string" ? alert.message : "";
      out.push({ text: /hidden from view|compact/i.test(msg) ? "context compacted" : "system alert", summary: msg.split("\n")[0]?.slice(0, 160) ?? null, detail: msg || null });
    } catch {
      // not JSON after all; leave it to the text
    }
  }
  return out;
}

/** Text of a Letta message's content (string or text parts). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
    .join("");
}

export interface TranscriptMessage {
  /** event: harness machinery (background task results, compaction), shown as a quiet row. */
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  at: string | null;
  summary?: string | null;
  detail?: string | null;
}

/**
 * Letta protocol messages (from conversation_messages_list or stream deltas),
 * oldest first, → a readable thread. Tool calls become markers; harness
 * machinery becomes events; reasoning and tool returns are dropped.
 */
export function toTranscript(messages: Array<Record<string, unknown>>): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    const at = typeof m.date === "string" ? m.date : null;
    switch (m.message_type) {
      case "user_message": {
        const raw = messageText(m.content);
        for (const ev of extractHarnessEvents(raw)) out.push({ role: "event", text: ev.text, summary: ev.summary, detail: ev.detail, at });
        const text = stripHarnessMarkup(raw).trim();
        if (text) out.push({ role: "user", text, at });
        break;
      }
      case "assistant_message": {
        const text = messageText(m.content).trim();
        if (text) out.push({ role: "assistant", text, at });
        break;
      }
      case "tool_call_message":
      case "approval_request_message": {
        const tc = m.tool_call as { name?: string; arguments?: unknown } | undefined;
        if (tc?.name) out.push({ role: "tool", text: toolLabel(tc.name, tc.arguments), at });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Heuristic: does this assistant message end by asking the user something? */
export function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const tail = text.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  return /\?\s*$/.test(tail) || /\b(should I|do you want|which (one|of)|let me know|your call|confirm)\b/i.test(tail);
}

/**
 * A one-line label for a tool call: the tool name plus the part of its input
 * a reader recognises (the shell command, the file path, the pattern).
 */
export function toolLabel(name: string, input: unknown): string {
  let args: Record<string, unknown> | null = null;
  if (input && typeof input === "object") args = input as Record<string, unknown>;
  else if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // partial or non-JSON arguments: name only
    }
  }
  if (!args) return name;
  const pick = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"].find((k) => typeof args![k] === "string" && (args![k] as string).trim());
  if (!pick) return name;
  const raw = (args[pick] as string).trim().split("\n")[0];
  const short = raw.length > 80 ? raw.slice(0, 77) + "…" : raw;
  return `${name} · ${short}`;
}
