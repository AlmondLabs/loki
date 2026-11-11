import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_NAME } from "../daemon/chat-images.ts";
import { OutsidePreviews, slackPreviews } from "../mod/outside-previews.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-outside-previews-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNT = "slack:T0ACME:U0ME";
const THUMB = { url: "https://files.slack.com/files-tmb/T0ACME-F1-abc/photo_360.png", width: 360, height: 200 };

/** A preview store over the test's folder, its fetch counted and answered by `answer`. */
function store(answer: () => Promise<{ data: Buffer; type: string } | null> = () => Promise.resolve({ data: Buffer.from("png bytes"), type: "image/png" })) {
  const asked: string[] = [];
  const preview = slackPreviews(new OutsidePreviews({ dir }), (accountId, url) => {
    asked.push(`${accountId} ${url}`);
    return answer();
  });
  return { previews: { preview }, asked };
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

  test("a thumbnail keeps the name it was given before the store served Jira too, so one saved then is found", async () => {
    // The name the plan 080 store gave, worked out by hand here so a change to the key or the extension shows.
    const old = `${createHash("sha256").update(`slack:${ACCOUNT}:${THUMB.url}`).digest("hex").slice(0, 32)}.png`;
    expect((await store().previews.preview(ACCOUNT, THUMB))?.name).toBe(old);
    const later = store();
    expect((await later.previews.preview(ACCOUNT, THUMB))?.name).toBe(old);
    expect(later.asked).toEqual([]);
  });
});

describe("the thumbnails of pictures in Jira comments (plan 092)", () => {
  const KEY = "jira:jira:acme:u1:10001";

  /** The store over the test's folder, with a fetch that counts its calls and gives `answer`. */
  function jira(answer: { data: Buffer; type: string } | null = { data: Buffer.from("jpeg bytes"), type: "image/jpeg" }) {
    const previews = new OutsidePreviews({ dir });
    let asked = 0;
    const fetch = () => {
      asked += 1;
      return Promise.resolve(answer);
    };
    return { previews, fetch, asked: () => asked };
  }

  test("a thumbnail answered as JPEG is saved under a jpg name the picture folder serves", async () => {
    const { previews, fetch } = jira();
    const name = await previews.preview(KEY, fetch);
    expect(name).toMatch(IMAGE_NAME);
    expect(name?.endsWith(".jpg")).toBe(true);
    expect(readFileSync(join(dir, name ?? ""), "utf8")).toBe("jpeg bytes");
  });

  test("an answer whose picture type the folder does not serve is no preview", async () => {
    const { previews, fetch } = jira({ data: Buffer.from("tiff bytes"), type: "image/tiff" });
    expect(await previews.preview(KEY, fetch)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("two reads of one picture fetch once, and one saved before loki started is found without a fetch", async () => {
    const one = jira();
    const [a, b] = await Promise.all([one.previews.preview(KEY, one.fetch), one.previews.preview(KEY, one.fetch)]);
    expect(a).toBe(b);
    expect(one.asked()).toBe(1);
    const later = jira();
    expect(await later.previews.preview(KEY, later.fetch)).toBe(a);
    expect(later.asked()).toBe(0);
  });

  test("the same attachment id on two accounts is two files", async () => {
    const { previews, fetch } = jira();
    const a = await previews.preview(KEY, fetch);
    const b = await previews.preview("jira:jira:other:u1:10001", fetch);
    expect(a).not.toBe(b);
    expect(readdirSync(dir).sort()).toEqual([a, b].sort());
  });
});
