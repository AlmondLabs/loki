import { AlwaysAllowed, Mcp, type McpApi } from "./mcp";
import { ChatLinks, type ChatLinksApi } from "./chat-links";
import { Engines, type EnginesApi } from "./engines";
import { Labels, type LabelsApi } from "./labels";
import { Lanes, type LaneAccountsApi, type LanesApi, type LanesProps } from "./lanes";
import { Accounts, type AccountsApi, type AgentName } from "./accounts";
import { useEffect, useState, type ReactNode } from "react";
import { inDesktop, keyboard, modBase, notYetOn, platform, systemName, type Platform } from "../workspace/env";
import { formatKeys, keyFor, keyRows, registerActions, takenBy, wasFor } from "../shell/keymap";
import { osWords, runsOn } from "../shell/os-words";
import { Button, Dot, Field, IconButton, Sheet, Switch, sentence } from "../components";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/chat-window";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { ProviderSettings } from "./providers";
import { Phone, type PhoneApi } from "./phone";
import { Macs, type MacsApi } from "./macs";
import { Skills, type GlobalSkillsApi } from "./skills";
import { ReflectionSettings } from "./reflection";
import type { ReflectionControls } from "../agents/types";
import type { DaemonStatus } from "../shell/bootstrap";
import { useHarnessFacts, type InstallReport } from "../shell/use-harness-facts";
import type { LokiUpdate, UpdateState } from "../shell/use-loki-update";
import { restartToUpdate } from "../shell/update-notice";
import { channelOf, type Channel } from "../../../core/version.ts";
import type { GlobalShortcut } from "../shell/use-global-shortcut";
import type { Learn as LearnModel } from "../shell/use-learn";
import { LearnSettings } from "../learn/learn-parts";
import { BLOCKED_POINTS, FOCUS_POINTS, NEW_POINTS } from "../../../core/attention/priority.ts";
import { FOCUS_HALF_LIFE_H } from "../../../core/attention/focus.ts";
import { REST_GROWTH, laterOf, type CardKind, type RestFirst, type RestLater, type ReturnTimes } from "../../../core/attention/rest.ts";

export interface ReturnTimesApi {
  times: ReturnTimes;
  set: (times: ReturnTimes) => void;
}
import { PAGES, SETTINGS_PAGE_KEY, pageTitle, savedPage, type SettingsPage } from "./pages";
import { NAV_TEXT_INSET, PageList } from "./page-list";
import { Block, Fact, Fold, PopUp, Segmented, Setting } from "./layout";
import type { UsageApi } from "../shared/use-usage";
import { UsagePage } from "./usage";
import { THEME_PREFERENCES, useTheme } from "../theme";
import { XIcon } from "lucide-react";
import { Glyph } from "../shared/icons";
import { cn } from "@/lib/utils";

const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "wide"];

const HOME = "~/.loki";

const PAGE_KEY = SETTINGS_PAGE_KEY;

const TOOLBAR_HEIGHT = 52;

export const PANE_INSET = 20;

type ChatLink = "connecting" | "open" | "closed";
type ModConnection = "connecting" | "open" | "closed";

export type SettingsProps = Parameters<typeof Settings>[0];

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
  working,
  shortcut,
  recall,
  reflect,
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
  daemon: DaemonStatus | null;
  phone: PhoneApi;
  macs: MacsApi;
  globalSkills: GlobalSkillsApi;
  mcp: McpApi;
  accounts: AccountsApi & LaneAccountsApi;
  agents: readonly AgentName[];
  engines: EnginesApi;
  links?: ChatLinksApi;
  labels: LabelsApi;
  update: LokiUpdate;
  working: boolean;
  shortcut: GlobalShortcut;
  recall: LearnModel;
  reflect?: ReflectionControls;
  usage: UsageApi;
  returnTimes: ReturnTimesApi;
  lanes: LanesApi;
  onClose?: () => void;
  windowed?: boolean;
  initialPage?: string | null;
}) {
  const harness = useHarnessFacts();
  const [page, setPage] = useState<SettingsPage>(() => savedPage(initialPage ?? sessionStorage.getItem(PAGE_KEY)));
  const pick = (p: SettingsPage) => {
    setPage(p);
    sessionStorage.setItem(PAGE_KEY, p);
  };
  useEffect(() => {
    const step = (d: 1 | -1) => pick(PAGES[(PAGES.findIndex((p) => p.id === page) + d + PAGES.length) % PAGES.length].id);
    return registerActions({ "settings.prevPage": () => step(-1), "settings.nextPage": () => step(1) });
  });

  const pageBody: Record<SettingsPage, () => ReactNode> = {
    loki: () => <LokiPage update={update} working={working} harness={harness} daemon={daemon} modConnection={modConnection} deskCount={deskCount} />,
    usage: () => <UsagePage usage={usage} />,
    flow: () => <FlowPage returnTimes={returnTimes} lanes={{ lanes, accounts, agents }} />,
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
    reflection: () =>
      chatLink === "open" && reflect ? <ReflectionSettings reflect={reflect} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />,
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
      <nav
        aria-label="Preferences"
        className={cn(windowed && "loki-settings-nav", "flex flex-col")}
        data-drag-region={windowed ? "" : undefined}
        style={{
          minHeight: 0,
          padding: windowed ? `${TOOLBAR_HEIGHT}px 8px 0` : "8px 8px 0",
          borderRight: windowed ? undefined : "1px solid var(--loki-border)",
        }}
      >
        {!windowed && (
          <h2 className="loki-title" style={{ margin: 0, padding: `4px ${NAV_TEXT_INSET}px 12px` }}>
            Preferences
          </h2>
        )}
        <PageList
          page={page}
          onPick={pick}
          extra={(p) =>
            p === "phone" && phone.status?.enabled ? (
              <Dot role="img" aria-label="On" color="var(--loki-positive)" style={{ marginLeft: 8, verticalAlign: "middle" }} />
            ) : null
          }
        />
      </nav>
      <div className="flex flex-col min-w-0" style={{ minHeight: 0, background: "var(--loki-bg)" }}>
        <div data-drag-region={windowed ? "" : undefined} className="loki-pane-header-line flex-none" style={{ borderBottom: "1px solid var(--loki-border)" }}>
          <h3 className="loki-title flex-1 min-w-0" style={{ margin: 0 }}>
            {pageTitle(page)}
          </h3>
          {onClose && (
            <IconButton size={28} onClick={onClose} label="Close preferences" style={{ fontSize: "var(--text-base)" }}>
              <Glyph icon={XIcon} size={16} />
            </IconButton>
          )}
        </div>
        <div key={page} className="grid content-start gap-6 flex-1" style={{ minHeight: 0, overflowY: "auto", padding: `24px ${PANE_INSET}px 48px` }}>
          {pageBody[page]()}
        </div>
      </div>
    </div>
  );
}

const THEME_LABEL: Record<(typeof THEME_PREFERENCES)[number], string> = { system: "System", light: "Light", dark: "Dark" };

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

function LokiPage({
  update,
  working,
  harness,
  daemon,
  modConnection,
  deskCount,
}: {
  update: LokiUpdate;
  working: boolean;
  harness: ReturnType<typeof useHarnessFacts>;
  daemon: DaemonStatus | null;
  modConnection: ModConnection;
  deskCount: number;
}) {
  return (
    <>
      <Block>
        <LokiVersionFact update={update} working={working} />
        <SystemFact />
      </Block>
      <Block title="Mod" help="Canvas layout, widget files, transcripts and chats, served by loki's daemon.">
        <Fact label="Link" value={<Status s={modConnection} />} />
        <Fact label="Chats" value={String(deskCount)} />
        <Fact label="Endpoint" value={modBase()} mono />
      </Block>
      {inDesktop && (
        <Block title="Requirements" help="What loki needs on this machine, and where it found it.">
          <NodeFact daemon={daemon} />
        </Block>
      )}
      {inDesktop && <InstallFold install={harness.install} />}
      <FilesFold />
    </>
  );
}

function NodeFact({ daemon }: { daemon: DaemonStatus | null }) {
  const value = !daemon ? "—" : daemon.error ? <Note tone="warn">{daemon.error}</Note> : (daemon.node ?? "Starting…");
  return <Fact label="Node" value={value} mono={!!daemon?.node && !daemon.error} />;
}

export function SystemFact({ os = platform, shell = inDesktop }: { os?: Platform; shell?: boolean }) {
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

const CHANNEL_LABEL: Record<Channel, string> = { stable: "Stable", nightly: "Nightly" };

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

const DEB_WORDS = "This install updates from the releases page";

const FAILED: Record<Extract<UpdateState, { kind: "failed" }>["stage"], string> = {
  check: "Could not check for updates",
  download: "The update did not download",
  signature: "The update failed its signature check",
  install: "The update did not install",
};

function updateLine(update: LokiUpdate, state: UpdateState, working: boolean): React.ReactNode {
  const button = (label: string, onClick: () => void) => (
    <span className="block" style={{ marginTop: 8 }}>
      <Button onClick={onClick}>{label}</Button>
    </span>
  );
  switch (state.kind) {
    case "idle":
      return <Note>Up to date</Note>;
    case "checking":
      return <Note>Checking…</Note>;
    case "downloading":
      return <Note>{state.total ? `Downloading… ${megabytes(state.done)} of ${megabytes(state.total)} MB` : "Downloading…"}</Note>;
    case "ready": {
      const version = state.version;
      return (
        <>
          <Note>Ready — installs when you quit loki</Note>
          {button("Restart to Update", () => restartToUpdate(version, working, update.restart))}
        </>
      );
    }
    case "failed":
      return (
        <>
          <span title={state.message}>
            <Note>{FAILED[state.stage]}; this version is still running</Note>
          </span>
          {button("Check Again", update.check)}
        </>
      );
    case "unsupported":
      return state.reason === "development" ? (
        <Note>Updates are off in development builds</Note>
      ) : (
        <Note>{update.releases ? <a href={update.releases}>{DEB_WORDS}</a> : DEB_WORDS}</Note>
      );
  }
}

export function LokiVersionFact({ update, working }: { update: LokiUpdate; working: boolean }) {
  const status = update.status;
  if (!status) return <Fact label="Version" value={__LOKI_VERSION__} />;
  const updates = status.state.kind !== "unsupported";
  const onNightly = channelOf(status.current) === "nightly";
  return (
    <>
      <Fact
        label="Version"
        value={
          <span>
            {status.current}
            {updateLine(update, status.state, working)}
          </span>
        }
      />
      {updates && (
        <Setting
          label="Channel"
          help={
            onNightly
              ? "You're on a nightly, and Stable stays on it until the next stable release."
              : "Stable gets each release, Nightly every change as it lands."
          }
        >
          <Segmented label="Update channel" options={["stable", "nightly"] as const} value={status.channel} onPick={update.setChannel} labels={CHANNEL_LABEL} />
        </Setting>
      )}
    </>
  );
}

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

function modNote(install: InstallReport): React.ReactNode {
  if (install.mod === "custom") return <Note>Your own copy is in place; the app leaves it alone</Note>;
  if (install.mod === "linked") return <Note>Development build — the daemon runs from this checkout</Note>;
  if (install.mod === "skipped") return <Note>Development build — the app's own copy is in place; set LOKI_INSTALL=1 to refresh it</Note>;
  return null;
}

function ModFact({ install }: { install: InstallReport | null }) {
  return (
    <Fact
      label="Daemon"
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

function RecallPage({ recall }: { recall: LearnModel }) {
  const { snap } = recall;
  useEffect(() => {
    if (!snap) void recall.refresh();
  }, [snap, recall]);
  return (
    <Block help="Flashcards and leads written in the background from chats that have gone quiet, off until you turn it on.">
      {snap ? (
        <LearnSettings
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
        <Setting label="Position" help="Where the chat sits on the canvas, centred until the first widget lands.">
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

export function FlowPage({ returnTimes, lanes }: { returnTimes: ReturnTimesApi; lanes?: LanesProps }) {
  const { times, set } = returnTimes;
  return (
    <>
      {lanes && <Lanes {...lanes} />}
      <Block help="Your chats, your Gmail inbox, unread Slack messages and the Jira tickets you watch that someone else changed, each card staying until it is done.">
        <Setting
          label="Read"
          help={`Marks the card read, in Gmail or Slack too: a chat or an email rests, ${REST_GROWTH} times longer each read in a row, and a Slack message or a Jira card is done once read.`}
        />
        <Setting label="Read rests a card for" help="The first rest after read, on every device.">
          <div className={KIND_GRID}>
            {READ_KINDS.map((kind) => [
              <span key={`${kind}-name`} className="loki-meta">
                {sentence(KIND_NAME[kind])}
              </span>,
              <PopUp
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
        <Setting label="Later" help="Keeps the card unread, in Gmail or Slack too, and brings it back after the time below or when something new comes." />
        <Setting label="Later brings a card back after" help="On every device, for cards you put off from now on.">
          <div className={KIND_GRID}>
            {LATER_KINDS.map((kind) => [
              <span key={`${kind}-name`} className="loki-meta">
                {sentence(KIND_NAME[kind])}
              </span>,
              <PopUp
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
          help="Archives a chat or an email thread, in Gmail too, and marks a Slack message read, where a Jira card has no archive and read ends it."
        />
        <Setting label="Label" help="On an email card: adds Gmail labels, and the card stays for your next key." />
        <Setting
          label="A reply"
          help="On a chat card the answer streams in where you are, and on an email or Slack card the key you press sends what you typed."
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
          help={`The chat's share of what you have done lately, each message, answer and read fading by half every ${FOCUS_HALF_LIFE_H} hours.`}
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

const KIND_GRID = "grid grid-cols-[auto_auto] items-center justify-items-end gap-2";
const READ_KINDS = ["chat", "email"] as const;
const LATER_KINDS = ["chat", "email", "slack", "jira"] as const;
const KIND_NAME: Record<CardKind, string> = { chat: "chats", email: "email", slack: "Slack", jira: "Jira" };
const REST_FIRST_KEYS: readonly RestFirst[] = ["10m", "30m", "1h", "3h"];
const REST_FIRST_LABELS: Record<RestFirst, string> = { "10m": "10 Min", "30m": "30 Min", "1h": "1 Hour", "3h": "3 Hours" };
const REST_LATER_KEYS: readonly RestLater[] = ["3h", "1d", "2d", "1w"];
const REST_LATER_LABELS: Record<RestLater, string> = { "3h": "3 Hours", "1d": "1 Day", "2d": "2 Days", "1w": "1 Week" };

function Score({ children }: { children: string }) {
  return (
    <span className="loki-mono" style={{ fontSize: "var(--text-xs)", color: "var(--loki-fg)" }}>
      {children}
    </span>
  );
}

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

const GLOBAL_KEY = `${formatKeys("alt", "macos")}Space`;

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
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--text-sm)" }}>
            <tbody>
              {rows.map((b, i, rows) => (
                <tr key={b.id} style={{ borderTop: i > 0 && rows[i - 1].where !== b.where ? "1px solid var(--loki-border)" : undefined }}>
                  <td className="loki-label" style={{ padding: "4px 0", width: 90, verticalAlign: "top" }}>
                    {i === 0 || rows[i - 1].where !== b.where ? sentence(b.where) : ""}
                  </td>
                  <td
                    className="loki-mono"
                    style={{
                      padding: "4px 12px 4px 0",
                      width: 170,
                      fontSize: "var(--text-xs)",
                      color: "var(--loki-fg)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {b.keys.map((k) => formatKeys(k)).join(" · ")}
                  </td>
                  <td style={{ padding: "4px 0", color: "var(--loki-muted)" }}>
                    {b.label}
                    {b.typing ? (
                      ""
                    ) : b.where === "flow" || b.where === "chats" ? (
                      <span style={{ marginLeft: 8, fontSize: "var(--text-xs)" }}>Not while typing</span>
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

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) {
  return <span style={{ marginLeft: 8, fontSize: "var(--text-xs)", color: tone === "warn" ? "var(--loki-negative)" : "var(--loki-muted)" }}>{children}</span>;
}

function InstallState({ s }: { s: string }) {
  const color = s === "error" ? "var(--loki-negative)" : s === "custom" || s === "skipped" ? "var(--loki-muted)" : "var(--loki-positive)";
  return <span style={{ color, fontSize: "var(--text-xs)", fontWeight: 600 }}>{sentence(s)}</span>;
}

function Status({ s }: { s: string }) {
  const color = s === "open" ? "var(--loki-positive)" : s === "connecting" ? "var(--loki-accent)" : "var(--loki-negative)";
  return (
    <span className="inline-flex items-center gap-1" style={{ color, fontSize: "var(--text-xs)", fontWeight: 600 }}>
      <Dot color={color} />
      {sentence(s)}
    </span>
  );
}
