/**
 * The `ws` the mod uses, in one place. The mod runs under Node only (loki's daemon), so this is the package as
 * esbuild inlines it into the release bundle; the bundle's `require` banner (scripts/build-mod.ts) lets it reach
 * Node's builtins. It once also chose Bun's own `ws` at runtime, for tests run under Bun; nothing runs under Bun now.
 */
export { WebSocket, WebSocketServer } from "ws";
