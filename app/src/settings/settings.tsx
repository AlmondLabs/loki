import { AlwaysAllowed, Mcp, type McpApi } from "./mcp";
import { ChatLinks, type ChatLinksApi } from "./chat-links";
import { Engines, type EnginesApi } from "./engines";
import { Labels, type LabelsApi } from "./labels";
import { Lanes, type LaneAccountsApi, type LanesApi, type LanesProps } from "./lanes";
import { Accounts, type AccountsApi, type AgentName } from "./accounts";
import { useEffect, useState, type ReactNode } from "react";
import { inTauri, keyboard, modBase, notYetOn, platform, systemName, type Platform } from "../desk/env";
import { formatKeys, keyFor, keyRows, registerActions, takenBy, wasFor } from "../shell/keymap";
import { lokiUpgrade, osWords, runsOn } from "../shell/os-words";
import { Dot, Field, IconButton, Kbd, Sheet, Switch, TabRow, sentence } from "../components";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/chat-window";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { ProviderSettings } from "./providers";
import { Phone, type PhoneApi } from "./phone";
import { Macs, type MacsApi } from "./macs";
import { Skills, type GlobalSkillsApi } from "./skills";
import type { DaemonStatus } from "../shell/bootstrap";
import { useHarnessFacts, type InstallReport } from "../shell/use-harness-facts";
import type { LokiUpdate } from "../shell/use-loki-update";
import type { GlobalShortcut } from "../shell/use-global-shortcut";
import type { Recall as RecallModel } from "../shell/use-recall";
import { RecallSettings } from "../recall/recall-parts";
import { BLOCKED_POINTS, FOCUS_POINTS, NEW_POINTS } from "../../../core/attention/priority.ts";
import { FOCUS_HALF_LIFE_H } from "../../../core/attention/focus.ts";
import { REST_GROWTH, laterOf, type CardKind, type RestFirst, type RestLater, type ReturnTimes } from "../../../core/attention/rest.ts";

/** Preferences › Inbox's return times, kept by the mod (plan 070): what they are now, and new ones. */
export interface ReturnTimesApi {
  times: ReturnTimes;
  set: (times: ReturnTimes) => void;
}
import { PAGES, SETTINGS_PAGE_KEY, groupOf, pageTitle, savedPage, type SettingsPage } from "./pages";
import { PageList } from "./page-list";
import { Block, Fact, Fold, Segmented, Setting } from "./layout";
import type { UsageApi } from "../shared/use-usage";
import { UsagePage } from "./usage";
import { THEME_PREFERENCES, useTheme } from "../theme";
import { XIcon } from "lucide-react";
import { Glyph } from "../shared/icons";
import { cn } from "@/lib/utils";

/** The chat panel's widths at the side, narrow first. */
const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "wide"];

const HOME = "~/.loki";

const PAGE_KEY = SETTINGS_PAGE_KEY;

/** The daemon's chat link (useAttention's status, "off" shown as connecting). */
type ChatLink = "connecting" | "open" | "closed";
type ModConnection = "connecting" | "open" | "closed";

/** Everything Settings takes: what the shell or the Settings window hands it. */
export type SettingsProps = Parameters<typeof Settings>[0];

/**
 * Preferences, Slack style: Settings in a large sheet over the section you were in (KTD11). It is marked
 * data-preferences so the shell's keys still reach ⌘, ⌘1-6 and the page steps while it is up; Esc, the
 * veil and the close button shut it.
 */
export function Preferences({ onClose, ...rest }: Omit<SettingsProps, "onClose"> & { onClose: () => void }) {
  return (
    <Sheet
      label="Preferences"
      onClose={onClose}
      width="min(1000px, 92vw)"
      height="min(720px, 88vh)"
      top="max(16px, calc((100vh - min(720px, 88vh)) / 2))"
      cardProps={{ "data-preferences": "" }}
    >
      <Settings {...rest} onClose={onClose} />
    </Sheet>
  );
}

/**
 * Settings: the facts that had no home — what loki runs on, how it reaches
 * the mod, where the files are — a couple of preferences, and the keymap. Laid out as Preferences' body:
 * the section list on the left, the page on the right, filling whatever holds it.
 */
export function Settings({
  chatLink,
  modConnection,
  deskCount,
  chatWidth,
  onChatWidth,
  chatPlacement,
  onChatPlacement,
  providers,
  onLoadProviders,
  onConnectProvider,
  onDisconnectProvider,
  onModelsChanged,
  daemon,
  phone,
  macs,
  globalSkills,
  mcp,
  accounts,
  agents,
  engines,
  links,
  labels,
  update,
  shortcut,
  recall,
  usage,
  returnTimes,
  lanes,
  onClose,
  windowed = false,
  initialPage = null,
}: {
  chatLink: ChatLink;
  modConnection: ModConnection;
  deskCount: number;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  onChatPlacement: (p: ChatPlacement) => void;
  providers: ConnectProvider[] | null;
  onLoadProviders: () => Promise<unknown>;
  onConnectProvider: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnectProvider: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
  /** loki's daemon as the shell sees it: the Node it runs on, or why it could not start (null in a browser tab). */
  daemon: DaemonStatus | null;
  /** The LAN listener and paired phones (useDesk().phone). */
  phone: PhoneApi;
  /** This Mac and the Macs paired with it (useDesk().macs, plan 023). */
  macs: MacsApi;
  /** ~/.agents/skills, which every agent reads (Preferences › Skills). */
  globalSkills: GlobalSkillsApi;
  /** Preferences › MCP servers, and Preferences › Chat's always-allowed tools (daemon/mcp/, daemon/approvals.ts). */
  mcp: McpApi;
  /** Preferences › Accounts: the Gmail mailboxes and Slack workspaces on this Mac and their owners (plan 067); every Mac's for lanes. */
  accounts: AccountsApi & LaneAccountsApi;
  /** Every agent by name, to choose an account's owner from. */
  agents: readonly AgentName[];
  /** Preferences › Engines: the ACP agents a chat can run on (daemon/acp/, plan 020). */
  engines: EnginesApi;
  /** Preferences › Chat › Chat links (plan 067); left out, the block says the daemon is not linked. */
  links?: ChatLinksApi;
  /** Preferences › Labels: the labels on chats, renamed, recoloured or deleted everywhere (plan 022). */
  labels: LabelsApi;
  /** Newer loki releases, from GitHub (Preferences › About). */
  update: LokiUpdate;
  /** ⌥Space, held or released (Preferences › Keyboard shortcuts). */
  shortcut: GlobalShortcut;
  /** The card writer's switch and knobs (Preferences › Learn). */
  recall: RecallModel;
  /** What the agents spent, and their names (Preferences › Usage). */
  usage: UsageApi;
  /** How long ⌘] and ⌘[ rest each kind of card (Preferences › Inbox). */
  returnTimes: ReturnTimesApi;
  /** The lanes the person made (Preferences › Flow, plan 087), kept by the mod and shared with every device. */
  lanes: LanesApi;
  /** The close button in the page's header (Preferences); none without it. */
  onClose?: () => void;
  /**
   * Settings is its own window (plan 2026-11-12-1505, U18): the section list sits on the window's sidebar material,
   * clear of the traffic lights, with no heading, and the page's title row drags the window.
   */
  windowed?: boolean;
  /** The page to open on, set by whoever opened the window; otherwise the one this window last showed. */
  initialPage?: string | null;
}) {
  const harness = useHarnessFacts();
  const [page, setPage] = useState<SettingsPage>(() => savedPage(initialPage ?? sessionStorage.getItem(PAGE_KEY)));
  const group = groupOf(page);
  const pick = (p: SettingsPage) => {
    setPage(p);
    sessionStorage.setItem(PAGE_KEY, p);
  };
  // ⌘[ and ⌘] step the pages (settings.prevPage / settings.nextPage in the keymap), wrapping at the ends.
  useEffect(() => {
    const step = (d: 1 | -1) => pick(PAGES[(PAGES.findIndex((p) => p.id === page) + d + PAGES.length) % PAGES.length].id);
    return registerActions({ "settings.prevPage": () => step(-1), "settings.nextPage": () => step(1) });
  });

  // Each page's body, by page: a table rather than a chain of conditions, so adding a page adds no branch here.
  const pageBody: Record<SettingsPage, () => ReactNode> = {
    loki: () => <LokiPage update={update} harness={harness} daemon={daemon} modConnection={modConnection} deskCount={deskCount} />,
    usage: () => <UsagePage usage={usage} />,
    inbox: () => <InboxPage returnTimes={returnTimes} lanes={{ lanes, accounts, agents }} />,
    accounts: () =>
      chatLink === "open" ? <Accounts api={accounts} agents={agents} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />,
    providers: () => (
      <ProvidersPage
        chatLink={chatLink}
        providers={providers}
        onLoadProviders={onLoadProviders}
        onConnectProvider={onConnectProvider}
        onDisconnectProvider={onDisconnectProvider}
        onModelsChanged={onModelsChanged}
      />
    ),
    engines: () => <EnginesPage engines={engines} chatLink={chatLink} />,
    mcp: () => <McpPage mcp={mcp} chatLink={chatLink} />,
    phone: () => <PhonePage phone={phone} modConnection={modConnection} />,
    macs: () => <Macs macs={macs} connected={modConnection === "open"} />,
    skills: () => <SkillsPage globalSkills={globalSkills} />,
    learn: () => <RecallPage recall={recall} />,
    appearance: () => <AppearancePage />,
    chat: () => (
      <ChatPage
        chatWidth={chatWidth}
        onChatWidth={onChatWidth}
        chatPlacement={chatPlacement}
        onChatPlacement={onChatPlacement}
        approvals={chatLink === "open" ? mcp.approvals : null}
        links={chatLink === "open" ? (links ?? null) : null}
      />
    ),
    labels: () => <LabelsPage labels={labels} chatLink={chatLink} />,
    keys: () => <KeysPage shortcut={shortcut} />,
  };

  return (
    <div className="grid grid-cols-[200px_1fr] flex-1" style={{ minHeight: 0 }}>
      {/* One page at a time: the section list on the left, the page on the right. The page is remembered for the window. */}
      <nav
        aria-label="Preferences"
        className={cn(windowed && "loki-settings-nav", "flex flex-col")}
        data-tauri-drag-region={windowed ? "deep" : undefined}
        style={{
          minHeight: 0,
          padding: windowed ? "52px 10px 0" : "16px 10px 0",
          borderRight: windowed ? undefined : "1px solid var(--loki-border)",
        }}
      >
        {!windowed && (
          <h2 className="loki-title" style={{ margin: 0, padding: "4px 10px 12px" }}>
            Preferences
          </h2>
        )}
        <PageList
          page={page}
          onPick={pick}
          extra={(g) =>
            g.pages.includes("phone") && phone.status?.enabled ? (
              <Dot aria-label="On" color="var(--loki-positive)" style={{ marginLeft: 8, verticalAlign: "middle" }} />
            ) : null
          }
        />
      </nav>
      <div className="flex flex-col min-w-0" style={{ minHeight: 0, background: "var(--loki-bg)" }}>
        <div
          data-tauri-drag-region={windowed ? "deep" : undefined}
          className="flex-none flex items-center gap-2"
          style={{
            minHeight: windowed ? 52 : 48,
            padding: "0 12px 0 28px",
            // A group with tabs draws its rule under them instead.
            borderBottom: group.pages.length > 1 ? undefined : "1px solid var(--loki-border)",
          }}
        >
          <h3 className="loki-title flex-1 min-w-0" style={{ margin: 0 }}>
            {group.title}
          </h3>
          {onClose && (
            <IconButton size={28} onClick={onClose} label="Close preferences" style={{ fontSize: "var(--loki-text-title)" }}>
              <Glyph icon={XIcon} size={16} />
            </IconButton>
          )}
        </div>
        {group.pages.length > 1 && (
          <div className="flex-none" style={{ padding: "0 8px", borderBottom: "1px solid var(--loki-border)" }}>
            <TabRow label={group.title} tabs={group.pages.map((p) => ({ id: p, label: pageTitle(p) }))} current={page} onChange={pick} />
          </div>
        )}
        {/* Keyed by page so a new page starts at its top. */}
        <div key={page} className="grid content-start gap-6 flex-1" style={{ minHeight: 0, overflowY: "auto", padding: "24px 28px 40px" }}>
          {pageBody[page]()}
        </div>
      </div>
    </div>
  );
}

/** Appearance's values in Apple's words (plan 2026-11-12-1505, U8). */
const THEME_LABEL: Record<(typeof THEME_PREFERENCES)[number], string> = { system: "System", light: "Light", dark: "Dark" };

/** Preferences › Appearance: light or dark, on this device only. */
function AppearancePage() {
  const theme = useTheme();
  return (
    <Block>
      <Setting
        label="Mode"
        help={
          theme.preference === "system" ? `Follows ${systemName(keyboard)} as it changes: ${theme.resolved} now.` : "On this device, whatever the system does."
        }
      >
        <Segmented label="Light or dark" options={THEME_PREFERENCES} value={theme.preference} onPick={theme.setPreference} labels={THEME_LABEL} />
      </Setting>
    </Block>
  );
}

/** Preferences › About: this app, the mod, what loki needs on this machine, and what launch installed. */
function LokiPage({
  update,
  harness,
  daemon,
  modConnection,
  deskCount,
}: {
  update: LokiUpdate;
  harness: ReturnType<typeof useHarnessFacts>;
  daemon: DaemonStatus | null;
  modConnection: ModConnection;
  deskCount: number;
}) {
  return (
    <>
      <Block>
        <LokiVersionFact update={update} />
        <SystemFact />
      </Block>
      <Block title="Mod" help="Canvas layout, widget files, transcripts and chats, served by loki's daemon.">
        <Fact label="Link" value={<Status s={modConnection} />} />
        <Fact label="Chats" value={String(deskCount)} />
        <Fact label="Endpoint" value={modBase()} mono />
      </Block>
      {inTauri && (
        <Block title="Requirements" help="What loki needs on this machine, and where it found it.">
          <NodeFact daemon={daemon} />
        </Block>
      )}
      {inTauri && <InstallFold install={harness.install} />}
      <FilesFold />
    </>
  );
}

/** The Node the daemon runs on, or why the daemon could not start. */
function NodeFact({ daemon }: { daemon: DaemonStatus | null }) {
  const value = !daemon ? "—" : daemon.error ? <Note tone="warn">{daemon.error}</Note> : (daemon.node ?? "Starting…");
  return <Fact label="Node" value={value} mono={!!daemon?.node && !daemon.error} />;
}

/** Where loki runs, said plainly (in a browser tab, that the tab is only a view of it), over what that system needs. */
export function SystemFact({ os = platform, shell = inTauri }: { os?: Platform; shell?: boolean }) {
  return (
    <Fact
      label="System"
      value={
        <span>
          {runsOn(os, shell)}
          <Note>{osWords(os).system}</Note>
        </span>
      }
    />
  );
}

/**
 * The app's own version, and the newest release on GitHub once it answered. Homebrew is the upgrade path on the
 * Mac; this system's file on the release elsewhere, where the build is also a preview (plan 014 R12). There the
 * check reads the newest release carrying that file, so the link is the file (the release page if it has none).
 */
export function LokiVersionFact({ update, os = platform }: { update: LokiUpdate; os?: Platform }) {
  const cask = update.channel === "nightly" ? "loki-nightly" : "loki";
  const upgrade = lokiUpgrade(cask, os);
  const preview =
    os === "macos" ? null : (
      <Note>
        A preview build: built and tested in CI, not yet tried on real machines
        {update.issues ? (
          <>
            {" "}
            — <a href={update.issues}>Report problems</a>
          </>
        ) : null}
      </Note>
    );
  const value = update.newer ? (
    <span>
      {update.current} · <a href={update.url ?? "#"}>{update.latest} is out</a>
      <Note>{os === "macos" ? upgrade : <a href={update.download ?? update.url ?? "#"}>{upgrade}</a>}</Note>
      {preview}
    </span>
  ) : update.latest ? (
    <span>
      {update.current}
      <Note>{update.channel === "nightly" ? "The newest nightly" : "The newest release"}</Note>
      {preview}
    </span>
  ) : (
    <span>
      {update.current}
      {update.error ? <Note>Could not check for a newer release — {update.error}</Note> : null}
      {preview}
    </span>
  );
  return <Fact label="Version" value={value} />;
}

/** In the shell only: what launch did about the mod and the skill, folded shut. */
function InstallFold({ install }: { install: InstallReport | null }) {
  return (
    <Fold title="What launch installed">
      <ModFact install={install} />
      {install?.mod_path ? <Fact label={install.mod === "linked" ? "Imports" : "Bundle"} value={install.mod_path} mono /> : null}
      <Fact label="Canvas" value={install ? <InstallState s={install.app} /> : "—"} />
      {install?.app_path ? <Fact label="Canvas path" value={install.app_path} mono /> : null}
      <Fact
        label="Skill"
        value={
          install ? (
            <span>
              <InstallState s={install.skill} />{" "}
              {install.skill === "custom" ? (
                <Note>A symlink or your own copy; left alone</Note>
              ) : install.skill === "linked" ? (
                <Note>A symlink to the checkout this build came from</Note>
              ) : null}
            </span>
          ) : (
            "—"
          )
        }
      />
      <Fact label="Skill path" value={install?.skill_path ?? "~/.agents/skills/loki"} mono />
      {install?.error ? <Fact label="Error" value={<span style={{ color: "var(--loki-negative)" }}>{install.error}</span>} /> : null}
    </Fold>
  );
}

/** The word after the mod's state: what launch found in its place. */
function modNote(install: InstallReport): React.ReactNode {
  if (install.mod === "custom") return <Note>Your own copy is in place; the app leaves it alone</Note>;
  if (install.mod === "linked") return <Note>Development build — the daemon runs this checkout's mod/boot.ts</Note>;
  if (install.mod === "skipped") return <Note>Development build — the app's own copy is in place; set LOKI_INSTALL=1 to refresh it</Note>;
  return null;
}

function ModFact({ install }: { install: InstallReport | null }) {
  return (
    <Fact
      label="Mod"
      value={
        install ? (
          <span>
            <InstallState s={install.mod} /> {modNote(install)}
          </span>
        ) : (
          "—"
        )
      }
    />
  );
}

function ProvidersPage({
  chatLink,
  providers,
  onLoadProviders,
  onConnectProvider,
  onDisconnectProvider,
  onModelsChanged,
}: {
  chatLink: ChatLink;
  providers: ConnectProvider[] | null;
  onLoadProviders: () => Promise<unknown>;
  onConnectProvider: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnectProvider: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
}) {
  return chatLink === "open" ? (
    <ProviderSettings
      providers={providers}
      onLoad={onLoadProviders}
      onConnect={onConnectProvider}
      onDisconnect={onDisconnectProvider}
      onChanged={onModelsChanged}
    />
  ) : (
    <Setting label="Not linked" help="loki's daemon is not linked yet." />
  );
}

function PhonePage({ phone, modConnection }: { phone: PhoneApi; modConnection: ModConnection }) {
  return <Phone phone={phone} connected={modConnection === "open"} />;
}

function SkillsPage({ globalSkills }: { globalSkills: GlobalSkillsApi }) {
  return <Skills api={globalSkills} />;
}

function RecallPage({ recall }: { recall: RecallModel }) {
  const { snap } = recall;
  // Settings may open before Learn ever did: ask for the snapshot once.
  useEffect(() => {
    if (!snap) void recall.refresh();
  }, [snap, recall]);
  return (
    <Block help="Flashcards written in the background from conversations that have gone quiet, and the leads it proposes. Learn is off until you turn it on.">
      {snap ? (
        <RecallSettings
          worker={snap.worker}
          onSettings={(s) => void recall.settings(s)}
          onRun={() => void recall.run()}
          running={recall.running}
          onExport={() => void recall.exportCards()}
          cardCount={snap.cards.length}
        />
      ) : (
        <Setting label="Learn" help={recall.error ?? "Loading…"} />
      )}
    </Block>
  );
}

function ChatPage({
  chatWidth,
  onChatWidth,
  chatPlacement,
  onChatPlacement,
  approvals,
  links,
}: {
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  onChatPlacement: (p: ChatPlacement) => void;
  approvals: McpApi["approvals"] | null;
  links: ChatLinksApi | null;
}) {
  return (
    <>
      <Block title="Chat panel">
        <Setting label="Position" help="Where the chat sits on the canvas. An empty canvas opens it centred until the first widget lands.">
          <Segmented
            label="Position"
            options={CHAT_PLACEMENTS}
            value={chatPlacement}
            onPick={onChatPlacement}
            labels={{ left: "Left", center: "Centre", right: "Right" }}
          />
        </Setting>
        <Setting label="Width at the side" help="When the chat sits on the left or the right.">
          <Segmented label="Width at the side" options={CHAT_WIDTHS} value={chatWidth} onPick={onChatWidth} labels={{ narrow: "Narrow", wide: "Wide" }} />
        </Setting>
      </Block>
      <Block title="Always allowed" help="Tools that run without asking, in every chat and every mode but strict.">
        {approvals ? <AlwaysAllowed api={approvals} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />}
      </Block>
      <Block title="Chat links" help="Which chats may message each other, opened on the card an agent shows when it first asks.">
        {links ? <ChatLinks api={links} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />}
      </Block>
    </>
  );
}

function LabelsPage({ labels, chatLink }: { labels: LabelsApi; chatLink: ChatLink }) {
  return chatLink === "open" ? <Labels api={labels} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />;
}

function EnginesPage({ engines, chatLink }: { engines: EnginesApi; chatLink: ChatLink }) {
  return chatLink === "open" ? <Engines api={engines} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />;
}

function McpPage({ mcp, chatLink }: { mcp: McpApi; chatLink: ChatLink }) {
  return chatLink === "open" ? <Mcp api={mcp} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />;
}

/**
 * Preferences › Inbox (Flow on screen): the lane editor when given its lanes (plan 087), then what read, later,
 * archive, label and a reply do, how long read and later set each kind of card aside, and how the deck orders its cards
 * behind a fold. The accounts whose mail and messages become cards have their
 * own page, Preferences › Accounts (plan 068). Exported for its test.
 */
export function InboxPage({ returnTimes, lanes }: { returnTimes: ReturnTimesApi; lanes?: LanesProps }) {
  const { times, set } = returnTimes;
  return (
    <>
      {lanes && <Lanes {...lanes} />}
      <Block help="Every chat you have not archived, every thread in your Gmail inbox, every unread Slack message and every Jira ticket you watch that someone else changed. A card stays until it is done: a chat or an email when you archive it, a Slack message or a Jira ticket when you read it. The card in front of you never moves until you act on it.">
        <Setting
          label="Read"
          help={`Marks the card read, in Gmail or Slack too. A chat or an email is set aside for a while, then ${REST_GROWTH} times longer each read in a row while nothing new comes, up to a week; anything new brings it back at once. A Slack message or a Jira card is done once read.`}
        >
          <Kbd>{keyFor("inbox.next")}</Kbd>
        </Setting>
        <Setting label="Read rests a card for" help="The first rest after read, on every device.">
          <div className={KIND_GRID}>
            {READ_KINDS.map((kind) => [
              <span key={`${kind}-name`} className="loki-meta">
                {sentence(KIND_NAME[kind])}
              </span>,
              <Segmented
                key={kind}
                label={`Read rests ${KIND_NAME[kind]} for`}
                options={REST_FIRST_KEYS}
                value={times.read_first[kind]}
                onPick={(first) => set({ ...times, read_first: { ...times.read_first, [kind]: first } })}
                labels={REST_FIRST_LABELS}
              />,
            ])}
          </div>
        </Setting>
        <Setting
          label="Later"
          help="Keeps the card unread, here and in Gmail or Slack (a Jira card here only, as Jira keeps no unread), and brings it back after the time below, or sooner if something new comes. The second later in a row asks when."
        >
          <Kbd>{keyFor("inbox.later")}</Kbd>
        </Setting>
        <Setting label="Later brings a card back after" help="On every device. A new time counts from the next later; a card already set aside keeps its own.">
          <div className={KIND_GRID}>
            {LATER_KINDS.map((kind) => [
              <span key={`${kind}-name`} className="loki-meta">
                {sentence(KIND_NAME[kind])}
              </span>,
              <Segmented
                key={kind}
                label={`Later brings ${KIND_NAME[kind]} back after`}
                options={REST_LATER_KEYS}
                value={laterOf(times, kind)}
                onPick={(later) => set({ ...times, later: { ...times.later, [kind]: later } })}
                labels={REST_LATER_LABELS}
              />,
            ])}
          </div>
        </Setting>
        <Setting
          label="Archive"
          help="Done: a chat is archived, an email thread is archived in Gmail, a Slack message is marked read. Undo brings it back. A Jira card has no archive: read ends it."
        >
          <Kbd>{keyFor("inbox.archive")}</Kbd>
        </Setting>
        <Setting label="Label" help="On an email card: adds Gmail labels, and the card stays for your next key.">
          <Kbd>{keyFor("inbox.label")}</Kbd>
        </Setting>
        <Setting
          label="A reply"
          help="On a chat card, the message goes to the agent and the card stays, so the answer streams in where you are. On an email or Slack card, the key you press sends what you typed, then does its own move."
        />
      </Block>
      <Fold title="How the order works">
        <Setting label="Blocked" help="An approval or a question: an agent is stopped until you answer.">
          <Score>{`+${BLOCKED_POINTS}`}</Score>
        </Setting>
        <Setting label="New" help="The agent said something since you last looked.">
          <Score>{`+${NEW_POINTS}`}</Score>
        </Setting>
        <Setting
          label="Focus"
          help={`The chat's share of what you have been doing lately: your messages, answers, decisions and reads, each fading by half every ${FOCUS_HALF_LIFE_H} hours. The task you are on rises; one you have moved on from fades.`}
        >
          <Score>{`Up to +${FOCUS_POINTS}`}</Score>
        </Setting>
        <Setting label="Age" help="Off for most cards, so old ones drift down; on for blocked cards, so the agent that has waited longest comes first.">
          <Score>±0.1 an hour</Score>
        </Setting>
      </Fold>
    </>
  );
}

/** Per-kind choices on a row: each kind's name beside its control, the controls lined up on the right. */
const KIND_GRID = "grid grid-cols-[auto_auto] items-center justify-items-end gap-2";
/** The kinds of card read rests; a Slack message or a Jira card is done once read, so it has no rest. */
const READ_KINDS = ["chat", "email"] as const;
/** The kinds of card later brings back. */
const LATER_KINDS = ["chat", "email", "slack", "jira"] as const;
/** Each kind of card as the Inbox page names it. */
const KIND_NAME: Record<CardKind, string> = { chat: "chats", email: "email", slack: "Slack", jira: "Jira" };
/** The first rests on offer, shortest first. */
const REST_FIRST_KEYS: readonly RestFirst[] = ["10m", "30m", "1h", "3h"];
/** Each first rest as the setting says it. */
const REST_FIRST_LABELS: Record<RestFirst, string> = { "10m": "10 Min", "30m": "30 Min", "1h": "1 Hour", "3h": "3 Hours" };
/** The later returns on offer, soonest first. */
const REST_LATER_KEYS: readonly RestLater[] = ["3h", "1d", "2d", "1w"];
/** Each later return as the setting says it. */
const REST_LATER_LABELS: Record<RestLater, string> = { "3h": "3 Hours", "1d": "1 Day", "2d": "2 Days", "1w": "1 Week" };

/** A score on the right of an Inbox row: what the rule adds. */
function Score({ children }: { children: string }) {
  return (
    <span className="loki-mono" style={{ fontSize: "var(--loki-text-meta)", color: "var(--loki-fg)" }}>
      {children}
    </span>
  );
}

/** Preferences › About: every folder and file loki keeps, folded shut (was a page of its own until plan 031). */
function FilesFold() {
  return (
    <Fold title="Where loki keeps things">
      <Fact label="Widgets" value={`${HOME}/widgets/<chat>/`} mono />
      <Fact label="Layout" value={`${HOME}/state/<chat>.json`} mono />
      <Fact label="Flow marks" value={`${HOME}/state/attention.json`} mono />
      <Fact label="Pictures" value={`${HOME}/chat-images/`} mono />
      <Fact label="Learn" value={`${HOME}/recall/  (cards, schedule and the deleted pile)`} mono />
      <Fact label="Token" value={`${HOME}/token`} mono />
      <Fact label="Logs" value={`${HOME}/mod.log · ${HOME}/logs/daemon.log`} mono />
      <Fact label="Mod · canvas" value={`${HOME}/mod/  ·  ${HOME}/app/  (installed from the app bundle at launch)`} mono />
    </Fold>
  );
}

/** The system-wide key as its row names it; it exists on the Mac only (global.inbox has no key elsewhere). */
const GLOBAL_KEY = `${formatKeys("alt", "macos")}Space`;

/** Preferences › Keyboard shortcuts: ⌥Space held or released on the Mac; a browser tab cannot hold it, and Windows and Linux have none yet (R3). */
export function GlobalKeyRow({ shortcut, os = platform }: { shortcut: GlobalShortcut; os?: Platform }) {
  if (os !== "macos") return <Fact label="System-wide" value={notYetOn("The system-wide key", os)} />;
  return (
    <Fact
      label={GLOBAL_KEY}
      value={
        shortcut.available ? (
          <span className="inline-grid gap-1">
            <Switch on={shortcut.enabled} onToggle={() => shortcut.set(!shortcut.enabled)} label="Bring loki up on Flow from anywhere on the Mac" />
            {shortcut.error ? (
              <Note tone="warn">{`macOS refused it — another app (Raycast, Alfred, the input-source switcher) holds ${GLOBAL_KEY}; free it there and switch this off and on`}</Note>
            ) : (
              <Note>Off, if another app wants the key or you type non-breaking spaces with it</Note>
            )}
          </span>
        ) : (
          "The app only — a browser tab cannot hold a system-wide key"
        )
      }
    />
  );
}

/** Preferences › Keyboard shortcuts shortcuts: ⌥Space, then every key loki has, found by what it does, its keys or where it works. */
function KeysPage({ shortcut }: { shortcut: GlobalShortcut }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = keyRows().filter((b) => !q || [b.label, b.where, ...b.keys.map((k) => formatKeys(k))].some((w) => w.toLowerCase().includes(q)));
  return (
    <>
      <Block>
        <GlobalKeyRow shortcut={shortcut} />
      </Block>
      <Block title="Every key" help={keyboard === "macos" ? `${formatKeys("cmd")} here is ctrl on other systems.` : undefined}>
        <div style={{ padding: "12px 0" }}>
          <Field
            size="sm"
            type="search"
            placeholder="Search keys"
            aria-label="Search keyboard shortcuts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        {rows.length === 0 && <Setting label="Nothing matches" help={`Try what the key does, such as archive, or a key, such as ${keyFor("search.open")}.`} />}
        {rows.length > 0 && (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--loki-text-body)" }}>
            <tbody>
              {rows.map((b, i, rows) => (
                <tr key={b.id} style={{ borderTop: i > 0 && rows[i - 1].where !== b.where ? "1px solid var(--loki-border)" : undefined }}>
                  <td className="loki-label" style={{ padding: "6px 0", width: 90, verticalAlign: "top", paddingTop: 9 }}>
                    {i === 0 || rows[i - 1].where !== b.where ? sentence(b.where) : ""}
                  </td>
                  <td
                    className="loki-mono"
                    style={{
                      padding: "6px 12px 6px 0",
                      width: 170,
                      fontSize: "var(--loki-text-meta)",
                      color: "var(--loki-fg)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {b.keys.map((k) => formatKeys(k)).join(" · ")}
                  </td>
                  <td style={{ padding: "6px 0", color: "var(--loki-muted)" }}>
                    {b.label}
                    {b.typing ? (
                      ""
                    ) : b.where === "inbox" || b.where === "desk" ? (
                      <span style={{ marginLeft: 8, fontSize: "var(--loki-text-fine)", opacity: 0.7 }}>Not while typing</span>
                    ) : null}
                    {b.was && <span className="loki-meta loki-meta--wrap block">{sentence(wasFor(b) ?? "")}</span>}
                    {takenBy(b).map((t) => (
                      <span key={t.id} className="loki-meta loki-meta--wrap block">{`Not in the ${t.where}: there ${formatKeys(t.key)} is ${t.label}`}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>
    </>
  );
}

/** A numeric setting on a Fact row: typed, applied on blur when it reads as a number inside its range (the mod clamps too), with a hint beside it. */

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) {
  return (
    <span style={{ marginLeft: 8, fontSize: "var(--loki-text-meta)", color: tone === "warn" ? "var(--loki-negative)" : "var(--loki-muted)" }}>{children}</span>
  );
}

function InstallState({ s }: { s: string }) {
  const color = s === "error" ? "var(--loki-negative)" : s === "custom" || s === "skipped" ? "var(--loki-muted)" : "var(--loki-positive)";
  return <span style={{ color, fontSize: "var(--loki-text-meta)", fontWeight: 600 }}>{sentence(s)}</span>;
}

function Status({ s }: { s: string }) {
  const color = s === "open" ? "var(--loki-positive)" : s === "connecting" ? "var(--loki-accent)" : "var(--loki-negative)";
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color, fontSize: "var(--loki-text-meta)", fontWeight: 600 }}>
      <Dot color={color} />
      {sentence(s)}
    </span>
  );
}
