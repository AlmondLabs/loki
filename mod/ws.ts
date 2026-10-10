/**
 * The `ws` the mod uses, chosen at runtime. loki's daemon runs the mod under Node, but the tests and a mod
 * loaded by hand may run it under Bun. Bun ships its own `ws`, and the copy esbuild inlines into the release
 * bundle (~/.loki/mod/loki-mod.mjs) cannot finish a handshake there: the 101 arrives as an "unexpected response"
 * and the socket closes before it opens (it once left the mod's client sockets quietly dark on any Mac with Bun). Under Bun,
 * ask the runtime for its own module (Bun resolves the bare specifier without a node_modules); under Node, the
 * inlined copy is the one that works. The development bundle (mod/boot.ts) leaves packages external, so it always
 * had the runtime's own.
 */
import { WebSocket as BundledWebSocket, WebSocketServer as BundledWebSocketServer } from "ws";

let socket: typeof BundledWebSocket = BundledWebSocket;
let server: typeof BundledWebSocketServer = BundledWebSocketServer;
/** Which `ws` this process ended up with; index.ts logs it at activate. */
export let wsSource = "bundled";
if (process.versions.bun) {
  try {
    // The specifier comes from the environment so esbuild cannot fold it back into the inlined copy ("w" + "s"
    // it folds); LOKI_WS_MODULE is only ever a debugging knob.
    const specifier = process.env.LOKI_WS_MODULE ?? "ws";
    const own = (await import(specifier)) as { WebSocket?: typeof BundledWebSocket; WebSocketServer?: typeof BundledWebSocketServer; default?: typeof BundledWebSocket };
    socket = own.WebSocket ?? own.default ?? socket;
    server = own.WebSocketServer ?? server;
    wsSource = own.WebSocket || own.default ? "bun's own" : "bundled (bun's import gave no WebSocket)";
  } catch (err) {
    wsSource = `bundled (bun's import failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export const WebSocket = socket;
export const WebSocketServer = server;
// The same names as types, for `sock: WebSocket` and friends.
export type WebSocket = BundledWebSocket;
export type WebSocketServer = BundledWebSocketServer;
