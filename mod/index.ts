import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { Scope, WidgetChange } from "../core/desk-core.ts";
import { SHARED_SCOPE } from "../core/desk-core.ts";
import type { ChatRef, ModApi } from "../daemon/mods/api.ts";
import { ScopeDebouncer } from "./lifecycle-events.ts";
import { DEFAULT_LAN_PORT, DEFAULT_MOD_PORT, MCP_OAUTH_CALLBACK, lokiDir, paths } from "./paths.ts";
import { registerGoogleTools } from "./google-tools/index.ts";
import { DeskStore } from "./desk-store.ts";
import { loadDesks, persistDesks } from "./persist.ts";
import { watchWidgets } from "./widgets-fs.ts";
import { WidgetLog, broadcastWidgetChanges } from "./widget-log.ts";
import { GestureLog, attachDeskContext, formatDeskContext } from "./gestures.ts";
import { checkFolder, completeFolder, pickFolder } from "./folders.ts";
import { DeskRegistry } from "./desks.ts";
import { ChatListing } from "./chat-listing.ts";
import type { ChatSource } from "./chat-source.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { RestartAnswer } from "./frames/daemon.ts";
import { SeenStore } from "./seen.ts";
import { RecallStore, isoDay } from "./recall.ts";
import { isPassChat, startLessonViaChats } from "./recall-worker.ts";
import { PassState } from "../daemon/passes-state.ts";
import { readPins, setPin } from "./pins.ts";
import { addRecentModel, readRecentModels } from "./models.ts";
import { readUsualModels, recordUsualModel } from "./usual-models.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { reflectionState } from "./reflection.ts";
import { memoryDiff, memoryLog, memorySkills, memoryTree, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";
import { conversationDirName, scopeFor } from "../core/desk-core.ts";

import { frameModules, welcomeFrames, type ModuleDeps } from "./frames/index.ts";
import type { UsageDeps } from "./frames/usage.ts";
import { join } from "node:path";
import { attachWs, oauthCallbackRoute, startServer, tokenAuth, type LokiServer } from "./server.ts";
import { Sockets } from "./sockets.ts";
import { chatImageRoute } from "./chat-images.ts";
import { OutsidePreviews, slackPreviews } from "./outside-previews.ts";
import { ChannelMembers, SlackPeople } from "./slack-people.ts";
import { createBridge } from "./bridge.ts";
import { seenChatFrame } from "./frames/seen.ts";
import { scopeOfId } from "../core/desk-core.ts";
import { DeviceStore } from "./devices.ts";
import type { SecretBackend } from "../daemon/credentials.ts";
import type { MemoryRepos } from "../daemon/memory-sync.ts";
import { PairingCodes } from "./pairing.ts";
import { LanListener } from "./lan.ts";
import { Tailscale } from "./tailscale.ts";
import { startPeering, type Peering } from "./peering.ts";
import { Accounts, perAccount, type AccountChange } from "./accounts.ts";
import { AccountThreads, outsideCardId, type ThreadRecord } from "./account-threads.ts";
import { outsideResting } from "../core/attention/rest.ts";
import { keyOf } from "../core/attention/model.ts";
import { AccountWatcher } from "./account-watcher.ts";
import { GmailClient } from "./gmail.ts";
import { GoogleAuth } from "./google-auth.ts";
import { GmailSync, gmailOutsideSource } from "./gmail-sync.ts";
import { GoogleSignIn, googleCallbackUrl } from "./google-signin.ts";
import { SlackSessions } from "./slack-session.ts";
import { SlackClient } from "./slack.ts";
import { SlackSync, slackOutsideSource } from "./slack-sync.ts";
import { jiraAccountClient, parseJiraSecret } from "./jira.ts";
import { JiraSync, jiraOutsideSource } from "./jira-sync.ts";
import { OutsideThreads } from "./outside-threads.ts";
import { previewAccounts, previewWiring, type AccountWiring } from "./preview-accounts.ts";
import { outboxKey } from "./mail-outbox.ts";
import { InboxLedger } from "./inbox-ledger.ts";
import { MailPeople } from "./mail-people.ts";
import { gmailThreadText } from "./account-ops/gmail.ts";
import { slackThreadText } from "./account-ops/slack.ts";
import { Handoff } from "./handoff.ts";
import { slackChannelView } from "./slack-view.ts";
import { jiraCardView, jiraThreadText } from "./jira-view.ts";
import { serialQueue } from "../core/serial.ts";
import { coalesce } from "../core/timers.ts";
import { Suggestions, chatCaller, withSuggestionsOnOpen, type SuggestionRecords } from "./suggestions.ts";
import { ChatMessages, LinkStore, withLinksOnOpen } from "./chat-links.ts";
import type { LinkAnswer, LinkAsk } from "../core/chat-links.ts";
import { bdReader, moveTasks, tasksDir } from "./task-migration.ts";
import { registerTools } from "./tools.ts";
import { registerAccountScriptTools } from "./account-ops/script-tools.ts";
import { GooglePeople } from "./google-people.ts";
import { People } from "./people.ts";
import { ReplyProposals, registerReplyTools, withRepliesOnOpen } from "./reply-proposals.ts";
import type { ReplyReads } from "./account-ops/reply-reader.ts";
import { initLog, log } from "./log.ts";
import { appVersion, createAnalytics, type Analytics } from "./analytics.ts";
import { messageOf } from "../core/errors.ts";

function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(paths.token, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {}
  const token = randomBytes(16).toString("hex");
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.token, token, { mode: 0o600 });
  return token;
}

/** What the daemon hosts the mod with besides the mod API: its chats, to read and to run, and its analytics writer. */
export interface Host {
  chats: ChatSource;
  chat: ChatBackend;
  analytics?: Analytics;
  usage?: NonNullable<UsageDeps["usage"]> & { onChange: (listener: () => void) => () => void };
  macId: string;
  /** The keychain (or the daemon's stand-in for it), for the tokens this Mac presents to paired Macs. */
  secrets: SecretBackend;
  suggestions?: SuggestionRecords;
  askLink?: (agentId: string, conversationId: string, link: LinkAsk, signal: AbortSignal) => Promise<LinkAnswer>;
  memory: MemoryRepos;
  daemon?: {
    restartDue: () => string | null;
    onRestartDue: (fn: (file: string) => void) => () => void;
    restart: (anyway: boolean) => Promise<RestartAnswer>;
  };
}

export default function activate(api: ModApi, host: Host): () => void {
  initLog(paths.modLog);
  const analytics =
    host.analytics ??
    createAnalytics({ path: process.env.LOKI_ANALYTICS === "0" ? null : paths.events, statePath: paths.analytics, appVersion: appVersion(paths.root) });
  log("activate", { pid: process.pid, node: process.versions.node, api: api.apiVersion });

  const modPort = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT);
  const token = loadOrCreateToken();

  const store = new DeskStore();
  loadDesks(store, paths.state);
  const stopPersist = persistDesks(store, paths.state);
  const gestures = new GestureLog();
  const recallStore = new RecallStore();
  const passChat = isPassChat;

  let activeScope: Scope = SHARED_SCOPE;

  const sockets = new Sockets<LanListener>();
  const phones = (): LanListener => sockets.phones();
  let peering: Peering | null = null;
  const broadcast = (msg: object, scope?: Scope) => {
    sockets.push(msg, { scope });
    peering?.pushed((msg as { type?: string }).type ?? "");
  };

  store.subscribe((scope, state) => broadcast({ type: "state", scope, state }, scope === SHARED_SCOPE ? undefined : scope));

  mkdirSync(paths.widgets, { recursive: true });
  const widgetLog = new WidgetLog(join(paths.state, "widget-log"));
  const widgets = watchWidgets(paths.widgets, (diff) => {
    log("widgets:diff", { added: diff.added.map((e) => e.id), changed: diff.changed.map((e) => e.id), removed: diff.removed });
    for (const e of [...diff.added].sort((a, b) => Number(b.scope === SHARED_SCOPE) - Number(a.scope === SHARED_SCOPE))) store.seen(e.scope, e.id);
    for (const e of diff.changed) store.fileChanged(e.scope, e.id);
    const scopes = new Set<Scope>([...diff.added.map((e) => e.scope), ...diff.changed.map((e) => e.scope), ...diff.removed.map(scopeOfId)]);
    for (const scope of scopes) {
      broadcast({ type: "widgets", scope, widgets: widgets.entries(scope) }, scope === SHARED_SCOPE ? undefined : scope);
    }
    const landed = diff.added.at(-1);
    if (landed && !landed.error) {
      broadcast({ type: "camera", widget_id: landed.id }, landed.scope === SHARED_SCOPE ? undefined : landed.scope);
    }
    broadcastWidgetChanges(widgetLog, diff, broadcast);
  });

  const { chats, chat: chatBackend } = host;
  chatBackend.attach((agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }));
  const desks = new DeskRegistry(join(paths.state, "desks.json"), (id) => chats.agentOf(id));
  const seen = new SeenStore(join(paths.state, "attention.json"));
  const folderFor = (agentId: string | null, conversationId: string | null): string | null =>
    conversationId ? (chats.folders().by_conversation[conversationDirName(conversationId, agentId)] ?? null) : null;

  const threads = new AccountThreads({
    dir: join(paths.state, "account-threads"),
    accounts: { get: (id) => accounts.get(id), list: () => accounts.list() },
    agentName: (id) => {
      const agent = readLocalAgent(id);
      return agent && agent.name !== agent.id ? agent.name : null;
    },
  });
  const listing = new ChatListing({
    chats,
    desks,
    layouts: () => store.scopes(),
    widgets,
    pins: () => readPins(),
    passChats: () => isPassChat,
    activeScope: () => activeScope,
    outside: () => threads.rows(),
    replies: (agentId, conversationId) => replies.open({ agent_id: agentId, conversation_id: conversationId }),
  });
  const deskInfo = (scope: Scope) => listing.info(scope);
  const listLocalDesks = () => listing.desks();
  const listLocalInbox = () => listing.inbox();
  const deleteWidgetFile = (id: string): string | null => {
    const entry = widgets.get(id);
    if (!entry) return null;
    const abs = join(paths.widgets, entry.file);
    try {
      widgetLog.expect(id, "removed", "you");
      unlinkSync(abs);
      log("widget:trashed", { id, file: abs });
      void widgets.rescan();
      return abs;
    } catch (err) {
      log("widget:trash-failed", { id, error: messageOf(err) });
      return null;
    }
  };
  const devices = new DeviceStore(paths.devices);
  const codes = new PairingCodes();
  const tailscale = new Tailscale({ port: Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT) });
  const macs: Peering = startPeering({
    macId: host.macId,
    build: appVersion(paths.root),
    secrets: host.secrets,
    memory: host.memory,
    chats,
    chat: chatBackend,
    seen,
    desks,
    sockets,
    tailscale,
    broadcast,
    local: { desks: listLocalDesks, inbox: listLocalInbox },
    dirs: paths,
    moveTasks: () => moveOpenTasks(),
  });
  peering = macs;
  const accounts = new Accounts({
    file: join(paths.state, "accounts.json"),
    secrets: host.secrets,
    agentExists: (id) => readLocalAgent(id) !== null,
    heldElsewhere: (id) => macs.accountHeldBy(id),
  });
  accounts.onChange(() => {
    broadcast({ type: "accounts_changed" });
    broadcast({ type: "chat_changed" });
  });
  threads.onChange(() => broadcast({ type: "chat_changed" }));
  const googleSignIn = new GoogleSignIn({ accounts, redirect: googleCallbackUrl(modPort) });
  const slackSessions = new SlackSessions({ home: homedir() });
  const statusOnly = (change: AccountChange) => change.kind === "status";
  const googleAuth = perAccount(accounts, (accountId) => new GoogleAuth({ accounts, account_id: accountId }), statusOnly);
  const gmailClient = perAccount(accounts, (accountId) => new GmailClient({ accounts, account_id: accountId, auth: googleAuth(accountId) }), statusOnly);
  const slackClient = perAccount(
    accounts,
    (accountId) => {
      const teamId = accountId.split(":")[1] ?? "";
      return new SlackClient({
        session: (fresh) => slackSessions.get(teamId, fresh),
        setStatus: (status) => accounts.setStatus(accountId, status),
      });
    },
    statusOnly,
  );
  const jiraClient = perAccount(accounts, (accountId) => jiraAccountClient(accounts, accountId), statusOnly);
  const mailPeople = new MailPeople({ file: join(paths.state, "mail-people.json") });
  accounts.onChange((change) => {
    if (change.kind === "disconnected") mailPeople.forget(change.account_id);
  });
  const restingIn = (accountId: string) => (r: ThreadRecord) =>
    outsideResting(seen.restsAll()[keyOf(`account:${accountId}`, outsideCardId(r))], r.newest_message_id, Date.now(), r.seeds);
  const previews = new OutsidePreviews({ dir: paths.chatImages });
  const wiring: AccountWiring = previewAccounts(process.env)
    ? previewWiring(threads)
    : {
        sources: (watcher) => ({
          gmail: gmailOutsideSource(gmailClient),
          jira: jiraOutsideSource(),
          slack: slackOutsideSource((accountId) => {
            const sync = watcher.syncOf(accountId);
            return sync instanceof SlackSync ? sync : null;
          }),
        }),
        factories: {
          gmail: (account) =>
            new GmailSync({ accounts, threads, account, client: gmailClient(account.account_id), people: mailPeople, resting: restingIn(account.account_id) }),
          slack: (account) => new SlackSync({ accounts, threads, account, client: slackClient(account.account_id), resting: restingIn(account.account_id) }),
          jira: (account) => new JiraSync({ accounts, threads, account, client: jiraClient(account.account_id), resting: restingIn(account.account_id) }),
        },
        threadText: { gmail: gmailThreadText(gmailClient), slack: slackThreadText(slackClient), jira: jiraThreadText(jiraClient) },
        cardView: {
          slack: slackChannelView(
            slackClient,
            slackPreviews(previews, (accountId, url) => slackClient(accountId).fileThumb(url)),
          ),
          jira: jiraCardView(
            jiraClient,
            async (accountId) => parseJiraSecret(await accounts.getSecret(accountId)),
            (accountId, attachmentId) => previews.preview(`jira:${accountId}:${attachmentId}`, () => jiraClient(accountId).thumbnail(attachmentId)),
          ),
        },
        clientFor: (account) => {
          switch (account.provider) {
            case "gmail":
              return { provider: "gmail", client: gmailClient(account.account_id) };
            case "slack":
              return { provider: "slack", client: slackClient(account.account_id) };
            case "jira":
              return { provider: "jira", client: jiraClient(account.account_id) };
          }
        },
      };
  const watcher = new AccountWatcher({ accounts, factories: wiring.factories, report: log });
  const sources = wiring.sources(watcher);
  threads.register("gmail", sources.gmail);
  threads.register("jira", sources.jira);
  threads.register("slack", sources.slack);
  watcher.start();
  const suggestions = host.suggestions
    ? new Suggestions({
        records: host.suggestions,
        chat: (ref) => {
          const desk = macs.desks().find((d) => d.conversation_id === ref.conversation_id && (d.agent_id ?? ref.agent_id) === ref.agent_id);
          return desk ? { title: desk.title, status: desk.status, has_draft: desk.has_draft === true } : null;
        },
        agentExists: (id) => readLocalAgent(id) !== null,
        agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
        call: chatCaller({ route: macs.router, backend: chatBackend, blocked: (agentId, conversationId) => macs.chatBlocked(agentId, conversationId) }),
        push: (agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }),
        track: (event, properties) => analytics.capture("mod", event, properties),
      })
    : undefined;
  const threadText = wiring.threadText;
  const handoff = new Handoff({
    file: join(paths.state, "handoffs.json"),
    accounts,
    threads,
    chats: () => macs.desks(),
    agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
    call: chatCaller({ route: macs.router, backend: chatBackend, blocked: (agentId, conversationId) => macs.chatBlocked(agentId, conversationId) }),
    threadText,
  });
  const slackPeople = new SlackPeople({ client: slackClient });
  const channelMembers = new ChannelMembers({ client: slackClient });
  const googlePeople = perAccount(accounts, (accountId) => new GooglePeople({ accounts, account_id: accountId, auth: googleAuth(accountId) }));
  const people = new People({
    accounts,
    slack: slackPeople,
    jira: (accountId) => jiraClient(accountId),
    google: googlePeople,
  });
  const outside = new OutsideThreads({
    accounts,
    threads,
    outbox: { file: join(paths.state, "outbox.json"), key: outboxKey(host.secrets) },
    people: mailPeople,
    slackPeople,
    threadText,
    cardView: wiring.cardView,
    clientFor: wiring.clientFor,
  });
  const ledger = new InboxLedger({ path: join(paths.state, "inbox-ledger.jsonl"), accounts, threads });
  const replies = new ReplyProposals({
    file: join(paths.state, "reply-proposals.json"),
    accounts,
    threads,
    outside,
    people,
    jira: (accountId) => jiraClient(accountId),
    members: (accountId, channel) => channelMembers.of(accountId, channel),
    clientFor: (account): ReplyReads => {
      switch (account.provider) {
        case "gmail":
          return { provider: "gmail", client: gmailClient(account.account_id) };
        case "slack":
          return { provider: "slack", client: slackClient(account.account_id) };
        case "jira": {
          const jira = jiraClient(account.account_id);
          return {
            provider: "jira",
            client: {
              ticketFacts: (idOrKey) => jira.ticketFacts(idOrKey),
              linkHost: async () => parseJiraSecret(await accounts.getSecret(account.account_id))?.link_host ?? null,
            },
          };
        }
      }
    },
    push: (agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }),
    changed: () => broadcast({ type: "chat_changed" }),
  });
  outside.reportAgentRepliesTo(replies);
  outside.resume();
  const askLink = host.askLink;
  const messages = askLink
    ? new ChatMessages({
        links: new LinkStore(join(paths.state, "chat-links.json")),
        chat: (ref) => {
          const desk = macs.desks().find((d) => d.conversation_id === ref.conversation_id && (d.agent_id ?? ref.agent_id) === ref.agent_id);
          return desk
            ? { title: desk.title, agent_name: desk.agent_name, mac: desk.home ? (desk.home_name ?? null) : null, open: desk.status === "live" }
            : null;
        },
        here: async (ref) => (await macs.router.target({ type: "chat_open", ...ref })) === null,
        ask: (source, ask, signal) => askLink(source.agent_id, source.conversation_id, ask, signal),
        forward: async (frame) => {
          const home = await macs.router.target(frame);
          if (!home) return { ok: false, message: "that chat is on this Mac" };
          const out = await macs.router.forward(home, frame, "request");
          return out.ok ? { ok: true, reply: out.reply ?? {} } : out;
        },
        power: (ref) => chatBackend.power(ref.agent_id, ref.conversation_id),
        deliver: (ref, text, context, sendId, cap) => {
          const blocked = macs.chatBlocked(ref.agent_id, ref.conversation_id);
          if (blocked) return Promise.resolve(blocked);
          return chatBackend.sendHeld({ ...ref, text, images: [], send_id: sendId, context }, cap);
        },
        push: (agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }),
        track: (event, properties) => analytics.capture("mod", event, properties),
      })
    : undefined;
  const taskMoves = serialQueue();
  const moveOpenTasks = (): Promise<unknown> => {
    if (!suggestions) return Promise.resolve();
    const s = suggestions;
    return taskMoves(() =>
      moveTasks({
        run: bdReader(tasksDir()),
        stateFile: join(paths.state, "migrations.json"),
        route: macs.router,
        suggestions: s,
        folderOf: (c) =>
          macs.desks().find((d) => d.conversation_id === c.conversation_id && (d.agent_id ?? c.agent_id) === c.agent_id)?.cwd ??
          folderFor(c.agent_id, c.conversation_id),
        report: (message) => log("tasks:move", message),
      }),
    ).catch((err: unknown) => log("tasks:move-failed", messageOf(err)));
  };
  void moveOpenTasks();
  const skillSources = new SkillSources({
    sourcesFile: join(paths.state, "skill-sources.json"),
    stagingDir: join(paths.state, "upstream"),
    serial: host.memory.serial,
  });
  const learnStatus = () => {
    const passes = new PassState(paths.state);
    const s = passes.settings().learn;
    const last = passes.learnLast();
    return {
      enabled: s.enabled,
      daily_cap: s.daily_cap,
      last_run_at: last?.at ?? null,
      last_run_note: last?.note ?? null,
      written_today: passes.writtenOn(isoDay(Date.now())),
    };
  };
  const lessons = { store: recallStore, widgetsDir: paths.widgets, expect: (id: string, change: WidgetChange) => widgetLog.expect(id, change, "loki") };

  const usagePush = coalesce(() => broadcast({ type: "usage_changed" }), 2000);
  const stopRestartDue = host.daemon?.onRestartDue((file) => sockets.push({ type: "restart_due", file }, { to: "desktop" }));
  const stopUsage = host.usage?.onChange(() => usagePush.schedule());

  const moduleDeps: ModuleDeps = {
    store,
    accounts,
    threads,
    handoff,
    outside,
    ledger,
    connect: { agentExists: (id) => readLocalAgent(id) !== null, googleSignIn, slackSessions },
    otherMacs: () => macs.accountsElsewhere(),
    widgets,
    gestures,
    listDesks: () => macs.desks(),
    listInbox: () => macs.inbox(),
    recall: {
      store: recallStore,
      status: learnStatus,
      setSettings: async (s) => {
        await chatBackend.setPasses({ learn: s });
      },
      run: async () => {
        await chatBackend.runLearn();
        return { note: learnStatus().last_run_note ?? "nothing new" };
      },
      startLesson: startLessonViaChats(chatBackend, lessons),
      lessonEmpty: (l) => chats.info(l.conversation_id, l.agent_id)?.lastMessageAt == null,
    },
    deskInfo,
    deleteWidgetFile,
    seen,
    transcript: (agentId, conversationId, limit, before) => chats.page(conversationId, agentId, limit, before),
    row: (agentId, conversationId, row) => chats.row(conversationId, agentId, row),
    widgetLog: (agentId, conversationId) => widgetLog.read(scopeFor(conversationId, agentId)),
    folders: { recent: () => chats.folders(), complete: completeFolder, check: checkFolder, pick: pickFolder },
    setPin: (agentId, conversationId, pinned) => setPin(agentId, conversationId, pinned),
    recentModels: { read: () => readRecentModels(), add: (handle) => addRecentModel(handle) },
    usualModels: { read: () => readUsualModels(), record: (agentId, handle, effort) => recordUsualModel(agentId, handle, effort, new Date()) },
    chat: withRepliesOnOpen(withLinksOnOpen(suggestions ? withSuggestionsOnOpen(chatBackend, suggestions) : chatBackend, messages), replies),
    suggestions,
    messages,
    replies,
    decidedBy: (c) => (c.deviceId ? "phone" : c.peerId ? macs.mac(c.peerId).name : "desktop"),
    usage: host.usage,
    daemon: host.daemon,
    lan: {
      status: () => phones().status(),
      refresh: () => phones().refresh(),
      setEnabled: (enabled) => phones().setEnabled(enabled),
      setVia: (via) => phones().setVia(via),
      setServe: (enabled) => phones().setServe(enabled),
      pairBegin: () => {
        const { code, expiresAt } = codes.mint();
        log("lan:pair-code", { expiresAt });
        return { code, url: phones().pairUrl(code), expires_at: expiresAt };
      },
      devices: () => devices.list(),
      forget: (id) => phones().forget(id),
    },
    peers: macs.frames,
    chatBlocked: (agentId, conversationId) => macs.chatBlocked(agentId, conversationId),
    titleFrame: (agentId, conversationId) => listing.titleFrame(scopeFor(conversationId, agentId)),
    agentDeleteBlocked: (agentId) => accounts.deleteBlocked(agentId) ?? macs.agentDeleteBlocked(agentId),
    agents: {
      get: (id) => readLocalAgent(id),
      tree: (id) => memoryTree(id),
      skills: (id) => memorySkills(id),
      skillsInfo: (id) => skillSources.annotate(id, memorySkills(id)),
      refreshSkill: (id, name, spec) => skillSources.refresh(id, name, spec),
      hasProfile: (id) => profilePath(id) !== null,
      read: (id, path) => readMemoryFile(id, path),
      log: (id, opts) => memoryLog(id, opts),
      diff: (id, sha) => memoryDiff(id, sha),
      reflection: (id) => reflectionState(id),
      globalSkills: () => listGlobalSkills().map((g) => ({ ...g, source: skillSources.describeGlobal(g) })),
      install: (id, source, force) => installSkill(source, id, { force }),
    },
  };
  const bridge = createBridge({
    modules: frameModules(moduleDeps),
    welcome: welcomeFrames(moduleDeps),
    broadcast,
    capture: (client, event, properties) => analytics.capture(client.deviceId ? "phone" : "mac", event, properties),
    route: macs.router,
  });
  const chatImageFromPeers = (name: string) => macs.chatImage(name);
  const serve = async (): Promise<LokiServer> => {
    const start = () =>
      startServer({
        port: modPort,
        token,
        profile: (agentId) => profilePath(agentId),
        uploads: paths.uploads,
        routes: [
          oauthCallbackRoute(MCP_OAUTH_CALLBACK, (params) => host.chat.mcpOauthCallback(params)),
          chatImageRoute({ prefix: "/chat-images/", dir: paths.chatImages, authorize: tokenAuth(token), denied: 403, fetchRemote: chatImageFromPeers }),
        ],
        health: () => ({ desks: store.scopes(), widgets: widgets.entries().length, tabs: sockets.tabs() }),
        googleSignIn: (params) => googleSignIn.finish(params),
      });
    try {
      const s = await sockets.serve(start, (started) => attachWs(started.server, token, bridge));
      log("server:listening", { port: s.port });
      return s;
    } catch (err) {
      log("server:failed", messageOf(err));
      api.diagnostics.report({
        message: `loki: server failed to start on ${modPort} (${messageOf(err)})`,
        severity: "error",
      });
      throw err;
    }
  };
  void serve().catch((err: unknown) => log("server:error", messageOf(err)));

  const lanPort = Number(process.env.LOKI_LAN_PORT ?? DEFAULT_LAN_PORT);
  const lan: LanListener = new LanListener({
    port: lanPort,
    tailscale,
    stateFile: paths.lan,
    devices,
    codes,
    handlers: bridge,
    desktopToken: token,
    profile: (agentId) => profilePath(agentId),
    uploads: paths.uploads,
    chatImages: { dir: paths.chatImages, fetchRemote: chatImageFromPeers },
    peers: macs.peers,
    health: () => ({ phones: lan.clientCount() }),
    onChange: (what, status) => {
      if (what === "status") {
        log("lan:status", status);
        sockets.push({ type: "lan_status", ...status }, { to: "desktop" });
      } else {
        sockets.push({ type: "devices", devices: devices.list() }, { to: "desktop" });
      }
    },
  });
  sockets.attachPhones(lan);
  if (lan.enabled()) void lan.start();
  macs.start();

  const eventDisposers: Array<() => void> = [];
  const titleRefreshes = new ScopeDebouncer(1200);
  const ignored = (e: ChatRef) => passChat(e.chatId);

  eventDisposers.push(
    api.events.on("chat_open", (e) => {
      log("event:chat_open", { id: e.chatId });
      if (ignored(e)) return;
      const next = desks.remember(e.chatId, e.agentId);
      if (next !== activeScope) {
        activeScope = next;
        broadcast({ type: "switch_desk", scope: activeScope });
      }
    }),
  );

  eventDisposers.push(
    api.message.transform((m) => {
      if (passChat(m.chatId)) return undefined;
      const scope = desks.remember(m.chatId, m.agentId);
      activeScope = scope;
      const lines = [...gestures.drain(scope), ...(scope !== SHARED_SCOPE ? gestures.drain(SHARED_SCOPE) : [])];
      log("event:message", { desk: scope, attached: lines.length });
      seen.mark(m.agentId, m.chatId);
      if (m.typed) seen.engage(m.agentId, m.chatId, "message");
      broadcast(seenChatFrame(seen, m.agentId, m.chatId));
      if (!lines.length) return undefined;
      return attachDeskContext(m.content, formatDeskContext(scope, lines, paths.widgets));
    }),
  );

  eventDisposers.push(
    api.events.on("tool_start", (e) => {
      if (e.name.startsWith("desk_") || e.name.startsWith("loki_")) {
        log("event:tool_start", { tool: e.name, args: e.args });
        analytics.capture("mod", "tool_used", { tool: e.name });
      }
    }),
  );
  eventDisposers.push(
    api.events.on("tool_end", (e) => {
      if (e.name.startsWith("desk_") || e.name.startsWith("loki_")) log("event:tool_end", { tool: e.name, failed: e.failed });
    }),
  );

  eventDisposers.push(
    api.events.on("turn_end", (e) => {
      if (ignored(e)) return;
      const scope = desks.remember(e.chatId, e.agentId);
      titleRefreshes.schedule(scope, () => {
        const frame = listing.titleFrame(scope);
        if (frame) broadcast(frame, scope === SHARED_SCOPE ? undefined : scope);
      });
    }),
  );

  const toolDisposers = registerTools(api, {
    store,
    widgets,
    gestures,
    widgetsDir: paths.widgets,
    activeScope: () => activeScope,
    remember: (conversationId, agentId) => desks.remember(conversationId, agentId ?? null),
    broadcast,
    chats: suggestions
      ? {
          suggestions,
          agents: async () =>
            (await chatBackend.agents()).map((a) => {
              const mac = macs.mac(a.home_mac || null);
              return { id: a.id, name: a.name, mac: mac.name, reachable: mac.reachable };
            }),
          chats: () => macs.desks(),
          passChat,
          messages,
        }
      : undefined,
  });
  toolDisposers.push(
    ...registerAccountScriptTools(api, { accounts, threads, slack: slackClient, jira: jiraClient, people, slackPeople }),
    ...registerReplyTools(api, { accounts, replies }),
    ...registerGoogleTools(api, {
      accounts,
      auth: googleAuth,
      gmail: gmailClient,
      heldElsewhere: (id) => macs.accountHeldBy(id),
      resultsDir: (chatId) => join(lokiDir(), "tool-results", chatId.replace(/[^A-Za-z0-9_.-]+/g, "_")),
    }),
  );

  const shutdown = (): void => {
    log("shutdown");
    watcher.stop();
    replies.stop();
    sockets.stop();
    macs.stop();
    widgets.close();
    titleRefreshes.clear();
    seen.flush();
  };
  api.signal.addEventListener("abort", shutdown, { once: true });

  return () => {
    stopUsage?.();
    stopRestartDue?.();
    usagePush.cancel();
    for (const d of eventDisposers) d();
    for (const d of toolDisposers) d();
    stopPersist();
    shutdown();
  };
}
