import type { ChatBackend } from "./frames/chat.ts";
import { readLocalAgent } from "./agents.ts";

/**
 * What this Mac lacks to run an agent's chat (plan 023, U10, R21), in words for the person: a sign-in for the
 * provider of the agent's model, an MCP server it uses that needs a sign-in or is not running. Shown when a new chat
 * is about to start here, so it never fails halfway through its first turn.
 */
export async function missingFor(chat: Pick<ChatBackend, "providers" | "mcp">, agentId: string): Promise<string[]> {
  const out: string[] = [];
  const model = readLocalAgent(agentId)?.model ?? null;
  const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : null;
  if (provider) {
    const known = (await chat.providers()).find((p) => p.id === provider || p.provider_name === provider);
    if (known && !known.connected.is_connected) out.push(`a sign-in for ${known.display_name}: Preferences › Providers`);
  }
  for (const s of (await chat.mcp()).servers) {
    if (s.off_for.includes(agentId)) continue;
    if (s.state === "signin") out.push(`a sign-in for the MCP server ${s.name}: Preferences › MCP servers`);
    else if (s.state === "down") out.push(`the MCP server ${s.name}, which is not running${s.error ? `: ${s.error}` : ""}`);
  }
  return out;
}
