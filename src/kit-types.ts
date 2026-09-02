/**
 * The kit vocabulary — shared between the mod (tool validation, tool
 * descriptions) and the web bundle (component registry). One entry per
 * renderable widget type; `dataShape` is the line the model reads.
 */
export const KIT: Record<string, { dataShape: string }> = {
  "info-card": {
    dataShape: '{ lines: string[] }',
  },
  stat: {
    dataShape: '{ value: string|number, label?: string, unit?: string, delta?: number }',
  },
  "slider-control": {
    dataShape:
      '{ label: string, value: number, min: number, max: number, step?: number, unit?: string }',
  },
  "list-card": {
    dataShape: '{ items: Array<{ text: string, done?: boolean }> }',
  },
  "chart-card": {
    dataShape:
      '{ kind: "line"|"bar"|"area", points: Array<{ x: string|number, y: number }>, yLabel?: string }',
  },
};

export const KIT_TYPES = Object.keys(KIT);

export function kitDescription(): string {
  return KIT_TYPES.map((t) => `${t}: ${KIT[t].dataShape}`).join("; ");
}
