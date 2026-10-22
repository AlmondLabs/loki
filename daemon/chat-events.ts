import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { messageAt, messageSteps, type ImageNamer, type PiMessage } from "../core/attention/pi-steps.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { turnIdOf } from "./telemetry.ts";

/** Why a message went unanswered, for the person. */
function unanswered(reason: string | undefined): string {
  if (reason === "no_model") return "this chat's model is not available — connect its provider in Preferences › Providers, or pick another model for the chat";
  if (reason === "model_error")
    return "the model could not be reached — is its provider connected in Preferences › Providers? Or pick another model for the chat";
  return `the agent could not take this message up${reason ? ` (${reason})` : ""}`;
}

/** A message's text blocks by content index. */
function textBlocks(message: AssistantMessage | undefined): Map<number, string> {
  const out = new Map<number, string>();
  (Array.isArray(message?.content) ? message.content : []).forEach((block, i) => {
    if (block.type === "text") out.set(i, block.text);
  });
  return out;
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
  /** The in-flight message's text blocks by content index: what `partial` is joined from. */
  private blocks = new Map<number, string>();
  /** The turn in flight (daemon/telemetry.ts names it the same), for the app's analytics to carry. */
  private turnId: string | null = null;
  private readonly agentId: string;
  /** Keeps the person's pictures as files a window loads (plan 029); without it they stay "[image]" lines. */
  private readonly nameImage?: ImageNamer;

  constructor(agentId = "", nameImage?: ImageNamer) {
    this.agentId = agentId;
    this.nameImage = nameImage;
  }

  /** The answer being written now, as far as it has streamed; null between answers. */
  inFlight(): { text: string; at: string | null } | null {
    return this.partial?.text ? { ...this.partial } : null;
  }

  convert(ev: AgentEvent, now = new Date().toISOString()): ChatEvent[] {
    switch (ev.type) {
      // Where the chat stands when following starts: an answer already under way is the partial to start from.
      case "snapshot": {
        this.blocks = textBlocks(ev.generation?.message);
        const text = this.joined();
        this.partial = text ? { text, at: now } : null;
        return [];
      }
      case "run_start":
        this.turnId = turnIdOf(this.agentId, ev.inputs);
        return [{ kind: "loop", state: "running", ...(this.turnId ? { turn_id: this.turnId } : {}) }];
      case "run_end": {
        const turnId = turnIdOf(this.agentId, ev.inputs) ?? this.turnId;
        this.turnId = null;
        this.partial = null;
        this.blocks.clear();
        return [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", ...(turnId ? { turn_id: turnId } : {}) }];
      }
      case "message_start":
        if (ev.message.role !== "user") {
          this.blocks.clear();
          return [];
        }
        return messageSteps(ev.message, messageAt(ev.message) ?? now, this.nameImage).map((step) => ({ kind: "step", step }));
      // The in-flight message changes in batches, and a batch's words can come in any of four shapes: a text block
      // begun (holding all it has so far: an answer's first words, often), words added to one, a block or the whole
      // message rewritten. Taking only the added words lost the first ones until the written answer replaced them.
      case "message_update": {
        for (const change of ev.changes) {
          if (change.type === "text_start" || change.type === "block") {
            if (change.block.type === "text") this.blocks.set(change.contentIndex, change.block.text);
          } else if (change.type === "text_delta") this.blocks.set(change.contentIndex, (this.blocks.get(change.contentIndex) ?? "") + change.delta);
          else if (change.type === "message") this.blocks = textBlocks(change.message);
        }
        const was = this.partial?.text ?? "";
        const text = this.joined();
        if (text === was) return [];
        const at = this.partial?.at ?? now;
        this.partial = text ? { text, at } : null;
        // What was shown still leads: the rest goes as a piece. Otherwise the client is handed the answer so far.
        if (text.startsWith(was)) return [{ kind: "step", step: { kind: "assistant", text: text.slice(was.length), at: now, chunk: true } }];
        return [{ kind: "streaming", text, at }];
      }
      // The attempt failed and pi-durable tries again: what it streamed is not the answer. An empty written answer
      // clears it on the client (ThreadModel), and the next attempt streams afresh.
      case "auto_retry_start":
        this.partial = null;
        this.blocks.clear();
        return [{ kind: "step", step: { kind: "assistant", text: "", at: now } }];
      case "message_end":
        this.partial = null;
        this.blocks.clear();
        return this.answered(ev.entry, now);
      case "tool_execution_end": {
        const result = ev.entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined;
        // No entry: the tool task faulted or was orphaned; the model is told, and the call shows as failed.
        return [
          {
            kind: "step",
            step: { kind: "result", id: ev.toolCallId, output: result?.content ?? "the tool did not finish", failed: result ? result.isError === true : true },
          },
        ];
      }
      case "task_failed":
        return [{ kind: "error", message: ev.message }];
      // A message the agent could not take up at all (no model to run it on, say): the turn ends here, and says why.
      case "submission":
        if (ev.record.status !== "unanswered") return [];
        return [
          { kind: "error", message: unanswered(ev.record.reason) },
          { kind: "settle" },
          { kind: "loop", state: "idle" },
          { kind: "turn_end", turn_id: turnIdOf(this.agentId, [ev.record.id]) ?? undefined },
        ];
      default:
        return [];
    }
  }

  /** The text blocks joined as the written answer joins them (contentText). */
  private joined(): string {
    return [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("\n");
  }

  /** An answer written: the stored message as a history page has it (its words whole, then its tool calls). */
  private answered(entry: EntryRecord, now: string): ChatEvent[] {
    const message = entry.model?.[0] as PiMessage | undefined;
    if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return [];
    return messageSteps(message, messageAt(message) ?? now).map((step) => ({ kind: "step", step }));
  }
}
