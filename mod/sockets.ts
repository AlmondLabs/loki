import type { Scope } from "../core/desk-core.ts";
import type { Audience, LokiServer, WsBridge } from "./server.ts";

export type PushTo = "everyone" | "desktop" | "macs";

export interface PhoneListener {
  broadcast(msg: object, scope?: Scope, to?: Audience): void;
  broadcastText?(text: string, scope?: Scope, to?: Audience): void;
  clientCount(): number;
  stop(): Promise<unknown>;
}

export class Sockets<P extends PhoneListener = PhoneListener> {
  private server: LokiServer | null = null;
  private desktop: WsBridge | null = null;
  private lan: P | null = null;
  private stopped = false;

  push(msg: object, { to = "everyone", scope }: { to?: PushTo; scope?: Scope } = {}): void {
    const sendDesktop = to !== "macs" && (this.desktop?.clientCount() ?? 0) > 0;
    const sendLan = to !== "desktop" && (this.lan?.clientCount() ?? 0) > 0;
    if (!sendDesktop && !sendLan) return;
    const lanAudience: Audience = to === "macs" ? "macs" : "all";
    if (sendDesktop && sendLan && this.desktop?.broadcastText && this.lan?.broadcastText) {
      const text = JSON.stringify(msg);
      this.desktop.broadcastText(text, scope);
      this.lan.broadcastText(text, scope, lanAudience);
      return;
    }
    if (sendDesktop) this.desktop?.broadcast(msg, scope);
    if (sendLan) this.lan?.broadcast(msg, scope, lanAudience);
  }

  async serve(start: () => Promise<LokiServer>, attach: (server: LokiServer) => WsBridge): Promise<LokiServer> {
    const server = await start();
    if (this.stopped) {
      await server.close();
      throw new Error("the mod stopped while its server was starting");
    }
    this.server = server;
    this.desktop = attach(server);
    return server;
  }

  attachPhones(lan: P): void {
    this.lan = lan;
  }

  phoneListener(): P | null {
    return this.lan;
  }

  phones(): P {
    if (!this.lan) throw new Error("the phone listener is not up yet");
    return this.lan;
  }

  tabs(): number {
    return this.desktop?.clientCount() ?? 0;
  }

  stop(): void {
    this.stopped = true;
    this.desktop?.close();
    void this.server?.close();
    void this.lan?.stop();
    this.desktop = null;
    this.server = null;
  }
}
