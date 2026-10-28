import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Field, Sheet } from "../components";
import { DESK_NAME_MAX, cleanDeskName } from "../shell/sidebar-model";
import type { CatchUp, Desk } from "../shell/types";
import type { DeskSummary } from "../../../core/frame-types.ts";

/** The props of the rename-chat dialog (`RenameDesk`). */
export interface RenameDeskProps {
  /** The desk's name now; the field starts on it, selected. */
  name: string;
  onClose: () => void;
  /** Save the cleaned name; resolves to the daemon's error, or null when it took. */
  onRename: (name: string) => Promise<string | null>;
  /** The chat's purpose line now (plan 047, R11); the second field starts on it. */
  purpose?: string | null;
  /** Save the purpose line, an empty one clearing it; left out, the dialog has no purpose field. */
  onPurpose?: (purpose: string) => Promise<string | null>;
}

/** What Save does in the rename dialog and sheet: the name when it changed, then the purpose when it changed; the first refusal, or null. */
export async function saveRename(
  { name, purpose }: { name: string | null; purpose: string | null },
  onRename: (name: string) => Promise<string | null>,
  onPurpose?: (purpose: string) => Promise<string | null>,
): Promise<string | null> {
  try {
    const renamed = name === null ? null : await onRename(name);
    if (renamed) return renamed;
    return purpose === null || !onPurpose ? null : await onPurpose(purpose);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The purpose line as it would be saved: one line, trimmed (the daemon cleans it the same way). */
export const cleanPurpose = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Slack's "Rename channel", for a desk: one field holding the current name, selected, so typing replaces it, and
 * under it the chat's one-line purpose, which agents read to know what the chat is for (plan 047, R11).
 * Enter saves, Esc cancels; Save waits for a name or a purpose that differs. A refusal shows under the field and the dialog
 * stays open to try again. Mounted only while open, so each opening starts from the desk's name; the Sheet puts
 * focus back where it was when it opened (the row or the header's menu button).
 */
export function RenameDesk({ name, onClose, onRename, purpose = null, onPurpose }: RenameDeskProps) {
  const [value, setValue] = useState(name);
  const [purposeValue, setPurposeValue] = useState(purpose ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  // After the Sheet has noted its opener (its own effect runs after this one), so focus can go back there.
  useEffect(() => {
    const t = setTimeout(() => fieldRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, []);

  const next = cleanDeskName(value);
  const nextPurpose = cleanPurpose(purposeValue);
  const renamed = !!next && next !== name.trim();
  const repurposed = !!onPurpose && nextPurpose !== (purpose ?? "");
  const canSave = !!next && (renamed || repurposed) && !busy;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const err = await saveRename({ name: renamed ? next : null, purpose: repurposed ? nextPurpose : null }, onRename, onPurpose);
    setBusy(false);
    if (!err) return onClose();
    setError(err);
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
  };

  const sheet = (
    <Sheet label="Rename chat" onClose={onClose} width={440} top="18vh">
      <div style={{ padding: "16px 18px 4px", display: "grid", gap: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--loki-fg)" }}>Rename chat</div>
        <Field
          ref={fieldRef}
          name="desk-name"
          aria-label="Chat name"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          spellCheck={false}
          maxLength={DESK_NAME_MAX}
          value={value}
          // read-only, not disabled, while saving: focus stays in the dialog, so Esc still reaches it
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "loki-rename-error" : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={onEnter}
        />
        {onPurpose && (
          <Field
            name="desk-purpose"
            aria-label="Chat purpose"
            placeholder="what this chat is for (agents read it)"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={purposeValue}
            readOnly={busy}
            onChange={(e) => {
              setPurposeValue(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter}
          />
        )}
        {error && (
          <div id="loki-rename-error" role="alert" style={{ color: "var(--loki-negative)", fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "12px 18px 16px", justifyContent: "flex-end" }}>
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" onClick={() => void save()} disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Sheet>
  );
  // Opened from the sidebar or the pane header, it would be laid out (and clipped) inside that column, and sit in
  // the header's window-drag strip; on the body the veil covers the whole window, as the shell's own sheets do.
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

/**
 * The purpose save both menus share (plan 047, R11): loki's daemon keeps the line, then the desks list is asked for
 * again so every header shows it.
 */
export function savePurpose(desk: Desk, catchUp: CatchUp) {
  return async (d: Pick<DeskSummary, "agent_id" | "conversation_id">, purpose: string): Promise<string | null> => {
    if (!d.conversation_id || !d.agent_id) return "this chat has no conversation to describe";
    const err = await catchUp.setPurpose({ agent_id: d.agent_id, conversation_id: d.conversation_id }, purpose);
    if (err) return err;
    desk.desks.request();
    return null;
  };
}

/** Without the link to loki's daemon there is nothing to write the name to; the menus say so on the disabled item. */
export const NO_RENAME_REASON = "Not connected";

/**
 * The save both menus share: loki's daemon renames the conversation, then the new name shows at once (the mod
 * only re-broadcasts titles at a turn's end) and the desks list is asked for again, as archive does.
 */
export function renameDesk(desk: Desk, catchUp: CatchUp, notice: (m: string) => void) {
  return async (d: Pick<DeskSummary, "scope" | "conversation_id">, name: string): Promise<string | null> => {
    if (!d.conversation_id) return "this chat has no conversation to rename";
    const err = await catchUp.renameConversation(d.conversation_id, name);
    if (err) return err;
    desk.setDeskTitle(d.scope, name);
    desk.desks.request();
    notice(`Renamed to ${name}`);
    return null;
  };
}
