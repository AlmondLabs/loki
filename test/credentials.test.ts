import { describe, expect, test } from "vitest";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";

describe("provider credentials", () => {
  test("a saved key reads back, is listed without its secret, and deleting it removes it and its listing", async () => {
    const secrets = memorySecrets();
    const store = new KeychainCredentials(secrets);
    await store.modify("openrouter", async () => ({ type: "api_key", key: "sk-or-123" }));
    expect(await store.read("openrouter")).toEqual({ type: "api_key", key: "sk-or-123" });
    expect(await store.list()).toEqual([{ providerId: "openrouter", type: "api_key" }]);
    await store.delete("openrouter");
    expect(await store.read("openrouter")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect([...secrets.entries.keys()]).toEqual(["providers"]);
  });

  test("two refreshes at once each see the other's result: neither write is lost", async () => {
    const store = new KeychainCredentials(memorySecrets());
    await store.modify("openai-codex", async () => ({ type: "oauth", access: "a0", refresh: "r0", expires: 0 }));
    const bump = (tag: string) =>
      store.modify("openai-codex", async (current) => {
        await new Promise((r) => setTimeout(r, 5));
        return { ...(current as { type: "oauth"; access: string; refresh: string; expires: number }), access: `${(current as { access: string }).access}+${tag}` };
      });
    await Promise.all([bump("a"), bump("b")]);
    expect((await store.read("openai-codex")) as { access: string }).toMatchObject({ access: "a0+a+b" });
  });

  test("a change that returns nothing leaves the credential as it was", async () => {
    const store = new KeychainCredentials(memorySecrets());
    await store.modify("x", async () => ({ type: "api_key", key: "k" }));
    expect(await store.modify("x", async () => undefined)).toEqual({ type: "api_key", key: "k" });
  });

  test("a damaged entry reads as none", async () => {
    const secrets = memorySecrets();
    secrets.entries.set("provider:x", "{not json");
    expect(await new KeychainCredentials(secrets).read("x")).toBeUndefined();
  });
});

describe("the keychain's index", () => {
  test("providers saved at the same moment are all listed", async () => {
    const secrets = memorySecrets();
    // A slow keychain, so every save's read of the index overlaps the others'.
    const slow = { ...secrets, get: async (a: string) => (await new Promise((r) => setTimeout(r, 5)), secrets.get(a)), set: async (a: string, v: string) => (await new Promise((r) => setTimeout(r, 5)), secrets.set(a, v)) };
    const store = new KeychainCredentials(slow);
    await Promise.all(["a", "b", "c", "d"].map((p) => store.modify(p, async () => ({ type: "api_key", key: p }))));
    expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["a", "b", "c", "d"]);
    await Promise.all(["a", "c"].map((p) => store.delete(p)));
    expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["b", "d"]);
  });
});
