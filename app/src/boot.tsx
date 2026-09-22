import { createRoot } from "react-dom/client";
import "./styles.css";
import "./shared-modules";
import { inLan, inTauri, installShellLogging } from "./desk/env";

installShellLogging();
import { Shell } from "./shell/Shell";
import { Phone } from "./phone/Phone";
import { ThemeProvider } from "./theme";

/**
 * Links leave the canvas. Anything the agent or a widget links to — markdown in
 * the chat, a URL in a card — opens in the default browser, never inside this
 * window: through the opener plugin in the Tauri shell, a new tab in a browser
 * tab. Reading a link belongs in the browser; the desk stays put.
 */
document.addEventListener(
  "click",
  (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (!/^https?:$/.test(url.protocol)) return; // mailto:, etc. keep their default
    if (url.origin === location.origin && url.pathname === location.pathname) return; // in-page (#anchors, desk links)
    e.preventDefault();
    // The Tauri webview blocks window.open; the opener plugin hands the URL to the default browser.
    if (inTauri) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url.href)).catch((err) => console.warn("loki: open link", err));
    else window.open(url.href, "_blank", "noopener,noreferrer");
  },
  true,
);

// Served over the Wi‑Fi by the mod (window.__LOKI__.lan): the phone's inbox instead of the desk.
createRoot(document.getElementById("root")!).render(<ThemeProvider>{inLan ? <Phone /> : <Shell />}</ThemeProvider>);
