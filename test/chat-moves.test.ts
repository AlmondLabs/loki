import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeFor } from "../core/desk-core.ts";
import type { MovedChat } from "../daemon/chat-move.ts";
import { ChatMoves } from "../mod/chat-moves.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

const moved = (id: string): MovedChat => ({
  agent_id: "agent-ira",
  conversation_id: id,
  info: { title: id, archived: false, mode: null, labels: [], created_at: "2026-10-18T10:00:00Z" },
  agent: {},
  entries: [],
  schedules: [],
  cursors: {},
});

/**
 * The MacBook (old home of Ira's chats) and the mini (her home) with ChatMoves on each, joined by a link that calls
 * the MacBook's frame answers directly. `busy` names chats whose turn is running on the MacBook.
 */
function macs(busy = new Set<string>()) {
  const dir = mkdtempSync(join(tmpdir(), "loki-chat-moves-"));
  const bookWidgets = join(dir, "book-widgets");
  const miniWidgets = join(dir, "mini-widgets");
  const onBook = new Set(["conv-1", "conv-2"]);
  const finished: string[] = [];
  const onMini = new Set<string>();
  const done = new Set<string>();
  const bookChat = {
    moveCandidates: () => Promise.resolve([...onBook].map((c) => ({ agent_id: "agent-ira", conversation_id: c }))),
    exportChat: (_a: string, c: string) => Promise.resolve(busy.has(c) ? { chat: null, busy: true } : { chat: moved(c), busy: false }),
    finishMove: (_a: string, c: string) => (onBook.delete(c), finished.push(c), Promise.resolve()),
  };
  const miniChat = { importChat: (m: MovedChat) => (onMini.add(m.conversation_id), Promise.resolve(true)) };
  const book: ChatMoves = new ChatMoves({
    chat: bookChat as never,
    link: () => null,
    widgetsDir: bookWidgets,
    done: () => false,
    markDone: () => {},
    onMoved: () => {},
  });
  const link = {
    request: async (f: Record<string, unknown>) => {
      if (f.type === "peer_moves_get") return { chats: await bookChat.moveCandidates() };
      if (f.type === "peer_chat_export") return book.export(MINI, String(f.agent_id), String(f.conversation_id));
      if (f.type === "peer_chat_moved") return (await book.moved(String(f.agent_id), String(f.conversation_id)), {});
      throw new Error(`unexpected ${String(f.type)}`);
    },
  };
  const mini = new ChatMoves({
    chat: miniChat as never,
    link: () => link as never,
    widgetsDir: miniWidgets,
    done: (id) => done.has(id),
    markDone: (id) => done.add(id),
    onMoved: () => {},
  });
  return { dir, bookWidgets, miniWidgets, onBook, onMini, finished, done, book, mini, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("taking an agent's chats over on first pairing", () => {
  test("every idle chat moves once, with its canvas, and the old Mac lets each go only after it arrived", async () => {
    const m = macs();
    try {
      const scope = scopeFor("conv-1", "agent-ira");
      mkdirSync(join(m.bookWidgets, scope), { recursive: true });
      writeFileSync(join(m.bookWidgets, scope, "chart.tsx"), "export default 1");
      await m.mini.run(BOOK);
      expect([...m.onMini]).toEqual(["conv-1", "conv-2"]);
      expect(m.finished).toEqual(["conv-1", "conv-2"]);
      expect(readFileSync(join(m.miniWidgets, scope, "chart.tsx"), "utf8")).toBe("export default 1");
      expect(existsSync(join(m.bookWidgets, scope))).toBe(false);
      expect(m.done.has(BOOK)).toBe(true);
      // Done once: a later contact asks nothing.
      m.onBook.add("conv-3");
      await m.mini.run(BOOK);
      expect(m.onMini.has("conv-3")).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  test("a busy chat waits for the next contact, and the move is not marked done until it goes", async () => {
    const busy = new Set(["conv-2"]);
    const m = macs(busy);
    try {
      await m.mini.run(BOOK);
      expect([...m.onMini]).toEqual(["conv-1"]);
      expect(m.done.has(BOOK)).toBe(false);
      busy.clear();
      await m.mini.run(BOOK);
      expect([...m.onMini]).toEqual(["conv-1", "conv-2"]);
      expect(m.done.has(BOOK)).toBe(true);
    } finally {
      m.cleanup();
    }
  });

  test("a chat being handed over takes no message on the old Mac until the other Mac holds it", async () => {
    const m = macs();
    try {
      await m.book.export(MINI, "agent-ira", "conv-1");
      expect(m.book.blocked("agent-ira", "conv-1")).toMatch(/moving to the Mac its agent lives on/);
      expect(m.book.blocked("agent-ira", "conv-2")).toBeNull();
      await m.book.moved("agent-ira", "conv-1");
      expect(m.book.blocked("agent-ira", "conv-1")).toBeNull();
    } finally {
      m.cleanup();
    }
  });
});
