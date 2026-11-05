import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Inbox, useDeck, type InboxMoves } from "../../app/src/phone/inbox";
import type { MoveResult } from "../../core/attention/use-attention.ts";
import type { SuggestionSource } from "../../app/src/chat/suggestion-card";
import "../../app/src/phone/phone.css";
import { DEMO_AGENTS, DemoChats } from "./demo-chats";

/** The phone at full size: a current iPhone's 393 × 852 point screen in its bezel. */
const PHONE = { w: 393 + 22, h: 852 + 22 };
/** Room the page keeps above and below the phone: the sticky bar and a margin. */
const PAGE_ROOM = 120;
/** Smaller than this the phone's words stop being readable, so a short window scrolls instead. */
const MIN_SCALE = 0.62;

/**
 * The phone section's live demo: loki's own phone Inbox, in a phone's outline, over its own copy of the made-up
 * chats. Swipe a card right to read and left for later, or use its buttons; replies and answers stream back as on
 * the desktop's deck. The outline is transformed, so the phone's fixed layers stay inside it instead of the page.
 */
export function PhoneDemo() {
  const [chats] = useState(() => new DemoChats());
  useEffect(() => () => chats.dispose(), [chats]);
  const items = useSyncExternalStore(chats.subscribe, chats.items);
  const all = useSyncExternalStore(chats.subscribe, chats.chats);
  const deck = useDeck(items);
  const suggestions: SuggestionSource = {
    conversation: chats.conversation,
    items: all,
    agents: DEMO_AGENTS,
    listed: true,
    agentsLoaded: true,
    suggestions: { decide: chats.decideSuggestion, retarget: chats.retargetSuggestion },
  };
  // The made-up chats' moves: Read marks a chat read, Later leaves it for this visit, Archive archives, and Undo takes
  // back whichever it was. Nothing rests and nothing is out there, so Later never asks and there are no labels.
  const [taken] = useState(() => new Map<string, "read" | "later" | "archive">());
  const moved: MoveResult = { error: null, ask: false, rest: null };
  const moves: InboxMoves = {
    read: (item) => (chats.seen(item.id), taken.set(item.id, "read"), Promise.resolve(moved)),
    later: (item) => (taken.set(item.id, "later"), Promise.resolve(moved)),
    archive: (item) => (chats.archive(item.id), taken.set(item.id, "archive"), Promise.resolve(null)),
    undo: (item) => {
      const was = taken.get(item.id);
      if (was === "read") chats.unread(item.id);
      if (was === "archive") chats.unarchive(item.id);
      taken.delete(item.id);
      return Promise.resolve(null);
    },
    laterAsks: () => false,
    label: () => Promise.resolve("the demo has no labels"),
    labelsOf: () => Promise.resolve([]),
  };
  const startOver = () => {
    chats.reset();
    deck.again();
  };
  // The phone lays out at its real size and is scaled down as a whole to fit the column and the window, so the
  // app inside always has a phone's width to work with.
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.max(MIN_SCALE, Math.min(1, el.clientWidth / PHONE.w, (window.innerHeight - PAGE_ROOM) / PHONE.h)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  return (
    <div ref={box} className="site-phone-fit" style={{ height: PHONE.h * scale }}>
      <div className="site-phone" style={{ transform: `scale(${scale})` }}>
        <div className="site-phone-screen loki-phone">
          <div className="site-phone-status" aria-hidden>
            <span>9:41</span>
            <span className="site-phone-island" />
            <span className="site-phone-icons">
              <i />
              <i />
            </span>
          </div>
          <Inbox
            items={items}
            loaded
            available
            chats={chats}
            deck={deck}
            backLabel="the start"
            onClose={startOver}
            onOpen={() => {}}
            onConnection={() => {}}
            onApprove={(item, _requestId, behavior) => chats.decide(item.id, behavior !== "deny")}
            moves={moves}
            onNote={() => {}}
            card={{
              onSend: (item, text) => chats.reply(item.id, text),
              onAnswer: (item, _requestId, answers) => chats.answer(item.id, answers),
              onCancelQueued: () => {},
              suggestions: { source: suggestions },
            }}
          />
          <div className="site-phone-home" aria-hidden />
        </div>
      </div>
    </div>
  );
}
