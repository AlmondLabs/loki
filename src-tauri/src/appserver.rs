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

/// Desktop's app-server if one is running (no auth), else None.
pub async fn find_desktop_app_server(exclude: &[u16]) -> Option<String> {
    for port in desktop_ports() {
        if exclude.contains(&port) { continue; }
        let url = format!("ws://127.0.0.1:{port}/ws");
        if probe(&url).await { return Some(url); }
    }
    None
}
