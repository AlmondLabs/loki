import { Button, Kbd, Meta, Sheet } from "../components";
import { KEYMAP, formatKeys, type Binding, type Segment, type Where } from "./keymap";

/**
 * The cheat sheet: `?` anywhere (outside a text box) lists the keys that work in the view showing — its own first,
 * then the ones that work everywhere — and closes on `?` or Escape. The rows are the keymap's (keymap.ts), so
 * the sheet cannot drift from the handler or the menu; the full table with the global key lives in Settings › keys.
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
          <span style={{ fontFamily: "var(--loki-display)", fontSize: 22 }}>keys</span>
          <Meta>{segment}</Meta>
          <span style={{ flex: 1 }} />
          <Meta>? or esc closes</Meta>
        </div>
        {groups.map((g) => (
          <section key={g.where} aria-label={g.title} style={{ display: "grid", gap: 4 }}>
            <div className="loki-label" style={{ fontSize: 9.5 }}>{g.title}</div>
            {g.rows.map((b) => (
              <div key={b.id} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 12, alignItems: "baseline", fontSize: 13.5 }}>
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  {b.keys.map((k) => (
                    <Kbd key={k}>{formatKeys(k)}</Kbd>
                  ))}
                </span>
                <span style={{ color: "var(--loki-fg)" }}>
                  {b.label}
                  {!b.typing && !b.note && (segment === "inbox" || segment === "desk") && <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--loki-muted)" }}>not while typing</span>}
                </span>
              </div>
            ))}
          </section>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Meta wrap>the whole table, and the system-wide key, are in Settings › keys</Meta>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={onSettings} kbd="⌘6">open</Button>
        </div>
      </div>
    </Sheet>
  );
}

/** The groups the sheet shows for a segment: the view's own bindings (the desk's include the chat box's), then "anywhere". */
export function keysFor(segment: Segment, map: Binding[] = KEYMAP): Array<{ where: Where; title: string; rows: Binding[] }> {
  const wheres: Where[] = segment === "desk" ? ["desk", "chat", "anywhere"] : [segment, "anywhere"];
  return wheres.map((where) => ({ where, title: TITLE[where] ?? where, rows: map.filter((b) => b.where === where) })).filter((g) => g.rows.length > 0);
}

const TITLE: Partial<Record<Where, string>> = { anywhere: "everywhere in loki", chat: "the message box", desk: "on the desk", inbox: "in the inbox", board: "on the board", learn: "in learn", agents: "in agents", settings: "in settings" };
