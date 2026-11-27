import type { ReactNode } from "react";
import { AppAttachment, Blocks, SlackFiles } from "../workspace/slack-thread";
import { MailFiles } from "../workspace/mail-thread";
import { MailHtml } from "../workspace/mail-html";
import { LinkedText } from "../workspace/mail-html";
import type { ItemPart, ItemSource } from "./item-view";

export function ContentParts({ parts, source, title }: { parts: readonly ItemPart[]; source: ItemSource; title: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      {parts.map((p, k) => (
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
      return (
        <div className="whitespace-pre-wrap">
          <Blocks blocks={p.blocks} />
        </div>
      );
    case "html":
      return <MailHtml html={p.html} title={title} images={p.inline_images} />;
    case "attachments":
      return (
        <div className="whitespace-pre-wrap">
          {p.attachments.map((a, k) => (
            <AppAttachment key={k} a={a} />
          ))}
        </div>
      );
    case "files":
      return <SlackFiles files={p.files} where={source === "jira" ? "jira" : "Slack"} />;
    case "mail_files":
      return <MailFiles files={p.files} />;
  }
}
