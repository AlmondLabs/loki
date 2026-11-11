import { useContext, useState, type ReactNode } from "react";
import { CornerUpLeftIcon, LayoutGridIcon, RefreshCwIcon } from "lucide-react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Marker, MarkerContent, MarkerIcon } from "@/ui/marker";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/ui/trace";
import { clockLabel } from "../shared/thread";
import { EventDetail } from "../chat/tool-steps";
import { OpenChat, SUGGESTED, suggestedSource, type WidgetMark } from "../chat/transcript";

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
 * A widget change among the messages: who, what and the widget, with its time. While the widget is on the canvas the
 * line opens the Canvas tab framed on it; once it is gone it says so. The summary row only counts, and opens the canvas.
 * The live widget follows its latest row.
 */
export function WidgetMarker({
  mark: w,
  live,
  inline,
  onFrame,
  onShowDesk,
}: {
  mark: WidgetMark;
  live: boolean;
  inline?: (widgetId: string) => ReactNode;
  onFrame?: (widgetId: string) => void;
  onShowDesk?: () => void;
}) {
  const time = w.earlier === undefined ? clockLabel(w.at) : null;
  const words =
    w.earlier !== undefined ? (
      `${w.earlier} earlier widget change${w.earlier === 1 ? "" : "s"}`
    ) : (
      <>
        <span className="font-semibold text-foreground">{w.who}</span> {w.change} <span className={w.gone ? undefined : "text-ring"}>{w.title}</span>
        {w.gone && (w.change === "removed" ? " · it is gone from the canvas" : " · since removed from the canvas")}
      </>
    );
  const open = w.earlier !== undefined ? onShowDesk : !w.gone && onFrame ? () => onFrame(w.widgetId) : undefined;
  return (
    <div className="flex flex-col gap-2" data-row="widget" data-gone={w.gone ? "true" : undefined}>
      <Marker render={open ? <button type="button" onClick={open} title={w.earlier !== undefined ? "show the canvas" : "show it on the canvas"} /> : undefined}>
        <MarkerIcon>
          <LayoutGridIcon />
        </MarkerIcon>
        <MarkerContent>
          {words}
          {time && <time dateTime={w.at}> · {time}</time>}
        </MarkerContent>
      </Marker>
      {live && inline?.(w.widgetId)}
    </div>
  );
}

/**
 * A harness event as one quiet line (a background task finishing, a skill loaded, a compaction); with a detail, it opens
 * to it, a lean one's fetched only then. A message sent from a suggestion is a line that opens the chat it came from.
 */
export function EventMarker({ row: m, arrived }: { row: TranscriptRow; arrived: boolean }) {
  const openChat = useContext(OpenChat);
  const [open, setOpen] = useState(false);
  if (m.text === SUGGESTED) {
    const from = suggestedSource(m);
    const go = openChat && from ? () => openChat(from.agent_id, from.conversation_id) : undefined;
    return (
      <Marker
        data-row="event"
        data-arrived={arrived || undefined}
        render={go ? <button type="button" onClick={go} title="open the chat it came from" /> : undefined}
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
