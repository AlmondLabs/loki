import { Fragment, type ReactNode } from "react";
import { ArchiveIcon, ClockIcon, ExternalLinkIcon, MailOpenIcon, MessageSquareIcon, MessageSquareShareIcon, TagIcon } from "lucide-react";
import type { JiraCardTicket, OutsideFacts } from "../../../core/frame-types.ts";
import { ToolbarGroup, ToolbarTitle, type ToolbarMove } from "../item/toolbar";
import { outsideItem, type ItemFlag, type ItemProperty, type ItemVerb } from "../item/item-view";
import { LeadRoom, Meta } from "../components";
import { keyFor } from "../shell/keymap";
import { ago, deckKey } from "./catch-up-parts";
import { CardFace } from "./card-head";
import { openExternal } from "./env";
import { senderName } from "./mail-thread";
import type { ThreadState } from "./outside-card";
import { ARCHIVE_TITLE, CAME_FROM, HANDOFF_TITLE, LATER_TITLE, MARK, READ_TITLE, disconnectedText, mendLabel, ticketAddress } from "./outside-words";

const FLAG_WORDS: Record<ItemFlag, string> = { unread: "Unread", starred: "Starred", mentions_you: "Mentions you", changed: "Changed" };

export function OutsideItemHeader({
  facts,
  unread,
  flash,
  went,
  cameBack,
  thread,
  actions,
}: {
  facts: OutsideFacts;
  unread: boolean;
  flash: string | null;
  went: string | null;
  cameBack: boolean;
  thread: ThreadState;
  actions?: ReactNode;
}) {
  const view = outsideItem({ facts, messages: thread.kind === "read" ? thread.messages : [], ticket: readHead(thread).ticket, unread });
  const who = senderName(facts.sender);
  const flags = view.header.flags.map((f): ItemProperty => ({
    key: "status",
    label: FLAG_WORDS[f],
    editable: false,
    ...(f === "unread" ? { tone: "attention" as const } : {}),
  }));
  const line = [...flags, ...view.header.properties];
  return (
    <div data-item-header className="loki-card-toolbar">
      <LeadRoom />
      <CardFace name={who} src={facts.sender_avatar ?? null} mark={MARK[facts.provider]} />
      <ToolbarTitle
        title={view.header.title}
        facts={line}
        extra={
          <OutsideHeadLine facts={facts} what={facts.provider === "slack" ? who : null} went={went} cameBack={cameBack} flash={flash} lead={line.length > 0} />
        }
      />
      {actions}
    </div>
  );
}

const VERB_WORDS: Record<ItemVerb, string> = {
  archive: "Archive",
  mark_read: "Mark as Read",
  later: "Later",
  label: "Label",
  handoff: "Hand Off",
  open: "Open Chat",
  open_out: "Open in Jira",
};

const VERB_ICONS: Record<ItemVerb, ReactNode> = {
  archive: <ArchiveIcon aria-hidden />,
  mark_read: <MailOpenIcon aria-hidden />,
  later: <ClockIcon aria-hidden />,
  label: <TagIcon aria-hidden />,
  handoff: <MessageSquareShareIcon aria-hidden />,
  open: <MessageSquareIcon aria-hidden />,
  open_out: <ExternalLinkIcon aria-hidden />,
};

interface VerbControl {
  run: () => void;
  keys?: string;
  title?: string;
  disabled?: boolean;
}

export function OutsideItemActions({
  facts,
  thread,
  typing,
  moves,
  onHandoff,
  onSignIn,
  picking,
  off = false,
}: {
  facts: OutsideFacts;
  thread: ThreadState;
  typing: boolean;
  moves: OutsideMoveHandlers;
  onHandoff?: () => void;
  onSignIn?: () => void;
  picking: boolean;
  off?: boolean;
}) {
  const { link } = readHead(thread);
  const view = outsideItem({ facts, messages: [], unread: false });
  const address = ticketAddress(facts, link);
  const waits = !!facts.disconnected || picking;
  const archiveTitle = ARCHIVE_TITLE[facts.provider];
  const verbs: Partial<Record<ItemVerb, VerbControl>> = {
    mark_read: { run: moves.read, keys: deckKey("flow.next", typing), title: READ_TITLE[facts.provider] },
    later: { run: moves.later, keys: deckKey("flow.later", typing), title: LATER_TITLE[facts.provider] },
  };
  if (archiveTitle) verbs.archive = { run: moves.archive, keys: deckKey("flow.archive", typing), title: archiveTitle };
  if (facts.provider === "gmail")
    verbs.label = {
      run: moves.label,
      keys: typing ? undefined : keyFor("flow.label"),
      disabled: waits,
      title: "Add a Gmail label to the thread; the card stays",
    };
  if (onHandoff)
    verbs.handoff = {
      run: onHandoff,
      disabled: waits,
      title: facts.disconnected
        ? `Cannot hand off now: ${disconnectedText(facts.disconnected, facts.provider)}`
        : HANDOFF_TITLE[facts.provider](facts.owner_name ?? "its agent"),
    };
  if (address) verbs.open_out = { run: () => openExternal(address), title: address };
  const prominent: ItemVerb = verbs.archive ? "archive" : view.actions.main;
  const order = [...new Set([...view.actions.more, view.actions.main])].filter((v) => v !== prominent).concat(prominent);
  const items = order.flatMap((v): ToolbarMove[] => {
    const c = verbs[v];
    if (!c) return [];
    const word = VERB_WORDS[v];
    return [
      {
        label: word,
        icon: VERB_ICONS[v],
        title: c.keys ? `${c.title ?? word} (${c.keys})` : (c.title ?? word),
        disabled: off || c.disabled,
        prominent: v === prominent,
        run: c.run,
      },
    ];
  });
  const mend = facts.disconnected ? mendLabel(facts.disconnected, facts.provider) : null;
  return (
    <>
      {mend && onSignIn && <ToolbarGroup label="Account" moves={[{ label: mend, title: "Open Preferences › Accounts", disabled: off, run: onSignIn }]} />}
      <ToolbarGroup label="Card actions" moves={items} />
    </>
  );
}

function OutsideHeadLine({
  facts,
  what,
  went,
  cameBack,
  flash,
  lead,
}: {
  facts: OutsideFacts;
  what: string | null;
  went: string | null;
  cameBack: boolean;
  flash: string | null;
  lead: boolean;
}) {
  const parts = [
    what && (
      <span key="what" className="loki-card-head-what" title={what}>
        {what}
      </span>
    ),
    <Meta key="when">{ago(facts.newest_at)}</Meta>,
    facts.only_account !== true && (
      <Meta key="in" title={CAME_FROM[facts.provider]}>
        in {facts.account_label}
      </Meta>
    ),
    went && <Meta key="went">{went}</Meta>,
    cameBack && <Meta key="back">back · new since you moved on</Meta>,
    flash && (
      <Meta key="flash" style={{ color: "var(--loki-fg)", fontWeight: 600 }}>
        {flash}
      </Meta>
    ),
  ].filter(Boolean);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {(i > 0 || lead) && " · "}
      {part}
    </Fragment>
  ));
}

export interface OutsideMoveHandlers {
  read: () => void;
  later: () => void;
  archive: () => void;
  label: () => void;
}

const readHead = (thread: ThreadState): { link: string | null; ticket: JiraCardTicket | null } =>
  thread.kind === "read" ? { link: thread.link ?? null, ticket: thread.ticket ?? null } : { link: null, ticket: null };
