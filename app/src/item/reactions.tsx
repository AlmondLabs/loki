import type { SlackReaction } from "../../../core/frame-types.ts";
import { Button } from "@/ui/button";
import { Emoji } from "../workspace/slack-reactions";

const slackTitle = (r: SlackReaction) => `:${r.name}:`;

export const emojiTitle = (r: SlackReaction) => r.emoji?.text ?? r.name;

const KEPT = "A mail reaction can't be taken back";

export function Reactions({
  reactions,
  onToggle,
  title = slackTitle,
  undoable = true,
}: {
  reactions: readonly SlackReaction[];
  onToggle?: (r: SlackReaction) => void;
  title?: (r: SlackReaction) => string;
  undoable?: boolean;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-reactions>
      {reactions.map((r) => {
        const kept = !undoable && r.mine && !!onToggle;
        return (
          <Button
            key={r.name}
            variant="outline"
            size="xs"
            className="gap-1 rounded-full px-2 tabular-nums data-[mine=true]:border-ring data-[mine=true]:bg-accent aria-disabled:cursor-default"
            data-mine={r.mine ? "true" : undefined}
            disabled={!onToggle}
            aria-disabled={kept || undefined}
            title={kept ? KEPT : title(r)}
            aria-pressed={r.mine}
            onClick={() => {
              if (!kept) onToggle?.(r);
            }}
          >
            <Emoji emoji={r.emoji} name={r.name} />
            {r.count}
          </Button>
        );
      })}
    </div>
  );
}
