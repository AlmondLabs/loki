import { useState, type ReactNode } from "react";
import type { JiraCardFields, JiraCardTicket, JiraFieldChange, JiraOtherChange } from "../../../core/frame-types.ts";
import { Button, Chip, Meta, sentence } from "../components";
import { ago } from "./catch-up-parts";
import { LinkedText } from "./mail-html";

/**
 * A Jira card drawn as the ticket (plan 089): its type, key and project over the summary, its fields with what someone
 * else changed since the card was last read, the fields it does not show in one line, the description folded after
 * six lines, and the comments under their count. The desktop and the phone draw the same parts in the same order; the
 * phone in sentence case. `outside-card` draws the comments themselves and the desktop header's tag and link.
 */

/** Desktop words stay lowercase; the phone's start with a capital. */
const say = (touch: boolean, words: string) => (touch ? sentence(words) : words);

/** The description shows this many lines before "show more". */
const FOLD_AT = 6;

/** The header's parts a change to marks new, by Jira's history name for each, with the plain word the card says for it. */
const HEAD_FIELDS = new Map<string, string>([
  ["summary", "summary"],
  ["issuetype", "type"],
  ["project", "project"],
]);

/**
 * The fields the card shows, in order, by the name Jira's history gives each (`Sprint` with its capital). Labels are
 * written lowercase, as desktop labels are, and `say` gives the phone its sentence case.
 */
const FIELDS: Array<{ key: keyof JiraCardFields; label: string; history: string }> = [
  { key: "status", label: "status", history: "status" },
  { key: "assignee", label: "assignee", history: "assignee" },
  { key: "reporter", label: "reporter", history: "reporter" },
  { key: "priority", label: "priority", history: "priority" },
  { key: "sprint", label: "sprint", history: "Sprint" },
  { key: "labels", label: "labels", history: "labels" },
];

/** Jira's history writes labels as one text parted by spaces; the card lists them parted by commas. */
const asLabels = (text: string) => text.split(" ").filter(Boolean).join(", ");

/** What a field was before the change, as the card says it: "none" when it had no value. */
function wasText(change: JiraFieldChange): string {
  if (!change.from) return "none";
  return change.field === "labels" ? asLabels(change.from) : change.from;
}

/** Who changed it and how long ago: "Ada Lovelace · 2h". */
const byWhen = (c: { by: string; at: string }) => [c.by, ago(c.at)].filter(Boolean).join(" · ");

/** The small mark beside a part someone else changed since the card was last read. */
function NewMark({ touch, title }: { touch: boolean; title?: string }) {
  return (
    <span className="loki-jira-new" title={title}>
      {say(touch, "new")}
    </span>
  );
}

/** A quiet line under a part: the desktop's meta or the phone's. */
function Quiet({ touch, children }: { touch: boolean; children: ReactNode }) {
  return touch ? <span className="loki-phone-meta">{children}</span> : <Meta wrap>{children}</Meta>;
}

/**
 * The ticket's header (plan 089, item 1): the Jira mark, the key, the type and project, then the summary as the card's
 * title, the size a mail card's subject is. A change to the summary, type or project marks it new. On the desktop it
 * fills the card's head beside `right` (the tag and the link to the ticket) with `line` (who, when, where) under the
 * summary; the phone draws it at the top of its card's body, with neither.
 */
export function JiraTicketHead({ ticket, touch = false, line, right }: { ticket: JiraCardTicket; touch?: boolean; line?: ReactNode; right?: ReactNode }) {
  const change = ticket.changed.find((c) => HEAD_FIELDS.has(c.field));
  const kind = [ticket.type, ticket.project].filter(Boolean).join(" · ");
  // On the desktop it is the head's growing column; on the phone a plain block at the top of the body.
  const text = (
    <div className={touch ? "loki-jira-head" : "loki-jira-head loki-card-head-text"}>
      <div className="loki-jira-key-line" style={touch ? { fontSize: "var(--phone-text-meta)" } : undefined}>
        <span className="loki-jira-type" aria-label="from Jira">
          ◆
        </span>
        {/* The key is an id, so it is mono, as task ids are. */}
        <span className="loki-jira-key" style={{ fontFamily: "var(--loki-mono)" }}>
          {ticket.key}
        </span>
        {kind && <span className="loki-jira-kind">· {kind}</span>}
        {change && <NewMark touch={touch} title={`${HEAD_FIELDS.get(change.field) ?? change.field} changed · ${byWhen(change)}`} />}
      </div>
      {touch ? (
        <div className="loki-jira-summary" style={{ fontSize: "var(--phone-text-emph)" }}>
          {ticket.summary}
        </div>
      ) : (
        <div className="loki-card-head-who" title={ticket.summary}>
          {ticket.summary}
        </div>
      )}
      {line && <div className="loki-card-head-line">{line}</div>}
    </div>
  );
  if (touch) return text;
  return (
    <div className="loki-card-head">
      {text}
      {right && <div className="loki-card-head-right">{right}</div>}
    </div>
  );
}

/** One field's value: the status as a small pill, labels parted by commas, anything else as Jira names it. */
function FieldValue({ field, fields }: { field: keyof JiraCardFields; fields: JiraCardFields }) {
  if (field === "labels") return <span>{fields.labels.length ? fields.labels.join(", ") : "none"}</span>;
  const value = fields[field];
  if (field === "status" && value) return <Chip static>{value}</Chip>;
  return <span>{value ?? "none"}</span>;
}

/**
 * The ticket's fields on a quiet surface (plan 089, item 2), each only when the ticket has it or someone changed it: a
 * changed one is marked new, with what it was, who changed it and when under its value.
 */
function JiraFields({ ticket, touch }: { ticket: JiraCardTicket; touch: boolean }) {
  const { fields } = ticket;
  const rows = FIELDS.map((f) => ({ ...f, change: ticket.changed.find((c) => c.field === f.history) })).filter(
    (f) => f.change !== undefined || (f.key === "labels" ? fields.labels.length > 0 : fields[f.key] !== null),
  );
  if (rows.length === 0) return null;
  return (
    <dl className="loki-jira-fields" style={{ fontSize: touch ? "var(--phone-text-body)" : 13.5 }}>
      {rows.map((f) => (
        <div key={f.key} className="loki-jira-field">
          <dt className={touch ? "loki-phone-meta" : "loki-meta"}>{say(touch, f.label)}</dt>
          <dd className="loki-jira-field-value">
            <span className="loki-jira-field-now">
              <FieldValue field={f.key} fields={fields} />
              {f.change && <NewMark touch={touch} />}
            </span>
            {f.change && <Quiet touch={touch}>{say(touch, `was ${wasText(f.change)} · ${byWhen(f.change)}`)}</Quiet>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The fields the card does not show that someone else changed (plan 089, item 3), as one line grouped by who changed
 * them, each group with its newest time: "also changed: Rank, Story points · Ada Lovelace · 2h".
 */
export function alsoChangedText(changes: readonly JiraOtherChange[]): string | null {
  if (changes.length === 0) return null;
  const groups = new Map<string, { fields: string[]; at: string }>();
  for (const c of changes) {
    const g = groups.get(c.by) ?? { fields: [], at: c.at };
    if (!g.fields.includes(c.field)) g.fields.push(c.field);
    if (c.at > g.at) g.at = c.at;
    groups.set(c.by, g);
  }
  const parts = [...groups].map(([by, g]) => `${g.fields.join(", ")} · ${byWhen({ by, at: g.at })}`);
  return `also changed: ${parts.join("; ")}`;
}

/** A part's heading: "Description", "Comments · 2". */
function Heading({ touch, children }: { touch: boolean; children: ReactNode }) {
  return (
    <div className="loki-jira-heading" style={{ fontSize: touch ? "var(--phone-text-body)" : 13.5 }}>
      {children}
    </div>
  );
}

/**
 * The description (plan 089, item 4): its lines, folded after six with "show more", and marked edited when someone
 * else changed it since the card was last read. A ticket without one, never edited, draws none.
 */
function JiraDescription({ ticket, touch }: { ticket: JiraCardTicket; touch: boolean }) {
  const [open, setOpen] = useState(false);
  const edit = ticket.changed.find((c) => c.field === "description");
  const lines = ticket.description;
  if (lines.length === 0 && !edit) return null;
  const folds = lines.length > FOLD_AT;
  const shown = folds && !open ? lines.slice(0, FOLD_AT) : lines;
  return (
    <section className="loki-jira-part">
      <Heading touch={touch}>Description</Heading>
      {edit && (
        <span className="loki-jira-field-now">
          <NewMark touch={touch} />
          <Quiet touch={touch}>{say(touch, `edited · ${byWhen(edit)}`)}</Quiet>
        </span>
      )}
      {lines.length > 0 ? (
        <div className="loki-jira-description" style={{ fontSize: touch ? "var(--phone-text-body)" : 13.5 }}>
          <LinkedText text={shown.join("\n")} />
        </div>
      ) : (
        <Quiet touch={touch}>{say(touch, "no description")}</Quiet>
      )}
      {folds && (
        <Button size={touch ? "touch" : "sm"} bare aria-expanded={open} onClick={() => setOpen(!open)} style={{ alignSelf: "flex-start" }}>
          {say(touch, open ? "show less" : "show more")}
        </Button>
      )}
    </section>
  );
}

/**
 * The ticket's body on its card (plan 089, items 2-6): on the phone its header first, then the fields, what else
 * changed, the description, and the comments under the ticket's count of them, which `children` draws as the thread's
 * list; the list is a window, so it may hold fewer.
 */
export function JiraTicket({ ticket, touch = false, children }: { ticket: JiraCardTicket; touch?: boolean; children: ReactNode }) {
  const also = alsoChangedText(ticket.also_changed);
  return (
    <div className="loki-jira-ticket" style={{ gap: touch ? "var(--phone-space-4)" : 16 }}>
      {touch && <JiraTicketHead ticket={ticket} touch />}
      <div className="loki-jira-part">
        <JiraFields ticket={ticket} touch={touch} />
        {also && <Quiet touch={touch}>{say(touch, also)}</Quiet>}
      </div>
      <JiraDescription ticket={ticket} touch={touch} />
      <section className="loki-jira-part">
        <Heading touch={touch}>{`Comments · ${String(ticket.comment_count)}`}</Heading>
        {children}
      </section>
    </div>
  );
}
