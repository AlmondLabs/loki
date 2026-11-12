import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { OutsideFacts } from "../../../core/frame-types.ts";
import { OutsideItemActions, OutsideItemHeader } from "../desk/outside-card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import { cn } from "@/lib/utils";
import { keyFor } from "../shell/keymap";
import { ActionBar } from "../item/action-bar";
import { AgentPlan } from "../item/agent-plan";
import { AgentTurn } from "../item/agent-turn";
import { ApprovalProposal } from "../item/proposal";
import { Thought } from "../item/thought";
import { Work } from "../item/work";
import type { TurnPart } from "../item/entries";

/*
 * The workbench (plan 2026-11-12-1505, U2): every piece of the Liquid Glass look on one page, in day and night, glass
 * and solid, with made-up data, so the foundation is approved by looking before any screen moves. Development only:
 * `?workbench` on the dev server's URL (main.tsx); production builds never load it.
 */

const noop = () => {};

const ROLES: Array<[string, string]> = [
  ["bg-loki-bg", "ground"],
  ["bg-loki-panel", "panel"],
  ["bg-loki-hover", "hover"],
  ["bg-loki-selection", "selection"],
  ["bg-loki-accent", "accent"],
  ["bg-loki-affirm", "default button"],
  ["bg-loki-attention", "needs you"],
  ["bg-loki-positive", "positive"],
  ["bg-loki-negative", "negative"],
];

const TYPE: Array<[string, string]> = [
  ["text-hero", "Hero 28"],
  ["text-display", "Display 22"],
  ["text-row", "Row title 15"],
  ["text-body", "Body 13.5"],
  ["text-meta", "Meta 12"],
  ["text-tag", "Tag 11"],
];

const tool = (name: string, input: string, output: string, over: Partial<NonNullable<TranscriptRow["tool"]>> = {}): TranscriptRow => ({
  role: "tool",
  text: `${name} · ${input}`,
  tool: { name, input, output, ...over },
});

const ROWS: TranscriptRow[] = [
  tool("plan", "", "", {
    plan: [
      { content: "Read the signups table", status: "completed" },
      { content: "Group the signups by week", status: "in_progress" },
      { content: "Draw the chart", status: "pending" },
    ],
  }),
  tool("Read", "signups.csv", "week,signups"),
  tool("Bash", "python chart.py --by iso-week", "wrote chart.png", { description: "Group signups by week" }),
  tool("Bash", "python summary.py", "ModuleNotFoundError: No module named 'pandas'", { failed: true }),
];

const ANSWER: TranscriptRow = {
  role: "assistant",
  text: "Week 9 stands out. Signups nearly doubled after the pricing page went live, then settled about 40% above where the quarter started.",
  thought: "Twelve weeks of data; the last one is partial, so it stays out of the trend.",
  thought_ms: 2000,
};

const PARTS: TurnPart[] = [
  { kind: "steps", key: "s1", rows: ROWS, running: false, arrived: false },
  { kind: "message", key: "m1", row: ANSWER, last: true, first: true, arrived: false },
];

/** Made-up outside threads, one per source, for Flow's cards. */
const OUTSIDE: Array<{ name: string; facts: OutsideFacts }> = [
  [
    "Gmail",
    {
      provider: "gmail" as const,
      account_id: "gmail:ada@example.com",
      account_label: "ada@example.com",
      place: null,
      sender: "Northwind billing",
      subject: "Your November invoice",
    },
  ],
  [
    "Slack",
    {
      provider: "slack" as const,
      account_id: "slack:acme",
      account_label: "acme",
      place: "#web-launch",
      sender: "Grace",
      subject: "Can we ship the pricing page Thursday?",
    },
  ],
  [
    "Jira",
    {
      provider: "jira" as const,
      account_id: "jira:acme",
      account_label: "acme.atlassian.net",
      place: null,
      sender: "Linus",
      subject: "WEB-412 Checkout fails on Safari 17",
    },
  ],
].map(([name, over]) => ({
  name: name as string,
  facts: {
    thread_id: "t1",
    generation: 0,
    owner_agent_id: "agent-work",
    owner_name: "friday",
    sender_address: "someone@example.com",
    lines: ["A made-up line of the thread."],
    newest_message_id: "m1",
    newest_at: "2026-11-12T08:15:00.000Z",
    handoff_conversation_id: null,
    disconnected: null,
    ...(over as Pick<OutsideFacts, "provider" | "account_id" | "account_label" | "place" | "sender" | "subject">),
  },
}));
const MOVES = { read: noop, later: noop, archive: noop, label: noop };

const LOREM = Array.from(
  { length: 14 },
  (_, i) =>
    `Week ${i + 1}: signups held between 300 and 360 until the pricing page went live; the content scrolls under the toolbar and the composer, which is where the glass shows what it is made of.`,
);

/** The whole page, mounted by main.tsx when the dev server's URL carries `?workbench`. */
export function Workbench() {
  const [night, setNight] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  const [solid, setSolid] = useState(false);

  // The page drives the root's look itself, as the theme provider does in the app, and puts it back on the way out.
  useEffect(() => {
    const root = document.documentElement;
    const before = { palette: root.getAttribute("data-palette"), theme: root.getAttribute("data-theme"), glass: root.getAttribute("data-glass") };
    root.setAttribute("data-palette", "apple");
    root.setAttribute("data-theme", night ? "dark" : "light");
    root.style.colorScheme = night ? "dark" : "light";
    if (solid) root.setAttribute("data-glass", "solid");
    else root.removeAttribute("data-glass");
    return () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === null) root.removeAttribute(`data-${key}`);
        else root.setAttribute(`data-${key}`, value);
      }
    };
  }, [night, solid]);

  return (
    <div className="min-h-full bg-background text-foreground">
      <header className="sticky top-0 z-panel flex items-center gap-3 px-6 py-3 glass">
        <h1 className="m-0 text-row font-semibold">Liquid Glass workbench</h1>
        <span className="text-meta text-muted-foreground">made-up data · plan 2026-11-12-1505</span>
        <div className="ml-auto flex items-center gap-2">
          <Toggle on={night} onClick={() => setNight((n) => !n)}>
            {night ? "Night" : "Day"}
          </Toggle>
          <Toggle on={solid} onClick={() => setSolid((s) => !s)}>
            {solid ? "Solid" : "Glass"}
          </Toggle>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-8">
        <Section title="Glass over content" note="The bar, the view switch, the approval and the composer are glass; the page under them is solid.">
          <div className="relative h-[480px] overflow-hidden rounded-lg border bg-background">
            <div className="absolute inset-0 overflow-auto px-10 pt-20 pb-56">
              <div className="mx-auto flex max-w-2xl flex-col gap-4 text-body">
                {LOREM.map((line) => (
                  <p key={line} className="m-0">
                    {line}
                  </p>
                ))}
              </div>
            </div>
            <div className="absolute inset-x-4 top-4 flex items-center justify-between">
              <div className="flex h-10 items-center gap-2 rounded-full px-4 glass">
                <span className="text-body font-semibold">Signups by week</span>
                <span className="text-meta text-muted-foreground">friday</span>
              </div>
              <div className="flex h-10 items-center gap-1 rounded-full px-1 glass">
                <Button size="sm" variant="secondary" className="rounded-full">
                  Messages
                </Button>
                <Button size="sm" variant="ghost" className="rounded-full">
                  Canvas
                </Button>
                <Button size="icon-sm" variant="ghost" className="rounded-full" aria-label="Find in chat">
                  <SearchIcon />
                </Button>
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-8 pb-4">
              <div className="w-full max-w-xl rounded-lg glass-strong">
                <ApprovalProposal
                  approval={{ requestId: "r1", toolName: "Edit notes.txt", input: { path: "notes.txt" }, at: "2026-11-12T09:00:00Z" }}
                  onApprove={noop}
                />
              </div>
              <div className="flex h-12 w-full max-w-xl items-center gap-2 rounded-full pr-2 pl-2 glass-strong">
                <Button size="icon-sm" variant="ghost" className="rounded-full" aria-label="Attach">
                  <PlusIcon />
                </Button>
                <span className="flex-1 text-body text-muted-foreground">Message friday</span>
                <span className="text-meta text-muted-foreground">Medium</span>
                <Button size="icon-sm" className="rounded-full" aria-label="Send">
                  <ArrowUpIcon />
                </Button>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Roles" note="Apple's semantic colours on loki's roles; the tokens test holds each to AA in day and night.">
          <div className="grid grid-cols-3 gap-3">
            {ROLES.map(([cls, name]) => (
              <div key={name} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <span aria-hidden className={cn("size-8 rounded-md border", cls)} />
                <span className="text-body">{name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type" note="San Francisco on Apple platforms; weight carries the hierarchy.">
          <div className="flex flex-col gap-2">
            {TYPE.map(([cls, name]) => (
              <span key={name} className={cls}>
                {name} — The quick brown fox
              </span>
            ))}
          </div>
        </Section>

        <Section title="Controls" note="Apple's title case; the default button is the accent; keys live in tooltips and menus.">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Allow</Button>
            <Button variant="secondary">Always Allow…</Button>
            <Button variant="outline">Later</Button>
            <Button variant="ghost">Deny</Button>
            <Badge variant="outline">
              <span aria-hidden className="size-1.5 rounded-full bg-loki-attention" />
              needs you
            </Badge>
            <Kbd>{keyFor("inbox.archive")}</Kbd>
            <Input className="w-56" placeholder="Search" aria-label="Search" />
          </div>
        </Section>

        <Section title="A turn" note="Plan, steps and thought, folded, above the agent's words.">
          <div className="rounded-lg border bg-background p-5">
            <AgentTurn
              agentName="friday"
              state="done"
              failed={1}
              took="2 min"
              parts={PARTS}
              draw={(p) =>
                p.kind === "steps" ? (
                  <Work rows={p.rows} running={false} arrived={false} />
                ) : p.kind === "message" ? (
                  <>
                    <Thought rows={[p.row]} />
                    <p className="m-0 text-body">{p.row.text}</p>
                  </>
                ) : null
              }
            />
          </div>
        </Section>

        <Section title="Plan" note="Closed to its line until pressed.">
          <AgentPlan items={ROWS[0].tool?.plan ?? []} />
        </Section>

        <Section title="Flow's cards" note="Gmail, Slack and Jira on one shape: the card is the solid page, its moves in Apple's words.">
          <div className="flex flex-col gap-4">
            {OUTSIDE.map(({ name, facts }) => (
              <div key={name} className="flex flex-col gap-2 rounded-lg border bg-background pb-3">
                <OutsideItemHeader facts={facts} unread flash={null} went={null} cameBack={false} thread={{ kind: "loading" }} />
                <div className="px-4">
                  <OutsideItemActions facts={facts} thread={{ kind: "loading" }} typing={false} moves={MOVES} picking={false} onHandoff={noop} />
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Moves under the box" note="The finishing move last and filled.">
          <ActionBar
            view={{ main: "archive", more: ["later", "mark_read"] }}
            verbs={{ archive: { run: noop }, later: { run: noop }, mark_read: { run: noop } }}
          />
        </Section>
      </main>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-row font-semibold text-foreground">{title}</h2>
        <p className="m-0 text-meta text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" variant={on ? "secondary" : "outline"} aria-pressed={on} onClick={onClick} className="rounded-full">
      {children}
    </Button>
  );
}
