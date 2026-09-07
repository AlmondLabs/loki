import { createRoot } from "react-dom/client";
import "./styles.css";
import "./shared-modules";
import { inTauri, installShellLogging } from "./desk/env";

installShellLogging();
import { Shell } from "./shell/Shell";

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

createRoot(document.getElementById("root")!).render(<Shell />);
