import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { POWERSHELL_GATEWAY_ARGS, listeningPorts, parseGatewayUrls, parseLsofPorts, parseNetstatPorts, parseProcNetTcp, probeAppServer, procCommandLines, procListeningPorts } from "../mod/app-server.ts";

/** A fake Letta app-server speaking just enough of the protocol. */
function fakeAppServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WebSocket>();
  const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(m);
      if (m.type === "app_server_info") {
        // real servers replay pending state before answering; the probe must not mistake it for a refusal
        ws.send(JSON.stringify({ type: "control_request", request_id: "perm-x", request: { subtype: "can_use_tool", tool_name: "Bash" }, agent_id: "a", conversation_id: "c" }));
        ws.send(JSON.stringify({ type: "app_server_info_response", request_id: m.request_id, success: true, backend: "local", protocol_version: 1, capabilities: { runtime_start: true } }));
      } else if (m.type === "runtime_start") {
        const ok = m.agent_id !== "agent-missing";
        ws.send(JSON.stringify({ type: "runtime_start_response", request_id: m.request_id, success: ok, ...(ok ? { runtime: { agent_id: m.agent_id, conversation_id: m.conversation_id } } : { error: "Agent agent-missing not found" }) }));
      } else if (m.type === "input") {
        // the real server acknowledges with input_accepted (no _response suffix)
        ws.send(JSON.stringify({ type: "input_accepted", request_id: m.request_id, runtime: m.runtime, accepted: true, disposition: "started" }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    received,
    push: (event: object) => {
      for (const s of sockets) s.send(JSON.stringify(event));
    },
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

describe("app-server client", () => {
  test("probe recognizes an app-server and rejects a plain websocket", async () => {
    const srv = fakeAppServer();
    const plain = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    try {
      expect(await probeAppServer(srv.url)).toMatchObject({ protocol_version: 1, backend: "local" });
      expect(await probeAppServer(`ws://127.0.0.1:${(plain.address() as { port: number }).port}/ws`, 400)).toBeNull();
      expect(await probeAppServer("ws://127.0.0.1:1/ws", 400)).toBeNull();
    } finally {
      await srv.close();
      plain.close();
    }
  });



  test("discovery parsers: lsof -Fn output and the gateway command line", () => {
    expect(parseLsofPorts("p56965\nn127.0.0.1:41414\nn127.0.0.1:49985\nn*:41414\n")).toEqual([41414, 49985]);
    expect(parseGatewayUrls("/Applications/Letta.app/Contents/MacOS/Letta letta.js channel-gateway --app-server-url ws://127.0.0.1:49985/ws --channels  --restore-enabled-channels\nnode vite\n")).toEqual(["ws://127.0.0.1:49985/ws"]);
    expect(parseGatewayUrls("nothing here")).toEqual([]);
  });

  // The real OS first: whatever reader this system uses (lsof, /proc, netstat) must see a port this very
  // test process listens on, and not one that is closed, before discovery is trusted with it.
  test("the OS reader lists a port this process listens on, and not a closed one", async () => {
    const srv = fakeAppServer();
    const port = Number(new URL(srv.url).port);
    const closed = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    try {
      const ports = await listeningPorts(process.pid);
      expect(ports).toContain(port);
      expect(ports).not.toContain(closed);
    } finally {
      await srv.close();
    }
    expect(await listeningPorts(process.pid)).not.toContain(port);
  }, 20_000);

  test("Linux: /proc/net/tcp{,6} rows in LISTEN whose inode is one of the process's sockets", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:A1F6 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:C2C1 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9999 1 0000000000000000 100 0 0 10 0",
      "   2: 0100007F:A1F6 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 5552 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:A1F7 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5553 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    // 41462 (A1F6) listening and ours; 49857 (C2C1) listening but another process's; an established row is no listener.
    expect(parseProcNetTcp(`${tcp}\n${tcp6}`, new Set(["5551", "5552", "5553"]))).toEqual([41462, 41463]);
    expect(parseProcNetTcp(tcp, new Set())).toEqual([]);
    expect(parseProcNetTcp("garbage\n\n", new Set(["1"]))).toEqual([]);
  });

  // Symlinks named `socket:[…]` are a unix thing; Windows cannot make them without privileges.
  test.skipIf(process.platform === "win32")("Linux: the same off a /proc tree — fd links name the sockets, net/tcp{,6} under the pid lists them", () => {
    const tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:A1F6 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0000000000000000 100 0 0 10 0";
    const tcp6 = "   0: 00000000000000000000000001000000:A1F7 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5553 1 0000000000000000 100 0 0 10 0";
    const root = mkdtempSync(join(tmpdir(), "loki-proc-"));
    mkdirSync(join(root, "4242", "fd"), { recursive: true });
    mkdirSync(join(root, "4242", "net"), { recursive: true });
    symlinkSync("socket:[5551]", join(root, "4242", "fd", "3"));
    symlinkSync("socket:[5553]", join(root, "4242", "fd", "4"));
    symlinkSync("/dev/null", join(root, "4242", "fd", "0"));
    writeFileSync(join(root, "4242", "net", "tcp"), tcp);
    writeFileSync(join(root, "4242", "net", "tcp6"), tcp6);
    expect(procListeningPorts(4242, root).sort()).toEqual([41462, 41463]);
    expect(procListeningPorts(1, root)).toEqual([]); // no such process
  });

  test("Linux: gateway command lines come from /proc/*/cmdline", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-proc-"));
    const procs: Array<[string, string[]]> = [
      ["10", ["/opt/Letta/letta", "letta.js", "channel-gateway", "--app-server-url", "ws://127.0.0.1:49985/ws"]],
      ["11", ["node", "vite"]],
    ];
    for (const [pid, argv] of procs) {
      mkdirSync(join(root, pid), { recursive: true });
      writeFileSync(join(root, pid, "cmdline"), argv.join("\0") + "\0");
    }
    mkdirSync(join(root, "self"));
    mkdirSync(join(root, "12")); // a process that exited, or one we may not read
    expect(parseGatewayUrls(procCommandLines(root).join("\n"))).toEqual(["ws://127.0.0.1:49985/ws"]);
    expect(procCommandLines(join(root, "missing"))).toEqual([]);
  });

  test("Windows: netstat -ano rows with no remote end are listeners, whatever language names the state", () => {
    const out = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1048",
      "  TCP    127.0.0.1:41414        0.0.0.0:0              LISTENING       7312",
      "  TCP    127.0.0.1:41414        127.0.0.1:50110        ESTABLISHED     7312",
      "  TCP    127.0.0.1:50110        127.0.0.1:41414        ESTABLISHED     900",
      "  TCP    127.0.0.1:49985        0.0.0.0:0              ABHÖREN         7312",
      "  TCP    [::1]:41415            [::]:0                 LISTENING       7312",
      "  UDP    0.0.0.0:5353           *:*                                    7312",
    ].join("\r\n");
    expect(parseNetstatPorts(out, 7312)).toEqual([41414, 49985, 41415]);
    expect(parseNetstatPorts(out, 1048)).toEqual([135]);
    expect(parseNetstatPorts(out, 1)).toEqual([]);
    expect(parseNetstatPorts("", 7312)).toEqual([]);
  });

  test("Windows: the gateway's command line, quoted, from a CIM query", () => {
    expect(POWERSHELL_GATEWAY_ARGS.join(" ")).toContain("Win32_Process");
    expect(POWERSHELL_GATEWAY_ARGS.join(" ")).not.toContain('"'); // nothing for Node's own Windows quoting to mangle
    const cim = String.raw`"C:\Users\someone\AppData\Local\Programs\Letta\Letta.exe" "C:\Users\someone\AppData\Local\Programs\Letta\resources\letta.js" channel-gateway --app-server-url "ws://127.0.0.1:53211/ws" --channels telegram` + "\r\n";
    expect(parseGatewayUrls(cim)).toEqual(["ws://127.0.0.1:53211/ws"]);
  });

});
