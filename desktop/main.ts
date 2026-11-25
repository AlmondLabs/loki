import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  Tray,
  type IpcMainEvent,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { machineDaemon, RUNTIME_EVENT } from "./daemon.ts";
import { ensureToken, homeFrom, lokiGlobals, pageOs, settingsPage } from "./env.ts";
import { launchInstall } from "./install.ts";
import { handleInvokes, sendEvent, sendResizes, windowHandlers, type InvokeHandler } from "./ipc.ts";
import { machineNodeInstallHost, NodeInstalls } from "./node-install.ts";
import { menuBarTemplate, popupTemplate, type MenuSpec, type PopupEntry } from "./menus.ts";
import { watchPageBuild } from "./page-reload.ts";
import { APP_ORIGIN, SCHEME, serveApp, serveWidget } from "./scheme.ts";
import { setCatchUpShortcut, trafficLights, waitingMarks } from "./tray.ts";
import { createUpdater } from "./update/updater.ts";
import { UPDATE_EVENT } from "./update/updates.ts";
import { linkLeavesLoki, mainWindowOptions, sameOrigin, settingsWindowOptions } from "./windows.ts";

const log = (line: string) => console.error(`loki: ${line}`);
const checkout = join(__dirname, "..", "..");
const devUrl = process.env.LOKI_DEV_URL || null;
const os = pageOs(process.platform);
const mac = os === "macos";
const pageRoot = app.isPackaged ? join(process.resourcesPath, "resources", "app") : join(checkout, "app", "dist");
const preload = join(__dirname, "preload.cjs");
const assets = app.isPackaged ? join(process.resourcesPath, "assets") : join(checkout, "desktop", "assets");
const appIcon = app.isPackaged ? join(assets, "icon.png") : join(checkout, "desktop", "build", "icon.png");
const pageOrigin = devUrl ?? APP_ORIGIN;

const home = homeFrom(process.platform === "win32", process.env);
if (!home) {
  log(`${process.platform === "win32" ? "USERPROFILE" : "HOME"} is not set`);
  process.exit(1);
}
const lokiDir = join(home, ".loki");
const widgetsDir = process.env.LOKI_WIDGETS_DIR || join(lokiDir, "widgets");

if (!app.isPackaged) {
  const key = createHash("sha256").update(checkout).digest("hex").slice(0, 12);
  app.setPath("userData", join(app.getPath("appData"), "loki-dev", key));
}
if (os === "linux" && !process.env.ELECTRON_OZONE_PLATFORM_HINT) app.commandLine.appendSwitch("ozone-platform", "x11");

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const settingsPages = new Map<number, string | null>();
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const broadcast = (name: string, payload: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) sendEvent(win.webContents, name, payload);
};

const daemon = machineDaemon({
  home,
  lokiDir,
  packaged: app.isPackaged,
  checkout,
  env: process.env,
  platform: process.platform,
  pid: process.pid,
  publish: (status) => broadcast(RUNTIME_EVENT, status),
  log,
});

const nodeInstalls = new NodeInstalls(machineNodeInstallHost(os, log));

const updater = createUpdater({
  lokiDir,
  current: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  exe: process.execPath,
  appImage: process.env.APPIMAGE,
  overrideUrl: process.env.LOKI_UPDATE_URL,
  tempDir: tmpdir(),
  fetch: (url, init) => net.fetch(url, init),
  publish: (status) => broadcast(UPDATE_EVENT, status),
  stopDaemon: () => daemon.quit(),
  startDaemon: () => daemon.resume(),
  relaunch: () => {
    app.relaunch();
    app.exit(0);
  },
  exit: () => app.exit(0),
});

function trusted(frame: WebFrameMain | null): boolean {
  return !!frame && !frame.parent && sameOrigin(frame.url, pageOrigin);
}

function guard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (linkLeavesLoki(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, pageOrigin)) event.preventDefault();
  });
  if (!mac) sendResizes(win);
}

function pageUrl(): string {
  return devUrl ?? `${APP_ORIGIN}/index.html`;
}

function showMain(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function catchUp(): void {
  showMain();
  if (mainWindow) sendEvent(mainWindow.webContents, "loki:catch-up", null);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow(mainWindowOptions(os, preload, appIcon));
  guard(win);
  win.once("ready-to-show", () => win.show());
  void win.loadURL(pageUrl());
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
}

function openSettings(page: string | null): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (page) sendEvent(settingsWindow.webContents, "loki:settings-page", page);
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow(settingsWindowOptions(os, preload, appIcon));
  settingsPages.set(win.webContents.id, page);
  guard(win);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow = win;
  void win.loadURL(pageUrl());
}

function popup(sender: WebContents, entries: PopupEntry[], x: number, y: number): Promise<number | null> {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return Promise.resolve(null);
  return new Promise((resolve) => {
    let chosen: number | null = null;
    const menu = Menu.buildFromTemplate(
      popupTemplate(
        entries,
        (index) => {
          chosen = index;
        },
        (png) => {
          const image = nativeImage.createFromBuffer(Buffer.from(png), { scaleFactor: 2 });
          image.setTemplateImage(true);
          return image;
        },
      ),
    );
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y), callback: () => setImmediate(() => resolve(chosen)) });
  });
}

const numberArg = (args: Record<string, unknown>, name: string): number => {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is a number`);
  return value;
};

function shellHandlers(installReport: ReturnType<typeof launchInstall>): Record<string, InvokeHandler<WebContents>> {
  return {
    client_log: (args) => log(`[${String(args.level)}] ${String(args.message)}`),
    install_status: () => installReport,
    daemon_status: () => daemon.status(),
    retry_daemon: () => daemon.retry(),
    install_tools: () => daemon.installTools(),
    open_settings: (args) => openSettings(settingsPage(args.page)),
    set_waiting: (args) => {
      if (!mac) return;
      const marks = waitingMarks(numberArg(args, "count"));
      tray?.setTitle(marks.title);
      tray?.setToolTip(marks.tooltip);
      app.setBadgeCount(marks.badge);
    },
    set_global_shortcut: (args) => {
      if (mac) setCatchUpShortcut(globalShortcut, args.enabled === true, catchUp);
    },
    traffic_lights: (_args, sender) => (mac ? trafficLights(BrowserWindow.fromWebContents(sender)?.getWindowButtonPosition() ?? null) : null),
    set_menu: (args) => {
      if (!mac || !Array.isArray(args.menus)) return;
      Menu.setApplicationMenu(Menu.buildFromTemplate(menuBarTemplate(args.menus as MenuSpec[], (id) => broadcast("loki:menu", id))));
    },
    popup_menu: (args, sender) => {
      if (!mac) throw new Error("native pop-up menus are the Mac's");
      return popup(sender, Array.isArray(args.entries) ? (args.entries as PopupEntry[]) : [], numberArg(args, "x"), numberArg(args, "y"));
    },
    install_node: async () => {
      const outcome = await nodeInstalls.install();
      if (outcome.kind === "failed") throw new Error(outcome.message);
      if (outcome.kind !== "cancelled") await daemon.retry();
      return outcome.kind;
    },
    update_status: () => updater.status(),
    check_for_updates: () => updater.check(),
    set_update_channel: (args) => updater.setChannel(args.channel),
    restart_to_update: () => updater.restart(),
  };
}

ipcMain.on("loki:globals", (event: IpcMainEvent) => {
  const token = trusted(event.senderFrame) ? ensureToken(lokiDir, log) : null;
  const id = event.sender.id;
  event.returnValue = token
    ? lokiGlobals({ token, env: process.env, os, ...(settingsPages.has(id) ? { settings: settingsPages.get(id) ?? null } : {}) })
    : null;
});

void app.whenReady().then(() => {
  ensureToken(lokiDir, log);
  const installReport = launchInstall({ packaged: app.isPackaged, env: process.env, resourceDir: process.resourcesPath, checkout, dataDir: lokiDir, home });
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("not found", { status: 404 });
    return url.pathname.startsWith("/widgets/") ? serveWidget(widgetsDir, url) : serveApp(pageRoot, url);
  });
  handleInvokes<WebFrameMain, WebContents>({
    ipc: ipcMain,
    trusted,
    handlers: {
      ...shellHandlers(installReport),
      ...windowHandlers<WebContents, BrowserWindow>({
        windowOf: (sender) => BrowserWindow.fromWebContents(sender),
        openExternal: (url) => shell.openExternal(url),
        showItemInFolder: (path) => shell.showItemInFolder(path),
        showOpenDialog: (win, options) => dialog.showOpenDialog(win, options),
        nativeTheme,
      }),
    },
  });
  mainWindow = createMainWindow();
  app.on("second-instance", showMain);
  if (mac) {
    if (!app.isPackaged) app.dock?.setIcon(appIcon);
    const trayImage = nativeImage.createFromPath(join(assets, "tray-template.png"));
    trayImage.setTemplateImage(true);
    tray = new Tray(trayImage);
    tray.setToolTip("loki");
    tray.on("click", catchUp);
    try {
      setCatchUpShortcut(globalShortcut, true, catchUp);
    } catch (error) {
      log(`global shortcut unavailable: ${String(error)}`);
    }
  }
  if (!devUrl && !app.isPackaged && existsSync(join(pageRoot, "index.html"))) {
    watchPageBuild(join(pageRoot, ".."), "dist", () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
    });
  }
  void daemon.start();
  updater.start();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  globalShortcut.unregisterAll();
  void updater.quit().finally(() => app.exit(0));
});

app.on("window-all-closed", () => app.quit());

process.on("uncaughtException", (thrown) => {
  log(`main stopped on an error: ${String(thrown)}`);
  void daemon.quit().finally(() => app.exit(1));
});
