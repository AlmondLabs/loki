import { Button, Kbd, Meta, Sheet, sentence } from "../components";
import { KEYMAP, formatKeys, keyFor, keysOf, takenBy, wasFor, type Binding, type Platform, type Segment, type Where } from "./keymap";
import { platform } from "../desk/env";

/**
 * The cheat sheet: `?` anywhere (outside a text box) lists the keys that work in the view showing — its own first,
 * then the ones that work everywhere — and closes on `?` or Escape. The rows are the keymap's (keymap.ts), so
 * the sheet cannot drift from the handler or the menu; the full table with the global key lives in Preferences › Keys.
 */
export function KeysSheet({ segment, onClose, onSettings }: { segment: Segment; onClose: () => void; onSettings: () => void }) {
  const groups = keysFor(segment);
  return (
    <Sheet label={`keys for ${segment}`} onClose={onClose} width={620}>
      <div
        style={{ display: "grid", gap: 16, padding: "18px 22px 16px" }}
        onKeyDown={(e) => {
          if (e.key === "?" && !(e.target instanceof HTMLInputElement)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 700 }}>Keys</span>
          <Meta>{segment}</Meta>
          <span style={{ flex: 1 }} />
          <Meta>? or esc closes</Meta>
        </div>
        {groups.map((g) => (
          <section key={g.where} aria-label={g.title} style={{ display: "grid", gap: 4 }}>
            <div className="loki-label">{g.title}</div>
            {g.rows.map((b) => (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 12, alignItems: "baseline", fontSize: 13.5 }}>
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  {b.keys.map((k) => (
                    <Kbd key={k}>{formatKeys(k)}</Kbd>
                  ))}
                </span>
                <span style={{ color: "var(--loki-fg)" }}>
                  {b.label}
                  {!b.typing && !b.note && (segment === "inbox" || segment === "desk") && <span className="loki-meta loki-meta--wrap" style={{ marginLeft: 8 }}>not while typing</span>}
                  {b.was && <span className="loki-meta loki-meta--wrap" style={{ display: "block" }}>{wasFor(b)}</span>}
                </span>
              </div>
            ))}
          </section>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Meta wrap>the whole table, and the system-wide key, are in Preferences › Keys</Meta>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={onSettings} kbd={keyFor("segment.settings", platform, 1)}>open</Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The groups the sheet shows for a segment: the view's own bindings (the desk's include the chat box's), then "anywhere"
 * — less the keys the view takes for itself (⌘⇧D is Deny in the inbox, listed there, not the sidebar). The rows carry
 * the system's own keys (keysOf).
 */
export function keysFor(segment: Segment, map: Binding[] = KEYMAP, os: Platform = platform): Array<{ where: Where; title: string; rows: Binding[] }> {
  const wheres: Where[] = segment === "desk" ? ["desk", "chat", "anywhere"] : [segment, "anywhere"];
  const here = (b: Binding): Binding | null => {
    const own = keysOf(b, os);
    const taken = b.where === "anywhere" ? new Set(takenBy(b, map, os).filter((t) => wheres.includes(t.where)).map((t) => t.key)) : new Set<string>();
    const keys = own.filter((k) => !taken.has(k));
    return keys.length === 0 ? null : own === b.keys && keys.length === own.length ? b : { ...b, keys };
  };
  return wheres.map((where) => ({ where, title: TITLE[where] ?? sentence(where), rows: map.filter((b) => b.where === where).flatMap((b) => here(b) ?? []) })).filter((g) => g.rows.length > 0);
}

const TITLE: Partial<Record<Where, string>> = { anywhere: "Everywhere in loki", chat: "The message box", desk: "On the desk", inbox: "In the inbox", board: "On the board", learn: "In Learn", agents: "In Agents", settings: "In Settings" };
