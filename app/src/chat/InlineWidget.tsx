import type { ReactNode } from "react";
import type { Gesture, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { getPath, mergeData } from "../../../core/desk-core.ts";
import { KIT_COMPONENTS } from "../kit";
import { ModuleWidget, WidgetError, WidgetErrorBoundary } from "../desk/ModuleWidget";
import { Icon } from "../shared/icons";

/**
 * A widget drawn inside the thread, live, where the agent made it: the same kit component or module the canvas
 * draws, without the canvas's frame (no drag, resize or close), in a card as wide as the thread allows. Using it
 * here is using it there: a slider moved here is the same edit (a `set` gesture on the widget's own desk), and the
 * canvas shows it. Errors are the canvas's to report; a broken widget here shows its error and nothing else breaks.
 * On the phone a custom (module) widget cannot load yet, so the card says where it runs; kit widgets draw there,
 * but read only: the phone may not change a desk.
 */
/** Errors are the canvas copy's to report: two copies reporting would clear each other's. Also the read-only gesture. */
const quiet = () => {};

export function InlineWidget({ entry, overlay, gesture, onOpen }: { entry: WidgetManifestEntry; overlay?: Record<string, unknown>; gesture?: (g: Gesture) => void; onOpen?: () => void }) {
  const send = gesture ?? quiet;
  let body: ReactNode;
  if (entry.kind === "module" && !gesture) body = <p className="loki-inline-widget-note">This widget runs on the Mac: open the chat there to use it.</p>;
  else if (entry.kind === "module") body = <ModuleWidget entry={entry} overlay={overlay} gesture={send} onError={quiet} />;
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
            Show on canvas
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
