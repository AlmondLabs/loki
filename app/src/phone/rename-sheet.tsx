import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Field, Sheet } from "../components";
import { DESK_NAME_MAX, cleanDeskName } from "../shell/sidebar-model";
import { cleanPurpose, saveRename } from "../desk/rename-desk";

/**
 * The phone's Rename, as the desktop's RenameDesk: one field holding the name now, selected, so typing replaces
 * it, and under it the chat's one-line purpose when `onPurpose` is given (plan 047, R11). Return saves; Save waits
 * for a name or a purpose that differs. A refusal shows under the fields and the sheet stays to try again. Mounted
 * only while open, so each opening starts from the desk's name and purpose.
 */
export function RenameSheet({
  name,
  onRename,
  onClose,
  purpose = null,
  onPurpose,
}: {
  name: string;
  onRename: (name: string) => Promise<string | null>;
  onClose: () => void;
  /** The chat's purpose line now. */
  purpose?: string | null;
  /** Save the purpose line, an empty one clearing it; left out, the sheet has no purpose field. */
  onPurpose?: (purpose: string) => Promise<string | null>;
}) {
  const [value, setValue] = useState(name);
  const [purposeValue, setPurposeValue] = useState(purpose ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
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
    if (err) setError(err);
    else onClose();
  };
  // A form of two fields does not submit on Return by itself, so each field saves on it.
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
  };
  return (
    <Sheet label="Rename chat" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-title">Rename chat</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          ref={fieldRef}
          size="touch"
          name="desk-name"
          aria-label="Chat name"
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
          maxLength={DESK_NAME_MAX}
          value={value}
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={onEnter}
        />
        {onPurpose && (
          <Field
            size="touch"
            name="desk-purpose"
            aria-label="Chat purpose"
            placeholder="What this chat is for"
            enterKeyHint="done"
            autoComplete="off"
            value={purposeValue}
            readOnly={busy}
            onChange={(e) => {
              setPurposeValue(e.target.value);
              setError(null);
            }}
            onKeyDown={onEnter}
          />
        )}
      </form>
      {error && (
        <p role="alert" className="loki-phone-error">
          {error}
        </p>
      )}
      <Button size="touch" tone="positive" block disabled={!canSave} onClick={() => void save()}>
        {busy ? "Saving…" : "Save"}
      </Button>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}
