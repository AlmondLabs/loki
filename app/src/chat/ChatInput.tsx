import { forwardRef, useEffect, useRef, type CSSProperties } from "react";

/**
 * Message box shared by the chat panel and the Catch Up reply: Enter sends,
 * Shift+Enter inserts a newline, grows with its content up to ~6 lines.
 */
export const ChatInput = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    onEscape?: () => void;
    placeholder?: string;
    disabled?: boolean;
    style?: CSSProperties;
  }
>(function ChatInput({ value, onChange, onSubmit, onEscape, placeholder, disabled, style }, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };

  // Grow to fit, capped; shrink back when cleared.
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 21 + 20)}px`;
  }, [value]);

  return (
    <textarea
      ref={setRef}
      value={value}
      rows={1}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        } else if (e.key === "Escape" && onEscape) {
          e.preventDefault();
          onEscape();
        }
      }}
      style={{
        flex: 1,
        resize: "none",
        overflowY: "auto",
        lineHeight: "21px",
        background: "#101014",
        border: "1px solid var(--loci-border, #2c2c34)",
        borderRadius: 8,
        padding: "9px 12px",
        fontSize: 13.5,
        fontFamily: "var(--loci-font)",
        color: "var(--loci-fg)",
        outline: "none",
        ...style,
      }}
    />
  );
});
