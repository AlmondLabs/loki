//! Our own harness, when Desktop is not running one: `letta server --listen …`
//! with a fixed address and the loki token as the capability token. Killed when
//! the app quits (never two harnesses on one backend).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub const LISTEN_URL: &str = "ws://127.0.0.1:41600/ws";

pub struct Harness(pub Mutex<Option<Child>>);

fn letta_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("LOKI_LETTA_BIN") { return Some(PathBuf::from(p)); }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let candidates = [home.join(".volta/bin/letta"), PathBuf::from("/opt/homebrew/bin/letta"), PathBuf::from("/usr/local/bin/letta")];
    candidates.into_iter().find(|p| p.exists())
}

impl Harness {
    pub fn spawn(token_file: &std::path::Path, log_dir: &std::path::Path) -> Result<Harness, String> {
        let bin = letta_binary().ok_or("letta CLI not found (looked in ~/.volta/bin, /opt/homebrew/bin, /usr/local/bin; set LOKI_LETTA_BIN)")?;
        std::fs::create_dir_all(log_dir).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(log_dir.join("harness.log")).map_err(|e| e.to_string())?;
        let child = Command::new(bin)
            .args(["server", "--listen", LISTEN_URL, "--ws-auth", "capability-token", "--ws-token-file"])
            .arg(token_file)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|e| format!("could not start letta server: {e}"))?;
        Ok(Harness(Mutex::new(Some(child))))
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
