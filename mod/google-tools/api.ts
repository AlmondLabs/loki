import type { GoogleService } from "../../core/frame-types.ts";
import { accountFor, rec, textArg, type GoogleToolDef } from "./core.ts";

/**
 * Any other call on the five services (plan 2026-11-11 scripts, KTD11): a method, a path on the service's own API
 * host, a query and a JSON body, answered with Google's JSON. The host is loki's, never the script's, so the token goes
 * only to Google, and only for a service the account granted.
 */

/** Gmail's methods that send: a message's, a draft's, and any draft by its id. */
const GMAIL_SEND = /\/(messages|drafts)(\/[^/]+)?\/send\/?$/i;

/**
 * Whether a Gmail path names a send method once parsed as fetch will parse it (plan 2026-11-14-1530, KTD15): the
 * resolved path is tested, and a path that resolves off Gmail's own host or cannot be parsed counts as one.
 */
function sendsMail(origin: string, path: string): boolean {
  let url: URL;
  try {
    url = new URL(`${origin}${path}`);
  } catch {
    return true;
  }
  return url.origin !== origin || GMAIL_SEND.test(url.pathname) || GMAIL_SEND.test(path.split(/[?#]/)[0] ?? "");
}

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
  answersContent: true,
  run: async (call) => {
    const service = textArg(call.args, "service");
    const method = textArg(call.args, "method").toUpperCase();
    const path = textArg(call.args, "path");
    if (!isService(service)) throw new Error(`\`service\` must be one of ${SERVICES.join(", ")}`);
    if (!isMethod(method)) throw new Error(`\`method\` must be one of ${METHODS.join(", ")}`);
    const host = HOSTS[service];
    // Encoded dots and backslashes are refused too: URL parsing would turn them into a step out of the service's path.
    if (!path.startsWith("/") || path.includes("://") || /%2e|%5c|\\/i.test(path) || path.split(/[/?#]/).includes("..") || !host.paths.test(path))
      throw new Error(`${path} is not a path of the ${service} API: start it as ${String(host.paths).slice(2, -2).replace(/\\\//g, "/")}`);
    // No script path sends mail (plan 2026-11-14-1530, KTD15): Gmail's send and draft-send methods are refused here.
    // The path is judged as the request will reach Google, after the URL parser has dropped tabs and newlines and
    // folded `.` segments, and a Gmail path may hold no whitespace, control character or percent escape at all, so
    // no spelling of `send` slips past the check and is sent anyway.
    if (service === "gmail" && (/[\x00-\x20\x7f%]/.test(path) || sendsMail(host.origin, path)))
      throw new Error("scripts do not send mail: save a draft with google_gmail_draft, or propose it to the person with message_propose");
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
