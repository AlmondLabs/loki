import type { ChatBackend } from "./frames/chat.ts";
import { readLocalAgent } from "./agents.ts";

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
