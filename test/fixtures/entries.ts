import type { ImportedEntry } from "../../daemon/kernel/index.ts";

/**
 * Entries written straight into a chat (`AgentStore.importEntries`, as a chat moving from another Mac writes them): a
 * question, a tool call and its result, an answer, a compaction that keeps from the answer, and a later turn.
 */
export const sampleEntries = (): ImportedEntry[] => structuredClone(SAMPLE);

/** A first try, an answer the person saw but the model never did (a branch entry), and the answer that was kept. */
export const branchEntries = (): ImportedEntry[] => structuredClone(BRANCH);

const SAMPLE: ImportedEntry[] = [
  {
    sourceId: "e1",
    line: 1,
    kind: "pi.user",
    model: [
      {
        role: "user",
        timestamp: 1790848801000,
        content: [
          {
            type: "text",
            text: "What is in the readme?",
          },
        ],
      },
    ],
  },
  {
    sourceId: "e2",
    line: 2,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        timestamp: 1790848802000,
        content: [
          {
            type: "thinking",
            thinking: "hm",
          },
          {
            type: "text",
            text: "Let me look.",
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "Read",
            arguments: {
              file_path: "README.md",
            },
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-test",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
      },
    ],
  },
  {
    sourceId: "e3",
    line: 3,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        timestamp: 1790848803000,
        toolCallId: "call-1",
        toolName: "Read",
        content: [
          {
            type: "text",
            text: "# loki",
          },
        ],
        isError: false,
      },
    ],
    data: {
      diagnostics: [],
    },
  },
  {
    sourceId: "e4",
    line: 4,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        timestamp: 1790848804000,
        content: [
          {
            type: "thinking",
            thinking: "hm",
          },
          {
            type: "text",
            text: "It is the loki readme.",
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-test",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
      },
    ],
  },
  {
    sourceId: "e5",
    line: 5,
    kind: "pi.compaction",
    model: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nAsked about the readme.\n</summary>",
          },
        ],
        timestamp: 1790848805000,
      },
    ],
    data: {
      reason: "threshold",
    },
    headSourceId: "e4",
  },
  {
    sourceId: "e6",
    line: 6,
    kind: "pi.user",
    model: [
      {
        role: "user",
        timestamp: 1790848806000,
        content: [
          {
            type: "text",
            text: "Thanks",
          },
        ],
      },
    ],
  },
];

const BRANCH: ImportedEntry[] = [
  {
    sourceId: "a",
    line: 1,
    kind: "pi.user",
    model: [
      {
        role: "user",
        timestamp: 1790848801000,
        content: [
          {
            type: "text",
            text: "first try",
          },
        ],
      },
    ],
  },
  {
    sourceId: "x",
    line: 2,
    kind: "loki.branch",
    data: {
      message: {
        role: "assistant",
        timestamp: 1790848802000,
        content: [
          {
            type: "thinking",
            thinking: "hm",
          },
          {
            type: "text",
            text: "abandoned answer",
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-test",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
      },
    },
  },
  {
    sourceId: "y",
    line: 3,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        timestamp: 1790848803000,
        content: [
          {
            type: "thinking",
            thinking: "hm",
          },
          {
            type: "text",
            text: "kept answer",
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-test",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
      },
    ],
  },
];
