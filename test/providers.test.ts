import { describe, expect, test } from "bun:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { Providers } from "../daemon/providers.ts";

function setup() {
  const secrets = memorySecrets();
  const credentials = new KeychainCredentials(secrets);
  // No environment: a provider is connected only by what is kept here.
  const models = builtinModels({ credentials });
  return { secrets, providers: new Providers(models, credentials) };
}

describe("providers on the daemon", () => {
  test("Anthropic offers a key and no subscription sign-in; ChatGPT offers its sign-in", async () => {
    const { providers } = setup();
    const list = await providers.list();
    const anthropic = list.find((p) => p.id === "anthropic")!;
    expect(anthropic.auth_methods?.map((m) => m.id)).toEqual(["api_key"]);
    expect(anthropic.auth_methods?.[0].fields).toEqual([{ key: "api_key", label: expect.any(String), secret: true, required: true }]);
    expect(list.find((p) => p.id === "openai-codex")?.auth_methods?.map((m) => m.id)).toEqual(["oauth"]);
    await expect(providers.signIn("anthropic")).rejects.toThrow("does not sign in to anthropic");
  });

  test("a kept key connects its provider, in the keychain, and disconnecting forgets it", async () => {
    const { providers, secrets } = setup();
    const before = (await providers.list()).find((p) => p.id === "anthropic")!;
    if (before.connected.is_connected) return; // an ANTHROPIC_API_KEY in this environment connects it already
    await providers.connectKey("anthropic", "  sk-ant-test  ");
    expect(JSON.parse(secrets.entries.get("provider:anthropic")!)).toEqual({ type: "api_key", key: "sk-ant-test" });
    expect((await providers.list()).find((p) => p.id === "anthropic")?.connected).toMatchObject({ is_connected: true, auth_type: "api_key" });
    await providers.disconnect("anthropic");
    expect(secrets.entries.has("provider:anthropic")).toBe(false);
  });

  test("an empty key, or one for a provider that takes none, is refused", async () => {
    const { providers } = setup();
    await expect(providers.connectKey("anthropic", "   ")).rejects.toThrow("empty");
    await expect(providers.connectKey("no-such-provider", "k")).rejects.toThrow("does not take an API key");
  });
});
