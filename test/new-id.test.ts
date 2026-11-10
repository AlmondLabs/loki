import { afterEach, describe, expect, test, vi } from "vitest";
import { newId } from "../app/src/shared/new-id.ts";
import { FRAMES } from "../core/frames.ts";

afterEach(() => void vi.unstubAllGlobals());

describe("an id a tab makes", () => {
  test("is made on a page with no randomUUID, as a phone on plain http is, and is one the mod takes for a held reply", () => {
    vi.stubGlobal("crypto", { getRandomValues: <T extends Uint8Array>(a: T) => realCrypto.getRandomValues(a) });
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newId()).not.toBe(id);
    const parsed = FRAMES.account_thread_reply.parse({ account_id: "gmail:a@b.example", thread_id: "t1", text: "ok", then: "read", outbox_id: id });
    expect(parsed).toMatchObject({ outbox_id: id });
  });
});

const realCrypto = globalThis.crypto;
