import { useState } from "react";
import { Button, Meta, Sheet } from "../components";

export function GoalDiscoverSheet({
  agents,
  initialAgentId,
  onStart,
  onClose,
}: {
  agents: ReadonlyArray<{ id: string; name: string }>;
  initialAgentId: string | null;
  onStart: (agentId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [starting, setStarting] = useState<string | null>(null);

  const pick = async (agentId: string) => {
    if (starting) return;
    setStarting(agentId);
    try {
      await onStart(agentId);
    } finally {
      setStarting(null);
    }
  };

  return (
    <Sheet label="Discover goals" onClose={onClose} width={420} top="14vh" scroll>
      <div className="grid gap-4" style={{ padding: 20 }}>
        <div className="grid gap-1">
          <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>Discover goals</div>
          <Meta wrap>Choose which agent to map your short, medium, and long term goals with. Any goals you save are shared across all agents.</Meta>
        </div>

        <div className="grid gap-1">
          {agents.map((agent) => (
            <button key={agent.id} type="button" className="loki-goal-subrow" disabled={Boolean(starting)} onClick={() => void pick(agent.id)}>
              <span className="loki-truncate">{agent.name}</span>
              {starting === agent.id ? <Meta>Starting…</Meta> : agent.id === initialAgentId ? <Meta>Default</Meta> : null}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={Boolean(starting)}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
