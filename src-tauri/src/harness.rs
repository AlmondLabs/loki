//! The harness loki launches when no app-server is running: `letta server --listen …` from the machine's
//! Letta Code (bootstrap.rs), with a fixed address and the loki token as the capability token. Killed when
//! the app quits. Its environment is loki's: the self-updater off (nothing changes under a running session;
//! the user's own terminal sessions keep the global install fresh) and a scratch folder under ~/.letta
//! (scratch.rs). It loads the mod from Letta's shared ~/.letta/mods like every harness; the mod itself serves
//! the desk only inside a harness that hosts an app-server (mod/gate.ts), so a terminal `letta` never takes
//! the mod's port.

use crate::bootstrap::{self, Runtime};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub const LISTEN_URL: &str = "ws://127.0.0.1:41600/ws";

/// The child, once started. Managed from launch so a harness can start later (after an install).
#[derive(Default)]
pub struct Harness(pub Mutex<Option<Child>>);

/// A machine that never ran `letta` has no backend chosen, and `letta server` would stop to ask.
/// `letta backend local` is non-interactive and writes `preferredBackendMode` to ~/.letta/settings.json;
/// a user who chose cloud keeps it.
pub fn ensure_backend_mode(rt: &Runtime, home: &Path) {
    let settings = home.join(".letta").join("settings.json");
    let chosen = std::fs::read_to_string(&settings).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).map(|v| v.get("preferredBackendMode").and_then(|m| m.as_str()).is_some()).unwrap_or(false);
    if chosen { return; }
    eprintln!("loki: no backend mode chosen yet — running `letta backend local`");
    match Command::new(&rt.letta).args(["backend", "local"]).env("PATH", bootstrap::path_for(rt)).env("DISABLE_AUTOUPDATER", "1").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() => {}
        Ok(s) => eprintln!("loki: `letta backend local` exited with {s}"),
        Err(e) => eprintln!("loki: could not run `letta backend local`: {e}"),
    }
}

/// Everything a start needs besides the runtime: where the token, the logs, the scratch folder and the mods folder are.
pub struct Launch<'a> {
    pub token_file: &'a Path,
    pub log_dir: &'a Path,
    /// The folder Letta's Bash tool keeps background output in (scratch.rs): emptied at start, handed over as LETTA_SCRATCHPAD.
    pub scratch: &'a Path,
}

impl Harness {
    /// Start `letta server` with `rt`; replaces a child started earlier.
    pub fn start(&self, rt: &Runtime, launch: &Launch) -> Result<(), String> {
        std::fs::create_dir_all(launch.log_dir).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(launch.log_dir.join("harness.log")).map_err(|e| e.to_string())?;
        // A scratch folder that cannot be made is not worth refusing the harness for: Letta falls back to its
        // temp folder, and Settings › letta shows the error next to the path.
        if let Err(e) = crate::scratch::prepare(launch.scratch) { eprintln!("loki: scratch folder: {e}"); }
        let child = Command::new(&rt.letta)
            .args(["server", "--listen", LISTEN_URL, "--ws-auth", "capability-token", "--ws-token-file"])
            .arg(launch.token_file)
            .env("PATH", bootstrap::path_for(rt))
            // Letta Code checks npm at startup and replaces itself in the background; under loki that is
            // never wanted — the harness would change under a session.
            .env("DISABLE_AUTOUPDATER", "1")
            // Letta's memory subagents (dreaming) run sandboxed and may only write under ~/.letta; their Bash
            // tool needs its scratch folder there, or every pass fails before its first command.
            .env("LETTA_SCRATCHPAD", launch.scratch)
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
