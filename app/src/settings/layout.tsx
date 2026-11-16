import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button, sentence } from "../components";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";

export function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-6" style={{ padding: "12px 0" }}>
      <div className="flex-none" style={{ minWidth: 120, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--loki-fg)" }}>
        {label}
      </div>
      <div
        className={cn(mono && "loki-mono", "flex-1 min-w-0")}
        style={{
          textAlign: "right",
          color: "var(--loki-fg)",
          fontSize: mono ? "var(--text-xs)" : "var(--text-sm)",
          lineHeight: 1.5,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function Block({ title, help, children }: { title?: string; help?: string; children: React.ReactNode }) {
  return (
    <section className="grid">
      {title && (
        <h4 className="loki-title" style={{ margin: "0 0 8px", fontSize: "var(--text-sm)" }}>
          {title}
        </h4>
      )}
      <div className="loki-settings-block">{children}</div>
      {help && (
        <div className="loki-meta loki-meta--wrap" style={{ marginTop: 8, paddingInline: 12, lineHeight: 1.45 }}>
          {sentence(help)}
        </div>
      )}
    </section>
  );
}

export function Setting({ label, help, mono = false, children }: { label: string; help?: React.ReactNode; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-6" style={{ padding: "12px 0", minHeight: 32 }}>
      <div className="flex-1 min-w-0">
        <div
          className={mono ? "loki-mono" : undefined}
          style={
            mono
              ? { fontSize: "var(--text-xs)", color: "var(--loki-fg)", overflowWrap: "anywhere" }
              : { fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--loki-fg)" }
          }
        >
          {label}
        </div>
        {help && (
          <div className="loki-meta loki-meta--wrap" style={{ marginTop: 2, lineHeight: 1.45 }}>
            {help}
          </div>
        )}
      </div>
      {children !== undefined && <div className="flex-none flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onPick,
  labels = {},
  label,
}: {
  options: readonly T[];
  value: T;
  onPick: (v: T) => void;
  labels?: Partial<Record<T, string>>;
  label: string;
}) {
  return (
    <span role="group" aria-label={label} className="loki-segmented">
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onPick(o)}>
          {labels[o] ?? o}
        </button>
      ))}
    </span>
  );
}

export function PopUp<T extends string>({
  options,
  value,
  onPick,
  labels = {},
  label,
}: {
  options: readonly T[];
  value: T;
  onPick: (v: T) => void;
  labels?: Partial<Record<T, string>>;
  label: string;
}) {
  const items = options.map((o) => ({ value: o, label: labels[o] ?? o }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v) => {
        const picked = options.find((o) => o === v);
        if (picked) onPick(picked);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        className="min-w-24 bg-loki-segment shadow-low ring-1 ring-loki-glass-edge border-transparent dark:bg-loki-segment"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((it) => (
          <SelectItem key={it.value} value={it.value}>
            {it.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="grid">
      <div className="flex items-center gap-2">
        <h4 className="loki-title flex-1" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
          {title}
        </h4>
        <Button size="sm" bare onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && <div className="loki-settings-block">{children}</div>}
    </section>
  );
}
