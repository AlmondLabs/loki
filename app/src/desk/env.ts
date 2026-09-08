/**
 * Where the app runs and how it reaches the mod. In a browser tab the page is
 * served by Vite (or the mod) and everything is same-origin under /loki. In the
 * Tauri shell the page is tauri://localhost, so the mod is addressed directly
 * and the token is handed over by the Rust side at startup. On a phone the mod
 * itself serves the page over the LAN and marks it with `__LOKI__.lan`; there
 * the origin is the mod and the device's cookie is the credential, not a token.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __LOKI__?: { token?: string; modPort?: number; desk?: string | null; lan?: boolean; build?: string };
  }
}

export const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
/** Served by the mod's LAN listener (a phone, or any browser on the Wi‑Fi): phone mode, cookie auth. */
export const inLan = typeof window !== "undefined" && !inTauri && !!window.__LOKI__?.lan;

/** http(s) origin + path prefix for the mod's HTTP/WS endpoints, without a trailing slash. */
export function modBase(): string {
  if (inTauri) return `http://127.0.0.1:${window.__LOKI__?.modPort ?? 41414}`;
  if (inLan) return location.origin; // the mod is the page's own server on the LAN
  return `${location.origin}/loki`;
}

/** ws(s) form of modBase(). */
export function modWsBase(): string {
  return modBase().replace(/^http/, "ws");
}

/** The agent's face as the mod serves it (its memory filesystem's profile.png). */
export function avatarUrl(agentId: string): string {
  const token = injectedToken() ?? localStorage.getItem("loki.token") ?? "";
  const url = `${modBase()}/agents/${encodeURIComponent(agentId)}/profile.png`;
  return token ? `${url}?t=${encodeURIComponent(token)}` : url; // on the LAN the device cookie authenticates
}

/** The token the Rust side injected, if any (browser tabs get it from the URL / localStorage instead). */
export function injectedToken(): string | null {
  return window.__LOKI__?.token ?? null;
}

/** A desk the shell was asked to open (LOKI_DESK), if any. */
export function injectedDesk(): string | null {
  return window.__LOKI__?.desk ?? null;
}

/** In the shell, mirror console warnings and errors (and a few milestones) to the Rust side's stderr. */
export function installShellLogging(): void {
  if (!inTauri) return;
  void import("@tauri-apps/api/core").then(({ invoke }) => {
    const mirror = (level: string, orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
      orig(...args);
      void invoke("client_log", { level, message: args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ") }).catch(() => {});
    };
    console.warn = mirror("warn", console.warn.bind(console));
    console.error = mirror("error", console.error.bind(console));
    console.info = mirror("info", console.info.bind(console));
    // WebKit prints CSP refusals to the console directly, bypassing console.error: report them ourselves.
    document.addEventListener("securitypolicyviolation", (e) => void invoke("client_log", { level: "error", message: `csp: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile || location.pathname}:${e.lineNumber}` }).catch(() => {}));
    window.addEventListener("error", (e) => void invoke("client_log", { level: "error", message: `uncaught: ${e.message}` }).catch(() => {}));
    window.addEventListener("unhandledrejection", (e) => void invoke("client_log", { level: "error", message: `unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}` }).catch(() => {}));
    void invoke("client_log", { level: "info", message: `page booted at ${location.href}` }).catch(() => {});
  });
}
