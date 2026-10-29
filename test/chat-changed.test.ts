import { describe, expect, test } from "vitest";
import { chatFrames, type ChatBackend } from "../mod/frames/chat.ts";
import type { FrameContext } from "../mod/frames/context.ts";
import type { DeskTitleFrame } from "../mod/chat-listing.ts";
import { must } from "./fixtures/must.ts";

/** A chat renamed, archived, hidden or relabelled: every client hears it (chat_changed), not only the one that changed it. */

const ctx = () => {
  const broadcasts: Array<{ frame: { type: string }; scope?: string }> = [];
  const c = {
    client: { scope: "s", send: () => {} },
    push: () => {},
    broadcast: (frame: { type: string }, scope?: string) => broadcasts.push({ frame, scope }),
    track: () => {},
  } as unknown as FrameContext;
  return { c, broadcasts };
};

const backend = (fail = false) =>
  ({
    update: async () => (fail ? Promise.reject(new Error("no chat conv-1")) : undefined),
  }) as unknown as ChatBackend;

const title = (conversationId: string): DeskTitleFrame => ({
  type: "desk_title",
  scope: conversationId,
  title: "renamed",
  status: "archived",
  agent_name: null,
  model: null,
  reasoning_effort: null,
  mode: null,
});

const update = { agent_id: "agent-local-a", conversation_id: "conv-1", title: "renamed", archived: true } as never;

describe("chat_changed", () => {
  test("an update tells every client, and the tabs showing the chat its title, once it is done", async () => {
    const { c, broadcasts } = ctx();
    const h = chatFrames({ chat: backend(), titleFrame: (_, conversationId) => title(conversationId) });
    expect(await must(h.chat_update, "the chat_update handler")(update, c)).toMatchObject({ ok: true });
    expect(broadcasts).toEqual([{ frame: title("conv-1"), scope: "conv-1" }, { frame: { type: "chat_changed" } }]);
  });

  test("a chat with no title yet still tells every client", async () => {
    const { c, broadcasts } = ctx();
    const h = chatFrames({ chat: backend(), titleFrame: () => null });
    expect(await must(h.chat_update, "the chat_update handler")(update, c)).toMatchObject({ ok: true });
    expect(broadcasts).toEqual([{ frame: { type: "chat_changed" } }]);
  });

  test("an update that failed tells no one", async () => {
    const { c, broadcasts } = ctx();
    const h = chatFrames({ chat: backend(true), titleFrame: (_, conversationId) => title(conversationId) });
    expect(await must(h.chat_update, "the chat_update handler")(update, c)).toMatchObject({ ok: false });
    expect(broadcasts).toEqual([]);
  });
});
