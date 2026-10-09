import { describe, expect, test } from "bun:test";
import { attachmentTag, withAttachments } from "../core/attention/content.ts";
import { historySteps, messageFiles, stripHarnessMarkup } from "../core/harness.ts";
import { applyEvent, emptyLive } from "../core/attention/model.ts";
import { foldSteps, ownSendKey } from "../core/attention/thread.ts";
import { fileSize, isInlineImage } from "../app/src/chat/attachments.ts";

const report = { path: "/Users/me/.letta/loki/uploads/2026-09-30/Q3 \"final\".pdf", name: 'Q3 "final".pdf', size: 482113, mime: "application/pdf" };

describe("files on a message: Letta's attachment tag", () => {
  test("a file goes as the tag Letta's channels use, after the text", () => {
    const tag = attachmentTag(report);
    expect(tag).toBe('<attachment kind="file" local_path="/Users/me/.letta/loki/uploads/2026-09-30/Q3 &quot;final&quot;.pdf" name="Q3 &quot;final&quot;.pdf" mime_type="application/pdf" size_bytes="482113" />');
    expect(withAttachments("read this", [report])).toBe(`read this\n\n${tag}`);
    expect(withAttachments("", [report])).toBe(tag);
    expect(withAttachments("just text", [])).toBe("just text");
  });

  test("the chat reads the tag back as a file and hides it from the words", () => {
    const text = withAttachments("read this", [report]);
    expect(messageFiles(text)).toEqual([report]);
    expect(stripHarnessMarkup(text).trim()).toBe("read this");
    // A Slack channel's tag with its own children, and one not downloaded: hidden; only files with a path are chips.
    const slack = 'hi <attachment kind="file" attachment_id="F1" download_status="not_downloaded" name="a.pdf">\n  <download-retry>…</download-retry>\n</attachment>';
    expect(stripHarnessMarkup(slack).trim()).toBe("hi");
    expect(messageFiles(slack)).toEqual([]);
  });

  test("history keeps the file on the row, even a message that was only a file", () => {
    const rows = foldSteps(historySteps([{ message_type: "user_message", content: withAttachments("", [report]), date: "2026-09-30T10:00:00Z" }]));
    expect(rows).toEqual([{ role: "user", text: "", at: "2026-09-30T10:00:00Z", files: [report] }]);
  });

  test("the echo of a message sent with a file is recognised, and not shown twice", () => {
    const l = emptyLive();
    l.thread.expectEcho(ownSendKey("", [report]));
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "user_message", content: withAttachments("", [report]) } });
    expect(l.thread.rows() ?? []).toEqual([]);
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "user_message", content: withAttachments("from the phone", [report]) } });
    expect(l.thread.rows()).toMatchObject([{ role: "user", text: "from the phone", files: [report] }]);
  });
});

describe("files in the message box", () => {
  test("photos the agent can see ride inside the message; SVGs, PDFs and the rest are uploaded", () => {
    expect(isInlineImage(new Blob([], { type: "image/png" }))).toBe(true);
    expect(isInlineImage(new Blob([], { type: "image/heic" }))).toBe(true);
    expect(isInlineImage(new Blob([], { type: "image/svg+xml" }))).toBe(false);
    expect(isInlineImage(new Blob([], { type: "application/pdf" }))).toBe(false);
    expect(isInlineImage(new Blob([], { type: "" }))).toBe(false);
  });
  test("sizes read the way Finder writes them", () => {
    expect(fileSize(900)).toBe("900 B");
    expect(fileSize(482113)).toBe("471 KB");
    expect(fileSize(3.1 * 1024 * 1024)).toBe("3.1 MB");
    expect(fileSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});
