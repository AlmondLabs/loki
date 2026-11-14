import type { AccountView } from "../../../core/frame-types.ts";
import { Button, Field } from "../components";
import type { AccountsApi } from "./accounts";
import { Setting } from "./layout";

/**
 * Connecting a Jira site in Preferences › Accounts (plan 2026-11-10-1451, U3): the form for the site's address, the
 * person's email and an API token, which "Connect Jira…" opens empty and a Jira row's reconnect opens with its site.
 */

/** What connecting a Jira site sends: its owner, what the person typed, and the account being reconnected, if one is. */
export interface JiraConnect {
  owner_agent_id: string;
  site: string;
  email: string;
  token: string;
  account_id: string | null;
}

/** The Jira form as the person fills it in. `reconnecting` names the account a row's reconnect opened it for, and its owner. */
export interface JiraForm {
  reconnecting: { account_id: string; owner_agent_id: string } | null;
  site: string;
  email: string;
  token: string;
}

/**
 * The Jira form as connecting takes it: all three fields filled in, trimmed, for the agent a new account goes to, or
 * for the account's own agent on a reconnect; otherwise null, and there is nothing to send yet.
 */
export function jiraConnectOf(form: JiraForm, owner: string | null): JiraConnect | null {
  const [site, email, token] = [form.site.trim(), form.email.trim(), form.token.trim()];
  const ownerId = form.reconnecting?.owner_agent_id ?? owner;
  return ownerId && site && email && token ? { owner_agent_id: ownerId, site, email, token, account_id: form.reconnecting?.account_id ?? null } : null;
}

/** The Jira line under "Connect an account": "Connect Jira…" opens an empty form, and waits while a connect is on its way. */
export function JiraConnectSetting({
  state,
  connecting,
  onOpen,
}: {
  state: { ready: boolean; reason: string | null };
  connecting: boolean;
  onOpen: (form: JiraForm) => void;
}) {
  return (
    <Setting label="Jira" help={state.reason ?? "Asks for your site's address, your Atlassian email and an API token."}>
      <Button tone="positive" disabled={!state.ready || connecting} onClick={() => onOpen({ reconnecting: null, site: "", email: "", token: "" })}>
        Connect Jira…
      </Button>
    </Setting>
  );
}

/**
 * The Jira form while it is open (nothing while `form` is null), under "Connect Jira…" or a Jira row's reconnect (plan
 * 2026-11-10-1451, U3): the site's address, the
 * person's email and an API token, then connect and cancel. `connecting` is held by the page, so "Connect Jira…" waits
 * for a connect on its way too; while it is, a second press does nothing. A refusal stays in the notice, since the list
 * is asked again every few seconds and clears the error line above it.
 */
export function JiraConnectForm({
  api,
  owner,
  form,
  onForm,
  connecting,
  onConnecting,
  onNotice,
  apply,
}: {
  api: AccountsApi;
  owner: string | null;
  form: JiraForm | null;
  onForm: (form: JiraForm | null) => void;
  connecting: boolean;
  onConnecting: (connecting: boolean) => void;
  onNotice: (notice: string | null) => void;
  apply: (r: AccountView[] | string) => void;
}) {
  if (!form) return null;
  const input = jiraConnectOf(form, owner);
  const connect = async (ready: JiraConnect) => {
    if (connecting) return;
    onConnecting(true);
    try {
      const r = await api.connectJira(ready);
      if (typeof r === "string") return onNotice(r);
      onForm(null);
      onNotice(null);
      apply(r);
    } finally {
      onConnecting(false);
    }
  };
  return (
    <>
      <Setting
        label={form.reconnecting ? `A new API token for ${form.site}` : "Jira site, email and API token"}
        help="The site's address as in acme.atlassian.net, the email of your Atlassian account, and an API token made in that account's security settings. loki keeps the token in the keychain."
      />
      <Field value={form.site} onChange={(e) => onForm({ ...form, site: e.target.value })} aria-label="Jira site address" placeholder="Site address" mono />
      <Field
        value={form.email}
        onChange={(e) => onForm({ ...form, email: e.target.value })}
        aria-label="Atlassian email"
        placeholder="Email"
        mono
        style={{ marginTop: 8 }}
      />
      <Field
        value={form.token}
        onChange={(e) => onForm({ ...form, token: e.target.value })}
        aria-label="Jira API token"
        placeholder="API token"
        type="password"
        mono
        style={{ marginTop: 8 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0" }}>
        <Button tone="positive" disabled={!input || connecting} onClick={() => input && void connect(input)}>
          {form.reconnecting ? "Reconnect Jira" : "Connect"}
        </Button>
        <Button disabled={connecting} onClick={() => onForm(null)}>
          Cancel
        </Button>
      </div>
    </>
  );
}
