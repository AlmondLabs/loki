import { injectedDesk, injectedToken } from "./env";
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
  if (changed) history.replaceState(history.state, "", `${location.pathname}?${params.toString()}${location.hash}`);
  return { token, desk };
}

export function rememberDesk(desk: string): void {
  localStorage.setItem(DESK_KEY, desk);
}
