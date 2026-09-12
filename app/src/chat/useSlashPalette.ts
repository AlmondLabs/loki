import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react";
import { matchCommands, slashQuery, type SlashCommand } from "../../../core/attention/commands.ts";

/**
 * The command palette over a message box, shared by the desk chat's footer (Composer) and the inbox
 * card's reply box: what it lists for the draft, which row is lit, and the keys the box hands it first —
 * ↑↓ move, ⇥ fills the name in, ↵ runs (or fills in a command that takes arguments), esc puts it away for
 * this draft. `aria` goes on the textarea so a screen reader follows the list.
 */
export function useSlashPalette({ draft, onDraft, commands, onCommand, inputRef }: { draft: string; onDraft: (text: string) => void; commands: SlashCommand[]; onCommand?: (id: string, args: string) => void; inputRef: RefObject<HTMLTextAreaElement | null> }) {
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
  const aria = {
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open && matches[index] ? `${listId}-opt-${index}` : undefined,
    "aria-expanded": open || undefined,
  };
  return { open, matches, index, setIndex, listId, pick, onKeyDown, aria };
}
