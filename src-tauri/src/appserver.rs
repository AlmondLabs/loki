//! The link to Letta's app-server.
//!
//! Browsers cannot put an `Authorization` header on a WebSocket handshake, which
//! is the one thing the app-server insists on when it runs with a capability
//! token. So the socket lives here: Rust connects (with the header when a token
//! is configured), forwards every text frame to the webview as an event, and
//! sends whatever the page hands it. Reconnects with backoff. One socket per app.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[derive(Clone, Debug, Serialize)]
pub struct LinkStatus {
    pub state: &'static str, // "connecting" | "open" | "closed"
    pub url: String,
}

pub struct Link {
    pub url: String,
    pub bearer: Option<String>,
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

pub type SharedLink = Arc<Link>;

impl Link {
    pub fn new(url: String, bearer: Option<String>) -> SharedLink {
        Arc::new(Link { url, bearer, tx: Mutex::new(None) })
    }

    /// Queue a frame for the server; false if not connected.
    pub async fn send(&self, text: String) -> bool {
        match self.tx.lock().await.as_ref() {
            Some(tx) => tx.send(text).is_ok(),
            None => false,
        }
    }

    /// Run forever: connect, pump, reconnect. Emits `app-server:status` and `app-server:event`.
    pub async fn run(self: SharedLink, app: AppHandle) {
        let mut backoff = Duration::from_millis(500);
        loop {
            let _ = app.emit("app-server:status", LinkStatus { state: "connecting", url: self.url.clone() });
            match self.connect_once(&app).await {
                Ok(()) => backoff = Duration::from_millis(500),
                Err(e) => eprintln!("loki: app-server link: {e}"),
            }
            *self.tx.lock().await = None;
            let _ = app.emit("app-server:status", LinkStatus { state: "closed", url: self.url.clone() });
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(8));
        }
    }

    async fn connect_once(&self, app: &AppHandle) -> Result<(), String> {
        let mut request = self.url.as_str().into_client_request().map_err(|e| e.to_string())?;
        if let Some(token) = &self.bearer {
            request.headers_mut().insert(
                http::header::AUTHORIZATION,
                http::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?,
            );
        }
        let (stream, _) = tokio_tungstenite::connect_async(request).await.map_err(|e| e.to_string())?;
        let (mut sink, mut source) = stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        *self.tx.lock().await = Some(tx);
        eprintln!("loki: app-server link open ({})", self.url);
        let _ = app.emit("app-server:status", LinkStatus { state: "open", url: self.url.clone() });

        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(text) => sink.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?,
                    None => return Ok(()),
                },
                inbound = source.next() => match inbound {
                    Some(Ok(Message::Text(text))) => { let _ = app.emit("app-server:event", text.to_string()); }
                    Some(Ok(Message::Ping(p))) => sink.send(Message::Pong(p)).await.map_err(|e| e.to_string())?,
                    Some(Ok(Message::Close(_))) | None => return Err("closed by server".into()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.to_string()),
                },
            }
        }
    }
}

/// Probe a loopback port: does an app-server answer `app_server_info` there? `bearer` for token-guarded servers.
pub async fn probe(url: &str) -> bool {
    probe_with(url, None).await
}

pub async fn probe_with(url: &str, bearer: Option<&str>) -> bool {
    let Ok(mut request) = url.into_client_request() else { return false };
    if let Some(token) = bearer {
        if let Ok(v) = http::HeaderValue::from_str(&format!("Bearer {token}")) {
            request.headers_mut().insert(http::header::AUTHORIZATION, v);
        }
    }
    let Ok(Ok((stream, _))) = tokio::time::timeout(Duration::from_millis(1500), tokio_tungstenite::connect_async(request)).await else { return false };
    let (mut sink, mut source) = stream.split();
    if sink.send(Message::Text(r#"{"type":"app_server_info","request_id":"probe"}"#.into())).await.is_err() { return false; }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, source.next()).await {
        if let Message::Text(t) = msg {
            if t.contains("\"request_id\":\"probe\"") && t.contains("app_server_info_response") { return true; }
        }
    }
    false
}

/// Ports the Letta Desktop harness listens on (macOS: `lsof` on the Letta process family).
#[cfg(target_os = "macos")]
pub fn desktop_ports() -> Vec<u16> {
    let out = std::process::Command::new("/usr/sbin/lsof").args(["-nP", "-a", "-c", "Letta", "-iTCP", "-sTCP:LISTEN", "-Fn"]).output();
    let Ok(out) = out else { return vec![] };
    let mut ports = vec![];
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(rest) = line.strip_prefix('n') {
            if let Some(p) = rest.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
                if !ports.contains(&p) { ports.push(p); }
            }
        }
    }
    ports
}

/// App-server addresses named on command lines in the process list: a `letta server --listen …` (loki's
/// own from an earlier run, or one the user started — a Node or Bun process, so `lsof -c Letta` never sees
/// it) and Letta's channel gateway, launched with `--app-server-url …`. `ps` is always at /bin/ps.
#[cfg(target_os = "macos")]
pub fn ps_app_server_urls() -> Vec<String> {
    let out = std::process::Command::new("/bin/ps").args(["-axo", "command"]).output();
    let Ok(out) = out else { return vec![] };
    parse_ps_urls(&String::from_utf8_lossy(&out.stdout))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the Mac's ps reader; its tests run everywhere
pub fn parse_ps_urls(ps: &str) -> Vec<String> {
    let mut urls = vec![];
    for line in ps.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        push_urls(&words, &mut urls);
    }
    urls
}

/// The URLs one command line names, added to `urls` once each: after `--listen` on a `server`, after `--app-server-url`.
fn push_urls(words: &[&str], urls: &mut Vec<String>) {
    for (i, w) in words.iter().enumerate() {
        let flag = (*w == "--listen" && words.iter().any(|x| *x == "server")) || *w == "--app-server-url";
        if !flag { continue; }
        if let Some(url) = words.get(i + 1).and_then(|a| ws_url(a)) {
            if !urls.contains(&url) { urls.push(url); }
        }
    }
}

/// `ws://host:port/ws` from what `--listen` accepts: a ws URL as is, `host:port`, `:port` or a bare port (loopback).
fn ws_url(addr: &str) -> Option<String> {
    if addr.starts_with("ws://") || addr.starts_with("wss://") { return Some(addr.to_string()); }
    let (host, port) = match addr.rsplit_once(':') {
        Some((h, p)) => (if h.is_empty() { "127.0.0.1" } else { h }, p),
        None => ("127.0.0.1", addr),
    };
    port.parse::<u16>().ok()?;
    Some(format!("ws://{host}:{port}/ws"))
}

fn port_of(url: &str) -> Option<u16> {
    url.split('/').nth(2)?.rsplit(':').next()?.parse().ok()
}

/// One process as sysinfo sees it: its pid, its name (`Letta.exe`, `node`), its arguments and when it started
/// (seconds since the epoch), so a pid found now is known to be the same process when it is stopped later.
#[derive(Clone, Debug, Default)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub cmd: Vec<String>,
    pub started: u64,
    /// The process that started it, when it is still known.
    pub parent: Option<u32>,
}

/// The machine at one moment: its processes, and every listening TCP port with its pid.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub procs: Vec<Proc>,
    pub listening: Vec<(u32, u16)>,
}

/// What to probe, in order, and loki's own harness from an earlier run when one holds its port.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Candidates {
    pub urls: Vec<String>,
    pub own: Option<Leftover>,
}

/// loki's own harness left from an earlier run (loki crashed or was force-quit): its pid and when it started.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Leftover {
    pub pid: u32,
    pub started: u64,
}

/// Which harness loki uses.
#[derive(Clone, Debug, PartialEq)]
pub enum Choice {
    /// Someone else's app-server (Desktop's, a `letta server` the user started): used, never stopped.
    Attach { url: String, bearer: Option<String> },
    /// loki's own harness left from an earlier run: stopped (stop_leftover), then a fresh one launched from the
    /// machine's current Letta Code with loki's current environment.
    Replace { pid: u32, started: u64 },
    /// Nothing answered: loki starts its own.
    Launch,
}

/// The arguments of a command line, however the process list gave it: already split (sysinfo), or one Windows
/// string with quoted paths. Quotes around an argument are dropped.
pub fn command_words(cmd: &[String]) -> Vec<String> {
    let words = match cmd {
        [one] if one.contains(char::is_whitespace) => split_windows(one),
        _ => cmd.to_vec(),
    };
    words.into_iter().map(|w| unquote(&w).to_string()).filter(|w| !w.is_empty()).collect()
}

fn unquote(w: &str) -> &str {
    w.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(w)
}

/// A Windows command line split the way programs read it (CommandLineToArgvW): whitespace outside quotes ends an
/// argument; 2n backslashes before a quote are n and the quote toggles, 2n+1 are n and a literal quote; other
/// backslashes are themselves — so a quoted `C:\Program Files\…` stays whole.
fn split_windows(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted, mut any) = (vec![], String::new(), false, false);
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let n = chars[i..].iter().take_while(|&&x| x == '\\').count();
            if chars.get(i + n) == Some(&'"') {
                cur.extend(std::iter::repeat_n('\\', n / 2));
                if n % 2 == 1 {
                    cur.push('"');
                    i += n + 1;
                } else {
                    i += n;
                }
            } else {
                cur.extend(std::iter::repeat_n('\\', n));
                i += n;
            }
            any = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            any = true;
        } else if c.is_whitespace() && !quoted {
            if any { out.push(std::mem::take(&mut cur)); }
            any = false;
        } else {
            cur.push(c);
            any = true;
        }
        i += 1;
    }
    if any { out.push(cur); }
    out
}

/// App-server addresses named on one command line: `letta server --listen …` or the gateway's `--app-server-url …`.
pub fn urls_in_command(words: &[String]) -> Vec<String> {
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let mut urls = vec![];
    push_urls(&words, &mut urls);
    urls
}

/// Letta Desktop by process name: `Letta`, `Letta.exe`, `Letta Helper`, a lowercase `letta` package on Linux.
pub fn is_letta_desktop(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("letta")
}

/// Whether a command line is loki's own start of the harness (harness::server_command): `server --listen <own_url>`
/// with loki's token file.
pub fn is_own_launch(words: &[String], own_url: &str, token_file: &std::path::Path) -> bool {
    let after = |flag: &str| words.iter().position(|w| w == flag).and_then(|i| words.get(i + 1));
    words.iter().any(|w| w == "server") && after("--listen").map(String::as_str) == Some(own_url) && after("--ws-token-file").is_some_and(|f| same_path(f, &token_file.to_string_lossy()))
}

/// Windows paths match whatever their slashes and case; other systems compare them as written.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        let norm = |p: &str| p.replace('/', "\\").to_lowercase();
        norm(a) == norm(b)
    } else {
        a == b
    }
}

/// Candidates from a snapshot: Desktop's listening ports first (as `lsof -c Letta` gives them on the Mac), then the
/// URLs on command lines; `own` is loki's own launch listening on `own_url`'s port. The Mac takes only `own` from it.
pub fn snapshot_candidates(snap: &Snapshot, own_url: &str, token_file: &std::path::Path) -> Candidates {
    let desktop: Vec<u32> = snap.procs.iter().filter(|p| is_letta_desktop(&p.name)).map(|p| p.pid).collect();
    let mut urls: Vec<String> = vec![];
    for (pid, port) in &snap.listening {
        let url = format!("ws://127.0.0.1:{port}/ws");
        if desktop.contains(pid) && !urls.contains(&url) { urls.push(url); }
    }
    let own_port = port_of(own_url);
    let mut own = None;
    for p in &snap.procs {
        let words = command_words(&p.cmd);
        for url in urls_in_command(&words) {
            if !urls.contains(&url) { urls.push(url); }
        }
        if own.is_none() && is_own_launch(&words, own_url, token_file) && !has_live_loki_parent(snap, p) && snap.listening.iter().any(|(pid, port)| *pid == p.pid && Some(*port) == own_port) {
            own = Some(Leftover { pid: p.pid, started: p.started });
        }
    }
    Candidates { urls, own }
}

/// Whether a loki that is still running started this process: then it is that loki's live harness (a dev build
/// beside the installed app, say), not a leftover, and must never be stopped. A leftover's loki is gone: its
/// parent is launchd, init or a subreaper, or on Windows a pid no process has any more.
fn has_live_loki_parent(snap: &Snapshot, p: &Proc) -> bool {
    let Some(parent) = p.parent else { return false };
    snap.procs.iter().any(|q| q.pid == parent && is_loki_shell(&q.name))
}

/// loki's own binary, as the process list names it: `loki` on the Mac and Linux, `loki.exe` on Windows.
fn is_loki_shell(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "loki" || n == "loki.exe"
}

/// The candidates on this machine. The Mac: `lsof -c Letta` and `/bin/ps`, as ever, for what to probe; loki's own
/// leftover from the same snapshot Windows and Linux use, which has what ps cannot give reliably — the arguments
/// already split (a token path with a space stays whole) and a start time `os::kill` can check.
#[cfg(target_os = "macos")]
pub fn candidates(own_url: &str, token_file: &std::path::Path) -> Candidates {
    let mut urls: Vec<String> = desktop_ports().into_iter().map(|p| format!("ws://127.0.0.1:{p}/ws")).collect();
    for u in ps_app_server_urls() {
        if !urls.contains(&u) { urls.push(u); }
    }
    Candidates { urls, own: snapshot_candidates(&os::snapshot(), own_url, token_file).own }
}

/// The candidates on this machine. Windows and Linux: a snapshot from sysinfo and listeners.
#[cfg(not(target_os = "macos"))]
pub fn candidates(own_url: &str, token_file: &std::path::Path) -> Candidates {
    snapshot_candidates(&os::snapshot(), own_url, token_file)
}

/// Probe the candidates in order, each without auth first and then with loki's token. `exclude` keeps the mod's
/// ports out. Reaching `own_url` with a leftover of loki's own on it replaces it, answering or not.
pub async fn choose(c: Candidates, own_url: &str, exclude: &[u16], token: Option<&str>) -> Choice {
    for url in c.urls {
        if port_of(&url).map(|p| exclude.contains(&p)).unwrap_or(true) { continue; }
        if let Some(Leftover { pid, started }) = c.own.filter(|_| url == own_url) {
            return Choice::Replace { pid, started };
        }
        let bearer = if probe(&url).await {
            None
        } else if token.is_some() && probe_with(&url, token).await {
            token.map(str::to_string)
        } else {
            continue;
        };
        return Choice::Attach { url, bearer };
    }
    Choice::Launch
}

/// What stopping a leftover did: whether it was killed, and whether its port is free for a fresh harness.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stopped {
    pub killed: bool,
    pub port_free: bool,
}

/// Stop loki's leftover harness `pid` — only while it is still the process that started at `started` — then wait up
/// to `wait` for `port` to stop listening.
pub fn stop_leftover(pid: u32, started: u64, port: u16, wait: Duration) -> Stopped {
    let killed = os::kill(pid, Some(started));
    Stopped { killed, port_free: wait_for(wait, || !listening(port)) }
}

/// Whether something accepts connections on the loopback `port` (a connection refused: nothing listens).
pub fn listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(250)).is_ok()
}

/// Poll `done` every 100 ms until it holds or `timeout` passes; true if it held.
pub fn wait_for(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if done() { return true; }
        if std::time::Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A running app-server loki may use, with the bearer it answered to: Desktop's (no auth), a `letta server`
/// or gateway from the process list (loki's token when it asks for one). `exclude` keeps the mod's ports out of
/// the probe. Replace: loki's own from an earlier run holds its port. Launch: nothing is running, so loki starts its own.
pub async fn find_app_server(exclude: &[u16], token: Option<&str>, token_file: &std::path::Path) -> Choice {
    let own_url = crate::harness::LISTEN_URL;
    choose(candidates(own_url, token_file), own_url, exclude, token).await
}

/// The process and port sources (sysinfo, listeners): everything Windows and Linux discover, and on the Mac only
/// loki's own leftover harness.
pub mod os {
    use super::{Proc, Snapshot};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};

    /// Every process with its command line, and every listening TCP port with its pid.
    pub fn snapshot() -> Snapshot {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always));
        let procs = sys
            .processes()
            .iter()
            .map(|(pid, p)| Proc { pid: pid.as_u32(), name: p.name().to_string_lossy().into_owned(), cmd: p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect(), started: p.start_time(), parent: None })
            .collect();
        let mut listening: Vec<(u32, u16)> = match listeners::get_all() {
            Ok(all) => all.into_iter().filter(|l| l.protocol == listeners::Protocol::TCP && l.state == listeners::SocketState::Listen).map(|l| (l.process.pid, l.socket.port())).collect(),
            Err(e) => {
                eprintln!("loki: listening ports: {e}");
                vec![]
            }
        };
        listening.sort_unstable();
        listening.dedup();
        Snapshot { procs, listening }
    }

    /// When `pid` started (seconds since the epoch), to know it is still the same process later. None once it
    /// has exited, a zombie included.
    pub fn start_time(pid: u32) -> Option<u64> {
        let mut sys = System::new();
        let pid = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
        sys.process(pid).filter(|p| !matches!(p.status(), ProcessStatus::Zombie | ProcessStatus::Dead)).map(|p| p.start_time())
    }

    /// Kill `pid` if it is still the process that started at `started`, and wait (up to 3 s) for it to go, so a
    /// harness started next finds its port free. False when it was already gone or is another process now.
    pub fn kill(pid: u32, started: Option<u64>) -> bool {
        let Some(at) = started else { return false };
        if start_time(pid) != Some(at) { return false; }
        let mut sys = System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
        if !sys.process(p).is_some_and(|proc| proc.kill()) { return false; }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while start_time(pid) == Some(at) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_app_server_addresses_off_the_process_list() {
        let ps = "\
COMMAND
/usr/bin/login -fp me
bun /opt/homebrew/lib/node_modules/@letta-ai/letta-code/letta.js server --listen ws://127.0.0.1:41600/ws --ws-auth capability-token --ws-token-file /Users/me/.letta/loki/token
node /x/letta.js channel-gateway --app-server-url ws://127.0.0.1:53211/ws --channels telegram
letta server --listen :4400
letta server --listen 0.0.0.0:4401
letta --listen nothing-without-server
grep --listen ws://evil
";
        assert_eq!(parse_ps_urls(ps), vec!["ws://127.0.0.1:41600/ws".to_string(), "ws://127.0.0.1:53211/ws".into(), "ws://127.0.0.1:4400/ws".into(), "ws://0.0.0.0:4401/ws".into()]);
        assert_eq!(parse_ps_urls(""), Vec::<String>::new());
        assert_eq!(port_of("ws://127.0.0.1:41600/ws"), Some(41600));
        assert_eq!(ws_url("41600"), Some("ws://127.0.0.1:41600/ws".into()));
        assert_eq!(ws_url("nope"), None);
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    fn token_file() -> std::path::PathBuf {
        std::path::PathBuf::from(if cfg!(windows) { r"C:\Users\someone\.letta\loki\token" } else { "/home/someone/.letta/loki/token" })
    }

    #[test]
    fn a_windows_command_line_names_its_listen_url() {
        // sysinfo hands the arguments over already split; quoted paths keep their spaces and backslashes.
        let split = s(&[r"C:\Program Files\nodejs\node.exe", r"C:\Users\someone\AppData\Roaming\npm\node_modules\@letta-ai\letta-code\letta.js", "server", "--listen", "ws://127.0.0.1:41999/ws"]);
        assert_eq!(urls_in_command(&command_words(&split)), vec!["ws://127.0.0.1:41999/ws".to_string()]);
        // …or as one string, the way Windows stores a command line.
        let one = s(&[r#""C:\Program Files\nodejs\node.exe" "C:\Users\some one\AppData\Roaming\npm\node_modules\@letta-ai\letta-code\letta.js" server --listen "ws://127.0.0.1:41999/ws" --ws-token-file "C:\Users\some one\.letta\loki\token""#]);
        let words = command_words(&one);
        assert_eq!(words[0], r"C:\Program Files\nodejs\node.exe");
        assert_eq!(words[1], r"C:\Users\some one\AppData\Roaming\npm\node_modules\@letta-ai\letta-code\letta.js");
        assert_eq!(words.last().unwrap(), r"C:\Users\some one\.letta\loki\token");
        assert_eq!(urls_in_command(&words), vec!["ws://127.0.0.1:41999/ws".to_string()]);
        // A quoted argument that is itself quoted by sysinfo loses its quotes too.
        assert_eq!(command_words(&s(&["node.exe", "\"ws://127.0.0.1:1/ws\""])), s(&["node.exe", "ws://127.0.0.1:1/ws"]));
        // The gateway, and the forms --listen accepts; nothing without `server`.
        assert_eq!(urls_in_command(&s(&[r"C:\Program Files\Letta\Letta.exe", "letta.js", "channel-gateway", "--app-server-url", "ws://127.0.0.1:53211/ws"])), vec!["ws://127.0.0.1:53211/ws".to_string()]);
        assert_eq!(urls_in_command(&s(&["letta", "server", "--listen", ":4400"])), vec!["ws://127.0.0.1:4400/ws".to_string()]);
        assert_eq!(urls_in_command(&s(&["letta", "--listen", "ws://127.0.0.1:9/ws"])), Vec::<String>::new());
        assert_eq!(urls_in_command(&s(&["letta", "server", "--listen"])), Vec::<String>::new(), "a flag with no value");
        assert_eq!(command_words(&[]), Vec::<String>::new());
        assert_eq!(command_words(&s(&[""])), Vec::<String>::new());
    }

    #[test]
    fn letta_desktop_is_found_by_its_process_name() {
        for yes in ["Letta", "Letta.exe", "LETTA.EXE", "Letta Helper", "letta", "letta-desktop"] { assert!(is_letta_desktop(yes), "{yes}"); }
        for no in ["node", "node.exe", "bun", "Slack.exe", "", "Palette"] { assert!(!is_letta_desktop(no), "{no}"); }
    }

    #[test]
    fn loki_s_own_launch_is_recognised_by_its_address_and_token_file() {
        let tf = token_file();
        let own = |url: &str, file: &str| s(&["node", "letta.js", "server", "--listen", url, "--ws-auth", "capability-token", "--ws-token-file", file]);
        let tfs = tf.to_string_lossy().into_owned();
        assert!(is_own_launch(&own(crate::harness::LISTEN_URL, &tfs), crate::harness::LISTEN_URL, &tf));
        assert!(!is_own_launch(&own("ws://127.0.0.1:4400/ws", &tfs), crate::harness::LISTEN_URL, &tf), "another address");
        assert!(!is_own_launch(&own(crate::harness::LISTEN_URL, "/elsewhere/token"), crate::harness::LISTEN_URL, &tf), "someone else's token file");
        assert!(!is_own_launch(&s(&["letta", "server", "--listen", crate::harness::LISTEN_URL]), crate::harness::LISTEN_URL, &tf), "no token file at all");
        assert!(!is_own_launch(&s(&["grep", "--listen", crate::harness::LISTEN_URL, "--ws-token-file", &tfs]), crate::harness::LISTEN_URL, &tf), "not a server");
        // Windows spells paths either way and ignores case.
        let win = std::path::Path::new(r"C:\Users\Someone\.letta\loki\token");
        assert!(is_own_launch(&own(crate::harness::LISTEN_URL, "c:/users/someone/.letta/loki/token"), crate::harness::LISTEN_URL, win) == cfg!(windows));
    }

    #[test]
    fn a_snapshot_gives_desktop_ports_then_command_line_urls_and_loki_s_leftover() {
        let tf = token_file();
        let tfs = tf.to_string_lossy().into_owned();
        let own_url = "ws://127.0.0.1:41600/ws";
        let snap = Snapshot {
            procs: vec![
                Proc { pid: 10, name: "Letta.exe".into(), cmd: s(&[r"C:\Program Files\Letta\Letta.exe"]), started: 1, parent: None },
                Proc { pid: 11, name: "Letta.exe".into(), cmd: s(&[r"C:\Program Files\Letta\Letta.exe", "letta.js", "channel-gateway", "--app-server-url", "ws://127.0.0.1:53211/ws"]), started: 1, parent: None },
                Proc { pid: 20, name: "node.exe".into(), cmd: own_launch(own_url, &tfs), started: 2, parent: None },
                Proc { pid: 30, name: "node".into(), cmd: s(&["node", "vite"]), started: 3, parent: None },
            ],
            listening: vec![(30, 5173), (10, 49985), (10, 49985), (10, 49986), (20, 41600)],
        };
        let c = snapshot_candidates(&snap, own_url, &tf);
        assert_eq!(c.urls, s(&["ws://127.0.0.1:49985/ws", "ws://127.0.0.1:49986/ws", "ws://127.0.0.1:53211/ws", own_url]));
        assert_eq!(c.own, Some(Leftover { pid: 20, started: 2 }));
        // loki's launch that no longer holds the port is no leftover to replace; its URL is still a candidate.
        let gone = Snapshot { listening: vec![], ..snap.clone() };
        assert_eq!(snapshot_candidates(&gone, own_url, &tf), Candidates { urls: s(&["ws://127.0.0.1:53211/ws", own_url]), own: None });
        assert_eq!(snapshot_candidates(&Snapshot::default(), own_url, &tf), Candidates::default());
    }

    /// A stand-in app-server on a free loopback port: answers `app_server_info` (with the bearer when `require` is set).
    async fn fake_app_server(require: Option<&'static str>) -> String {
        use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = l.accept().await {
                tokio::spawn(async move {
                    let check = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
                        let ok = match require {
                            None => true,
                            Some(t) => req.headers().get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {t}")),
                        };
                        if ok { Ok(res) } else { Err(http::Response::builder().status(401).body(None).unwrap()) }
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else { return };
                    while let Some(Ok(Message::Text(t))) = ws.next().await {
                        if t.contains("\"app_server_info\"") {
                            let _ = ws.send(Message::Text(r#"{"type":"app_server_info_response","request_id":"probe","protocol_version":1}"#.into())).await;
                        }
                    }
                });
            }
        });
        format!("ws://127.0.0.1:{port}/ws")
    }

    /// A loopback port nothing listens on.
    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn letta_desktop_on_a_port_that_answers_is_attached_to() {
        let url = fake_app_server(None).await;
        let port = port_of(&url).unwrap();
        let dead = closed_port();
        let snap = Snapshot { procs: vec![Proc { pid: 42, name: "Letta.exe".into(), cmd: vec![], started: 1, parent: None }], listening: vec![(42, dead), (42, port)] };
        let own_url = format!("ws://127.0.0.1:{}/ws", closed_port());
        let c = snapshot_candidates(&snap, &own_url, &token_file());
        assert_eq!(choose(c, &own_url, &[41414, 41415], Some("tok")).await, Choice::Attach { url, bearer: None });
    }

    #[tokio::test]
    async fn nothing_running_means_loki_starts_its_own() {
        let own_url = format!("ws://127.0.0.1:{}/ws", closed_port());
        let c = snapshot_candidates(&Snapshot::default(), &own_url, &token_file());
        assert_eq!(choose(c, &own_url, &[], Some("tok")).await, Choice::Launch);
        // A candidate that does not answer is no harness either.
        let dead = Candidates { urls: vec![format!("ws://127.0.0.1:{}/ws", closed_port())], own: None };
        assert_eq!(choose(dead, &own_url, &[], None).await, Choice::Launch);
    }

    #[tokio::test]
    async fn the_mod_s_ports_are_never_probed() {
        let url = fake_app_server(None).await;
        let port = port_of(&url).unwrap();
        let c = Candidates { urls: vec![url.clone()], own: None };
        assert_eq!(choose(c, "ws://127.0.0.1:1/ws", &[port], None).await, Choice::Launch);
    }

    fn own_launch(url: &str, token_file: &str) -> Vec<String> {
        s(&["node.exe", "letta.js", "server", "--listen", url, "--ws-auth", "capability-token", "--ws-token-file", token_file])
    }

    #[tokio::test]
    async fn loki_s_leftover_harness_is_replaced_not_attached() {
        let own_url = fake_app_server(Some("tok")).await;
        let port = port_of(&own_url).unwrap();
        let tf = token_file();
        let tfs = tf.to_string_lossy().into_owned();
        let snap = Snapshot { procs: vec![Proc { pid: 77, name: "node.exe".into(), cmd: own_launch(&own_url, &tfs), started: 1234, parent: None }], listening: vec![(77, port)] };
        let c = snapshot_candidates(&snap, &own_url, &tf);
        assert_eq!(c.own, Some(Leftover { pid: 77, started: 1234 }));
        assert_eq!(choose(c.clone(), &own_url, &[41414, 41415], Some("tok")).await, Choice::Replace { pid: 77, started: 1234 });
        // Replaced whether or not it answers: a leftover that hangs, or one on an old token, is restarted all the same.
        assert_eq!(choose(c, &own_url, &[], None).await, Choice::Replace { pid: 77, started: 1234 });
        // The same server without a recognised owner is attached to, never stopped.
        let c = Candidates { urls: vec![own_url.clone()], own: None };
        assert_eq!(choose(c, &own_url, &[], Some("tok")).await, Choice::Attach { url: own_url.clone(), bearer: Some("tok".into()) });
        // Desktop found first still wins, as ever: loki starts nothing, so it restarts nothing.
        let desktop = fake_app_server(None).await;
        let c = Candidates { urls: vec![desktop.clone(), own_url.clone()], own: Some(Leftover { pid: 77, started: 1234 }) };
        assert_eq!(choose(c, &own_url, &[], Some("tok")).await, Choice::Attach { url: desktop, bearer: None });
    }

    #[tokio::test]
    async fn a_harness_whose_loki_is_still_running_is_that_loki_s_and_never_replaced() {
        let own_url = fake_app_server(Some("tok")).await;
        let port = port_of(&own_url).unwrap();
        let tf = token_file();
        let tfs = tf.to_string_lossy().into_owned();
        let harness = |parent| Proc { pid: 77, name: "node".into(), cmd: own_launch(&own_url, &tfs), started: 1234, parent };
        // A second loki (a dev build beside the installed app): the first one's live harness is attached to.
        for shell in ["loki", "loki.exe", "LOKI.EXE"] {
            let snap = Snapshot { procs: vec![harness(Some(5)), Proc { pid: 5, name: shell.into(), cmd: vec![], started: 1, parent: Some(1) }], listening: vec![(77, port)] };
            let c = snapshot_candidates(&snap, &own_url, &tf);
            assert_eq!(c.own, None, "{shell}");
            assert_eq!(choose(c, &own_url, &[], Some("tok")).await, Choice::Attach { url: own_url.clone(), bearer: Some("tok".into()) });
        }
        // Its loki gone: reparented to launchd or init, a subreaper, or (Windows) a pid no process has.
        for (parent, procs) in [(Some(1), vec![Proc { pid: 1, name: "launchd".into(), cmd: vec![], started: 0, parent: None }]), (Some(900), vec![Proc { pid: 900, name: "systemd".into(), cmd: vec![], started: 0, parent: Some(1) }]), (Some(4321), vec![]), (None, vec![])] {
            let mut all = vec![harness(parent)];
            all.extend(procs);
            let snap = Snapshot { procs: all, listening: vec![(77, port)] };
            assert_eq!(snapshot_candidates(&snap, &own_url, &tf).own, Some(Leftover { pid: 77, started: 1234 }), "{parent:?}");
        }
    }

    #[tokio::test]
    async fn a_server_on_loki_s_port_that_is_not_loki_s_launch_is_attached_to_and_never_stopped() {
        let own_url = fake_app_server(Some("tok")).await;
        let port = port_of(&own_url).unwrap();
        let tf = token_file();
        for cmd in [own_launch(&own_url, "/elsewhere/token"), s(&["letta", "server", "--listen", &own_url])] {
            let snap = Snapshot { procs: vec![Proc { pid: 78, name: "node".into(), cmd, started: 1, parent: None }], listening: vec![(78, port)] };
            let c = snapshot_candidates(&snap, &own_url, &tf);
            assert_eq!(c.own, None);
            assert_eq!(choose(c.clone(), &own_url, &[], Some("tok")).await, Choice::Attach { url: own_url.clone(), bearer: Some("tok".into()) });
            // One that does not answer is not killed either: loki launches, and a port still held fails as it did before.
            assert_eq!(choose(c, &own_url, &[], None).await, Choice::Launch);
        }
    }

    fn sleeper() -> std::process::Child {
        if cfg!(windows) {
            std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap()
        } else {
            std::process::Command::new("sleep").arg("30").spawn().unwrap()
        }
    }

    #[test]
    fn a_leftover_is_stopped_only_while_it_is_the_process_that_was_found() {
        let mut child = sleeper();
        let pid = child.id();
        let started = os::start_time(pid).unwrap();
        let free = closed_port();
        assert_eq!(stop_leftover(pid, started + 1000, free, Duration::from_millis(300)), Stopped { killed: false, port_free: true }, "another start time: another process, left alone");
        assert!(child.try_wait().unwrap().is_none());
        assert_eq!(stop_leftover(pid, started, free, Duration::from_millis(300)), Stopped { killed: true, port_free: true });
        assert!(!child.wait().unwrap().success());
        // The port still held after the wait: said so, for the caller to attach instead.
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert_eq!(stop_leftover(pid, started, port, Duration::from_millis(300)), Stopped { killed: false, port_free: false });
    }

    #[test]
    fn waiting_for_the_port_ends_when_it_frees_or_at_the_deadline() {
        let mut polls = 0;
        assert!(wait_for(Duration::from_secs(5), || { polls += 1; polls >= 3 }));
        assert_eq!(polls, 3);
        let t = std::time::Instant::now();
        assert!(!wait_for(Duration::from_millis(300), || false));
        assert!(t.elapsed() >= Duration::from_millis(300) && t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(listening(port));
        drop(held);
        assert!(!listening(port));
    }

    /// The real OS, before anything is wired to it: the reader lists a port this test listens on, with this test's
    /// pid, and not one that was closed. On the Mac this runs the Windows/Linux reader through the same crates.
    #[test]
    fn the_os_reader_lists_a_port_this_process_listens_on() {
        let me = std::process::id();
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = open.local_addr().unwrap().port();
        let closed = closed_port();
        let snap = os::snapshot();
        assert!(snap.listening.contains(&(me, port)), "port {port} for pid {me}: {:?}", snap.listening.iter().filter(|(p, _)| *p == me).collect::<Vec<_>>());
        assert!(!snap.listening.iter().any(|(_, p)| *p == closed), "closed port {closed} listed");
        let mine = snap.procs.iter().find(|p| p.pid == me).expect("this process in the list");
        assert!(!mine.cmd.is_empty(), "its command line: {mine:?}");
        drop(open);
        assert!(!os::snapshot().listening.contains(&(me, port)), "after closing, {port} is gone");
        assert!(os::start_time(me).is_some());
        assert_eq!(os::start_time(u32::MAX), None);
    }

    #[test]
    fn kill_stops_the_process_it_was_given_and_only_that_one() {
        let mut child = sleeper();
        let pid = child.id();
        let started = os::start_time(pid);
        assert!(started.is_some());
        assert!(!os::kill(pid, started.map(|t| t + 1000)), "a different start time is a different process: left alone");
        assert!(child.try_wait().unwrap().is_none());
        assert!(os::kill(pid, started));
        assert!(child.wait().is_ok());
        assert!(!os::kill(pid, started), "already gone");
    }
}
