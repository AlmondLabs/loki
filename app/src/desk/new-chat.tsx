import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PaneHeader, Popover } from "../components";
import { Conversation, type ConversationView } from "../chat/conversation";
import type { Draft } from "../shared/drafts";
import { useHeightVar } from "../shared/use-height-var";
import { ToolbarTitle } from "../item/toolbar";
import { PopoverMenu } from "../shell/menu-items";
import { popUpMenu, under, useNativeMenus, type MenuEntry } from "../shell/native-menu";
import { osWords } from "../shell/os-words";
import type { Attachment } from "../../../core/attention/content.ts";
import { messageOf } from "../../../core/errors.ts";
import type { Pushes } from "../../../core/frames.ts";
import { AgentFace } from "./agent-chip";
import { FolderPicker, folderLabel, useChatHome, useFolderField, type FolderApi, type NewChatAgent } from "./new-desk";

/** A chat not started yet has an empty thread that says nothing, and no agent at work. */
const UNSENT: ConversationView = { rows: [], status: "idle", blank: true };
const NO_DRAFT: Draft = { text: "", images: [] };
/** How long a run of typed letters on the To: token counts as one name being spelled. */
const TYPE_AHEAD_MS = 700;

/** What `NewChat` needs: who it can be for, where its folder comes from, and how the first message starts it. */
export interface NewChatProps {
  agents: NewChatAgent[];
  /** Where an agent's face is served (env.ts `avatarUrl`). */
  avatar: (agentId: string) => string | null;
  /** The agent the To: line starts on: the one asked for, else the open chat's. */
  defaultAgentId: string | null;
  /** The chat this opened from: its folder is the default for that same agent, as in the New chat dialog. */
  currentAgentId: string | null;
  currentConversationKey: string | null;
  folders: FolderApi;
  /** This Mac and the Macs paired with it (plan 023): a chat starts on its agent's home Mac while that is in reach. */
  macs?: Pushes["peers"] | null;
  requirements?: (agentId: string, home?: string) => Promise<string[]>;
  /** The first message: creates the chat in the folder (empty for the agent's own default) and sends it. */
  onStart: (start: { agentId: string; folder: string; home?: string; text: string; images: Attachment[] }) => Promise<void>;
  /** Esc in the empty box: the new chat goes, and nothing was made. */
  onClose: () => void;
  /** Bumped to put the caret in the message box (⌘N again). */
  focusTick: number;
}

/**
 * ⌘N under Liquid Glass (plan 2026-11-12-1505, U20): an empty chat in place of the open one, as Messages opens a new
 * message. A To: line holds the agent, with the folder the chat will work in at its trailing edge; both default as
 * the New chat dialog's did. Nothing is created until the first message is sent, so leaving it leaves nothing behind.
 */
export function NewChat({
  agents,
  avatar,
  defaultAgentId,
  currentAgentId,
  currentConversationKey,
  folders,
  macs,
  requirements,
  onStart,
  onClose,
  focusTick,
}: NewChatProps) {
  const [picked, setPicked] = useState<string | null>(defaultAgentId);
  // The agent picked may be deleted meanwhile, and the list may arrive after the pane: fall back to the first there is.
  const agent = agents.find((a) => a.id === picked) ?? agents.at(0) ?? null;
  const agentId = agent?.id ?? null;
  const where = useChatHome(agents, agentId, macs, requirements);
  const field = useFolderField({ folders, agentId, currentAgentId, currentConversationKey, home: where.remote?.mac_id });
  const [draft, setDraft] = useState<Draft>(NO_DRAFT);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folder = field.folder.trim();
  // A folder that was checked and is not usable stops the send; one not checked yet goes, and the daemon has the last word.
  const badFolder = folder && field.status?.ok === false ? (field.status.reason ?? "that folder cannot be used") : null;
  const send = (text: string, images: Attachment[] = []) => {
    if (!agentId || starting) return;
    if (badFolder) {
      setDraft({ text, images });
      return setError(`${folderLabel(folder)}: ${badFolder}`);
    }
    setStarting(true);
    setError(null);
    onStart({ agentId, folder, home: where.home, text, images }).catch((err: unknown) => {
      // The message comes back to the box for another try.
      setDraft({ text, images });
      setError(messageOf(err));
      setStarting(false);
    });
  };

  // The header floats over the thread, which pads itself by its height, as the chat pane's does.
  const paneRef = useRef<HTMLDivElement>(null);
  const header = useCallback(() => paneRef.current?.querySelector<HTMLElement>(":scope > .loki-pane-header") ?? null, []);
  useHeightVar(header, "--loki-header-height");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const lacks = where.lacks.length > 0 ? `${where.remote ? where.remote.name : osWords().Machine} needs ${where.lacks.join("; ")}` : null;

  return (
    <div className="loki-desk-pane loki-new-chat" ref={paneRef}>
      <PaneHeader
        title="New Chat"
        line={<ToolbarTitle title="New Chat" facts={[]} titleAs="h1" />}
        subtitle={
          <ToLine
            agents={agents}
            avatar={avatar}
            agent={agent}
            onPick={(id) => {
              setPicked(id);
              boxRef.current?.focus();
            }}
            field={field}
            lives={where.remote?.name ?? null}
            onDone={() => boxRef.current?.focus()}
          />
        }
      />
      <div className="loki-desk-pane-body">
        <div className="loki-desk-pane-panel loki-desk-pane-messages" role="region" aria-label="New chat">
          <Conversation
            view={UNSENT}
            actions={{ onSend: send }}
            agentName={agent?.name ?? null}
            inputRef={boxRef}
            draft={{ value: draft, onChange: setDraft }}
            focusTick={focusTick}
            onEscapeEmpty={onClose}
            dim={false}
            notice={
              (error ?? lacks) && (
                <div className="loki-meta loki-meta--negative loki-meta--wrap loki-new-chat-notice" role="status">
                  {error ?? lacks}
                </div>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The To: line: the agent as a token that opens a menu of agents (the Mac's own menu in the app), or changes as a name
 * is typed on it; and, at the trailing edge, the folder the chat will work in, which opens the folder field.
 */
function ToLine({
  agents,
  avatar,
  agent,
  onPick,
  field,
  lives,
  onDone,
}: {
  agents: NewChatAgent[];
  avatar: (agentId: string) => string | null;
  agent: NewChatAgent | null;
  onPick: (agentId: string) => void;
  field: ReturnType<typeof useFolderField>;
  /** The other Mac the chat will live on, when its agent lives there and it is in reach. */
  lives: string | null;
  /** The folder was chosen: focus goes back to the message box. */
  onDone: () => void;
}) {
  const native = useNativeMenus();
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const typed = useRef({ text: "", at: 0 });
  const entries: MenuEntry[] = agents.map((a) => ({ type: "item", id: a.id, label: a.name, checked: a.id === agent?.id, run: () => onPick(a.id) }));

  /** A letter typed on the token spells an agent's name, as a pop-up button selects by typing. */
  const typeAhead = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      return e.currentTarget.click();
    }
    if (e.key.length !== 1 || e.key === " " || e.metaKey || e.ctrlKey || e.altKey) return;
    const now = e.timeStamp;
    const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + e.key.toLowerCase();
    typed.current = { text, at: now };
    const hit = agents.find((a) => a.name.toLowerCase().startsWith(text));
    if (hit && hit.id !== agent?.id) onPick(hit.id);
    e.preventDefault();
  };

  const folder = field.folder.trim();
  const folderFailed = !!folder && field.status?.ok === false;
  return (
    <div className="loki-new-chat-to">
      <span className="loki-new-chat-to-label" id="loki-new-chat-to">
        To:
      </span>
      <span className="loki-new-chat-anchor">
        <button
          type="button"
          className="loki-new-chat-token"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-describedby="loki-new-chat-to"
          title="Choose Agent"
          disabled={agents.length === 0}
          onKeyDown={typeAhead}
          onClick={(e) => {
            if (native) void popUpMenu(entries, under(e.currentTarget)).catch((err: unknown) => console.warn("loki: agent menu", err));
            else setMenuOpen((v) => !v);
          }}
        >
          {agent && <AgentFace name={agent.name} src={avatar(agent.id)} size={16} />}
          <span>{agent?.name ?? "No Agents"}</span>
        </button>
        {menuOpen && <PopoverMenu label="Agents" entries={entries} onClose={() => setMenuOpen(false)} anchor="left" width={220} />}
      </span>
      <span className="loki-new-chat-spacer" />
      <span className="loki-new-chat-anchor">
        <button
          type="button"
          className="loki-new-chat-folder"
          data-failed={folderFailed || undefined}
          aria-haspopup="dialog"
          aria-expanded={folderOpen}
          title={folder ? `Folder: ${folder}${lives ? `, on ${lives}` : ""}` : "Choose Folder"}
          onClick={() => setFolderOpen((v) => !v)}
        >
          {folder ? folderLabel(folder) : "Choose Folder…"}
          {lives ? ` · ${lives}` : ""}
        </button>
        {folderOpen && (
          <FolderPopover
            field={field}
            agentName={agent?.name ?? null}
            onClose={(chosen) => {
              setFolderOpen(false);
              if (chosen) onDone();
            }}
          />
        )}
      </span>
    </div>
  );
}

/**
 * The folder field hung from the To: line's folder: the same field, list, check and Browse as the New chat dialog,
 * dimming nothing. Return (with its list closed) keeps the folder and goes back to the message; Esc or a press outside
 * closes it.
 */
function FolderPopover({
  field,
  agentName,
  onClose,
}: {
  field: ReturnType<typeof useFolderField>;
  agentName: string | null;
  onClose: (chosen: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const input = field.inputRef;
  useEffect(() => {
    const wrapper = ref.current?.parentElement ?? null;
    input.current?.select();
    const away = (e: PointerEvent) => {
      if (!wrapper?.contains(e.target as Node)) closeRef.current(false);
    };
    // capture phase: the sidebar and other popovers stop pointerdown from bubbling, and a press there must still close it
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [input]);
  return (
    <Popover
      ref={ref}
      role="dialog"
      aria-label="Folder for the new chat"
      anchor="right"
      width={440}
      style={{ padding: 12, right: 0, maxWidth: "none", overflow: "visible" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (field.listOpen) field.setListOpen(false);
          else onClose(false);
        } else if (e.key === "Enter" && !field.listOpen) {
          e.preventDefault();
          onClose(true);
        }
      }}
    >
      <FolderPicker
        inputRef={field.inputRef}
        folder={field.folder}
        onType={field.type}
        onChoose={field.choose}
        status={field.status}
        options={field.options}
        listOpen={field.listOpen}
        setListOpen={field.setListOpen}
        busy={field.picking ? "picking" : false}
        onBrowse={() => void field.browse()}
        agentName={agentName}
        source={field.source}
        canBrowse={field.ready || field.touched}
        browser={field.browser}
      />
    </Popover>
  );
}
