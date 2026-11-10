import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_NAME } from "../daemon/chat-images.ts";
import { SlackPreviews } from "../mod/slack-previews.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-slack-previews-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNT = "slack:T0ACME:U0ME";
const THUMB = { url: "https://files.slack.com/files-tmb/T0ACME-F1-abc/photo_360.png", width: 360, height: 200 };

/** A preview store over the test's folder, its fetch counted and answered by `answer`. */
function store(answer: () => Promise<{ data: Buffer } | null> = () => Promise.resolve({ data: Buffer.from("png bytes") })) {
  const asked: string[] = [];
  const previews = new SlackPreviews({
    dir,
    fetchThumb: (accountId, url) => {
      asked.push(`${accountId} ${url}`);
      return answer();
    },
  });
  return { previews, asked };
}

describe("the thumbnails of pictures shared in Slack (plan 080)", () => {
  test("a thumbnail is fetched once and saved under a name the picture folder serves, with its size", async () => {
    const { previews, asked } = store();
    const first = await previews.preview(ACCOUNT, THUMB);
    expect(first).toMatchObject({ width: 360, height: 200 });
    expect(first?.name).toMatch(IMAGE_NAME);
    expect(first?.name.endsWith(".png")).toBe(true);
    expect(readFileSync(join(dir, first?.name ?? ""), "utf8")).toBe("png bytes");
    expect(await previews.preview(ACCOUNT, THUMB)).toEqual(first);
    expect(asked).toEqual([`${ACCOUNT} ${THUMB.url}`]);
  });

  test("a thumbnail saved before loki started is not fetched again, and two reads at once ask once", async () => {
    const name = (await store().previews.preview(ACCOUNT, THUMB))?.name ?? "";
    const later = store();
    expect((await later.previews.preview(ACCOUNT, THUMB))?.name).toBe(name);
    expect(later.asked).toEqual([]);
    rmSync(join(dir, name));
    const both = store();
    await Promise.all([both.previews.preview(ACCOUNT, THUMB), both.previews.preview(ACCOUNT, THUMB)]);
    expect(both.asked).toHaveLength(1);
  });

  test("one that cannot be had, or whose address names no picture type, is no preview and leaves nothing behind", async () => {
    expect(await store(() => Promise.resolve(null)).previews.preview(ACCOUNT, THUMB)).toBeNull();
    expect(await store(() => Promise.reject(new Error("offline"))).previews.preview(ACCOUNT, THUMB)).toBeNull();
    const odd = store();
    expect(await odd.previews.preview(ACCOUNT, { ...THUMB, url: "https://files.slack.com/files-tmb/x/download" })).toBeNull();
    expect(odd.asked).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the same picture in two workspaces is two files", async () => {
    const { previews } = store();
    const a = await previews.preview(ACCOUNT, THUMB);
    const b = await previews.preview("slack:T0OTHER:U0ME", THUMB);
    expect(a?.name).not.toBe(b?.name);
    expect(existsSync(join(dir, b?.name ?? ""))).toBe(true);
  });
});
