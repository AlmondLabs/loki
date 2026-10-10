import { describe, expect, test } from "bun:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { deviceIdIn, Providers } from "../daemon/providers.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import type { LoginOptions, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("signing in through the browser", () => {
  /** A provider whose sign-in goes as ChatGPT's do: a choice of method, the page, then the browser or a pasted address. */
  function signInSetup() {
    const secrets = memorySecrets();
    const credentials = new KeychainCredentials(secrets);
    const models = createModels({ credentials });
    const seen: { choice?: string; device?: string; agent?: string } = {};
    let callback: ((code: string) => void) | null = null;
    const base = fauxProvider().provider;
    models.setProvider({
      ...base,
      id: "fake-chatgpt",
      auth: {
        oauth: {
          name: "Fake (ChatGPT subscription)",
          loginLabel: "Sign in with ChatGPT",
          login: async (interaction: ProviderAuthInteraction, options?: LoginOptions) => {
            seen.choice = await interaction.prompt({ type: "select", message: "how?", options: [{ id: "browser", label: "Browser" }, { id: "device", label: "Device code" }] });
            seen.device = options?.getDeviceId?.();
            seen.agent = options?.agentName;
            interaction.notify({ type: "auth_url", url: "https://auth.example/authorize", instructions: "finish in the browser" });
            const browser = new Promise<string>((resolve) => (callback = resolve));
            const manual = new AbortController();
            const pasted = interaction.prompt({ type: "manual_code", message: "or paste", signal: manual.signal });
            const code = await Promise.race([browser, pasted]);
            manual.abort();
            pasted.catch(() => {});
            return { type: "oauth", access: `access-for-${code}`, refresh: "r", expires: Date.now() + 3_600_000 };
          },
          refresh: async (c: OAuthCredential) => c,
          toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }),
        },
      },
    } as never);
    const providers = new Providers(models, credentials, () => {}, () => "0b5a3f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    return { providers, credentials, seen, browser: (code: string) => callback?.(code) };
  }

  test("the browser is chosen, the page comes back at once, and the browser's return keeps the credential", async () => {
    const s = signInSetup();
    expect(await s.providers.signIn("fake-chatgpt")).toEqual({ url: "https://auth.example/authorize", instructions: "finish in the browser" });
    expect(s.seen).toEqual({ choice: "browser", device: "0b5a3f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", agent: "loki" });
    s.browser("from-callback");
    await until(async () => (await s.credentials.read("fake-chatgpt")) !== undefined);
    expect(await s.credentials.read("fake-chatgpt")).toMatchObject({ type: "oauth", access: "access-for-from-callback" });
    expect(() => s.providers.finishSignIn("fake-chatgpt", "late")).toThrow("no sign-in to fake-chatgpt is waiting");
  });

  test("when the browser cannot come back, the address it ended on finishes the sign-in", async () => {
    const s = signInSetup();
    await s.providers.signIn("fake-chatgpt");
    s.providers.finishSignIn("fake-chatgpt", "  http://localhost:1455/auth/callback?code=pasted  ");
    await until(async () => (await s.credentials.read("fake-chatgpt")) !== undefined);
    expect(await s.credentials.read("fake-chatgpt")).toMatchObject({ access: "access-for-http://localhost:1455/auth/callback?code=pasted" });
  });

  test("a second sign-in replaces one still waiting", async () => {
    const s = signInSetup();
    await s.providers.signIn("fake-chatgpt");
    await s.providers.signIn("fake-chatgpt");
    s.browser("second");
    await until(async () => (await s.credentials.read("fake-chatgpt")) !== undefined);
    expect(await s.credentials.read("fake-chatgpt")).toMatchObject({ access: "access-for-second" });
  });

  test("an install keeps one device id", () => {
    const file = join(mkdtempSync(join(tmpdir(), "loki-device-")), "state", "device-id");
    const id = deviceIdIn(file);
    expect(id()).toMatch(/^[0-9a-f-]{36}$/);
    expect(id()).toBe(id());
    expect(readFileSync(file, "utf8").trim()).toBe(id());
  });
});

async function until(check: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
