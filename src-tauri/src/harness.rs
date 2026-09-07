//! Our own harness, when Desktop is not running one: `letta server --listen …`
//! with a fixed address and the loki token as the capability token. Killed when
//! the app quits (never two harnesses on one backend).

use crate::bootstrap::Runtime;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub const LISTEN_URL: &str = "ws://127.0.0.1:41600/ws";

/// The child, once started. Managed from launch so a harness can start later (after an install).
#[derive(Default)]
pub struct Harness(pub Mutex<Option<Child>>);

/// PATH for anything that runs `letta`: the shim is `#!/usr/bin/env node`, and GUI apps get a short PATH.
fn path_with(node_bin_dir: Option<&Path>) -> String {
    let base = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
    match node_bin_dir {
        Some(d) => format!("{}:{base}", d.display()),
        None => base,
    }
}

/// A machine that never ran `letta` has no backend chosen, and `letta server` would stop to ask.
/// `letta backend local` is non-interactive and writes `preferredBackendMode` to ~/.letta/settings.json;
/// a user who chose cloud keeps it.
pub fn ensure_backend_mode(rt: &Runtime, home: &Path) {
    let settings = home.join(".letta").join("settings.json");
    let chosen = std::fs::read_to_string(&settings).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).map(|v| v.get("preferredBackendMode").and_then(|m| m.as_str()).is_some()).unwrap_or(false);
    if chosen { return; }
    eprintln!("loki: no backend mode chosen yet — running `letta backend local`");
    match Command::new(&rt.letta).args(["backend", "local"]).env("PATH", path_with(rt.node_bin_dir.as_deref())).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() => {}
        Ok(s) => eprintln!("loki: `letta backend local` exited with {s}"),
        Err(e) => eprintln!("loki: could not run `letta backend local`: {e}"),
    }
}

impl Harness {
    /// Start `letta server` with `rt`; replaces a child started earlier.
    pub fn start(&self, rt: &Runtime, token_file: &Path, log_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(log_dir).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(log_dir.join("harness.log")).map_err(|e| e.to_string())?;
        let child = Command::new(&rt.letta)
            .args(["server", "--listen", LISTEN_URL, "--ws-auth", "capability-token", "--ws-token-file"])
            .arg(token_file)
            .env("PATH", path_with(rt.node_bin_dir.as_deref()))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|e| format!("could not start letta server: {e}"))?;
        self.stop();
        if let Ok(mut g) = self.0.lock() { *g = Some(child); }
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.0.lock().ok().and_then(|mut g| g.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Whatever ends the app — window closed, quit, or a signal unwinding main — the harness goes with it.
impl Drop for Harness {
    fn drop(&mut self) {
        self.stop();
    }
}
