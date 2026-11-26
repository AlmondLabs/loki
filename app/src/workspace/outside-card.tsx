import type { ReactNode, RefObject } from "react";
import type { AccountDisconnectCause, MailCompose, OutsideFacts } from "../../../core/frame-types.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { Meta, sentence } from "../components";
import { MAIL_INDENT } from "./mail-thread";
import { OutsideItemActions, OutsideItemHeader, type OutsideMoveHandlers } from "./outside-toolbar";
import { disconnectedText } from "./outside-words";
import { DeckReply, type ReplyBoxControl } from "./outside-reply";
import { OutsideThread } from "./outside-thread";
import { useOutsideThread, type OutsideThreadSource } from "./use-outside-thread";

export { OutsideReply, replyBoxKey, type ReplyBoxControl } from "./outside-reply";
export { OutsideLines, OutsideThread } from "./outside-thread";
export {
  prefetchOutside,
  quoteOf,
  refreshAsk,
  threadSourceOf,
  ticketAsk,
  useMailCompose,
  useOutsideThread,
  wentTo,
  withLoaded,
  withNewer,
  type OutsideThreadSource,
  type Shown,
  type ThreadControls,
  type ThreadState,
} from "./use-outside-thread";

function ownAddresses(facts: OutsideFacts, compose: MailCompose | null): string[] {
  if (facts.provider !== "gmail") return [];
  return [facts.account_id.replace(/^gmail:/, ""), ...(compose?.from.map((f) => f.address) ?? [])];
}

function Disconnected({ facts, cause }: { facts: OutsideFacts; cause: AccountDisconnectCause }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Meta negative wrap>
        {sentence(disconnectedText(cause, facts.provider))}
      </Meta>
    </div>
  );
}

export function OutsideCard({
  current,
  facts,
  flash,
  cameBack,
  typing,
  moves,
  went = null,
  onHandoff,
  onSignIn,
  picker = null,
  source = null,
  box,
  replyRef,
  onTyping,
  onEscapeEmpty,
  compose = null,
  off = false,
}: {
  current: AttentionItem;
  facts: OutsideFacts;
  flash: string | null;
  cameBack: boolean;
  typing: boolean;
  moves: OutsideMoveHandlers;
  went?: string | null;
  onHandoff?: () => void;
  onSignIn?: () => void;
  picker?: ReactNode;
  source?: OutsideThreadSource | null;
  box?: ReplyBoxControl;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  compose?: MailCompose | null;
  off?: boolean;
}) {
  const thread = useOutsideThread(current, source, box?.onThread ? { opened: box.thread ?? null, setOpened: box.onThread } : undefined);
  const actions = (
    <OutsideItemActions facts={facts} thread={thread} typing={typing} moves={moves} onHandoff={onHandoff} onSignIn={onSignIn} picking={!!picker} off={off} />
  );
  const mailBox = facts.provider === "gmail" && !!box;
  const own = ownAddresses(facts, compose);
  const reply = box ? (
    <DeckReply
      current={current}
      facts={facts}
      thread={thread}
      source={source}
      box={box}
      replyRef={replyRef}
      onTyping={onTyping}
      onEscapeEmpty={onEscapeEmpty}
      compose={compose}
      items
    />
  ) : null;
  return (
    <div className="flex flex-1 flex-col" style={{ minHeight: 0 }}>
      <OutsideItemHeader facts={facts} unread={current.unread} flash={flash} went={went} cameBack={cameBack} thread={thread} actions={actions} />
      <div data-thread-scroll className="flex-1" style={{ minHeight: 0, overflow: "auto" }}>
        <div className="mx-auto w-full max-w-3xl" style={{ padding: facts.provider === "slack" ? "8px 20px 16px" : "16px 20px" }}>
          {facts.disconnected && <Disconnected facts={facts} cause={facts.disconnected} />}
          <OutsideThread facts={facts} state={thread} own={own} items />
          {mailBox && <div style={{ marginLeft: MAIL_INDENT, marginTop: 16 }}>{reply}</div>}
        </div>
      </div>
      {picker && <div className="loki-card-picker">{picker}</div>}
      {reply && !mailBox && (
        <div className="mx-auto w-full max-w-3xl" style={{ padding: "12px 20px 16px" }}>
          {reply}
        </div>
      )}
    </div>
  );
}
