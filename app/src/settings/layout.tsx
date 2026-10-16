import { Chip, Title, sentence } from "../components";

/** A row of chips, one of which is chosen: a setting with a few named values. */
export function Choice<T extends string>({
  options,
  value,
  onPick,
  labels = {},
}: {
  options: T[];
  value: T;
  onPick: (v: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      {options.map((o) => (
        <Chip key={o} label active={value === o} onClick={() => onPick(o)} aria-pressed={value === o}>
          {labels[o] ?? o}
        </Chip>
      ))}
    </span>
  );
}

/** One block of a Preferences page: its title and hint on the left, its facts on the right, behind a rule. */
export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "6px 24px", alignItems: "start" }}>
      <div style={{ paddingTop: 2 }}>
        <Title>{title}</Title>
        {hint && (
          <div className="loki-meta loki-meta--wrap" style={{ marginTop: 4, lineHeight: 1.45 }}>
            {sentence(hint)}
          </div>
        )}
      </div>
      <div style={{ display: "grid", gap: 6, borderLeft: "1px solid var(--loki-border)", paddingLeft: 20 }}>{children}</div>
    </section>
  );
}

/** One line of a section: a label and its value (mono for paths and ids). */
export function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "baseline", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label">{label}</span>
      <span style={{ color: "var(--loki-fg)", fontFamily: mono ? "var(--loki-mono)" : undefined, fontSize: mono ? 12 : 13.5, overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
}
