import { createRoot } from "react-dom/client";
import "./styles.css";
import { inLan, inDesktop, installShellLogging, openExternal, platform, settingsWindow } from "./desk/env";

installShellLogging();
import { ThemeProvider } from "./theme";

document.addEventListener(
  "click",
  (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (!/^https?:$/.test(url.protocol)) return;
    if (url.origin === location.origin && url.pathname === location.pathname) return;
    e.preventDefault();
    openExternal(url.href);
  },
  true,
);

const root = document.getElementById("root");
if (!root) throw new Error("loki: index.html has no #root element");
const trafficLights = !inLan && !settingsWindow && inDesktop && platform === "macos" ? import("./shell/sidebar").then((m) => m.adoptTrafficLights()) : null;
const Surface = inLan
  ? (await import("./phone/phone")).Phone
  : settingsWindow
    ? (await import("./shell/settings-window")).SettingsWindow
    : (await import("./shell/shell")).Shell;
await trafficLights;
createRoot(root).render(
  <ThemeProvider>
    <Surface />
  </ThemeProvider>,
);
