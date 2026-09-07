/**
 * How frames reach Letta's app-server. The client hands one in; core never picks.
 * A browser tab opens a WebSocket to the mod's tunnel, the Tauri shell relays
 * through the Rust core (which holds the socket and its bearer token), the phone
 * opens a WebSocket with a bearer header. `AppServerSocket` speaks only to this.
 */
export interface Transport {
  open(handlers: { onOpen: () => void; onMessage: (raw: string) => void; onClose: () => void; onError: (err: Error) => void }): void;
  send(raw: string): void;
  close(): void;
  /**
   * True when the link re-establishes itself and reports open again (the Rust core does).
   * The socket then leaves a closed transport alone instead of building a new one with backoff.
   */
  readonly reconnects?: boolean;
}

/** Builds the transport for a tunnel URL; passed into `useAttention` / `AppServerSocket`. */
export type MakeTransport = (url: string) => Transport;
