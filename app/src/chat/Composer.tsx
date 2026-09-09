import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import type { PendingQuestion } from "../../../packages/core/src/attention/model.ts";
import { matchCommands, slashQuery, type SlashCommand } from "../../../packages/core/src/attention/commands.ts";
import { Button } from "../ui";
import { ChatInput } from "./ChatInput";
import { SlashPalette } from "./SlashPalette";
import type { ChatStatus } from "./ChatWindow";

/**
 * The footer row: the message box and the send button, which reads "queue" while the agent is
 * mid-turn. A draft that starts with "/" opens the command palette above the box (see SlashPalette);
 * the box keeps focus and this component routes its arrow, tab, enter and escape keys.
 */
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
  commands = [],
  onCommand,
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
  /** The slash commands the box offers; empty hides the palette. */
  commands?: SlashCommand[];
  /** Run one (from the palette, before the draft has caught up). */
  onCommand?: (id: string, args: string) => void;
}) {
  const hasContent = !!draft.trim() || images.length > 0;
  const query = slashQuery(draft);
  const [index, setIndex] = useState(0);
  /** Esc put the palette away for this draft; typing brings it back. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const matches = query !== null && commands.length && dismissed !== draft ? matchCommands(query, commands) : [];
  const open = query !== null && dismissed !== draft && commands.length > 0;
  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [open, index, listId]);

  const pick = (c: SlashCommand) => {
    if (c.args) {
      onDraft(`/${c.id} `); // it takes arguments: fill the name in and keep typing
      inputRef.current?.focus();
      return;
    }
    onDraft("");
    onCommand?.(c.id, "");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (matches.length) setIndex((i) => (e.key === "ArrowDown" ? Math.min(matches.length - 1, i + 1) : Math.max(0, i - 1)));
      return true;
    }
    if (e.key === "Tab" && matches[index]) {
      e.preventDefault();
      onDraft(`/${matches[index].id}${matches[index].args ? " " : ""}`);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && matches[index]) {
      e.preventDefault();
      pick(matches[index]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(draft);
      return true;
    }
    return false;
  };

  return (
    <div style={{ position: "relative", display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loki-border)", alignItems: "flex-end" }}>
      {open && <SlashPalette matches={matches} index={index} listId={listId} onHover={setIndex} onPick={pick} />}
      <ChatInput
        ref={inputRef}
        value={draft}
        onChange={onDraft}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        onEscape={() => inputRef.current?.blur()}
        images={images}
        onImages={onImages}
        placeholder={composerPlaceholder(question, status, agentName)}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && matches[index] ? `${listId}-opt-${index}` : undefined}
        aria-expanded={open || undefined}
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
