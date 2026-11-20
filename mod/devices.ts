import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DeviceSummary, DeviceVia } from "../core/frame-types.ts";
import { writeJsonAtomic } from "./json-file.ts";

export interface DeviceRecord extends DeviceSummary {
  /** sha256 hex of the device token. */
  token_hash: string;
}

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
          (d): d is DeviceRecord =>
            typeof d === "object" && d !== null && typeof (d as DeviceRecord).id === "string" && typeof (d as DeviceRecord).token_hash === "string",
        );
      }
    } catch {
      this.devices = [];
    }
  }

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
      writeJsonAtomic(this.path, this.devices, { pretty: true, newline: true, mode: 0o600, pidTemp: true });
    } catch {}
  }
}
