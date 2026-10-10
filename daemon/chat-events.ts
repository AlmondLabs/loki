import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { contentText } from "../core/harness.ts";
import { messageAt } from "../core/attention/pi-steps.ts";
import type { ChatEvent } from "../core/attention/model.ts";

/** Why a message went unanswered, for the person. */
function unanswered(reason: string | undefined): string {
  if (reason === "no_model") return "this chat's model is not available — connect its provider in Settings › Providers, or pick another model for the chat";
  if (reason === "model_error") return "the model could not be reached — is its provider connected in Settings › Providers? Or pick another model for the chat";
  return `the agent could not take this message up${reason ? ` (${reason})` : ""}`;
}

/**
 * One chat's pi-durable agent events as loki's chat events (plan 017, U5), what the daemon pushes to every client
 * watching the chat. Stateful per chat: an answer's words stream in as pieces, and a short answer can be committed
 * whole with no piece before it, so the converter remembers how much of the answer in flight it has sent and sends
 * only the rest when the answer is written.
 */
export class ChatEventConverter {
  /** The answer in flight: its text so far, by content block. */
  private streamed = new Map<number, string>();

  convert(ev: AgentEvent, now = new Date().toISOString()): ChatEvent[] {
    switch (ev.type) {
      case "run_start":
        return [{ kind: "loop", state: "running" }];
      case "run_end":
        return [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end" }];
      case "message_start":
        if (ev.message.role !== "user") return [];
        return [{ kind: "step", step: { kind: "user", raw: contentText(ev.message.content), at: messageAt(ev.message) ?? now } }];
      case "message_update": {
        const out: ChatEvent[] = [];
        for (const change of ev.changes) {
          if (change.type !== "text_delta") continue;
          this.streamed.set(change.contentIndex, (this.streamed.get(change.contentIndex) ?? "") + change.delta);
          out.push({ kind: "step", step: { kind: "assistant", text: change.delta, at: now, chunk: true } });
        }
        return out;
      }
      case "message_end":
        return this.answered(ev.entry, now);
      case "tool_execution_end": {
        const result = ev.entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined;
        // No entry: the tool task faulted or was orphaned; the model is told, and the call shows as failed.
        return [{ kind: "step", step: { kind: "result", id: ev.toolCallId, output: result?.content ?? "the tool did not finish", failed: result ? result.isError === true : true } }];
      }
      case "task_failed":
        return [{ kind: "error", message: ev.message }];
      // A message the agent could not take up at all (no model to run it on, say): the turn ends here, and says why.
      case "submission":
        if (ev.record.status !== "unanswered") return [];
        return [{ kind: "error", message: unanswered(ev.record.reason) }, { kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end" }];
      default:
        return [];
    }
  }

  /** An answer written: what of its words did not stream, then its tool calls. */
  private answered(entry: EntryRecord, now: string): ChatEvent[] {
    const message = entry.model?.[0] as { role?: string; content?: Array<{ type?: string; text?: string; name?: string; id?: string; arguments?: unknown }> } | undefined;
    if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return [];
    const out: ChatEvent[] = [];
    (message.content ?? []).forEach((part, index) => {
      if (part.type === "text" && part.text) {
        const sent = this.streamed.get(index) ?? "";
        const rest = part.text.startsWith(sent) ? part.text.slice(sent.length) : part.text;
        if (rest) out.push({ kind: "step", step: { kind: "assistant", text: rest, at: now, chunk: true } });
      } else if (part.type === "toolCall" && part.name) {
        out.push({ kind: "step", step: { kind: "call", name: part.name, args: part.arguments, id: part.id ?? null, at: now } });
      }
    });
    this.streamed.clear();
    return out;
  }
}
