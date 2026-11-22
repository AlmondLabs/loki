import { messageOf } from "../../../core/errors.ts";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __LOKI__?: {
      token?: string;
      modPort?: number;
      desk?: string | null;
      lan?: boolean;
      build?: string;
      os?: string;
      window?: string;
      page?: string | null;
    };
  }
}

export type Platform = "macos" | "windows" | "linux";

export function platformFrom(os: unknown, userAgent: string): Platform {
  if (os === "macos" || os === "windows" || os === "linux") return os;
  if (userAgent.includes("Windows")) return "windows";
  if (/Linux|X11|CrOS/.test(userAgent) && !userAgent.includes("like Mac OS X")) return "linux";
  return "macos";
}

export function keyboardFrom(tauri: boolean, os: unknown, userAgent: string): Platform {
  return platformFrom(tauri ? os : undefined, userAgent);
}

export const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
export const inLan = typeof window !== "undefined" && !inTauri && !!window.__LOKI__?.lan;

export function settingsWindowFrom(loki: Window["__LOKI__"], search: string, tauri: boolean, lan: boolean): { page: string | null } | null {
  if (loki?.window === "settings") return { page: loki.page ?? null };
  if (tauri || lan) return null;
  const query = new URLSearchParams(search);
  return query.get("window") === "settings" ? { page: query.get("page") } : null;
}
export const settingsWindow =
  typeof window !== "undefined" ? settingsWindowFrom(window.__LOKI__, typeof location !== "undefined" ? location.search : "", inTauri, inLan) : null;

const injectedOs = typeof window !== "undefined" ? window.__LOKI__?.os : undefined;
const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const platform: Platform = platformFrom(injectedOs, userAgent);
export const keyboard: Platform = keyboardFrom(inTauri, injectedOs, userAgent);

const SYSTEM_NAME: Record<Platform, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

export function systemName(os: Platform = platform): string {
  return SYSTEM_NAME[os];
}

export function notYetOn(what: string, os: Platform = platform): string {
  return `${what} isn't on ${systemName(os)} yet`;
}

export function modBase(): string {
  if (inTauri) return `http://127.0.0.1:${window.__LOKI__?.modPort ?? 41414}`;
  if (inLan) return location.origin;
  return `${location.origin}/loki`;
}

export function modWsBase(): string {
  return modBase().replace(/^http/, "ws");
}

export function avatarUrl(agentId: string): string {
  const token = injectedToken() ?? localStorage.getItem("loki.token") ?? "";
  const url = `${modBase()}/agents/${encodeURIComponent(agentId)}/profile.png`;
  return token ? `${url}?t=${encodeURIComponent(token)}` : url;
}

export function chatImageUrl(src: string): string {
  if (/^(data|blob|https?):/.test(src)) return src;
  const token = injectedToken() ?? localStorage.getItem("loki.token") ?? "";
  const url = `${modBase()}/chat-images/${encodeURIComponent(src)}`;
  return token ? `${url}?t=${encodeURIComponent(token)}` : url;
}

export function injectedToken(): string | null {
  return window.__LOKI__?.token ?? null;
}

export function injectedDesk(): string | null {
  return window.__LOKI__?.desk ?? null;
}

/** A web link, out to the default browser: the opener plugin in the shell (its webview blocks window.open), a new tab otherwise. */
export function openExternal(href: string): void {
  if (inTauri) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href)).catch((err: unknown) => console.warn("loki: open link", err));
  else window.open(href, "_blank", "noopener,noreferrer");
}

export function installShellLogging(): void {
  if (!inTauri) return;
  void import("@tauri-apps/api/core").then(({ invoke }) => {
    const mirror =
      (level: string, orig: (...a: unknown[]) => void) =>
      (...args: unknown[]) => {
        orig(...args);
        void invoke("client_log", {
          level,
          message: args.map((a) => (a instanceof Error ? messageOf(a) : typeof a === "string" ? a : JSON.stringify(a))).join(" "),
        }).catch(() => {});
      };
    console.warn = mirror("warn", console.warn.bind(console));
    console.error = mirror("error", console.error.bind(console));
    console.info = mirror("info", console.info.bind(console));
    // Outside (WebKit): CSP refusals skip console.error, so they are reported here.
    document.addEventListener(
      "securitypolicyviolation",
      (e) =>
        void invoke("client_log", {
          level: "error",
          message: `csp: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile || location.pathname}:${e.lineNumber}`,
        }).catch(() => {}),
    );
    window.addEventListener("error", (e) => void invoke("client_log", { level: "error", message: `uncaught: ${e.message}` }).catch(() => {}));
    window.addEventListener(
      "unhandledrejection",
      (e) => void invoke("client_log", { level: "error", message: `unhandled rejection: ${String(e.reason)}` }).catch(() => {}),
    );
    void invoke("client_log", { level: "info", message: `page booted at ${location.href}` }).catch(() => {});
  });
}
