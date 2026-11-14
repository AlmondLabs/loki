import type { ReactNode } from "react";
import type { ItemProperty } from "./item-view";

/**
 * An item's title as a Mac toolbar draws it under Liquid Glass (plan 2026-11-12-1505, U13, U16): the name over a grey
 * line of its facts, joined by dots, the one that waits on you led by its dot. With `onOpen` the name is a button that
 * opens the item where it lives (a Flow card's chat), its key in the tooltip.
 */
export function ToolbarTitle({
  title,
  facts,
  extra,
  titleAs: Title = "h2",
  onOpen,
  openTitle,
  menu,
}: {
  title: string;
  facts: readonly ItemProperty[];
  /** More of the grey line after the facts: the chat's links, when and why it is here. */
  extra?: ReactNode;
  titleAs?: "h1" | "h2";
  onOpen?: () => void;
  openTitle?: string;
  /** The name as a menu of its own (Flow's lane switcher) in place of the plain name; `title` stays its tooltip. */
  menu?: ReactNode;
}) {
  return (
    <div className="loki-toolbar-title">
      <Title className="loki-toolbar-name" title={onOpen ? undefined : title}>
        {menu ??
          (onOpen ? (
            <button type="button" className="loki-toolbar-open" title={openTitle ?? title} onClick={onOpen}>
              {title}
            </button>
          ) : (
            title
          ))}
      </Title>
      <p className="loki-toolbar-sub">
        {facts.map((p, i) => (
          <span key={`${p.key}-${i}`}>
            {i > 0 && " · "}
            {p.tone === "attention" && <span aria-hidden className="loki-toolbar-dot" />}
            {p.label}
          </span>
        ))}
        {extra}
      </p>
    </div>
  );
}

/**
 * One of a toolbar group's items: a symbol whose name is said to a screen reader and shown, with its key, on hover; or,
 * without a symbol, its name in words (Sign In…).
 */
export interface ToolbarMove {
  label: string;
  icon?: ReactNode;
  run: () => void;
  /** The tooltip: the name and its key, or why the move is off. */
  title?: string;
  disabled?: boolean;
  /** The group's one prominent item, tinted as a Mac toolbar's (plan 2026-11-14-1330, R10): what finishes the item. */
  prominent?: boolean;
}

/** The item's moves as one glass group of symbols at the toolbar's trailing edge, as Mail's toolbar draws them. */
export function ToolbarGroup({ label, moves }: { label: string; moves: readonly ToolbarMove[] }) {
  return (
    <span className="loki-toolbar-group" role="group" aria-label={label}>
      {moves.map((m) => (
        <button
          key={m.label}
          type="button"
          className={["loki-toolbar-item", !m.icon && "loki-toolbar-item--text", m.prominent && "loki-toolbar-item--prominent"].filter(Boolean).join(" ")}
          aria-label={m.label}
          title={m.title ?? m.label}
          disabled={m.disabled}
          onClick={m.run}
        >
          {m.icon ?? m.label}
        </button>
      ))}
    </span>
  );
}
