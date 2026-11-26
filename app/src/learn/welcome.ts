export interface WelcomeRow {
  icon: "chats" | "spaced" | "budget";
  head: string;
  line: string;
}

export const WELCOME_TITLE = "Learn";
export const WELCOME_LINE = "Flashcards from your chats, when you want them.";

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

export const WELCOME_MORE: readonly string[] = [
  "It also names leads: ideas that went by in a chat without being understood. Start one and the agent that was there teaches it in a chat of its own, or choose Not This and it is set aside.",
  "Deleting a card tells it what you don't want; it reads the deleted ones before it writes again.",
  "Everything it writes is a file under ~/.loki/learn/. Preferences › Learn turns it off again.",
];
