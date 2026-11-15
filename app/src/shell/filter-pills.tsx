import type { LucideIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { cn } from "@/lib/utils";

/** One pill: the value it picks, its name and its symbol. */
export interface FilterPill<V extends string> {
  value: V;
  label: string;
  icon: LucideIcon;
}

/**
 * A list's filter pills (plans 2026-11-15-1523 and 2026-11-15-1740), in Mail's shape: the chosen one a filled capsule
 * with its symbol and name, the others grey circles with their symbol alone, each named for a screen reader and in its
 * tooltip. shadcn's ToggleGroup on Base UI, one pressed at a time. Chats' states and Flow's kinds both draw it.
 */
export function FilterPills<V extends string>({ pills, value, onValue }: { pills: ReadonlyArray<FilterPill<V>>; value: V; onValue: (value: V) => void }) {
  return (
    <ToggleGroup
      aria-label="Show"
      spacing={2}
      value={[value]}
      onValueChange={(v: unknown[]) => {
        const next = pills.find((p) => p.value === v[0]);
        if (next) onValue(next.value);
      }}
    >
      {pills.map(({ value: v, label, icon: Mark }) => {
        const on = v === value;
        return (
          <ToggleGroupItem
            key={v}
            value={v}
            aria-label={label}
            title={label}
            className={cn(
              "h-7 rounded-full",
              on
                ? "bg-primary px-3 text-primary-foreground data-pressed:bg-primary data-pressed:text-primary-foreground"
                : "w-9 bg-loki-hover px-0 text-muted-foreground",
            )}
          >
            <Mark aria-hidden className="size-3.5" />
            {on && <span>{label}</span>}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
