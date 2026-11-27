import { describe, expect, test } from "vitest";
import { backendName, conversationDirName, isMainChat, MAIN_CHAT_ID, mainChatAgent, scopeFor } from "../core/chat-scope.ts";

describe("chat-scope", () => {
  test("scopeFor sanitizes conversation ids and keys default chats by agent", () => {
    expect(scopeFor(null)).toBe("shared");
    expect(scopeFor("conv-abc/../x y")).toBe("conv-abc____x_y");
    expect(scopeFor("default", "agent-local-1")).toBe("default-agent-local-1");
    expect(scopeFor("default", "agent-local-2")).not.toBe(scopeFor("default", "agent-local-1"));
    expect(scopeFor("default")).toBe("default");
  });

  test('the main chat has one name: stored as "default", its scope leads back to its agent, its folder is keyed by agent', () => {
    expect(MAIN_CHAT_ID).toBe("default");
    expect(isMainChat(MAIN_CHAT_ID)).toBe(true);
    expect(isMainChat("conv-1")).toBe(false);
    expect(isMainChat(null)).toBe(false);
    expect(mainChatAgent(scopeFor(MAIN_CHAT_ID, "a1"))).toBe("a1");
    expect(mainChatAgent("conv-1")).toBeNull();
    expect(mainChatAgent("shared")).toBeNull();
    expect(conversationDirName(MAIN_CHAT_ID, "a1")).toBe(backendName("default:a1"));
    expect(conversationDirName("conv-1", "a1")).toBe(backendName("conversation:conv-1"));
  });
});
