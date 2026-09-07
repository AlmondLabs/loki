import { randomInt } from "node:crypto";

/**
 * Pairing codes: six characters Settings shows next to the QR, in memory only.
 * A code lives ten minutes and may be redeemed more than once inside that window
 * (each redeem mints a new device): an iOS home-screen web app has its own cookie
 * jar, so the user pairs in Safari, adds to the Home Screen, and pairs the new
 * icon with the same code.
 */
import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../packages/core/src/pairing-code.ts";
export { PAIRING_ALPHABET, PAIRING_LENGTH };
export const PAIRING_TTL_MS = 10 * 60_000;

export interface PairingCode {
  code: string;
  /** ISO timestamp. */
  expiresAt: string;
}

export class PairingCodes {
  private readonly codes = new Map<string, number>(); // code → expiry (ms)
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? PAIRING_TTL_MS;
  }

  mint(): PairingCode {
    this.prune();
    let code = generate();
    while (this.codes.has(code)) code = generate();
    const expires = this.now() + this.ttl;
    this.codes.set(code, expires);
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /** True while the code is inside its window. Case-insensitive; whitespace ignored. */
  redeem(code: string): boolean {
    this.prune();
    const key = normalize(code);
    if (key.length !== PAIRING_LENGTH) return false;
    const expires = this.codes.get(key);
    return expires !== undefined && expires > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
  }
}

export const normalize = (code: string): string => (typeof code === "string" ? code.replace(/[\s-]/g, "").toUpperCase() : "");

function generate(): string {
  let out = "";
  for (let i = 0; i < PAIRING_LENGTH; i++) out += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return out;
}
