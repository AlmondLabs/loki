import type { ModApi } from "../../daemon/mods/api.ts";
import { servicesOf } from "../accounts.ts";
import { apiTools } from "./api.ts";
import { calendarTools } from "./calendar.ts";
import { googleAccountsOf, modToolOf, type GoogleToolDeps } from "./core.ts";
import { docsTools } from "./docs.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { sheetsTools } from "./sheets.ts";

export type { GoogleToolDeps } from "./core.ts";

/**
 * The Google tools (plan 2026-11-11 scripts, U7, U9): Gmail, Drive, Sheets, Docs and Calendar for the Google accounts
 * an agent owns on this Mac, as script-only tools in the `google` namespace (daemon/scripts.ts). An agent without such
 * an account is offered none of them, and so no script tool either. Each call is checked as it runs (core.ts).
 */
export function registerGoogleTools(api: ModApi, deps: GoogleToolDeps): Array<() => void> {
  const accounts = api.tools.register({
    name: "google_accounts",
    description: "The Google accounts this agent owns on this Mac: each one's address, whether it is connected, and the services its sign-in allows.",
    parameters: { type: "object", properties: {} },
    callers: ["tools"],
    outputSchema: { type: "object" },
    replay: "safe",
    annotations: { readOnly: true },
    forAgent: (agentId) => googleAccountsOf(deps.accounts, agentId).length > 0,
    execute: (_args, ctx) => ({
      accounts: googleAccountsOf(deps.accounts, ctx.agentId).map((a) => ({
        address: a.address,
        connected: a.status === "connected",
        services: servicesOf(a),
      })),
    }),
  });
  const tools = [...gmailTools, ...driveTools, ...sheetsTools, ...docsTools, ...calendarTools, ...apiTools];
  return [accounts, ...tools.map((def) => api.tools.register(modToolOf(def, deps)))];
}
