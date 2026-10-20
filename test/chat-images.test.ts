import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHRINK_ABOVE_BYTES, shrinkImage, type Run } from "../daemon/image-shrink.ts";
import { ChatImages } from "../daemon/chat-images.ts";
import { chatImageRoute } from "../mod/chat-images.ts";
import { messageSteps } from "../core/attention/pi-steps.ts";
import { ThreadModel } from "../core/attention/thread.ts";
import { must } from "./fixtures/must.ts";

/** Plan 029: tool-result images shrunk before they are kept, and the person's pictures on every window. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-chat-images-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const big = () => {
  const file = join(dir, "shot.png");
  writeFileSync(file, Buffer.alloc(SHRINK_ABOVE_BYTES + 1, 7));
  return file;
};

describe("view_image's shrink", () => {
  test("a large image is resized by sips and comes back as JPEG; its size is asked first, so a small one is not enlarged", async () => {
    const calls: string[][] = [];
    const run: Run = (_file, args) => {
      calls.push(args);
      if (args[0] === "-g") return Promise.resolve("  pixelWidth: 3200\n  pixelHeight: 1800\n");
      writeFileSync(args[args.length - 1], Buffer.from("small jpeg"));
      return Promise.resolve("");
    };
    const out = await shrinkImage(big(), "image/png", { run, platform: "darwin" });
    expect(out).toEqual({ data: Buffer.from("small jpeg"), mimeType: "image/jpeg" });
    expect(calls[1].slice(0, 2)).toEqual(["-Z", "1600"]);
    const narrow: Run = (_f, args) =>
      args[0] === "-g" ? Promise.resolve("pixelWidth: 900\npixelHeight: 600") : (writeFileSync(args[args.length - 1], "j"), Promise.resolve(""));
    const calls2: string[][] = [];
    await shrinkImage(big(), "image/png", { run: (f, a) => (calls2.push(a), narrow(f, a)), platform: "darwin" });
    expect(calls2[1]).not.toContain("-Z");
  });

  test("a small file, a GIF, a failed resize and another system send the file as it is", async () => {
    const never: Run = () => Promise.reject(new Error("no sips"));
    const small = join(dir, "small.png");
    writeFileSync(small, "tiny");
    expect((await shrinkImage(small, "image/png", { run: never, platform: "darwin" })).mimeType).toBe("image/png");
    expect((await shrinkImage(big(), "image/gif", { run: never, platform: "darwin" })).mimeType).toBe("image/gif");
    expect((await shrinkImage(big(), "image/png", { run: never, platform: "darwin" })).mimeType).toBe("image/png");
    expect((await shrinkImage(big(), "image/png", { run: never, platform: "linux" })).data.length).toBe(SHRINK_ABOVE_BYTES + 1);
  });
});

describe("the person's pictures, named and kept", () => {
  const png = { data: Buffer.from("a picture").toString("base64"), mimeType: "image/png" };

  test("a picture is written once under its content's name; an unknown type gets none", () => {
    const images = new ChatImages(dir);
    const name = must(images.name(png), "a name");
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(new ChatImages(dir).name(png)).toBe(name);
    expect(readFileSync(join(dir, name), "utf8")).toBe("a picture");
    expect(readdirSync(dir)).toEqual([name]);
    expect(images.name({ data: png.data, mimeType: "image/tiff" })).toBeNull();
  });

  test("a user message's pictures reach its row in the thread, and their [image] lines go", () => {
    const images = new ChatImages(dir);
    const steps = messageSteps(
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", ...png },
        ],
      },
      "2026-10-20T10:00:00Z",
      (i) => images.name(i),
    );
    const step = must(steps[0], "the step");
    expect(step).toMatchObject({ kind: "user", raw: "look\n[image]" });
    const thread = new ThreadModel();
    thread.apply(step);
    expect(thread.rows()?.map((r) => [r.text, r.images])).toEqual([["look", [images.name(png)]]]);
    // Without a namer the pictures stay the lines that stand for them.
    expect(messageSteps({ role: "user", content: [{ type: "image", ...png }] }, null)[0]).not.toHaveProperty("images");
  });
});

describe("the route", () => {
  let server: Server;
  let base = "";
  const remote = new Map<string, Buffer>();
  beforeEach(async () => {
    remote.clear();
    const route = chatImageRoute({
      prefix: "/chat-images/",
      dir,
      authorize: (_req, url) => ({ ok: url.searchParams.get("t") === "ok" }),
      denied: 403,
      fetchRemote: (name) => Promise.resolve(remote.get(name) ?? null),
    });
    server = createServer((req, res) => {
      if (!route(req, res, new URL(req.url ?? "/", "http://x"))) res.writeHead(418).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const NAME = "0123456789abcdef0123456789abcdef.png";

  test("serves a picture held here, fetches and keeps one from a paired Mac, and refuses the rest", async () => {
    writeFileSync(join(dir, NAME), "here");
    const here = await fetch(`${base}/chat-images/${NAME}?t=ok`);
    expect([here.status, here.headers.get("content-type"), await here.text()]).toEqual([200, "image/png", "here"]);
    const other = "fedcba9876543210fedcba9876543210.jpg";
    remote.set(other, Buffer.from("from the mini"));
    expect(await (await fetch(`${base}/chat-images/${other}?t=ok`)).text()).toBe("from the mini");
    expect(existsSync(join(dir, other))).toBe(true);
    expect((await fetch(`${base}/chat-images/${NAME}`)).status).toBe(403);
    expect((await fetch(`${base}/chat-images/..%2Fsecret.png?t=ok`)).status).toBe(404);
    expect((await fetch(`${base}/chat-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png?t=ok`)).status).toBe(404);
  });
});
