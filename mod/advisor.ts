import { ADVISOR_CONSULTS_PER_HOUR, isAdvisorChat } from "../core/advisor.ts";
import type { ChangesConsult } from "../daemon/advisor-changes.ts";
import type { ConsultReply } from "../daemon/advisor-consults.ts";
import type { ModApi } from "../daemon/mods/api.ts";

export interface AdvisorConsulting {
  consult(ref: { agent_id: string; conversation_id: string }, text: string): Promise<ConsultReply>;
  changes(folder: string | undefined): Promise<ChangesConsult>;
}

export const CONSULTING_PROMPT = [
  "You have an advisor: another model that reads this chat's folder and your memory but never changes anything, and has never seen this chat.",
  "Consult it with advisor_consult before a risky or hard-to-undo step, after a change worth a second look, or when you are stuck; not for every edit, and not for questions only the person can answer.",
  "It knows only what you send: what to look at (absolute paths, the change or commit range), what you want to know, and the person's constraints that bear on it. Leave out your own reasoning for why the work is right, so it judges afresh.",
  "Its answer comes later, as a row from your advisor that starts a new turn: never wait or check for it.",
  'When it answers, say which points you take up and which you set aside, and why; the person\'s instructions win. Send substantial fixes back for another look when that helps, and stop once it answers "Nothing new."',
  `You may consult it ${ADVISOR_CONSULTS_PER_HOUR} times an hour. Past that, wait or tell the person, who can still ask with /advisor.`,
].join("\n");

export function consultingSection(api: ModApi, passChat: (conversationId: string) => boolean): () => void {
  return api.prompt.section("advisor_consult", (input) => (isAdvisorChat(input.chatId) || passChat(input.chatId) ? undefined : CONSULTING_PROMPT));
}

export function consultRefusal(conversationId: string, passChat: (conversationId: string) => boolean): string | null {
  if (isAdvisorChat(conversationId)) return "an advisor chat has no advisor of its own";
  if (passChat(conversationId)) return "a background pass has no advisor";
  return null;
}

export function sentText(reply: Exclude<ConsultReply, { refused: string }>): string {
  const to = reply.advisor_model ? `sent to your advisor (${reply.advisor_model})` : "sent to your advisor";
  const when = reply.ahead ? `it answers after ${reply.ahead} consult${reply.ahead === 1 ? "" : "s"} ahead of it` : "it is working on it now";
  return (
    `${to}; ${when}; ${reply.left_this_hour} of ${ADVISOR_CONSULTS_PER_HOUR} consults left this hour. ` +
    "Its answer comes back as a row from your advisor and starts a new turn: do not wait or check for it; end your turn or go on with other work."
  );
}
