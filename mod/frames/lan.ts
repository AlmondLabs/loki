import type { DeviceSummary, LanStatus, LanVia } from "../../core/frame-types.ts";
import type { Pushes } from "../../core/frames.ts";
import type { FrameHandlers } from "./context.ts";

export interface LanDeps {
  lan?: {
    status: () => LanStatus;
    refresh: () => Promise<LanStatus>;
    setEnabled: (enabled: boolean) => Promise<LanStatus>;
    setVia: (via: LanVia) => LanStatus;
    setServe: (enabled: boolean) => Promise<LanStatus>;
    pairBegin: () => Pushes["pair_code"];
    devices: () => DeviceSummary[];
    forget: (id: string) => boolean;
  };
}

export function lanFrames({ lan }: LanDeps): FrameHandlers {
  const need = () => {
    if (!lan) throw new Error("the phone listener is not available in this mod");
    return lan;
  };
  const status = (s: LanStatus) => ({ type: "lan_status" as const, ...s });
  return {
    lan_get: (_, ctx) =>
      need()
        .refresh()
        .then((s) => ctx.push(status(s))),
    lan_set: ({ enabled }, ctx) =>
      need()
        .setEnabled(enabled)
        .then((s) => ctx.push(status(s))),
    lan_via_set: ({ via }, ctx) => ctx.push(status(need().setVia(via))),
    lan_serve_set: ({ enabled }, ctx) =>
      need()
        .setServe(enabled)
        .then((s) => ctx.push(status(s))),
    pair_begin: (_, ctx) => ctx.push({ type: "pair_code", ...need().pairBegin() }),
    devices_list: (_, ctx) => ctx.push({ type: "devices", devices: need().devices() }),
    device_forget: ({ id }, ctx) => {
      const l = need();
      if (id) l.forget(id);
      ctx.broadcast({ type: "devices", devices: l.devices() });
    },
  };
}
