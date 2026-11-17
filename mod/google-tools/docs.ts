import { flag, list, rec, str, textArg, type GoogleToolDef } from "./core.ts";

const API = "https://docs.googleapis.com/v1/documents";

const paragraphText = (p: Record<string, unknown>): string =>
  list(p.elements)
    .map((e) => str(rec(rec(e).textRun).content))
    .join("");

const read: GoogleToolDef = {
  name: "google_docs_read",
  description:
    "Read a Google Doc (`document`, its id): its title and text, or with `structure` its paragraphs with their start and end indexes and style, for an edit through google_api.",
  properties: { document: { type: "string" }, structure: { type: "boolean" } },
  required: ["document"],
  service: "docs",
  reads: true,
  run: async (call) => {
    const doc = rec(await call.auth.json({ service: "docs", method: "GET", url: `${API}/${encodeURIComponent(textArg(call.args, "document"))}` }));
    const paragraphs = list(rec(doc.body).content)
      .map(rec)
      .filter((c) => c.paragraph !== undefined)
      .map((c) => ({
        start: c.startIndex ?? 0,
        end: c.endIndex,
        text: paragraphText(rec(c.paragraph)),
        style: str(rec(rec(c.paragraph).paragraphStyle).namedStyleType),
      }));
    const base = { id: str(doc.documentId), title: str(doc.title), revision: str(doc.revisionId) };
    return flag(call.args, "structure") ? { ...base, paragraphs } : { ...base, text: paragraphs.map((p) => p.text).join("") };
  },
};

export const docsTools: GoogleToolDef[] = [read];
