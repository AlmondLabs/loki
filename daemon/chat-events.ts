import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { contentText } from "../core/harness.ts";
import { messageAt, messageSteps, type PiMessage } from "../core/attention/pi-steps.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { turnIdOf } from "./telemetry.ts";

/** Why a message went unanswered, for the person. */
function unanswered(reason: string | undefined): string {
  if (reason === "no_model") return "this chat's model is not available — connect its provider in Settings › Providers, or pick another model for the chat";
  if (reason === "model_error") return "the model could not be reached — is its provider connected in Settings › Providers? Or pick another model for the chat";
  return `the agent could not take this message up${reason ? ` (${reason})` : ""}`;
}

/**
 * One chat's pi-durable agent events as loki's chat events (plan 017, U5), what the daemon pushes to every client
 * watching the chat. An answer's words stream in as pieces (`chunk`) for the live view; when the answer is written it
 * goes out whole, as the stored message (what a history page shows), and the client puts it in place of what
 * streamed. Sending only "the rest" after what streamed broke whenever the two disagreed: a retried attempt's
 * pieces were still counted, a client that joined mid-answer had missed the start, and an answer the stream did not
 * prefix went out whole on top of its pieces: the reply showed twice, the second copy glued to the first's tail.
 */
export class ChatEventConverter {
  /** The answer in flight as streamed so far, for a client that opens the chat mid-answer (DaemonChats.open). */
  private partial: { text: string; at: string | null } | null = null;
  /** The turn in flight (daemon/telemetry.ts names it the same), for the app's analytics to carry. */
  private turnId: string | null = null;
  private readonly agentId: string;

  constructor(agentId = "") {
    this.agentId = agentId;
  }

  /** The answer being written now, as far as it has streamed; null between answers. */
  inFlight(): { text: string; at: string | null } | null {
    return this.partial?.text ? { ...this.partial } : null;
  }

  convert(ev: AgentEvent, now = new Date().toISOString()): ChatEvent[] {
    switch (ev.type) {
      // Where the chat stands when following starts: an answer already under way is the partial to start from.
      case "snapshot": {
        const m = ev.generation?.message as PiMessage | undefined;
        const text = m ? contentText((Array.isArray(m.content) ? m.content : []).filter((p) => (p as { type?: string }).type === "text")) : "";
        this.partial = text ? { text, at: now } : null;
        return [];
      }
      case "run_start":
        this.turnId = turnIdOf(this.agentId, ev.inputs);
        return [{ kind: "loop", state: "running", ...(this.turnId ? { turnId: this.turnId } : {}) }];
      case "run_end": {
        const turnId = turnIdOf(this.agentId, ev.inputs) ?? this.turnId;
        this.turnId = null;
        this.partial = null;
        return [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", ...(turnId ? { turnId } : {}) }];
      }
      case "message_start":
        if (ev.message.role !== "user") return [];
        return [{ kind: "step", step: { kind: "user", raw: contentText(ev.message.content), at: messageAt(ev.message) ?? now } }];
      case "message_update": {
        const out: ChatEvent[] = [];
        for (const change of ev.changes) {
          if (change.type !== "text_delta") continue;
          this.partial = { text: (this.partial?.text ?? "") + change.delta, at: this.partial?.at ?? now };
          out.push({ kind: "step", step: { kind: "assistant", text: change.delta, at: now, chunk: true } });
        }
        return out;
      }
      // The attempt failed and pi-durable tries again: what it streamed is not the answer. An empty written answer
      // clears it on the client (ThreadModel), and the next attempt streams afresh.
      case "auto_retry_start":
        this.partial = null;
        return [{ kind: "step", step: { kind: "assistant", text: "", at: now } }];
      case "message_end":
        this.partial = null;
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
        return [{ kind: "error", message: unanswered(ev.record.reason) }, { kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", turnId: turnIdOf(this.agentId, [ev.record.id])! }];
      default:
        return [];
    }
  }

  /** An answer written: the stored message as a history page has it (its words whole, then its tool calls). */
  private answered(entry: EntryRecord, now: string): ChatEvent[] {
    const message = entry.model?.[0] as PiMessage | undefined;
    if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return [];
    return messageSteps(message, messageAt(message) ?? now).map((step) => ({ kind: "step", step }));
  }
}
