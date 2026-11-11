import type { GoogleService } from "../../core/frame-types.ts";
import { accountFor, rec, textArg, type GoogleToolDef } from "./core.ts";

/**
 * Any other call on the five services (plan 2026-11-11 scripts, KTD11): a method, a path on the service's own API
 * host, a query and a JSON body, answered with Google's JSON. The host is loki's, never the script's, so the token goes
 * only to Google, and only for a service the account granted.
 */

/** Each service's API host, and the paths on it that are that service's. */
const HOSTS: Record<GoogleService, { origin: string; paths: RegExp }> = {
  gmail: { origin: "https://gmail.googleapis.com", paths: /^\/gmail\/v1\// },
  drive: { origin: "https://www.googleapis.com", paths: /^\/(upload\/)?drive\/v3\// },
  sheets: { origin: "https://sheets.googleapis.com", paths: /^\/v4\/spreadsheets/ },
  docs: { origin: "https://docs.googleapis.com", paths: /^\/v1\/documents/ },
  calendar: { origin: "https://www.googleapis.com", paths: /^\/calendar\/v3\// },
};
const SERVICES = Object.keys(HOSTS) as GoogleService[];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const isService = (v: string): v is GoogleService => (SERVICES as string[]).includes(v);
const isMethod = (v: string): v is (typeof METHODS)[number] => (METHODS as readonly string[]).includes(v);

const api: GoogleToolDef = {
  name: "google_api",
  description:
    'Call any Google API method of gmail, drive, sheets, docs or calendar that the other google_ tools do not cover, such as a spreadsheet\'s or a document\'s batchUpdate: `service`, `method`, `path` (e.g. "/v4/spreadsheets/<id>:batchUpdate", "/v1/documents/<id>:batchUpdate", "/calendar/v3/users/me/calendarList"), `query` and a JSON `body`. Answers with Google\'s JSON.',
  properties: {
    service: { type: "string", enum: SERVICES },
    method: { type: "string", enum: [...METHODS] },
    path: { type: "string" },
    query: { type: "object", additionalProperties: { type: "string" } },
    body: { type: "object" },
  },
  required: ["service", "method", "path"],
  // Checked against the service named, below.
  service: null,
  reads: false,
  run: async (call) => {
    const service = textArg(call.args, "service");
    const method = textArg(call.args, "method").toUpperCase();
    const path = textArg(call.args, "path");
    if (!isService(service)) throw new Error(`\`service\` must be one of ${SERVICES.join(", ")}`);
    if (!isMethod(method)) throw new Error(`\`method\` must be one of ${METHODS.join(", ")}`);
    const host = HOSTS[service];
    if (!path.startsWith("/") || path.includes("://") || path.split(/[/?#]/).includes("..") || !host.paths.test(path))
      throw new Error(`${path} is not a path of the ${service} API: start it as ${String(host.paths).slice(2, -2).replace(/\\\//g, "/")}`);
    const query = Object.fromEntries(Object.entries(rec(call.args.query)).filter((e): e is [string, string] => typeof e[1] === "string"));
    accountFor(call.deps, call.ctx, call.account.address, service);
    const answer = await call.auth.json({
      service,
      method,
      url: `${host.origin}${path}`,
      ...(Object.keys(query).length ? { query } : {}),
      ...(call.args.body === undefined ? {} : { json: call.args.body }),
    });
    return rec(answer);
  },
};

/** The request tool. */
export const apiTools: GoogleToolDef[] = [api];
