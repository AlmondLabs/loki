import { injectedDesk, injectedToken } from "./env";
/**
 * Where this tab's token and desk come from. The URL wins; when it carries
 * nothing (an installed app launched from its icon, a bare bookmark) the
 * values from the last visit are restored and written back into the URL so
 * copying the address still works.
 */
const TOKEN_KEY = "loki.token";
const DESK_KEY = "loki.desk";

export function readSession(): { token: string; desk: string | null } {
  const params = new URLSearchParams(location.search);
  let token = params.get("t");
  let desk = params.get("desk");
  let changed = false;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else {
    token = injectedToken() ?? localStorage.getItem(TOKEN_KEY) ?? "";
    if (token) {
      params.set("t", token);
      changed = true;
    }
  }
  if (desk) localStorage.setItem(DESK_KEY, desk);
  else {
    desk = injectedDesk() ?? localStorage.getItem(DESK_KEY);
    if (desk) {
      params.set("desk", desk);
      changed = true;
    }
  }
  if (changed) history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  return { token, desk };
}

export function rememberDesk(desk: string): void {
  localStorage.setItem(DESK_KEY, desk);
}
