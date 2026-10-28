import { AlwaysAllowed, Mcp, type McpApi } from "./mcp";
import { Engines, type EnginesApi } from "./engines";
import { Labels, type LabelsApi } from "./labels";
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
import { REST_FIRST_MS, REST_GROWTH } from "../../../core/attention/rest.ts";
import { PAGES, SETTINGS_PAGE_KEY, groupOf, pageTitle, savedPage, type SettingsPage } from "./pages";
import { PageList } from "./page-list";
import { Block, Fact, Fold, Segmented, Setting } from "./layout";
import { UsagePage, type UsageApi } from "./usage";
import { PALETTES, PALETTE_LABEL, THEME_PREFERENCES, useTheme } from "../theme";

/** The chat panel's widths at the side, narrow first. */
const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "wide"];

const HOME = "~/.loki";

export { PAGES, isSettingsPage, pageTitle, type SettingsPage } from "./pages";

const PAGE_KEY = SETTINGS_PAGE_KEY;

/** The daemon's chat link (useAttention's status, "off" shown as connecting). */
type ChatLink = "connecting" | "open" | "closed";
type ModConnection = "connecting" | "open" | "closed";

type SettingsProps = Parameters<typeof Settings>[0];

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
  engines,
  labels,
  update,
  shortcut,
  recall,
  usage,
  onClose,
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
  /** ~/.agents/skills, which every agent reads (Settings › skills). */
  globalSkills: GlobalSkillsApi;
  /** Settings › MCP, and Settings › Chat's always-allowed tools (daemon/mcp/, daemon/approvals.ts). */
  mcp: McpApi;
  /** Settings › Engines: the ACP agents a chat can run on (daemon/acp/, plan 020). */
  engines: EnginesApi;
  /** Settings › labels: the labels on chats, renamed, recoloured or deleted everywhere (plan 022). */
  labels: LabelsApi;
  /** Newer loki releases, from GitHub (Settings › loki). */
  update: LokiUpdate;
  /** ⌥Space, held or released (Settings › keys). */
  shortcut: GlobalShortcut;
  /** The card writer's switch and knobs (Settings › learn). */
  recall: RecallModel;
  /** What the agents spent, and their names (Settings › usage). */
  usage: UsageApi;
  /** The close button in the page's header (Preferences); none without it. */
  onClose?: () => void;
}) {
  const harness = useHarnessFacts();
  const [page, setPage] = useState<SettingsPage>(() => savedPage(sessionStorage.getItem(PAGE_KEY)));
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
    inbox: () => <InboxPage />,
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
      />
    ),
    labels: () => <LabelsPage labels={labels} chatLink={chatLink} />,
    keys: () => <KeysPage shortcut={shortcut} />,
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", flex: 1, minHeight: 0 }}>
      {/* One page at a time: the section list on the left, the page on the right. The page is remembered for the window. */}
      <nav
        aria-label="Preferences"
        style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: "16px 10px 0", borderRight: "1px solid var(--loki-border)" }}
      >
        <h2 className="loki-title" style={{ margin: 0, padding: "4px 10px 12px" }}>
          Preferences
        </h2>
        <PageList
          page={page}
          onPick={pick}
          extra={(g) =>
            g.pages.includes("phone") && phone.status?.enabled ? (
              <Dot aria-label="on" color="var(--loki-positive)" style={{ marginLeft: 8, verticalAlign: "middle" }} />
            ) : null
          }
        />
      </nav>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--loki-bg)" }}>
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 48,
            padding: "0 12px 0 28px",
            // A group with tabs draws its rule under them instead.
            borderBottom: group.pages.length > 1 ? undefined : "1px solid var(--loki-border)",
          }}
        >
          <h3 className="loki-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
            {group.title}
          </h3>
          {onClose && (
            <IconButton size={28} onClick={onClose} label="Close preferences" style={{ fontSize: 17 }}>
              ×
            </IconButton>
          )}
        </div>
        {group.pages.length > 1 && (
          <div style={{ flex: "none", padding: "0 8px", borderBottom: "1px solid var(--loki-border)" }}>
            <TabRow label={group.title} tabs={group.pages.map((p) => ({ id: p, label: pageTitle(p) }))} current={page} onChange={pick} />
          </div>
        )}
        {/* Keyed by page so a new page starts at its top. */}
        <div key={page} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 28px 40px", display: "grid", gap: 28, alignContent: "start" }}>
          {pageBody[page]()}
        </div>
      </div>
    </div>
  );
}

/** Settings › appearance: light or dark and the colour family, on this device only. */
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
        <Segmented label="light or dark" options={THEME_PREFERENCES} value={theme.preference} onPick={theme.setPreference} />
      </Setting>
      <Setting label="Palette" help="The colour family, in light and in dark.">
        <Segmented label="colour palette" options={PALETTES} value={theme.palette} onPick={theme.setPalette} labels={PALETTE_LABEL} />
      </Setting>
    </Block>
  );
}

/** Settings › loki: this app, the mod, what loki needs on this machine, and what launch installed. */
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
      <Block title="Mod" help="canvas layout, widget files, transcripts and chats, served by loki's daemon.">
        <Fact label="Link" value={<Status s={modConnection} />} />
        <Fact label="Chats" value={String(deskCount)} />
        <Fact label="Endpoint" value={modBase()} mono />
      </Block>
      <Block title="Requirements" help="what loki needs on this machine, and where it found it.">
        {inTauri && <NodeFact daemon={daemon} />}
        <Fact
          label="bd (beads)"
          value={
            harness.tools
              ? (harness.tools.bd ?? <Note tone="warn">{`not found — ${osWords().beadsInstall} (Tasks needs it; everything else works without)`}</Note>)
              : "—"
          }
          mono
        />
      </Block>
      {inTauri && <InstallFold install={harness.install} />}
      <FilesFold />
    </>
  );
}

/** The Node the daemon runs on, or why the daemon could not start. */
function NodeFact({ daemon }: { daemon: DaemonStatus | null }) {
  const value = !daemon ? "—" : daemon.error ? <Note tone="warn">{daemon.error}</Note> : (daemon.node ?? "starting…");
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
        a preview build: built and tested in CI, not yet tried on real machines
        {update.issues ? (
          <>
            {" "}
            — <a href={update.issues}>report problems</a>
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
      <Note>{update.channel === "nightly" ? "the newest nightly" : "the newest release"}</Note>
      {preview}
    </span>
  ) : (
    <span>
      {update.current}
      {update.error ? <Note>could not check for a newer release — {update.error}</Note> : null}
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
                <Note>a symlink or your own copy; left alone</Note>
              ) : install.skill === "linked" ? (
                <Note>a symlink to the checkout this build came from</Note>
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
  if (install.mod === "custom") return <Note>your own copy is in place; the app leaves it alone</Note>;
  if (install.mod === "linked") return <Note>development build — the daemon runs this checkout's mod/boot.ts</Note>;
  if (install.mod === "skipped") return <Note>development build — the app's own copy is in place; set LOKI_INSTALL=1 to refresh it</Note>;
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
    <Block help="flashcards written in the background from conversations that have gone quiet, and the leads it proposes. The writer is off until you switch it on.">
      {snap ? (
        <RecallSettings worker={snap.worker} onSettings={(s) => void recall.settings(s)} onRun={() => void recall.run()} running={recall.running} />
      ) : (
        <Setting label="Card writer" help={recall.error ?? "loading…"} />
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
}: {
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  onChatPlacement: (p: ChatPlacement) => void;
  approvals: McpApi["approvals"] | null;
}) {
  return (
    <>
      <Block title="Chat panel">
        <Setting label="Position" help="Where the chat sits on the canvas. An empty canvas opens it centred until the first widget lands.">
          <Segmented label="position" options={CHAT_PLACEMENTS} value={chatPlacement} onPick={onChatPlacement} labels={{ center: "centre" }} />
        </Setting>
        <Setting label="Width at the side" help="When the chat sits on the left or the right.">
          <Segmented label="width at the side" options={CHAT_WIDTHS} value={chatWidth} onPick={onChatWidth} />
        </Setting>
      </Block>
      <Block title="Always allowed" help="tools that run without asking, in every chat and every mode but strict.">
        {approvals ? <AlwaysAllowed api={approvals} /> : <Setting label="Not linked" help="loki's daemon is not linked yet." />}
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

/** Settings › inbox: what Next, Archive and a reply do, and how the deck orders its cards behind a fold. */
function InboxPage() {
  return (
    <>
      <Block help="every chat you have not archived, except one whose agent is mid-turn: a chat is not done until it is archived. The card in front of you never moves until you act on it.">
        <Setting
          label="Next"
          help={`Reads the card and rests it. A card with nothing new comes back in ${REST_FIRST_MS / 60_000} minutes, then ${REST_GROWTH} times longer each Next in a row, up to a week; anything new from the agent brings it back at once.`}
        >
          <Kbd>{keyFor("inbox.next")}</Kbd>
        </Setting>
        <Setting label="Archive" help="Done: the chat leaves the Inbox. Undo brings it back.">
          <Kbd>{keyFor("inbox.archive")}</Kbd>
        </Setting>
        <Setting label="A reply" help="Keeps the card, so the answer streams in where you are; Next moves on, and the answer then brings the card back." />
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
          <Score>{`up to +${FOCUS_POINTS}`}</Score>
        </Setting>
        <Setting label="Age" help="Off for most cards, so old ones drift down; on for blocked cards, so the agent that has waited longest comes first.">
          <Score>±0.1 an hour</Score>
        </Setting>
      </Fold>
    </>
  );
}

/** A score on the right of an Inbox row: what the rule adds. */
function Score({ children }: { children: string }) {
  return <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)" }}>{children}</span>;
}

/** Settings › About: every folder and file loki keeps, folded shut (was a page of its own until plan 031). */
function FilesFold() {
  return (
    <Fold title="Where loki keeps things">
      <Fact label="Widgets" value={`${HOME}/widgets/<chat>/`} mono />
      <Fact label="Layout" value={`${HOME}/state/<chat>.json`} mono />
      <Fact label="Inbox marks" value={`${HOME}/state/attention.json`} mono />
      <Fact label="Pictures" value={`${HOME}/chat-images/`} mono />
      <Fact label="Learn" value={`${HOME}/recall/  (cards, schedule and the deleted pile)`} mono />
      <Fact label="Tasks" value={`${HOME}/tasks  (beads · bd, embedded Dolt, prefix lk)`} mono />
      <Fact label="Token" value={`${HOME}/token`} mono />
      <Fact label="Logs" value={`${HOME}/mod.log · ${HOME}/logs/daemon.log`} mono />
      <Fact label="Mod · canvas" value={`${HOME}/mod/  ·  ${HOME}/app/  (installed from the app bundle at launch)`} mono />
    </Fold>
  );
}

/** The system-wide key as its row names it; it exists on the Mac only (global.inbox has no key elsewhere). */
const GLOBAL_KEY = `${formatKeys("alt", "macos")}Space`;

/** Settings › keys: ⌥Space held or released on the Mac; a browser tab cannot hold it, and Windows and Linux have none yet (R3). */
export function GlobalKeyRow({ shortcut, os = platform }: { shortcut: GlobalShortcut; os?: Platform }) {
  if (os !== "macos") return <Fact label="System-wide" value={notYetOn("The system-wide key", os)} />;
  return (
    <Fact
      label={GLOBAL_KEY}
      value={
        shortcut.available ? (
          <span style={{ display: "inline-grid", gap: 4 }}>
            <Switch on={shortcut.enabled} onToggle={() => shortcut.set(!shortcut.enabled)} label="bring loki up on the inbox from anywhere on the Mac" />
            {shortcut.error ? (
              <Note tone="warn">{`macOS refused it — another app (Raycast, Alfred, the input-source switcher) holds ${GLOBAL_KEY}; free it there and switch this off and on`}</Note>
            ) : (
              <Note>off, if another app wants the key or you type non-breaking spaces with it</Note>
            )}
          </span>
        ) : (
          "the app only — a browser tab cannot hold a system-wide key"
        )
      }
    />
  );
}

/** Settings › keyboard shortcuts: ⌥Space, then every key loki has, found by what it does, its keys or where it works. */
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
            placeholder="search keys"
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
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
            <tbody>
              {rows.map((b, i, rows) => (
                <tr key={b.id} style={{ borderTop: i > 0 && rows[i - 1].where !== b.where ? "1px solid var(--loki-border)" : undefined }}>
                  <td className="loki-label" style={{ padding: "6px 0", width: 90, verticalAlign: "top", paddingTop: 9 }}>
                    {i === 0 || rows[i - 1].where !== b.where ? sentence(b.where) : ""}
                  </td>
                  <td
                    style={{
                      padding: "6px 12px 6px 0",
                      width: 170,
                      fontFamily: "var(--loki-mono)",
                      fontSize: 12,
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
                      <span style={{ marginLeft: 8, fontSize: 10.5, opacity: 0.7 }}>not while typing</span>
                    ) : null}
                    {b.was && (
                      <span className="loki-meta loki-meta--wrap" style={{ display: "block" }}>
                        {wasFor(b)}
                      </span>
                    )}
                    {takenBy(b).map((t) => (
                      <span
                        key={t.id}
                        className="loki-meta loki-meta--wrap"
                        style={{ display: "block" }}
                      >{`not in the ${t.where}: there ${formatKeys(t.key)} is ${t.label}`}</span>
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
  return <span style={{ marginLeft: 8, fontSize: 12, color: tone === "warn" ? "var(--loki-negative)" : "var(--loki-muted)" }}>{children}</span>;
}

function InstallState({ s }: { s: string }) {
  const color = s === "error" ? "var(--loki-negative)" : s === "custom" || s === "skipped" ? "var(--loki-muted)" : "var(--loki-positive)";
  return <span style={{ color, fontSize: 12, fontWeight: 600 }}>{sentence(s)}</span>;
}

function Status({ s }: { s: string }) {
  const color = s === "open" ? "var(--loki-positive)" : s === "connecting" ? "var(--loki-accent)" : "var(--loki-negative)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color, fontSize: 12, fontWeight: 600 }}>
      <Dot color={color} />
      {sentence(s)}
    </span>
  );
}
