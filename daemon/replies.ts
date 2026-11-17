import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";

export const REPLIES_PROMPT = [
  "When a turn ends on a choice the person will likely make from a few clear options, you may end your reply with quick replies, which loki shows as buttons; a click sends that option to you as the person's message, word for word:",
  "<loki-replies>\n- run the migration\n- show me the diff first\n</loki-replies>",
  "Two to four options, each under 80 characters and written as the person would say it. Put the block last in the reply. Offer them only at a real fork, never on every reply; when you cannot go on without an answer, ask with your question tool instead; work for another chat is a suggestion, not a quick reply.",
].join("\n");

export function repliesExtension(): Extension {
  return defineExtension({ name: "loki.replies", sections: [section("replies", () => REPLIES_PROMPT)] });
}
