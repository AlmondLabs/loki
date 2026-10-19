import { describe, expect, test } from "vitest";
import { PeerGroup } from "../mod/peer-group.ts";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";

/**
 * Three Macs in memory: who is paired with whom, who forgot whom, and each one's PeerGroup; a link is a call into the
 * other Mac's frame answers, and joining pairs the two Macs at once (as POST /peer/pair would).
 */
function macs(pairs: Array<[string, string]>) {
  const paired = new Map<string, Set<string>>([A, B, C].map((m) => [m, new Set<string>()]));
  const pair = (x: string, y: string) => (paired.get(x)?.add(y), paired.get(y)?.add(x));
  for (const [x, y] of pairs) pair(x, y);
  const forgotten = new Map<string, Set<string>>([A, B, C].map((m) => [m, new Set<string>()]));
  const invites = new Map<string, { at: string; for: string }>();
  const groups = new Map<string, PeerGroup>();
  const joins: Array<[string, string]> = [];
  const isPaired = (x: string, y: string) => paired.get(x)?.has(y) ?? false;
  /** What Mac `to` answers when Mac `from` asks it over their link. */
  const answer = async (to: string, from: string, f: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (f.type === "peer_group_get") return { macs: [...(paired.get(to) ?? [])].map((m) => ({ mac_id: m, name: m.slice(0, 4), host: `${m}.ts.net` })) };
    if (f.type === "peer_introduce") return groups.get(to)?.introduce(from, String(f.mac_id)) ?? {};
    if (f.type === "peer_invite_get") {
      if (forgotten.get(to)?.has(String(f.for))) throw new Error("this Mac does not pair with that one");
      const code = `invite-${invites.size}`;
      invites.set(code, { at: to, for: String(f.for) });
      return { host: `${to}.ts.net`, code };
    }
    throw new Error(`unexpected ${String(f.type)}`);
  };
  for (const me of [A, B, C])
    groups.set(
      me,
      new PeerGroup({
        here: me,
        paired: (m) => isPaired(me, m),
        forgotten: (m) => forgotten.get(me)?.has(m) ?? false,
        link: (m) => (isPaired(me, m) ? ({ request: (f: Record<string, unknown>) => answer(m, me, f) } as never) : null),
        join: (host, code) => {
          const inv = invites.get(code);
          invites.delete(code);
          if (inv?.for !== me || `${inv.at}.ts.net` !== host) return Promise.reject(new Error("unknown or expired code"));
          pair(me, inv.at);
          joins.push([me, inv.at]);
          return Promise.resolve();
        },
      }),
    );
  const group = (m: string) => {
    const g = groups.get(m);
    if (!g) throw new Error(m);
    return g;
  };
  return { group, isPaired, forgotten, joins };
}

describe("every Mac paired with every other (plan 023, addendum D)", () => {
  test("a Mac paired with B joins the Mac B is paired with, by an introduction, with no code", async () => {
    const m = macs([
      [B, C],
      [A, B],
    ]);
    // A has the lower id, so it is the one to join C.
    expect(await m.group(A).meshWith(B)).toEqual([C]);
    expect(m.isPaired(A, C)).toBe(true);
    expect(m.joins).toEqual([[A, C]]);
  });

  test("of two Macs that learn of each other, only the lower id joins, so two pairings never cross", async () => {
    const m = macs([
      [B, C],
      [A, B],
    ]);
    expect(await m.group(C).meshWith(B)).toEqual([]);
    expect(m.isPaired(A, C)).toBe(false);
    await m.group(A).meshWith(B);
    expect(m.joins).toEqual([[A, C]]);
    // Asking again changes nothing.
    expect(await m.group(A).meshWith(B)).toEqual([]);
  });

  test("a Mac forgotten on purpose is not joined, and does not invite back the Mac that forgot it", async () => {
    const m = macs([
      [B, C],
      [A, B],
    ]);
    m.forgotten.get(A)?.add(C);
    expect(await m.group(A).meshWith(B)).toEqual([]);
    m.forgotten.get(A)?.clear();
    m.forgotten.get(C)?.add(A);
    expect(await m.group(A).meshWith(B)).toEqual([]);
    expect(m.isPaired(A, C)).toBe(false);
  });

  test("a Mac introduces only between Macs it is paired with", async () => {
    const m = macs([[A, B]]);
    await expect(m.group(B).introduce(A, C)).rejects.toThrow(/not a Mac this one can introduce/);
    await expect(m.group(B).introduce(C, A)).rejects.toThrow(/not a Mac this one can introduce/);
  });
});
