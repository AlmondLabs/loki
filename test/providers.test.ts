import { describe, expect, test } from "bun:test";
import type { ConnectProvider } from "../app/src/attention/protocol";
import { canConnect, fieldValues, fieldsFor, needsTerminal, sortProviders, welcomeStep } from "../app/src/settings/provider-model";

const p = (id: string, extra: Partial<ConnectProvider> = {}): ConnectProvider => ({ id, display_name: id[0].toUpperCase() + id.slice(1), provider_type: id, provider_name: id, requires_api_key: true, fields: [{ key: "apiKey", label: "API Key", secret: true, required: true }], connected: { is_connected: false }, ...extra });

describe("provider helpers", () => {
  test("fieldsFor: plain fields, or the chosen auth method's", () => {
    expect(fieldsFor(p("openai"))).toEqual({ authMethodId: null, fields: [{ key: "apiKey", label: "API Key", secret: true, required: true }] });
    const bedrock = p("amazon-bedrock", { fields: undefined, auth_methods: [{ id: "iam", label: "keys", fields: [{ key: "accessKey", label: "a", required: true }] }, { id: "profile", label: "profile", fields: [{ key: "profile", label: "p", required: true }] }] });
    expect(fieldsFor(bedrock).authMethodId).toBe("iam");
    expect(fieldsFor(bedrock, "profile").fields[0].key).toBe("profile");
  });
  test("canConnect and fieldValues respect required and trim", () => {
    const fields = [{ key: "apiKey", label: "k", required: true }, { key: "baseUrl", label: "u", required: false }];
    expect(canConnect(fields, { apiKey: "  " })).toBe(false);
    expect(canConnect(fields, { apiKey: "x" })).toBe(true);
    expect(fieldValues(fields, { apiKey: " x ", baseUrl: "", other: "y" })).toEqual({ apiKey: "x" });
  });
  test("needsTerminal for oauth entries", () => {
    expect(needsTerminal(p("anthropic-oauth", { is_oauth: true, fields: undefined, auth_methods: [] }))).toBe(true);
    expect(needsTerminal(p("openai"))).toBe(false);
  });
  test("sortProviders: connected, shortlist, rest; filter by name", () => {
    const list = [p("zai"), p("openai"), p("anthropic"), p("groq", { connected: { is_connected: true } })];
    expect(sortProviders(list).map((x) => x.id)).toEqual(["groq", "anthropic", "openai", "zai"]);
    expect(sortProviders(list, "ANTH").map((x) => x.id)).toEqual(["anthropic"]);
  });
  test("welcomeStep", () => {
    expect(welcomeStep({ agents: 2, providers: null })).toBeNull();
    expect(welcomeStep({ agents: 0, providers: null })).toBe("agent");
    expect(welcomeStep({ agents: 0, providers: [p("openai")] })).toBe("provider");
    expect(welcomeStep({ agents: 0, providers: [p("openai", { connected: { is_connected: true } })] })).toBe("agent");
  });
});
