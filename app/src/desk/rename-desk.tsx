import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Field, Sheet } from "../components";
import { DESK_NAME_MAX, cleanDeskName } from "../shell/sidebar-model";
import type { CatchUp, Desk } from "../shell/types";
import type { DeskSummary } from "../../../core/frame-types.ts";
import { messageOf } from "../../../core/errors.ts";

export interface RenameDeskProps {
  name: string;
  onClose: () => void;
  onRename: (name: string) => Promise<string | null>;
  purpose?: string | null;
  onPurpose?: (purpose: string) => Promise<string | null>;
}

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
    return messageOf(e);
  }
}

export const cleanPurpose = (value: string): string => value.replace(/\s+/g, " ").trim();

export function RenameDesk({ name, onClose, onRename, purpose = null, onPurpose }: RenameDeskProps) {
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
    let err: string | null;
    try {
      err = await saveRename({ name: renamed ? next : null, purpose: repurposed ? nextPurpose : null }, onRename, onPurpose);
    } finally {
      setBusy(false);
    }
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
      <div className="grid gap-3" style={{ padding: "16px 16px 4px" }}>
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>Rename chat</div>
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
          // Outside (HTML): a disabled field loses the focus, so while saving it is read-only and Esc still reaches the dialog.
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
            placeholder="What this chat is for (agents read it)"
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
          <div id="loki-rename-error" role="alert" style={{ color: "var(--loki-negative)", fontSize: "var(--text-xs)" }}>
            {error}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2" style={{ padding: "12px 16px 16px" }}>
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" onClick={() => void save()} disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

export function savePurpose(desk: Desk, catchUp: CatchUp) {
  return async (d: Pick<DeskSummary, "agent_id" | "conversation_id">, purpose: string): Promise<string | null> => {
    if (!d.conversation_id || !d.agent_id) return "this chat has no conversation to describe";
    const err = await catchUp.setPurpose({ agent_id: d.agent_id, conversation_id: d.conversation_id }, purpose);
    if (err) return err;
    desk.desks.request();
    return null;
  };
}

export const NO_RENAME_REASON = "Not connected";

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
