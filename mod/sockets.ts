import type { Scope } from "../core/desk-core.ts";
import type { Audience, LokiServer, WsBridge } from "./server.ts";

/**
 * The mod's two listeners (docs/architecture.md, "The ports, and why there are two"): the loopback server, whose
 * sockets are this Mac's own tabs, and the LAN listener, whose sockets are paired phones and paired Macs. Every push
 * names who it is for, so the rule lives here once rather than in which listener each caller reached for:
 *  - everyone: every tab, phone and paired Mac following the desk
 *  - desktop:  this Mac's tabs only, for its settings (the phone listener's status, the paired devices and Macs)
 *  - macs:     paired Macs only, for the person's state, memory and group, which no phone or tab reads (plan 023)
 * The phone listener is built after the bridge it serves, so it is handed over once it exists.
 */

/** Who a push is for. */
export type PushTo = "everyone" | "desktop" | "macs";

/** The phone listener as Sockets uses it: mod/lan.ts's LanListener, or a fake in a test. */
export interface PhoneListener {
  broadcast(msg: object, scope?: Scope, to?: Audience): void;
  clientCount(): number;
  stop(): Promise<unknown>;
}

/** The mod's listeners, and the one way to push to them. */
export class Sockets<P extends PhoneListener = PhoneListener> {
  private server: LokiServer | null = null;
  private desktop: WsBridge | null = null;
  private lan: P | null = null;
  /** Set when the mod stops: a server still starting then closes as soon as it is up, so the next mod can have its port. */
  private stopped = false;

  /** Send `msg` to its audience; `scope` keeps it to the sockets showing that desk (a paired Mac follows every desk). */
  push(msg: object, { to = "everyone", scope }: { to?: PushTo; scope?: Scope } = {}): void {
    if (to !== "macs") this.desktop?.broadcast(msg, scope);
    if (to !== "desktop") this.lan?.broadcast(msg, scope, to === "macs" ? "macs" : "all");
  }

  /** Start the loopback server and attach its sockets; one that comes up after the mod stopped is closed again. */
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

  /** Hand over the phone listener, once it is built. */
  attachPhones(lan: P): void {
    this.lan = lan;
  }

  /** The phone listener, or null before it is built. */
  phoneListener(): P | null {
    return this.lan;
  }

  /** The phone listener; asked for only by what runs after it is built (frames, pairing), so it is there. */
  phones(): P {
    if (!this.lan) throw new Error("the phone listener is not up yet");
    return this.lan;
  }

  /** How many of this Mac's tabs are connected. */
  tabs(): number {
    return this.desktop?.clientCount() ?? 0;
  }

  /** Close every socket and both listeners; the phone listener's setting stays, so it returns with the mod. */
  stop(): void {
    this.stopped = true;
    this.desktop?.close();
    void this.server?.close();
    void this.lan?.stop();
    this.desktop = null;
    this.server = null;
  }
}
