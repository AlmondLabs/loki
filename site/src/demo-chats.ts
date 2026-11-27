import { Listeners } from "../../core/listeners.ts";
import type { AttentionItem, PendingApproval, PendingQuestion } from "../../core/attention/model.ts";
import type { ChatFace, ChatViews } from "../../core/attention/use-attention.ts";
import type { TranscriptRow } from "../../core/attention/transcript.ts";
import type { Runtime } from "../../core/attention/protocol.ts";
import type { SuggestionOutcome } from "../../core/attention/chat-store.ts";
import type { SuggestionAction } from "../../core/frames.ts";
import type { Suggestion, SuggestionTarget } from "../../core/frame-types.ts";

export type Schedule = (run: () => void, ms: number) => () => void;

export const timerSchedule: Schedule = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

export const DEMO_AGENTS = [
  { id: "wren", name: "wren" },
  { id: "ira", name: "ira" },
  { id: "otto", name: "otto" },
] as const;

interface DemoChat {
  id: string;
  agent_id: string;
  title: string;
  minutesAgo: number;
  rows: TranscriptRow[];
  approval?: { tool: string; input: Record<string, unknown>; then: TranscriptRow[] };
  question?: { questions: PendingQuestion["questions"]; then: (answer: string) => string };
  answer: (text: string) => string;
  suggestions?: Array<Pick<Suggestion, "id" | "title" | "text" | "target">>;
  cwd?: string;
}

const user = (text: string): TranscriptRow => ({ role: "user", text });
const agent = (text: string): TranscriptRow => ({ role: "assistant", text });

function startingChats(): DemoChat[] {
  return [
    {
      id: "checkout-test",
      agent_id: "wren",
      title: "Fix the flaky checkout test",
      minutesAgo: 2,
      rows: [
        user("The checkout test fails about one run in five on CI. Can you find out why?"),
        agent(
          "Found it. The test builds an order at `new Date()` and asserts on the delivery day, so a run that crosses midnight UTC lands on the next day. I've pinned the clock in the fixture.\n\nI'd like to run the checkout suite to confirm.",
        ),
      ],
      approval: {
        tool: "bash",
        input: { command: "npm test -- checkout", description: "Run the checkout tests" },
        then: [
          {
            role: "tool",
            text: "",
            tool: { name: "bash", input: "npm test -- checkout", description: "Run the checkout tests", output: "✓ 12 passed (1.8s)" },
          },
          agent("All 12 pass, three times in a row. The fix is one line in `test/fixtures/order.ts`; want me to open a pull request?"),
        ],
      },
      answer: () => "On it. I'll open the pull request with the fix and a note on why the test was flaky.",
      cwd: "~/code/shop",
      suggestions: [
        {
          id: "notes",
          title: "Add the flaky-test fix to the 2.3 notes",
          text: "Add this under **Fixes** in the 2.3 notes:\n\n- The checkout tests no longer fail for runs that cross midnight UTC; the order fixture now runs on a pinned clock.",
          target: { agent_id: "wren", conversation_id: "release-notes" },
        },
        {
          id: "audit",
          title: "Look for the same clock bug in other tests",
          text: "Search `test/` for tests that read `new Date()` or `Date.now()` directly, list the ones whose assertions depend on the day, and pin their clocks the way `test/fixtures/order.ts` now does.",
          target: { agent_id: "wren", folder: "~/code/shop" },
        },
      ],
    },
    {
      id: "lisbon",
      agent_id: "ira",
      title: "A long weekend in Lisbon",
      minutesAgo: 9,
      rows: [
        user("Find me a flat in Lisbon for the second weekend of March, walkable to the old town, under €140 a night."),
        agent(
          "Three fit:\n\n1. **Alfama, top floor**: €118 a night, river view, 4 minutes to the cathedral.\n2. **Graça, with a terrace**: €132, quiet street, the 28 tram at the corner.\n3. **Mouraria, two rooms**: €109, the cheapest, but no lift and four floors.\n\nShould I compare them side by side with the walk to each?",
        ),
      ],
      answer: (text) =>
        /no|not/i.test(text)
          ? "Understood. I'll keep looking and come back with others by tonight."
          : "Done: the three are compared with prices and the walk from each. The Alfama one has two other enquiries this week, so I'd decide soon.",
    },
    {
      id: "groceries",
      agent_id: "otto",
      title: "This week's groceries",
      minutesAgo: 24,
      rows: [
        user("Plan dinners for this week, nothing that takes more than 30 minutes."),
        agent("I've planned five dinners. One thing before I write the list:"),
      ],
      question: {
        questions: [
          {
            question: "Which shop should I write the list for?",
            header: "shop",
            options: [{ label: "the market on Saturday" }, { label: "the supermarket" }, { label: "delivery on Thursday" }],
            multiSelect: false,
          },
        ],
        then: (answer) => `The list is ready for ${answer}, grouped by aisle, 23 items. I left out what you bought last week and still have.`,
      },
      answer: () => "Noted. I'll fold that into the plan and the list.",
    },
    {
      id: "sleep-paper",
      agent_id: "ira",
      title: "Read: sleep and memory",
      minutesAgo: 95,
      rows: [
        user("Summarise the paper I dropped in, in plain words."),
        agent(
          "**In one line**: deep sleep replays the day's new memories and moves them into long-term storage; cut it short and that move stops.\n\nThe interesting part is the timing: most of the replay happens in the first three hours of the night.",
        ),
      ],
      answer: () => "Good question. They measured it in two ways, and both point the same way; I've added the details under the summary.",
    },
    {
      id: "release-notes",
      agent_id: "wren",
      title: "Release notes for 2.3",
      minutesAgo: 180,
      rows: [
        user("Draft the release notes from the merged pull requests."),
        agent("I've drafted the release notes: 4 features, 9 fixes, grouped for people who use it rather than by folder."),
      ],
      answer: () => "Changed. I've tightened the wording and moved the fixes under the features.",
    },
  ];
}

interface ChatState {
  chat: DemoChat;
  rows: TranscriptRow[];
  status: ChatFace["status"];
  approval: PendingApproval | null;
  question: PendingQuestion | null;
  unread: boolean;
  archived: boolean;
  at: number;
  suggestions: Suggestion[];
  draft: string | null;
}

const NEW_CHAT_ANSWER =
  "On it. Four other tests read the clock directly; two of them assert on the day, so they would fail the same way around midnight. I'll pin both and tell you when they pass.";

const STREAM_WORDS = 3;
const STREAM_MS = 45;
const THINK_MS = 700;

export class DemoChats implements ChatViews {
  private states = new Map<string, ChatState>();
  private listeners = new Listeners();
  private cancels: Array<() => void> = [];
  private itemsCache: AttentionItem[] | null = null;
  private chatsCache: AttentionItem[] | null = null;
  private made = 0;
  private readonly now: () => number;
  private readonly schedule: Schedule;

  constructor(now: () => number = Date.now, schedule: Schedule = timerSchedule) {
    this.now = now;
    this.schedule = schedule;
    this.reset();
  }

  reset(): void {
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
    this.made = 0;
    this.states = new Map(
      startingChats().map((chat) => [
        chat.id,
        {
          chat,
          rows: chat.rows,
          status: "idle",
          approval: chat.approval
            ? { requestId: `${chat.id}-approval`, toolName: chat.approval.tool, input: chat.approval.input, at: this.iso(chat.minutesAgo) }
            : null,
          question: chat.question
            ? {
                requestId: `${chat.id}-question`,
                input: { questions: chat.question.questions },
                questions: chat.question.questions,
                at: this.iso(chat.minutesAgo),
              }
            : null,
          unread: true,
          archived: false,
          at: this.now() - chat.minutesAgo * 60_000,
          suggestions: (chat.suggestions ?? []).map((x) => ({ ...x, status: "pending", created_at: this.iso(chat.minutesAgo) })),
          draft: null,
        },
      ]),
    );
    this.changed();
  }

  subscribe = (onChange: () => void): (() => void) => this.listeners.add(onChange);

  items = (): AttentionItem[] => {
    this.itemsCache ??= [...this.states.values()]
      .filter((s) => !s.archived && s.status === "idle")
      .map((s) => this.itemOf(s))
      .sort((a, b) => b.score - a.score);
    return this.itemsCache;
  };

  conversation = (_agentId: string, conversationId: string): ChatFace => {
    const s = this.states.get(conversationId);
    return {
      status: s?.status ?? "idle",
      pending: s?.approval ?? null,
      question: s?.question ?? null,
      error: null,
      mode: "auto",
      cwd: s?.chat.cwd ?? null,
      engine: null,
      older: null,
      loadFailed: null,
      loadStep: () => Promise.resolve(null),
      suggestions: s?.suggestions ?? [],
      links: [],
    };
  };

  chats = (): AttentionItem[] => {
    this.chatsCache ??= [...this.states.values()].filter((s) => !s.archived).map((s) => this.itemOf(s));
    return this.chatsCache;
  };

  draftOf = (id: string): string | null => this.states.get(id)?.draft ?? null;

  decideSuggestion = (rt: Runtime, suggestionId: string, action: SuggestionAction): Promise<SuggestionOutcome> => {
    const s = this.states.get(rt.conversation_id)?.suggestions.find((x) => x.id === suggestionId);
    if (s?.status !== "pending") return Promise.resolve({ done: false, message: "this suggestion was already settled", suggestion: s ?? null });
    const t = s.target;
    const id = "conversation_id" in t ? t.conversation_id : this.startChat(t.agent_id, s.title, t.folder);
    if (action === "send") this.reply(id, s.text);
    if (action === "draft") this.update(id, (st) => ({ ...st, draft: s.text }));
    const settled: Suggestion = { ...s, status: action === "send" ? "sent" : action === "draft" ? "drafted" : "rejected", decided_by: "you" };
    this.setSuggestion(rt.conversation_id, settled);
    return Promise.resolve({ done: true, message: null, suggestion: settled });
  };

  retargetSuggestion = (rt: Runtime, suggestionId: string, target: SuggestionTarget): Promise<SuggestionOutcome> => {
    const s = this.states.get(rt.conversation_id)?.suggestions.find((x) => x.id === suggestionId);
    if (!s) return Promise.resolve({ done: false, message: "this suggestion is gone", suggestion: null });
    const moved = { ...s, target };
    this.setSuggestion(rt.conversation_id, moved);
    return Promise.resolve({ done: true, message: null, suggestion: moved });
  };

  watchThreads = (onChange: () => void): (() => void) => this.listeners.add(onChange);

  threadRows = (_agentId: string, conversationId: string): TranscriptRow[] | undefined => this.states.get(conversationId)?.rows;

  seen = (id: string): void => this.update(id, (s) => ({ ...s, unread: false }));
  unread = (id: string): void => this.update(id, (s) => ({ ...s, unread: true }));

  archive = (id: string): void => this.update(id, (s) => ({ ...s, archived: true }));
  unarchive = (id: string): void => this.update(id, (s) => ({ ...s, archived: false }));

  reply = (id: string, text: string): void => {
    const s = this.states.get(id);
    if (!s) return;
    this.update(id, (st) => ({ ...st, rows: [...st.rows, user(text)], unread: false }));
    this.answerWith(id, s.chat.answer(text));
  };

  decide = (id: string, allow: boolean): void => {
    const s = this.states.get(id);
    if (!s?.approval || !s.chat.approval) return;
    const then = s.chat.approval.then;
    this.update(id, (st) => ({ ...st, approval: null, unread: false }));
    if (!allow) {
      this.answerWith(id, "Understood, I won't run it. The fix is in place; you can run the suite yourself when it suits you.");
      return;
    }
    this.update(id, (st) => ({ ...st, status: "thinking", rows: [...st.rows, ...then.slice(0, -1)] }));
    const last = then.at(-1);
    if (last) this.answerWith(id, last.text);
  };

  answer = (id: string, answers: Record<string, string | string[]>): void => {
    const s = this.states.get(id);
    if (!s?.question || !s.chat.question) return;
    const picked = Object.values(answers).flat().join(", ");
    const then = s.chat.question.then(picked || "you");
    this.update(id, (st) => ({ ...st, question: null, unread: false, rows: [...st.rows, user(picked)] }));
    this.answerWith(id, then);
  };

  dispose(): void {
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
  }

  private answerWith(id: string, text: string): void {
    this.update(id, (s) => ({ ...s, status: "thinking" }));
    const words = text.split(/(?<= )/);
    let shown = 0;
    const step = () => {
      shown = Math.min(words.length, shown + STREAM_WORDS);
      const partial = words.slice(0, shown).join("");
      const done = shown >= words.length;
      this.update(id, (s) => {
        const rows = s.status === "streaming" ? s.rows.slice(0, -1) : s.rows;
        return { ...s, rows: [...rows, agent(partial)], status: done ? "idle" : "streaming", unread: done ? true : s.unread, at: this.now() };
      });
      if (!done) this.cancels.push(this.schedule(step, STREAM_MS));
    };
    this.cancels.push(this.schedule(step, THINK_MS));
  }

  private startChat(agentId: string, title: string, folder: string): string {
    this.made += 1;
    const id = `new-${this.made}`;
    const chat: DemoChat = { id, agent_id: agentId, title, minutesAgo: 0, rows: [], cwd: folder, answer: () => NEW_CHAT_ANSWER };
    this.states.set(id, {
      chat,
      rows: [],
      status: "idle",
      approval: null,
      question: null,
      unread: false,
      archived: false,
      at: this.now(),
      suggestions: [],
      draft: null,
    });
    this.changed();
    return id;
  }

  private setSuggestion(chatId: string, next: Suggestion): void {
    this.update(chatId, (st) => ({ ...st, suggestions: st.suggestions.map((x) => (x.id === next.id ? next : x)) }));
  }

  private update(id: string, change: (s: ChatState) => ChatState): void {
    const s = this.states.get(id);
    if (!s) return;
    this.states.set(id, change(s));
    this.changed();
  }

  private changed(): void {
    this.itemsCache = null;
    this.chatsCache = null;
    this.listeners.emit();
  }

  private iso(minutesAgo: number): string {
    return new Date(this.now() - minutesAgo * 60_000).toISOString();
  }

  private itemOf(s: ChatState): AttentionItem {
    const runtime: Runtime = { agent_id: s.chat.agent_id, conversation_id: s.chat.id };
    const last = s.rows.at(-1);
    const status: AttentionItem["status"] = s.approval ? "approval" : s.question ? "question" : "done";
    const blocked = status !== "done";
    const hours = (this.now() - s.at) / 3_600_000;
    return {
      id: s.chat.id,
      agent_id: s.chat.agent_id,
      agent_name: s.chat.agent_id,
      title: s.chat.title,
      last_message_at: new Date(s.at).toISOString(),
      archived: false,
      cwd: s.chat.cwd ?? null,
      has_draft: s.draft !== null,
      draft_text: s.draft,
      status,
      lastAssistantText: last?.role === "assistant" ? last.text : null,
      lastRole: last?.role === "user" ? "user" : "assistant",
      pendingApproval: s.approval,
      pendingQuestion: s.question,
      error: null,
      seenAt: null,
      unread: s.unread,
      viewedAt: null,
      lastAsk: "person",
      score: (blocked ? 100 : 0) + (s.unread ? 10 : 0) - hours * 0.1,
      reason: blocked ? "blocked" : s.unread ? "new" : "other",
      focus: 0,
      runtime,
    };
  }
}
