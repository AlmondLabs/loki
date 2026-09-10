import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import type { PendingQuestion } from "../../../packages/core/src/attention/model.ts";
import { matchCommands, slashQuery, type SlashCommand } from "../../../packages/core/src/attention/commands.ts";
import { Button } from "../components";
import { ChatInput } from "./ChatInput";
import { SlashPalette } from "./SlashPalette";
import { ModelChip, ModelPicker, type ModelEntry } from "./ModelPicker";
import { ModeChip, ModeMenu, isPermissionMode } from "./PermissionMode";
import type { ModelAndMode } from "./useModelAndMode";
import type { ChatStatus } from "./ChatWindow";

/**
 * The footer: the message box, and under it the conversation's switchers (model, permission mode, each
 * with its popover opening upward), the status word and the send button, which reads "queue" while
 * the agent is mid-turn. The chips only appear when the host can act on them. A draft that starts
 * with "/" opens the command palette above the box (see SlashPalette); the box keeps focus and this
 * component routes its arrow, tab, enter and escape keys.
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
  model = null,
  models = null,
  mode = null,
  hasModelPicker = false,
  hasModeMenu = false,
  controls,
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
  /** The conversation's model and mode, whether each can be changed here, and the switchers' state. */
  model?: string | null;
  models?: ModelEntry[] | null;
  mode?: string | null;
  hasModelPicker?: boolean;
  hasModeMenu?: boolean;
  controls?: ModelAndMode;
}) {
  const currentMode = isPermissionMode(mode) ? mode : null;
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
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8, padding: "12px 12px 10px", borderTop: "1px solid var(--loki-border)" }}>
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
      {/* The chips on the left with their popovers hung above this row; the status word and send on the right. */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {controls && hasModelPicker && <ModelChip model={model} busy={controls.switching} onClick={controls.togglePicker} />}
        {controls && hasModeMenu && <ModeChip mode={currentMode} busy={controls.changingMode} onClick={controls.toggleMode} />}
        {controls && <ModeMenu open={controls.modeOpen} side="above" current={currentMode} onPick={(m) => void controls.pickMode(m)} onClose={controls.closeMode} />}
        {controls && <ModelPicker open={controls.pickerOpen} side="above" current={model} entries={models} loading={!models} onPick={(h) => void controls.pickModel(h)} onClose={controls.closePicker} />}
        <span className="loki-label" style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--loki-muted)", opacity: 0.7, whiteSpace: "nowrap" }}>{statusWord(status)}</span>
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
    </div>
  );
}

function statusWord(status: ChatStatus): string {
  if (status === "thinking") return "thinking…";
  if (status === "streaming") return "replying…";
  return "";
}

/** What the empty box says: answer the open question, or message the agent, with a note when it will queue. */
export function composerPlaceholder(question: PendingQuestion | null, status: ChatStatus, agentName: string | null | undefined): string {
  if (question) return question.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…";
  const who = agentName ?? "the agent";
  return status === "idle" ? `message ${who}… (⇧↵ for a new line)` : `message ${who}… it goes when this turn ends`;
}
