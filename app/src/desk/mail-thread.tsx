import type { MailFile, OutsideMessage } from "../../../core/frame-types.ts";
import { headerPeople } from "../../../core/mail-header.ts";
import { useState } from "react";
import { Chip, Meta } from "../components";
import { AgentFace } from "./agent-chip";
import { ago } from "./catch-up-parts";
import { LinkedText, MailHtml } from "./mail-html";

/**
 * A mail thread on a desktop card, laid out the way Gmail lays one out (plan 078): every mail before the newest folded to
 * one line, and each open mail under its own header line (the face, who wrote, whom it went to, when), its body
 * indented past the face, and its files as chips. The reply box follows the thread, indented with it, on the card.
 */

/** How far a mail's body and the reply box sit in: the face and the gap after it. */
export const MAIL_INDENT = 36;

/** A sender as the card names them: a mail address's display name ("Ada" from "Ada <ada@acme.com>"), else as given. */
export function senderName(sender: string): string {
  const name = sender
    .replace(/<[^>]*>/g, "")
    .replace(/^"|"$/g, "")
    .replace(/"/g, "")
    .trim();
  return name || sender.replace(/[<>]/g, "").trim() || "someone";
}

/** A message's first line with words in it, for a folded mail. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

/** A folded mail's line, as Gmail's snippet reads: its words run together, so a greeting alone never fills it. */
export function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The bare address in a From header, lower case; "" when it has none. */
function addressIn(sender: string): string {
  return headerPeople(sender).at(0)?.address ?? "";
}

/** People as a header line says them: the person as "you", others by name, two at most and then how many more. */
function said(list: ReadonlyArray<{ name: string; address: string }>, own: ReadonlySet<string>): string {
  const names = list.map((p) => (own.has(p.address) ? "you" : p.name || p.address));
  if (names.length <= 2) return names.join(", ");
  const more = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${more} ${more === 1 ? "other" : "others"}`;
}

/** Whom a mail went to, as its header line says it: "to you, cc Dev Patel"; "" when its headers name nobody. */
export function sentToLine(m: Pick<OutsideMessage, "to" | "cc">, own: readonly string[]): string {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const to = headerPeople(m.to ?? "");
  const cc = headerPeople(m.cc ?? "");
  return [to.length ? `to ${said(to, mine)}` : "", cc.length ? `cc ${said(cc, mine)}` : ""].filter(Boolean).join(", ");
}

/** When a mail came, as its header line says it: the time today, else the day, with the year when it is not this year. */
export function mailWhen(at: string, now: Date): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** A file's size in the words a chip uses: bytes under a kilobyte, else KB or MB with one decimal under ten. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A mail's files as chips, by name and size; the card's Gmail link opens them. */
export function MailFiles({ files }: { files: readonly MailFile[] }) {
  // Two files may share a name, so each is keyed by its name and how many of that name came before it.
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

/** One mail of the thread: folded to a line when it is not the newest and was not pressed open, else with its header. */
function MailMessage({ m, own, folded, now }: { m: OutsideMessage; own: readonly string[]; folded: boolean; now: Date }) {
  // Only the press is kept; whether it is folded is the thread's to say, so a mail a newer one arrives under folds.
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
        {when && <Meta style={{ flex: "none" }}>{when}</Meta>}
      </button>
    );
  const address = addressIn(m.sender);
  const sentTo = sentToLine(m, own);
  return (
    <div className="loki-mail-msg">
      <div className="loki-mail-msg-head">
        {face}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span className="loki-mail-msg-name">{name}</span>
            {address && address !== name && <Meta style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>&lt;{address}&gt;</Meta>}
          </div>
          {sentTo && <Meta style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sentTo}</Meta>}
        </div>
        {when && (
          <Meta style={{ flex: "none" }} title={new Date(m.at).toLocaleString()}>
            {when} ({ago(m.at)})
          </Meta>
        )}
      </div>
      <div style={{ marginLeft: MAIL_INDENT, marginTop: 8 }}>
        {m.html ? (
          <MailHtml html={m.html} title={`mail from ${senderName(m.sender)}`} />
        ) : (
          <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13.5, lineHeight: 1.55 }}>
            <LinkedText text={m.text} />
          </p>
        )}
        {m.files?.length ? <MailFiles files={m.files} /> : null}
      </div>
    </div>
  );
}

/** The thread's mails, oldest first, each before the newest folded to a line. */
export function MailThread({ messages, own, now = new Date() }: { messages: readonly OutsideMessage[]; own: readonly string[]; now?: Date }) {
  return (
    <div className="loki-mail-thread">
      {messages.map((m, i) => (
        <MailMessage key={m.id} m={m} own={own} folded={i < messages.length - 1} now={now} />
      ))}
    </div>
  );
}
