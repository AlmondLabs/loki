import { useEffect, useState, useSyncExternalStore } from "react";
import Markdown from "react-markdown";
import { chatChoices, SuggestionCard, targetOf, type SuggestionSource } from "../../app/src/chat/suggestion-card";
import { Button } from "../../app/src/components";
import type { Suggestion } from "../../core/frame-types.ts";
import type { TranscriptRow } from "../../core/attention/transcript.ts";
import { DEMO_AGENTS, DemoChats } from "./demo-chats";

/** The chat the suggestions were made in. */
const FROM = { agent_id: "wren", conversation_id: "checkout-test" };

/** What a settled suggestion's line says happened, by its status. */
const SETTLED: Partial<Record<Suggestion["status"], string>> = { sent: "sent to", drafted: "saved as a draft in", rejected: "rejected" };

/**
 * The suggestions section's live demo: a chat whose agent suggests messages for other chats, drawn with loki's own
 * suggestion cards over the made-up chats of demo-chats.ts. Send now puts the message in its chat and that chat's
 * agent answers; save as draft leaves it in that chat's box; change chat points it elsewhere; reject drops it. The
 * right side shows the chat it went to.
 */
export function SuggestionsDemo() {
  const [chats] = useState(() => new DemoChats());
  useEffect(() => () => chats.dispose(), [chats]);
  const items = useSyncExternalStore(chats.subscribe, chats.chats);

  const source: Pick<SuggestionSource, "items" | "agents" | "listed" | "agentsLoaded"> = {
    items,
    agents: DEMO_AGENTS,
    listed: true,
    agentsLoaded: true,
  };
  const all = chats.conversation(FROM.agent_id, FROM.conversation_id).suggestions;
  const [openId, setOpenId] = useState<string | null>("notes");
  /** The chat the last action went to, shown on the right. */
  const [landed, setLanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = (s: Suggestion, action: "send" | "draft" | "reject") => {
    setBusy(s.id);
    const before = new Set(items.map((c) => c.id));
    void chats.decideSuggestion(FROM, s.id, action).then(() => {
      setBusy(null);
      if (action === "reject") return;
      const t = s.target;
      setLanded("conversation_id" in t ? t.conversation_id : (chats.chats().find((c) => !before.has(c.id))?.id ?? null));
    });
  };

  const startOver = () => {
    chats.reset();
    setLanded(null);
    setOpenId("notes");
  };

  const origin = chats.threadRows(FROM.agent_id, FROM.conversation_id) ?? [];
  const last = origin.filter((r) => r.role === "assistant").at(-1);
  const target = landed ? items.find((c) => c.id === landed) : undefined;

  return (
    <div className="site-window">
      <div className="site-window-bar" aria-hidden>
        <span />
        <span />
        <span />
        <em>Fix the flaky checkout test · wren</em>
      </div>
      <div className="site-suggest">
        <div className="site-suggest-from">
          {last && <Bubble row={last} who="wren" />}
          <div className="site-suggest-cards" role="region" aria-label="suggestions for other chats">
            {all.map((s) =>
              s.status === "pending" ? (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  target={targetOf(source, s)}
                  open={openId === s.id}
                  onToggle={() => setOpenId(openId === s.id ? null : s.id)}
                  note={null}
                  busy={busy === s.id}
                  blocked={null}
                  touch={false}
                  onDecide={(action) => decide(s, action)}
                  picker={(close) => (
                    <Picker
                      source={source}
                      suggestion={s}
                      onPick={(c) => {
                        const to = c.conversationId
                          ? { agent_id: c.agentId, conversation_id: c.conversationId }
                          : { agent_id: c.agentId, folder: "~/code/shop" };
                        void chats.retargetSuggestion(FROM, s.id, to).then(close);
                      }}
                      onCancel={close}
                    />
                  )}
                />
              ) : (
                <div key={s.id} className="loki-suggestion loki-suggestion-told">
                  <span className="loki-suggestion-title">{s.title}</span>
                  <span className="loki-suggestion-note">
                    {SETTLED[s.status]}
                    {s.status !== "rejected" && ` ${targetOf(source, s).name}`}
                  </span>
                </div>
              ),
            )}
          </div>
          <div className="site-suggest-box" aria-hidden>
            message wren
          </div>
        </div>
        <div className="site-suggest-to" aria-live="polite">
          {target ? (
            <>
              <div className="site-suggest-to-head">
                {target.title} · {target.agent_id}
              </div>
              <div className="site-suggest-rows">
                {(chats.threadRows(target.agent_id, target.id) ?? [])
                  .filter((r) => r.role !== "tool")
                  .slice(-3)
                  .map((r, i) => (
                    <Bubble key={i} row={r} who={target.agent_id} />
                  ))}
              </div>
              <div className="site-suggest-box" data-draft={chats.draftOf(target.id) ? true : undefined}>
                {chats.draftOf(target.id) ?? `message ${target.agent_id}`}
              </div>
            </>
          ) : (
            <p className="site-suggest-empty">The chat a suggestion goes to shows here.</p>
          )}
        </div>
      </div>
      {all.some((s) => s.status !== "pending") && (
        <button type="button" className="site-start-over" onClick={startOver}>
          start over
        </button>
      )}
    </div>
  );
}

/** One message, as a short bubble: who wrote it and its text as markdown. */
function Bubble({ row, who }: { row: TranscriptRow; who: string }) {
  const mine = row.role === "user";
  return (
    <div className="site-bubble" data-mine={mine || undefined}>
      <span className="site-bubble-who">{mine ? "you" : who}</span>
      <div className="loki-md">
        <Markdown>{row.text}</Markdown>
      </div>
    </div>
  );
}

/** Change chat, cut down for the demo: the app's own choices (the latest chats, then a new chat with each agent), no search. */
function Picker({
  source,
  suggestion,
  onPick,
  onCancel,
}: {
  source: Pick<SuggestionSource, "items" | "agents">;
  suggestion: Suggestion;
  onPick: (choice: ReturnType<typeof chatChoices>[number]) => void;
  onCancel: () => void;
}) {
  return (
    <div className="loki-suggestion-picker">
      <ul className="loki-suggestion-hits">
        {chatChoices(source, "", suggestion.target).map((c) => (
          <li key={c.key}>
            <Button size="sm" bare className="loki-suggestion-hit" onClick={() => onPick(c)}>
              <span className="loki-suggestion-hit-title">{c.title}</span>
              {c.line && <span className="loki-suggestion-hit-line">{c.line}</span>}
            </Button>
          </li>
        ))}
      </ul>
      <span>
        <Button size="sm" onClick={onCancel}>
          cancel
        </Button>
      </span>
    </div>
  );
}
