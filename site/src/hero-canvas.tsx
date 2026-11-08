import { useEffect, useRef, useState } from "react";
import { applyGesture, getPath, mergeData, type DeskState, type Gesture, type WidgetManifestEntry } from "../../core/desk-core.ts";
import { describeGesture, formatDeskContext } from "../../mod/gestures.ts";
import { WidgetFrame } from "../../app/src/desk/widget-frame";
import { KIT_COMPONENTS } from "../../app/src/kit";

/**
 * The hero's canvas: loki's own widget frames and kit widgets over a made-up chat's widgets, which the visitor can
 * drag, tick and slide. Under it, the block loki attaches to the person's next message, written by the same code
 * the mod uses (mod/gestures.ts), so the visitor reads exactly what the agent would be told.
 */

const SCOPE = "saturday";
/** The canvas's own size: a desktop window's worth; narrower screens draw it scaled down. */
const CANVAS = { w: 760, h: 470 };

const widget = (name: string, title: string, type: string, data: Record<string, unknown>): WidgetManifestEntry => ({
  id: `${SCOPE}/${name}`,
  scope: SCOPE,
  name,
  kind: "json",
  file: `${SCOPE}/${name}.json`,
  title,
  type,
  data,
  hash: name,
  updated_at: 0,
});

const WIDGETS: WidgetManifestEntry[] = [
  widget("plan", "Saturday", "info-card", {
    lines: ["9:00 · run by the river, 8 km", "11:30 · the farmers' market", "14:00 · fix the bike's back brake", "19:30 · dinner at Ana's"],
  }),
  widget("sleep", "Last night", "stat", { value: 7.4, unit: "h asleep", delta: 0.6, label: "deep sleep 1 h 52 m" }),
  widget("runs", "This week's runs", "chart-card", {
    kind: "bar",
    points: [
      { x: "mon", y: 5 },
      { x: "tue", y: 0 },
      { x: "wed", y: 6.5 },
      { x: "thu", y: 4 },
      { x: "fri", y: 0 },
      { x: "sat", y: 8 },
      { x: "sun", y: 0 },
    ],
  }),
  widget("packing", "Packing for Lisbon", "list-card", {
    items: [{ text: "passport", done: true }, { text: "charger" }, { text: "rain jacket" }, { text: "the good sandals" }],
  }),
  widget("heating", "Heating", "slider-control", { label: "living room", value: 20, min: 16, max: 25, step: 0.5, unit: "°C" }),
];

const START: DeskState = {
  scope: SCOPE,
  rev: 0,
  overlay: {},
  layout: {
    "saturday/plan": { position: { x: 24, y: 24 }, z: 1 },
    "saturday/sleep": { position: { x: 300, y: 24 }, z: 2 },
    "saturday/runs": { position: { x: 300, y: 168 }, z: 3, size: { w: 300, h: 260 }, sized: true },
    "saturday/packing": { position: { x: 24, y: 214 }, z: 4 },
    "saturday/heating": { position: { x: 520, y: 24 }, z: 5, size: { w: 216, h: 120 }, sized: true },
  },
};

/** The canvas and the note it leaves for the agent. */
export function HeroCanvas() {
  const [desk, setDesk] = useState(START);
  /** What the agent will be told, by gesture key: a later move of the same widget replaces the earlier one, as the mod does. */
  const [said, setSaid] = useState<ReadonlyMap<string, string>>(new Map());
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const s = Math.min(1, el.clientWidth / CANVAS.w);
      scaleRef.current = s;
      setScale(s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const gesture = (g: Gesture) => {
    const entry = WIDGETS.find((w) => w.id === g.id);
    const told = describeGesture(g, entry, entry?.data);
    if (told) setSaid((m) => new Map(m).set(told.key, told.line));
    setDesk((d) => applyGesture(d, g));
  };

  const startOver = () => {
    setDesk(START);
    setSaid(new Map());
  };

  const shown = WIDGETS.filter((w) => desk.layout[w.id].hidden !== true);
  const lines = [...said.values()];

  return (
    <div className="site-hero-demo">
      <div className="site-window site-canvas-window">
        <div className="site-window-bar" aria-hidden>
          <span />
          <span />
          <span />
          <em>Saturday · Canvas</em>
        </div>
        <div ref={box} className="site-canvas" style={{ height: CANVAS.h * scale }}>
          <div className="site-canvas-plane" style={{ width: CANVAS.w, height: CANVAS.h, transform: `scale(${scale})` }}>
            {shown.map((entry, i) => {
              const layout = desk.layout[entry.id];
              const data = mergeData(entry.data, desk.overlay[entry.id]);
              const Kit = entry.type ? KIT_COMPONENTS[entry.type] : undefined;
              return (
                <WidgetFrame key={entry.id} entry={entry} layout={layout} order={i} gesture={gesture} getScale={() => scaleRef.current}>
                  {Kit && <Kit data={data} onSet={(path, value) => gesture({ kind: "set", id: entry.id, path, value, prev: getPath(data, path) })} />}
                </WidgetFrame>
              );
            })}
          </div>
        </div>
      </div>
      <div className="site-told" aria-live="polite">
        <div className="site-told-head">
          <span>what the agent reads with your next message</span>
          {(lines.length > 0 || shown.length < WIDGETS.length) && (
            <button type="button" onClick={startOver}>
              start over
            </button>
          )}
        </div>
        <pre>{lines.length ? formatDeskContext(SCOPE, lines) : "drag a widget, tick an item or move the slider"}</pre>
      </div>
    </div>
  );
}
