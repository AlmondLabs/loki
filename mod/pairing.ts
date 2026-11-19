import { randomInt } from "node:crypto";

/**
 * Pairing codes: six characters Settings shows next to the QR, in memory only.
 * A code lives ten minutes and may be redeemed more than once inside that window
 * (each redeem mints a new device): an iOS home-screen web app has its own cookie
 * jar, so the user pairs in Safari, adds to the Home Screen, and pairs the new
 * icon with the same code. A code that pairs a Mac is the other kind: `spend` takes it out with its first use,
 * since a paired Mac is trusted with far more than a phone.
 */
import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../core/pairing-code.ts";
export { PAIRING_ALPHABET, PAIRING_LENGTH };
export const PAIRING_TTL_MS = 10 * 60_000;

export const TOO_MANY_WRONG_CODES = "too many wrong codes; wait a while";

/** What one pairing request's code check found: a wrong code counts toward the block, a right one clears it, a refusal neither. */
export type CodeCheck<T> = { code: "right"; value: T } | { code: "wrong" | "refused"; status: number; body: Record<string, unknown> };

export type CodeStep<T> = (check: () => CodeCheck<T>) => CodeCheck<T> | { code: "blocked" };

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export class PairingCodes {
  private readonly codes = new Map<string, number>();
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

  redeem(code: string): boolean {
    this.prune();
    const key = normalize(code);
    if (key.length !== PAIRING_LENGTH) return false;
    const expires = this.codes.get(key);
    return expires !== undefined && expires > this.now();
  }

  spend(code: string): boolean {
    const ok = this.redeem(code);
    if (ok) this.codes.delete(normalize(code));
    return ok;
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
