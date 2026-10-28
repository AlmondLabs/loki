// The rename dialog and sheet (plan 047, U5): beside the name, a one-line purpose agents read to know what a chat is for.
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RenameDesk, cleanPurpose, saveRename } from "../app/src/desk/rename-desk.tsx";
import { RenameSheet } from "../app/src/phone/rename-sheet.tsx";

/** The calls a save made, with the answers each gives. */
function calls(answers: { rename?: string | null; purpose?: string | null } = {}) {
  const made: string[] = [];
  return {
    made,
    onRename: (name: string) => (made.push(`rename ${name}`), Promise.resolve(answers.rename ?? null)),
    onPurpose: (purpose: string) => (made.push(`purpose ${purpose}`), Promise.resolve(answers.purpose ?? null)),
  };
}

describe("saving a rename with a purpose", () => {
  test("only what changed is saved: the name, the purpose, or both in that order", async () => {
    const a = calls();
    expect(await saveRename({ name: null, purpose: "the website" }, a.onRename, a.onPurpose)).toBeNull();
    expect(a.made).toEqual(["purpose the website"]);
    const b = calls();
    expect(await saveRename({ name: "site", purpose: "the website" }, b.onRename, b.onPurpose)).toBeNull();
    expect(b.made).toEqual(["rename site", "purpose the website"]);
    const c = calls();
    expect(await saveRename({ name: "site", purpose: null }, c.onRename, c.onPurpose)).toBeNull();
    expect(c.made).toEqual(["rename site"]);
  });

  test("an empty purpose is saved, which clears it", async () => {
    const a = calls();
    await saveRename({ name: null, purpose: cleanPurpose("   ") }, a.onRename, a.onPurpose);
    expect(a.made).toEqual(["purpose "]);
  });

  test("a refused rename stops there and says why; a throw reads as its message", async () => {
    const a = calls({ rename: "a main chat cannot be renamed" });
    expect(await saveRename({ name: "x", purpose: "y" }, a.onRename, a.onPurpose)).toBe("a main chat cannot be renamed");
    expect(a.made).toEqual(["rename x"]);
    const thrown = await saveRename({ name: null, purpose: "y" }, a.onRename, () => Promise.reject(new Error("not connected")));
    expect(thrown).toBe("not connected");
  });

  test("a purpose is one line", () => {
    expect(cleanPurpose("  the website:\n deploys  and copy ")).toBe("the website: deploys and copy");
  });
});

describe("the purpose field", () => {
  const noop = () => Promise.resolve(null);
  test("the desktop dialog has it, holding the purpose now, when it can save one", () => {
    const html = renderToStaticMarkup(createElement(RenameDesk, { name: "site", purpose: "the website", onClose: () => {}, onRename: noop, onPurpose: noop }));
    expect(html).toContain('aria-label="Chat purpose"');
    expect(html).toContain('value="the website"');
    expect(renderToStaticMarkup(createElement(RenameDesk, { name: "site", onClose: () => {}, onRename: noop }))).not.toContain("Chat purpose");
  });

  test("the phone's sheet has it too, in sentence case", () => {
    const html = renderToStaticMarkup(createElement(RenameSheet, { name: "site", purpose: null, onClose: () => {}, onRename: noop, onPurpose: noop }));
    expect(html).toContain('aria-label="Chat purpose"');
    expect(html).toContain('placeholder="What this chat is for"');
  });
});
