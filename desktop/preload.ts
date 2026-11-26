import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { EVENT_CHANNEL, INVOKE_CHANNEL } from "./ipc.ts";

const globals: unknown = ipcRenderer.sendSync("loki:globals");
if (globals) contextBridge.exposeInMainWorld("__LOKI__", globals);

const LISTENERS = new Map<string, Set<(payload: unknown) => void>>();
let listening = false;

function ensureEventListener() {
  if (listening) return;
  listening = true;
  ipcRenderer.on(EVENT_CHANNEL, (_e: IpcRendererEvent, name: unknown, payload: unknown) => {
    if (typeof name !== "string") return;
    const fns = LISTENERS.get(name);
    if (!fns) return;
    for (const fn of [...fns]) fn(payload);
  });
}

contextBridge.exposeInMainWorld("lokiDesktop", {
  invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke(INVOKE_CHANNEL, command, args ?? {}),
  listen: (event: string, handler: (payload: unknown) => void): (() => void) => {
    ensureEventListener();
    let fns = LISTENERS.get(event);
    if (!fns) {
      fns = new Set();
      LISTENERS.set(event, fns);
    }
    fns.add(handler);
    return () => {
      const cur = LISTENERS.get(event);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) LISTENERS.delete(event);
    };
  },
});
