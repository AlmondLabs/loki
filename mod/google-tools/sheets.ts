import { flag, list, rec, str, textArg, textList, type GoogleCall, type GoogleToolDef } from "./core.ts";

/**
 * Sheets for scripts (plan 2026-11-11 scripts, U9): read ranges as values and formulas, and write ranges, answered
 * with what Sheets stored (R21), read back as both, so a script checks a formula and what it computes in one call.
 * Formatting and structure (`batchUpdate`) go through google_api.
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Ranges as Sheets holds them: each with its values as shown and, with formulas, what was typed in each cell. */
async function readRanges(call: GoogleCall, spreadsheet: string, ranges: string[], formulas: boolean): Promise<Array<Record<string, unknown>>> {
  const fetchRender = async (render: "FORMATTED_VALUE" | "FORMULA") => {
    const params = new URLSearchParams({ valueRenderOption: render });
    for (const r of ranges) params.append("ranges", r);
    return list(
      rec(await call.auth.json({ service: "sheets", method: "GET", url: `${API}/${encodeURIComponent(spreadsheet)}/values:batchGet?${params.toString()}` }))
        .valueRanges,
    );
  };
  const [shown, typed] = await Promise.all([fetchRender("FORMATTED_VALUE"), formulas ? fetchRender("FORMULA") : Promise.resolve([])]);
  return shown.map((v, i) => ({
    range: str(rec(v).range),
    values: list(rec(v).values),
    ...(formulas ? { formulas: list(rec(typed[i]).values) } : {}),
  }));
}

const read: GoogleToolDef = {
  name: "google_sheets_read",
  description:
    'Read `ranges` (A1 notation, e.g. "Budget!A1:D20") of a spreadsheet: each range\'s values as shown, and with `formulas` what was typed in each cell.',
  properties: {
    spreadsheet: { type: "string", description: "The spreadsheet's id, from its link" },
    ranges: { type: "array", items: { type: "string" } },
    formulas: { type: "boolean" },
  },
  required: ["spreadsheet", "ranges"],
  service: "sheets",
  reads: true,
  run: async (call) => ({ ranges: await readRanges(call, textArg(call.args, "spreadsheet"), textList(call.args, "ranges"), flag(call.args, "formulas")) }),
};

const write: GoogleToolDef = {
  name: "google_sheets_write",
  description:
    "Write cells: `data` is a list of {range, values} (values a list of rows). Typed as a person would (formulas work) unless `raw`. Answers with how many cells changed and each range read back, values and formulas, as Sheets stored them.",
  properties: {
    spreadsheet: { type: "string" },
    data: {
      type: "array",
      items: { type: "object", properties: { range: { type: "string" }, values: { type: "array", items: { type: "array" } } }, required: ["range", "values"] },
    },
    raw: { type: "boolean", description: "Store exactly what is given, with no formula or number parsing" },
  },
  required: ["spreadsheet", "data"],
  service: "sheets",
  reads: false,
  run: async (call) => {
    const spreadsheet = textArg(call.args, "spreadsheet");
    const data = list(call.args.data).map((d) => ({ range: str(rec(d).range), values: list(rec(d).values) }));
    if (!data.length || data.some((d) => !d.range)) throw new Error("`data` needs at least one {range, values}");
    const r = rec(
      await call.auth.json({
        service: "sheets",
        method: "POST",
        url: `${API}/${encodeURIComponent(spreadsheet)}/values:batchUpdate`,
        json: { valueInputOption: flag(call.args, "raw") ? "RAW" : "USER_ENTERED", data },
      }),
    );
    return {
      updated_cells: typeof r.totalUpdatedCells === "number" ? r.totalUpdatedCells : 0,
      stored: await readRanges(
        call,
        spreadsheet,
        data.map((d) => d.range),
        true,
      ),
    };
  },
};

/** The Sheets tools. */
export const sheetsTools: GoogleToolDef[] = [read, write];
