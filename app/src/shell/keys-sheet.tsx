import { Button, Kbd, Meta, Sheet, sentence } from "../components";
import { KEYMAP, formatKeys, keyFor, keysOf, labelOf, takenBy, wasFor, type Binding, type Platform, type Segment, type Where } from "./keymap";
import { keyboard } from "../desk/env";
import { useLook, type Look } from "../theme";

/**
 * The cheat sheet: `?` anywhere (outside a text box) lists the keys that work in the view showing — its own first,
 * then the ones that work everywhere — and closes on `?` or Escape. The rows are the keymap's (keymap.ts), so
 * the sheet cannot drift from the handler or the menu; the full table with the global key lives in Preferences › Keys.
 * Under Liquid Glass (plan 2026-11-12-1505, U20) it is a plain panel that dims nothing behind it: the menu bar carries
 * the keys, and this is the list of them for the view, named as the sidebar names it.
 */
export function KeysSheet({ segment, onClose, onSettings }: { segment: Segment; onClose: () => void; onSettings: () => void }) {
  const glass = useLook() === "glass";
  const groups = keysFor(segment, KEYMAP, keyboard, glass ? "glass" : "classic");
  const place = glass ? (PLACE[segment] ?? sentence(segment)) : segment;
  return (
    <Sheet label={glass ? `Keys for ${place}` : `keys for ${segment}`} onClose={onClose} width={620} clear={glass}>
      <div
        // The card caps its height and clips; the list scrolls inside it, so a view with many keys shows them all.
        style={{ display: "grid", gap: 16, padding: "18px 22px 16px", maxHeight: "inherit", boxSizing: "border-box", overflowY: "auto" }}
        onKeyDown={(e) => {
          if (e.key === "?" && !(e.target instanceof HTMLInputElement)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: "var(--loki-text-display)", fontWeight: 700 }}>Keys</span>
          <Meta>{place}</Meta>
          <span style={{ flex: 1 }} />
          {!glass && <Meta>? or esc closes</Meta>}
        </div>
        {groups.map((g) => (
          <section key={g.where} aria-label={g.title} style={{ display: "grid", gap: 4 }}>
            <div className="loki-label">{g.title}</div>
            {g.rows.map((b) => (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 12, alignItems: "baseline", fontSize: "var(--loki-text-body)" }}>
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  {b.keys.map((k) => (
                    <Kbd key={k}>{formatKeys(k)}</Kbd>
                  ))}
                </span>
                <span style={{ color: "var(--loki-fg)" }}>
                  {glass ? sentence(b.label) : b.label}
                  {!b.typing && !b.note && (segment === "inbox" || segment === "desk") && (
                    <span className="loki-meta loki-meta--wrap" style={{ marginLeft: 8 }}>
                      {glass ? "Not while typing" : "not while typing"}
                    </span>
                  )}
                  {b.was && (
                    <span className="loki-meta loki-meta--wrap" style={{ display: "block" }}>
                      {wasFor(b)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </section>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Meta wrap>{glass ? sentence(keysSheetNote()) : keysSheetNote()}</Meta>
          <span style={{ flex: 1 }} />
          {glass ? (
            <Button size="sm" onClick={onSettings} title={`Open Keys (${keyFor("segment.settings", keyboard, 1)})`}>
              Open
            </Button>
          ) : (
            <Button size="sm" onClick={onSettings} kbd={keyFor("segment.settings", keyboard, 1)}>
              open
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** The footer's pointer to Preferences › Keys; the system-wide key is there on the Mac only (R3). */
export function keysSheetNote(os: Platform = keyboard): string {
  return os === "macos" ? "the whole table, and the system-wide key, are in Preferences › Keys" : "the whole table is in Preferences › Keys";
}

/**
 * The groups the sheet shows for a segment: the view's own bindings (the desk's include the chat box's), then "anywhere"
 * — less the keys the view takes for itself (⌘⇧D is Deny in the inbox, listed there, not the sidebar). The rows carry
 * the system's own keys (keysOf).
 */
export function keysFor(
  segment: Segment,
  map: Binding[] = KEYMAP,
  os: Platform = keyboard,
  look: Look = "classic",
): Array<{ where: Where; title: string; rows: Binding[] }> {
  const wheres: Where[] = segment === "desk" ? ["desk", "chat", "anywhere"] : [segment, "anywhere"];
  const here = (b: Binding): Binding | null => {
    const own = keysOf(b, os);
    const taken =
      b.where === "anywhere"
        ? new Set(
            takenBy(b, map, os)
              .filter((t) => wheres.includes(t.where))
              .map((t) => t.key),
          )
        : new Set<string>();
    const keys = own.filter((k) => !taken.has(k));
    const label = labelOf(b, os, look);
    return keys.length === 0 ? null : own === b.keys && keys.length === own.length && label === b.label ? b : { ...b, keys, label };
  };
  return wheres
    .map((where) => ({ where, title: TITLE[where] ?? sentence(where), rows: map.filter((b) => b.where === where).flatMap((b) => here(b) ?? []) }))
    .filter((g) => g.rows.length > 0);
}

/** A section as the Liquid Glass sidebar names it, where that differs from its id. */
const PLACE: Partial<Record<Segment, string>> = { desk: "Chats", inbox: "Flow" };

const TITLE: Partial<Record<Where, string>> = {
  anywhere: "Everywhere in loki",
  chat: "The message box",
  desk: "In a chat",
  inbox: "In Flow",
  learn: "In Learn",
  agents: "In Agents",
  settings: "In Settings",
};
