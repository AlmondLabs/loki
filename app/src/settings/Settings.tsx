import { useEffect, useState } from "react";
import { inTauri, modBase } from "../desk/env";
import { KEYMAP, WHERE_ORDER, formatKeys } from "../shell/keymap";
import { Button, Chip, Dot, NavButton, Switch, Title } from "../components";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import { TESTED_APP_SERVER_REPORT, TESTED_LETTA_CODE, lettaCompatible } from "../../../core/compat.ts";
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

const HOME = "~/.letta/loki";

/** The pages down the left. "letta" gathers what loki runs on: harness, mod, requirements, install. */
export type SettingsPage = "letta" | "providers" | "phone" | "skills" | "learn" | "chat" | "files" | "keys";
export const PAGES: Array<{ id: SettingsPage }> = [{ id: "letta" }, { id: "providers" }, { id: "phone" }, { id: "skills" }, { id: "learn" }, { id: "chat" }, { id: "files" }, { id: "keys" }];
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
  return !appServerUrl ? "not found" : viaTunnel ? "whichever harness the mod found — this tab reaches it through the mod's tunnel" : ownHarness ? "loki's own harness (letta server --listen), adopted or spawned at launch" : "Letta Desktop";
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
        {page === "letta" && <LettaPage update={update} harness={harness} appServerStatus={appServerStatus} modConnection={modConnection} deskCount={deskCount} lettaVersion={lettaVersion} bootstrap={bootstrap} onInstallLetta={onInstallLetta} onCheckLetta={onCheckLetta} onUpdateLetta={onUpdateLetta} />}
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
function LettaPage({ update, harness, appServerStatus, modConnection, deskCount, lettaVersion, bootstrap, onInstallLetta, onCheckLetta, onUpdateLetta }: { update: LokiUpdate; harness: ReturnType<typeof useHarnessFacts>; appServerStatus: AppServerStatus; modConnection: ModConnection; deskCount: number; lettaVersion: string | null; bootstrap: BootstrapStatus | null; onInstallLetta: () => Promise<void>; onCheckLetta: () => Promise<string | null>; onUpdateLetta: () => Promise<string | null> }) {
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

/** The Letta Code the harness reports, against the release loki was tested with. */
function LettaCodeFact({ lettaVersion, tools }: { lettaVersion: string | null; tools: Tools | null }) {
  const compatible = lettaCompatible(lettaVersion);
  return <Fact label="letta code" value={lettaVersion ? <span>harness reports {lettaVersion}{compatible === false ? <Note tone="warn">loki was tested with {TESTED_LETTA_CODE}, whose harness reports {TESTED_APP_SERVER_REPORT} — if something is off, this is the first suspect</Note> : <Note>as the tested release ({TESTED_LETTA_CODE}) does</Note>}</span> : tools ? (tools.letta ? "harness not linked yet" : <Note tone="warn">not found — npm install -g @letta-ai/letta-code</Note>) : "—"} />;
}

/**
 * Updating Letta Code is manual and lives here: the harness runs with its self-updater off, so the only
 * "update available" the app ever shows on its own is loki's. "check" asks npm; "update" pulls the newest
 * release the way this copy was installed and restarts the harness — only when loki started that harness.
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
  const { version, latest, managed, installing } = bootstrap;
  const newer = !!latest && !!version && latest !== version;
  const tested = latest ? lettaCompatible(latest, TESTED_LETTA_CODE) : null;
  return (
    <Fact
      label="updates"
      value={
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 12 }}>{version ? `installed ${version}` : "installed —"}{latest ? ` · newest ${latest}` : ""}</span>
          {installing ? (
            <Note tone="warn">{bootstrap.log[bootstrap.log.length - 1] ?? "updating…"}</Note>
          ) : (
            <>
              <Button size="sm" onClick={() => void run("check", onCheck)} disabled={busy !== null}>{busy === "check" ? "checking…" : "check"}</Button>
              {newer && managed && (
                <Button size="sm" tone="brass" onClick={() => void run("update", onUpdate)} disabled={busy !== null} title="pulls the newest release and restarts the harness — a turn in progress stops">
                  {busy === "update" ? "updating…" : `update to ${latest}`}
                </Button>
              )}
              {newer && !managed && <Note tone="warn">newer release — this harness is not loki's to restart; update Letta Code where it runs</Note>}
              {latest && !newer && version && <Note>up to date</Note>}
            </>
          )}
          {newer && tested === false && <Note tone="warn">loki was tested with {TESTED_LETTA_CODE}; a newer minor may need a loki update too</Note>}
          {!installing && !latest && !error && <Note>Letta Code never updates itself under loki — this is the only way it moves</Note>}
          {(error ?? (!installing ? bootstrap.error : null)) && <Note tone="warn">{error ?? bootstrap.error}</Note>}
        </span>
      }
    />
  );
}

/** The letta CLI on this Mac: found, installing privately, failed (with the install button), or as the tool scan saw it. */
function LettaCliFact({ bootstrap, tools, onInstallLetta }: { bootstrap: BootstrapStatus | null; tools: Tools | null; onInstallLetta: () => Promise<void> }) {
  return <Fact label="letta cli" value={bootstrap ? (bootstrap.letta ? <span>{bootstrap.letta}{bootstrap.private ? <Note>loki's own copy — yours, if you have one, is never touched</Note> : <Note>named by LOKI_LETTA_BIN — not loki's copy, so not loki's to update</Note>}</span> : bootstrap.installing ? <Note tone="warn">installing a private copy… {bootstrap.log[bootstrap.log.length - 1] ?? ""}</Note> : <span><Note tone="warn">{bootstrap.error ?? "not found"}</Note> <Button size="sm" onClick={() => void onInstallLetta()} style={{ marginLeft: 8 }}>install</Button> <Note>or: npm install -g @letta-ai/letta-code</Note></span>) : tools ? tools.letta ?? <Note tone="warn">not found — npm install -g @letta-ai/letta-code</Note> : "—"} mono />;
}

/** In the shell only: what launch did about the mod and the skill. */
function InstallSection({ install }: { install: InstallReport | null }) {
  return (
    <Section title="install" hint="on launch the app puts its mod and skill where Letta looks">
      <ModFact install={install} />
      <Fact label="shim" value={install?.shim ?? "~/.letta/mods/loki.ts"} mono />
      {install?.mod_path ? <Fact label="bundle" value={install.mod_path} mono /> : null}
      <Fact label="skill" value={install ? <span><InstallState s={install.skill} /> {install.skill === "custom" ? <Note>a symlink or your own copy; left alone</Note> : null}</span> : "—"} />
      <Fact label="skill path" value={install?.skill_path ?? "~/.agents/skills/loki"} mono />
      {install?.error ? <Fact label="error" value={<span style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{install.error}</span>} /> : null}
    </Section>
  );
}

function ModFact({ install }: { install: InstallReport | null }) {
  return <Fact label="mod" value={install ? <span><InstallState s={install.mod} /> {install.mod === "custom" ? <Note>your own shim is in place; the app leaves it alone</Note> : install.mod === "skipped" ? <Note>development build — set LOKI_INSTALL=1 to install anyway</Note> : install.needs_reload ? <Note tone="warn">the harness started before this copy landed: run /reload in Letta Code, or restart Letta Desktop</Note> : null}</span> : "—"} />;
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
      <Fact label="later" value="5m · 15m · 45m · 2h · 6h · 1d, one step further each time a card is deferred" />
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
      <Fact label="letta code" value={`${HOME}/runtime/  (loki's own Node and Letta Code)`} mono />
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
