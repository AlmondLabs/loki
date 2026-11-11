import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, FileIcon } from "lucide-react";
import type { FileRef, TranscriptRow } from "../../../../core/attention/transcript.ts";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/ui/attachment";
import { Button } from "@/ui/button";
import { Message, MessageActions, MessageContent, MessageResponse } from "@/ui/ai-elements/message";
import { cn } from "cn";
import { chatImageUrl, inTauri } from "../../desk/env";
import { clockLabel } from "../../shared/thread";
import { fileSize } from "../attachments";
import { MARKDOWN_COMPONENTS } from "../markdown-image";
import { shownText } from "../transcript";

const REMARK_PLUGINS = [remarkGfm];

/**
 * One message in the new thread (plan 096), on AI Elements' Message, laid out as Turns: yours is a block across the
 * column, "You" and its time over your words; the agent's words are MessageResponse (streamdown, which fades words in
 * while a reply streams) inside its turn, whose header names it, with its copy button (as markdown, once a reply has
 * finished) and time under them. A queued message says so in its label line and offers its take-back. Memoised like
 * today's rows: a long thread is not parsed again on every keystroke.
 */
export const ThreadRow = memo(function ThreadRow({
  row: m,
  last,
  streaming,
  arrived,
  onCancelQueued,
}: {
  row: TranscriptRow;
  last: boolean;
  /** The agent is writing this reply now (only ever the last row). */
  streaming: boolean;
  arrived: boolean;
  onCancelQueued?: (row: TranscriptRow) => void;
}) {
  const time = clockLabel(m.at);
  const text = shownText(m);
  const writing = last && streaming;
  const copyable = !!text && !writing;
  if (m.role === "user")
    return (
      <Message from="user" data-row="user" data-queued={m.queued ? "true" : undefined} data-arrived={arrived || undefined} className="group/row max-w-full">
        <MessageContent className={cn("w-full gap-1 bg-accent! px-3.5! py-2.5!", m.queued && "border border-dashed border-ring")}>
          <div className="flex min-h-6 items-center gap-2 text-meta text-muted-foreground">
            <span className="font-semibold text-foreground">You</span>
            {time && <time dateTime={m.at}>{time}</time>}
            {m.queued && (
              <Button variant="link" size="xs" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="h-auto px-0">
                queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
              </Button>
            )}
            {copyable && (
              <span className="ml-auto">
                <CopyAsMarkdown text={text} />
              </span>
            )}
          </div>
          <UserContent row={m} />
        </MessageContent>
      </Message>
    );
  return (
    <Message from="assistant" data-row={m.role} data-arrived={arrived || undefined} className="group/row max-w-full">
      <MessageContent className="text-body">
        <MessageResponse className="loki-md" isAnimating={writing} animated components={MARKDOWN_COMPONENTS}>
          {text}
        </MessageResponse>
      </MessageContent>
      {(copyable || time) && (
        <MessageActions>
          {copyable && <CopyAsMarkdown text={text} />}
          {time && (
            <time dateTime={m.at} className="text-meta text-muted-foreground">
              {time}
            </time>
          )}
        </MessageActions>
      )}
    </Message>
  );
});

/** The message's words as written (markdown, not the rendering) onto the clipboard; a check for a beat after. */
function CopyAsMarkdown({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // The clipboard refused (no permission here): nothing else to say.
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "copied" : "copy as markdown"}
      title={copied ? "copied" : "copy as markdown"}
      onClick={() => void copy()}
      className="text-muted-foreground opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100 data-[copied=true]:opacity-100"
      data-copied={copied ? "true" : undefined}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/** Your message: the pictures and files it carried, then your words with the same markdown as the agent's. */
function UserContent({ row: m }: { row: TranscriptRow }) {
  return (
    <div className="flex flex-col gap-2">
      {m.images && m.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {m.images.map((src, k) => (
            <img key={k} src={chatImageUrl(src)} alt="" className="block max-h-40 max-w-56 rounded-sm border border-border" />
          ))}
        </div>
      )}
      {m.files && m.files.length > 0 && (
        <AttachmentGroup>
          {m.files.map((f) => (
            <FileAttachment key={f.path} file={f} />
          ))}
        </AttachmentGroup>
      )}
      {m.text && (
        <div className="loki-md">
          <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {m.text}
          </Markdown>
        </div>
      )}
    </div>
  );
}

/** A file the message carried: its name and size; in the desktop app pressing it shows the file in its folder. */
function FileAttachment({ file }: { file: FileRef }) {
  const reveal = () =>
    void import("@tauri-apps/plugin-opener")
      .then(({ revealItemInDir }) => revealItemInDir(file.path))
      .catch((err: unknown) => console.warn("loki: reveal file", err));
  return (
    <Attachment size="sm" title={file.path}>
      <AttachmentMedia>
        <FileIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{file.name}</AttachmentTitle>
        {file.size !== undefined && <AttachmentDescription>{fileSize(file.size)}</AttachmentDescription>}
      </AttachmentContent>
      {inTauri && <AttachmentTrigger aria-label={`show ${file.name} in its folder`} onClick={reveal} />}
    </Attachment>
  );
}
