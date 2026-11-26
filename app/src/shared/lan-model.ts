import type { DeviceSummary, LanStatus, LanVia, TailscaleStatus } from "../../../core/frame-types.ts";

export type PairedDevice = DeviceSummary;

export type PhoneLanStatus = LanStatus & { via: LanVia; tailscale: TailscaleStatus | null };

export function lanStatusFromFrame(msg: Record<string, unknown>): PhoneLanStatus {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const t = msg.tailscale;
  let tailscale: TailscaleStatus | null = null;
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    tailscale = {
      installed: o.installed === true,
      running: o.running === true,
      ip: str(o.ip),
      name: str(o.name),
      serve_url: str(o.serve_url),
      error: str(o.error),
    };
  }
  return {
    enabled: msg.enabled === true,
    address: str(msg.address),
    addresses: Array.isArray(msg.addresses) ? (msg.addresses as unknown[]).filter((a): a is string => typeof a === "string") : [],
    host: str(msg.host),
    port: typeof msg.port === "number" ? msg.port : 41415,
    app_served: msg.app_served === true,
    error: str(msg.error),
    via: msg.via === "tailscale" && tailscale?.running ? "tailscale" : "lan",
    tailscale,
  };
}

export function pairOrigin(s: PhoneLanStatus): string | null {
  const ts = s.tailscale;
  if (s.via === "tailscale" && ts?.running) {
    if (ts.serve_url) return ts.serve_url;
    if (ts.name) return `http://${ts.name}:${s.port}`;
    if (ts.ip) return `http://${ts.ip}:${s.port}`;
  }
  const h = s.host ?? s.address;
  return h ? `http://${h}:${s.port}` : null;
}

export function wifiAddress(s: PhoneLanStatus): string {
  return s.host ? `${s.host}:${s.port}${s.address ? ` · ${s.address}` : ""}` : s.address ? `${s.address}:${s.port}` : `port ${s.port}, no network`;
}

export function tailnetAddress(s: PhoneLanStatus): string | null {
  const ts = s.tailscale;
  return ts?.serve_url ? ts.serve_url.replace(/^https:\/\//, "") + " · https" : ts?.name ? `${ts.name}:${s.port}` : ts?.ip ? `${ts.ip}:${s.port}` : null;
}

export interface PairCode {
  code: string;
  url: string;
  expiresAt: string;
}

export function pairUrlFor(s: PhoneLanStatus, code: string): string | null {
  const origin = pairOrigin(s);
  return origin ? `${origin}/?code=${encodeURIComponent(code)}` : null;
}

export function viaLabel(via: unknown): string | null {
  return via === "tailscale" ? "Tailscale" : via === "lan" ? "Wi‑Fi" : null;
}

export function lastSeen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(s) || s <= 0) return "expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
