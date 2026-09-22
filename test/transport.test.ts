import { describe, expect, test } from "bun:test";
import { TauriTransport } from "../app/src/shell/transport.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Tauri transport", () => {
  test("closing during listener setup disposes the late listener and stops setup", async () => {
    const firstListener = deferred<() => void>();
    let unlistened = 0;
    let listenCalls = 0;
    let invokeCalls = 0;
    let opened = 0;
    const transport = new TauriTransport({
      listen: async () => {
        listenCalls++;
        return firstListener.promise;
      },
      invoke: async () => {
        invokeCalls++;
        return true;
      },
    });

    transport.open({ onOpen: () => opened++, onMessage: () => {}, onClose: () => {}, onError: () => {} });
    await Promise.resolve();
    transport.close();
    firstListener.resolve(() => unlistened++);
    await Promise.resolve();
    await Promise.resolve();

    expect(unlistened).toBe(1);
    expect(listenCalls).toBe(1);
    expect(invokeCalls).toBe(0);
    expect(opened).toBe(0);
  });

  test("ignores late events and a late handshake after close", async () => {
    const handshake = deferred<unknown>();
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    let unlistened = 0;
    let opened = 0;
    let messages = 0;
    const transport = new TauriTransport({
      listen: async (event, handler) => {
        handlers.set(event, handler);
        return () => unlistened++;
      },
      invoke: async () => handshake.promise,
    });

    transport.open({ onOpen: () => opened++, onMessage: () => messages++, onClose: () => {}, onError: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    transport.close();
    handlers.get("app-server:status")?.({ payload: { state: "open" } });
    handlers.get("app-server:event")?.({ payload: "late" });
    handshake.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(unlistened).toBe(2);
    expect(opened).toBe(0);
    expect(messages).toBe(0);
  });
});
