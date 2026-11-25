import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { EVENT_CHANNEL, INVOKE_CHANNEL } from "./ipc.ts";

const globals: unknown = ipcRenderer.sendSync("loki:globals");
if (globals) contextBridge.exposeInMainWorld("__LOKI__", globals);

contextBridge.exposeInMainWorld("lokiDesktop", {
  invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke(INVOKE_CHANNEL, command, args ?? {}),
  listen: (event: string, handler: (payload: unknown) => void): (() => void) => {
    const heard = (_e: IpcRendererEvent, name: unknown, payload: unknown) => {
      if (name === event) handler(payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, heard);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, heard);
    };
  },
});
