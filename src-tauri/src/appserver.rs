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
pub fn ps_app_server_urls() -> Vec<String> {
    let out = std::process::Command::new("/bin/ps").args(["-axo", "command"]).output();
    let Ok(out) = out else { return vec![] };
    parse_ps_urls(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_ps_urls(ps: &str) -> Vec<String> {
    let mut urls = vec![];
    for line in ps.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        for (i, w) in words.iter().enumerate() {
            let flag = (*w == "--listen" && words.iter().any(|x| *x == "server")) || *w == "--app-server-url";
            if !flag { continue; }
            if let Some(url) = words.get(i + 1).and_then(|a| ws_url(a)) {
                if !urls.contains(&url) { urls.push(url); }
            }
        }
    }
    urls
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

/// A running app-server loki may use, with the bearer it answered to: Desktop's (no auth), a `letta server`
/// or gateway from the process list, loki's own from an earlier run (the token). `exclude` keeps the mod's
/// ports out of the probe. None: nothing is running, so loki launches its own.
pub async fn find_app_server(exclude: &[u16], token: Option<&str>) -> Option<(String, Option<String>)> {
    let mut candidates: Vec<String> = desktop_ports().into_iter().map(|p| format!("ws://127.0.0.1:{p}/ws")).collect();
    for u in ps_app_server_urls() {
        if !candidates.contains(&u) { candidates.push(u); }
    }
    for url in candidates {
        if port_of(&url).map(|p| exclude.contains(&p)).unwrap_or(true) { continue; }
        if probe(&url).await { return Some((url, None)); }
        if token.is_some() && probe_with(&url, token).await { return Some((url, token.map(str::to_string))); }
    }
    None
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
}
