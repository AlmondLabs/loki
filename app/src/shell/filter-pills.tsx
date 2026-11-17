import type { LucideIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface FilterPill<V extends string> {
  value: V;
  label: string;
  icon: LucideIcon;
}

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
