export const WS_PROTOCOL = "loki";
const PREFIX = "loki.t.";

export const tokenProtocols = (token: string): string[] => (token ? [WS_PROTOCOL, `${PREFIX}${token}`] : []);

export function tokenFromProtocols(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  for (const p of raw.split(",")) {
    const v = p.trim();
    if (v.startsWith(PREFIX) && v.length > PREFIX.length) return v.slice(PREFIX.length);
  }
  return null;
}
