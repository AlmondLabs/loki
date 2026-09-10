import { useState } from "react";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { PendingQuestion } from "../../../core/attention/model.ts";
import { parseSlash, type SlashCommand } from "../../../core/attention/commands.ts";

/**
 * The message being typed: its text, the images pasted or dropped in, and the send.
 * Submitting clears the box first; a typed reply while one question is open is the
 * answer to it, a known "/command" runs as one, anything else goes to the agent.
 */
export function useDraft({
  question,
  onAnswer,
  onSend,
  commands = [],
  onCommand,
}: {
  question: PendingQuestion | null;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  /** Slash commands the box knows; a typed one runs instead of being sent. */
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const submit = () => {
    const text = draft.trim();
    if (!text && !images.length) return;
    setDraft("");
    setImages([]);
    // "/reload", "/compact all": a command the box knows runs as one (with images attached it is a message).
    const cmd = !images.length ? parseSlash(text) : null;
    if (cmd && onCommand && commands.some((c) => c.id === cmd.id)) {
      onCommand(cmd.id, cmd.args);
      return;
    }
    // A typed reply while one question is open is the answer to it.
    if (question && onAnswer && question.questions.length === 1 && text && !images.length) {
      onAnswer({ [question.questions[0].question]: text });
      return;
    }
    onSend(text, images);
  };
  return { draft, setDraft, images, setImages, submit };
}
