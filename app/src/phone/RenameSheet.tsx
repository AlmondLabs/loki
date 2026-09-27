import { useEffect, useRef, useState } from "react";
import { Button, Field, Sheet } from "../components";
import { DESK_NAME_MAX, cleanDeskName } from "../shell/sidebarModel";

/**
 * The phone's Rename, as the desktop's RenameDesk: one field holding the name now, selected, so typing replaces
 * it. Return saves; Save waits for a name that differs. A refusal shows under the field and the sheet stays to
 * try again. Mounted only while open, so each opening starts from the desk's name.
 */
export function RenameSheet({ name, onRename, onClose }: { name: string; onRename: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
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
    }
    setBusy(false); // after either branch: the catch cannot throw, so no finally (the React Compiler cannot take one)
    if (err) setError(err);
    else onClose();
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
        />
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
