import { describe, expect, test } from "vitest";
import { editOf, formOf, pairsText, parsePairs, secureValues, tokenLabel } from "../app/src/settings/mcp.tsx";
import type { McpServerView } from "../core/frame-types.ts";

const server = (config: McpServerView["config"]): McpServerView => ({
  name: "gh",
  entry: "my gh",
  kind: "command" in config ? "local" : "remote",
  state: "connected",
  error: null,
  purpose: null,
  tools: [],
  tokens: 0,
  config,
  off_for: [],
  sign_in: null,
});

describe("Settings › MCP's form", () => {
  test("a server's config becomes the form's text, and the form comes back as the same edit", async () => {
    const local = server({ command: "npx", args: ["-y", "srv"], env: { A: "1", B: "${keychain:gh.B}" }, cwd: "/w" });
    const form = formOf(local);
    expect(form).toMatchObject({ kind: "local", name: "my gh", command: "npx", args: "-y\nsrv", env: "A=1\nB=${keychain:gh.B}", cwd: "/w" });
    expect(await editOf(form, (p) => Promise.resolve(p))).toEqual({ command: "npx", args: ["-y", "srv"], env: { A: "1", B: "${keychain:gh.B}" }, cwd: "/w" });
    const remote = formOf(server({ url: "https://x/mcp", headers: { Authorization: "Bearer t" } }));
    expect(await editOf(remote, (p) => Promise.resolve(p))).toEqual({ url: "https://x/mcp", headers: { Authorization: "Bearer t" } });
    expect(formOf(null)).toMatchObject({ kind: "local", name: "", command: "" });
  });

  test("values go to the keychain and their references take their place; references and empties are left; a failure says which", async () => {
    const stored: string[] = [];
    const secret = (name: string, value: string) => (stored.push(`${name}=${value}`), Promise.resolve({ ref: `\${keychain:${name}}` }));
    expect(await secureValues({ A: "1", B: "${keychain:gh.B}", C: "" }, "gh", secret)).toEqual({ A: "${keychain:gh.A}", B: "${keychain:gh.B}", C: "" });
    expect(stored).toEqual(["gh.A=1"]);
    await expect(secureValues({ T: "x" }, "gh", () => Promise.resolve("keychain locked"))).rejects.toThrow("could not keep T in the keychain: keychain locked");
  });

  test("lines of pairs read back; costs read as the list shows them", () => {
    expect(parsePairs("A=1\n =x\nnone\nB = two=2", "=")).toEqual({ A: "1", B: "two=2" });
    expect(parsePairs("Authorization: Bearer x:y", ":")).toEqual({ Authorization: "Bearer x:y" });
    expect(pairsText({ A: "1" }, ":")).toBe("A: 1");
    expect([tokenLabel(240), tokenLabel(9150)]).toEqual(["~240 tokens", "~9.2k tokens"]);
  });
});
