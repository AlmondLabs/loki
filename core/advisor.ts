import { decodeEntities } from "./harness.ts";

export const ADVISOR_CHAT_PREFIX = "advisor-";

export const advisorChatId = (chatId: string): string => `${ADVISOR_CHAT_PREFIX}${chatId}`;

export const isAdvisorChat = (chatId: string): boolean => chatId.startsWith(ADVISOR_CHAT_PREFIX);

/** The request id of every consult loki submits to an advisor chat starts with this; usage reads it as the advisor's origin. */
export const ADVISOR_REQUEST_PREFIX = "advisor:";

export const ADVISOR_CONSULTS_PER_HOUR = 6;

export const ADVISOR_CAP_WINDOW_MS = 3_600_000;

export type ConsultFrom = "agent" | "person";

export type ConsultState = "queued" | "running" | "answered" | "failed" | "stopped" | "dropped";

const ENDED: ReadonlySet<ConsultState> = new Set(["answered", "failed", "stopped", "dropped"]);

export const consultEnded = (c: Pick<AdvisorConsult, "state">): boolean => ENDED.has(c.state);

/**
 * One consult in a chat's ledger (`advisor_consults` on the chat's info, in its agent's store under ~/.loki). It runs
 * queued → running → answered, failed or stopped, or ends dropped when its chat is archived. `text` is what was sent,
 * kept until the advisor has it; `submission` is the advisor chat's pi-durable submission once it runs; `reason` says
 * why a failed or stopped consult ended.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- part of ChatInfo, a pi-durable document
export type AdvisorConsult = {
  id: string;
  from: ConsultFrom;
  first_line: string;
  text: string | null;
  state: ConsultState;
  asked_at: string;
  ended_at: string | null;
  reason: string | null;
  submission: number | null;
};

export function agentConsultsInHour(consults: readonly AdvisorConsult[], now: Date): number {
  const since = now.getTime() - ADVISOR_CAP_WINDOW_MS;
  return consults.filter((c) => c.from === "agent" && Date.parse(c.asked_at) > since).length;
}

export function keptConsults(consults: readonly AdvisorConsult[], now: Date): AdvisorConsult[] {
  const since = now.getTime() - ADVISOR_CAP_WINDOW_MS;
  const newestEnded = [...consults].reverse().find(consultEnded);
  return consults.filter((c) => !consultEnded(c) || c === newestEnded || Date.parse(c.asked_at) > since);
}

const FIRST_LINE_MAX = 120;

export function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return "";
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

/** What the strip over a chat shows of its advisor: its model, whether it works and how many consults wait, its last failure. */
export interface AdvisorView {
  advisor_chat: string;
  model: string | null;
  working: boolean;
  waiting: number;
  last_failure: string | null;
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fieldsOf = (attrs: string): Partial<Record<string, string>> =>
  Object.fromEntries([...attrs.matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, decodeEntities(value)]));

const CONSULT_TAG = "loki-advisor-consult";
const ANSWER_TAG = "loki-advisor-answer";

const escapeClose = (text: string, tag: string) => text.replace(new RegExp(`</${tag}`, "g"), `&lt;/${tag}`);
const unescapeClose = (text: string, tag: string) => text.replace(new RegExp(`&lt;/${tag}`, "g"), `</${tag}`);

const isFrom = (v: string): v is ConsultFrom => v === "agent" || v === "person";

/** A consult as the advisor chat receives it: who sent it, and only what they wrote. */
export function consultBlock(from: ConsultFrom, text: string): string {
  return `<${CONSULT_TAG} from="${from}">\n${escapeClose(text, CONSULT_TAG)}\n</${CONSULT_TAG}>`;
}

export function consultOf(text: string): { from: ConsultFrom; text: string } | null {
  const m = /<loki-advisor-consult\b([^>]*)>([\s\S]*?)<\/loki-advisor-consult>/.exec(text);
  if (!m) return null;
  const { from = "" } = fieldsOf(m[1]);
  return isFrom(from) ? { from, text: unescapeClose(m[2].trim(), CONSULT_TAG) } : null;
}

/** An advisor's answer, or why there is none, as its chat receives it (R24). */
export type AdvisorAnswer = { from: ConsultFrom; asked: string; advisor_chat: string } & (
  | { state: "answered"; text: string }
  | { state: "failed" | "stopped"; reason: string }
);

export const unansweredText = (reason: string): string => `The advisor couldn't answer: ${reason}`;

/** The block an answer travels in, saved in the chat's thread: the attributes say who asked what, and of which advisor chat. */
export function answerBlock(a: AdvisorAnswer): string {
  const common = `from="${a.from}" asked="${attr(a.asked)}" advisor_chat="${attr(a.advisor_chat)}" state="${a.state}"`;
  const head = a.state === "answered" ? common : `${common} reason="${attr(a.reason)}"`;
  const body = a.state === "answered" ? a.text : unansweredText(a.reason);
  return `<${ANSWER_TAG} ${head}>\n${escapeClose(body, ANSWER_TAG)}\n</${ANSWER_TAG}>`;
}

export function answerOf(text: string): AdvisorAnswer | null {
  const m = /<loki-advisor-answer\b([^>]*)>([\s\S]*?)<\/loki-advisor-answer>/.exec(text);
  if (!m) return null;
  const { from = "", asked = "", advisor_chat: advisorChat, state, reason = "" } = fieldsOf(m[1]);
  if (!isFrom(from) || !advisorChat) return null;
  const common = { from, asked, advisor_chat: advisorChat };
  if (state === "answered") return { ...common, state, text: unescapeClose(m[2].trim(), ANSWER_TAG) };
  if (state === "failed" || state === "stopped") return { ...common, state, reason };
  return null;
}
