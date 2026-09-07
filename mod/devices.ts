import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Paired phones. Each holds a 32-byte token (in an HttpOnly cookie, see mod/lan.ts);
 * the file at state/devices.json keeps only the token's sha256, so reading the file
 * never yields a usable credential.
 *   [{ id, name, tokenHash, createdAt, lastSeenAt }]
 */
export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 hex of the device token. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
}

/** What the canvas sees: never the hash. */
export type DeviceSummary = Omit<DeviceRecord, "tokenHash">;

const SEEN_WRITE_INTERVAL_MS = 60_000;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class DeviceStore {
  private devices: DeviceRecord[] = [];
  private readonly path: string;
  private readonly now: () => number;

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        this.devices = parsed.filter(
          (d): d is DeviceRecord => typeof d === "object" && d !== null && typeof (d as DeviceRecord).id === "string" && typeof (d as DeviceRecord).tokenHash === "string",
        );
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
    this.devices.push({ id, name: clean, tokenHash: hashToken(token), createdAt: at, lastSeenAt: at });
    this.persist();
    return { id, token };
  }

  /** The device a token belongs to, or null. Refreshes lastSeenAt; the file is rewritten at most once a minute per device. */
  verify(token: string): DeviceRecord | null {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = hashToken(token);
    const device = this.devices.find((d) => d.tokenHash === hash);
    if (!device) return null;
    const now = this.now();
    if (now - Date.parse(device.lastSeenAt) >= SEEN_WRITE_INTERVAL_MS) {
      device.lastSeenAt = new Date(now).toISOString();
      this.persist();
      this.onSeen?.(device);
    }
    return device;
  }

  /** Called when a verify moved a device's lastSeenAt on disk (so the canvas's list can follow). */
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
    return this.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }));
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
