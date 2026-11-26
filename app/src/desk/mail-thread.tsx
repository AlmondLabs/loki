import type { MailFile, OutsideMessage } from "../../../core/frame-types.ts";
import { headerPeople } from "../../../core/mail-header.ts";
import { useState } from "react";
import { Chip, Meta } from "../components";
import { AgentFace } from "./agent-chip";
import { ago } from "./catch-up-parts";
import { LinkedText, MailHtml } from "./mail-html";

export const MAIL_INDENT = 36;

export function senderName(sender: string): string {
  const name = sender
    .replace(/<[^>]*>/g, "")
    .replace(/^"|"$/g, "")
    .replace(/"/g, "")
    .trim();
  return name || sender.replace(/[<>]/g, "").trim() || "someone";
}

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

export function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function addressIn(sender: string): string {
  return headerPeople(sender).at(0)?.address ?? "";
}

function said(list: ReadonlyArray<{ name: string; address: string }>, own: ReadonlySet<string>): string {
  const names = list.map((p) => (own.has(p.address) ? "you" : p.name || p.address));
  if (names.length <= 2) return names.join(", ");
  const more = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${more} ${more === 1 ? "other" : "others"}`;
}

export function sentToLine(m: Pick<OutsideMessage, "to" | "cc">, own: readonly string[]): string {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const to = headerPeople(m.to ?? "");
  const cc = headerPeople(m.cc ?? "");
  return [to.length ? `to ${said(to, mine)}` : "", cc.length ? `cc ${said(cc, mine)}` : ""].filter(Boolean).join(", ");
}

export function mailWhen(at: string, now: Date): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function MailFiles({ files }: { files: readonly MailFile[] }) {
  const seen = new Map<string, number>();
  const keyed = files.map((f) => {
    const n = seen.get(f.name) ?? 0;
    seen.set(f.name, n + 1);
    return { f, key: `${f.name}#${n}` };
  });
  return (
    <div className="loki-mail-files">
      {keyed.map(({ f, key }) => (
        <Chip key={key} static title={`${f.name}, ${fileSize(f.size)}: open it from Gmail`}>
          {f.name} <span style={{ color: "var(--loki-muted)" }}>{fileSize(f.size)}</span>
        </Chip>
      ))}
    </div>
  );
}

function MailMessage({ m, own, folded, now }: { m: OutsideMessage; own: readonly string[]; folded: boolean; now: Date }) {
  const [opened, setOpened] = useState(false);
  const name = m.mine ? "you" : senderName(m.sender);
  const face = <AgentFace name={senderName(m.sender)} src={null} size={28} />;
  const when = m.at ? mailWhen(m.at, now) : "";
  if (folded && !opened)
    return (
      <button type="button" className="loki-mail-msg loki-mail-msg--folded" onClick={() => setOpened(true)} aria-expanded={false}>
        {face}
        <span className="loki-mail-msg-name">{name}</span>
        <span className="loki-mail-fold-line">{snippet(m.text)}</span>
        {when && <Meta className="flex-none">{when}</Meta>}
      </button>
    );
  const address = addressIn(m.sender);
  const sentTo = sentToLine(m, own);
  return (
    <div className="loki-mail-msg">
      <div className="loki-mail-msg-head">
        {face}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1">
            <span className="loki-mail-msg-name">{name}</span>
            {address && address !== name && <Meta>&lt;{address}&gt;</Meta>}
          </div>
          {sentTo && <Meta className="block">{sentTo}</Meta>}
        </div>
        {when && (
          <Meta className="flex-none" title={new Date(m.at).toLocaleString()}>
            {when} ({ago(m.at)})
          </Meta>
        )}
      </div>
      <div style={{ marginLeft: MAIL_INDENT, marginTop: 8 }}>
        {m.html ? (
          <MailHtml html={m.html} title={`Mail from ${senderName(m.sender)}`} images={m.inline_images} />
        ) : (
          <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>
            <LinkedText text={m.text} />
          </p>
        )}
        {m.files?.length ? <MailFiles files={m.files} /> : null}
      </div>
    </div>
  );
}

export function MailThread({ messages, own, now }: { messages: readonly OutsideMessage[]; own: readonly string[]; now?: Date }) {
  // oxlint-disable-next-line react/purity -- a fresh clock each render is the point: the relative times move on as the view re-renders.
  const clock = now ?? new Date();
  return (
    <div className="loki-mail-thread">
      {messages.map((m, i) => (
        <MailMessage key={m.id} m={m} own={own} folded={i < messages.length - 1} now={clock} />
      ))}
    </div>
  );
}
