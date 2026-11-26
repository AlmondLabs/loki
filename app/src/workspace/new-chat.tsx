import { cloneElement, useCallback, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { PaneHeader, Popover } from "../components";
import { Conversation, type ConversationView } from "../chat/conversation";
import type { Draft } from "../shared/drafts";
import { useHeightVar } from "../shared/use-height-var";
import { ToolbarTitle } from "../item/toolbar";
import { DrawnMenu } from "../shell/menu-items";
import { popUpMenu, under, NATIVE_MENUS, type MenuEntry } from "../shell/native-menu";
import { osWords } from "../shell/os-words";
import type { Attachment } from "../../../core/attention/content.ts";
import { messageOf } from "../../../core/errors.ts";
import type { Pushes } from "../../../core/frames.ts";
import { AgentFace } from "./agent-chip";
import { FolderPicker, folderLabel, useChatHome, useFolderField, type FolderApi, type NewChatAgent } from "./new-workspace";

const UNSENT: ConversationView = { rows: [], status: "idle", blank: true };
const NO_DRAFT: Draft = { text: "", images: [] };
const TYPE_AHEAD_MS = 700;

export interface NewChatProps {
  agents: NewChatAgent[];
  avatar: (agentId: string) => string | null;
  defaultAgentId: string | null;
  currentAgentId: string | null;
  currentConversationKey: string | null;
  folders: FolderApi;
  macs?: Pushes["peers"] | null;
  requirements?: (agentId: string, home?: string) => Promise<string[]>;
  onStart: (start: { agentId: string; folder: string; home?: string; text: string; images: Attachment[] }) => Promise<void>;
  onClose: () => void;
  focusTick: number;
}

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
  const agent = agents.find((a) => a.id === picked) ?? agents.at(0) ?? null;
  const agentId = agent?.id ?? null;
  const where = useChatHome(agents, agentId, macs, requirements);
  const field = useFolderField({ folders, agentId, currentAgentId, currentConversationKey, home: where.remote?.mac_id });
  const [draft, setDraft] = useState<Draft>(NO_DRAFT);
  const starting = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const folder = field.folder.trim();
  const badFolder = folder && field.status?.ok === false ? (field.status.reason ?? "that folder cannot be used") : null;
  const send = (text: string, images: Attachment[] = []) => {
    if (!agentId || starting.current) return;
    if (badFolder) {
      setDraft({ text, images });
      return setError(`${folderLabel(folder)}: ${badFolder}`);
    }
    starting.current = true;
    setError(null);
    onStart({ agentId, folder, home: where.home, text, images }).catch((err: unknown) => {
      setDraft({ text, images });
      setError(messageOf(err));
      starting.current = false;
    });
  };

  const paneRef = useRef<HTMLDivElement>(null);
  const header = useCallback(() => paneRef.current?.querySelector<HTMLElement>(":scope > .loki-pane-header") ?? null, []);
  useHeightVar(header, "--loki-header-height");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const lacks = where.lacks.length > 0 ? `${where.remote ? where.remote.name : osWords().Machine} needs ${where.lacks.join("; ")}` : null;

  return (
    <div className="loki-canvas-pane loki-new-chat" ref={paneRef}>
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
      <div className="loki-canvas-pane-body">
        <div className="loki-canvas-pane-panel loki-canvas-pane-messages" role="region" aria-label="New chat">
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
  lives: string | null;
  onDone: () => void;
}) {
  const native = NATIVE_MENUS;
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const typed = useRef({ text: "", at: 0 });
  const entries: MenuEntry[] = agents.map((a) => ({ type: "item", id: a.id, label: a.name, checked: a.id === agent?.id, run: () => onPick(a.id) }));

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

  const token = (
    <button
      type="button"
      className="loki-new-chat-token"
      aria-haspopup="menu"
      aria-describedby="loki-new-chat-to"
      title="Choose Agent"
      disabled={agents.length === 0}
      onKeyDown={typeAhead}
    >
      {agent && <AgentFace name={agent.name} src={avatar(agent.id)} size={16} />}
      <span>{agent?.name ?? "No Agents"}</span>
    </button>
  );
  const folder = field.folder.trim();
  const folderFailed = !!folder && field.status?.ok === false;
  return (
    <div className="loki-new-chat-to">
      <span className="loki-new-chat-to-label" id="loki-new-chat-to">
        To:
      </span>
      <span className="loki-new-chat-anchor">
        {native ? (
          cloneElement(token, {
            onClick: (e: MouseEvent<HTMLButtonElement>) =>
              void popUpMenu(entries, under(e.currentTarget)).catch((err: unknown) => console.warn("loki: agent menu", err)),
          })
        ) : (
          <DrawnMenu label="Agents" entries={entries} open={menuOpen} onOpenChange={setMenuOpen} trigger={token} anchor="left" width={220} />
        )}
      </span>
      <span className="loki-new-chat-spacer" />
      <span className="loki-new-chat-anchor">
        <FolderPopover
          field={field}
          agentName={agent?.name ?? null}
          open={folderOpen}
          onOpenChange={setFolderOpen}
          onChosen={onDone}
          trigger={
            <button
              type="button"
              className="loki-new-chat-folder"
              data-failed={folderFailed || undefined}
              title={folder ? `Folder: ${folder}${lives ? `, on ${lives}` : ""}` : "Choose Folder"}
            >
              {folder ? folderLabel(folder) : "Choose Folder…"}
              {lives ? ` · ${lives}` : ""}
            </button>
          }
        />
      </span>
    </div>
  );
}

function FolderPopover({
  field,
  agentName,
  trigger,
  open,
  onOpenChange,
  onChosen,
}: {
  field: ReturnType<typeof useFolderField>;
  agentName: string | null;
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChosen: () => void;
}) {
  const input = field.inputRef;
  return (
    <Popover
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      role="dialog"
      aria-label="Folder for the new chat"
      anchor="right"
      width={440}
      initialFocus={() => {
        input.current?.select();
        return input.current;
      }}
      style={{ padding: 12, maxWidth: "none", overflow: "visible" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && field.listOpen) {
          e.preventDefault();
          e.stopPropagation();
          field.setListOpen(false);
        } else if (e.key === "Enter" && !field.listOpen) {
          e.preventDefault();
          onOpenChange(false);
          onChosen();
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
