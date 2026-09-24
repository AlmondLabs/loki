import { useEffect, useRef, useState } from "react";
import { Kbd, Row } from "../components";
import { keyboard, type Platform } from "../desk/env";
import { KEYMAP, formatKeys, keyFor, keysOf, labelOf, menuSpec, runAction, type Binding } from "./keymap";

/** A line of a ☰ menu: a keymap id, its label and its key as this system reads it (null where the Mac's menu shows none). */
export interface TitleMenuEntry {
  id: string;
  label: string;
  keys: string | null;
}
export interface TitleMenuGroup {
  title: string;
  items: Array<TitleMenuEntry | { separator: true }>;
}

const HIDE = "window.hide";

/**
 * The Mac's menu bar as ☰ shows it on Windows and Linux (plan 014 KTD4): the same menuSpec groups, in order, their keys
 * in Ctrl words. An item without an accelerator on the Mac shows none here either.
 */
export function titleMenus(os: Platform = keyboard, map: Binding[] = KEYMAP): TitleMenuGroup[] {
  return menuSpec(map, os).map((m) => ({
    title: m.title,
    items: m.items.map((it) => {
      if ("separator" in it) return it;
      const b = map.find((x) => x.id === it.id);
      const k = b && it.accelerator ? keysOf(b, os)[0] : undefined;
      return { id: it.id, label: it.label, keys: k ? formatKeys(k, os) : null };
    }),
  }));
}

/** A ☰ pick: the action the Mac's menu click runs (useShellKeys, loki:menu), straight through the registry. */
export function runMenuItem(id: string): void {
  if (!runAction(id)) console.warn("loki: menu item without an action", id);
}

/**
 * The menu itself, without state: the titles, then Hide loki (Minimise loki there, labelOf); beside them the open title's items. Pointing at a
 * title opens it, as a menu bar's does.
 */
export function TitleMenuPanel({ groups, open, onOpen, onPick, os = keyboard }: { groups: TitleMenuGroup[]; open: string | null; onOpen: (title: string | null) => void; onPick: (id: string) => void; os?: Platform }) {
  const current = groups.find((g) => g.title === open) ?? null;
  return (
    <>
      <div role="menu" aria-label="loki" className="loki-title-menu-panel">
        {groups.map((g) => (
          <Row key={g.title} dense role="menuitem" aria-haspopup="menu" aria-expanded={open === g.title} data-menu={g.title} selected={open === g.title} className="loki-title-menu-item" onClick={() => onOpen(g.title)} onPointerEnter={() => onOpen(g.title)}>
            <span>{g.title}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <path d="M3.5 2l3 3-3 3" />
            </svg>
          </Row>
        ))}
        <div role="separator" className="loki-title-menu-sep" />
        <Row dense role="menuitem" data-menu-id={HIDE} className="loki-title-menu-item" onClick={() => onPick(HIDE)} onPointerEnter={() => onOpen(null)}>
          <span>{labelOf(KEYMAP.find((b) => b.id === HIDE)!, os)}</span>
          <Kbd>{keyFor(HIDE, os)}</Kbd>
        </Row>
      </div>
      {current && (
        <div role="menu" aria-label={current.title} className="loki-title-menu-panel loki-title-submenu">
          {current.items.map((it, i) =>
            "separator" in it ? (
              <div key={`sep-${i}`} role="separator" className="loki-title-menu-sep" />
            ) : (
              <Row key={it.id} dense role="menuitem" data-menu-id={it.id} className="loki-title-menu-item" onClick={() => onPick(it.id)}>
                <span>{it.label}</span>
                {it.keys && <Kbd>{it.keys}</Kbd>}
              </Row>
            ),
          )}
        </div>
      )}
    </>
  );
}

const items = (panel: Element | null | undefined) => [...(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

/**
 * ☰ and its menu, at the strip's left end on Windows and Linux. The header menus' manners (DeskPane): focus goes in,
 * ↑↓ move, → or Enter opens a title's menu and ← or Esc goes back to it, Esc on the titles closes, a press outside
 * closes, and focus returns to ☰.
 */
export function TitleMenu({ os = keyboard }: { os?: Platform }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <span className="loki-title-menu-anchor">
      <button type="button" className="loki-title-btn loki-title-btn--menu" aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
          <path d="M3 4.5h10M3 8h10M3 11.5h10" />
        </svg>
      </button>
      {menuOpen && (
        <TitleMenuPopover
          os={os}
          onPick={(id) => {
            setMenuOpen(false);
            runMenuItem(id);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </span>
  );
}

function TitleMenuPopover({ os, onPick, onClose }: { os: Platform; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** Bumped when the keyboard opens a title: its menu's first item takes the focus once it shows. */
  const [enter, setEnter] = useState(0);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const node = ref.current;
    const anchor = node?.parentElement ?? null;
    items(node?.firstElementChild)[0]?.focus();
    const away = (e: PointerEvent) => {
      if (!anchor?.contains(e.target as Node)) closeRef.current();
    };
    // capture phase: the rail and the list column stop pointerdown from bubbling, and a press there must still close it
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      const a = document.activeElement;
      if (!a || a === document.body || node?.contains(a)) anchor?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (enter) items(ref.current?.querySelector(".loki-title-submenu"))[0]?.focus();
  }, [enter]);
  const titles = () => ref.current?.firstElementChild;
  const focusTitle = (t: string | null) => (t ? items(titles()).find((el) => el.dataset.menu === t)?.focus() : undefined);
  return (
    <div
      ref={ref}
      className="loki-title-menu"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const here = (document.activeElement as HTMLElement | null)?.closest('[role="menu"]') ?? null;
        const inSub = !!here?.classList.contains("loki-title-submenu");
        const all = items(here);
        const i = all.indexOf(document.activeElement as HTMLElement);
        const title = (document.activeElement as HTMLElement | null)?.dataset.menu;
        if (e.key === "ArrowDown") all[(i + 1) % all.length]?.focus();
        else if (e.key === "ArrowUp") all[(i - 1 + all.length) % all.length]?.focus();
        else if ((e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") && title) {
          setOpen(title);
          setEnter((n) => n + 1);
        } else if ((e.key === "ArrowLeft" || e.key === "Escape") && inSub) {
          focusTitle(open);
          setOpen(null);
        } else if (e.key === "Escape") onClose();
        else if (e.key === "Tab") return onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <TitleMenuPanel groups={titleMenus(os)} open={open} onOpen={setOpen} onPick={onPick} os={os} />
    </div>
  );
}
