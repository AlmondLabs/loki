import { describe, expect, test } from "vitest";
import { chosenFolder, folderName, foldersOf, shownFolders } from "../app/src/phone/newChatFolders.ts";

describe("the phone's New chat folder", () => {
  const recent = { a: ["/Users/u/work/loki", "/Users/u/work/site", "/Users/u/notes"], b: [] };

  test("an agent's folders, most recent first; none before the Mac answers or for an agent with none", () => {
    expect(foldersOf(recent, "a")).toEqual(recent.a);
    expect(foldersOf(recent, "b")).toEqual([]);
    expect(foldersOf(null, "a")).toEqual([]);
    expect(foldersOf(recent, null)).toEqual([]);
  });

  test("the most recent to begin with; a pick holds while the agent has worked there", () => {
    expect(chosenFolder(recent.a, null)).toBe("/Users/u/work/loki");
    expect(chosenFolder(recent.a, "/Users/u/notes")).toBe("/Users/u/notes");
    expect(chosenFolder(recent.a, "/Users/u/elsewhere")).toBe("/Users/u/work/loki"); // another agent's pick
    expect(chosenFolder([], "/Users/u/notes")).toBeNull();
  });

  test("six chips, the lit one kept in view, all after More", () => {
    const many = Array.from({ length: 9 }, (_, i) => `/f/${i}`);
    expect(shownFolders(many, "/f/0", false)).toEqual(many.slice(0, 6));
    expect(shownFolders(many, "/f/8", false)).toEqual([...many.slice(0, 6), "/f/8"]);
    expect(shownFolders(many, "/f/8", true)).toEqual(many);
  });

  test("a chip is named by the folder's last part", () => {
    expect(folderName("/Users/u/work/loki")).toBe("loki");
    expect(folderName("/Users/u/work/loki/")).toBe("loki");
    expect(folderName("/")).toBe("/");
  });
});
