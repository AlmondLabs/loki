import type { MailAddressing, MailCompose, MailMode, MailPerson } from "../../../core/frame-types.ts";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Chip, Field, Meta, sentence } from "../components";
import { XIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

/**
 * A mail card's recipients line (plan 076), as Gmail draws it: collapsed to whom the reply goes ("to Pinku Kumar, cc 2
 * others"), and opened into To, Cc and Bcc rows of chips with suggestions from the people the account has mail with.
 * The mode (reply, reply all, forward) and, when the person has more than one, the address it goes from, lead the line.
 * The deck holds what was chosen; null means nothing was changed, which sends to all, as before.
 */

/** The modes in the menu's order, with their words. */
export const MAIL_MODES: ReadonlyArray<{ mode: MailMode; word: string }> = [
  { mode: "reply", word: "reply" },
  { mode: "reply_all", word: "reply all" },
  { mode: "forward", word: "forward" },
];

/** What the line starts as: reply all, from the address the mail came to, with the signature. */
export function startAddressing(compose: MailCompose): MailAddressing {
  return { mode: "reply_all", ...compose.modes.reply_all, bcc: [], from: compose.default_from, signature: true };
}

/**
 * The addressing after switching to `mode`: who that mode goes to (a forward to nobody yet), keeping the address it
 * goes from and the signature. Bcc is kept too, since the person added each of those by hand.
 */
export function addressingFor(compose: MailCompose, mode: MailMode, prev: MailAddressing | null): MailAddressing {
  const base = prev ?? startAddressing(compose);
  const who = mode === "forward" ? { to: [], cc: [] } : compose.modes[mode];
  return { ...base, mode, to: [...who.to], cc: [...who.cc] };
}

/** A recipient's bare address, lower case: what is inside the last <…>, else the whole. */
export function addressOf(entry: string): string {
  return ([...entry.matchAll(/<([^<>]+)>/g)].at(-1)?.[1] ?? entry).trim().toLowerCase();
}

/** A recipient as a chip names them: their display name, else their address. */
export function recipientName(entry: string): string {
  const at = entry.lastIndexOf("<");
  const name = at > 0 ? entry.slice(0, at).replace(/"/g, "").trim() : "";
  return name || addressOf(entry);
}

/** Names in a list as the collapsed line says them: two names, then how many others. */
function names(list: readonly string[]): string {
  if (list.length <= 2) return list.map(recipientName).join(", ");
  return `${list.slice(0, 2).map(recipientName).join(", ")} and ${list.length - 2} ${list.length - 2 === 1 ? "other" : "others"}`;
}

/** The collapsed line: "to Pinku Kumar, cc 2 others, bcc 1", or that nobody is on it yet. */
export function addressSummary(a: MailAddressing): string {
  const parts = [
    a.to.length ? `to ${names(a.to)}` : "",
    a.cc.length ? `cc ${a.cc.length <= 2 ? names(a.cc) : `${a.cc.length} others`}` : "",
    a.bcc.length ? `bcc ${a.bcc.length}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nobody yet: add someone";
}

/** A person as a recipient: `"Name" <address>`, or the bare address. */
export const asRecipient = (p: MailPerson): string => (p.name ? `"${p.name.replace(/"/g, "")}" <${p.address}>` : p.address);

/** What was typed, as a recipient: a bare address or `Name <address>`; null when it is not an address yet. */
export function typedRecipient(text: string): string | null {
  const t = text.trim().replace(/[,;]+$/, "");
  const address = addressOf(t);
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address) ? t : null;
}

/** The people that match what was typed, those whose name or address starts with it first, leaving out who is already on it. */
export function suggest(people: readonly MailPerson[], query: string, taken: ReadonlySet<string>, n = 6): MailPerson[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = (p: MailPerson) =>
    p.address.startsWith(q) ||
    p.name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.startsWith(q));
  const has = (p: MailPerson) => p.address.includes(q) || p.name.toLowerCase().includes(q);
  const open = people.filter((p) => !taken.has(p.address));
  return [...open.filter(starts), ...open.filter((p) => !starts(p) && has(p))].slice(0, n);
}

type Row = "to" | "cc" | "bcc";

/**
 * One row of recipients: its chips, each removed by its ×, and a field that adds someone. Suggestions show as you type;
 * ↑ and ↓ move through them and Enter or Tab takes one. Enter, Tab or a comma takes a whole address typed by hand, and
 * Backspace in an empty field removes the last chip.
 */
function RecipientRow({
  row,
  list,
  people,
  taken,
  onChange,
  onTyping,
  touch,
  autoFocus,
}: {
  row: Row;
  list: string[];
  people: readonly MailPerson[];
  taken: ReadonlySet<string>;
  onChange: (list: string[]) => void;
  onTyping?: (typing: boolean) => void;
  touch: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const found = suggest(people, query, taken);
  const at = Math.min(pick, Math.max(0, found.length - 1));
  const add = (entry: string) => {
    if (!taken.has(addressOf(entry))) onChange([...list, entry]);
    setQuery("");
    setPick(0);
  };
  const keys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Letters here are the address's, never the deck's keys.
    e.stopPropagation();
    if (e.key === "ArrowDown" && found.length) {
      e.preventDefault();
      setPick((at + 1) % found.length);
    } else if (e.key === "ArrowUp" && found.length) {
      e.preventDefault();
      setPick((at - 1 + found.length) % found.length);
    } else if ((e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") && !e.nativeEvent.isComposing) {
      const typed = typedRecipient(query);
      const chosen = found.length ? found[at] : null;
      if (e.key !== "," && e.key !== ";" && chosen) {
        e.preventDefault();
        add(asRecipient(chosen));
      } else if (typed) {
        e.preventDefault();
        add(typed);
      } else if (e.key === "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && query === "" && list.length) {
      onChange(list.slice(0, -1));
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
    }
  };
  const size = touch ? "var(--phone-text-body)" : 12;
  // The words are capitalised, as iOS and macOS write them.
  const label = { to: "To", cc: "Cc", bcc: "Bcc" }[row];
  return (
    <div className="loki-mail-row">
      <Meta style={{ width: 28, flex: "none" }}>{label}</Meta>
      <div className="loki-mail-row-chips">
        {list.map((entry, i) => (
          <Chip
            key={addressOf(entry)}
            touch={touch}
            title={addressOf(entry)}
            onClick={() => onChange(list.filter((_, j) => j !== i))}
            aria-label={`Remove ${recipientName(entry)}`}
          >
            {recipientName(entry)}{" "}
            <span aria-hidden>
              <Glyph icon={XIcon} size={12} inline />
            </span>
          </Chip>
        ))}
        <div style={{ position: "relative", flex: 1, minWidth: 120 }}>
          <Field
            bare
            size={touch ? "touch" : "sm"}
            value={query}
            autoFocus={autoFocus}
            aria-label={`Add someone to ${label}`}
            placeholder={list.length ? "" : "Name or address"}
            onChange={(e) => {
              setQuery(e.target.value);
              setPick(0);
            }}
            onKeyDown={keys}
            onFocus={() => onTyping?.(true)}
            onBlur={() => {
              onTyping?.(false);
              // A whole address left in the field when it loses focus is taken, as Gmail does.
              const typed = typedRecipient(query);
              if (typed) add(typed);
            }}
            style={{ fontSize: size, width: "100%" }}
          />
          {found.length > 0 && (
            <div className="loki-mail-suggest" role="listbox" aria-label="suggestions">
              {found.map((p, i) => (
                <button
                  key={p.address}
                  type="button"
                  role="option"
                  aria-selected={i === at}
                  className="loki-mail-suggest-row"
                  // Before the field's blur, so the pick is the person and not what was typed.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    add(asRecipient(p));
                  }}
                >
                  <span className="loki-mail-suggest-name">{p.name || p.address}</span>
                  {p.name && <Meta>{p.address}</Meta>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The recipients line. Collapsed it is one line: the mode, whom the reply goes to, and a press opens it. Open, it is the
 * mode and From, then the To, Cc and Bcc rows. Without `compose` (still read, or it failed) it says the reply goes to
 * all, as before plan 076.
 */
export function MailAddressLine({
  compose,
  value,
  onChange,
  open,
  onOpen,
  onTyping,
  touch = false,
  disabled = false,
  full = true,
}: {
  compose: MailCompose | null;
  value: MailAddressing | null;
  onChange: (a: MailAddressing) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  onTyping?: (typing: boolean) => void;
  touch?: boolean;
  disabled?: boolean;
  /** The mode, From and Bcc; the phone draws To and Cc only. */
  full?: boolean;
}) {
  if (!compose) return <Meta>Reply to all</Meta>;
  const a = value ?? startAddressing(compose);
  const taken = new Set([...a.to, ...a.cc, ...a.bcc].map(addressOf));
  const set = (patch: Partial<MailAddressing>) => onChange({ ...a, ...patch });
  // Capitalised; on the Mac a control's own name is title case ("Reply All"), on the phone a sentence.
  const word = sentence;
  const control = (s: string) => (touch ? sentence(s) : s.replace(/(^|\s)([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase()));
  const selectStyle = {
    font: "inherit",
    fontSize: touch ? "var(--phone-text-body)" : "var(--loki-text-meta)",
    color: "var(--loki-fg)",
    background: "transparent",
    border: "none",
  };
  const lead = (
    <>
      {full && (
        <select
          aria-label={word("how it is sent")}
          value={a.mode}
          disabled={disabled}
          onChange={(e) => onChange(addressingFor(compose, e.target.value as MailMode, a))}
          style={selectStyle}
        >
          {MAIL_MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {control(m.word)}
            </option>
          ))}
        </select>
      )}
      {full && compose.from.length > 1 && open && (
        <select
          aria-label={word("from")}
          value={a.from ?? compose.default_from}
          disabled={disabled}
          onChange={(e) => set({ from: e.target.value })}
          style={selectStyle}
        >
          {compose.from.map((f) => (
            <option key={f.address} value={f.address}>
              {word("from")} {f.address}
            </option>
          ))}
        </select>
      )}
    </>
  );
  if (!open)
    return (
      <div className="loki-mail-line">
        {lead}
        <button
          type="button"
          className="loki-mail-line-who"
          disabled={disabled}
          onClick={() => onOpen(true)}
          title={touch ? undefined : "who it goes to: press to change"}
        >
          {word(addressSummary(a))}
        </button>
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-1)" : 2 }}>
      <div className="loki-mail-line">
        {lead}
        <span style={{ flex: 1 }} />
        <button type="button" className="loki-mail-line-who" onClick={() => onOpen(false)} style={{ flex: "none" }}>
          {control("done")}
        </button>
      </div>
      <RecipientRow row="to" list={a.to} people={compose.people} taken={taken} onChange={(to) => set({ to })} onTyping={onTyping} touch={touch} autoFocus />
      <RecipientRow row="cc" list={a.cc} people={compose.people} taken={taken} onChange={(cc) => set({ cc })} onTyping={onTyping} touch={touch} />
      {full && <RecipientRow row="bcc" list={a.bcc} people={compose.people} taken={taken} onChange={(bcc) => set({ bcc })} onTyping={onTyping} touch={touch} />}
    </div>
  );
}
