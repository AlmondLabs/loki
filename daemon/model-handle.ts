/** Letta's name for ChatGPT's sign-in provider, as models imported from it may still carry it; pi-ai's is openai-codex. */
const PROVIDER_ALIASES: Record<string, string> = { "chatgpt-plus-pro": "openai-codex", chatgpt_oauth: "openai-codex" };

/**
 * A model handle as pi-ai can run it. A handle whose provider pi-ai knows is kept; otherwise the first part that names
 * a known provider starts it (Letta wrote some as `chatgpt-plus-pro/chatgpt-plus-pro/openai-codex/<model>`), or Letta's
 * name for ChatGPT's provider is translated. Anything else stays as it is, and fails with its own name.
 */
export function piHandle(handle: string, known: (provider: string) => boolean): string {
  const parts = handle.split("/");
  if (parts.length < 2 || known(parts[0])) return handle;
  for (let i = 1; i < parts.length - 1; i++) if (known(parts[i])) return parts.slice(i).join("/");
  const alias = PROVIDER_ALIASES[parts[0]];
  return alias && known(alias) ? [alias, ...parts.slice(1)].join("/") : handle;
}
