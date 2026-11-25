import type { BrowserWindowConstructorOptions } from "electron";
import type { PageOs } from "./env.ts";
import { TRAFFIC_LIGHTS_AT } from "./tray.ts";

export const WINDOW_GROUND = "#1c1c1e";

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function chrome(os: PageOs): BrowserWindowConstructorOptions {
  return os === "macos"
    ? {
        titleBarStyle: "hidden",
        trafficLightPosition: TRAFFIC_LIGHTS_AT,
        transparent: true,
        backgroundColor: "#00000000",
        vibrancy: "sidebar",
        visualEffectState: "followWindow",
      }
    : { frame: false, backgroundColor: WINDOW_GROUND };
}

const webPreferences = (preload: string): BrowserWindowConstructorOptions["webPreferences"] => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: true,
});

export function mainWindowOptions(os: PageOs, preload: string): BrowserWindowConstructorOptions {
  return { width: 1440, height: 900, minWidth: 900, minHeight: 600, title: "loki", show: false, ...chrome(os), webPreferences: webPreferences(preload) };
}

export function settingsWindowOptions(os: PageOs, preload: string): BrowserWindowConstructorOptions {
  return { width: 820, height: 600, minWidth: 680, minHeight: 460, title: "Settings", show: false, ...chrome(os), webPreferences: webPreferences(preload) };
}

export function linkLeavesLoki(url: string): boolean {
  try {
    return LINK_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}
