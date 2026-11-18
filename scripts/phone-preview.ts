import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const FAKE_AGENT = join(repo, "test", "fixtures", "fake-acp.mjs");
const ENGINE_ID = "made-up";
const START_MS = 60_000;
const TURN_MS = 20_000;
const STOP_MS = 5_000;

export const LAN_STATE = JSON.stringify({ enabled: true, via: "lan" });

const CREDENTIAL =
  /(_API_KEY|_TOKEN|_SECRET|_ACCESS_KEY|_ACCESS_KEY_ID)$|^AWS_|^AZURE_|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^GEMINI_|^GOOGLE_APPLICATION_CREDENTIALS$/;

export interface Ports {
  port: number;
  lanPort: number;
}

export function previewEnv(base: Record<string, string | undefined>, scratch: string, ports: Ports): Record<string, string> {
  const kept = Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !CREDENTIAL.test(e[0]) && !e[0].startsWith("LOKI_"));
  return {
    ...Object.fromEntries(kept),
    HOME: scratch,
    USERPROFILE: scratch,
    LOKI_DIR: join(scratch, ".loki"),
    LOKI_SKILLS_DIR: join(scratch, "skills"),
    LOKI_KEYCHAIN: "0",
    LOKI_ANALYTICS: "0",
    LOKI_BUILT_PAGE: "1",
    LOKI_PORT: String(ports.port),
    LOKI_LAN_PORT: String(ports.lanPort),
  };
}

export function parseArgs(argv: readonly string[]): { keep: boolean } {
  const unknown = argv.filter((a) => a !== "--keep");
  if (unknown.length) throw new Error(`phone-preview: unknown option ${unknown[0]}; the only one is --keep`);
  return { keep: argv.includes("--keep") };
}

export function pairLink(code: string, lanPort: number): string {
  return `http://localhost:${lanPort}/?code=${encodeURIComponent(code)}`;
}

export interface SeedChat {
  title: string;
  text: string;
  ends: "turn" | "long" | "approval";
}

export interface SeedAgent {
  name: string;
  description: string;
  chats: SeedChat[];
}

export const SEED: SeedAgent[] = [
  {
    name: "Juniper",
    description: "Looks after the garden club's newsletter",
    chats: [
      { title: "Spring newsletter", text: "Draft the spring newsletter from the meeting notes.", ends: "turn" },
      { title: "Seed swap", text: "Tell me the long story of how the seed swap began, every year of it.", ends: "long" },
      { title: "Member list", text: "Please edit the member list to add the three new names.", ends: "approval" },
    ],
  },
  {
    name: "Basil",
    description: "Keeps the recipe box in order",
    chats: [
      { title: "Soup for twelve", text: "Scale the leek soup for twelve people.", ends: "turn" },
      { title: "Shopping list", text: "Make a shopping list for Saturday's lunch.", ends: "turn" },
    ],
  },
  {
    name: "Wren",
    description: "Tracks the bird counts",
    chats: [
      { title: "Weekend count", text: "Add up the weekend's sightings by species.", ends: "turn" },
      { title: "Count sheet", text: "Please edit the count sheet so it has a column for the weather.", ends: "approval" },
    ],
  },
];

export type Message = { type: string; request_id?: string; message?: string } & Record<string, unknown>;

export function pushWaiter() {
  const waiting = new Set<{ match: (m: Message) => boolean; resolve: (m: Message) => void }>();
  return {
    push: (m: Message) => {
      for (const w of waiting)
        if (w.match(m)) {
          waiting.delete(w);
          w.resolve(m);
        }
    },
    wait: (match: (m: Message) => boolean, ms = TURN_MS, what = "a reply"): Promise<Message> =>
      new Promise((resolve, reject) => {
        const entry = {
          match,
          resolve: (m: Message) => {
            clearTimeout(timer);
            resolve(m);
          },
        };
        const timer = setTimeout(() => {
          waiting.delete(entry);
          reject(new Error(`phone-preview: no ${what} in ${ms / 1000}s`));
        }, ms);
        waiting.add(entry);
      }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(lokiDir: string, port: number) {
  const token = readFileSync(join(lokiDir, "token"), "utf8").trim();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(token)}`);
  const pushes = pushWaiter();
  ws.addEventListener("message", (e) => pushes.push(JSON.parse(String(e.data)) as Message));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("phone-preview: the socket refused the token")), { once: true });
  });
  let n = 0;
  const request = async (type: string, payload: Record<string, unknown> = {}): Promise<Message> => {
    const requestId = `preview-${++n}`;
    const reply = pushes.wait((m) => m.request_id === requestId, TURN_MS, `answer to ${type}`);
    ws.send(JSON.stringify({ type, request_id: requestId, ...payload }));
    const m = await reply;
    if (m.type === "error") throw new Error(`phone-preview: ${type}: ${m.message ?? "failed"}`);
    return m;
  };
  const send = (type: string, payload: Record<string, unknown> = {}) => ws.send(JSON.stringify({ type, ...payload }));
  return { request, send, wait: pushes.wait, close: () => ws.close() };
}

type Socket = Awaited<ReturnType<typeof connect>>;

const chatEvent = (agentId: string, conversationId: string, kind: string) => (m: Message) =>
  m.type === "chat_event" &&
  m.agent_id === agentId &&
  m.conversation_id === conversationId &&
  Array.isArray(m.events) &&
  (m.events as Array<{ kind?: string }>).some((e) => e.kind === kind);

interface SeededChat {
  agentId: string;
  conversationId: string;
  chat: SeedChat;
}

let sends = 0;

async function sendInto(sock: Socket, { agentId, conversationId, chat }: SeededChat): Promise<void> {
  await sock.request("chat_open", { agent_id: agentId, conversation_id: conversationId });
  const settled = sock.wait(chatEvent(agentId, conversationId, chat.ends === "approval" ? "approval" : "turn_end"), TURN_MS, `end of "${chat.title}"`);
  const sent = sock.request("chat_send", { agent_id: agentId, conversation_id: conversationId, text: chat.text, send_id: `preview-${++sends}` });
  await Promise.all([sent, settled]);
}

async function seed(sock: Socket): Promise<SeededChat[]> {
  await sock.request("chat_engine_set", { id: ENGINE_ID, name: "Made-up agent", command: process.execPath, args: [FAKE_AGENT] });
  const waiting: SeededChat[] = [];
  for (const agent of SEED) {
    const made = await sock.request("chat_agent_create", { name: agent.name, description: agent.description });
    const agentId = String(made.id);
    for (const chat of agent.chats) {
      const created = await sock.request("chat_create", { agent_id: agentId, title: chat.title });
      const seeded = { agentId, conversationId: String(created.conversation_id), chat };
      await sock.request("chat_model", { agent_id: agentId, conversation_id: seeded.conversationId, handle: `acp:${ENGINE_ID}/default` });
      await sendInto(sock, seeded);
      if (chat.ends === "approval") waiting.push(seeded);
    }
    console.log(`  ${agent.name}: ${agent.chats.length} chats`);
  }
  return waiting;
}

async function printPairLink(sock: Socket, lanPort: number): Promise<void> {
  const code = sock.wait((m) => m.type === "pair_code", TURN_MS, "pairing code");
  sock.send("pair_begin");
  const m = await code;
  console.log(`\nOpen this to pair a browser as a phone (once, within ten minutes; press Enter for another):\n  ${pairLink(String(m.code), lanPort)}\n`);
}

interface Daemon {
  child: ChildProcess;
  stop: () => Promise<void>;
}

async function startDaemon(env: Record<string, string>, ports: Ports, log: string[]): Promise<Daemon> {
  const lokiDir = env.LOKI_DIR;
  const tokenFile = join(lokiDir, "token");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(repo, "daemon", "main.ts"),
      "--loki-daemon",
      "--dir",
      lokiDir,
      "--mod",
      join(repo, "mod", "boot.ts"),
      "--token-file",
      tokenFile,
    ],
    { cwd: env.HOME, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const keep = (d: Buffer) => {
    log.push(d.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (!running()) return;
    child.kill();
    await Promise.race([exited, sleep(STOP_MS)]);
    if (running()) child.kill("SIGKILL");
  };
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    if (!running()) throw new Error(`phone-preview: the daemon exited:\n${log.join("")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${ports.port}/health`);
      if (r.ok && existsSync(tokenFile)) return { child, stop };
    } catch {}
    await sleep(250);
  }
  await stop();
  throw new Error(`phone-preview: the daemon did not answer /health within ${START_MS / 1000}s:\n${log.join("")}`);
}

async function main(): Promise<void> {
  const { keep } = parseArgs(process.argv.slice(2));
  if (!existsSync(join(repo, "app", "dist", "index.html"))) {
    console.log("phone-preview: building the phone's page");
    execFileSync("npm", ["run", "build:app"], { cwd: repo, stdio: "inherit" });
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "loki-phone-preview-")));
  const ports = { port: await freePort(), lanPort: await freePort() };
  const env = previewEnv(process.env, scratch, ports);
  const log: string[] = [];
  let stopping = false;
  let daemon: Daemon | null = null;
  let sock: Socket | null = null;

  const finish = async (code: number) => {
    if (stopping) return;
    stopping = true;
    sock?.close();
    await daemon?.stop();
    if (keep) console.log(`\nphone-preview: kept ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
    process.exit(code);
  };
  const fail = (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    void finish(1);
  };
  process.on("SIGINT", () => void finish(0));
  process.on("SIGTERM", () => void finish(0));

  try {
    mkdirSync(join(env.LOKI_DIR, "state"), { recursive: true });
    writeFileSync(join(env.LOKI_DIR, "state", "lan.json"), LAN_STATE);
    console.log(`phone-preview: a throwaway daemon in ${scratch}\n  desktop socket on ${ports.port}, phone listener on ${ports.lanPort}`);
    daemon = await startDaemon(env, ports, log);
    sock = await connect(env.LOKI_DIR, ports.port);
    const waiting = await seed(sock);
    await printPairLink(sock, ports.lanPort);

    const restart = async () => {
      console.log("phone-preview: the daemon stopped for a code change; starting it again");
      sock?.close();
      daemon = await startDaemon(env, ports, log);
      watch(daemon);
      if (stopping) return;
      sock = await connect(env.LOKI_DIR, ports.port);
      for (const w of waiting) await sendInto(sock, w);
      console.log("phone-preview: back, with its approvals waiting again; reload the page");
    };
    const watch = (d: Daemon) =>
      d.child.once("exit", () => {
        if (!stopping) restart().catch(fail);
      });
    watch(daemon);

    createInterface({ input: process.stdin }).on("line", () => {
      if (sock) printPairLink(sock, ports.lanPort).catch((e: unknown) => console.error(e instanceof Error ? e.message : String(e)));
    });
  } catch (e) {
    fail(e);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
