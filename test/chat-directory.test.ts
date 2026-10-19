import { describe, expect, test } from "vitest";
import { ChatDirectory, type ChatRef } from "../mod/chat-directory.ts";
import { scopeFor } from "../core/desk-core.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const THIRD = "cccccccc-3333-4333-8333-333333333333";
const CHAT: ChatRef = { agent_id: "agent-ira", conversation_id: "conv-1" };
const SCOPE = scopeFor("conv-1", "agent-ira");

/**
 * Paired Macs joined in memory: each one's store (the scopes it holds), its directory, and what it was told. `down`
 * names Macs out of reach. `restart` gives a Mac a fresh directory over the same store, as after a reboot.
 */
function macs(ids: string[]) {
  const stores = new Map(ids.map((id) => [id, new Set<string>()]));
  const down = new Set<string>();
  const told: Array<{ from: string; frame: Record<string, unknown> }> = [];
  const dirs = new Map<string, ChatDirectory>();
  const make = (id: string): ChatDirectory =>
    new ChatDirectory({
      here: id,
      holds: (scope) => stores.get(id)?.has(scope) ?? false,
      macs: () => ids.filter((m) => m !== id),
      reachable: (m) => !down.has(m),
      ask: (m, chat) => {
        const other = dirs.get(m);
        return other && !down.has(m) ? Promise.resolve(other.answer(chat)) : Promise.reject(new Error("out of reach"));
      },
      tell: (frame) => {
        told.push({ from: id, frame });
        for (const [m, d] of dirs)
          if (m !== id && !down.has(m)) d.heard(id, { kind: "left", scope: scopeFor(frame.conversation_id, frame.agent_id), to: frame.to });
      },
    });
  for (const id of ids) dirs.set(id, make(id));
  const dir = (id: string): ChatDirectory => {
    const d = dirs.get(id);
    if (!d) throw new Error(id);
    return d;
  };
  /** A chat moves from one store to another, and the Mac it left tells the others. */
  const move = (from: string, to: string) => {
    stores.get(from)?.delete(SCOPE);
    stores.get(to)?.add(SCOPE);
    dir(from).left(CHAT, to);
  };
  return { stores, down, told, dir, move, restart: (id: string) => dirs.set(id, make(id)) };
}

describe("the chat directory (plan 023, addendum B)", () => {
  test("its own chats come from the store; a paired Mac's list says where its chats are", () => {
    const m = macs([BOOK, MINI]);
    m.stores.get(BOOK)?.add(SCOPE);
    expect(m.dir(BOOK).peek(CHAT)).toEqual({ at: "here" });
    m.dir(MINI).heard(BOOK, { kind: "holds", scopes: [SCOPE] });
    expect(m.dir(MINI).peek(CHAT)).toEqual({ at: "mac", mac: BOOK, reachable: true });
    // A newer list replaces the old one: a chat no longer listed is no longer claimed.
    m.dir(MINI).heard(BOOK, { kind: "holds", scopes: [] });
    expect(m.dir(MINI).peek(CHAT)).toBeNull();
  });

  test("a move tells the paired Macs, so the new home is known at once, here and on a third Mac", () => {
    const m = macs([BOOK, MINI, THIRD]);
    m.stores.get(BOOK)?.add(SCOPE);
    m.dir(THIRD).heard(BOOK, { kind: "holds", scopes: [SCOPE] });
    m.move(BOOK, MINI);
    expect(m.dir(MINI).peek(CHAT)).toEqual({ at: "here" });
    expect(m.dir(THIRD).peek(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: true });
    expect(m.dir(BOOK).peek(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: true });
  });

  test("a Mac that missed the move is redirected once by the Mac the chat left", () => {
    const m = macs([BOOK, MINI, THIRD]);
    m.stores.get(BOOK)?.add(SCOPE);
    m.dir(THIRD).heard(BOOK, { kind: "holds", scopes: [SCOPE] });
    m.down.add(THIRD); // asleep while the chat moves
    m.move(BOOK, MINI);
    m.down.delete(THIRD);
    expect(m.dir(THIRD).peek(CHAT)).toEqual({ at: "mac", mac: BOOK, reachable: true });
    // Its frame reaches the MacBook, which answers with where the chat went.
    const redirect = m.dir(BOOK).answer(CHAT);
    expect(redirect).toEqual({ held: false, moved_to: MINI });
    m.dir(THIRD).heard(BOOK, { kind: "answer", scope: SCOPE, ...redirect });
    expect(m.dir(THIRD).peek(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: true });
  });

  test("a chat no Mac claimed is asked for, and the answer is kept; one no Mac holds is nowhere", async () => {
    const m = macs([BOOK, MINI]);
    m.stores.get(MINI)?.add(SCOPE); // made on the mini a moment ago, before its list reached the MacBook
    expect(m.dir(BOOK).peek(CHAT)).toBeNull();
    expect(await m.dir(BOOK).locate(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: true });
    expect(m.dir(BOOK).peek(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: true });
    expect(await m.dir(BOOK).locate({ agent_id: "agent-ira", conversation_id: "conv-9" })).toEqual({ at: "nowhere" });
  });

  test("a restarted Mac with no notes still finds a moved chat by asking", async () => {
    const m = macs([BOOK, MINI, THIRD]);
    m.stores.get(BOOK)?.add(SCOPE);
    m.dir(THIRD).heard(BOOK, { kind: "holds", scopes: [SCOPE] });
    m.down.add(THIRD);
    m.move(BOOK, MINI);
    m.restart(BOOK); // the MacBook's forwarding note is gone
    m.down.delete(THIRD);
    // The MacBook now answers "not here, no note": the third Mac drops its claim and asks around.
    m.dir(THIRD).heard(BOOK, { kind: "answer", scope: SCOPE, ...m.dir(BOOK).answer(CHAT) });
    expect(m.dir(THIRD).peek(CHAT)).toBeNull();
    expect(await m.dir(THIRD).locate(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: true });
  });

  test("a chat that comes back here is this Mac's own again, from its store; an out-of-reach home says so", () => {
    const m = macs([BOOK, MINI]);
    m.stores.get(BOOK)?.add(SCOPE);
    m.move(BOOK, MINI);
    m.down.add(MINI);
    expect(m.dir(BOOK).peek(CHAT)).toEqual({ at: "mac", mac: MINI, reachable: false });
    m.down.delete(MINI);
    m.move(MINI, BOOK);
    expect(m.dir(BOOK).peek(CHAT)).toEqual({ at: "here" });
    expect(m.dir(MINI).peek(CHAT)).toEqual({ at: "mac", mac: BOOK, reachable: true });
  });

  test("an unpaired Mac's word goes, and so do notes pointing at it", () => {
    const m = macs([BOOK, MINI]);
    m.stores.get(BOOK)?.add(SCOPE);
    m.move(BOOK, MINI);
    m.dir(BOOK).forget(MINI);
    expect(m.dir(BOOK).peek(CHAT)).toBeNull();
    expect(m.dir(BOOK).answer(CHAT)).toEqual({ held: false, moved_to: null });
  });
});
