import { describe, expect, test } from "bun:test";
import { assistantTextFromChunk, createChatBridge, type ChatFrame, type ConversationHandle } from "../src/chat";

function fakeConversation(replies: string[][]): { handle: ConversationHandle; forks: number } {
  const counter = { handle: null as unknown as ConversationHandle, forks: 0 };
  let call = 0;
  const forked: ConversationHandle = {
    id: "fork-1",
    fork: () => Promise.reject(new Error("no nested forks")),
    sendMessageStream: async () => {
      const parts = replies[Math.min(call++, replies.length - 1)];
      return (async function* () {
        for (const text of parts) {
          yield { message_type: "assistant_message", content: text };
        }
        yield { message_type: "stop_reason", stop_reason: "end_turn" };
      })();
    },
  };
  counter.handle = {
    id: "conv-1",
    fork: async () => {
      counter.forks++;
      return forked;
    },
    sendMessageStream: () => Promise.reject(new Error("direct send forbidden in tests")),
  };
  return counter;
}

async function collect(bridge: ReturnType<typeof createChatBridge>, text: string) {
  const frames: ChatFrame[] = [];
  await bridge.send(text, (f) => frames.push(f));
  return frames;
}

describe("chat bridge", () => {
  test("streams deltas and returns to idle", async () => {
    const conv = fakeConversation([["hel", "lo"]]);
    const bridge = createChatBridge(() => conv.handle);
    const frames = await collect(bridge, "hi");
    const deltas = frames.filter((f) => f.type === "chat_delta").map((f) => (f as { text: string }).text);
    expect(deltas.join("")).toBe("hello");
    expect(frames.at(-1)).toEqual({ type: "chat_state", state: "idle" });
    expect(frames.some((f) => f.type === "chat_done")).toBe(true);
  });

  test("forks once and reuses the fork across messages", async () => {
    const conv = fakeConversation([["a"], ["b"]]);
    const bridge = createChatBridge(() => conv.handle);
    await collect(bridge, "one");
    await collect(bridge, "two");
    expect(conv.forks).toBe(1);
  });

  test("no conversation captured → chat_error, no crash", async () => {
    const bridge = createChatBridge(() => null);
    const frames = await collect(bridge, "hi");
    expect(frames.some((f) => f.type === "chat_error")).toBe(true);
  });

  test("stream failure resets the fork and reports the error", async () => {
    let calls = 0;
    const handle: ConversationHandle = {
      id: "conv-1",
      fork: async () => ({
        id: "fork-x",
        fork: () => Promise.reject(new Error("nope")),
        sendMessageStream: async () => {
          calls++;
          throw new Error("stream exploded");
        },
      }),
      sendMessageStream: () => Promise.reject(new Error("unused")),
    };
    const bridge = createChatBridge(() => handle);
    const frames = await collect(bridge, "hi");
    expect(frames.some((f) => f.type === "chat_error" && (f as { message: string }).message.includes("exploded"))).toBe(true);
    // Next send re-forks instead of reusing the dead fork.
    await collect(bridge, "again");
    expect(calls).toBe(2);
  });
});

describe("assistantTextFromChunk", () => {
  test("string content", () => {
    expect(assistantTextFromChunk({ message_type: "assistant_message", content: "hi" })).toBe("hi");
  });
  test("parts content picks text parts only", () => {
    expect(
      assistantTextFromChunk({
        message_type: "assistant_message",
        content: [
          { type: "text", text: "a" },
          { type: "reasoning", text: "IGNORED" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });
  test("non-assistant chunks are empty", () => {
    expect(assistantTextFromChunk({ message_type: "reasoning_message", reasoning: "x" })).toBe("");
    expect(assistantTextFromChunk({ message_type: "stop_reason" })).toBe("");
  });
});
