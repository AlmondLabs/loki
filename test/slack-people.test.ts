import { describe, expect, test } from "vitest";
import type { SlackPerson } from "../core/frame-types.ts";
import type { SlackUser } from "../mod/slack.ts";
import { SlackPeople, searchPeople, withMentions } from "../mod/slack-people.ts";

const HANDLES = new Map([
  ["ravi.kumar", "U1"],
  ["ana", "U2"],
]);

describe("an @handle becomes Slack's mention (plan 082)", () => {
  test("a known handle at the start, after a space or a bracket, and before punctuation", () => {
    expect(withMentions("@ravi.kumar look (@ana) thanks @ravi.kumar.", HANDLES)).toBe("<@U1> look (<@U2>) thanks <@U1>.");
  });

  test("an unknown handle, an email address and a handle glued to a word stay as typed; case does not matter", () => {
    expect(withMentions("@nobody mail ravi@example.test x@ana @ANA", HANDLES)).toBe("@nobody mail ravi@example.test x@ana <@U2>");
  });
});

const PEOPLE: SlackPerson[] = [
  { id: "U1", handle: "ravi.kumar", name: "Ravi Kumar", avatar: null },
  { id: "U2", handle: "ana", name: "Ana Rao", avatar: null },
  { id: "U3", handle: "kumaresh", name: "Kumaresh S", avatar: null },
  { id: "U4", handle: "bravi", name: "B Ravindra", avatar: null },
];

describe("finding people to mention", () => {
  test("an exact handle first, then a start, then a word's start, then anywhere; nothing for an empty query", () => {
    expect(searchPeople(PEOPLE, "ana").map((p) => p.id)).toEqual(["U2"]);
    expect(searchPeople(PEOPLE, "kum").map((p) => p.id)).toEqual(["U3", "U1"]);
    expect(searchPeople(PEOPLE, "ravi").map((p) => p.id)).toEqual(["U1", "U4"]);
    expect(searchPeople(PEOPLE, " ")).toEqual([]);
  });
});

const user = (id: string, name: string, extra: Partial<SlackUser> = {}): SlackUser => ({
  id,
  name,
  real_name: name,
  display_name: "",
  is_bot: false,
  ...extra,
});

describe("a workspace's people", () => {
  /** People over two pages, a bot among them; the clock and each read are the test's. */
  const fixture = () => {
    const clock = { t: 0 };
    const reads: Array<string | null> = [];
    let fail = false;
    const people = new SlackPeople({
      now: () => clock.t,
      client: () => ({
        usersList: (cursor) => {
          reads.push(cursor);
          if (fail) return Promise.reject(new Error("ratelimited"));
          return Promise.resolve(
            cursor
              ? { users: [user("U2", "ana", { display_name: "Ana" })], next_cursor: null }
              : { users: [user("U1", "ravi.kumar"), user("B1", "deploybot", { is_bot: true })], next_cursor: "next" },
          );
        },
      }),
    });
    return { people, clock, reads, failNext: (on: boolean) => (fail = on) };
  };

  test("every page is read once, bots left out, and read again after an hour", async () => {
    const { people, clock, reads } = fixture();
    expect((await people.search("slack:T1:U0", "an")).map((p) => [p.handle, p.name])).toEqual([["ana", "Ana"]]);
    await people.search("slack:T1:U0", "ravi");
    expect(reads).toEqual([null, "next"]);
    clock.t = 61 * 60_000;
    await people.search("slack:T1:U0", "ravi");
    expect(reads).toEqual([null, "next", null, "next"]);
  });

  test("a reply with no @handle reads no one; one with a handle gets every handle's id", async () => {
    const { people, reads } = fixture();
    expect(await people.mentions("slack:T1:U0", "no one here")).toEqual(new Map());
    expect(reads).toEqual([]);
    expect(await people.mentions("slack:T1:U0", "@ana hi")).toEqual(
      new Map([
        ["ravi.kumar", "U1"],
        ["ana", "U2"],
      ]),
    );
  });

  test("a read that fails is tried again on the next ask", async () => {
    const { people, reads, failNext } = fixture();
    failNext(true);
    await expect(people.search("slack:T1:U0", "ana")).rejects.toThrow("ratelimited");
    failNext(false);
    expect(await people.search("slack:T1:U0", "ana")).toHaveLength(1);
    expect(reads).toEqual([null, null, "next"]);
  });
});
