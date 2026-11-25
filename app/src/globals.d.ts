declare const __LOKI_VERSION__: string;
declare const __LOKI_REPO__: string;

/**
 * What desktop/preload.ts puts on the page in loki's desktop shell, absent in a browser tab and on the phone: `invoke`
 * runs one of the shell's commands (desktop/ipc.ts) with its arguments, `listen` hears one of its events, by name, until
 * the function it returns is called.
 */
interface LokiDesktop {
  invoke: (command: string, args?: object) => Promise<unknown>;
  listen: (event: string, handler: (payload: unknown) => void) => () => void;
}

interface Window {
  lokiDesktop?: LokiDesktop;
}
