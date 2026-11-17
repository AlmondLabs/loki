import { memo, useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, FileIcon } from "lucide-react";
import type { FileRef, TranscriptRow } from "../../../core/attention/transcript.ts";
import type { SlackReaction } from "../../../core/frame-types.ts";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/ui/attachment";
import { Button } from "@/ui/button";
import { Message, MessageActions, MessageContent, MessageResponse } from "@/ui/ai-elements/message";
import { cn } from "@/lib/utils";
import { chatImageUrl, inTauri } from "../desk/env";
import { clockLabel } from "../shared/thread";
import { fileSize } from "../chat/attachments";
import { MARKDOWN_COMPONENTS } from "../chat/markdown-image";
import { shownText } from "../chat/transcript";
import { ContentParts } from "./content-parts";
import type { ItemEntry, ItemSource } from "./item-view";
import { Reactions } from "./reactions";

const REMARK_PLUGINS = [remarkGfm];

export function MessageEntry({
  entry: m,
  source,
  status = null,
  onReact,
  first = true,
  note = null,
  children,
}: {
  entry: Extract<ItemEntry, { kind: "message" }>;
  source: ItemSource;
  status?: string | null;
  onReact?: (r: SlackReaction) => void;
  first?: boolean;
  note?: string | null;
  children?: ReactNode;
}) {
  const time = clockLabel(m.at);
  const parts = <ContentParts parts={m.parts} source={source} title={`${m.who}'s message`} />;
  if (m.from === "you" && source !== "slack" && source !== "jira")
    return (
      <Message from="user" data-row="user" className="max-w-full">
        <MessageContent className="w-full gap-1 bg-accent! px-4! py-2!">
          <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">You</span>
            {time && <time dateTime={m.at}>{time}</time>}
            {status && <span>· {status}</span>}
          </div>
          {parts}
        </MessageContent>
        <Reactions reactions={m.reactions} onToggle={onReact} />
        {children}
      </Message>
    );
  return (
    <div
      data-row="person"
      data-mentions={m.mentions_you || undefined}
      className={cn("grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2", m.in_thread && "pl-6", m.mentions_you && "border-l-2 border-loki-attention pl-2")}
    >
      {first ? <Avatar who={m.who} src={m.avatar} /> : <span aria-hidden />}
      <div className="flex min-w-0 flex-col gap-1">
        {first && (
          <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="text-sm font-semibold text-foreground">{m.who}</span>
            {time && <time dateTime={m.at}>{time}</time>}
            {note && <span>{note}</span>}
          </div>
        )}
        {parts}
        <Reactions reactions={m.reactions} onToggle={onReact} />
        {children}
      </div>
    </div>
  );
}

function Avatar({ who, src }: { who: string; src: string | null }) {
  if (src) return <img src={src} alt="" className="size-8 rounded-md object-cover" />;
  return (
    <span aria-hidden className="grid size-8 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
      {who.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export const ChatMessage = memo(function ChatMessage({
  row: m,
  last,
  streaming,
  arrived,
  onCancelQueued,
}: {
  row: TranscriptRow;
  last: boolean;
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
      <Message from="user" data-row="user" data-queued={m.queued ? "true" : undefined} data-arrived={arrived || undefined} className="group/row max-w-[75%]">
        <div className="relative ml-auto w-fit max-w-full">
          {copyable && (
            <span className="absolute top-1/2 right-full mr-1 -translate-y-1/2">
              <CopyAsMarkdown text={text} />
            </span>
          )}
          <MessageContent title={time ?? undefined} className={cn("rounded-3xl! bg-accent! px-4! py-2!", m.queued && "border border-dashed border-ring")}>
            <UserContent row={m} />
          </MessageContent>
        </div>
        {m.queued && (
          <MessageActions className="justify-end text-xs text-muted-foreground">
            <Button variant="link" size="xs" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="h-auto px-0">
              Queued · sends when this turn ends{onCancelQueued ? " · Take Back" : ""}
            </Button>
          </MessageActions>
        )}
      </Message>
    );
  return (
    <Message from="assistant" data-row={m.role} data-arrived={arrived || undefined} className="group/row relative max-w-full">
      <MessageContent className="text-sm">
        <MessageResponse className="loki-md" isAnimating={writing} animated components={MARKDOWN_COMPONENTS}>
          {text}
        </MessageResponse>
      </MessageContent>
      {copyable && (
        <MessageActions title={time ?? undefined} className="absolute top-0 left-full ml-1">
          <CopyAsMarkdown text={text} />
        </MessageActions>
      )}
    </Message>
  );
});

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
    } catch {}
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy as Markdown"}
      title={copied ? "Copied" : "Copy as Markdown"}
      onClick={() => void copy()}
      className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[copied=true]:opacity-100"
      data-copied={copied ? "true" : undefined}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

function UserContent({ row: m }: { row: TranscriptRow }) {
  return (
    <div className="flex flex-col gap-2">
      {m.images && m.images.length > 0 && (
        <div className="flex flex-wrap gap-2">
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
      {inTauri && <AttachmentTrigger aria-label={`Show ${file.name} in its folder`} onClick={reveal} />}
    </Attachment>
  );
}
