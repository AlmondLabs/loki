import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { SHARED_SCOPE, scopeFor, type Scope } from "../core/chat-scope.ts";
import type { ChatRef, ModApi } from "../daemon/mods/api.ts";
import { ScopeDebouncer } from "./lifecycle-events.ts";
import { appVersion, DEFAULT_LAN_PORT, DEFAULT_MOD_PORT, MCP_OAUTH_CALLBACK, lokiDir, paths } from "./paths.ts";
import { registerGoogleTools } from "./google-tools/index.ts";
import { checkFolder, completeFolder, pickFolder } from "./folders.ts";
import { ChatRegistry } from "./chats.ts";
import { ChatListing } from "./chat-listing.ts";
import type { ChatSource } from "./chat-source.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { RestartAnswer } from "./frames/daemon.ts";
import { SeenStore } from "./seen.ts";
import { LearnStore, isoDay } from "./learn.ts";
import { isPassChat, startLessonViaChats } from "./learn-worker.ts";
import { PassState } from "../daemon/passes-state.ts";
import { readPins, setPin } from "./pins.ts";
import { addRecentModel, readRecentModels } from "./models.ts";
import { readUsualModels, recordUsualModel } from "./usual-models.ts";
import { installSkill, listGlobalSkills } from "./skills.ts";
import { SkillSources } from "./skill-sources.ts";
import { reflectionState } from "./reflection.ts";
import { memoryDiff, memoryLog, memorySkills, memoryTree, profilePath, readLocalAgent, readMemoryFile } from "./agents.ts";

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
import { keyOf, type ChatEvent } from "../core/attention/model.ts";
import { AccountWatcher } from "./account-watcher.ts";
import { GmailClient } from "./gmail.ts";
import { MailReactions } from "./mail-reactions.ts";
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
import { FlowLedger } from "./flow-ledger.ts";
import { MailPeople } from "./mail-people.ts";
import { gmailCardView, gmailThreadText } from "./account-ops/gmail.ts";
import { slackThreadText } from "./account-ops/slack.ts";
import { Handoff } from "./handoff.ts";
import { slackChannelView } from "./slack-view.ts";
import { jiraCardView, jiraThreadText } from "./jira-view.ts";
import { coalesce } from "../core/timers.ts";
import { Suggestions, chatCaller, withSuggestionsOnOpen, type SuggestionRecords } from "./suggestions.ts";
import { ChatMessages, LinkStore, withLinksOnOpen } from "./chat-links.ts";
import { SubagentStrips, withSubagentsOnOpen } from "./chat-subagents.ts";
import type { LinkAnswer, LinkAsk } from "../core/chat-links.ts";
import { registerTools } from "./tools.ts";
import { registerAccountScriptTools } from "./account-ops/script-tools.ts";
import { GooglePeople } from "./google-people.ts";
import { People } from "./people.ts";
import { ReplyProposals, registerReplyTools, withRepliesOnOpen } from "./reply-proposals.ts";
import type { ReplyReads } from "./account-ops/reply-reader.ts";
import { initLog, log } from "./log.ts";
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

/** What the daemon hosts the mod with besides the mod API: its chats, to read and to run. */
export interface Host {
  chats: ChatSource;
  chat: ChatBackend;
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

export function activateLoki(api: ModApi, host: Host): () => void {
  initLog(paths.modLog);
  log("activate", { pid: process.pid, node: process.versions.node, api: api.apiVersion });

  const modPort = Number(process.env.LOKI_PORT ?? DEFAULT_MOD_PORT);
  const token = loadOrCreateToken();

  const learnStore = new LearnStore();
  const passChat = isPassChat;

  let activeScope: Scope = SHARED_SCOPE;

  const sockets = new Sockets<LanListener>();
  const phones = (): LanListener => sockets.phones();
  let peering: Peering | null = null;
  const broadcast = (msg: object, scope?: Scope) => {
    sockets.push(msg, { scope });
    peering?.pushed((msg as { type?: string }).type ?? "");
  };

  const { chats, chat: chatBackend } = host;
  const chatEvents = (agentId: string, conversationId: string, events: ChatEvent[]) =>
    broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events });
  const subagentStrips = new SubagentStrips(chatBackend, chatEvents);
  chatBackend.attach((agentId, conversationId, events) => {
    chatEvents(agentId, conversationId, events);
    subagentStrips.heard(agentId, conversationId, events);
  });
  const desks = new ChatRegistry(join(paths.state, "chats.json"), (id) => chats.agentOf(id));
  const seen = new SeenStore(join(paths.state, "attention.json"));

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
    pins: () => readPins(),
    passChats: () => isPassChat,
    activeScope: () => activeScope,
    outside: () => threads.rows(),
    replies: (agentId, conversationId) => replies.open({ agent_id: agentId, conversation_id: conversationId }),
  });
  const chatMeta = (scope: Scope) => listing.info(scope);
  const listLocalDesks = () => listing.summaries();
  const listLocalFlow = () => listing.flow();
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
    local: { chats: listLocalDesks, flow: listLocalFlow },
    dirs: paths,
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
  const mailReactions = perAccount(accounts, (accountId) => new MailReactions(gmailClient(accountId)), statusOnly);
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
    outsideResting(seen.restOf(keyOf(`account:${accountId}`, outsideCardId(r))) ?? undefined, r.newest_message_id, Date.now(), r.seeds);
  const previews = new OutsidePreviews({ dir: paths.chatImages });
  const wiring: AccountWiring = previewAccounts(process.env)
    ? previewWiring(threads)
    : {
        mailReactions,
        sources: (watcher) => ({
          gmail: gmailOutsideSource(gmailClient, mailReactions),
          jira: jiraOutsideSource(),
          slack: slackOutsideSource((accountId) => {
            const sync = watcher.syncOf(accountId);
            return sync instanceof SlackSync ? sync : null;
          }),
        }),
        factories: {
          gmail: (account) =>
            new GmailSync({
              accounts,
              threads,
              account,
              client: gmailClient(account.account_id),
              people: mailPeople,
              reactions: mailReactions(account.account_id),
              resting: restingIn(account.account_id),
            }),
          slack: (account) => new SlackSync({ accounts, threads, account, client: slackClient(account.account_id), resting: restingIn(account.account_id) }),
          jira: (account) => new JiraSync({ accounts, threads, account, client: jiraClient(account.account_id), resting: restingIn(account.account_id) }),
        },
        threadText: { gmail: gmailThreadText(gmailClient, mailReactions), slack: slackThreadText(slackClient), jira: jiraThreadText(jiraClient) },
        cardView: {
          gmail: gmailCardView(gmailClient, (key, read) => previews.preview(key, read), mailReactions),
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
          const local = chats.info(ref.conversation_id, ref.agent_id);
          if (local) return { title: local.title, status: local.archived ? "archived" : "live", has_draft: local.hasDraft };
          const desk = macs.summaries().find((d) => d.conversation_id === ref.conversation_id && (d.agent_id ?? ref.agent_id) === ref.agent_id);
          return desk ? { title: desk.title, status: desk.status, has_draft: desk.has_draft === true } : null;
        },
        agentExists: (id) => readLocalAgent(id) !== null,
        agentHome: (id) => readLocalAgent(id)?.home_mac ?? null,
        call: chatCaller({ route: macs.router, backend: chatBackend, blocked: (agentId, conversationId) => macs.chatBlocked(agentId, conversationId) }),
        push: (agentId, conversationId, events) => broadcast({ type: "chat_event", agent_id: agentId, conversation_id: conversationId, events }),
      })
    : undefined;
  const threadText = wiring.threadText;
  const handoff = new Handoff({
    file: join(paths.state, "handoffs.json"),
    accounts,
    threads,
    chats: () => macs.summaries(),
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
    ...(wiring.mailReactions ? { mailReactions: wiring.mailReactions } : {}),
  });
  const ledgerPath = join(paths.state, "flow-ledger.jsonl");
  const legacyLedgerPath = join(paths.state, "inbox-ledger.jsonl");
  if (!existsSync(ledgerPath) && existsSync(legacyLedgerPath)) {
    try {
      renameSync(legacyLedgerPath, ledgerPath);
    } catch {}
  }
  const ledger = new FlowLedger({ path: ledgerPath, accounts, threads });
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
          return { provider: "gmail", client: gmailClient(account.account_id), reactions: mailReactions(account.account_id) };
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
          const local = chats.info(ref.conversation_id, ref.agent_id);
          if (local) {
            const agent = readLocalAgent(local.agentId ?? ref.agent_id);
            const agentName = agent && agent.name !== agent.id ? agent.name : null;
            return { title: local.title, agent_name: agentName, mac: null, open: !local.archived };
          }
          const desk = macs.summaries().find((d) => d.conversation_id === ref.conversation_id && (d.agent_id ?? ref.agent_id) === ref.agent_id);
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
      })
    : undefined;
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
  const lessons = { store: learnStore };

  const usagePush = coalesce(() => broadcast({ type: "usage_changed" }), 2000);
  const stopRestartDue = host.daemon?.onRestartDue((file) => sockets.push({ type: "restart_due", file }, { to: "desktop" }));
  const stopUsage = host.usage?.onChange(() => usagePush.schedule());

  const moduleDeps: ModuleDeps = {
    accounts,
    threads,
    handoff,
    outside,
    ledger,
    connect: { agentExists: (id) => readLocalAgent(id) !== null, googleSignIn, slackSessions },
    otherMacs: () => macs.accountsElsewhere(),
    listChats: () => macs.summaries(),
    listFlow: () => macs.flow(),
    learn: {
      store: learnStore,
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
    chatMeta,
    seen,
    ensureTranscript: (agentId, conversationId) => chats.ensureLoaded?.(conversationId, agentId),
    transcript: (agentId, conversationId, limit, before) => chats.page(conversationId, agentId, limit, before),
    row: (agentId, conversationId, row) => chats.row(conversationId, agentId, row),
    folders: { recent: () => chats.folders(), complete: completeFolder, check: checkFolder, pick: pickFolder },
    setPin: (agentId, conversationId, pinned) => setPin(agentId, conversationId, pinned),
    recentModels: { read: () => readRecentModels(), add: (handle) => addRecentModel(handle) },
    usualModels: { read: () => readUsualModels(), record: (agentId, handle, effort) => recordUsualModel(agentId, handle, effort, new Date()) },
    chat: withRepliesOnOpen(
      withLinksOnOpen(withSubagentsOnOpen(suggestions ? withSuggestionsOnOpen(chatBackend, suggestions) : chatBackend), messages),
      replies,
    ),
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
        health: () => ({ tabs: sockets.tabs() }),
        googleSignIn: (params) => googleSignIn.finish(params),
      });
    try {
      const s = await sockets.serve(start, (started) => attachWs(started.server, token, bridge));
      log("server:listening", { port: s.port });
      return s;
    } catch (err) {
      log.error("server:failed", messageOf(err));
      api.diagnostics.report({
        message: `loki: server failed to start on ${modPort} (${messageOf(err)})`,
        severity: "error",
      });
      throw err;
    }
  };
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
  let stopped = false;
  void serve()
    .then(() => {
      process.send?.("ready");
      if (stopped) return;
      if (lan.enabled()) void lan.start();
      macs.start();
    })
    .catch((err: unknown) => log.error("server:error", messageOf(err)));

  const eventDisposers: Array<() => void> = [subagentStrips.start()];
  const titleRefreshes = new ScopeDebouncer(1200);
  const ignored = (e: ChatRef) => passChat(e.chatId);

  eventDisposers.push(
    api.events.on("chat_open", (e) => {
      log("event:chat_open", { id: e.chatId });
      if (ignored(e)) return;
      const next = desks.remember(e.chatId, e.agentId);
      if (next !== activeScope) {
        activeScope = next;
        broadcast({ type: "switch_chat", scope: activeScope });
      }
    }),
  );

  eventDisposers.push(
    api.message.transform((m) => {
      if (passChat(m.chatId)) return undefined;
      const scope = desks.remember(m.chatId, m.agentId);
      activeScope = scope;
      seen.mark(m.agentId, m.chatId);
      if (m.typed) seen.engage(m.agentId, m.chatId, "message");
      broadcast(seenChatFrame(seen, m.agentId, m.chatId));
      return undefined;
    }),
  );

  eventDisposers.push(
    api.events.on("tool_start", (e) => {
      if (e.name.startsWith("desk_") || e.name.startsWith("loki_")) {
        log("event:tool_start", { tool: e.name, args: e.args });
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
    chats: suggestions
      ? {
          suggestions,
          agents: async () =>
            (await chatBackend.agents()).map((a) => {
              const mac = macs.mac(a.home_mac || null);
              return { id: a.id, name: a.name, mac: mac.name, reachable: mac.reachable };
            }),
          chats: () => macs.summaries(),
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
    stopped = true;
    log("shutdown");
    watcher.stop();
    replies.stop();
    sockets.stop();
    macs.stop();
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
    shutdown();
  };
}
