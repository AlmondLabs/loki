import { afterEach, describe, expect, test } from "vitest";
import { createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { useMessageBox, type MessageBoxProps } from "../app/src/chat/chat-input.tsx";
import { Composer } from "../app/src/item/composer.tsx";
import { Conversation, Thread } from "../app/src/chat/conversation.tsx";
import { threadPreview } from "../app/src/item/preview.ts";

// Plan 097, U6: the Composer draws today's message box behaviour (useMessageBox) with AI Elements' PromptInput parts,
// and shows what waits to send in a Queue above the field. Typing and pasting for real is checked in the app.

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const props = (over: Partial<MessageBoxProps> = {}): MessageBoxProps => ({
  value: "",
  onChange: () => {},
  onSubmit: () => {},
  canSend: false,
  sendLabel: "Send",
  ...over,
});
const key = (k: string, mods: { shift?: boolean; composing?: boolean; meta?: boolean } = {}) => {
  let prevented = false;
  const e = {
    key: k,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    ctrlKey: false,
    altKey: false,
    nativeEvent: { isComposing: !!mods.composing },
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { e, prevented: () => prevented };
};

/** Renders a box once and hands back its behaviour, so its handlers can be called as the field would call them. */
function boxOf(p: MessageBoxProps) {
  const got: { box?: ReturnType<typeof useMessageBox> } = {};
  function Probe() {
    got.box = useMessageBox(p, null);
    return null;
  }
  html(createElement(Probe));
  if (!got.box) throw new Error("the probe did not render");
  return got.box;
}

describe("the message box's behaviour", () => {
  test("Enter sends; Shift+Enter and Enter while composing do not", () => {
    let sent = 0;
    const box = boxOf(props({ value: "hello", onSubmit: () => sent++ }));
    const enter = key("Enter");
    box.field.onKeyDown(enter.e);
    expect(sent).toBe(1);
    expect(enter.prevented()).toBe(true);
    box.field.onKeyDown(key("Enter", { shift: true }).e);
    box.field.onKeyDown(key("Enter", { composing: true }).e);
    expect(sent).toBe(1);
  });

  test("a host that claims a key gets it first, as the slash palette does", () => {
    let sent = 0;
    const box = boxOf(props({ onSubmit: () => sent++, onKeyDown: () => true }));
    box.field.onKeyDown(key("Enter").e);
    expect(sent).toBe(0);
  });

  test("Escape goes to the host", () => {
    let escaped = 0;
    const box = boxOf(props({ onEscape: () => escaped++ }));
    box.field.onKeyDown(key("Escape").e);
    expect(escaped).toBe(1);
  });
});

describe("the Composer", () => {
  test("is a field named message with send, disabled while there is nothing to send", () => {
    const out = html(createElement(Composer, props()));
    expect(out).toContain("data-composer");
    expect(out).toContain('name="message"');
    expect(out).toMatch(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/);
  });

  test("offers attach only when the host takes files, and stop in send's place while the agent works with nothing typed", () => {
    expect(html(createElement(Composer, props()))).not.toContain("attach files");
    expect(html(createElement(Composer, props({ onImages: () => {} })))).toContain("attach files");
    const working = html(createElement(Composer, props({ onStop: () => {} })));
    expect(working).toContain('aria-label="stop"');
    expect(working).not.toContain('aria-label="Send"');
  });

  test("shows what waits to send in a queue, each with take back; none, no queue", () => {
    const queued: TranscriptRow[] = [
      { role: "user", text: "Also add week 14.", queued: true },
      { role: "user", text: "And label the peak.", queued: true },
    ];
    const out = html(createElement(Composer, { ...props(), queued, onCancelQueued: () => {} }));
    expect(out).toContain('aria-label="queued messages"');
    expect(out).toContain("Also add week 14.");
    expect(out).toContain('aria-label="take back &quot;And label the peak.&quot;"');
    expect(html(createElement(Composer, props()))).not.toContain("queued messages");
  });
});

describe("the pane's seam", () => {
  afterEach(() => threadPreview.set("off"));
  const pane = () => html(createElement(Conversation, { view: { rows: [], status: "idle" }, actions: { onSend: () => {} }, agentName: "friday" }));

  test("today's box by default, the Composer when the preview is on", () => {
    expect(pane()).toContain("loki-composer-box");
    expect(pane()).not.toContain("data-composer");
    threadPreview.set("on");
    expect(pane()).toContain("data-composer");
  });

  test("with the preview on, queued messages leave the end of the thread for the queue", () => {
    threadPreview.set("on");
    const rows: TranscriptRow[] = [
      { role: "user", text: "chart signups" },
      { role: "assistant", text: "On it." },
      { role: "user", text: "Also add week 14.", queued: true },
    ];
    const thread = html(createElement(Thread, { rows, status: "thinking" }));
    expect(thread).toContain("On it.");
    expect(thread).not.toContain("Also add week 14.");
  });
});
