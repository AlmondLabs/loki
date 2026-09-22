import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri } from "../desk/env";
import type { Transport } from "../../../core/attention/transport.ts";

/**
 * How frames reach Letta's app-server from the canvas. In a browser tab: a WebSocket to the
 * mod's tunnel. In the Tauri shell: the Rust core holds the socket (it can send
 * the bearer token) and relays frames as events. Same interface (from core) either way.
 */
export type { Transport };

interface TauriTransportDeps {
  listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<UnlistenFn>;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const tauriDeps: TauriTransportDeps = {
  listen: (event, handler) => listen<unknown>(event, handler),
  invoke: (command, args) => invoke(command, args),
};

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
  private revision = 0;
  private readonly deps: TauriTransportDeps;

  constructor(deps: TauriTransportDeps = tauriDeps) {
    this.deps = deps;
  }

  open(h: Parameters<Transport["open"]>[0]): void {
    const revision = ++this.revision;
    void (async () => {
      const statusUnlisten = await this.deps.listen("app-server:status", (e) => {
        if (revision !== this.revision) return;
        const state = (e.payload as { state?: string }).state;
        if (state === "open" && !this.isOpen) {
          this.isOpen = true;
          h.onOpen();
        } else if (state === "closed" && this.isOpen) {
          this.isOpen = false;
          h.onClose();
        }
      });
      if (!this.keepListener(revision, statusUnlisten)) return;
      const eventUnlisten = await this.deps.listen("app-server:event", (e) => {
        if (revision === this.revision) h.onMessage(String(e.payload));
      });
      if (!this.keepListener(revision, eventUnlisten)) return;
      // The link may already be up: ask, and treat a successful send as proof.
      const ok = await this.deps.invoke("appserver_send", { text: JSON.stringify({ type: "app_server_info", request_id: "loki-hello" }) }).catch(() => false);
      if (revision === this.revision && ok === true && !this.isOpen) {
        this.isOpen = true;
        h.onOpen();
      }
    })().catch((err) => {
      if (revision === this.revision) h.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }
  send(raw: string): void {
    void this.deps.invoke("appserver_send", { text: raw }).catch((err) => console.warn("loki: appserver_send", err));
  }
  close(): void {
    this.revision++;
    for (const u of this.unlisten) u();
    this.unlisten = [];
    this.isOpen = false;
  }

  private keepListener(revision: number, unlisten: UnlistenFn): boolean {
    if (revision !== this.revision) {
      unlisten();
      return false;
    }
    this.unlisten.push(unlisten);
    return true;
  }
}

export function makeTransport(url: string): Transport {
  return inTauri ? new TauriTransport() : new BrowserTransport(url);
}
