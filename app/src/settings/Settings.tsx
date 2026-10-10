import type { Replies, RequestResult } from "../../../core/frames.ts";
import { useEffect, useState } from "react";
import { inTauri, keyboard, modBase, notYetOn, platform, systemName, type Platform } from "../desk/env";
import { formatKeys, keyFor, keyRows, registerActions, takenBy, wasFor } from "../shell/keymap";
import { lokiUpgrade, osWords, runsOn } from "../shell/osWords";
import { Button, Chip, Dot, IconButton, Sheet, Switch, Title, sentence } from "../components";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { Providers } from "./Providers";
import { Phone, type PhoneApi } from "./Phone";
import { Skills, type GlobalSkillsApi } from "./Skills";
import type { DaemonStatus } from "../shell/bootstrap";
import { useHarnessFacts, type InstallReport } from "../shell/useHarnessFacts";
import type { LokiUpdate } from "../shell/useLokiUpdate";
import type { GlobalShortcut } from "../shell/useGlobalShortcut";
import type { Recall as RecallModel } from "../shell/useRecall";
import { RecallSettings } from "../recall/RecallParts";
import { BLOCKED_POINTS, FOCUS_POINTS, NEW_POINTS } from "../../../core/attention/priority.ts";
import { FOCUS_HALF_LIFE_H } from "../../../core/attention/focus.ts";
import { ThemeChoice } from "./ThemeChoice";
import { PAGES, SETTINGS_PAGE_KEY, pageTitle, savedPage, type SettingsPage } from "./pages";
import { PageList } from "./PageList";
import { useTheme } from "../theme";

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
    <Sheet label="Preferences" onClose={onClose} width="min(1000px, 92vw)" height="min(720px, 88vh)" top="max(16px, calc((100vh - min(720px, 88vh)) / 2))" cardProps={{ "data-preferences": "" }}>
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
  importLetta = null,
  onConnectProvider,
  onDisconnectProvider,
  onModelsChanged,
  daemon,
  phone,
  globalSkills,
  update,
  shortcut,
  recall,
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
  /** The one-time import from Letta into loki's daemon. */
  importLetta?: (() => Promise<RequestResult<Replies["chat_imported"]>>) | null;
  onConnectProvider: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnectProvider: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
  /** loki's daemon as the shell sees it: the Node it runs on, or why it could not start (null in a browser tab). */
  daemon: DaemonStatus | null;
  /** The LAN listener and paired phones (useDesk().phone). */
  phone: PhoneApi;
  /** ~/.agents/skills, which every agent reads (Settings › skills). */
  globalSkills: GlobalSkillsApi;
  /** Newer loki releases, from GitHub (Settings › loki). */
  update: LokiUpdate;
  /** ⌥Space, held or released (Settings › keys). */
  shortcut: GlobalShortcut;
  /** The card writer's switch and knobs (Settings › learn). */
  recall: RecallModel;
  /** The close button in the page's header (Preferences); none without it. */
  onClose?: () => void;
}) {
  const harness = useHarnessFacts();
  const [page, setPage] = useState<SettingsPage>(() => savedPage(sessionStorage.getItem(PAGE_KEY)));
  const pick = (p: SettingsPage) => {
    setPage(p);
    sessionStorage.setItem(PAGE_KEY, p);
  };
  // ⌘[ and ⌘] step the pages (settings.prevPage / settings.nextPage in the keymap), wrapping at the ends.
  useEffect(() => {
    const step = (d: 1 | -1) => pick(PAGES[(PAGES.findIndex((p) => p.id === page) + d + PAGES.length) % PAGES.length].id);
    return registerActions({ "settings.prevPage": () => step(-1), "settings.nextPage": () => step(1) });
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", flex: 1, minHeight: 0 }}>
      {/* One page at a time: the section list on the left, the page on the right. The page is remembered for the window. */}
      <nav aria-label="Preferences" style={{ display: "grid", alignContent: "start", gap: 2, padding: "16px 10px", overflowY: "auto", borderRight: "1px solid var(--loki-border)" }}>
        <h2 className="loki-title" style={{ margin: 0, padding: "4px 10px 12px" }}>
          Preferences
        </h2>
        <PageList page={page} onPick={pick} extra={(p) => (p === "phone" && phone.status?.enabled ? <Dot aria-label="on" color="var(--loki-positive)" style={{ marginLeft: 8, verticalAlign: "middle" }} /> : null)} />
      </nav>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--loki-bg)" }}>
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, minHeight: 48, padding: "0 12px 0 28px", borderBottom: "1px solid var(--loki-border)" }}>
          <h3 className="loki-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
            {pageTitle(page)}
          </h3>
          {onClose && (
            <IconButton size={28} onClick={onClose} label="Close preferences" style={{ fontSize: 17 }}>
              ×
            </IconButton>
          )}
        </div>
        {/* Keyed by page so a new page starts at its top. */}
        <div key={page} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 28px 40px", display: "grid", gap: 28, alignContent: "start" }}>
          {page === "loki" && <LokiPage update={update} harness={harness} daemon={daemon} modConnection={modConnection} deskCount={deskCount} importLetta={importLetta} />}
          {page === "inbox" && <InboxPage />}
          {page === "providers" && <ProvidersPage chatLink={chatLink} providers={providers} onLoadProviders={onLoadProviders} onConnectProvider={onConnectProvider} onDisconnectProvider={onDisconnectProvider} onModelsChanged={onModelsChanged} />}
          {page === "phone" && <PhonePage phone={phone} modConnection={modConnection} />}
          {page === "skills" && <SkillsPage globalSkills={globalSkills} />}
          {page === "learn" && <RecallPage recall={recall} />}
          {page === "appearance" && <AppearancePage />}
          {page === "chat" && <ChatPage chatWidth={chatWidth} onChatWidth={onChatWidth} chatPlacement={chatPlacement} onChatPlacement={onChatPlacement} />}
          {page === "files" && <FilesPage />}
          {page === "keys" && <KeysPage shortcut={shortcut} />}
          <div className="loki-label" style={{ textAlign: "center", paddingTop: 12 }}>
            loki {__LOKI_VERSION__} · {inTauri ? "tauri shell" : "browser tab"}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearancePage() {
  const theme = useTheme();
  return (
    <Section title="Appearance" hint={`the colors on this device; system follows ${systemName(keyboard)} as it changes`}>
      <Fact label="Theme" value={<ThemeChoice />} />
      <Fact label="Using" value={theme.preference === "system" ? `${theme.resolved}, from the system` : theme.resolved} />
    </Section>
  );
}

/** Settings › loki: this app, the import from Letta, the mod, what loki needs on this machine, and what launch installed. */
function LokiPage({ update, harness, daemon, modConnection, deskCount, importLetta }: { update: LokiUpdate; harness: ReturnType<typeof useHarnessFacts>; daemon: DaemonStatus | null; modConnection: ModConnection; deskCount: number; importLetta: (() => Promise<RequestResult<Replies["chat_imported"]>>) | null }) {
  return (
    <>
      <Section title="loki" hint="this app; the only update it ever offers on its own">
        <LokiVersionFact update={update} />
      </Section>
      {importLetta && (
        <Section title="Import" hint="your agents, their memory and chats, keys and schedules, from Letta into loki; Letta's own files are left as they are">
          <ImportFact run={importLetta} />
        </Section>
      )}
      <Section title="Mod" hint="canvas layout, widget files, transcripts and chats, served by loki's daemon">
        <Fact label="Endpoint" value={modBase()} mono />
        <Fact label="Link" value={<Status s={modConnection} />} />
        <Fact label="Chats" value={String(deskCount)} />
      </Section>
      <Section title="Requirements" hint="what loki needs on this machine, and where it found it">
        {inTauri && <NodeFact daemon={daemon} />}
        <Fact label="bd (beads)" value={harness.tools ? harness.tools.bd ?? <Note tone="warn">{`not found — ${osWords().beadsInstall} (the board needs it; everything else works without)`}</Note> : "—"} mono />
        <SystemFact />
      </Section>
      {inTauri && <InstallSection install={harness.install} />}
    </>
  );
}

/** The Node the daemon runs on, or why the daemon could not start. */
function NodeFact({ daemon }: { daemon: DaemonStatus | null }) {
  const value = !daemon ? "—" : daemon.error ? <Note tone="warn">{daemon.error}</Note> : daemon.node ?? "starting…";
  return <Fact label="Node" value={value} mono={!!daemon?.node && !daemon.error} />;
}

/** Where loki runs, said plainly (in a browser tab, that the tab is only a view of it), over what that system needs. */
export function SystemFact({ os = platform, shell = inTauri }: { os?: Platform; shell?: boolean }) {
  return <Fact label="System" value={<span>{runsOn(os, shell)}<Note>{osWords(os).system}</Note></span>} />;
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
        a preview build: built and tested in CI, not yet tried on real machines{update.issues ? <> — <a href={update.issues}>report problems</a></> : null}
      </Note>
    );
  const value = update.newer ? (
    <span>
      {update.current} · <a href={update.url ?? "#"}>{update.latest} is out</a>
      <Note>{os === "macos" ? upgrade : <a href={update.download ?? update.url ?? "#"}>{upgrade}</a>}</Note>
      {preview}
    </span>
  ) : update.latest ? (
    <span>{update.current}<Note>{update.channel === "nightly" ? "the newest nightly" : "the newest release"}</Note>{preview}</span>
  ) : (
    <span>{update.current}{update.error ? <Note>could not check for a newer release — {update.error}</Note> : null}{preview}</span>
  );
  return <Fact label="Version" value={value} />;
}

/** Run the import from Letta, then say what came over; again imports only what is missing. */
function ImportFact({ run }: { run: () => Promise<RequestResult<Replies["chat_imported"]>> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RequestResult<Replies["chat_imported"]> | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      setResult(await run());
    } finally {
      setBusy(false);
    }
  };
  const done = result?.ok ? result.reply : null;
  return (
    <>
      <Fact
        label="From Letta"
        value={
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <Button size="sm" onClick={() => void go()} disabled={busy}>{busy ? "importing…" : done ? "import again" : "import"}</Button>
            {result && !result.ok && <Note tone="warn">{result.error}</Note>}
            {done && <Note>{`${done.agents.length} agents, ${done.chats} chats${done.kept ? ` (${done.kept} already here)` : ""}, ${done.credentials.length} keys, ${done.schedules} schedules`}</Note>}
          </span>
        }
      />
      {done?.notes.map((n) => <Fact key={n} label="" value={<Note>{n}</Note>} />)}
    </>
  );
}

/** In the shell only: what launch did about the mod and the skill. */
function InstallSection({ install }: { install: InstallReport | null }) {
  return (
    <Section title="Install" hint="on launch the app puts its mod, its daemon, the phone canvas and the skill in place">
      <ModFact install={install} />
      {install?.mod_path ? <Fact label={install.mod === "linked" ? "Imports" : "Bundle"} value={install.mod_path} mono /> : null}
      <Fact label="Canvas" value={install ? <InstallState s={install.app} /> : "—"} />
      {install?.app_path ? <Fact label="Canvas path" value={install.app_path} mono /> : null}
      <Fact label="Skill" value={install ? <span><InstallState s={install.skill} /> {install.skill === "custom" ? <Note>a symlink or your own copy; left alone</Note> : install.skill === "linked" ? <Note>a symlink to the checkout this build came from</Note> : null}</span> : "—"} />
      <Fact label="Skill path" value={install?.skill_path ?? "~/.agents/skills/loki"} mono />
      {install?.error ? <Fact label="Error" value={<span style={{ color: "var(--loki-negative)" }}>{install.error}</span>} /> : null}
    </Section>
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
  return <Fact label="Mod" value={install ? <span><InstallState s={install.mod} /> {modNote(install)}</span> : "—"} />;
}

function ProvidersPage({ chatLink, providers, onLoadProviders, onConnectProvider, onDisconnectProvider, onModelsChanged }: { chatLink: ChatLink; providers: ConnectProvider[] | null; onLoadProviders: () => Promise<unknown>; onConnectProvider: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>; onDisconnectProvider: (providerId: string) => Promise<string | null>; onModelsChanged: () => void }) {
  return (
    <Section title="Providers" hint="who answers the models; keys are checked, then kept in this computer's keychain">
      {chatLink === "open" ? <Providers providers={providers} onLoad={onLoadProviders} onConnect={onConnectProvider} onDisconnect={onDisconnectProvider} onChanged={onModelsChanged} /> : <Fact label="Link" value="loki's daemon is not linked yet" />}
    </Section>
  );
}

function PhonePage({ phone, modConnection }: { phone: PhoneApi; modConnection: ModConnection }) {
  return (
    <Section title="Phone" hint={platform === "macos" ? "the inbox on a phone, over Tailscale or this Wi‑Fi; nothing to install" : undefined}>
      <Phone phone={phone} connected={modConnection === "open"} />
    </Section>
  );
}

function SkillsPage({ globalSkills }: { globalSkills: GlobalSkillsApi }) {
  return (
    <Section title="Skills" hint="~/.agents/skills — every agent reads these; an agent's own skills are on its page">
      <Skills api={globalSkills} />
    </Section>
  );
}

function RecallPage({ recall }: { recall: RecallModel }) {
  const { snap } = recall;
  // Settings may open before Learn ever did: ask for the snapshot once.
  useEffect(() => {
    if (!snap) void recall.refresh();
  }, [snap, recall]);
  return (
    <Section title="Learn" hint="flashcards written in the background from conversations that have gone quiet, and the leads it proposes; the writer is off until you switch it on">
      {snap ? <RecallSettings worker={snap.worker} onSettings={(s) => void recall.settings(s)} onRun={() => void recall.run()} running={recall.running} /> : <Fact label="Writer" value={recall.error ?? "loading…"} />}
    </Section>
  );
}

function ChatPage({ chatWidth, onChatWidth, chatPlacement, onChatPlacement }: { chatWidth: ChatWidth; onChatWidth: (w: ChatWidth) => void; chatPlacement: ChatPlacement; onChatPlacement: (p: ChatPlacement) => void }) {
  return (
    <Section title="Chat" hint="how the panel sits on the sheet">
      <Fact label="Position" value={<Choice options={CHAT_PLACEMENTS} value={chatPlacement} onPick={onChatPlacement} labels={{ center: "centre" }} />} />
      <Fact label="Side width" value={<Choice options={["narrow", "wide"] as ChatWidth[]} value={chatWidth} onPick={onChatWidth} />} />
      <Fact label="Empty canvas" value="opens the chat centred until the first widget lands" />
    </Section>
  );
}

/** Settings › inbox: how the deck orders its cards. */
function InboxPage() {
  return (
    <>
      <Section title="Order" hint="one score per card, one list; the card in front of you never moves until you act on it">
        <Fact label="In it" value="every chat you have not archived, except one whose agent is mid-turn: a chat is not done until it is archived" />
        <Fact label="Blocked" value={`+${BLOCKED_POINTS} — an approval or a question: an agent is stopped until you answer`} />
        <Fact label="New" value={`+${NEW_POINTS} — the agent said something since you last looked`} />
        <Fact label="Focus" value={`up to +${FOCUS_POINTS} — the chat's share of what you have been doing lately: your messages, answers, decisions and reads, each fading by half every ${FOCUS_HALF_LIFE_H} hours. Learned from you: the task you are on rises, one you have moved on from fades`} />
        <Fact label="Age" value="a tenth of a point per hour: off for most cards, so old ones drift down; on for blocked cards, so the agent that has waited longest comes first" />
        <Fact label="Next" value={`${keyFor("inbox.next")} reads the card and moves on; the chat stays for your next visit, in its place by score`} />
        <Fact label="Archive" value={`${keyFor("inbox.archive")} is done: the chat leaves the Inbox (undo brings it back)`} />
        <Fact label="A reply" value={`keeps the card, so the answer streams in where you are; ${keyFor("inbox.next")} moves on, and the answer then brings the card back by score`} />
      </Section>
    </>
  );
}

function FilesPage() {
  return (
    <Section title="Files" hint="everything loki keeps, in one folder">
      <Fact label="Widgets" value={`${HOME}/widgets/<chat>/`} mono />
      <Fact label="Layout" value={`${HOME}/state/<chat>.json`} mono />
      <Fact label="Inbox marks" value={`${HOME}/state/attention.json`} mono />
      <Fact label="Board" value={`${HOME}/board  (beads · bd, embedded Dolt, prefix lk)`} mono />
      <Fact label="Token" value={`${HOME}/token`} mono />
      <Fact label="Logs" value={`${HOME}/mod.log · ${HOME}/logs/daemon.log`} mono />
      <Fact label="Mod · canvas" value={`${HOME}/mod/  ·  ${HOME}/app/  (installed from the app bundle at launch)`} mono />
    </Section>
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
            {shortcut.error ? <Note tone="warn">{`macOS refused it — another app (Raycast, Alfred, the input-source switcher) holds ${GLOBAL_KEY}; free it there and switch this off and on`}</Note> : <Note>off, if another app wants the key or you type non-breaking spaces with it</Note>}
          </span>
        ) : (
          "the app only — a browser tab cannot hold a system-wide key"
        )
      }
    />
  );
}

function KeysPage({ shortcut }: { shortcut: GlobalShortcut }) {
  return (
    <Section title="Keys" hint={keyboard === "macos" ? `${formatKeys("cmd")} here is ctrl on other systems` : undefined}>
      <GlobalKeyRow shortcut={shortcut} />
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
        <tbody>
          {keyRows().map((b, i, rows) => (
            <tr key={b.id} style={{ borderTop: i > 0 && rows[i - 1].where !== b.where ? "1px solid var(--loki-border)" : undefined }}>
              <td className="loki-label" style={{ padding: "6px 0", width: 90, verticalAlign: "top", paddingTop: 9 }}>{i === 0 || rows[i - 1].where !== b.where ? sentence(b.where) : ""}</td>
              <td style={{ padding: "6px 12px 6px 0", width: 170, fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)", whiteSpace: "nowrap" }}>{b.keys.map((k) => formatKeys(k)).join(" · ")}</td>
              <td style={{ padding: "6px 0", color: "var(--loki-muted)" }}>
                {b.label}
                {b.typing ? "" : b.where === "inbox" || b.where === "desk" ? <span style={{ marginLeft: 8, fontSize: 10.5, opacity: 0.7 }}>not while typing</span> : null}
                {b.was && <span className="loki-meta loki-meta--wrap" style={{ display: "block" }}>{wasFor(b)}</span>}
                {takenBy(b).map((t) => (
                  <span key={t.id} className="loki-meta loki-meta--wrap" style={{ display: "block" }}>{`not in the ${t.where}: there ${formatKeys(t.key)} is ${t.label}`}</span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** A numeric setting on a Fact row: typed, applied on blur when it reads as a number inside its range (the mod clamps too), with a hint beside it. */

function Choice<T extends string>({ options, value, onPick, labels = {} }: { options: T[]; value: T; onPick: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      {options.map((o) => (
        <Chip key={o} label active={value === o} onClick={() => onPick(o)} aria-pressed={value === o}>
          {labels[o] ?? o}
        </Chip>
      ))}
    </span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "6px 24px", alignItems: "start" }}>
      <div style={{ paddingTop: 2 }}>
        <Title>{title}</Title>
        {hint && <div className="loki-meta loki-meta--wrap" style={{ marginTop: 4, lineHeight: 1.45 }}>{sentence(hint)}</div>}
      </div>
      <div style={{ display: "grid", gap: 6, borderLeft: "1px solid var(--loki-border)", paddingLeft: 20 }}>{children}</div>
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "baseline", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label">{label}</span>
      <span style={{ color: "var(--loki-fg)", fontFamily: mono ? "var(--loki-mono)" : undefined, fontSize: mono ? 12 : 13.5, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

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
