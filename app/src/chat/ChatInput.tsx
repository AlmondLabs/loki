import { forwardRef, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useDictation } from "./useDictation";
import { imageBlobs, imageFromBlob } from "./attachments";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import { Dot, IconButton, TextArea } from "../ui";

/** "what was typed" + "what was heard", one space between, no trailing space carried over. */
const join = (a: string, b: string) => (a && b ? `${a.replace(/\s+$/, "")} ${b}` : a || b);

/**
 * Message box shared by the chat panel and the Catch Up reply: Enter sends,
 * Shift+Enter inserts a newline, grows with its content up to ~6 lines.
 * The mic (or ⌘D while focused) dictates into the same box; recognition
 * stops by itself after a pause, then Enter sends as usual.
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
    /** Images attached to the draft (paste or drop them in); the host sends them with the text. */
    images?: ImageAttachment[];
    onImages?: (images: ImageAttachment[]) => void;
    placeholder?: string;
    disabled?: boolean;
    style?: CSSProperties;
    "aria-controls"?: string;
    "aria-activedescendant"?: string;
    "aria-expanded"?: boolean;
  }
>(function ChatInput({ value, onChange, onSubmit, onKeyDown, onEscape, onFocus, onBlur, images = [], onImages, placeholder, disabled, style, ...aria }, ref) {
  const addBlobs = async (blobs: Blob[]) => {
    if (!onImages || !blobs.length) return;
    const added = await Promise.all(blobs.map((b) => imageFromBlob(b).catch(() => null)));
    onImages([...images, ...added.filter((a): a is ImageAttachment => !!a)]);
  };
  const inner = useRef<HTMLTextAreaElement | null>(null);
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
  useEffect(() => {
    if (!dictation.listening) {
      base.current = value; // sends/clears outside dictation reset the base
      discarding.current = false;
    }
  }, [value, dictation.listening]);

  // Grow to fit, capped; shrink back when cleared.
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    // Empty: one line (36px, md, like the send button beside it) even when the placeholder would wrap.
    if (!value) {
      el.style.height = "";
      return;
    }
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 20 + 16)}px`;
  }, [value]);

  const listening = dictation.listening;
  return (
    <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {images.length > 0 && (
        <div data-attachments style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {images.map((img) => (
            <span key={img.id} style={{ position: "relative", display: "inline-block" }}>
              <img src={img.url} alt="" style={{ height: 56, maxWidth: 120, objectFit: "cover", borderRadius: 6, border: "1px solid var(--loki-border)", display: "block" }} />
              <button
                type="button"
                onClick={() => onImages?.(images.filter((i) => i.id !== img.id))}
                aria-label="remove image"
                style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: "1px solid var(--loki-border)", background: "var(--loki-panel)", color: "var(--loki-fg)", fontSize: 10.5, lineHeight: "16px", cursor: "pointer", padding: 0 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: "relative", display: "flex", minWidth: 0 }}>
      <TextArea
        ref={setRef}
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
          const blobs = imageBlobs(e.clipboardData);
          if (blobs.length) {
            e.preventDefault(); // the image, not its file name
            void addBlobs(blobs);
          }
        }}
        onDragOver={(e) => {
          if (onImages && imageBlobs(e.dataTransfer).length) e.preventDefault();
        }}
        onDrop={(e) => {
          const blobs = imageBlobs(e.dataTransfer);
          if (blobs.length) {
            e.preventDefault();
            void addBlobs(blobs);
          }
        }}
        {...aria}
        onKeyDown={(e) => {
          if (onKeyDown?.(e)) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (listening || dictation.pending) {
              discarding.current = true; // whatever the recogniser still emits belongs to the sent message
              base.current = "";
              interimRef.current = "";
              setInterim("");
              dictation.stop();
            }
            onSubmit();
          } else if (e.key === "Escape" && onEscape) {
            e.preventDefault();
            onEscape();
          } else if (e.key.toLowerCase() === "d" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && dictation.supported) {
            // ⌘D dictates. (⌘M is minimise on a Mac and stays that way.)
            e.preventDefault();
            startDictation();
          }
        }}
        style={{
          flex: 1,
          lineHeight: "20px",
          padding: dictation.supported ? "7px 40px 7px 12px" : "7px 12px",
          // Listening: the box's edge turns brass until the recogniser stops.
          ...(listening ? { borderColor: "var(--loki-accent)" } : null),
          ...style,
        }}
      />
      {dictation.supported && (
        <IconButton
          size={28}
          tone={listening || dictation.pending ? "brass" : "quiet"}
          onClick={startDictation}
          disabled={disabled}
          label={listening ? "stop dictating" : "dictate"}
          aria-pressed={listening}
          title={listening ? "stop dictating" : "dictate (⌘D)"}
          style={{ position: "absolute", right: 6, bottom: 6 }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
            <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
          </svg>
          {listening && <Dot pulse size={6} color="var(--loki-accent)" aria-hidden style={{ position: "absolute", top: 3, right: 3 }} />}
        </IconButton>
      )}
      </div>
      {dictation.error && (
        <span id="loki-dictation-error" role="status" style={{ position: "absolute", left: 12, bottom: "100%", marginBottom: 6, fontSize: 10.5, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", whiteSpace: "nowrap" }}>
          {dictation.error}
        </span>
      )}
      {interim && <span className="sr-only" aria-live="polite">{interim}</span>}
    </div>
  );
});
