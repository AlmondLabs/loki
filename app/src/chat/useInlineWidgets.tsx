import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Gesture, Scope, WidgetLogEntry, WidgetManifestEntry } from "../../../core/desk-core.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { widgetMarks } from "../desk/widgetRows";
import { InlineWidget } from "./InlineWidget";
import type { WidgetMark } from "./Transcript";

/** What a thread needs from the desk socket to show a desk's widgets inline (useDesk has all of it). */
export interface InlineWidgetSource {
  widgetLogOf: (scope: Scope) => WidgetLogEntry[] | undefined;
  widgetsOf: (scope: Scope) => { entries: WidgetManifestEntry[]; overlay: Record<string, Record<string, unknown>> } | undefined;
  watchDesk: (scope: Scope) => void;
  gesture: (g: Gesture) => void;
}

/** The phone's widget source, provided once at its root, so its threads need not be handed it (desktop hosts pass theirs). */
export const WidgetSourceContext = createContext<InlineWidgetSource | undefined>(undefined);

/**
 * A thread's widget rows and the widgets drawn under them: the marks (desk/widgetRows.ts) from the desk's change
 * log, and `inline(widgetId)` for the live widget. The desk's widgets are asked for once something in the thread
 * shows one (watchDesk), and again when they change. `readOnly` is the phone: it draws, it does not edit.
 */
export function useInlineWidgets(given: InlineWidgetSource | undefined, scope: Scope | null, rows: TranscriptRow[] | undefined, agentName: string | null, opts: { readOnly?: boolean; onOpen?: (widgetId: string) => void } = {}): { widgets: WidgetMark[]; inline: (widgetId: string) => ReactNode } {
  const provided = useContext(WidgetSourceContext);
  const source = given ?? provided;
  const log = scope ? source?.widgetLogOf(scope) : undefined;
  const widgets = useMemo(() => widgetMarks(rows, log, agentName), [rows, log, agentName]);
  const shows = !!scope && widgets.some((w) => w.earlier === undefined && !w.gone);
  // Read through refs: the socket's functions are new each render, and the transcript is memoised on `inline`.
  const watch = useRef(source?.watchDesk);
  const send = useRef(source?.gesture);
  const open = useRef(opts.onOpen);
  useEffect(() => {
    watch.current = source?.watchDesk;
    send.current = source?.gesture;
    open.current = opts.onOpen;
  });
  useEffect(() => {
    if (shows && scope) watch.current?.(scope);
  }, [shows, scope]);
  const known = scope ? source?.widgetsOf(scope) : undefined;
  const entries = known?.entries;
  const overlay = known?.overlay;
  const readOnly = !!opts.readOnly;
  const canOpen = !!opts.onOpen;
  const inline = useCallback(
    (widgetId: string): ReactNode => {
      const entry = entries?.find((e) => e.id === widgetId);
      if (!entry) return null;
      return <InlineWidget entry={entry} overlay={overlay?.[widgetId]} gesture={readOnly ? undefined : (g) => send.current?.(g)} onOpen={canOpen ? () => open.current?.(widgetId) : undefined} />;
    },
    [entries, overlay, readOnly, canOpen],
  );
  return { widgets, inline };
}
