import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PageOs = "macos" | "windows" | "linux";

export const DEFAULT_MOD_PORT = 41414;

/**
 * What the page is told before its scripts run (`window.__LOKI__`): the daemon token, the mod's port, the desk to open
 * and the system; the settings window also learns it is the settings window and which page to open. Only the app's
 * own top-level page gets it: a widget runs in a sandboxed subframe that must never see the token.
 */
export interface LokiGlobals {
  token: string;
  modPort: number;
  desk: string | null;
  os: PageOs;
  window?: "settings";
  page?: string | null;
}

export function pageOs(platform: NodeJS.Platform): PageOs {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function homeFrom(windows: boolean, env: NodeJS.ProcessEnv): string | null {
  const home = env[windows ? "USERPROFILE" : "HOME"];
  return home ? home : null;
}

export function newToken(): string {
  return randomBytes(16).toString("hex");
}

function readToken(dir: string): string | null {
  try {
    return readFileSync(join(dir, "token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function ensureToken(dir: string, log: (line: string) => void): string | null {
  const present = readToken(dir);
  if (present) return present;
  const token = newToken();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "token"), token, { flag: "wx", mode: 0o600 });
    log("wrote a new capability token");
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readToken(dir);
    log(`could not write the capability token: ${String(error)}`);
    return null;
  }
}

export function settingsPage(page: unknown): string | null {
  return typeof page === "string" && /^[a-z-]{1,32}$/.test(page) ? page : null;
}

export function lokiGlobals(opts: { token: string; env: NodeJS.ProcessEnv; os: PageOs; settings?: unknown }): LokiGlobals {
  const port = Number(opts.env.LOKI_PORT);
  const globals: LokiGlobals = {
    token: opts.token,
    modPort: Number.isInteger(port) && port > 0 ? port : DEFAULT_MOD_PORT,
    desk: opts.env.LOKI_DESK || null,
    os: opts.os,
  };
  return opts.settings === undefined ? globals : { ...globals, window: "settings", page: settingsPage(opts.settings) };
}
