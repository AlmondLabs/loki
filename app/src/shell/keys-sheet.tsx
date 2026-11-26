import { Button, Kbd, Meta, Sheet, sentence } from "../components";
import { KEYMAP, formatKeys, keyFor, keysOf, labelOf, takenBy, wasFor, type Binding, type Platform, type Segment, type Where } from "./keymap";
import { keyboard } from "../workspace/env";

export function KeysSheet({ segment, onClose, onSettings }: { segment: Segment; onClose: () => void; onSettings: () => void }) {
  const groups = keysFor(segment, KEYMAP, keyboard);
  const place = PLACE[segment] ?? sentence(segment);
  return (
    <Sheet label={`Keys for ${place}`} onClose={onClose} width={620} clear>
      <div
        className="grid gap-4"
        style={{ padding: "16px 24px", maxHeight: "inherit", boxSizing: "border-box", overflowY: "auto" }}
        onKeyDown={(e) => {
          if (e.key === "?" && !(e.target instanceof HTMLInputElement)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="flex items-baseline gap-3">
          <span style={{ fontSize: "var(--text-2xl)", fontWeight: 700 }}>Keys</span>
          <Meta>{place}</Meta>
          <span className="flex-1" />
        </div>
        {groups.map((g) => (
          <section key={g.where} aria-label={g.title} className="grid gap-1">
            <div className="loki-label">{g.title}</div>
            {g.rows.map((b) => (
              <div key={b.id} className="grid grid-cols-[170px_1fr] items-baseline gap-3" style={{ fontSize: "var(--text-sm)" }}>
                <span className="inline-flex flex-wrap gap-2">
                  {b.keys.map((k) => (
                    <Kbd key={k}>{formatKeys(k)}</Kbd>
                  ))}
                </span>
                <span style={{ color: "var(--loki-fg)" }}>
                  {sentence(b.label)}
                  {!b.typing && !b.note && (segment === "flow" || segment === "chats") && (
                    <span className="loki-meta loki-meta--wrap" style={{ marginLeft: 8 }}>
                      Not while typing
                    </span>
                  )}
                  {b.was && <span className="loki-meta loki-meta--wrap block">{wasFor(b)}</span>}
                </span>
              </div>
            ))}
          </section>
        ))}
        <div className="flex items-center gap-2">
          <Meta wrap>{sentence(keysSheetNote())}</Meta>
          <span className="flex-1" />
          <Button size="sm" onClick={onSettings} title={`Open Keys (${keyFor("segment.settings", keyboard, 1)})`}>
            Open
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function keysSheetNote(os: Platform = keyboard): string {
  return os === "macos" ? "the whole table, and the system-wide key, are in Preferences › Keys" : "the whole table is in Preferences › Keys";
}

export function keysFor(segment: Segment, map: Binding[] = KEYMAP, os: Platform = keyboard): Array<{ where: Where; title: string; rows: Binding[] }> {
  const wheres: Where[] = segment === "chats" ? ["chats", "chat", "anywhere"] : [segment, "anywhere"];
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
    const label = labelOf(b, os);
    return keys.length === 0 ? null : own === b.keys && keys.length === own.length && label === b.label ? b : { ...b, keys, label };
  };
  return wheres
    .map((where) => ({ where, title: TITLE[where] ?? sentence(where), rows: map.filter((b) => b.where === where).flatMap((b) => here(b) ?? []) }))
    .filter((g) => g.rows.length > 0);
}

const PLACE: Partial<Record<Segment, string>> = { chats: "Chats", flow: "Flow" };

const TITLE: Partial<Record<Where, string>> = {
  anywhere: "Everywhere in loki",
  chat: "The message box",
  chats: "In a chat",
  flow: "In Flow",
  learn: "In Learn",
  agents: "In Agents",
  settings: "In Settings",
};
