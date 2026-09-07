import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri } from "../desk/env";
import type { Transport } from "../../../packages/core/src/attention/transport.ts";

/**
 * How frames reach Letta's app-server from the canvas. In a browser tab: a WebSocket to the
 * mod's tunnel. In the Tauri shell: the Rust core holds the socket (it can send
 * the bearer token) and relays frames as events. Same interface (from core) either way.
 */
export type { Transport };

export class BrowserTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  open(h: Parameters<Transport["open"]>[0]): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = h.onOpen;
    ws.onmessage = (e) => h.onMessage(String(e.data));
    ws.onerror = () => h.onError(new Error("app-server tunnel failed"));
    ws.onclose = () => {
      this.ws = null;
      h.onClose();
    };
  }
  send(raw: string): void {
    this.ws?.send(raw);
  }
  close(): void {
    this.ws?.close();
  }
}

/** Events from the Rust link: `app-server:status` {state} and `app-server:event` (a JSON frame as text). */
export class TauriTransport implements Transport {
  /** The Rust core reconnects by itself and reports "open" again; the socket must not rebuild us. */
  readonly reconnects = true;
  private unlisten: UnlistenFn[] = [];
  private isOpen = false;
  open(h: Parameters<Transport["open"]>[0]): void {
    void (async () => {
      this.unlisten.push(
        await listen<{ state: string }>("app-server:status", (e) => {
          if (e.payload.state === "open" && !this.isOpen) {
            this.isOpen = true;
            h.onOpen();
          } else if (e.payload.state === "closed" && this.isOpen) {
            this.isOpen = false;
            h.onClose();
          }
        }),
      );
      this.unlisten.push(await listen<string>("app-server:event", (e) => h.onMessage(e.payload)));
      // The link may already be up: ask, and treat a successful send as proof.
      const ok = await invoke<boolean>("appserver_send", { text: JSON.stringify({ type: "app_server_info", request_id: "loki-hello" }) }).catch(() => false);
      if (ok && !this.isOpen) {
        this.isOpen = true;
        h.onOpen();
      }
    })();
  }
  send(raw: string): void {
    void invoke<boolean>("appserver_send", { text: raw }).catch((err) => console.warn("loki: appserver_send", err));
  }
  close(): void {
    for (const u of this.unlisten) u();
    this.unlisten = [];
  }
}

export function makeTransport(url: string): Transport {
  return inTauri ? new TauriTransport() : new BrowserTransport(url);
}
