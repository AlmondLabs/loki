import { useEffect, useEffectEvent, useState } from "react";
import type { AccountProvider, AccountView, GoogleService, SlackWorkspaceView } from "../../../core/frame-types.ts";
import { Button, Dot, Field, sentence } from "../components";
import { disconnectedText } from "../workspace/outside-words";
import { notYetOn, openExternal, platform, type Platform } from "../workspace/env";
import { Block, Fold, Setting } from "./layout";
import { JiraConnectForm, JiraConnectSetting, type JiraConnect, type JiraForm } from "./jira-connect";

export interface AccountsApi {
  list: () => Promise<AccountView[] | string>;
  move: (accountId: string, ownerAgentId: string) => Promise<AccountView[] | string>;
  disconnect: (accountId: string) => Promise<AccountView[] | string>;
  connectGmail: (ownerAgentId: string, ownApp: OwnApp | null, accountId?: string | null) => Promise<{ url: string } | string>;
  connectSlack: (ownerAgentId: string, teamId?: string) => Promise<{ workspaces: SlackWorkspaceView[]; account: AccountView | null } | string>;
  connectJira: (input: JiraConnect) => Promise<AccountView[] | string>;
}

export interface OwnApp {
  client_id: string;
  client_secret: string;
}

export interface AgentName {
  id: string;
  name: string;
}

export type Reconnect =
  | { provider: "gmail"; owner_agent_id: string; account_id: string; team_id: null }
  | { provider: "slack"; owner_agent_id: string; team_id: string | null }
  | { provider: "jira"; owner_agent_id: string; account_id: string; site: string };

export interface AccountRow {
  account_id: string;
  label: string;
  service: string;
  owner_agent_id: string;
  owner: string;
  state: string;
  problem: boolean;
  reconnect: Reconnect | null;
  more: { reconnect: Reconnect; services: string } | null;
  people: string | null;
}

export const PEOPLE_BY_ADDRESS_ONLY = "Agents can find people here only by address until it signs in again for Contacts";

const GOOGLE_SERVICE_WORDS: Record<GoogleService, string> = { gmail: "Gmail", drive: "Drive", sheets: "Sheets", docs: "Docs", calendar: "Calendar" };

function servicesWords(services: readonly GoogleService[], contacts = false): string {
  const words = [...services.map((s) => GOOGLE_SERVICE_WORDS[s]), ...(contacts ? ["Contacts"] : [])];
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

const SERVICE: Record<AccountProvider, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };

const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "drive", "sheets", "docs", "calendar"];

const POLL_MS = 3000;

export function connectState(provider: AccountProvider, owner: string | null, os: Platform): { ready: boolean; reason: string | null } {
  if (provider === "slack" && os !== "macos") return { ready: false, reason: notYetOn("Connecting Slack", os) };
  if (!owner) return { ready: false, reason: "Add an agent first: an account belongs to one" };
  return { ready: true, reason: null };
}

const teamOf = (accountId: string): string | null => /^slack:([^:]+):/.exec(accountId)?.[1] ?? null;

function reconnectOf(a: AccountView): Reconnect {
  switch (a.provider) {
    case "gmail":
      return { provider: "gmail", owner_agent_id: a.owner_agent_id, account_id: a.account_id, team_id: null };
    case "slack":
      return { provider: "slack", owner_agent_id: a.owner_agent_id, team_id: teamOf(a.account_id) };
    case "jira":
      return { provider: "jira", owner_agent_id: a.owner_agent_id, account_id: a.account_id, site: a.address };
  }
}

export interface ReconnectWays {
  gmail: (ownerId: string, accountId: string) => void;
  slack: (ownerId: string, teamId?: string) => void;
  jira: (form: JiraForm) => void;
}

export function reconnectVia(r: Reconnect, ways: ReconnectWays): void {
  switch (r.provider) {
    case "gmail":
      return ways.gmail(r.owner_agent_id, r.account_id);
    case "slack":
      return ways.slack(r.owner_agent_id, r.team_id ?? undefined);
    case "jira":
      return ways.jira({ reconnecting: { account_id: r.account_id, owner_agent_id: r.owner_agent_id }, site: r.site, email: "", token: "" });
  }
}

export function accountRows(accounts: readonly AccountView[], agents: readonly AgentName[]): AccountRow[] {
  return accounts.map((a) => {
    const cause = a.status === "connected" ? null : a.status.disconnected;
    const reconnect = cause && cause !== "temporarily_failing" ? reconnectOf(a) : null;
    const missing = a.provider === "gmail" ? GOOGLE_SERVICES.filter((s) => !(a.services ?? ["gmail"]).includes(s)) : [];
    const noContacts = a.provider === "gmail" && !cause && (a.contacts ?? []).length === 0;
    const more = !cause && (missing.length > 0 || noContacts) ? { reconnect: reconnectOf(a), services: servicesWords(missing, noContacts) } : null;
    return {
      account_id: a.account_id,
      label: a.address,
      service: SERVICE[a.provider],
      owner_agent_id: a.owner_agent_id,
      owner: agents.find((g) => g.id === a.owner_agent_id)?.name ?? "an agent no longer here",
      state: cause
        ? disconnectedText(cause, a.provider)
        : missing.length > 0
          ? `Connected; scripts cannot use ${servicesWords(missing)} until it signs in again`
          : "Connected",
      problem: cause !== null,
      reconnect,
      more,
      people: noContacts ? PEOPLE_BY_ADDRESS_ONLY : null,
    };
  });
}

export function ownAppOf(clientId: string, clientSecret: string): OwnApp | null {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  return id && secret ? { client_id: id, client_secret: secret } : null;
}

export function deleteBlockers(accounts: readonly AccountView[], agentId: string): AccountView[] {
  return accounts.filter((a) => a.owner_agent_id === agentId);
}

export function moveTargets(agents: readonly AgentName[], ownerId: string): AgentName[] {
  return agents.filter((g) => g.id !== ownerId);
}

export function AgentPicker({
  agents,
  value,
  onPick,
  label,
  placeholder,
}: {
  agents: readonly AgentName[];
  value: string | null;
  onPick: (agentId: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => e.target.value && onPick(e.target.value)}
      style={{ font: "inherit", color: "var(--loki-fg)" }}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {agents.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}

function useAccounts(api: AccountsApi) {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: AccountView[] | string) => {
    if (typeof r === "string") return setError(r);
    setError(null);
    setAccounts(r);
  };
  const read = useEffectEvent(() => api.list());
  const take = useEffectEvent(apply);
  useEffect(() => {
    let live = true;
    const load = () => void read().then((r) => live && take(r));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { accounts, error, setError, apply };
}

export function Accounts({ api, agents, os = platform }: { api: AccountsApi; agents: readonly AgentName[]; os?: Platform }) {
  const { accounts, error, setError, apply } = useAccounts(api);
  const [picked, setOwner] = useState<string | null>(null);
  const owner = picked && agents.some((g) => g.id === picked) ? picked : (agents[0]?.id ?? null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ owner: string; list: SlackWorkspaceView[] } | null>(null);
  const [jiraForm, setJiraForm] = useState<JiraForm | null>(null);

  const gmail = async (ownerId: string, accountId?: string) => {
    const r = await api.connectGmail(ownerId, ownAppOf(clientId, clientSecret), accountId ?? null);
    if (typeof r === "string") return setError(r);
    openExternal(r.url);
    setNotice("Finish signing in to Google in your browser: the mailbox shows here once Google sends you back");
  };
  const slack = async (ownerId: string, teamId?: string) => {
    const r = await api.connectSlack(ownerId, teamId);
    if (typeof r === "string") return setError(r);
    if (r.account) {
      setWorkspaces(null);
      setNotice(null);
      return apply(await api.list());
    }
    setWorkspaces({ owner: ownerId, list: r.workspaces });
  };
  const [connecting, setConnecting] = useState(false);
  const reconnect = (r: Reconnect) =>
    reconnectVia(r, {
      gmail: (ownerId, accountId) => void gmail(ownerId, accountId),
      slack: (ownerId, teamId) => void slack(ownerId, teamId),
      jira: setJiraForm,
    });

  const rows = accountRows(accounts ?? [], agents);
  const connectedTeams = new Set((accounts ?? []).filter((a) => a.status === "connected").map((a) => teamOf(a.account_id)));
  const gmailState = connectState("gmail", owner, os);
  const slackState = connectState("slack", owner, os);
  return (
    <>
      <Block title="Accounts" help="Mail, Slack and Jira that need you arrive as cards in Flow, and each account belongs to one agent.">
        {error && (
          <div role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
            {error}
          </div>
        )}
        {!accounts && !error && <Setting label="Accounts" help="Asking loki…" />}
        {accounts && rows.length === 0 && <Setting label="None yet" help="Connect a Gmail account, a Slack workspace or a Jira site below." />}
        {rows.map((row) => (
          <AccountLine key={row.account_id} row={row} agents={agents} api={api} apply={apply} onReconnect={reconnect} />
        ))}
      </Block>
      <Block title="Connect an account" help="A mailbox, a workspace or a Jira site, given to the agent below.">
        <Setting label="Gmail" help={gmailState.reason ?? "Opens Google's sign-in in your browser."}>
          <Button tone="positive" disabled={!gmailState.ready} onClick={() => owner && void gmail(owner)}>
            Connect Gmail
          </Button>
        </Setting>
        <Setting label="Slack" help={slackState.reason ?? "Reads the workspaces signed in to the Slack desktop app; no Slack app to create."}>
          <Button tone="positive" disabled={!slackState.ready} onClick={() => owner && void slack(owner)}>
            Connect Slack
          </Button>
        </Setting>
        <JiraConnectSetting state={connectState("jira", owner, os)} connecting={connecting} onOpen={setJiraForm} />
        <Setting label="Goes to" help="The agent that gets a new account's hand-offs, and the only one with tools for it.">
          <AgentPicker agents={agents} value={owner} onPick={setOwner} label="The agent a new account goes to" placeholder="Choose an agent" />
        </Setting>
        {notice && <div className="loki-meta loki-meta--wrap">{notice}</div>}
        <JiraConnectForm
          api={api}
          owner={owner}
          form={jiraForm}
          onForm={setJiraForm}
          connecting={connecting}
          onConnecting={setConnecting}
          onNotice={setNotice}
          apply={apply}
        />
        {workspaces?.list.length === 0 && <Setting label="No workspaces" help="Sign in to a workspace in the Slack desktop app, then connect Slack again." />}
        {workspaces?.list.map((w) => (
          <Setting key={w.team_id} label={w.team_name} help={w.url} mono>
            {connectedTeams.has(w.team_id) ? (
              <span className="loki-meta">Connected</span>
            ) : (
              <Button tone="positive" onClick={() => void slack(workspaces.owner, w.team_id)}>
                Connect
              </Button>
            )}
          </Setting>
        ))}
      </Block>
      <Fold title="Use your own Google app">
        <Setting
          label="Client id and secret"
          help="An OAuth client of your own for a desktop app, which Connect Gmail then signs in with instead of loki's shared app."
        />
        <Field value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client ID" placeholder="Client ID" mono />
        <Field
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          aria-label="Client secret"
          placeholder="Client secret"
          type="password"
          mono
          style={{ marginTop: 8 }}
        />
      </Fold>
    </>
  );
}

function AccountLine({
  row,
  agents,
  api,
  apply,
  onReconnect,
}: {
  row: AccountRow;
  agents: readonly AgentName[];
  api: AccountsApi;
  apply: (r: AccountView[] | string) => void;
  onReconnect: (r: Reconnect) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const { reconnect, more } = row;
  return (
    <div className="grid gap-2" style={{ padding: "12px 0" }}>
      <div className="flex items-center gap-2">
        <Dot color={row.problem ? "var(--loki-negative)" : "var(--loki-positive)"} />
        <strong className="min-w-0" style={{ fontSize: "var(--text-sm)", overflowWrap: "anywhere" }}>
          {row.label}
        </strong>
        <span className="loki-meta">
          {row.service} · {row.owner}
        </span>
      </div>
      <div className={row.problem ? "loki-meta loki-meta--negative loki-meta--wrap" : "loki-meta loki-meta--wrap"}>{sentence(row.state)}</div>
      {row.people && <div className="loki-meta loki-meta--wrap">{row.people}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {reconnect && (
          <Button tone="positive" onClick={() => onReconnect(reconnect)}>
            {`Reconnect ${row.service}`}
          </Button>
        )}
        {more && (
          <Button tone="positive" onClick={() => onReconnect(more.reconnect)}>
            {`Sign In Again for ${more.services}`}
          </Button>
        )}
        <label className="loki-meta flex items-center gap-2">
          Move to
          <AgentPicker
            agents={agents}
            value={agents.some((g) => g.id === row.owner_agent_id) ? row.owner_agent_id : null}
            onPick={(agentId) => void api.move(row.account_id, agentId).then(apply)}
            label={`The agent that owns ${row.label}`}
            placeholder="Choose an agent"
          />
        </label>
        {confirm ? (
          <>
            <Button tone="negative" onClick={() => void api.disconnect(row.account_id).then(apply)}>
              Disconnect {row.label}
            </Button>
            <Button onClick={() => setConfirm(false)}>Keep</Button>
          </>
        ) : (
          <Button onClick={() => setConfirm(true)}>Disconnect…</Button>
        )}
      </div>
    </div>
  );
}

export function OwnedAccounts({
  api,
  agentId,
  agents,
  asked,
  onOwned,
}: {
  api: AccountsApi;
  agentId: string;
  agents: readonly AgentName[];
  asked: number;
  onOwned: (count: number) => void;
}) {
  const [owned, setOwned] = useState<AccountView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: AccountView[] | string) => {
    if (typeof r === "string") return setError(r);
    const mine = deleteBlockers(r, agentId);
    setError(null);
    setOwned(mine);
    onOwned(mine.length);
  };
  const take = useEffectEvent(apply);
  const read = useEffectEvent(() => api.list());
  useEffect(() => {
    let live = true;
    void read().then((r) => live && take(r));
    return () => {
      live = false;
    };
  }, [asked]);
  if (!owned.length && !error) return null;
  return (
    <div role="group" aria-label="Accounts this agent owns" className="grid gap-2">
      {error && (
        <span role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </span>
      )}
      {owned.length > 0 && <span>It owns these accounts: move each to another agent or disconnect it first.</span>}
      {accountRows(owned, agents).map((row) => (
        <div key={row.account_id} className="flex flex-wrap items-center gap-2">
          <strong className="min-w-0" style={{ overflowWrap: "anywhere" }}>
            {row.label}
          </strong>
          <span className="loki-meta">{row.service}</span>
          <label className="loki-meta flex items-center gap-2" style={{ marginLeft: "auto" }}>
            Move to
            <AgentPicker
              agents={moveTargets(agents, agentId)}
              value={null}
              onPick={(to) => void api.move(row.account_id, to).then(apply)}
              label={`Move ${row.label} to`}
              placeholder="Choose an agent"
            />
          </label>
          <Button tone="negative" onClick={() => void api.disconnect(row.account_id).then(apply)}>
            Disconnect
          </Button>
        </div>
      ))}
    </div>
  );
}
