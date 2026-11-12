import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/utils";
import type { ItemFlag, ItemHeaderView, ItemProperty } from "./item-view";

/** How each flag reads on screen; the unread one carries the attention dot. */
const FLAG_WORDS: Record<ItemFlag, string> = { unread: "unread", mentions_you: "mentions you", changed: "changed" };

/** A property's tone as its dot's colour. */
const TONE_DOT: Record<NonNullable<ItemProperty["tone"]>, string> = {
  attention: "bg-loki-attention",
  negative: "bg-loki-negative",
  positive: "bg-loki-positive",
};

/**
 * The item's header (plan 097, ItemHeader): its title on one line, cut with an ellipsis and whole on hover (R3), the
 * flags that hold beside it (R4), then its properties as chips, with the surface's own words after them (when, where
 * it went). An editable property is a button only where the surface has its picker; elsewhere it is a plain chip, so
 * nothing on screen promises a menu that does not open. The item's moves are not here: the ActionBar sits under the
 * box, beside the reply it goes with.
 */
export function ItemHeader({
  view,
  lead,
  meta,
  actions,
  onProperty = {},
  titleAs: Title = "h2",
  className,
}: {
  view: ItemHeaderView;
  /** A face before the title: the agent's, the sender's. */
  lead?: ReactNode;
  /** The surface's words after the properties: when, the account, where it went before, the last move's flash. */
  meta?: ReactNode;
  /** A surface's own controls at the end of the line: the chat pane's Canvas menu. Not the item's moves. */
  actions?: ReactNode;
  /** The pickers this surface has, by property: today's labels, folder and Jira pickers. */
  onProperty?: Partial<Record<ItemProperty["key"], () => void>>;
  /** The title's heading level: h1 where it names the pane, as the chat pane's does. */
  titleAs?: "h1" | "h2";
  className?: string;
}) {
  return (
    <div data-item-header className={cn("flex min-w-0 items-start gap-3 px-4 py-3", className)}>
      {lead && <span className="shrink-0">{lead}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Title data-item-title className="m-0 min-w-0 truncate text-card font-semibold text-foreground" title={view.title}>
            {view.title}
          </Title>
          {view.flags.map((f) => (
            <Badge key={f} variant={f === "unread" ? "outline" : "secondary"} data-flag={f}>
              {f === "unread" && <span aria-hidden className="size-1.5 rounded-full bg-loki-attention" />}
              {FLAG_WORDS[f]}
            </Badge>
          ))}
        </div>
        {(view.properties.length > 0 || meta) && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            {view.properties.map((p) => (
              <PropertyChip key={p.key} property={p} onPick={p.editable ? onProperty[p.key] : undefined} />
            ))}
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/** One property: a chip with its tone's dot; with a picker, a button that opens it. */
function PropertyChip({ property: p, onPick }: { property: ItemProperty; onPick: (() => void) | undefined }) {
  const body = (
    <>
      {p.tone && <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[p.tone])} />}
      <span className="max-w-64 truncate">{p.label}</span>
    </>
  );
  if (!onPick)
    return (
      <Badge variant="outline" data-property={p.key} title={p.label} className="font-normal text-muted-foreground">
        {body}
      </Badge>
    );
  return (
    <Badge
      variant="outline"
      data-property={p.key}
      title={p.label}
      className="cursor-pointer font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
      render={<button type="button" aria-haspopup="dialog" onClick={onPick} />}
    >
      {body}
      <ChevronDownIcon data-icon="inline-end" />
    </Badge>
  );
}
