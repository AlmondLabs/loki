/**
 * The phone's pure bits — no DOM, so test/phone.test.ts can run them under bun:
 * the pairing URL both ways, the device label, the "last seen" wording, and the
 * frame shapes the mod sends about the LAN listener (the contract in
 * docs/plans/2026-09-07-007-feat-loki-mobile-plan.md, "Bridge frames").
 */

import type { LanStatus } from "../../../mod/lan.ts";
import type { DeviceSummary } from "../../../mod/devices.ts";
import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../../../packages/core/src/pairing-code.ts";

/** The mod's own types: what `lan_status` and `devices` carry (mod/lan.ts, mod/devices.ts). */
export type { LanStatus };
export type PairedDevice = DeviceSummary;

/** A fresh pairing code (`pair_code`). */
export interface PairCode {
  code: string;
  url: string;
  /** ISO time after which the code is refused. */
  expiresAt: string;
}

/** The pairing alphabet and length are the mod's (mod/pairing.ts); the URL itself comes from the mod in `pair_code`. */
export const CODE_ALPHABET = PAIRING_ALPHABET;
export const CODE_LENGTH = PAIRING_LENGTH;

/** The code in a pairing URL or a bare query string, normalised; null when there is none. */
export function codeFromUrl(url: string): string | null {
  try {
    const search = url.startsWith("?") ? url : new URL(url, "http://localhost").search;
    const raw = new URLSearchParams(search).get("code");
    if (!raw) return null;
    const code = normalizeCode(raw);
    return code.length === CODE_LENGTH ? code : null;
  } catch {
    return null;
  }
}

/** Uppercase, alphabet only, at most six characters — what the code field keeps as you type. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .split("")
    .filter((c) => CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, CODE_LENGTH);
}

export type DeviceKind = "iPhone" | "iPad" | "Android" | "phone";

/**
 * What kind of device a user agent is. iPadOS Safari calls itself a Macintosh, so a Mac UA with
 * touch points is an iPad; the caller passes `navigator.maxTouchPoints` when it has one.
 */
export function deviceKind(ua: string, touchPoints = 0): DeviceKind {
  if (/iPad/i.test(ua)) return "iPad";
  if (/iPhone|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua) && touchPoints > 1) return "iPad";
  return "phone";
}

/** "iPhone · 14:05": the label a paired phone gets in Settings, so two of the same kind stay apart. */
export function deviceName(ua: string, now: Date = new Date(), touchPoints = 0): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${deviceKind(ua, touchPoints)} · ${hh}:${mm}`;
}

/** "just now", "1 minute ago", "3 hours ago", "2 days ago" — for a device's last visit and the Mac's last answer. */
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

/** "9:58" until `iso`, or "expired". */
export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(s) || s <= 0) return "expired";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
