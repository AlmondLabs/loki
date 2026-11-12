import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeFor } from "../core/desk-core.ts";
import { MOVE_OUT_OF_REACH } from "../core/frames.ts";
import type { MovedChat } from "../daemon/chat-move.ts";
import { ChatMoves, writeWidgets } from "../mod/chat-moves.ts";

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
 * The MacBook (old home of Ira's chats) and the mini (her home), with ChatMoves on each, joined by an in-memory link
 * that answers each frame as mod/frames/peers.ts does, by the other Mac's moves. `busy` names chats whose turn is
 * running on the MacBook; `miniUp` whether the MacBook can reach the mini.
 */
function macs(busy = new Set<string>(), miniUp = true) {
  const dir = mkdtempSync(join(tmpdir(), "loki-chat-moves-"));
  const bookWidgets = join(dir, "book-widgets");
  const miniWidgets = join(dir, "mini-widgets");
  const onBook = new Set(["conv-1", "conv-2"]);
  const finished: string[] = [];
  const onMini = new Set<string>();
  const done = new Set<string>();
  const left: Array<[string, string]> = [];
  const imported: MovedChat[] = [];
  const store = (chats: Set<string>) => ({
    moveCandidates: () => Promise.resolve([...chats].map((c) => ({ agent_id: "agent-ira", conversation_id: c }))),
    exportChat: (_a: string, c: string) =>
      Promise.resolve(busy.has(c) ? { chat: null, busy: true } : chats.has(c) ? { chat: moved(c), busy: false } : { chat: null, busy: false }),
    finishMove: (_a: string, c: string) => (chats.delete(c), finished.push(c), Promise.resolve()),
    importChat: (m: MovedChat) => (chats.add(m.conversation_id), imported.push(m), Promise.resolve(true)),
  });
  /** The link from `from` to the Mac whose moves are `to` and whose chats are `toChats`. */
  const link = (from: string, to: () => ChatMoves, toChats: Set<string>) => ({
    request: async (f: Record<string, unknown>) => {
      const [a, c] = [String(f.agent_id), String(f.conversation_id)];
      if (f.type === "peer_where") return { held: toChats.has(c), moved_to: null };
      if (f.type === "peer_moves_get") return { chats: await to().candidates(from) };
      if (f.type === "peer_chat_export") return to().export(from, a, c);
      if (f.type === "peer_chat_moved") return (await to().moved(from, a, c), {});
      if (f.type === "peer_chat_take") return to().take(from, a, c);
      throw new Error(`unexpected ${String(f.type)}`);
    },
  });
  const names: Record<string, string> = { [BOOK]: "MacBook", [MINI]: "Mac mini" };
  /** Whether the MacBook can reach the mini now; a test turns it off and on. */
  const reach = { mini: miniUp };
  const mac = (here: string, chats: Set<string>, widgetsDir: string, other: () => ChatMoves, otherChats: Set<string>, up: () => boolean, file?: string) =>
    new ChatMoves({
      here,
      chat: store(chats),
      link: (id) => (names[id] && up() ? (link(here, other, otherChats) as never) : null),
      ...(file ? { file } : {}),
      widgetsDir,
      name: (id) => (id === null ? names[here] : (names[id] ?? null)),
      done: (id) => here === MINI && done.has(id),
      markDone: (id) => void done.add(id),
      onMoved: () => {},
      onLeft: (chat, to) => void left.push([chat.conversation_id, to]),
    });
  const bookFile = join(dir, "book-moves.json");
  let book: ChatMoves = mac(
    BOOK,
    onBook,
    bookWidgets,
    () => mini,
    onMini,
    () => reach.mini,
    bookFile,
  );
  const mini: ChatMoves = mac(
    MINI,
    onMini,
    miniWidgets,
    () => book,
    onBook,
    () => true,
  );
  return {
    dir,
    bookWidgets,
    miniWidgets,
    onBook,
    onMini,
    imported,
    finished,
    done,
    left,
    get book() {
      return book;
    },
    mini,
    reach,
    /** The MacBook's daemon starting again over the same holds file. */
    restartBook: () =>
      (book = mac(
        BOOK,
        onBook,
        bookWidgets,
        () => mini,
        onMini,
        () => reach.mini,
        bookFile,
      )),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("a moved canvas's files", () => {
  test("one that would land outside its folder is skipped, a Windows path with backslashes too", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-widgets-"));
    try {
      const canvas = join(dir, "canvas");
      const data = Buffer.from("x").toString("base64");
      writeWidgets(canvas, { "../out.tsx": data, "..\\out.tsx": data, "/abs.tsx": data, "ok/chart.tsx": data });
      expect(readdirSync(canvas)).toEqual(["ok"]);
      expect(readdirSync(dir)).toEqual(["canvas"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("taking an agent's chats over on first pairing", () => {
  test("every idle chat moves once, with its canvas, and the old Mac lets each go only after it arrived", async () => {
    const m = macs();
    try {
      const scope = scopeFor("conv-1", "agent-ira");
      mkdirSync(join(m.bookWidgets, scope), { recursive: true });
      writeFileSync(join(m.bookWidgets, scope, "chart.tsx"), "export default 1");
      await m.mini.takeOver(BOOK);
      expect([...m.onMini]).toEqual(["conv-1", "conv-2"]);
      expect(m.finished).toEqual(["conv-1", "conv-2"]);
      expect(readFileSync(join(m.miniWidgets, scope, "chart.tsx"), "utf8")).toBe("export default 1");
      expect(existsSync(join(m.bookWidgets, scope))).toBe(false);
      expect(m.done.has(BOOK)).toBe(true);
      // Done once: a later contact asks nothing.
      m.onBook.add("conv-3");
      await m.mini.takeOver(BOOK);
      expect(m.onMini.has("conv-3")).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  test("a busy chat waits for the next contact, and the move is not marked done until it goes", async () => {
    const busy = new Set(["conv-2"]);
    const m = macs(busy);
    try {
      await m.mini.takeOver(BOOK);
      expect([...m.onMini]).toEqual(["conv-1"]);
      expect(m.done.has(BOOK)).toBe(false);
      busy.clear();
      await m.mini.takeOver(BOOK);
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
      expect(m.book.blocked("agent-ira", "conv-1")).toMatch(/this chat is moving to Mac mini/);
      expect(m.book.blocked("agent-ira", "conv-2")).toBeNull();
      await m.book.moved(MINI, "agent-ira", "conv-1");
      expect(m.book.blocked("agent-ira", "conv-1")).toBeNull();
    } finally {
      m.cleanup();
    }
  });
});

describe("a message that arrives while a chat's log is being copied out", () => {
  test("is refused from the moment the copy starts; a chat that turns out busy or gone takes messages again", async () => {
    const busy = new Set<string>();
    const m = macs(busy);
    try {
      // Read before the copy's answer comes: the hold is already on.
      const copying = m.book.export(MINI, "agent-ira", "conv-1");
      expect(m.book.blocked("agent-ira", "conv-1")).toMatch(/this chat is moving to Mac mini/);
      await copying;
      expect(m.book.blocked("agent-ira", "conv-1")).toMatch(/moving/);
      busy.add("conv-2");
      await m.book.export(MINI, "agent-ira", "conv-2");
      expect(m.book.blocked("agent-ira", "conv-2")).toBeNull();
      await m.book.export(MINI, "agent-ira", "no-such-chat");
      expect(m.book.blocked("agent-ira", "no-such-chat")).toBeNull();
    } finally {
      m.cleanup();
    }
  });
});

describe("an agent's home set to this Mac after pairing", () => {
  test("brings its chats over even though the first hand-over already ran", async () => {
    const m = macs();
    try {
      await m.mini.takeOver(BOOK);
      expect(m.done.has(BOOK)).toBe(true);
      m.onBook.add("conv-3");
      await m.mini.takeOver(BOOK);
      expect(m.onMini.has("conv-3")).toBe(false);
      await m.mini.takeOver(BOOK, true);
      expect(m.onMini.has("conv-3")).toBe(true);
    } finally {
      m.cleanup();
    }
  });
});

describe("moving one chat by hand", () => {
  test("arrives placed, so the hand-over leaves it, and the old Mac lets it go; a busy chat stays and says so", async () => {
    const m = macs(new Set(["conv-2"]));
    try {
      expect(await m.mini.take(BOOK, "agent-ira", "conv-1")).toEqual({ moved: true, busy: false });
      expect(m.imported.map((c) => [c.conversation_id, c.info.placed])).toEqual([["conv-1", true]]);
      expect(m.finished).toEqual(["conv-1"]);
      expect(await m.mini.take(BOOK, "agent-ira", "conv-2")).toEqual({ moved: false, busy: true });
      expect(m.onBook.has("conv-2")).toBe(true);
      // The hand-over is not marked done by a move by hand.
      expect(m.done.has(BOOK)).toBe(false);
    } finally {
      m.cleanup();
    }
  });
});

describe("moving a chat to another Mac", () => {
  test("the Mac it lives on offers it; the other takes it, placed; the first lets go and says where it went", async () => {
    const m = macs();
    try {
      expect(await m.book.offer(MINI, "agent-ira", "conv-1")).toBeNull();
      expect(m.onMini.has("conv-1")).toBe(true);
      expect(m.onBook.has("conv-1")).toBe(false);
      expect(m.imported.map((c) => c.info.placed)).toEqual([true]);
      expect(m.left).toEqual([["conv-1", MINI]]);
      expect(m.book.blocked("agent-ira", "conv-1")).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  test("says why it did not move: busy, out of reach, not paired; a move to this Mac is nothing to do", async () => {
    const m = macs(new Set(["conv-2"]));
    try {
      expect(await m.book.offer(MINI, "agent-ira", "conv-2")).toBe("the chat is answering or waiting for you: move it once it is done");
      expect(await m.book.offer("cccccccc-3333-4333-8333-333333333333", "agent-ira", "conv-1")).toBe("that Mac is not paired with this one");
      expect(await m.book.offer(BOOK, "agent-ira", "conv-1")).toBeNull();
      expect(m.onBook.has("conv-1") && m.onBook.has("conv-2")).toBe(true);
      const away = macs(new Set(), false);
      try {
        expect(await away.book.offer(MINI, "agent-ira", "conv-1")).toBe("Mac mini is out of reach: move the chat once it is back");
      } finally {
        away.cleanup();
      }
    } finally {
      m.cleanup();
    }
  });
});

describe("a move that never finishes (plan 096)", () => {
  test("the chat it left stays held however long, says so, and holds across a restart; keep it here frees it", async () => {
    const m = macs();
    try {
      await m.book.export(MINI, "agent-ira", "conv-1");
      m.reach.mini = false; // the mini went away before it said the chat arrived
      const said = m.book.blocked("agent-ira", "conv-1");
      expect(said).toBe(`this chat is moving to Mac mini, ${MOVE_OUT_OF_REACH} to use it on this Mac`);
      m.restartBook();
      expect(m.book.blocked("agent-ira", "conv-1")).toBe(said);
      expect(m.book.keepHere("agent-ira", "conv-1")).toBeNull();
      expect(m.book.blocked("agent-ira", "conv-1")).toBeNull();
      expect(m.book.keepHere("agent-ira", "conv-2")).toBe("this chat is not moving");
    } finally {
      m.cleanup();
    }
  });

  test("at the next contact a move the other Mac finished is let go here, and one it never got takes messages here again", async () => {
    const m = macs();
    try {
      await m.book.export(MINI, "agent-ira", "conv-1");
      m.onMini.add("conv-1"); // the import landed, but its "moved" never came back
      await m.book.export(MINI, "agent-ira", "conv-2"); // this one's import failed there
      m.restartBook();
      await m.book.settle(MINI);
      expect(m.onBook.has("conv-1")).toBe(false);
      expect(m.left).toContainEqual(["conv-1", MINI]);
      expect(m.onBook.has("conv-2")).toBe(true);
      expect(m.book.blocked("agent-ira", "conv-2")).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  test("a chat kept here: the other Mac lets go of its copy at the next contact, and only then is the hold gone", async () => {
    const m = macs();
    try {
      await m.book.export(MINI, "agent-ira", "conv-1");
      m.onMini.add("conv-1");
      m.reach.mini = false;
      m.book.keepHere("agent-ira", "conv-1");
      await m.book.settle(MINI); // out of reach: nothing yet
      expect(m.onMini.has("conv-1")).toBe(true);
      m.reach.mini = true;
      await m.book.settle(MINI);
      expect(m.onMini.has("conv-1")).toBe(false);
      expect(m.onBook.has("conv-1")).toBe(true);
      expect(m.book.blocked("agent-ira", "conv-1")).toBeNull();
      expect(JSON.parse(readFileSync(join(m.dir, "book-moves.json"), "utf8"))).toEqual({ version: 1, holds: [] });
    } finally {
      m.cleanup();
    }
  });
});
