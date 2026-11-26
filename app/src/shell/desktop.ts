import { messageOf } from "../../../core/errors.ts";
import type { Channel } from "../../../core/version.ts";
import type { DaemonStatus } from "./bootstrap";
import type { MenuSpec } from "./keymap";
import type { PopupEntry } from "./native-menu";
import type { InstallReport } from "./use-harness-facts";
import type { UpdateStatus } from "./use-loki-update";

export const inDesktop = typeof window !== "undefined" && !!window.lokiDesktop;

/** The shell's commands (desktop/ipc.ts and the handlers main.ts gives it): each one's arguments, if any, and its answer. */
export interface DesktopCommands {
  client_log: { args: { level: string; message: string }; result: undefined };
  install_status: { result: InstallReport };
  daemon_status: { result: DaemonStatus };
  retry_daemon: { result: DaemonStatus };
  install_tools: { result: undefined };
  install_node: { result: "installed" | "opened" | "cancelled" };
  open_settings: { args: { page: string | null }; result: undefined };
  set_waiting: { args: { count: number }; result: undefined };
  set_global_shortcut: { args: { enabled: boolean }; result: undefined };
  traffic_lights: { result: Record<string, unknown> | null };
  set_menu: { args: { menus: MenuSpec[] }; result: undefined };
  popup_menu: { args: { entries: PopupEntry[]; x: number; y: number }; result: number | null };
  update_status: { result: UpdateStatus };
  check_for_updates: { result: undefined };
  set_update_channel: { args: { channel: Channel }; result: undefined };
  restart_to_update: { result: undefined };
  window_set_title: { args: { title: string }; result: undefined };
  window_hide: { result: undefined };
  window_minimize: { result: undefined };
  window_toggle_maximize: { result: undefined };
  window_close: { result: undefined };
  window_is_maximized: { result: boolean };
  window_set_theme: { args: { theme: "light" | "dark" | null }; result: undefined };
  open_url: { args: { url: string }; result: undefined };
  reveal_item: { args: { path: string }; result: undefined };
  open_dialog: { args: OpenDialogOptions; result: string | string[] | null };
}

/** The shell's events, by name, and what each carries. */
export interface DesktopEvents {
  "loki:runtime": DaemonStatus;
  "loki:daemon-ready": null;
  "loki:update": UpdateStatus;
  "loki:menu": string;
  "loki:catch-up": null;
  "loki:settings-page": string;
  "loki:window-resized": boolean;
}

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  title?: string;
}

export type DesktopCommand = keyof DesktopCommands;
export type DesktopEvent = keyof DesktopEvents;
type ArgsOf<C extends DesktopCommand> = DesktopCommands[C] extends { args: infer A extends object } ? [args: A] : [];

const NOT_HERE = "loki's desktop shell is not here";
const bridge = (): LokiDesktop | undefined => (typeof window !== "undefined" ? window.lokiDesktop : undefined);
// Outside (Electron): ipcRenderer.invoke puts its own words before the error a command threw.
const REMOTE_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

export async function invoke<C extends DesktopCommand>(command: C, ...args: ArgsOf<C>): Promise<DesktopCommands[C]["result"]> {
  const desktop = bridge();
  if (!desktop) throw new Error(NOT_HERE);
  const [payload] = args;
  try {
    return (await desktop.invoke(command, payload)) as DesktopCommands[C]["result"];
  } catch (err) {
    throw new Error(messageOf(err).replace(REMOTE_PREFIX, ""));
  }
}

export function listen<E extends DesktopEvent>(event: E, handler: (e: { payload: DesktopEvents[E] }) => void): Promise<() => void> {
  const desktop = bridge();
  if (!desktop) return Promise.reject(new Error(NOT_HERE));
  return Promise.resolve(desktop.listen(event, (payload) => handler({ payload: payload as DesktopEvents[E] })));
}

export interface DesktopWindow {
  setTitle: (title: string) => Promise<void>;
  hide: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: (maximized: boolean) => void) => Promise<() => void>;
  setTheme: (theme: "light" | "dark" | null) => Promise<void>;
}

const DESKTOP_WINDOW: DesktopWindow = {
  setTitle: (title) => invoke("window_set_title", { title }),
  hide: () => invoke("window_hide"),
  minimize: () => invoke("window_minimize"),
  toggleMaximize: () => invoke("window_toggle_maximize"),
  close: () => invoke("window_close"),
  isMaximized: () => invoke("window_is_maximized"),
  onResized: (handler) => listen("loki:window-resized", (e) => handler(e.payload)),
  setTheme: (theme) => invoke("window_set_theme", { theme }),
};

export function currentWindow(): DesktopWindow {
  return DESKTOP_WINDOW;
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function revealItemInDir(path: string): Promise<void> {
  return invoke("reveal_item", { path });
}

export function openDialog(options: OpenDialogOptions): Promise<string | string[] | null> {
  return invoke("open_dialog", options);
}
