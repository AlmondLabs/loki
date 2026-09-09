import { useState } from "react";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import type { PendingQuestion } from "../../../packages/core/src/attention/model.ts";

/**
 * The message being typed: its text, the images pasted or dropped in, and the send.
 * Submitting clears the box first; a typed reply while one question is open is the
 * answer to it, anything else goes to the agent.
 */
export function useDraft({
  question,
  onAnswer,
  onSend,
}: {
  question: PendingQuestion | null;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const submit = () => {
    const text = draft.trim();
    if (!text && !images.length) return;
    setDraft("");
    setImages([]);
    // A typed reply while one question is open is the answer to it.
    if (question && onAnswer && question.questions.length === 1 && text && !images.length) {
      onAnswer({ [question.questions[0].question]: text });
      return;
    }
    onSend(text, images);
  };
  return { draft, setDraft, images, setImages, submit };
}
