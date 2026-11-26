import { isLanVia, nothing, strOr, type Raw } from "./primitives.ts";
import { push, request, send } from "./types.ts";

export const lanFrames = {
  lan_get: send("the listener's status, after asking Tailscale again", nothing, { causes: ["lan_status"] }),
  lan_set: send("turn the listener on or off (persisted, then bound or closed)", (m: Raw) => ({ enabled: m.enabled === true }), { causes: ["lan_status"] }),
  lan_via_set: send("which route the QR encodes", (m: Raw) => (isLanVia(m.via) ? { via: m.via } : 'via must be "tailscale" or "lan"'), {
    causes: ["lan_status"],
  }),
  lan_serve_set: send("`tailscale serve` on or off for the listener", (m: Raw) => ({ enabled: m.enabled === true }), { causes: ["lan_status"] }),
  pair_begin: send("mint a pairing code and the URL its QR carries", nothing, { causes: ["pair_code"] }),
  devices_list: send("the paired phones", nothing, { causes: ["devices"] }),
  device_forget: send("forget a phone and close its sockets", (m: Raw) => ({ id: strOr(m.id, null) }), { causes: ["devices"] }),

  daemon_restart: request(
    "chat_done",
    "update a checkout's loki: build the page if due, then restart the daemon; a restart is refused while a chat works or an approval waits, unless `anyway`",
    (m: Raw) => ({ anyway: m.anyway === true }),
  ),

  lan_status: push("the phone listener's status"),
  devices: push("the paired phones"),
  pair_code: push("a pairing code, its URL and when it expires"),
  app_build: push("the build a phone is served, so it can offer a reload"),
  restart_due: push("a checkout's code changed, so an update is due (a page build, a restart); the window offers it (plans 024 and 041)"),
} as const;
