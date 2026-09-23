import { describe, expect, test } from "bun:test";
import { AppServerSocket } from "../core/attention/protocol.ts";
import type { Transport } from "../core/attention/transport.ts";

/**
 * Renaming a desk (core/attention/protocol.ts renameConversation): the app-server's conversation_update with
 * the new name as Letta's `summary`, the field a desk's title is read from; a refusal comes back as the error.
 */

/** A transport that answers every frame with `reply(frame)`, keeping what was sent. */
function fake(reply: (m: Record<string, unknown>) => Record<string, unknown>) {
  let handlers: Parameters<Transport["open"]>[0] | null = null;
  const sent: Array<Record<string, unknown>> = [];
  const transport: Transport = {
    open(next) {
      handlers = next;
      queueMicrotask(next.onOpen);
    },
    send(raw) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      sent.push(m);
      queueMicrotask(() => handlers?.onMessage(JSON.stringify({ request_id: m.request_id, ...reply(m) })));
    },
    close() {},
  };
  return { socket: new AppServerSocket("ws://test", () => transport), sent };
}

describe("rename protocol", () => {
  test("sends conversation_update with the name as the summary", async () => {
    const { socket, sent } = fake(() => ({ type: "conversation_update_response", success: true, conversation: { id: "conv-1", summary: "Q3 plan" } }));
    await socket.renameConversation("conv-1", "Q3 plan");
    expect(sent[0]).toMatchObject({ type: "conversation_update", conversation_id: "conv-1", body: { summary: "Q3 plan" } });
    expect(Object.keys(sent[0].body as object)).toEqual(["summary"]);
    socket.close();
  });

  test("a refusal throws the app-server's own words", async () => {
    const { socket } = fake(() => ({ type: "conversation_update_response", success: false, conversation: null, error: "Conversation not found" }));
    await expect(socket.renameConversation("conv-2", "x")).rejects.toThrow("Conversation not found");
    socket.close();
  });
});
