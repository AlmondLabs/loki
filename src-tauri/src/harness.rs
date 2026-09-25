//! The harness loki launches when no app-server is running: `letta server --listen …` from the machine's
//! Letta Code (bootstrap.rs), with a fixed address and the loki token as the capability token. Killed when
//! the app quits. Its environment is loki's: the self-updater off (nothing changes under a running session;
//! the user's own terminal sessions keep the global install fresh) and a scratch folder under ~/.letta
//! (scratch.rs). It loads the mod from Letta's shared ~/.letta/mods like every harness; the mod itself serves
//! the desk only inside a harness that hosts an app-server (mod/gate.ts), so a terminal `letta` never takes
//! the mod's port. It is told its own address in `LOKI_OWN_APP_SERVER_URL`, so the mod needs no lookup for it.
//!
//! On Windows the harness is `node …\letta-code\letta.js` rather than npm's `letta.cmd` (bootstrap::launch_of),
//! with no console window, inside a Job Object that kills the whole tree when loki's handle closes — quitting,
//! or loki dying, never leaves a node holding the harness port. On Linux the harness is started with
//! PR_SET_PDEATHSIG, so the kernel kills it when loki dies (`die_with_loki`). A harness left from an earlier run
//! anyway (the Mac, or a Linux crash before that took hold) is stopped at the next launch and started afresh
//! (appserver::Choice::Replace), so it always runs the machine's current Letta Code and loki's current environment.

use crate::bootstrap::{self, Os, Runtime};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub const LISTEN_URL: &str = "ws://127.0.0.1:41600/ws";
/// LISTEN_URL's port, for the wait for a leftover to let go of it.
pub const LISTEN_PORT: u16 = 41600;

/// The child, once started. Managed from launch so a harness can start later (after an install).
#[derive(Default)]
pub struct Harness(pub Mutex<Option<Running>>);

/// The harness loki started: the child, and on Windows the Job Object that owns its process tree.
pub struct Running {
    child: Child,
    #[cfg(windows)]
    _job: Option<job::Job>,
}

/// A machine that never ran `letta` has no backend chosen, and `letta server` would stop to ask.
/// `letta backend local` is non-interactive and writes `preferredBackendMode` to ~/.letta/settings.json;
/// a user who chose cloud keeps it.
pub fn ensure_backend_mode(rt: &Runtime, home: &Path) {
    let settings = home.join(".letta").join("settings.json");
    let chosen = std::fs::read_to_string(&settings).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).map(|v| v.get("preferredBackendMode").and_then(|m| m.as_str()).is_some()).unwrap_or(false);
    if chosen { return; }
    eprintln!("loki: no backend mode chosen yet — running `letta backend local`");
    match bootstrap::letta_command(rt).args(["backend", "local"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
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

/// `letta server` on `rt` as `os` starts it: the address, the token file and loki's environment.
pub fn server_command(os: Os, rt: &Runtime, launch: &Launch) -> Command {
    let mut cmd = bootstrap::letta_command_for(os, rt);
    cmd.args(["server", "--listen", LISTEN_URL, "--ws-auth", "capability-token", "--ws-token-file"])
        .arg(launch.token_file)
        // Letta Code checks npm at startup and replaces itself in the background; under loki that is
        // never wanted — the harness would change under a session. (letta_command sets DISABLE_AUTOUPDATER.)
        // Letta's memory subagents (dreaming) run sandboxed and may only write under ~/.letta; their Bash
        // tool needs its scratch folder there, or every pass fails before its first command.
        .env("LETTA_SCRATCHPAD", launch.scratch)
        // The mod inside learns the harness's own address from this rather than looking it up, and removes it
        // (mod/index.ts): a name of its own, not LOKI_APP_SERVER_URL, which a shell or `letta` an agent starts
        // would otherwise inherit and take as "attach here" — without loki's token.
        .env("LOKI_OWN_APP_SERVER_URL", LISTEN_URL);
    cmd
}

impl Harness {
    /// Start `letta server` with `rt`; replaces a child started earlier.
    pub fn start(&self, rt: &Runtime, launch: &Launch) -> Result<(), String> {
        std::fs::create_dir_all(launch.log_dir).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(launch.log_dir.join("harness.log")).map_err(|e| e.to_string())?;
        // A scratch folder that cannot be made is not worth refusing the harness for: Letta falls back to its
        // temp folder, and Settings › letta shows the error next to the path.
        if let Err(e) = crate::scratch::prepare(launch.scratch) { eprintln!("loki: scratch folder: {e}"); }
        // Resolved now, from what is on disk now: never a path remembered from an earlier start.
        let mut cmd = server_command(Os::HOST, rt, launch);
        cmd.stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log));
        #[cfg(target_os = "linux")]
        let child = death::spawn(cmd);
        #[cfg(not(target_os = "linux"))]
        let child = cmd.spawn();
        let child = child.map_err(|e| format!("could not start letta server: {e}"))?;
        #[cfg(windows)]
        let running = {
            let job = job::Job::kill_on_close().and_then(|j| j.assign(&child).map(|_| j));
            if let Err(e) = &job { eprintln!("loki: harness job object: {e}"); }
            Running { child, _job: job.ok() }
        };
        #[cfg(not(windows))]
        let running = Running { child };
        self.stop();
        if let Ok(mut g) = self.0.lock() { *g = Some(running); }
        Ok(())
    }

    /// Kill the harness and wait for it; on Windows closing the job then takes the rest of its tree.
    pub fn stop(&self) {
        if let Some(Running { mut child, .. }) = self.0.lock().ok().and_then(|mut g| g.take()) {
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

/// Linux: the harness dies with loki. PR_SET_PDEATHSIG fires when the *thread* that forked the child exits, not the
/// process — and a start can come from a short-lived thread (an install or update runs on tokio's blocking pool,
/// whose idle threads exit), which would kill a healthy harness. So every start is forked from one thread that
/// lives as long as loki. SIGKILL, like `stop`: nothing of the harness outlives loki to hold 41600.
#[cfg(target_os = "linux")]
mod death {
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};
    use std::sync::{mpsc, Mutex, OnceLock};

    type Request = (Command, mpsc::Sender<io::Result<Child>>);

    /// Ask the kernel to kill the child when its parent goes; if loki is already gone by then, fail the start.
    fn die_with_loki(cmd: &mut Command) {
        let parent = std::process::id() as libc::pid_t;
        // Safety: between fork and exec only async-signal-safe calls — prctl, getppid — and no allocation.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) == -1 { return Err(io::Error::last_os_error()); }
                // loki already gone: no start (a raw errno, as nothing may allocate here).
                if libc::getppid() != parent { return Err(io::Error::from_raw_os_error(libc::ESRCH)); }
                Ok(())
            });
        }
    }

    /// Spawn `cmd`, set to die with loki, from the one long-lived spawner thread.
    pub fn spawn(mut cmd: Command) -> io::Result<Child> {
        static SPAWNER: OnceLock<Mutex<mpsc::Sender<Request>>> = OnceLock::new();
        die_with_loki(&mut cmd);
        let tx = SPAWNER.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Request>();
            std::thread::Builder::new()
                .name("loki-harness-spawner".into())
                .spawn(move || {
                    for (mut cmd, reply) in rx { let _ = reply.send(cmd.spawn()); }
                })
                .expect("the harness spawner thread");
            Mutex::new(tx)
        });
        let (reply, answer) = mpsc::channel();
        tx.lock().map_err(|_| io::Error::other("harness spawner poisoned"))?.send((cmd, reply)).map_err(|_| io::Error::other("harness spawner gone"))?;
        answer.recv().map_err(|_| io::Error::other("harness spawner gone"))?
    }
}

/// A Windows Job Object set to kill every process in it when its last handle closes: loki's handle closes when
/// the harness is stopped or replaced, and when loki itself exits for any reason.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};

    pub struct Job(HANDLE);
    // The handle is an owned kernel object, usable from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn kill_on_close() -> Result<Job, String> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() { return Err(format!("CreateJobObjectW: {}", std::io::Error::last_os_error())); }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const core::ffi::c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
                if ok == 0 { return Err(format!("SetInformationJobObject: {}", std::io::Error::last_os_error())); }
                Ok(job)
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 { Err(format!("AssignProcessToJobObject: {}", std::io::Error::last_os_error())) } else { Ok(()) }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bootstrap::Os;
    use std::path::PathBuf;

    fn envs(cmd: &Command) -> Vec<(String, String)> {
        cmd.get_envs().filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned()))).collect()
    }
    fn launch<'a>(dir: &'a Path) -> Launch<'a> {
        Launch { token_file: dir, log_dir: dir, scratch: dir }
    }

    #[test]
    fn the_start_command_tells_the_harness_its_own_url_on_every_os() {
        let dir = PathBuf::from("/data/token");
        let rt = Runtime { letta: PathBuf::from("/usr/local/bin/letta"), node_bin_dir: Some(PathBuf::from("/usr/local/bin")), explicit: false };
        for os in [Os::Macos, Os::Linux, Os::Windows] {
            let cmd = server_command(os, &rt, &launch(&dir));
            let env = envs(&cmd);
            assert!(env.contains(&("LOKI_OWN_APP_SERVER_URL".into(), "ws://127.0.0.1:41600/ws".into())), "{os:?}: {env:?}");
            assert!(env.contains(&("DISABLE_AUTOUPDATER".into(), "1".into())));
            assert!(env.contains(&("LETTA_SCRATCHPAD".into(), dir.to_string_lossy().into_owned())));
            let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(args, ["server", "--listen", LISTEN_URL, "--ws-auth", "capability-token", "--ws-token-file", "/data/token"]);
            assert_eq!(cmd.get_program(), rt.letta.as_os_str(), "{os:?}: no letta.js beside it, so the shim itself");
        }
        assert_eq!(LISTEN_URL, format!("ws://127.0.0.1:{LISTEN_PORT}/ws"));
    }

    /// Linux: a start through the parent-death setup succeeds, and the harness outlives the thread that asked for it
    /// (the spawner thread forked it), then stops like any other.
    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_the_harness_dies_with_loki_but_not_with_the_thread_that_started_it() {
        let mut child = std::thread::spawn(|| death::spawn({ let mut c = Command::new("sleep"); c.arg("30"); c }).unwrap()).join().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(child.try_wait().unwrap().is_none(), "alive after the starting thread exited");
        let _ = child.kill();
        assert!(!child.wait().unwrap().success());
    }

    #[test]
    fn on_windows_the_harness_is_node_running_letta_js() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("loki-harness-{}-{nanos}", std::process::id()));
        let npm = home.join("npm");
        let js = npm.join("node_modules").join("@letta-ai").join("letta-code").join("letta.js");
        let nodejs = home.join("nodejs");
        for f in [npm.join("letta.cmd"), js.clone(), nodejs.join("node.exe")] {
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, "").unwrap();
        }
        let rt = Runtime { letta: npm.join("letta.cmd"), node_bin_dir: Some(nodejs.clone()), explicit: false };
        let dir = home.join("token");
        let cmd = server_command(Os::Windows, &rt, &launch(&dir));
        assert_eq!(cmd.get_program(), nodejs.join("node.exe").as_os_str());
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[0], js.to_string_lossy());
        assert_eq!(&args[1..3], ["server", "--listen"]);
        let _ = std::fs::remove_dir_all(&home);
    }
}
