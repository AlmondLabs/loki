import { describe, expect, test } from "vitest";
import {
  EVENT_CHANNEL,
  handleInvokes,
  INVOKE_CHANNEL,
  sendEvent,
  sendResizes,
  windowHandlers,
  type InvokeEvent,
  type InvokeHandler,
  type OpenDialogOptions,
  type WindowLike,
} from "../desktop/ipc.ts";

interface Frame {
  origin: string;
  parent: Frame | null;
}

const APP_ORIGIN = "loki://app";
const page: Frame = { origin: APP_ORIGIN, parent: null };
const trusted = (frame: Frame | null) => !!frame && !frame.parent && frame.origin === APP_ORIGIN;

type Listener = (event: InvokeEvent<Frame, string>, ...args: unknown[]) => Promise<unknown>;

function registered(handlers: Record<string, InvokeHandler<string>>) {
  const channels = new Map<string, Listener>();
  handleInvokes<Frame, string>({ ipc: { handle: (channel, listener) => channels.set(channel, listener) }, trusted, handlers });
  const listener = channels.get(INVOKE_CHANNEL);
  if (!listener) throw new Error("no invoke channel registered");
  return {
    channels: [...channels.keys()],
    invoke: (command: unknown, args?: unknown, frame: Frame | null = page) => listener({ senderFrame: frame, sender: "main-window" }, command, args),
  };
}

const status = { node: "/usr/local/bin/node", error: null, preparing: { name: "node", version: "24.1.0", done: 10, total: null }, toolsMissing: null };

describe("the page's calls into the shell", () => {
  test("one channel carries every command, and daemon_status answers with its status unchanged", async () => {
    const seen: unknown[] = [];
    const shell = registered({
      daemon_status: (args, sender) => {
        seen.push(args, sender);
        return status;
      },
    });
    expect(shell.channels).toEqual([INVOKE_CHANNEL]);
    expect(await shell.invoke("daemon_status")).toEqual(status);
    expect(seen).toEqual([{}, "main-window"]);
  });

  test("a handler's arguments arrive as the page sent them, and its rejection reaches the page", async () => {
    const shell = registered({
      set_waiting: (args) => args,
      retry_daemon: () => Promise.reject(new Error("node did not start")),
    });
    expect(await shell.invoke("set_waiting", { count: 3 })).toEqual({ count: 3 });
    await expect(shell.invoke("retry_daemon")).rejects.toThrow("node did not start");
  });

  test("a frame inside the page, another origin or no frame is refused before any handler runs", async () => {
    let ran = 0;
    const shell = registered({ daemon_status: () => ++ran });
    await expect(shell.invoke("daemon_status", {}, { origin: APP_ORIGIN, parent: page })).rejects.toThrow("only its own page");
    await expect(shell.invoke("daemon_status", {}, { origin: "https://example.com", parent: null })).rejects.toThrow("only its own page");
    await expect(shell.invoke("daemon_status", {}, null)).rejects.toThrow("only its own page");
    expect(ran).toBe(0);
  });

  test("an unknown command, a name from Object's prototype or arguments that are not an object are refused", async () => {
    const shell = registered({ daemon_status: () => status });
    await expect(shell.invoke("format_disk")).rejects.toThrow("no command format_disk");
    await expect(shell.invoke("toString")).rejects.toThrow("no command toString");
    await expect(shell.invoke(42)).rejects.toThrow("no command number");
    await expect(shell.invoke("daemon_status", ["x"])).rejects.toThrow("arguments are an object");
  });
});

describe("events from the shell to the page", () => {
  test("an event goes out on the one event channel with its name and payload, and not to a closed page", () => {
    const sent: unknown[][] = [];
    let destroyed = false;
    const contents = { isDestroyed: () => destroyed, send: (...args: unknown[]) => void sent.push(args) };
    sendEvent(contents, "loki:runtime", status);
    destroyed = true;
    sendEvent(contents, "loki:runtime", status);
    expect(sent).toEqual([[EVENT_CHANNEL, "loki:runtime", status]]);
  });

  test("a resize, maximise or restore tells the page the window resized", () => {
    const listeners = new Map<string, () => void>();
    const sent: unknown[][] = [];
    sendResizes({
      on: (event, listener) => listeners.set(event, listener),
      webContents: { isDestroyed: () => false, send: (...args: unknown[]) => void sent.push(args) },
    });
    for (const fire of listeners.values()) fire();
    expect([...listeners.keys()]).toEqual(["resize", "maximize", "unmaximize"]);
    expect(sent).toEqual([
      [EVENT_CHANNEL, "loki:window-resized", null],
      [EVENT_CHANNEL, "loki:window-resized", null],
      [EVENT_CHANNEL, "loki:window-resized", null],
    ]);
  });
});

function fakeWindowShell(picked: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: [] }) {
  const done: string[] = [];
  let maximized = false;
  const win: WindowLike = {
    setTitle: (title) => void done.push(`title ${title}`),
    hide: () => void done.push("hide"),
    minimize: () => void done.push("minimize"),
    maximize: () => {
      maximized = true;
      done.push("maximize");
    },
    unmaximize: () => {
      maximized = false;
      done.push("unmaximize");
    },
    isMaximized: () => maximized,
    close: () => void done.push("close"),
  };
  const opened: string[] = [];
  const revealed: string[] = [];
  const dialogs: OpenDialogOptions[] = [];
  const nativeTheme: { themeSource: "system" | "light" | "dark" } = { themeSource: "system" };
  const handlers = windowHandlers<string, WindowLike>({
    windowOf: (sender) => (sender === "main-window" ? win : null),
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    showItemInFolder: (path) => void revealed.push(path),
    showOpenDialog: (_window, options) => {
      dialogs.push(options);
      return Promise.resolve(picked);
    },
    nativeTheme,
  });
  const shell = registered(handlers);
  return { ...shell, done, opened, revealed, dialogs, nativeTheme };
}

describe("the window, links, files and the folder dialog", () => {
  test("the window commands act on the window of the page that asked", async () => {
    const shell = fakeWindowShell();
    await shell.invoke("window_set_title", { title: "Flow · 2 waiting" });
    expect(await shell.invoke("window_is_maximized")).toBe(false);
    await shell.invoke("window_toggle_maximize");
    expect(await shell.invoke("window_is_maximized")).toBe(true);
    await shell.invoke("window_toggle_maximize");
    await shell.invoke("window_minimize");
    await shell.invoke("window_hide");
    await shell.invoke("window_close");
    expect(shell.done).toEqual(["title Flow · 2 waiting", "maximize", "unmaximize", "minimize", "hide", "close"]);
  });

  test("the theme follows the page's choice, and none means the system's", async () => {
    const shell = fakeWindowShell();
    await shell.invoke("window_set_theme", { theme: "dark" });
    expect(shell.nativeTheme.themeSource).toBe("dark");
    await shell.invoke("window_set_theme", { theme: "light" });
    expect(shell.nativeTheme.themeSource).toBe("light");
    await shell.invoke("window_set_theme", { theme: null });
    expect(shell.nativeTheme.themeSource).toBe("system");
  });

  test("open_url opens web, mail and phone links only; file, smb and other schemes open nothing", async () => {
    const shell = fakeWindowShell();
    for (const url of [
      "https://github.com/",
      "http://localhost:5173/",
      "mailto:someone@example.com",
      "tel:+15551234567",
      "file:///etc/passwd",
      "smb://server/share",
      "loki-dev://open",
      "javascript:alert(1)",
      "not a url",
    ]) {
      await expect(shell.invoke("open_url", { url })).resolves.toBeUndefined();
    }
    await shell.invoke("open_url", {});
    expect(shell.opened).toEqual(["https://github.com/", "http://localhost:5173/", "mailto:someone@example.com", "tel:+15551234567"]);
  });

  test("reveal_item shows the path in its folder", async () => {
    const shell = fakeWindowShell();
    await shell.invoke("reveal_item", { path: "/Users/me/notes.md" });
    expect(shell.revealed).toEqual(["/Users/me/notes.md"]);
    await expect(shell.invoke("reveal_item", {})).rejects.toThrow("path is a string");
  });

  test("open_dialog for one folder answers its path, or null when cancelled", async () => {
    const chosen = fakeWindowShell({ canceled: false, filePaths: ["/Users/me/code/loki"] });
    const args = { directory: true, multiple: false, defaultPath: "/Users/me/code", title: "Folder for the new chat" };
    expect(await chosen.invoke("open_dialog", args)).toBe("/Users/me/code/loki");
    expect(chosen.dialogs).toEqual([{ properties: ["openDirectory"], defaultPath: "/Users/me/code", title: "Folder for the new chat" }]);
    const cancelled = fakeWindowShell({ canceled: true, filePaths: [] });
    expect(await cancelled.invoke("open_dialog", { directory: true, multiple: false })).toBeNull();
    expect(cancelled.dialogs).toEqual([{ properties: ["openDirectory"] }]);
  });

  test("open_dialog with multiple answers every path picked", async () => {
    const shell = fakeWindowShell({ canceled: false, filePaths: ["/a.md", "/b.md"] });
    expect(await shell.invoke("open_dialog", { multiple: true })).toEqual(["/a.md", "/b.md"]);
    expect(shell.dialogs).toEqual([{ properties: ["openFile", "multiSelections"] }]);
  });
});
