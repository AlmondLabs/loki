import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceSummary, DeviceVia } from "../core/frame-types.ts";
import { migrateKeys } from "../core/snake-keys.ts";

/**
 * Paired phones. Each holds a 32-byte token (in an HttpOnly cookie, see mod/lan.ts);
 * the file at state/devices.json keeps only the token's sha256, so reading the file
 * never yields a usable credential.
 *   [{ id, name, token_hash, created_at, last_seen_at, last_via? }]
 */
export interface DeviceRecord extends DeviceSummary {
  /** sha256 hex of the device token. */
  token_hash: string;
}

const SEEN_WRITE_INTERVAL_MS = 60_000;

/** The sha256 hex of a device token: the only form of a token state/devices.json keeps. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * The paired phones, kept in state/devices.json (mode 0600) and loaded once at start; an unreadable file means no
 * paired phones. Writes are best effort: a failed one costs a re-pair, never a crash.
 */
export class DeviceStore {
  private devices: DeviceRecord[] = [];
  private readonly path: string;
  private readonly now: () => number;

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    try {
      const { value: parsed, changed } = migrateKeys(JSON.parse(readFileSync(path, "utf8")) as unknown);
      if (Array.isArray(parsed)) {
        this.devices = parsed.filter(
          (d): d is DeviceRecord =>
            typeof d === "object" && d !== null && typeof (d as DeviceRecord).id === "string" && typeof (d as DeviceRecord).token_hash === "string",
        );
        if (changed) this.persist();
      }
    } catch {
      this.devices = [];
    }
  }

  /** A new device; the token is returned once and never stored. */
  mint(name: string): { id: string; token: string } {
    const token = randomBytes(32).toString("hex");
    const at = new Date(this.now()).toISOString();
    let id = randomBytes(6).toString("hex");
    while (this.devices.some((d) => d.id === id)) id = randomBytes(6).toString("hex");
    const clean = name.trim().slice(0, 64) || "Phone";
    this.devices.push({ id, name: clean, token_hash: hashToken(token), created_at: at, last_seen_at: at });
    this.persist();
    return { id, token };
  }

  /**
   * The device a token belongs to, or null. Refreshes last_seen_at and, when given, the route the request
   * came in by; the file is rewritten at most once a minute per device, or at once when the route changed
   * (that is the fact Settings shows, and a phone switching Wi‑Fi for the tailnet should read so right away).
   */
  verify(token: string, via?: DeviceVia): DeviceRecord | null {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = hashToken(token);
    const device = this.devices.find((d) => d.token_hash === hash);
    if (!device) return null;
    const now = this.now();
    const routeChanged = via !== undefined && via !== device.last_via;
    if (routeChanged || now - Date.parse(device.last_seen_at) >= SEEN_WRITE_INTERVAL_MS) {
      device.last_seen_at = new Date(now).toISOString();
      if (via !== undefined) device.last_via = via;
      this.persist();
      this.onSeen?.(device);
    }
    return device;
  }

  /** Called when a verify moved a device's last_seen_at on disk (so the canvas's list can follow). */
  onSeen: ((device: DeviceRecord) => void) | null = null;

  forget(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.persist();
    return true;
  }

  get(id: string): DeviceRecord | null {
    return this.devices.find((d) => d.id === id) ?? null;
  }

  list(): DeviceSummary[] {
    return this.devices.map(({ id, name, created_at: createdAt, last_seen_at: lastSeenAt, last_via: lastVia }) => ({
      id,
      name,
      created_at: createdAt,
      last_seen_at: lastSeenAt,
      ...(lastVia ? { last_via: lastVia } : {}),
    }));
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.devices, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // best effort: a failed write costs a re-pair, never a crash
    }
  }
}
