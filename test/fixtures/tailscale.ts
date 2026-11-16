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
    HostName: "My-MacBook-Pro",
    DNSName: "My-MacBook-Pro.tail1234.ts.net.",
    OS: "macOS",
    UserID: 1234,
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    Online: true,
    InNetworkMap: true,
  },
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "someone@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  Peer: {},
});

export const STATUS_STOPPED = JSON.stringify({
  BackendState: "Stopped",
  Self: { DNSName: "My-MacBook-Pro.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103"] },
});

export const SERVE_41415 = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { "my-macbook-pro.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:41415" } } } },
});
