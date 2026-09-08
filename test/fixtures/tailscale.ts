/**
 * Recorded Tailscale CLI output (v1.86-era), for tests on a Mac without Tailscale installed. Fields the
 * mod does not read are trimmed; the ones it does read keep the CLI's exact casing and trailing dot.
 */

/** `tailscale status --json` on a signed-in, running Mac. */
export const STATUS_RUNNING = JSON.stringify({
  Version: "1.86.2-t1a2b3c4d5-g6e7f8a9b0",
  TUN: true,
  BackendState: "Running",
  HaveNodeKey: true,
  AuthURL: "",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  Self: {
    ID: "nABCDEF1234",
    PublicKey: "nodekey:0000",
    HostName: "Deepaks-MacBook-Pro",
    DNSName: "Deepaks-MacBook-Pro.tail1234.ts.net.",
    OS: "macOS",
    UserID: 1234,
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    Online: true,
    InNetworkMap: true,
  },
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "deepak@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  Peer: {},
});

/** `tailscale status --json` after `tailscale down`: the node keeps its name and address. */
export const STATUS_STOPPED = JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "Deepaks-MacBook-Pro.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103"] } });

/** `tailscale serve status --json` after `serve --bg --https=443 http://127.0.0.1:41415`. */
export const SERVE_41415 = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "deepaks-macbook-pro.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:41415" } } } } });
