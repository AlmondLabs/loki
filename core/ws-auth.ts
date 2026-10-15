/**
 * How a desktop tab proves itself to loki's socket (the mod's /ws, which the daemon hosts): the token rides in the WebSocket subprotocol header
 * (`loki`, `loki.t.<token>`), not the URL, so it stays out of anything that records addresses. The server answers
 * `loki`. `?t=` is still read for GET /uploads and the agents' faces, which an <img> fetches and cannot add a header
 * to. Phones on the LAN send neither: their device cookie is the credential (mod/lan.ts).
 */
export const WS_PROTOCOL = "loki";
const PREFIX = "loki.t.";

/** The subprotocols a tab opens the socket with to present `token`: `loki` and `loki.t.<token>`; none for an empty token. */
export const tokenProtocols = (token: string): string[] => (token ? [WS_PROTOCOL, `${PREFIX}${token}`] : []);

/** The token in a Sec-WebSocket-Protocol header, or null. */
export function tokenFromProtocols(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  for (const p of raw.split(",")) {
    const v = p.trim();
    if (v.startsWith(PREFIX) && v.length > PREFIX.length) return v.slice(PREFIX.length);
  }
  return null;
}
