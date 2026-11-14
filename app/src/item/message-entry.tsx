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

/**
 * A message from a person, or from you, in an outside item (plan 097, MessageEntry): a person's has their picture (or
 * initial), name and time beside it; yours is the block across the column with where it went. Under the words, its
 * reactions where the source has them. A Slack message that brought the card, or a Jira comment naming the person, is
 * marked with the accent bar.
 */
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
  /** Where your message went, said in its label line: "in thread", "to billing@…", "internal comment". */
  status?: string | null;
  onReact?: (r: SlackReaction) => void;
  /** The first of a run from one sender, which shows their picture and name; the rest of the run sits under it. */
  first?: boolean;
  /** The day beside the time, when the run moved to a new one. */
  note?: string | null;
  /** What follows the reactions: a post's replies, the emoji picker. */
  children?: ReactNode;
}) {
  const time = clockLabel(m.at);
  const parts = <ContentParts parts={m.parts} source={source} title={`${m.who}'s message`} />;
  if (m.from === "you")
    return (
      <Message from="user" data-row="user" className="max-w-full">
        <MessageContent className="w-full gap-1 bg-accent! px-3.5! py-2.5!">
          <div className="flex min-h-6 items-center gap-2 text-meta text-muted-foreground">
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
      className={cn("grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2.5", m.in_thread && "pl-6", m.mentions_you && "border-l-2 border-loki-attention pl-2")}
    >
      {first ? <Avatar who={m.who} src={m.avatar} /> : <span aria-hidden />}
      <div className="flex min-w-0 flex-col gap-1">
        {first && (
          <div className="flex items-baseline gap-2 text-meta text-muted-foreground">
            <span className="text-body font-semibold text-foreground">{m.who}</span>
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

/** Someone's picture as their source gave it, else their initial on the panel's tone. */
function Avatar({ who, src }: { who: string; src: string | null }) {
  if (src) return <img src={src} alt="" className="size-8 rounded-md object-cover" />;
  return (
    <span aria-hidden className="grid size-8 place-items-center rounded-md bg-muted text-meta font-semibold text-muted-foreground">
      {who.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * One message in the new thread (plan 096), on AI Elements' Message, laid out as Turns: yours is a block across the
 * column, "You" and its time over your words; the agent's words are MessageResponse (streamdown, which fades words in
 * while a reply streams) inside its turn, whose header names it, with its copy button (as markdown, once a reply has
 * finished) and time under them. A queued message says so in its label line and offers its take-back. Memoised like
 * today's rows: a long thread is not parsed again on every keystroke.
 */
export const ChatMessage = memo(function ChatMessage({
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
  // The thread reads as ChatGPT's and Claude's do on the Mac (plan 2026-11-12-1505, U14): your message is a bubble at
  // the trailing edge with no label, its time in its tooltip; time is told at gaps (entries.ts).
  if (m.role === "user")
    return (
      <Message from="user" data-row="user" data-queued={m.queued ? "true" : undefined} data-arrived={arrived || undefined} className="group/row max-w-[75%]">
        {/* Copy floats beside the bubble on hover and takes no room, so the thread keeps its rhythm. */}
        <div className="relative ml-auto w-fit max-w-full">
          {copyable && (
            <span className="absolute top-1/2 right-full mr-1 -translate-y-1/2">
              <CopyAsMarkdown text={text} />
            </span>
          )}
          <MessageContent title={time ?? undefined} className={cn("rounded-[24px]! bg-accent! px-4! py-2.5!", m.queued && "border border-dashed border-ring")}>
            <UserContent row={m} />
          </MessageContent>
        </div>
        {m.queued && (
          <MessageActions className="justify-end text-meta text-muted-foreground">
            <Button variant="link" size="xs" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} className="h-auto px-0">
              Sends when this turn ends{onCancelQueued ? " · Take Back" : ""}
            </Button>
          </MessageActions>
        )}
      </Message>
    );
  return (
    <Message from="assistant" data-row={m.role} data-arrived={arrived || undefined} className="group/row relative max-w-full">
      <MessageContent className="text-body">
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

/**
 * The message's words as written (markdown, not the rendering) onto the clipboard; a check for a beat after. Out of
 * sight until the row is hovered or the button has focus, as the Mac's chat apps do.
 */
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
