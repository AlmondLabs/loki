import { useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../../core/attention/content.ts";
import type { PendingQuestion } from "../../../core/attention/model.ts";
import type { Draft } from "../shared/drafts";
import { parseSlash, type SlashCommand } from "../../../core/attention/commands.ts";

export interface ControlledDraft {
  value: Draft;
  onChange: (next: Draft) => void;
}

interface SubmitContext {
  question: PendingQuestion | null;
  onAnswer?: (answers: Record<string, string | string[]>) => void;
  onSend: (text: string, images?: Attachment[]) => void;
  commands?: SlashCommand[];
  onCommand?: (id: string, args: string) => void;
  onSent?: () => void;
}

export function submitDraft(value: Draft, { question, onAnswer, onSend, commands = [], onCommand, onSent }: SubmitContext, clear: () => void): boolean {
  const text = value.text.trim();
  const images = value.images;
  if (!text && !images.length) return false;
  const cmd = !images.length ? parseSlash(text) : null;
  if (cmd && onCommand && commands.some((c) => c.id === cmd.id)) {
    clear();
    onCommand(cmd.id, cmd.args);
    return true;
  }
  if (question && onAnswer && question.questions.length === 1 && text && !images.length) onAnswer({ [question.questions[0].question]: text });
  else onSend(text, images);
  clear();
  onSent?.();
  return true;
}

export function draftWriter(latest: { current: Draft }, onChange: (next: Draft) => void) {
  const put = (patch: Partial<Draft>) => {
    latest.current = { ...latest.current, ...patch };
    onChange(latest.current);
  };
  return {
    setText: (text: string) => put({ text }),
    setImages: (images: Attachment[]) => put({ images }),
    clear: () => put({ text: "", images: [] }),
  };
}

export function useDraft({
  question,
  onAnswer,
  onSend,
  commands = [],
  onCommand,
  onSent,
  controlled,
}: SubmitContext & {
  controlled?: ControlledDraft;
}) {
  const [ownDraft, setOwnDraft] = useState("");
  const [ownImages, setOwnImages] = useState<Attachment[]>([]);
  const latest = useRef<Draft>(controlled?.value ?? { text: "", images: [] });
  useLayoutEffect(() => {
    if (controlled) latest.current = controlled.value;
  });
  const onChange = controlled?.onChange;

  const draft = controlled ? controlled.value.text : ownDraft;
  const images = controlled ? controlled.value.images : ownImages;
  const setDraft = (text: string) => (onChange ? draftWriter(latest, onChange).setText(text) : setOwnDraft(text));
  const setImages = (next: Attachment[]) => (onChange ? draftWriter(latest, onChange).setImages(next) : setOwnImages(next));
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
