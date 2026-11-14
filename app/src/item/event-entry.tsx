import { useContext, useState } from "react";
import { CircleDotIcon, CornerUpLeftIcon, RefreshCwIcon } from "lucide-react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { COMPACTED_TEXT } from "../../../core/attention/thread.ts";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/ui/ai-elements/checkpoint";
import { Marker, MarkerContent, MarkerIcon } from "@/ui/marker";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/ui/trace";
import { clockLabel } from "../shared/thread";
import { EventDetail } from "../chat/tool-steps";
import { OpenChat, SUGGESTED, suggestedSource } from "../chat/transcript";

/** A calendar day opening in the thread: "Today", "Yesterday", a date, between two hairlines. */
export function DayMarker({ label }: { label: string }) {
  return (
    <Marker variant="separator" role="separator" aria-label={label} className="text-meta font-semibold">
      <MarkerContent>{label}</MarkerContent>
    </Marker>
  );
}

/** The first thing you have not seen: "New" on a hairline in the attention colour, with the day where rows carry no times. */
export function NewMarker({ day }: { day: string | null }) {
  return (
    <Marker
      variant="separator"
      role="separator"
      aria-label={day ? `New since you last looked, ${day}` : "New since you last looked"}
      className="text-meta font-semibold text-loki-attention before:bg-loki-attention after:bg-loki-attention"
    >
      <MarkerContent>{day ? `${day} · New` : "New"}</MarkerContent>
    </Marker>
  );
}

/**
 * Something that changed in an outside item (plan 097, EventEntry): a Jira field set, a status moved, as one quiet line
 * with who did it and when.
 */
export function ChangeEntry({ who, text, at }: { who: string | null; text: string; at: string }) {
  const time = clockLabel(at);
  return (
    <Marker data-row="event">
      <MarkerIcon>
        <CircleDotIcon />
      </MarkerIcon>
      <MarkerContent>
        {who && <span className="font-semibold text-foreground">{who} </span>}
        {text}
        {time && <time dateTime={at}> · {time}</time>}
      </MarkerContent>
    </Marker>
  );
}

/**
 * A harness event as one quiet line (plan 097, EventEntry: a background task finishing, a skill loaded); with a detail,
 * it opens to it, a lean one's fetched only then. A message sent from a suggestion is a line that opens the chat it came
 * from. A finished compaction is a Checkpoint, a point in the chat marked across the column, whose summary opens under
 * it; it offers no restore, since loki cannot go back to one yet (plan 097, KTD8).
 */
export function EventEntry({ row: m, arrived }: { row: TranscriptRow; arrived: boolean }) {
  const openChat = useContext(OpenChat);
  const [open, setOpen] = useState(false);
  if (m.text === SUGGESTED) {
    const from = suggestedSource(m);
    const go = openChat && from ? () => openChat(from.agent_id, from.conversation_id) : undefined;
    return (
      <Marker
        data-row="event"
        data-arrived={arrived || undefined}
        render={go ? <button type="button" onClick={go} title="Open the chat it came from" /> : undefined}
      >
        <MarkerIcon>
          <CornerUpLeftIcon />
        </MarkerIcon>
        <MarkerContent>
          {SUGGESTED}
          {m.summary && <span className="text-muted-foreground"> · {m.summary}</span>}
        </MarkerContent>
      </Marker>
    );
  }
  const title = (
    <>
      {m.text}
      {m.summary && <span className="text-muted-foreground"> · {m.summary}</span>}
    </>
  );
  if (m.text === COMPACTED_TEXT)
    return (
      <div data-row="event" data-checkpoint data-arrived={arrived || undefined} className="flex flex-col gap-2">
        <Checkpoint className="text-meta">
          <CheckpointIcon />
          <CheckpointTrigger
            size="xs"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-muted-foreground"
            disabled={!m.detail && m.row === undefined}
          >
            {m.text}
          </CheckpointTrigger>
        </Checkpoint>
        {open && <EventDetail row={m} />}
      </div>
    );
  if (!m.detail && m.row === undefined)
    return (
      <Marker data-row="event" data-arrived={arrived || undefined}>
        <MarkerIcon>
          <RefreshCwIcon />
        </MarkerIcon>
        <MarkerContent>{title}</MarkerContent>
      </Marker>
    );
  return (
    <Trace data-row="event" data-arrived={arrived || undefined}>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>{open && <EventDetail row={m} />}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
