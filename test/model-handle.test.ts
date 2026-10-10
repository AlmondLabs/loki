import { describe, expect, test } from "bun:test";
import { piHandle } from "../daemon/model-handle.ts";

const known = (p: string) => ["openai-codex", "openrouter", "anthropic", "openai"].includes(p);

describe("model names pi-ai can run", () => {
  test("a known provider's handle is kept, even when a later part names another provider", () => {
    expect(piHandle("openai-codex/gpt-6.1-sol", known)).toBe("openai-codex/gpt-6.1-sol");
    expect(piHandle("openrouter/anthropic/claude-haiku", known)).toBe("openrouter/anthropic/claude-haiku");
  });
  test("Letta's names: ChatGPT's provider translated, a doubled prefix dropped", () => {
    expect(piHandle("chatgpt-plus-pro/gpt-6-luna", known)).toBe("openai-codex/gpt-6-luna");
    expect(piHandle("chatgpt-plus-pro/chatgpt-plus-pro/openai-codex/gpt-6.1-sol", known)).toBe("openai-codex/gpt-6.1-sol");
  });
  test("anything else stays as it is", () => {
    expect(piHandle("letta/auto", known)).toBe("letta/auto");
    expect(piHandle("gpt", known)).toBe("gpt");
  });
});
