import { useState } from "react";
import { harnessOf, type ModelEntry } from "../../../core/models.ts";
import { ModelChoices, modelName, type PickerView } from "../chat/model-picker";
import { Button, Popover } from "../components";
import { Icon } from "../shared/icons";
import "../chat/chat.css";

export function ModelSelect({
  value,
  entries,
  onLoad,
  onPick,
  allowDefault = false,
  anchor = "right",
  ariaLabel = "Model",
}: {
  value: string;
  entries: ModelEntry[] | null;
  onLoad: () => void;
  onPick: (handle: string) => void;
  allowDefault?: boolean;
  anchor?: "left" | "right";
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("models");
  const [harness, setHarness] = useState<string | null>(() => harnessOf(value || null));
  const [query, setQuery] = useState("");

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setView("models");
      setQuery("");
      setHarness(harnessOf(value || null));
      if (!entries) onLoad();
    }
  };

  const label = value ? modelName(entries, value) : "Harness default";

  return (
    <Popover
      open={open}
      onOpenChange={handleOpen}
      role="dialog"
      aria-label={ariaLabel}
      anchor={anchor}
      width={340}
      trigger={
        <Button size="sm" tone="paper" aria-label={ariaLabel} aria-expanded={open} style={{ maxWidth: 260 }}>
          <span className="loki-truncate">{label}</span>
          <Icon name="chevron-down" size={12} />
        </Button>
      }
    >
      <div style={{ maxHeight: "min(460px, 65vh)", display: "flex", flexDirection: "column" }}>
        <ModelChoices
          view={view}
          entries={entries}
          current={value || null}
          currentEffort={null}
          started={false}
          harness={harness}
          loading={entries === null}
          query={query}
          scopeLabel="Default for this agent"
          onView={setView}
          onHarness={setHarness}
          onQuery={setQuery}
          onPick={(selection) => {
            onPick(selection.handle);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
        {allowDefault && value && (
          <div className="flex justify-end" style={{ padding: "4px 8px", borderTop: "1px solid var(--loki-border)" }}>
            <Button
              size="sm"
              bare
              onClick={() => {
                onPick("");
                setOpen(false);
              }}
            >
              Use Harness Default
            </Button>
          </div>
        )}
      </div>
    </Popover>
  );
}
