import { useEffect, useState } from "react";
import { Button, Chip, Sheet } from "../components";
import { folderName, shownFolders } from "./newChatFolders";

/** Home shortened to ~, for reading. */
const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/**
 * The phone's Change folder: the folders this chat's agent has worked in on the Mac, as chips (New chat's), the
 * chat's own folder lit; Move waits for another one. Letta Code moves the chat and tells the agent on its next
 * turn that the working directory changed. A refusal shows under the chips and the sheet stays. Browsing any
 * folder on the Mac is the desktop's (the phone is not given the Mac's disk).
 */
export function FolderSheet({ load, onMove, onClose }: { load: () => Promise<{ current: string | null; choices: string[] }>; onMove: (folder: string) => Promise<string | null>; onClose: () => void }) {
  const [state, setState] = useState<{ current: string | null; choices: string[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((s) => live && setState(s))
      .catch(() => live && setState({ current: null, choices: [] }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The chat's own folder is always a chip, first when the agent's list does not have it.
  const folders = state ? (state.current && !state.choices.includes(state.current) ? [state.current, ...state.choices] : state.choices) : [];
  const lit = picked ?? state?.current ?? null;
  const shown = shownFolders(folders, lit, all);
  const canMove = !!picked && picked !== state?.current && !busy;
  const move = async () => {
    if (!canMove || !picked) return;
    setBusy(true);
    setError(null);
    let err: string | null;
    try {
      err = await onMove(picked);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    setBusy(false); // after either branch: the catch cannot throw, so no finally (the React Compiler cannot take one)
    if (err) setError(err);
    else onClose();
  };
  return (
    <Sheet label="Change folder" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-title">Change folder</div>
      {state === null ? (
        <p className="loki-phone-meta">Asking the Mac for folders…</p>
      ) : folders.length < 2 ? (
        <p className="loki-phone-meta loki-phone-wrap">{state.current ? `In ${shortPath(state.current)}. ` : ""}This agent has worked in no other folder; pick one on the Mac.</p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Folder" className="loki-phone-chips loki-phone-chips--wrap">
            {shown.map((f) => (
              <Chip key={f} touch role="radio" active={f === lit} aria-checked={f === lit} aria-label={shortPath(f)} onClick={() => (setPicked(f), setError(null))}>
                {folderName(f)}
              </Chip>
            ))}
            {!all && folders.length > shown.length && (
              <Chip touch onClick={() => setAll(true)}>
                {`More (${folders.length - shown.length})`}
              </Chip>
            )}
          </div>
          <p className="loki-phone-meta loki-phone-wrap">{lit ? `${lit === state.current ? "Now in" : "Move to"} ${shortPath(lit)}` : ""}</p>
        </>
      )}
      {error && (
        <p role="alert" className="loki-phone-error">
          {error}
        </p>
      )}
      <Button size="touch" tone="positive" block disabled={!canMove} onClick={() => void move()}>
        {busy ? "Moving…" : "Move"}
      </Button>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}
