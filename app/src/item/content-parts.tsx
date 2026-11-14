import type { ReactNode } from "react";
import { LayoutGridIcon } from "lucide-react";
import { Artifact, ArtifactAction, ArtifactActions, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "@/ui/ai-elements/artifact";
import { Marker, MarkerContent, MarkerIcon } from "@/ui/marker";
import { AppAttachment, Blocks, SlackFiles } from "../desk/slack-thread";
import { MailFiles } from "../desk/mail-thread";
import { MailHtml } from "../desk/mail-html";
import { LinkedText } from "../desk/mail-html";
import { clockLabel } from "../shared/thread";
import type { WidgetMark } from "../chat/transcript";
import type { ItemPart, ItemSource } from "./item-view";

/**
 * What an outside entry carries, one renderer per part (plan 097, ContentParts): Slack's blocks and what its apps
 * attached, a mail's HTML in its locked frame, plain text with its links, and files as chips. The renderers are the
 * outside cards' own, so a message reads the same here as there. An agent chat's words are markdown and go through
 * MessageResponse instead; its widgets are drawn by WidgetArtifact.
 */
export function ContentParts({ parts, source, title }: { parts: readonly ItemPart[]; source: ItemSource; title: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-body">
      {parts.map((p, k) => (
        // A message's parts never reorder, so their place is their key.
        <div key={k} className="min-w-0">
          {partOf(p, source, title)}
        </div>
      ))}
    </div>
  );
}

function partOf(p: ItemPart, source: ItemSource, title: string): ReactNode {
  switch (p.kind) {
    case "text":
      return (
        <p className="m-0 whitespace-pre-wrap">
          <LinkedText text={p.text} />
        </p>
      );
    case "blocks":
      return <Blocks blocks={p.blocks} />;
    case "html":
      return <MailHtml html={p.html} title={title} />;
    case "attachments":
      return p.attachments.map((a, k) => <AppAttachment key={k} a={a} />);
    case "files":
      return <SlackFiles files={p.files} where={source === "jira" ? "jira" : "Slack"} />;
    case "mail_files":
      return <MailFiles files={p.files} />;
  }
}

/**
 * A widget the agent changed, drawn as AI Elements' Artifact (plan 097): its title, who changed it and when, an action
 * that opens the Canvas tab framed on it, and the live widget inside while this is its latest change. A widget since
 * removed says so and opens nothing. The summary of earlier changes stays one quiet line that opens the canvas.
 */
export function WidgetArtifact({
  mark: w,
  live,
  inline,
  onFrame,
  onShowDesk,
}: {
  mark: WidgetMark;
  live: boolean;
  inline?: (widgetId: string) => ReactNode;
  onFrame?: (widgetId: string) => void;
  onShowDesk?: () => void;
}) {
  if (w.earlier !== undefined)
    return (
      <Marker data-row="widget" render={onShowDesk ? <button type="button" onClick={onShowDesk} title="Show the canvas" /> : undefined}>
        <MarkerIcon>
          <LayoutGridIcon />
        </MarkerIcon>
        <MarkerContent>{`${w.earlier} earlier widget change${w.earlier === 1 ? "" : "s"}`}</MarkerContent>
      </Marker>
    );
  const time = clockLabel(w.at);
  const open = !w.gone && onFrame ? () => onFrame(w.widgetId) : undefined;
  const body = live ? inline?.(w.widgetId) : null;
  return (
    <Artifact data-row="widget" data-gone={w.gone ? "true" : undefined} className="shadow-none">
      <ArtifactHeader className="gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <ArtifactTitle className="truncate">{w.title}</ArtifactTitle>
          <ArtifactDescription className="text-meta">
            {w.who} {w.change}
            {time && (
              <>
                {" · "}
                <time dateTime={w.at}>{time}</time>
              </>
            )}
            {w.gone && (w.change === "removed" ? " · gone from the canvas" : " · since removed from the canvas")}
          </ArtifactDescription>
        </div>
        {open && (
          <ArtifactActions>
            <ArtifactAction icon={LayoutGridIcon} label="Show it on the canvas" title="Show it on the canvas" onClick={open} />
          </ArtifactActions>
        )}
      </ArtifactHeader>
      {body ? <ArtifactContent className="p-0">{body}</ArtifactContent> : null}
    </Artifact>
  );
}
