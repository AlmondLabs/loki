import type { ReactNode } from "react";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { getPath, mergeData } from "../../../core/desk-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { ModuleWidget, WidgetError, WidgetErrorBoundary } from "../desk/module-widget";
import { Icon } from "../shared/icons";

const quiet = () => {};

export function InlineWidget({
  entry,
  overlay,
  gesture,
  onOpen,
}: {
  entry: WidgetManifestEntry;
  overlay?: Record<string, unknown>;
  gesture?: (g: Gesture) => void;
  onOpen?: () => void;
}) {
  const send = gesture ?? quiet;
  let body: ReactNode;
  if (entry.kind === "module" && !gesture) body = <p className="loki-inline-widget-note">This widget runs on the Mac: open the chat there to use it.</p>;
  else if (entry.kind === "module") body = <ModuleWidget entry={entry} overlay={overlay} gesture={send} onError={quiet} fill />;
  else if (entry.error) body = <WidgetError message={entry.error} />;
  else {
    const Kit = entry.type ? KIT_COMPONENTS[entry.type] : undefined;
    if (!Kit) body = <WidgetError message={`unknown kit type: ${entry.type}`} />;
    else {
      const data = mergeData(entry.data, overlay);
      body = <Kit data={data} onSet={(path, value) => send({ kind: "set", id: entry.id, path, value, prev: getPath(data, path) })} />;
    }
  }
  return (
    <div className="loki-inline-widget" data-row="widget-inline">
      <div className="loki-inline-widget-head">
        <Icon name="widget" size={14} />
        <span className="loki-inline-widget-title">{entry.title}</span>
        {onOpen && (
          <button type="button" className="loki-inline-widget-open" onClick={onOpen}>
            Show on Canvas
          </button>
        )}
      </div>
      <div className="loki-inline-widget-body">
        <WidgetErrorBoundary key={entry.hash} id={entry.id} onError={quiet}>
          {body}
        </WidgetErrorBoundary>
      </div>
    </div>
  );
}
