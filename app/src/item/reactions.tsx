import type { SlackReaction } from "../../../core/frame-types.ts";
import { Button } from "@/ui/button";
import { Emoji } from "../desk/slack-reactions";

/**
 * An entry's reactions (plan 097, Reactions): each emoji with how many reacted, the person's own outlined in the accent;
 * pressing one toggles theirs where the source lets loki react. An entry without reactions draws nothing at all, so a
 * source that has none (an agent chat, an email, a Jira comment) never shows an empty footer.
 */
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
