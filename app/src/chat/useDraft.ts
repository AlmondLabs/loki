import { useLayoutEffect, useRef, useState } from "react";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { PendingQuestion } from "../../../core/attention/model.ts";
import { parseSlash, type SlashCommand } from "../../../core/attention/commands.ts";

/** What is in the box: the text and the images pasted, dropped or picked in. */
export type DraftValue = { text: string; images: ImageAttachment[] };

/**
 * A draft the host keeps (the phone's per-conversation store, shared by an Inbox card and the desk page),
 * instead of the box's own state. `value` is read on every render; `onChange` gets the whole next draft,
 * an empty one after a send.
 */
export interface ControlledDraft {
  value: DraftValue;
  onChange: (next: DraftValue) => void;
}

type SubmitContext = {
  question: PendingQuestion | null;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
  onSent?: () => void;
};

/**
 * What submitting a draft does, apart from React: nothing when it is empty; otherwise a known "/command"
 * runs as one, a typed reply while one question is open answers it, and anything else goes to the agent —
 * then `clear` (only this draft — the host's clear knows which). A send or answer that throws keeps the
 * draft for another try. True when something went.
 */
export function submitDraft(value: DraftValue, { question, onAnswer, onSend, commands = [], onCommand, onSent }: SubmitContext, clear: () => void): boolean {
  const text = value.text.trim();
  const images = value.images;
  if (!text && !images.length) return false;
  // "/reload", "/compact all": a command the box knows runs as one (with images attached it is a message).
  const cmd = !images.length ? parseSlash(text) : null;
  if (cmd && onCommand && commands.some((c) => c.id === cmd.id)) {
    clear(); // first, as before: a command may open something that writes to the box
    onCommand(cmd.id, cmd.args);
    return true;
  }
  // A typed reply while one question is open is the answer to it.
  if (question && onAnswer && question.questions.length === 1 && text && !images.length) onAnswer({ [question.questions[0].question]: text });
  else onSend(text, images);
  clear();
  onSent?.();
  return true;
}

/**
 * Writes to a host-kept draft. Each one merges onto the latest draft — the one just written, not the one
 * the last render saw — so an image that finishes decoding after the text changed, or a clear right after
 * a set, never brings back what was there before.
 */
export function draftWriter(latest: { current: DraftValue }, onChange: (next: DraftValue) => void) {
  const put = (patch: Partial<DraftValue>) => {
    latest.current = { ...latest.current, ...patch };
    onChange(latest.current);
  };
  return {
    setText: (text: string) => put({ text }),
    setImages: (images: ImageAttachment[]) => put({ images }),
    clear: () => put({ text: "", images: [] }),
  };
}

/**
 * The message being typed: its text, the images pasted or dropped in, and the send.
 * Submitting sends, then clears the box; a typed reply while one question is open is the
 * answer to it, a known "/command" runs as one, anything else goes to the agent.
 * With `controlled` the host keeps the draft (see ControlledDraft); without it, the box does, as before.
 */
export function useDraft({
  question,
  onAnswer,
  onSend,
  commands = [],
  onCommand,
  onSent,
  controlled,
}: SubmitContext & {
  /** The host's draft; omitted, the box keeps its own. */
  controlled?: ControlledDraft;
}) {
  const [ownDraft, setOwnDraft] = useState("");
  const [ownImages, setOwnImages] = useState<ImageAttachment[]>([]);
  // The latest host draft, for writes that land after the render that made them (see draftWriter).
  const latest = useRef<DraftValue>(controlled?.value ?? { text: "", images: [] });
  useLayoutEffect(() => {
    if (controlled) latest.current = controlled.value;
  });
  const onChange = controlled?.onChange;

  const draft = controlled ? controlled.value.text : ownDraft;
  const images = controlled ? controlled.value.images : ownImages;
  // The host's writer is made when a write happens, not during render: it reads the ref.
  const setDraft = (text: string) => (onChange ? draftWriter(latest, onChange).setText(text) : setOwnDraft(text));
  const setImages = (next: ImageAttachment[]) => (onChange ? draftWriter(latest, onChange).setImages(next) : setOwnImages(next));
  const submit = () => {
    submitDraft({ text: draft, images }, { question, onAnswer, onSend, commands, onCommand, onSent }, () => {
      if (onChange) draftWriter(latest, onChange).clear();
      else {
        setOwnDraft("");
        setOwnImages([]);
      }
    });
  };
  return { draft, setDraft, images, setImages, submit };
}
