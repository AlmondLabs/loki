import type { DeskState, Scope, WidgetLayout, WidgetManifestEntry } from "../../../core/desk-core.ts";
import { SHARED_SCOPE, autoPlace } from "../../../core/desk-core.ts";

export interface VisibleWidget {
  entry: WidgetManifestEntry;
  layout: WidgetLayout;
  overlay: Record<string, unknown> | undefined;
}

export function deskView(scope: Scope, desks: Partial<Record<Scope, DeskState>>, widgets: Partial<Record<Scope, WidgetManifestEntry[]>>) {
  const visible: VisibleWidget[] = [];
  const closed: WidgetManifestEntry[] = [];
  const scopes = scope === SHARED_SCOPE ? [SHARED_SCOPE] : [SHARED_SCOPE, scope];
  for (const s of scopes) {
    const desk = desks[s];
    (widgets[s] ?? []).forEach((entry, i) => {
      const layout = desk?.layout[entry.id];
      if (layout?.hidden) {
        closed.push(entry);
        return;
      }
      visible.push({ entry, layout: layout ?? { position: autoPlace(i), z: 0 }, overlay: desk?.overlay[entry.id] });
    });
  }
  const ownCount = scope === SHARED_SCOPE ? (widgets[SHARED_SCOPE] ?? []).length : (widgets[scope] ?? []).length;
  const loaded = widgets[scope] !== undefined;
  return { visible, closed, ownCount, loaded };
}
