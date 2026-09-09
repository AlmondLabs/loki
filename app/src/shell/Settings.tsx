import { useState } from "react";
import { inTauri, modBase } from "../desk/env";
import { KEYMAP, WHERE_ORDER, formatKeys } from "./keymap";
import { Button, Chip, Dot, NavButton, Title } from "../ui";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import { TESTED_APP_SERVER_REPORT, TESTED_LETTA_CODE, lettaCompatible } from "../../../packages/core/src/compat.ts";
import type { ConnectProvider } from "../../../packages/core/src/attention/protocol.ts";
import { Providers } from "../settings/Providers";
import { Phone, type PhoneApi } from "../settings/Phone";
import { Skills, type GlobalSkillsApi } from "../settings/Skills";
import type { BootstrapStatus } from "./bootstrap";
import { useHarnessFacts, type InstallReport, type Tools } from "./useHarnessFacts";

const HOME = "~/.letta/loki";

/** The pages down the left. "letta" gathers what loki runs on: harness, mod, requirements, install. */
export type SettingsPage = "letta" | "providers" | "phone" | "skills" | "chat" | "files" | "keys";
export const PAGES: Array<{ id: SettingsPage }> = [{ id: "letta" }, { id: "providers" }, { id: "phone" }, { id: "skills" }, { id: "chat" }, { id: "files" }, { id: "keys" }];
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
  phone,
  globalSkills,
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
  /** The LAN listener and paired phones (useDesk().phone). */
  phone: PhoneApi;
  /** ~/.letta/skills, which every agent reads (Settings › skills). */
  globalSkills: GlobalSkillsApi;
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
        {page === "letta" && <LettaPage harness={harness} appServerStatus={appServerStatus} modConnection={modConnection} deskCount={deskCount} lettaVersion={lettaVersion} bootstrap={bootstrap} onInstallLetta={onInstallLetta} />}
        {page === "providers" && <ProvidersPage appServerStatus={appServerStatus} providers={providers} onLoadProviders={onLoadProviders} onConnectProvider={onConnectProvider} onDisconnectProvider={onDisconnectProvider} onModelsChanged={onModelsChanged} />}
        {page === "phone" && <PhonePage phone={phone} modConnection={modConnection} />}
        {page === "skills" && <SkillsPage globalSkills={globalSkills} />}
        {page === "chat" && <ChatPage chatWidth={chatWidth} onChatWidth={onChatWidth} chatPlacement={chatPlacement} onChatPlacement={onChatPlacement} />}
        {page === "files" && <FilesPage />}
        {page === "keys" && <KeysPage />}
          <div className="loki-label" style={{ fontSize: 9.5, textAlign: "center", paddingTop: 12 }}>
            loki {__LOKI_VERSION__} · {inTauri ? "tauri shell" : "browser tab"}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Settings › letta: the harness, the mod, what loki needs on this machine, and what launch installed. */
function LettaPage({ harness, appServerStatus, modConnection, deskCount, lettaVersion, bootstrap, onInstallLetta }: { harness: ReturnType<typeof useHarnessFacts>; appServerStatus: AppServerStatus; modConnection: ModConnection; deskCount: number; lettaVersion: string | null; bootstrap: BootstrapStatus | null; onInstallLetta: () => Promise<void> }) {
  // Never print the token: a browser tab's tunnel URL carries it as a query.
  const shownUrl = harness.appServerUrl ? harness.appServerUrl.replace(/\?.*$/, "") : null;
  return (
    <>
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
        <Fact label="bd (beads)" value={harness.tools ? harness.tools.bd ?? <Note tone="warn">not found — brew install beads (the board needs it; everything else works without)</Note> : "—"} mono />
        <Fact label="system" value="macOS 13 or later; the shell finds Letta Desktop with lsof and picks folders with osascript" />
      </Section>
      {inTauri && <InstallSection install={harness.install} />}
    </>
  );
}

/** The Letta Code the harness reports, against the release loki was tested with. */
function LettaCodeFact({ lettaVersion, tools }: { lettaVersion: string | null; tools: Tools | null }) {
  const compatible = lettaCompatible(lettaVersion);
  return <Fact label="letta code" value={lettaVersion ? <span>harness reports {lettaVersion}{compatible === false ? <Note tone="warn">loki was tested with {TESTED_LETTA_CODE}, whose harness reports {TESTED_APP_SERVER_REPORT} — if something is off, this is the first suspect</Note> : <Note>as the tested release ({TESTED_LETTA_CODE}) does</Note>}</span> : tools ? (tools.letta ? "harness not linked yet" : <Note tone="warn">not found — npm install -g @letta-ai/letta-code</Note>) : "—"} />;
}

/** The letta CLI on this Mac: found, installing privately, failed (with the install button), or as the tool scan saw it. */
function LettaCliFact({ bootstrap, tools, onInstallLetta }: { bootstrap: BootstrapStatus | null; tools: Tools | null; onInstallLetta: () => Promise<void> }) {
  return <Fact label="letta cli" value={bootstrap ? (bootstrap.letta ? <span>{bootstrap.letta}{bootstrap.private ? <Note>installed by loki, under its own folder</Note> : null}</span> : bootstrap.installing ? <Note tone="warn">installing a private copy… {bootstrap.log[bootstrap.log.length - 1] ?? ""}</Note> : <span><Note tone="warn">{bootstrap.error ?? "not found"}</Note> <Button size="sm" onClick={() => void onInstallLetta()} style={{ marginLeft: 8 }}>install</Button> <Note>or: npm install -g @letta-ai/letta-code</Note></span>) : tools ? tools.letta ?? <Note tone="warn">not found — npm install -g @letta-ai/letta-code</Note> : "—"} mono />;
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
    </Section>
  );
}

function KeysPage() {
  return (
    <Section title="keys" hint="⌘ here is ctrl on other systems">
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
