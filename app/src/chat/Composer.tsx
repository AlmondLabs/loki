import type { RefObject } from "react";
import { useSlashPalette } from "./useSlashPalette";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { PendingQuestion } from "../../../core/attention/model.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import { Button } from "../components";
import { ChatInput } from "./ChatInput";
import { SlashPalette } from "./SlashPalette";
import { EffortChip, EffortMenu, ModelChip, ModelPicker, effortEntriesFor, type ModelEntry } from "./ModelPicker";
import { selectionOf, type ReasoningEffort } from "../../../core/models.ts";
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
  reasoningEffort = null,
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
  reasoningEffort?: ReasoningEffort | null;
  models?: ModelEntry[] | null;
  mode?: string | null;
  hasModelPicker?: boolean;
  hasModeMenu?: boolean;
  controls?: ModelAndMode;
}) {
  const currentMode = isPermissionMode(mode) ? mode : null;
  const effortEntries = effortEntriesFor(models ?? [], model);
  const hasEffortPicker = effortEntries.length > 1;
  const hasContent = !!draft.trim() || images.length > 0;
  const palette = useSlashPalette({ draft, onDraft, commands, onCommand, inputRef });

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8, padding: "12px 12px 10px", borderTop: "1px solid var(--loki-border)" }}>
      {palette.open && <SlashPalette matches={palette.matches} index={palette.index} listId={palette.listId} onHover={palette.setIndex} onPick={palette.pick} />}
      <ChatInput
        ref={inputRef}
        value={draft}
        onChange={onDraft}
        onSubmit={onSubmit}
        onKeyDown={palette.onKeyDown}
        onEscape={() => inputRef.current?.blur()}
        images={images}
        onImages={onImages}
        placeholder={composerPlaceholder(question, status, agentName)}
        {...palette.aria}
      />
      {/* The chips on the left with their popovers hung above this row; the status word and send on the right. */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {controls && hasModelPicker && <ModelChip model={model} busy={controls.switching} onClick={controls.togglePicker} />}
        {controls && <ModelPicker open={controls.pickerOpen} side="above" current={model} currentEffort={reasoningEffort} entries={models} loading={!models} onPick={(selection) => void controls.pickModel(selection)} onClose={controls.closePicker} />}
        {controls && hasModelPicker && hasEffortPicker && (
          <>
            <EffortChip effort={reasoningEffort} busy={controls.changingEffort} onClick={controls.toggleEffort} />
            <EffortMenu open={controls.effortOpen} side="above" entries={effortEntries} current={reasoningEffort} onPick={(entry) => void controls.pickEffort(selectionOf(entry))} onClose={controls.closeEffort} />
          </>
        )}
        {controls && hasModeMenu && <ModeChip mode={currentMode} busy={controls.changingMode} onClick={controls.toggleMode} />}
        {controls && <ModeMenu open={controls.modeOpen} side="above" current={currentMode} onPick={(m) => void controls.pickMode(m)} onClose={controls.closeMode} />}
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
