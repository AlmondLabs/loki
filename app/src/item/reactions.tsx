import type { SlackReaction } from "../../../core/frame-types.ts";
import { Button } from "@/ui/button";
import { Emoji } from "../desk/slack-reactions";

export function Reactions({ reactions, onToggle }: { reactions: readonly SlackReaction[]; onToggle?: (r: SlackReaction) => void }) {
  if (reactions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-reactions>
      {reactions.map((r) => (
        <Button
          key={r.name}
          variant="outline"
          size="xs"
          className="gap-1 rounded-full px-2 tabular-nums data-[mine=true]:border-ring data-[mine=true]:bg-accent"
          data-mine={r.mine ? "true" : undefined}
          disabled={!onToggle}
          title={`:${r.name}:`}
          aria-pressed={r.mine}
          onClick={() => onToggle?.(r)}
        >
          <Emoji emoji={r.emoji} name={r.name} />
          {r.count}
        </Button>
      ))}
    </div>
  );
}
