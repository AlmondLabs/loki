import type { ReactNode } from "react";
import type { ItemProperty } from "./item-view";

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
  extra?: ReactNode;
  titleAs?: "h1" | "h2";
  onOpen?: () => void;
  openTitle?: string;
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

export interface ToolbarMove {
  label: string;
  icon?: ReactNode;
  run: () => void;
  title?: string;
  disabled?: boolean;
  prominent?: boolean;
}

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
