/**
 * Learn's welcome (plan 2026-11-14-0852, 2), the words the Mac and the phone share: a title, three rows of a symbol,
 * a bold line and one sentence, as Apple's welcome sheets have, and the rest behind Learn More….
 */

/** One row of the welcome: which symbol leads it, its bold line and its sentence. */
export interface WelcomeRow {
  icon: "chats" | "spaced" | "budget";
  head: string;
  line: string;
}

/** The welcome's title and the line under it. */
export const WELCOME_TITLE = "Learn";
/** The line under the title. */
export const WELCOME_LINE = "Flashcards from your chats, when you want them.";

/** The three rows, with the day's cap from the writer's settings. */
export function welcomeRows(dailyCap: number): WelcomeRow[] {
  return [
    {
      icon: "chats",
      head: "Cards from what you discuss",
      line: "After a chat has been quiet for half an hour, the agent writes cards for what will still be true in months.",
    },
    {
      icon: "spaced",
      head: "Reviewed when you'd forget",
      line: "Cards you know come back less often; the ones you miss come back sooner.",
    },
    {
      icon: "budget",
      head: "Uses your model",
      line: `Up to ${dailyCap} cards a day, from your provider budget. Nothing runs while no chat has anything new.`,
    },
  ];
}

/** What Learn More… opens to: the details the rows leave out. */
export const WELCOME_MORE: readonly string[] = [
  "It also names leads: ideas that went by in a chat without being understood. Start one and the agent that was there teaches it in a chat of its own, or choose Not This and it is set aside.",
  "Deleting a card tells it what you don't want; it reads the deleted ones before it writes again.",
  "Everything it writes is a file under ~/.loki/recall/. Preferences › Learn turns it off again.",
];
