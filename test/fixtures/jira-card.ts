import type { JiraCardTicket, OutsideMessage } from "../../core/frame-types.ts";

/**
 * A Jira ticket as its card's read gives it (plan 089): OPS-7, a task in Operations, whose status Ada moved on since the
 * card was last read, with a rank and story points changed beside it and an eight-line description.
 */
export const jiraTicket = (over: Partial<JiraCardTicket> = {}): JiraCardTicket => ({
  key: "OPS-7",
  summary: "Rotate the keys",
  type: "Task",
  project: "Operations",
  fields: { status: "In review", assignee: "Mina Example", reporter: "Ada Lovelace", priority: "High", sprint: null, labels: ["security", "keys"] },
  description: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
  changed: [{ field: "status", from: "In progress", to: "In review", by: "Ada Lovelace", at: "2026-11-10T09:00:00.000Z" }],
  also_changed: [
    { field: "Rank", by: "Ada Lovelace", at: "2026-11-10T09:01:00.000Z" },
    { field: "Story points", by: "Ada Lovelace", at: "2026-11-10T09:02:00.000Z" },
  ],
  ...over,
});

/** The ticket's comments: the person's own, read, then Ada's, not yet read. */
export const JIRA_COMMENTS: OutsideMessage[] = [
  { id: "c1", sender: "Mina Example", at: "", text: "On it", mine: true },
  { id: "c2", sender: "Ada Lovelace", at: "", text: "Can you look at the rotation?", mine: false, unread: true, brought: true },
];
