import { useState, type ReactNode } from "react";
import type { JiraCardFields, JiraCardTicket, JiraFieldChange, JiraOtherChange } from "../../../core/frame-types.ts";
import { Button, Chip, Meta, sentence } from "../components";
import { ago } from "./catch-up-parts";
import { LinkedText } from "./mail-html";

const FOLD_AT = 6;

const HEAD_FIELDS = new Map<string, string>([
  ["summary", "summary"],
  ["issuetype", "type"],
  ["project", "project"],
]);

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

function wasText(change: JiraFieldChange): string {
  if (!change.from) return "none";
  return change.field === "labels" ? asLabels(change.from) : change.from;
}

const byWhen = (c: { by: string; at: string }) => [c.by, ago(c.at)].filter(Boolean).join(" · ");

function NewMark({ title }: { title?: string }) {
  return (
    <span className="loki-jira-new" title={title}>
      New
    </span>
  );
}

function Quiet({ touch, children }: { touch: boolean; children: ReactNode }) {
  return touch ? <span className="loki-phone-meta">{children}</span> : <Meta wrap>{children}</Meta>;
}

export function JiraTicketHead({ ticket, touch = false, line, right }: { ticket: JiraCardTicket; touch?: boolean; line?: ReactNode; right?: ReactNode }) {
  const change = ticket.changed.find((c) => HEAD_FIELDS.has(c.field));
  const kind = [ticket.type, ticket.project].filter(Boolean).join(" · ");
  const text = (
    <div className={touch ? "loki-jira-head" : "loki-jira-head loki-card-head-text"}>
      <div className="loki-jira-key-line" style={touch ? { fontSize: "var(--phone-text-meta)" } : undefined}>
        <span className="loki-jira-type" aria-label="From Jira">
          ◆
        </span>
        <span className="loki-jira-key loki-mono">{ticket.key}</span>
        {kind && <span className="loki-jira-kind">· {kind}</span>}
        {change && <NewMark title={sentence(`${HEAD_FIELDS.get(change.field) ?? change.field} changed · ${byWhen(change)}`)} />}
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

function FieldValue({ field, fields }: { field: keyof JiraCardFields; fields: JiraCardFields }) {
  if (field === "labels") return <span>{fields.labels.length ? fields.labels.join(", ") : "none"}</span>;
  const value = fields[field];
  if (field === "status" && value) return <Chip static>{value}</Chip>;
  return <span>{value ?? "none"}</span>;
}

function JiraFields({ ticket, touch }: { ticket: JiraCardTicket; touch: boolean }) {
  const { fields } = ticket;
  const rows = FIELDS.map((f) => ({ ...f, change: ticket.changed.find((c) => c.field === f.history) })).filter(
    (f) => f.change !== undefined || (f.key === "labels" ? fields.labels.length > 0 : fields[f.key] !== null),
  );
  if (rows.length === 0) return null;
  return (
    <dl className="loki-jira-fields" style={{ fontSize: touch ? "var(--phone-text-body)" : "var(--text-sm)" }}>
      {rows.map((f) => (
        <div key={f.key} className="loki-jira-field">
          <dt className={touch ? "loki-phone-meta" : "loki-meta"}>{sentence(f.label)}</dt>
          <dd className="loki-jira-field-value">
            <span className="loki-jira-field-now">
              <FieldValue field={f.key} fields={fields} />
              {f.change && <NewMark />}
            </span>
            {f.change && <Quiet touch={touch}>{sentence(`was ${wasText(f.change)} · ${byWhen(f.change)}`)}</Quiet>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

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

function Heading({ touch, children }: { touch: boolean; children: ReactNode }) {
  return (
    <div className="loki-jira-heading" style={{ fontSize: touch ? "var(--phone-text-body)" : "var(--text-sm)" }}>
      {children}
    </div>
  );
}

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
          <NewMark />
          <Quiet touch={touch}>{sentence(`edited · ${byWhen(edit)}`)}</Quiet>
        </span>
      )}
      {lines.length > 0 ? (
        <div className="loki-jira-description" style={{ fontSize: touch ? "var(--phone-text-body)" : "var(--text-sm)" }}>
          <LinkedText text={shown.join("\n")} />
        </div>
      ) : (
        <Quiet touch={touch}>No description</Quiet>
      )}
      {folds && (
        <Button size={touch ? "touch" : "sm"} bare aria-expanded={open} onClick={() => setOpen(!open)} className="self-start">
          {open ? "Show Less" : "Show More"}
        </Button>
      )}
    </section>
  );
}

export function JiraTicket({ ticket, touch = false, children }: { ticket: JiraCardTicket; touch?: boolean; children: ReactNode }) {
  const also = alsoChangedText(ticket.also_changed);
  return (
    <div className="loki-jira-ticket" style={{ gap: touch ? "var(--phone-space-4)" : 16 }}>
      {touch && <JiraTicketHead ticket={ticket} touch />}
      <div className="loki-jira-part">
        <JiraFields ticket={ticket} touch={touch} />
        {also && <Quiet touch={touch}>{sentence(also)}</Quiet>}
      </div>
      <JiraDescription ticket={ticket} touch={touch} />
      <section className="loki-jira-part">
        <Heading touch={touch}>{`Comments · ${String(ticket.comment_count)}`}</Heading>
        {children}
      </section>
    </div>
  );
}
