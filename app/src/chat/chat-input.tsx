import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { dictateTitle, useDictation } from "./use-dictation";
import { discardUpload, droppedFiles, fileSize, imageFromBlob, isInlineImage, uploadFile } from "./attachments";
import { isFileAttachment, type Attachment, type ImageAttachment } from "../../../core/attention/content.ts";
import { Dot, IconButton, TextArea } from "../components";
import { Icon } from "../shared/icons";
import { cmdHeld } from "../shell/keymap";
import { messageOf } from "../../../core/errors.ts";

const NO_IMAGES: Attachment[] = [];
function bindRef(ref: ForwardedRef<HTMLTextAreaElement>) {
  return (el: HTMLTextAreaElement | null) => {
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
}
const join = (a: string, b: string) => (a && b ? `${a.replace(/\s+$/, "")} ${b}` : a || b);

export interface MessageBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onEscape?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  images?: Attachment[];
  onImages?: (images: Attachment[]) => void;
  placeholder?: string;
  disabled?: boolean;
  touch?: boolean;
  tools?: ReactNode;
  canSend: boolean;
  sendLabel: string;
  sendTitle?: string;
  onStop?: () => void;
  stopping?: boolean;
  folded?: boolean;
  "aria-describedby"?: string;
  "aria-controls"?: string;
  "aria-activedescendant"?: string;
  "aria-expanded"?: boolean;
}

export function useMessageBox(
  { value, onChange, onSubmit, onKeyDown, onEscape, images = NO_IMAGES, onImages, placeholder }: MessageBoxProps,
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  const setRef = bindRef(ref);
  const imagesRef = useRef(images);
  useLayoutEffect(() => {
    imagesRef.current = images;
  }, [images]);
  const uploadCount = useRef(0);
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; share: number; error?: string }>>([]);
  const upload = (file: File) => {
    const id = `up-${++uploadCount.current}`;
    setUploads((u) => [...u, { id, name: file.name || "file", share: 0 }]);
    uploadFile(file, (share) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, share } : x))))
      .then((done) => {
        setUploads((u) => u.filter((x) => x.id !== id));
        onImages?.([...imagesRef.current, done]);
      })
      .catch((err: unknown) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: messageOf(err) } : x))));
  };
  const addFiles = async (picked: { images: Blob[]; files: File[] }) => {
    if (!onImages) return;
    for (const f of picked.files) upload(f);
    if (!picked.images.length) return;
    const added = await Promise.all(picked.images.map((b) => imageFromBlob(b).catch(() => null)));
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
  const failedUpload = uploads.find((u) => u.error);
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const base = useRef(value);
  const [interim, setInterim] = useState("");
  const interimRef = useRef("");
  const discarding = useRef(false);
  const dictation = useDictation({
    onInterim: (text) => {
      if (discarding.current) return;
      if (!text && !interimRef.current) return;
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
    base.current = v;
    setInterim("");
    onChange(v);
  };
  const startDictation = () => {
    base.current = value;
    dictation.toggle();
    inner.current?.focus();
  };
  const send = () => {
    if (uploading) return;
    if (dictation.listening || dictation.pending) {
      discarding.current = true;
      base.current = "";
      interimRef.current = "";
      setInterim("");
      dictation.stop();
    }
    onSubmit();
  };
  useEffect(() => {
    if (!dictation.listening) {
      base.current = value;
      discarding.current = false;
    }
  }, [value, dictation.listening]);

  // Grow to fit, capped; shrink back when cleared. Measured before paint, and with the box held at its height while
  // the field is collapsed to read its scrollHeight: otherwise the thread above grows for that instant, WebKit pulls
  // its scroll offset back to fit, and following the bottom pushes it down again — the thread twitched per keystroke.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
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
  const field = {
    ref: (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      setRef(el);
    },
    value,
    placeholder: listening ? "listening… pause to finish, enter to send" : dictation.pending ? "waiting for the microphone…" : placeholder,
    "aria-describedby": dictation.error ? "loki-dictation-error" : undefined,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => typed(e.target.value),
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const picked = droppedFiles(e.clipboardData);
      if (onImages && (picked.images.length || picked.files.length)) {
        e.preventDefault();
        void addFiles(picked);
      }
    },
    onDragOver: (e: DragEvent<HTMLTextAreaElement>) => {
      if (onImages && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
    },
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
      const picked = droppedFiles(e.dataTransfer);
      if (onImages && (picked.images.length || picked.files.length)) {
        e.preventDefault();
        void addFiles(picked);
      }
    },
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (onKeyDown?.(e)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape" && onEscape) {
        onEscape();
      } else if (e.key.toLowerCase() === "d" && cmdHeld(e) && !e.altKey && !e.shiftKey && dictation.supported) {
        e.preventDefault();
        startDictation();
      }
    },
  };
  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files ?? []);
    e.target.value = "";
    void addFiles({ images: all.filter(isInlineImage), files: all.filter((f) => !isInlineImage(f)) });
  };
  return {
    images,
    uploads,
    dismissUpload: (id: string) => setUploads((x) => x.filter((y) => y.id !== id)),
    uploading,
    failedUpload,
    remove,
    picker,
    dictation,
    listening,
    interim,
    startDictation,
    send,
    field,
    onPicked,
  };
}

export const ChatInput = forwardRef<HTMLTextAreaElement, MessageBoxProps>(function ChatInput(props, ref) {
  const {
    onFocus,
    onBlur,
    onImages,
    disabled,
    touch = false,
    tools,
    canSend,
    sendLabel,
    sendTitle,
    onStop,
    stopping = false,
    folded = false,
    onKeyDown: _k,
    onChange: _c,
    onSubmit: _s,
    onEscape: _e,
    value: _v,
    images: _i,
    placeholder: _p,
    ...aria
  } = props;
  const box = useMessageBox(props, ref);
  const { images, uploads, uploading, failedUpload, remove, picker, dictation, listening, interim, startDictation, send, field, onPicked } = box;
  return (
    <div className="loki-composer-box" data-listening={listening || undefined} data-folded={folded || undefined}>
      {!folded && (images.length > 0 || uploads.length > 0) && (
        <div data-attachments className="loki-composer-images">
          {images.map((a, i) =>
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
              <span key={a.id} className="inline-block" style={{ position: "relative" }}>
                <img
                  src={a.url}
                  alt=""
                  className="block"
                  style={{
                    height: 56,
                    maxWidth: 120,
                    objectFit: "cover",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--loki-border)",
                  }}
                />
                <IconButton
                  size={24}
                  hairline
                  label={`Remove Image ${i + 1}`}
                  onClick={() => remove(a)}
                  className="rounded-full bg-loki-panel"
                  style={{ position: "absolute", top: -8, right: -8 }}
                >
                  <Icon name="close" size={12} />
                </IconButton>
              </span>
            ),
          )}
          {uploads.map((u) => (
            <span key={u.id} className="loki-file-chip" data-failed={u.error ? true : undefined} title={u.error}>
              <Icon name="file" size={16} />
              <span className="loki-file-chip-name">{u.name}</span>
              <span className="loki-file-chip-size">{u.error ? "failed" : `${Math.round(u.share * 100)}%`}</span>
              {u.error && (
                <button type="button" className="loki-file-chip-remove" onClick={() => box.dismissUpload(u.id)} aria-label={`Remove ${u.name}`}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {failedUpload && (
        <span role="status" className="loki-meta loki-meta--negative loki-file-error">
          {failedUpload.name}: {failedUpload.error}
        </span>
      )}
      <TextArea
        className="loki-composer-text"
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
        onFocus={onFocus}
        onBlur={onBlur}
        {...aria}
        {...field}
      />
      {folded && onStop && !canSend && (
        <IconButton
          size={36}
          onClick={onStop}
          disabled={stopping}
          label={stopping ? "Stopping" : "Stop"}
          title={stopping ? "Stopping…" : "Stop the agent's turn"}
          className="loki-composer-round loki-composer-stop"
        >
          <Icon name="stop" size={20} />
        </IconButton>
      )}
      {!folded && (
        <ComposerBar
          touch={touch}
          attach={onImages ? { onClick: () => picker.current?.click() } : null}
          tools={tools}
          dictation={
            dictation.supported
              ? { listening, pending: dictation.pending, title: listening ? "stop dictating" : dictateTitle(), onToggle: startDictation }
              : null
          }
          canSend={canSend && !uploading}
          sendLabel={uploading ? "Uploading…" : sendLabel}
          sendTitle={sendTitle}
          onSend={send}
          stop={onStop && !canSend ? { onStop, stopping } : null}
          disabled={disabled}
        />
      )}
      {onImages && <input ref={picker} type="file" multiple hidden onChange={onPicked} />}
      {dictation.error && (
        <span
          id="loki-dictation-error"
          role="status"
          className="loki-meta loki-meta--negative"
          style={{ position: "absolute", left: 12, bottom: "100%", marginBottom: 4 }}
        >
          {dictation.error}
        </span>
      )}
      {interim && (
        <span className="sr-only" aria-live="polite">
          {interim}
        </span>
      )}
    </div>
  );
});

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
          <IconButton
            size={size}
            tone={dictation.listening || dictation.pending ? "brass" : "quiet"}
            onClick={dictation.onToggle}
            disabled={disabled}
            label={dictation.listening ? "Stop dictating" : "Dictate"}
            aria-pressed={dictation.listening}
            title={dictation.title}
            className="loki-composer-round"
          >
            <Icon name="mic" size={glyph} />
            {dictation.listening && <Dot pulse size={6} color="var(--loki-accent)" aria-hidden style={{ position: "absolute", top: 3, right: 3 }} />}
          </IconButton>
        )}
        {stop ? (
          <IconButton
            size={size}
            onClick={stop.onStop}
            disabled={stop.stopping}
            label={stop.stopping ? "Stopping" : "Stop"}
            title={stop.stopping ? "Stopping…" : "Stop the agent's turn"}
            className="loki-composer-round loki-composer-stop"
          >
            <Icon name="stop" size={glyph} />
          </IconButton>
        ) : (
          <IconButton
            size={size}
            tone={canSend ? "positive" : "quiet"}
            onClick={onSend}
            disabled={disabled || !canSend}
            label={sendLabel}
            title={sendTitle ?? sendLabel}
            className="loki-composer-round loki-composer-send"
          >
            <Icon name="send" size={glyph} />
          </IconButton>
        )}
      </span>
    </div>
  );
}
