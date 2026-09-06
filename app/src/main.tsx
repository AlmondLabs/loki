import { createRoot } from "react-dom/client";
import "./styles.css";
import "./shared-modules";
import { installShellLogging } from "./desk/env";

installShellLogging();
import { Shell } from "./shell/Shell";

/**
 * Links leave the canvas. Anything the agent or a widget links to — markdown in
 * the chat, a URL in a card — opens in a new browser tab, never inside this
 * window. In an installed (standalone) app a new tab lands in the browser
 * proper, which is where reading a link belongs; the desk stays put.
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
    window.open(url.href, "_blank", "noopener,noreferrer");
  },
  true,
);

createRoot(document.getElementById("root")!).render(<Shell />);
