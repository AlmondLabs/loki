import type { RefObject } from "react";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import type { PendingQuestion } from "../../../packages/core/src/attention/model.ts";
import { Button } from "../ui";
import { ChatInput } from "./ChatInput";
import type { ChatStatus } from "./ChatWindow";

/** The footer row: the message box and the send button, which reads "queue" while the agent is mid-turn. */
export function Composer({
  inputRef,
  draft,
  onDraft,
  images,
  onImages,
  onSubmit,
  status,
  agentName,
  question,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraft: (text: string) => void;
  images: ImageAttachment[];
  onImages: (images: ImageAttachment[]) => void;
  onSubmit: () => void;
  status: ChatStatus;
  agentName: string | null | undefined;
  question: PendingQuestion | null;
}) {
  const hasContent = !!draft.trim() || images.length > 0;
  return (
    <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loki-border)", alignItems: "flex-end" }}>
      <ChatInput
        ref={inputRef}
        value={draft}
        onChange={onDraft}
        onSubmit={onSubmit}
        onEscape={() => inputRef.current?.blur()}
        images={images}
        onImages={onImages}
        placeholder={composerPlaceholder(question, status, agentName)}
      />
      <Button
        size="md"
        tone={hasContent ? "brass" : "quiet"}
        onClick={onSubmit}
        disabled={!hasContent}
        title={status === "idle" ? undefined : "the agent is mid-turn; this is kept and sent when the turn ends"}
      >
        {status === "idle" ? "send" : "queue"}
      </Button>
    </div>
  );
}

/** What the empty box says: answer the open question, or message the agent, with a note when it will queue. */
export function composerPlaceholder(question: PendingQuestion | null, status: ChatStatus, agentName: string | null | undefined): string {
  if (question) return question.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…";
  const who = agentName ?? "the agent";
  return status === "idle" ? `message ${who}… (⇧↵ for a new line)` : `message ${who}… it goes when this turn ends`;
}
