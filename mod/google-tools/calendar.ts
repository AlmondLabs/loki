import { count, flag, listing, optText, rec, str, textArg, textList, type GoogleToolDef } from "./core.ts";

/**
 * Calendar for scripts (plan 2026-11-11 scripts, U9): list events in a time range, and create, change or delete one,
 * inviting guests. A change answers with the event as Calendar stored it; guests hear of it unless `notify` is false.
 */

const API = "https://www.googleapis.com/calendar/v3/calendars";

/** An event as a script reads it. */
function eventOf(v: unknown): Record<string, unknown> {
  const e = rec(v);
  const when = (t: unknown) => str(rec(t).dateTime) || str(rec(t).date);
  return {
    id: str(e.id),
    summary: str(e.summary),
    start: when(e.start),
    end: when(e.end),
    ...(e.location ? { location: str(e.location) } : {}),
    ...(e.description ? { description: str(e.description) } : {}),
    status: str(e.status),
    guests: (Array.isArray(e.attendees) ? e.attendees : []).map((a) => ({ email: str(rec(a).email), response: str(rec(a).responseStatus) })),
    ...(e.htmlLink ? { link: str(e.htmlLink) } : {}),
  };
}

/** A time as Calendar takes it: a day ("2026-11-12") is all-day, anything else a moment, in `zone` when given. */
const timeOf = (when: string, zone: string | undefined) =>
  /^\d{4}-\d{2}-\d{2}$/.test(when) ? { date: when } : { dateTime: when, ...(zone ? { timeZone: zone } : {}) };

const events: GoogleToolDef = {
  name: "google_calendar_list",
  description:
    "List events between `from` and `to` (ISO times) on `calendar` (default the primary one), matching `query` when given, recurring ones as single events in time order. One page, or with `all_pages` every page saved to a file, answered with its path and the first 20.",
  properties: {
    calendar: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    query: { type: "string" },
    all_pages: { type: "boolean" },
    page: { type: "string" },
    page_size: { type: "integer", description: "Up to 2500; default 250" },
  },
  required: ["from", "to"],
  service: "calendar",
  reads: true,
  run: (call) => {
    const calendar = optText(call.args, "calendar") ?? "primary";
    const query = optText(call.args, "query");
    const base = {
      timeMin: textArg(call.args, "from"),
      timeMax: textArg(call.args, "to"),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(count(call.args, "page_size", 250, 2500)),
      ...(query ? { q: query } : {}),
    };
    return listing(
      call,
      "google_calendar_list",
      flag(call.args, "all_pages"),
      async (token) => {
        const r = rec(
          await call.auth.json({
            service: "calendar",
            method: "GET",
            url: `${API}/${encodeURIComponent(calendar)}/events`,
            query: { ...base, ...(token ? { pageToken: token } : {}) },
          }),
        );
        return { items: (Array.isArray(r.items) ? r.items : []).map(eventOf), next: str(r.nextPageToken) || undefined };
      },
      optText(call.args, "page"),
    );
  },
};

const change: GoogleToolDef = {
  name: "google_calendar_change",
  description:
    "Create, update or delete an event on `calendar` (default primary). `action`: create (summary, start, end), update (event, any field), delete (event). `start`/`end` are ISO times, or days for all-day; `time_zone` an IANA zone; `guests` email addresses, who are invited and told unless `notify` is false; on update, `guests` is the whole new list. Answers with the event as stored.",
  properties: {
    action: { type: "string", enum: ["create", "update", "delete"] },
    calendar: { type: "string" },
    event: { type: "string" },
    summary: { type: "string" },
    description: { type: "string" },
    location: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    time_zone: { type: "string" },
    guests: { type: "array", items: { type: "string" } },
    notify: { type: "boolean" },
  },
  required: ["action"],
  service: "calendar",
  reads: false,
  run: async (call) => {
    const action = textArg(call.args, "action");
    const calendar = encodeURIComponent(optText(call.args, "calendar") ?? "primary");
    const sendUpdates = call.args.notify === false ? "none" : "all";
    const zone = optText(call.args, "time_zone");
    const start = optText(call.args, "start");
    const end = optText(call.args, "end");
    const guests = textList(call.args, "guests");
    const fields = {
      ...(optText(call.args, "summary") ? { summary: optText(call.args, "summary") } : {}),
      ...(optText(call.args, "description") ? { description: optText(call.args, "description") } : {}),
      ...(optText(call.args, "location") ? { location: optText(call.args, "location") } : {}),
      ...(start ? { start: timeOf(start, zone) } : {}),
      ...(end ? { end: timeOf(end, zone) } : {}),
      ...(guests.length ? { attendees: guests.map((email) => ({ email })) } : {}),
    };
    switch (action) {
      case "create":
        if (!start || !end) throw new Error("an event needs `start` and `end`");
        return eventOf(await call.auth.json({ service: "calendar", method: "POST", url: `${API}/${calendar}/events`, query: { sendUpdates }, json: fields }));
      case "update":
        return eventOf(
          await call.auth.json({
            service: "calendar",
            method: "PATCH",
            url: `${API}/${calendar}/events/${encodeURIComponent(textArg(call.args, "event"))}`,
            query: { sendUpdates },
            json: fields,
          }),
        );
      case "delete": {
        const event = textArg(call.args, "event");
        await call.auth.json({ service: "calendar", method: "DELETE", url: `${API}/${calendar}/events/${encodeURIComponent(event)}`, query: { sendUpdates } });
        return { id: event, deleted: true };
      }
      default:
        throw new Error(`\`action\` must be create, update or delete, not ${action}`);
    }
  },
};

/** The Calendar tools. */
export const calendarTools: GoogleToolDef[] = [events, change];
