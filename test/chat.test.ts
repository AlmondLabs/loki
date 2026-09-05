import { describe, expect, test } from "bun:test";
import {
  assistantTextFromChunk,
  createChatBridge,
  type ChatFrame,
  type ConversationHandle,
  extractHarnessEvents,
  stripHarnessMarkup,
  decodeEntities,
} from "../mod/chat.ts";

function handleReplying(replies: string[][]): { handle: ConversationHandle; sends: number } {
  const box = { handle: null as unknown as ConversationHandle, sends: 0 };
  box.handle = {
    id: "conv-1",
    sendMessageStream: async () => {
      const parts = replies[Math.min(box.sends++, replies.length - 1)];
      return (async function* () {
        for (const text of parts) yield { message_type: "assistant_message", content: text };
        yield { message_type: "stop_reason", stop_reason: "end_turn" };
      })();
    },
  };
  return box;
}

async function collect(bridge: ReturnType<typeof createChatBridge>, text: string) {
  const frames: ChatFrame[] = [];
  await bridge.send(text, (f) => frames.push(f));
  return frames;
}

describe("chat bridge — shared transcript, no forking", () => {
  test("sends into the live conversation and streams deltas", async () => {
    const box = handleReplying([["hel", "lo"]]);
    const bridge = createChatBridge({ getConversation: () => box.handle, isMainBusy: () => false });
    const frames = await collect(bridge, "hi");
    const deltas = frames.filter((f) => f.type === "chat_delta").map((f) => (f as { text: string }).text);
    expect(deltas.join("")).toBe("hello");
    expect(box.sends).toBe(1);
    expect(frames.at(-1)).toEqual({ type: "chat_state", state: "idle" });
  });

  test("no conversation captured → chat_error, no crash", async () => {
    const bridge = createChatBridge({ getConversation: () => null, isMainBusy: () => false });
    const frames = await collect(bridge, "hi");
    expect(frames.some((f) => f.type === "chat_error")).toBe(true);
  });

  test("mid-turn message is queued, not sent, then flushed on idle", async () => {
    const box = handleReplying([["queued reply"]]);
    let busy = true;
    const frames: ChatFrame[] = [];
    const bridge = createChatBridge({ getConversation: () => box.handle, isMainBusy: () => busy });

    await bridge.send("while busy", (f) => frames.push(f));
    expect(box.sends).toBe(0); // nothing sent while busy
    expect(frames).toContainEqual({ type: "chat_state", state: "thinking" });

    busy = false;
    bridge.onMainIdle();
    await new Promise((r) => setTimeout(r, 1400)); // debounced flush (1200ms) + margin

    expect(box.sends).toBe(1);
    expect(frames.some((f) => f.type === "chat_delta" && (f as { text: string }).text === "queued reply")).toBe(true);
  });

  test("a turn starting during the debounce cancels the flush (no tool-call interrupt)", async () => {
    const box = handleReplying([["late reply"]]);
    let busy = true;
    const bridge = createChatBridge({ getConversation: () => box.handle, isMainBusy: () => busy });

    await bridge.send("while busy", () => {});
    busy = false;
    bridge.onMainIdle(); // schedule flush
    await new Promise((r) => setTimeout(r, 400));
    // A tool-call gap: a new turn starts before the debounce elapses.
    busy = true;
    bridge.onMainBusy(); // cancels the pending flush
    await new Promise((r) => setTimeout(r, 1200));
    expect(box.sends).toBe(0); // never flushed into the active turn

    // When it finally settles, the flush goes through.
    busy = false;
    bridge.onMainIdle();
    await new Promise((r) => setTimeout(r, 1400));
    expect(box.sends).toBe(1);
  });

  test("second message while one is queued is rejected", async () => {
    const box = handleReplying([["r"]]);
    const bridge = createChatBridge({ getConversation: () => box.handle, isMainBusy: () => true });
    await collect(bridge, "first");
    const second = await collect(bridge, "second");
    expect(second.some((f) => f.type === "chat_error")).toBe(true);
  });

  test("stream failure reports the error and stays usable", async () => {
    let calls = 0;
    const handle: ConversationHandle = {
      id: "conv-1",
      sendMessageStream: async () => {
        calls++;
        if (calls === 1) throw new Error("stream exploded");
        return (async function* () {
          yield { message_type: "assistant_message", content: "ok" };
        })();
      },
    };
    const bridge = createChatBridge({ getConversation: () => handle, isMainBusy: () => false });
    const first = await collect(bridge, "hi");
    expect(first.some((f) => f.type === "chat_error" && (f as { message: string }).message.includes("exploded"))).toBe(true);
    const second = await collect(bridge, "again");
    expect(second.some((f) => f.type === "chat_delta")).toBe(true);
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

describe("messagesToChatHistory", () => {
  test("maps user/assistant turns, strips system tags, drops empties and non-text", async () => {
    const { messagesToChatHistory } = await import("../mod/chat.ts");
    const history = messagesToChatHistory([
      { message_type: "user_message", content: "<system-reminder>env stuff</system-reminder>Hi there" },
      { message_type: "assistant_message", content: [{ type: "text", text: "Hello" }] },
      { message_type: "tool_call_message", content: "ignored" },
      { message_type: "user_message", content: "<system-reminder>only machinery</system-reminder>" },
    ]);
    expect(history).toEqual([
      { role: "user", text: "Hi there" },
      { role: "assistant", text: "Hello" },
    ]);
  });
});

describe("bridge.history", () => {
  test("uses getHistory when available, empty otherwise", async () => {
    const withHistory: ConversationHandle = {
      id: "c",
      sendMessageStream: async () => (async function* () {})(),
      getHistory: async () => [{ message_type: "user_message", content: "yo" }],
    };
    const bridge = createChatBridge({ getConversation: () => withHistory, isMainBusy: () => false });
    expect(await bridge.history()).toEqual([{ role: "user", text: "yo" }]);

    const without = createChatBridge({ getConversation: () => null, isMainBusy: () => false });
    expect(await without.history()).toEqual([]);
  });
});

describe("harness markup", () => {
  const notif = `<task-notification>\n<task-id>bash_24</task-id>\n<status>completed</status>\n<summary>Background command "Re-auth dev" completed</summary>\n<result>$ cd /tmp\nnohup aws sso login &gt; /tmp/x 2&gt;&amp;1 &amp;</result>\n<usage>duration_ms: 1</usage>\n</task-notification>\nFull transcript available at: /var/x/bash_24.log`;
  test("task notifications and compaction alerts become events; the rest of the text stays", () => {
    const text = `${notif}\n\nplease continue`;
    const events = extractHarnessEvents(text);
    expect(events).toEqual([{ text: "background task bash_24 completed", summary: 'Background command "Re-auth dev" completed', detail: "$ cd /tmp\nnohup aws sso login > /tmp/x 2>&1 &" }]);
    expect(stripHarnessMarkup(text).trim()).toBe("please continue");
    const alert = extractHarnessEvents('{"type":"system_alert","message":"Note: 14 messages from the beginning of the conversation have been hidden from view due to memory constraints.\\nSummary…"}');
    expect(alert[0]).toMatchObject({ text: "context compacted" });
    expect(stripHarnessMarkup('{"type":"system_alert","message":"x"}').trim()).toBe("");
    expect(decodeEntities("a &lt;b&gt; &amp;&quot;")).toBe('a <b> &"');
  });
});
