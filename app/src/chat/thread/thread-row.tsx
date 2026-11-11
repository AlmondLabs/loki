import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, FileIcon } from "lucide-react";
import type { FileRef, TranscriptRow } from "../../../../core/attention/transcript.ts";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/ui/attachment";
import { Bubble, BubbleContent } from "@/ui/bubble";
import { Button } from "@/ui/button";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/ui/message";
import { chatImageUrl, inTauri } from "../../desk/env";
import { clockLabel } from "../../shared/thread";
import { fileSize } from "../attachments";
import { MARKDOWN_COMPONENTS } from "../markdown-image";
import { AssistantBody, shownText } from "../transcript";

const REMARK_PLUGINS = [remarkGfm];

/**
 * One message in the new thread (plan 094, U5), in shadcn's chat anatomy: the agent's words as plain prose on the left,
 * yours in a bubble on the right; the speaker's name opens a run of the agent's messages. Under each, its copy button
 * (as markdown; there once a reply has finished) and its time. A queued message carries its take-back. Memoised like
 * today's rows: a long thread is not parsed again on every keystroke.
 */
export const ThreadRow = memo(function ThreadRow({
  row: m,
  last,
  streaming,
  first,
  arrived,
  agentName,
  onCancelQueued,
}: {
  row: TranscriptRow;
  last: boolean;
  /** The agent is writing this reply now (only ever the last row). */
  streaming: boolean;
  first: boolean;
  arrived: boolean;
  agentName: string;
  onCancelQueued?: (row: TranscriptRow) => void;
}) {
  const mine = m.role === "user";
  const time = clockLabel(m.at);
  const text = shownText(m);
  const copyable = !!text && !(last && streaming);
  return (
    <Message
      align={mine ? "end" : "start"}
      data-row={m.role}
      data-queued={m.queued ? "true" : undefined}
      data-arrived={arrived || undefined}
      className="group/row"
    >
      <MessageContent>
        {!mine && first && <MessageHeader className="px-0 text-foreground">{agentName}</MessageHeader>}
        <Bubble variant={mine ? "secondary" : "ghost"} align={mine ? "end" : "start"} className={m.queued ? "opacity-70" : undefined}>
          <BubbleContent className="text-body">{mine ? <UserContent row={m} /> : <AssistantBody row={m} cursor={last && streaming} />}</BubbleContent>
        </Bubble>
        {m.queued && (
          <Button variant="link" size="xs" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="self-end">
            queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
          </Button>
        )}
        {(copyable || time) && (
          <MessageFooter className="gap-1 px-0">
            {copyable && <CopyAsMarkdown text={text} />}
            {time && (
              <time dateTime={m.at} className="text-meta font-normal text-muted-foreground">
                {time}
              </time>
            )}
          </MessageFooter>
        )}
      </MessageContent>
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
      className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[copied=true]:opacity-100"
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
