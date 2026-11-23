import type { SlackReaction } from "../../../core/frame-types.ts";
import { Button } from "@/ui/button";
import { Emoji } from "../desk/slack-reactions";

const slackTitle = (r: SlackReaction) => `:${r.name}:`;

export const emojiTitle = (r: SlackReaction) => r.emoji?.text ?? r.name;

export function Reactions({
  reactions,
  onToggle,
  title = slackTitle,
}: {
  reactions: readonly SlackReaction[];
  onToggle?: (r: SlackReaction) => void;
  title?: (r: SlackReaction) => string;
}) {
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
          title={title(r)}
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
