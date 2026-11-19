import { describe, expect, test } from "vitest";
import type { AttentionItem } from "../core/attention/model.ts";
import { FLOW_HINT_KEY, createFlowHint, hintShows } from "../app/src/phone/flow-hint.tsx";

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "c1",
  agent_id: "a1",
  agent_name: "friday",
  title: "data pipelines",
  last_message_at: "2026-09-25T10:00:00Z",
  archived: false,
  status: "done",
  lastAssistantText: "x",
  lastRole: "assistant",
  pendingApproval: null,
  pendingQuestion: null,
  error: null,
  seenAt: null,
  unread: true,
  viewedAt: null,
  lastAsk: null,
  score: 0,
  reason: "other",
  focus: 0,
  runtime: { agent_id: "a1", conversation_id: "c1" },
  ...over,
});

const memory = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
};

describe("the one-time hint for the box drags (R11)", () => {
  const ask = item({ pendingApproval: { requestId: "r", toolName: "Bash", input: {}, at: "2026-09-25T10:00:00Z" } });

  test("shows on the first card that is not an approval, and waits while an approval is on top", () => {
    expect(hintShows("unseen", item())).toBe(true);
    expect(hintShows("unseen", ask)).toBe(false);
    expect(hintShows("unseen", undefined)).toBe(false);
  });

  test("once dismissed it stays dismissed, in the phone's lasting storage", () => {
    const storage = memory();
    const first = createFlowHint(() => storage);
    expect(first.get()).toBe("unseen");
    first.set("seen");
    expect(storage.getItem(FLOW_HINT_KEY)).toBe("seen");
    expect(createFlowHint(() => storage).get()).toBe("seen");
    expect(hintShows("seen", item())).toBe(false);
  });

  test("storage that throws costs nothing but the memory: no crash, and a dismissal holds for the visit", () => {
    const hint = createFlowHint(() => {
      throw new Error("blocked");
    });
    expect(hint.get()).toBe("unseen");
    hint.set("seen");
    expect(hint.get()).toBe("seen");
  });
});
