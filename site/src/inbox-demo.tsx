import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { CatchUp } from "../../app/src/desk/catch-up";
import { resolve, runAction } from "../../app/src/shell/keymap";
import type { SuggestionSource } from "../../app/src/chat/suggestion-card";
import { DEMO_AGENTS, DemoChats } from "./demo-chats";

/** A demo move always goes: there is no account out there to refuse it. */
const MOVED = { error: null, ask: false, rest: null };

/**
 * The Inbox section's live deck: loki's own Inbox (`CatchUp`) over the made-up chats of demo-chats.ts. Keys work
 * while the deck has focus, through the app's own keymap, so arrows and letters do not steal the page's scrolling.
 */
export function InboxDemo() {
  const [chats] = useState(() => new DemoChats());
  useEffect(() => () => chats.dispose(), [chats]);
  const items = useSyncExternalStore(chats.subscribe, chats.items);
  const all = useSyncExternalStore(chats.subscribe, chats.chats);
  /** Each card's last move, so undo takes back exactly it. */
  const [lastMove] = useState(() => new Map<string, "read" | "later" | "archive">());
  /** Bumped by "start over", so the deck opens a fresh visit over the reset chats. */
  const [visit, setVisit] = useState(0);
  const source = useMemo((): Parameters<typeof CatchUp>[0]["chats"] => {
    const suggestions: Omit<SuggestionSource, "conversation"> = {
      // Every chat, not only the Inbox's: a suggestion's chat may be mid-answer.
      items: all,
      agents: DEMO_AGENTS,
      listed: true,
      agentsLoaded: true,
      suggestions: { decide: chats.decideSuggestion, retarget: chats.retargetSuggestion },
    };
    return { ...suggestions, conversation: chats.conversation, watchThreads: chats.watchThreads, threadRows: chats.threadRows };
  }, [chats, all]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The keymap leaves plain letters and arrows to a focused reply box, as in the app.
    const binding = resolve(e.nativeEvent, "inbox");
    if (binding && runAction(binding.id)) e.preventDefault();
  };

  const startOver = () => {
    chats.reset();
    setVisit((v) => v + 1);
  };

  return (
    <div className="site-window site-inbox" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="site-window-bar" aria-hidden>
        <span />
        <span />
        <span />
        <em>Flow · {items.length} waiting</em>
      </div>
      <div className="site-inbox-deck">
        <CatchUp
          key={visit}
          open
          onClose={startOver}
          items={items}
          chats={source}
          loadHistory={() => {}}
          onRead={(item) => (chats.seen(item.id), lastMove.set(item.id, "read"), Promise.resolve(MOVED))}
          onLater={(item) => (lastMove.set(item.id, "later"), Promise.resolve(MOVED))}
          laterAsks={() => false}
          onArchive={(item) => {
            chats.archive(item.id);
            lastMove.set(item.id, "archive");
            return Promise.resolve(null);
          }}
          onLabel={() => Promise.resolve(null)}
          onUndo={(item) => {
            const move = lastMove.get(item.id);
            if (move === "read") chats.unread(item.id);
            else if (move === "archive") chats.unarchive(item.id);
            lastMove.delete(item.id);
            return Promise.resolve(null);
          }}
          onSeen={(item) => chats.seen(item.id)}
          onUnread={(item) => chats.unread(item.id)}
          onApprove={(item, _requestId, behavior) => chats.decide(item.id, behavior !== "deny")}
          onReply={(item, text) => chats.reply(item.id, text)}
          onAnswer={(item, _requestId, answers) => chats.answer(item.id, answers)}
          onOpenDesk={() => {}}
        />
      </div>
      <button type="button" className="site-start-over" onClick={startOver}>
        start over
      </button>
    </div>
  );
}
