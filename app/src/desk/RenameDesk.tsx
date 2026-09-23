import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Field, Sheet } from "../components";
import { DESK_NAME_MAX, cleanDeskName } from "../shell/sidebarModel";
import type { CatchUp, Desk } from "../shell/types";
import type { DeskSummary } from "./useDesk";

export interface RenameDeskProps {
  /** The desk's name now; the field starts on it, selected. */
  name: string;
  onClose: () => void;
  /** Save the cleaned name; resolves to the app-server's error, or null when it took. */
  onRename: (name: string) => Promise<string | null>;
}

/**
 * Slack's "Rename channel", for a desk: one field holding the current name, selected, so typing replaces it.
 * Enter saves, Esc cancels; Save waits for a name that differs. A refusal shows under the field and the dialog
 * stays open to try again. Mounted only while open, so each opening starts from the desk's name; the Sheet puts
 * focus back where it was when it opened (the row or the header's menu button).
 */
export function RenameDesk({ name, onClose, onRename }: RenameDeskProps) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  // After the Sheet has noted its opener (its own effect runs after this one), so focus can go back there.
  useEffect(() => {
    const t = setTimeout(() => fieldRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, []);

  const next = cleanDeskName(value);
  const canSave = !!next && next !== name.trim() && !busy;
  const save = async () => {
    if (!canSave || !next) return;
    setBusy(true);
    setError(null);
    let err: string | null;
    try {
      err = await onRename(next);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      setBusy(false);
    }
    if (!err) return onClose();
    setError(err);
  };

  const sheet = (
    <Sheet label="Rename desk" onClose={onClose} width={440} top="18vh">
      <div style={{ padding: "16px 18px 4px", display: "grid", gap: 12 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--loki-fg)" }}>Rename desk</div>
        <Field
          ref={fieldRef}
          name="desk-name"
          aria-label="Desk name"
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
        />
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

/** Without the app-server there is nothing to write the name to; the menus say so on the disabled item. */
export const NO_RENAME_REASON = "Not connected";

/**
 * The save both menus share: the app-server renames the conversation, then the new name shows at once (the mod
 * only re-broadcasts titles at a turn's end) and the desks list is asked for again, as archive does.
 */
export function renameDesk(desk: Desk, catchUp: CatchUp, notice: (m: string) => void) {
  return async (d: Pick<DeskSummary, "scope" | "conversationId">, name: string): Promise<string | null> => {
    if (!d.conversationId) return "this desk has no conversation to rename";
    const err = await catchUp.renameConversation(d.conversationId, name);
    if (err) return err;
    desk.setDeskTitle(d.scope, name);
    desk.desks.request();
    notice(`Renamed to ${name}`);
    return null;
  };
}
