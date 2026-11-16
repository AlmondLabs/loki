import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Gesture, Scope, WidgetLogEntry, WidgetManifestEntry } from "../../../core/desk-core.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { widgetMarks } from "../desk/widget-rows";
import { InlineWidget } from "./inline-widget";
import type { WidgetMark } from "./transcript";

export interface InlineWidgetSource {
  widgetLogOf: (scope: Scope) => WidgetLogEntry[] | undefined;
  widgetsOf: (scope: Scope) => { entries: WidgetManifestEntry[]; overlay: Record<string, Record<string, unknown>> } | undefined;
  watchDesk: (scope: Scope) => void;
  gesture: (g: Gesture) => void;
}

export const WidgetSourceContext = createContext<InlineWidgetSource | undefined>(undefined);

export function useInlineWidgets(
  given: InlineWidgetSource | undefined,
  scope: Scope | null,
  rows: TranscriptRow[] | undefined,
  agentName: string | null,
  opts: { readOnly?: boolean; onOpen?: (widgetId: string) => void } = {},
): { widgets: WidgetMark[]; inline: (widgetId: string) => ReactNode } {
  const provided = useContext(WidgetSourceContext);
  const source = given ?? provided;
  const log = scope ? source?.widgetLogOf(scope) : undefined;
  const widgets = useMemo(() => widgetMarks(rows, log, agentName), [rows, log, agentName]);
  const shows = !!scope && widgets.some((w) => w.earlier === undefined && !w.gone);
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
      return (
        <InlineWidget
          entry={entry}
          overlay={overlay?.[widgetId]}
          gesture={readOnly ? undefined : (g) => send.current?.(g)}
          onOpen={canOpen ? () => open.current?.(widgetId) : undefined}
        />
      );
    },
    [entries, overlay, readOnly, canOpen],
  );
  return { widgets, inline };
}
