import type { DeviceSummary, LanStatus, LanVia } from "../../core/frame-types.ts";
import type { FrameHandlers } from "./context.ts";

export interface LanDeps {
  /** The phone listener (mod/lan.ts) and its paired devices, for Settings › phone. */
  lan?: {
    status: () => LanStatus;
    /** status() after asking Tailscale again (what lan_get answers with). */
    refresh: () => Promise<LanStatus>;
    setEnabled: (enabled: boolean) => Promise<LanStatus>;
    /** Which route the QR encodes; persisted. */
    setVia: (via: LanVia) => LanStatus;
    /** `tailscale serve` on or off for the listener. */
    setServe: (enabled: boolean) => Promise<LanStatus>;
    /** Mint a pairing code and the URL the QR carries. */
    pairBegin: () => { code: string; url: string; expiresAt: string };
    devices: () => DeviceSummary[];
    /** Forget a device and close its sockets. */
    forget: (id: string) => boolean;
  };
}

/**
 * Settings › phone: the listener on and off, the route its QR encodes, `tailscale serve`, pairing, and the paired
 * phones. Each answers with a push; the listener's own onChange also broadcasts its status to every tab.
 */
export function lanFrames({ lan }: LanDeps): FrameHandlers {
  const need = () => {
    if (!lan) throw new Error("the phone listener is not available in this mod");
    return lan;
  };
  const status = (s: LanStatus) => ({ type: "lan_status" as const, ...s });
  return {
    // Settings just opened: ask Tailscale again (cached inside its ttl) before answering.
    lan_get: (_, ctx) => need().refresh().then((s) => ctx.push(status(s))),
    // Persisted first, then bound or closed.
    lan_set: ({ enabled }, ctx) => need().setEnabled(enabled).then((s) => ctx.push(status(s))),
    lan_via_set: ({ via }, ctx) => ctx.push(status(need().setVia(via))),
    // The CLI's complaint, if any, rides in tailscale.error: Settings shows it beside the switch.
    lan_serve_set: ({ enabled }, ctx) => need().setServe(enabled).then((s) => ctx.push(status(s))),
    pair_begin: (_, ctx) => ctx.push({ type: "pair_code", ...need().pairBegin() }),
    devices_list: (_, ctx) => ctx.push({ type: "devices", devices: need().devices() }),
    device_forget: ({ id }, ctx) => {
      const l = need();
      if (id) l.forget(id);
      ctx.broadcast({ type: "devices", devices: l.devices() });
    },
  };
}
