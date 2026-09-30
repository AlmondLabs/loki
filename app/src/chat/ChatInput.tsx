import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { dictateTitle, useDictation } from "./useDictation";
import { discardUpload, droppedFiles, fileSize, imageFromBlob, isInlineImage, uploadFile } from "./attachments";
import { isFileAttachment, type Attachment, type ImageAttachment } from "../../../core/attention/content.ts";
import { Dot, IconButton, TextArea } from "../components";
import { Icon } from "../shared/icons";
import { cmdHeld } from "../shell/keymap";

/** "what was typed" + "what was heard", one space between, no trailing space carried over. */
const join = (a: string, b: string) => (a && b ? `${a.replace(/\s+$/, "")} ${b}` : a || b);

/**
 * The message box, one for the phone and the desktop (2026-09-24, after Claude's): one rounded field with the
 * text on top and a row inside it — "+" to attach images, the host's tools (the model pill), then the mic and
 * send at the end. Enter sends, Shift+Enter inserts a newline, the text grows with its content up to ~6 lines.
 * The mic (or ⌘D while focused) dictates into the same box; recognition stops by itself after a pause, then
 * Enter (or send) sends as usual. Images come in by paste, drop or "+".
 */
export const ChatInput = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    /** First look at a key; return true to claim it (the command palette takes arrows, tab, enter, esc while open). */
    onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    onEscape?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    /**
     * Images and files attached to the draft; the host sends them with the text. Images ride inside the message;
     * any other file is uploaded to the Mac as soon as it is added and goes as its path. Without onImages there is no "+".
     */
    images?: Attachment[];
    onImages?: (images: Attachment[]) => void;
    placeholder?: string;
    disabled?: boolean;
    /** The phone's sizes: 36 in the row (each with a 44 target), 15px text. */
    touch?: boolean;
    /** In the row after "+": the model pill. */
    tools?: ReactNode;
    /** Something to send (text or an image); send is disabled without it. */
    canSend: boolean;
    /** Send's name: "Send", or what happens mid-turn (it queues). */
    sendLabel: string;
    sendTitle?: string;
    /** The agent is working: with nothing typed, send becomes Stop, which ends the turn so you can take over. Typed text still sends (it queues). */
    onStop?: () => void;
    /** A stop was asked for and the turn has not ended yet. */
    stopping?: boolean;
    "aria-controls"?: string;
    "aria-activedescendant"?: string;
    "aria-expanded"?: boolean;
  }
>(function ChatInput({ value, onChange, onSubmit, onKeyDown, onEscape, onFocus, onBlur, images = [], onImages, placeholder, disabled, touch = false, tools, canSend, sendLabel, sendTitle, onStop, stopping = false, ...aria }, ref) {
  // The latest list, for uploads that finish after the draft moved on.
  const imagesRef = useRef(images);
  useLayoutEffect(() => {
    imagesRef.current = images;
  }, [images]);
  const uploadCount = useRef(0);
  /** Files still on their way to the Mac, with how far along; a failed one stays with its reason until removed. */
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; share: number; error?: string }>>([]);
  const upload = (file: File) => {
    const id = `up-${++uploadCount.current}`;
    setUploads((u) => [...u, { id, name: file.name || "file", share: 0 }]);
    uploadFile(file, (share) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, share } : x))))
      .then((done) => {
        setUploads((u) => u.filter((x) => x.id !== id));
        onImages?.([...imagesRef.current, done]);
      })
      .catch((err: unknown) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: err instanceof Error ? err.message : String(err) } : x))));
  };
  const addFiles = async (picked: { images: Blob[]; files: File[] }) => {
    if (!onImages) return;
    for (const f of picked.files) upload(f);
    if (!picked.images.length) return;
    const added = await Promise.all(picked.images.map((b) => imageFromBlob(b).catch(() => null)));
    // An image this browser cannot draw (HEIC outside Safari) still goes, as a file.
    picked.images.forEach((b, i) => {
      if (!added[i] && b instanceof File) upload(b);
    });
    onImages([...imagesRef.current, ...added.filter((a): a is ImageAttachment => !!a)]);
  };
  const remove = (a: Attachment) => {
    onImages?.(imagesRef.current.filter((i) => i.id !== a.id));
    if (isFileAttachment(a)) discardUpload(a.path);
  };
  const uploading = uploads.some((u) => !u.error);
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };

  // What was in the box before dictation (plus finished phrases); interim words sit after it.
  const base = useRef(value);
  const [interim, setInterim] = useState("");
  const interimRef = useRef("");
  /** Enter was pressed while listening: the message is gone, so late results from the recogniser must not refill the box. */
  const discarding = useRef(false);
  const dictation = useDictation({
    onInterim: (text) => {
      if (discarding.current) return;
      if (!text && !interimRef.current) return; // nothing to clear (recognition ended quietly)
      interimRef.current = text;
      setInterim(text);
      onChange(join(base.current, text));
    },
    onFinal: (text) => {
      if (discarding.current) return;
      base.current = join(base.current, text);
      interimRef.current = "";
      setInterim("");
      onChange(base.current);
    },
  });
  const typed = (v: string) => {
    base.current = v; // typing while listening: keep what the user wrote
    setInterim("");
    onChange(v);
  };
  const startDictation = () => {
    base.current = value;
    dictation.toggle();
    inner.current?.focus();
  };
  /** Enter or the send button: a dictation still running ends here, and what it still emits is dropped. */
  const send = () => {
    if (uploading) return; // the file would be left behind: send waits for it (the button says so)
    if (dictation.listening || dictation.pending) {
      discarding.current = true; // whatever the recogniser still emits belongs to the sent message
      base.current = "";
      interimRef.current = "";
      setInterim("");
      dictation.stop();
    }
    onSubmit();
  };
  useEffect(() => {
    if (!dictation.listening) {
      base.current = value; // sends/clears outside dictation reset the base
      discarding.current = false;
    }
  }, [value, dictation.listening]);

  // Grow to fit, capped; shrink back when cleared. Measured before paint, and with the box held at its height while
  // the field is collapsed to read its scrollHeight: otherwise the thread above grows for that instant, WebKit pulls
  // its scroll offset back to fit, and following the bottom pushes it down again — the thread twitched per keystroke.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // Empty: one line even when the placeholder would wrap.
    if (!value) {
      el.style.height = "";
      return;
    }
    const box = el.parentElement;
    const held = box?.style.minHeight ?? "";
    if (box) box.style.minHeight = `${box.offsetHeight}px`;
    el.style.height = "0px";
    const next = `${Math.min(el.scrollHeight, 6 * 20 + 12)}px`;
    el.style.height = next;
    if (box) box.style.minHeight = held;
  }, [value]);

  const listening = dictation.listening;
  return (
    <div className="loki-composer-box" data-listening={listening || undefined}>
      {(images.length > 0 || uploads.length > 0) && (
        <div data-attachments className="loki-composer-images">
          {images.map((a) =>
            isFileAttachment(a) ? (
              <span key={a.id} className="loki-file-chip" title={a.path}>
                <Icon name="file" size={16} />
                <span className="loki-file-chip-name">{a.name}</span>
                <span className="loki-file-chip-size">{fileSize(a.size)}</span>
                <button type="button" className="loki-file-chip-remove" onClick={() => remove(a)} aria-label={`Remove ${a.name}`}>
                  ×
                </button>
              </span>
            ) : (
              <span key={a.id} style={{ position: "relative", display: "inline-block" }}>
                <img src={a.url} alt="" style={{ height: 56, maxWidth: 120, objectFit: "cover", borderRadius: "var(--loki-radius-sm)", border: "1px solid var(--loki-border)", display: "block" }} />
                <button
                  type="button"
                  onClick={() => remove(a)}
                  aria-label="Remove image"
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: "1px solid var(--loki-border)", background: "var(--loki-panel)", color: "var(--loki-fg)", fontSize: 10.5, lineHeight: "16px", cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
              </span>
            ),
          )}
          {uploads.map((u) => (
            <span key={u.id} className="loki-file-chip" data-failed={u.error ? true : undefined} title={u.error}>
              <Icon name="file" size={16} />
              <span className="loki-file-chip-name">{u.name}</span>
              <span className="loki-file-chip-size">{u.error ? "failed" : `${Math.round(u.share * 100)}%`}</span>
              {u.error && (
                <button type="button" className="loki-file-chip-remove" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))} aria-label={`Remove ${u.name}`}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {uploads.find((u) => u.error) && (
        <span role="status" className="loki-meta loki-meta--negative loki-file-error">
          {uploads.find((u) => u.error)!.name}: {uploads.find((u) => u.error)!.error}
        </span>
      )}
      <TextArea
        ref={setRef}
        className="loki-composer-text"
        value={value}
        rows={1}
        name="message"
        // iCloud Passwords ignores autocomplete=off but skips textareas that declare themselves a
        // search field (type/inputmode/enterkeyhint "search"). `type` is inert on a textarea, so
        // it costs nothing in the browser and stops the credential popup on a chat box.
        {...({ type: "search" } as object)}
        autoComplete="off"
        autoCorrect="on"
        spellCheck
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        disabled={disabled}
        placeholder={listening ? "listening… pause to finish, enter to send" : dictation.pending ? "waiting for the microphone…" : placeholder}
        aria-describedby={dictation.error ? "loki-dictation-error" : undefined}
        onChange={(e) => typed(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={(e) => {
          const picked = droppedFiles(e.clipboardData);
          if (onImages && (picked.images.length || picked.files.length)) {
            e.preventDefault(); // the file, not its name
            void addFiles(picked);
          }
        }}
        onDragOver={(e) => {
          if (onImages && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          const picked = droppedFiles(e.dataTransfer);
          if (onImages && (picked.images.length || picked.files.length)) {
            e.preventDefault();
            void addFiles(picked);
          }
        }}
        {...aria}
        onKeyDown={(e) => {
          if (onKeyDown?.(e)) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape" && onEscape) {
            e.preventDefault();
            onEscape();
          } else if (e.key.toLowerCase() === "d" && cmdHeld(e) && !e.altKey && !e.shiftKey && dictation.supported) {
            // ⌘D dictates (Ctrl+D off the Mac). (⌘M is minimise on a Mac and stays that way.)
            e.preventDefault();
            startDictation();
          }
        }}
      />
      <ComposerBar
        touch={touch}
        attach={onImages ? { onClick: () => picker.current?.click() } : null}
        tools={tools}
        dictation={dictation.supported ? { listening, pending: dictation.pending, title: listening ? "stop dictating" : dictateTitle(), onToggle: startDictation } : null}
        canSend={canSend && !uploading}
        sendLabel={uploading ? "Uploading…" : sendLabel}
        sendTitle={sendTitle}
        onSend={send}
        stop={onStop && !canSend ? { onStop, stopping } : null}
        disabled={disabled}
      />
      {onImages && (
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const all = Array.from(e.target.files ?? []);
            e.target.value = ""; // the same file can be picked again
            void addFiles({ images: all.filter(isInlineImage), files: all.filter((f) => !isInlineImage(f)) });
          }}
        />
      )}
      {dictation.error && (
        <span id="loki-dictation-error" role="status" className="loki-meta loki-meta--negative" style={{ position: "absolute", left: 12, bottom: "100%", marginBottom: 6 }}>
          {dictation.error}
        </span>
      )}
      {interim && <span className="sr-only" aria-live="polite">{interim}</span>}
    </div>
  );
});

/**
 * The box's bottom row, one height throughout (28 on the desktop, 36 on the phone): "+" and the host's tools on
 * the left; the mic (only where dictation works) and the round send at the end, green once there is something
 * to send (Slack's send), a muted circle while the box is empty.
 */
export function ComposerBar({
  touch = false,
  attach,
  tools,
  dictation,
  canSend,
  sendLabel,
  sendTitle,
  onSend,
  stop = null,
  disabled,
}: {
  touch?: boolean;
  attach: { onClick: () => void } | null;
  tools?: ReactNode;
  dictation: { listening: boolean; pending: boolean; title: string; onToggle: () => void } | null;
  canSend: boolean;
  sendLabel: string;
  sendTitle?: string;
  onSend: () => void;
  /** In send's place while the agent works and nothing is typed. */
  stop?: { onStop: () => void; stopping: boolean } | null;
  disabled?: boolean;
}) {
  const size = touch ? 36 : 28;
  const glyph = touch ? 20 : 16;
  return (
    <div className="loki-composer-bar">
      {attach && (
        <IconButton size={size} hairline label="Attach files" onClick={attach.onClick} disabled={disabled} className="loki-composer-round loki-composer-attach">
          <Icon name="plus" size={glyph} />
        </IconButton>
      )}
      {tools}
      <span className="loki-composer-end">
        {dictation && (
          <IconButton size={size} tone={dictation.listening || dictation.pending ? "brass" : "quiet"} onClick={dictation.onToggle} disabled={disabled} label={dictation.listening ? "Stop dictating" : "Dictate"} aria-pressed={dictation.listening} title={dictation.title} className="loki-composer-round">
            <Icon name="mic" size={glyph} />
            {dictation.listening && <Dot pulse size={6} color="var(--loki-accent)" aria-hidden style={{ position: "absolute", top: 3, right: 3 }} />}
          </IconButton>
        )}
        {stop ? (
          <IconButton size={size} onClick={stop.onStop} disabled={stop.stopping} label={stop.stopping ? "Stopping" : "Stop"} title={stop.stopping ? "stopping…" : "stop the agent's turn"} className="loki-composer-round loki-composer-stop">
            <Icon name="stop" size={glyph} />
          </IconButton>
        ) : (
          <IconButton size={size} tone={canSend ? "positive" : "quiet"} onClick={onSend} disabled={disabled || !canSend} label={sendLabel} title={sendTitle ?? sendLabel} className="loki-composer-round loki-composer-send">
            <Icon name="send" size={glyph} />
          </IconButton>
        )}
      </span>
    </div>
  );
}
