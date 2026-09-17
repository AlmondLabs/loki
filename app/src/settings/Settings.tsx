import { useEffect, useState } from "react";
import { inTauri, modBase } from "../desk/env";
import { KEYMAP, WHERE_ORDER, formatKeys, registerActions } from "../shell/keymap";
import { Button, Chip, Dot, Field, Meta, NavButton, Switch, Title } from "../components";
import type { Scratch } from "../shell/useScratch";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import { MIN_LETTA_CODE, TESTED_LETTA_CODE, UPGRADE_LINE, lettaStanding } from "../../../core/compat.ts";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { Providers } from "./Providers";
import { Phone, type PhoneApi } from "./Phone";
import { Skills, type GlobalSkillsApi } from "./Skills";
import type { BootstrapStatus } from "../shell/bootstrap";
import { useHarnessFacts, type InstallReport, type Tools } from "../shell/useHarnessFacts";
import type { LokiUpdate } from "../shell/useLokiUpdate";
import type { GlobalShortcut } from "../shell/useGlobalShortcut";
import type { Recall as RecallModel } from "../shell/useRecall";
import { RecallSettings } from "../recall/RecallParts";
import { BLOCKED_POINTS, WARM_POINTS, YOURS_POINTS } from "../../../core/attention/priority.ts";
import { LADDER_RANGE, formatGap, ladderSteps, type SnoozeLadder } from "../../../core/attention/ladder.ts";

const HOME = "~/.letta/loki";

/** The pages down the left. "letta" gathers what loki runs on: harness, mod, requirements, install. */
export type SettingsPage = "letta" | "inbox" | "providers" | "phone" | "skills" | "learn" | "chat" | "files" | "keys";
export const PAGES: Array<{ id: SettingsPage }> = [{ id: "letta" }, { id: "inbox" }, { id: "providers" }, { id: "phone" }, { id: "skills" }, { id: "learn" }, { id: "chat" }, { id: "files" }, { id: "keys" }];

/** Settings › inbox: the "later" ladder in force and its setter (useDesk().attention). */
export interface InboxSettingsApi {
  ladder: SnoozeLadder;
  onLadder: (input: Partial<SnoozeLadder>) => void;
}
const PAGE_KEY = "loki.settingsPage";
export function isSettingsPage(v: unknown): v is SettingsPage {
  return PAGES.some((p) => p.id === v);
}

type AppServerStatus = "connecting" | "open" | "closed" | "unavailable";
type ModConnection = "connecting" | "open" | "closed";

/** Who runs the app-server, read off its address. */
function describeRunner(appServerUrl: string | null): string {
  const viaTunnel = !!appServerUrl && appServerUrl.includes("/appserver");
  const ownHarness = !!appServerUrl && /:41600\//.test(appServerUrl);
  return !appServerUrl ? "not found" : viaTunnel ? "whichever harness the mod found — this tab reaches it through the mod's tunnel" : ownHarness ? "loki's own harness (letta server --listen), launched now or by an earlier run" : "a harness loki did not launch — Letta Desktop, or a letta server you started; loki attached to it instead of launching its own";
}

/**
 * Settings: the facts that had no home — which harness the app is on, how it reaches
 * the mod, where the files are — a couple of preferences, and the keymap.
 */
export function Settings({
  appServerStatus,
  tunnelUrl,
  modConnection,
  deskCount,
  chatWidth,
  onChatWidth,
  chatPlacement,
  onChatPlacement,
  lettaVersion,
  providers,
  onLoadProviders,
  onConnectProvider,
  onDisconnectProvider,
  onModelsChanged,
  bootstrap,
  onInstallLetta,
  onCheckLetta,
  onUpdateLetta,
  phone,
  globalSkills,
  update,
  shortcut,
  recall,
  scratch,
  inbox,
}: {
  appServerStatus: AppServerStatus;
  tunnelUrl: string | null;
  modConnection: ModConnection;
  deskCount: number;
  chatWidth: ChatWidth;
  onChatWidth: (w: ChatWidth) => void;
  chatPlacement: ChatPlacement;
  onChatPlacement: (p: ChatPlacement) => void;
  /** From the harness's app_server_info reply. */
  lettaVersion: string | null;
  providers: ConnectProvider[] | null;
  onLoadProviders: () => Promise<unknown>;
  onConnectProvider: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>;
  onDisconnectProvider: (providerId: string) => Promise<string | null>;
  onModelsChanged: () => void;
  bootstrap: BootstrapStatus | null;
  onInstallLetta: () => Promise<void>;
  /** Settings › letta: ask npm for the newest Letta Code, and pull it (restarting the harness). Each resolves to an error line or null. */
  onCheckLetta: () => Promise<string | null>;
  onUpdateLetta: () => Promise<string | null>;
  /** The LAN listener and paired phones (useDesk().phone). */
  phone: PhoneApi;
  /** ~/.letta/skills, which every agent reads (Settings › skills). */
  globalSkills: GlobalSkillsApi;
  /** Newer loki releases, from GitHub (Settings › letta). */
  update: LokiUpdate;
  /** ⌥Space, held or released (Settings › keys). */
  shortcut: GlobalShortcut;
  /** The card writer's switch and knobs (Settings › learn). */
  recall: RecallModel;
  /** The harness's scratch folder (Settings › letta). */
  scratch: Scratch;
  /** The deck's "later" ladder (Settings › inbox). */
  inbox: InboxSettingsApi;
}) {
  const harness = useHarnessFacts(tunnelUrl);
  const [page, setPage] = useState<SettingsPage>(() => {
    const saved = sessionStorage.getItem(PAGE_KEY);
    return isSettingsPage(saved) ? saved : "letta";
  });
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
    <div style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "28px 40px 60px", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "grid", gridTemplateColumns: "150px 1fr", gap: "0 32px", alignItems: "start" }}>
      {/* One page at a time: the list on the left, its sections on the right. The page is remembered for the window. */}
      <nav aria-label="settings pages" style={{ display: "grid", alignContent: "start", gap: 2, paddingTop: 4 }}>
        {PAGES.map((p) => (
          <NavButton key={p.id} onClick={() => pick(p.id)} current={page === p.id}>
            {p.id}
            {p.id === "phone" && phone.status?.enabled ? <Dot aria-label="on" color="var(--loki-accent)" style={{ marginLeft: 8, verticalAlign: "middle" }} /> : null}
          </NavButton>
        ))}
      </nav>
      <div style={{ display: "grid", gap: 28, alignContent: "start", minWidth: 0 }}>
        {page === "letta" && <LettaPage update={update} harness={harness} appServerStatus={appServerStatus} modConnection={modConnection} deskCount={deskCount} lettaVersion={lettaVersion} bootstrap={bootstrap} onInstallLetta={onInstallLetta} onCheckLetta={onCheckLetta} onUpdateLetta={onUpdateLetta} scratch={scratch} />}
        {page === "inbox" && <InboxPage inbox={inbox} />}
        {page === "providers" && <ProvidersPage appServerStatus={appServerStatus} providers={providers} onLoadProviders={onLoadProviders} onConnectProvider={onConnectProvider} onDisconnectProvider={onDisconnectProvider} onModelsChanged={onModelsChanged} />}
        {page === "phone" && <PhonePage phone={phone} modConnection={modConnection} />}
        {page === "skills" && <SkillsPage globalSkills={globalSkills} />}
        {page === "learn" && <RecallPage recall={recall} />}
        {page === "chat" && <ChatPage chatWidth={chatWidth} onChatWidth={onChatWidth} chatPlacement={chatPlacement} onChatPlacement={onChatPlacement} />}
        {page === "files" && <FilesPage />}
        {page === "keys" && <KeysPage shortcut={shortcut} />}
          <div className="loki-label" style={{ fontSize: 9.5, textAlign: "center", paddingTop: 12 }}>
            loki {__LOKI_VERSION__} · {inTauri ? "tauri shell" : "browser tab"}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Settings › letta: the harness, the mod, what loki needs on this machine, and what launch installed. */
function LettaPage({ update, harness, appServerStatus, modConnection, deskCount, lettaVersion, bootstrap, onInstallLetta, onCheckLetta, onUpdateLetta, scratch }: { update: LokiUpdate; harness: ReturnType<typeof useHarnessFacts>; appServerStatus: AppServerStatus; modConnection: ModConnection; deskCount: number; lettaVersion: string | null; bootstrap: BootstrapStatus | null; onInstallLetta: () => Promise<void>; onCheckLetta: () => Promise<string | null>; onUpdateLetta: () => Promise<string | null>; scratch: Scratch }) {
  // Never print the token: a browser tab's tunnel URL carries it as a query.
  const shownUrl = harness.appServerUrl ? harness.appServerUrl.replace(/\?.*$/, "") : null;
  return (
    <>
      <Section title="loki" hint="this app; the only update it ever offers on its own">
        <LokiVersionFact update={update} />
      </Section>
      <Section title="harness" hint="the Letta process loki talks to; the mod runs inside it">
        <Fact label="app-server" value={shownUrl ?? "—"} mono />
        <Fact label="who runs it" value={describeRunner(harness.appServerUrl)} />
        <Fact label="link" value={<Status s={appServerStatus} />} />
      </Section>
      <Section title="scratch" hint="where Letta's Bash tool keeps background output; dreaming runs sandboxed and may only write under ~/.letta">
        <ScratchFacts scratch={scratch} />
      </Section>
      <Section title="mod" hint="desk layout, widget files, transcripts">
        <Fact label="endpoint" value={modBase()} mono />
        <Fact label="link" value={<Status s={modConnection} />} />
        <Fact label="desks" value={String(deskCount)} mono />
      </Section>
      <Section title="requirements" hint="what loki needs on this machine, and where it found it">
        <LettaCodeFact lettaVersion={lettaVersion} tools={harness.tools} />
        <LettaCliFact bootstrap={bootstrap} tools={harness.tools} onInstallLetta={onInstallLetta} />
        {inTauri && <LettaUpdateFact bootstrap={bootstrap} onCheck={onCheckLetta} onUpdate={onUpdateLetta} />}
        <Fact label="bd (beads)" value={harness.tools ? harness.tools.bd ?? <Note tone="warn">not found — brew install beads (the board needs it; everything else works without)</Note> : "—"} mono />
        <Fact label="system" value="macOS 13 or later; the shell finds Letta Desktop with lsof and picks folders with osascript" />
      </Section>
      {inTauri && <InstallSection install={harness.install} />}
    </>
  );
}

/**
 * The scratch folder: loki's harness gets one under ~/.letta (Letta's own default, a system temp folder, is refused
 * by the sandbox its memory subagents run in since 0.31.13, so every dreaming pass failed silently); a `letta`
 * run from a terminal needs its own, because Letta names the files inside by a per-process counter.
 */
function ScratchFacts({ scratch }: { scratch: Scratch }) {
  if (!scratch.available) return <Fact label="loki's harness" value="the app only — a browser tab does not launch a harness" />;
  return (
    <>
      <HarnessScratchFact scratch={scratch} />
      <TerminalScratchFact suggestion={scratch.settings?.terminalSuggestion ?? "$HOME/.letta/scratch"} />
    </>
  );
}

/** The folder loki's harness uses: editable, applied with a harness restart, and a way back to the default. */
function HarnessScratchFact({ scratch }: { scratch: Scratch }) {
  const [draft, setDraft] = useState<string | null>(null);
  const s = scratch.settings;
  const shown = draft ?? s?.path ?? "";
  const changed = s ? shown.trim() !== s.path : false;
  const apply = (path: string | null) => void scratch.set(path).then(() => setDraft(null));
  return (
    <Fact
      label="loki's harness"
      value={
        <span style={{ display: "inline-grid", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Field size="sm" mono value={shown} onChange={(e) => setDraft(e.target.value)} placeholder={s?.defaultPath ?? "reading…"} style={{ width: 340 }} aria-label="scratch folder for loki's harness" disabled={!s || scratch.busy} />
            <Button size="sm" tone="brass" disabled={!s || !changed || scratch.busy} onClick={() => apply(shown)} title="saves the folder and restarts the harness on it — a turn in progress stops">
              {scratch.busy ? "restarting…" : "apply, restarting the harness"}
            </Button>
            {s && !s.isDefault && (
              <Button size="sm" bare disabled={scratch.busy} onClick={() => apply(null)}>
                back to the default
              </Button>
            )}
          </span>
          {scratchWord(scratch)}
        </span>
      }
    />
  );
}

/** The line under the field: the shell's error, else where the folder stands against the default. */
function scratchWord(scratch: Scratch): React.ReactNode {
  if (scratch.error) return <Note tone="warn">{scratch.error}</Note>;
  const s = scratch.settings;
  if (!s) return <Note>asking the shell…</Note>;
  return <Note>{s.isDefault ? "the default; emptied each time the harness starts" : `default ${s.defaultPath}`}</Note>;
}

/** The export line for a `letta` run from a terminal, with copy. */
function TerminalScratchFact({ suggestion }: { suggestion: string }) {
  const [copied, setCopied] = useState(false);
  const line = `export LETTA_SCRATCHPAD="${suggestion}"`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Fact
      label="your terminal"
      value={
        <span style={{ display: "inline-grid", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <code style={{ fontFamily: "var(--loki-mono)", fontSize: 12 }}>{line}</code>
            <Button size="sm" onClick={() => void copy()}>{copied ? "copied" : "copy"}</Button>
          </span>
          <Note>for a `letta` you run yourself, in its shell profile — a different folder from loki's, since both write task_1.log, task_2.log…</Note>
        </span>
      }
    />
  );
}

/** The app's own version, and the newest release on GitHub once it answered. Homebrew is the upgrade path. */
function LokiVersionFact({ update }: { update: LokiUpdate }) {
  const value = update.newer ? (
    <span>
      {update.current} · <a href={update.url ?? "#"}>{update.latest} is out</a>
      <Note>brew upgrade --cask loki, or the .dmg on the release page</Note>
    </span>
  ) : update.latest ? (
    <span>{update.current}<Note>the newest release</Note></span>
  ) : (
    <span>{update.current}{update.error ? <Note>could not check for a newer release — {update.error}</Note> : null}</span>
  );
  return <Fact label="version" value={value} />;
}

/** The Letta Code the harness reports, against the range loki runs on (core/compat.ts). */
function LettaCodeFact({ lettaVersion, tools }: { lettaVersion: string | null; tools: Tools | null }) {
  return <Fact label="letta code" value={lettaVersion ? <span>harness reports {lettaVersion}<StandingNote version={lettaVersion} /></span> : tools ? (tools.letta ? "harness not linked yet" : <Note tone="warn">not found — the shell installs it with npm on launch</Note>) : "—"} />;
}

/** Where a version stands: the tested release, newer than it (runs; first suspect), older (fine), or below the minimum (upgrade). */
function StandingNote({ version }: { version: string }) {
  const standing = lettaStanding(version);
  if (standing === "tested") return <Note>the release loki was tested with</Note>;
  if (standing === "newer") return <Note tone="warn">newer than the release loki was tested with ({TESTED_LETTA_CODE}) — if something is off, this is the first suspect</Note>;
  if (standing === "too_old") return <Note tone="warn">below the oldest release loki runs on ({MIN_LETTA_CODE}) — in a terminal: {UPGRADE_LINE}</Note>;
  if (standing === "older") return <Note>older than the tested release ({TESTED_LETTA_CODE}); fine down to {MIN_LETTA_CODE}</Note>;
  return null;
}

/**
 * Updating Letta Code from here: "check" asks npm for the newest release; "update" runs the same
 * `npm install -g @letta-ai/letta-code@latest` that installed it and restarts the harness — only when loki
 * launched that harness. loki's harness runs with the self-updater off, so nothing changes under a session;
 * a terminal `letta` updates the same install by itself.
 */
function LettaUpdateFact({ bootstrap, onCheck, onUpdate }: { bootstrap: BootstrapStatus | null; onCheck: () => Promise<string | null>; onUpdate: () => Promise<string | null> }) {
  const [busy, setBusy] = useState<"check" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: "check" | "update", act: () => Promise<string | null>) => {
    setBusy(what);
    setError(await act());
    setBusy(null);
  };
  if (!bootstrap?.letta) return null;
  return (
    <Fact
      label="updates"
      value={
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12 }}>{bootstrap.version ? `installed ${bootstrap.version}` : "installed —"}{bootstrap.latest ? ` · newest ${bootstrap.latest}` : ""}</span>
          {bootstrap.installing ? <Note tone="warn">{bootstrap.log[bootstrap.log.length - 1] ?? "updating…"}</Note> : <UpdateActions bootstrap={bootstrap} busy={busy} onCheck={() => void run("check", onCheck)} onUpdate={() => void run("update", onUpdate)} />}
          <UpdateNotes bootstrap={bootstrap} error={error} />
        </span>
      }
    />
  );
}

/** Check, and update when a newer release exists and this harness is loki's to restart; else the one-line verdict. */
function UpdateActions({ bootstrap, busy, onCheck, onUpdate }: { bootstrap: BootstrapStatus; busy: "check" | "update" | null; onCheck: () => void; onUpdate: () => void }) {
  const { version, latest, managed } = bootstrap;
  const newer = !!latest && !!version && latest !== version;
  return (
    <>
      <Button size="sm" onClick={onCheck} disabled={busy !== null}>{busy === "check" ? "checking…" : "check"}</Button>
      {newer && managed && (
        <Button size="sm" tone="brass" onClick={onUpdate} disabled={busy !== null} title="npm install -g @letta-ai/letta-code@latest, then the harness restarts — a turn in progress stops">
          {busy === "update" ? "updating…" : `update to ${latest}`}
        </Button>
      )}
      {newer && !managed && <Note tone="warn">newer release — this harness is not loki's to restart; in a terminal: {UPGRADE_LINE}, then restart it where it runs</Note>}
      {latest && !newer && version && <Note>up to date</Note>}
    </>
  );
}

/** The footnotes: a newest release beyond the tested one, the how-it-moves reminder before the first check, and any error. */
function UpdateNotes({ bootstrap, error }: { bootstrap: BootstrapStatus; error: string | null }) {
  const { version, latest, installing } = bootstrap;
  const newer = !!latest && !!version && latest !== version;
  const shown = error ?? (installing ? null : bootstrap.error);
  return (
    <>
      {newer && lettaStanding(latest) === "newer" && <Note tone="warn">loki was tested with {TESTED_LETTA_CODE}; a newer release may need a loki update too</Note>}
      {!installing && !latest && !error && <Note>loki's harness never updates itself; this button or a terminal's {UPGRADE_LINE} moves the one install both use</Note>}
      {shown && <Note tone="warn">{shown}</Note>}
    </>
  );
}

/** The letta CLI on this Mac: found where installers put it, being installed with npm, failed (with the install button), or as the tool scan saw it. */
function LettaCliFact({ bootstrap, tools, onInstallLetta }: { bootstrap: BootstrapStatus | null; tools: Tools | null; onInstallLetta: () => Promise<void> }) {
  return <Fact label="letta cli" value={bootstrap ? (bootstrap.letta ? <span>{bootstrap.letta}{bootstrap.explicit ? <Note>named by LOKI_LETTA_BIN — not npm's, so not the update button's to move</Note> : <Note>the Mac's own Letta Code — the same file a terminal runs</Note>}</span> : bootstrap.installing ? <Note tone="warn">installing with npm… {bootstrap.log[bootstrap.log.length - 1] ?? ""}</Note> : <span><Note tone="warn">{bootstrap.error ?? "not found"}</Note> <Button size="sm" onClick={() => void onInstallLetta()} style={{ marginLeft: 8 }}>install</Button> <Note>or, in a terminal: {UPGRADE_LINE}</Note></span>) : tools ? tools.letta ?? <Note tone="warn">not found — {UPGRADE_LINE}</Note> : "—"} mono />;
}

/** In the shell only: what launch did about the mod and the skill. */
function InstallSection({ install }: { install: InstallReport | null }) {
  return (
    <Section title="install" hint="on launch the app puts its mod and skill where Letta looks">
      <ModFact install={install} />
      <Fact label="shim" value={<span>{install?.shim ?? "~/.letta/mods/loki.ts"}<Note>every harness on this Mac loads it; the mod serves the desk only inside one that hosts an app-server (loki's own, Letta Desktop, a letta server) and stands down in a terminal session</Note></span>} mono />
      {install?.mod_path ? <Fact label={install.mod === "linked" ? "imports" : "bundle"} value={install.mod_path} mono /> : null}
      <Fact label="skill" value={install ? <span><InstallState s={install.skill} /> {install.skill === "custom" ? <Note>a symlink or your own copy; left alone</Note> : install.skill === "linked" ? <Note>a symlink to the checkout this build came from</Note> : null}</span> : "—"} />
      <Fact label="skill path" value={install?.skill_path ?? "~/.agents/skills/loki"} mono />
      {install?.error ? <Fact label="error" value={<span style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{install.error}</span>} /> : null}
    </Section>
  );
}

/** The word after the mod's state: what launch found in the shim's place, or what the harness still needs. */
function modNote(install: InstallReport): React.ReactNode {
  if (install.mod === "custom") return <Note>your own shim is in place; the app leaves it alone</Note>;
  if (install.needs_reload) return <Note tone="warn">the harness started before this copy landed: /reload in it, or restart Letta Desktop</Note>;
  if (install.mod === "linked") return <Note>development build — the shim imports this checkout's mod/boot.ts; /reload re-bundles it</Note>;
  if (install.mod === "skipped") return <Note>development build — the app's own copy is in place; set LOKI_INSTALL=1 to refresh it</Note>;
  return null;
}

function ModFact({ install }: { install: InstallReport | null }) {
  return <Fact label="mod" value={install ? <span><InstallState s={install.mod} /> {modNote(install)}</span> : "—"} />;
}

function ProvidersPage({ appServerStatus, providers, onLoadProviders, onConnectProvider, onDisconnectProvider, onModelsChanged }: { appServerStatus: AppServerStatus; providers: ConnectProvider[] | null; onLoadProviders: () => Promise<unknown>; onConnectProvider: (providerId: string, fields: Record<string, string>, authMethodId?: string) => Promise<string | null>; onDisconnectProvider: (providerId: string) => Promise<string | null>; onModelsChanged: () => void }) {
  return (
    <Section title="providers" hint="who answers the models; keys are checked, then kept by Letta on this Mac">
      {appServerStatus === "open" ? <Providers providers={providers} onLoad={onLoadProviders} onConnect={onConnectProvider} onDisconnect={onDisconnectProvider} onChanged={onModelsChanged} /> : <Fact label="link" value="the harness is not linked yet" />}
    </Section>
  );
}

function PhonePage({ phone, modConnection }: { phone: PhoneApi; modConnection: ModConnection }) {
  return (
    <Section title="phone" hint="the inbox on a phone, over Tailscale or this Wi‑Fi; nothing to install">
      <Phone phone={phone} connected={modConnection === "open"} />
    </Section>
  );
}

function SkillsPage({ globalSkills }: { globalSkills: GlobalSkillsApi }) {
  return (
    <Section title="skills" hint="~/.letta/skills — every agent reads these; an agent's own skills are on its page">
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
    <Section title="learn" hint="flashcards written in the background from conversations that have gone quiet, and the leads it proposes; the writer is off until you switch it on">
      {snap ? <RecallSettings worker={snap.worker} onSettings={(s) => void recall.settings(s)} onRun={() => void recall.run()} running={recall.running} /> : <Fact label="writer" value={recall.error ?? "loading…"} />}
    </Section>
  );
}

function ChatPage({ chatWidth, onChatWidth, chatPlacement, onChatPlacement }: { chatWidth: ChatWidth; onChatWidth: (w: ChatWidth) => void; chatPlacement: ChatPlacement; onChatPlacement: (p: ChatPlacement) => void }) {
  return (
    <Section title="chat" hint="how the panel sits on the sheet">
      <Fact label="position" value={<Choice options={CHAT_PLACEMENTS} value={chatPlacement} onPick={onChatPlacement} labels={{ center: "centre" }} />} />
      <Fact label="side width" value={<Choice options={["narrow", "wide"] as ChatWidth[]} value={chatWidth} onPick={onChatWidth} />} />
      <Fact label="empty desk" value="opens the chat centred until the first widget lands" />
    </Section>
  );
}

/** Settings › inbox: how the deck orders its cards, and how long "later" hides one. */
function InboxPage({ inbox }: { inbox: InboxSettingsApi }) {
  return (
    <>
      <Section title="order" hint="one score per card, one list; the card in front of you never moves until you act on it">
        <Fact label="blocked" value={`+${BLOCKED_POINTS} — an approval, a question, a failed turn: an agent is stopped`} />
        <Fact label="warm" value={`+${WARM_POINTS} — the agent spoke under four minutes ago, so its prompt is still cached and a reply now costs a tenth of one typed later`} />
        <Fact label="reply to you" value={`+${YOURS_POINTS} — the turn answers a message you sent, not a scheduled task's prompt`} />
        <Fact label="age" value="a tenth of a point per hour: off for most cards, so old ones drift down; on for blocked cards, so the agent that has waited longest comes first" />
        <Fact label="a reply" value="hands the card over: it leaves, and comes back warm behind whatever you are reading when the answer lands" />
      </Section>
      <LadderSection inbox={inbox} />
    </>
  );
}

/** A typed knob is applied on blur only when it is a number inside its range; anything else is left in the box. */
const within = (v: string, range: { min: number; max: number }) => Number.isFinite(Number(v)) && Number(v) >= range.min && Number(v) <= range.max;

function LadderSection({ inbox }: { inbox: InboxSettingsApi }) {
  const [first, setFirst] = useState(String(inbox.ladder.firstMinutes));
  const [growth, setGrowth] = useState(String(inbox.ladder.growth));
  return (
    <Section title="later" hint="how long ← hides a card: the first deferral, then each further one in the same day multiplied by the growth, never past a day">
      <Fact
        label="first"
        value={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Field size="sm" mono value={first} onChange={(e) => setFirst(e.target.value)} onBlur={() => within(first, LADDER_RANGE.firstMinutes) && inbox.onLadder({ firstMinutes: Number(first) })} style={{ width: 64 }} aria-label="minutes the first deferral lasts" />
            <Meta wrap>minutes ({LADDER_RANGE.firstMinutes.min}–{LADDER_RANGE.firstMinutes.max}); the one you feel — does the card come back inside this pass or after the next coffee</Meta>
          </span>
        }
      />
      <Fact
        label="growth"
        value={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Field size="sm" mono value={growth} onChange={(e) => setGrowth(e.target.value)} onBlur={() => within(growth, LADDER_RANGE.growth) && inbox.onLadder({ growth: Number(growth) })} style={{ width: 64 }} aria-label="growth per further deferral" />
            <Meta wrap>× per further deferral of the same card ({LADDER_RANGE.growth.min}–{LADDER_RANGE.growth.max}); 1 keeps every deferral the same length</Meta>
          </span>
        }
      />
      <Fact label="ladder" value={ladderSteps(inbox.ladder).map(formatGap).join(" · ")} mono />
      <Fact label="resets" value="each day; a card that moves on (new reply, new approval) comes back at once; approvals never defer" />
    </Section>
  );
}

function FilesPage() {
  return (
    <Section title="files" hint="everything loki keeps, in one folder">
      <Fact label="widgets" value={`${HOME}/widgets/<desk>/`} mono />
      <Fact label="layout" value={`${HOME}/state/<desk>.json`} mono />
      <Fact label="inbox marks" value={`${HOME}/state/attention.json`} mono />
      <Fact label="board" value={`${HOME}/board  (beads · bd, embedded Dolt, prefix lk)`} mono />
      <Fact label="token" value={`${HOME}/token`} mono />
      <Fact label="logs" value={`${HOME}/mod.log · ${HOME}/logs/harness.log`} mono />
      <Fact label="mod · canvas" value={`${HOME}/mod/  ·  ${HOME}/app/  (installed from the app bundle at launch)`} mono />
    </Section>
  );
}

function KeysPage({ shortcut }: { shortcut: GlobalShortcut }) {
  return (
    <Section title="keys" hint="⌘ here is ctrl on other systems">
      <Fact
        label="⌥Space"
        value={
          shortcut.available ? (
            <span style={{ display: "inline-grid", gap: 4 }}>
              <Switch on={shortcut.enabled} onToggle={() => shortcut.set(!shortcut.enabled)} label="bring loki up on the inbox from anywhere on the Mac" />
              {shortcut.error ? <Note tone="warn">macOS refused it — another app (Raycast, Alfred, the input-source switcher) holds ⌥Space; free it there and switch this off and on</Note> : <Note>off, if another app wants the key or you type non-breaking spaces with it</Note>}
            </span>
          ) : (
            "the app only — a browser tab cannot hold a system-wide key"
          )
        }
      />
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
        <tbody>
          {WHERE_ORDER.flatMap((where) => KEYMAP.filter((b) => b.where === where)).map((b, i, rows) => (
            <tr key={b.id} style={{ borderTop: i > 0 && rows[i - 1].where !== b.where ? "1px solid var(--loki-border)" : undefined }}>
              <td className="loki-label" style={{ padding: "6px 0", width: 90, fontSize: 9.5, verticalAlign: "top", paddingTop: 9 }}>{i === 0 || rows[i - 1].where !== b.where ? b.where : ""}</td>
              <td style={{ padding: "6px 12px 6px 0", width: 170, fontFamily: "var(--loki-mono)", fontSize: 12, color: "var(--loki-fg)", whiteSpace: "nowrap" }}>{b.keys.map(formatKeys).join(" · ")}</td>
              <td style={{ padding: "6px 0", color: "var(--loki-muted)" }}>
                {b.label}
                {b.typing ? "" : b.where === "inbox" || b.where === "desk" ? <span style={{ marginLeft: 8, fontSize: 10.5, opacity: 0.7 }}>not while typing</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

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
        {hint && <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div style={{ display: "grid", gap: 6, borderLeft: "1px solid var(--loki-border)", paddingLeft: 20 }}>{children}</div>
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, alignItems: "baseline", fontSize: 13.5, lineHeight: 1.5 }}>
      <span className="loki-label" style={{ fontSize: 9.5 }}>{label}</span>
      <span style={{ color: "var(--loki-fg)", fontFamily: mono ? "var(--loki-mono)" : undefined, fontSize: mono ? 12 : 13.5, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) {
  return <span style={{ marginLeft: 8, fontSize: 12, color: tone === "warn" ? "var(--loki-accent)" : "var(--loki-muted)" }}>{children}</span>;
}

function InstallState({ s }: { s: string }) {
  const color = s === "error" ? "var(--loki-negative)" : s === "custom" || s === "skipped" ? "var(--loki-muted)" : "var(--loki-positive)";
  return <span style={{ color, fontFamily: "var(--loki-label)", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>{s}</span>;
}

function Status({ s }: { s: string }) {
  const color = s === "open" ? "var(--loki-positive)" : s === "connecting" ? "var(--loki-accent)" : "var(--loki-negative)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color, fontFamily: "var(--loki-label)", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>
      <Dot color={color} />
      {s}
    </span>
  );
}
