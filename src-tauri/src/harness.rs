//! loki's daemon (plan 017): `node <daemon> --loki-daemon …` on the machine's Node (node.rs), hosting the mod and
//! serving the app, with loki's token file as its capability token. Started at launch, restarted when it dies
//! (supervise_daemon in lib.rs), killed when the app quits.
//!
//! On Windows it runs with no console window, inside a Job Object that kills the whole tree when loki's handle
//! closes — quitting, or loki dying, never leaves a node holding the daemon's folder. On Linux it is started with
//! PR_SET_PDEATHSIG, so the kernel kills it when loki dies (`die_with_loki`). A daemon left from an earlier run
//! anyway (the Mac, or a Linux crash before that took hold) is stopped at the next launch (procs::daemon_leftover).

use crate::node;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// The daemon, once started. Managed from launch so it can start later (after Node is installed: retry_daemon).
#[derive(Default)]
pub struct Harness {
    slot: Mutex<Option<Running>>,
    /// Set by `stop`: the supervisor (supervise_daemon in lib.rs) does not restart a child loki stopped itself.
    stopped: std::sync::atomic::AtomicBool,
}

/// The daemon loki started: the child, and on Windows the Job Object that owns its process tree.
pub struct Running {
    child: Child,
    #[cfg(windows)]
    _job: Option<job::Job>,
}

/// Everything a start needs besides the daemon itself: where the token and the logs are.
pub struct Launch<'a> {
    pub token_file: &'a Path,
    pub log_dir: &'a Path,
}

/// Where loki's daemon is and what it hosts.
pub struct Daemon<'a> {
    pub node: &'a Path,
    /// daemon.mjs as installed, or a checkout's daemon/main.ts.
    pub entry: &'a Path,
    /// The mod the daemon hosts: the installed loki-mod.mjs, or a checkout's mod/boot.ts.
    pub mod_entry: &'a Path,
    /// The folder the daemon locks and keeps its state in.
    pub dir: &'a Path,
}

/// The daemon's exit code when another daemon already holds its folder (daemon/main.ts EXIT_HELD): that one keeps
/// serving, so this one is not restarted.
pub const EXIT_HELD: i32 = 3;

/// `node <entry> --loki-daemon …`: TypeScript sources run with Node's type stripping, the bundle as it is. The marker
/// and the token file make the command line recognisably loki's, for a leftover from a crash (procs.rs).
pub fn daemon_command(d: &Daemon, launch: &Launch) -> Command {
    let mut cmd = Command::new(d.node);
    // Node calls its own SQLite (pi-durable's store) and type stripping experimental and says so on every start; the
    // daemon's log keeps every other warning.
    cmd.arg("--disable-warning=ExperimentalWarning");
    if d.entry.extension().is_some_and(|e| e == "ts") {
        cmd.arg("--experimental-strip-types");
    }
    cmd.arg(d.entry).args(["--loki-daemon", "--dir"]).arg(d.dir).arg("--mod").arg(d.mod_entry).arg("--token-file").arg(launch.token_file);
    node::quiet(&mut cmd);
    cmd
}

/// How long to wait before restarting a daemon that died, given how many times it died in the last minute: one
/// second, doubling, never more than thirty — a daemon that crashes at start does not spin.
pub fn restart_delay(recent_exits: usize) -> std::time::Duration {
    std::time::Duration::from_secs(1u64.checked_shl(recent_exits.min(5) as u32).unwrap_or(32).min(30))
}

impl Harness {
    /// Start loki's daemon; replaces a child started earlier.
    pub fn start_daemon(&self, d: &Daemon, launch: &Launch) -> Result<(), String> {
        // Appended, so a restarted daemon's log follows the one that died rather than replacing it.
        self.spawn(daemon_command(d, launch), &launch.log_dir.join("daemon.log"))
    }

    /// Whether the child has exited, and how: None while it runs or when there is none.
    pub fn exited(&self) -> Option<std::process::ExitStatus> {
        self.slot.lock().ok()?.as_mut()?.child.try_wait().ok()?
    }

    /// Whether loki itself stopped the child (quit, or a replacement started).
    pub fn was_stopped(&self) -> bool {
        self.stopped.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn spawn(&self, mut cmd: Command, log: &Path) -> Result<(), String> {
        if let Some(dir) = log.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
        let log = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
        let name = cmd_name(&cmd);
        cmd.stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log));
        #[cfg(target_os = "linux")]
        let child = death::spawn(cmd);
        #[cfg(not(target_os = "linux"))]
        let child = cmd.spawn();
        let child = child.map_err(|e| format!("could not start {name}: {e}"))?;
        #[cfg(windows)]
        let running = {
            let job = job::Job::kill_on_close().and_then(|j| j.assign(&child).map(|_| j));
            if let Err(e) = &job { eprintln!("loki: harness job object: {e}"); }
            Running { child, _job: job.ok() }
        };
        #[cfg(not(windows))]
        let running = Running { child };
        self.kill_child();
        self.stopped.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut g) = self.slot.lock() { *g = Some(running); }
        Ok(())
    }

    /// Kill the daemon and wait for it; on Windows closing the job then takes the rest of its tree.
    pub fn stop(&self) {
        self.stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        self.kill_child();
    }

    fn kill_child(&self) {
        if let Some(Running { mut child, .. }) = self.slot.lock().ok().and_then(|mut g| g.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The program a command runs, for an error message.
fn cmd_name(cmd: &Command) -> String {
    Path::new(cmd.get_program()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Whatever ends the app — window closed, quit, or a signal unwinding main — the daemon goes with it.
impl Drop for Harness {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Linux: the daemon dies with loki. PR_SET_PDEATHSIG fires when the *thread* that forked the child exits, not the
/// process — and a start can come from a short-lived thread (the supervisor's, or retry_daemon on Tauri's command
/// pool), which would kill a healthy daemon when that thread ends. So every start is forked from one thread that
/// lives as long as loki. SIGKILL, like `stop`: nothing of the daemon outlives loki to hold its folder.
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
/// the daemon is stopped or replaced, and when loki itself exits for any reason.
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
    use std::path::PathBuf;

    fn launch<'a>(dir: &'a Path) -> Launch<'a> {
        Launch { token_file: dir, log_dir: dir }
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
    fn the_daemon_runs_its_sources_with_type_stripping_and_its_bundle_as_it_is() {
        let (node, dir, token) = (PathBuf::from("/usr/local/bin/node"), PathBuf::from("/home/x/.loki"), PathBuf::from("/home/x/.loki/token"));
        let args = |entry: &str, mod_entry: &str| {
            let (entry, mod_entry) = (PathBuf::from(entry), PathBuf::from(mod_entry));
            let cmd = daemon_command(&Daemon { node: &node, entry: &entry, mod_entry: &mod_entry, dir: &dir }, &launch(&token));
            assert_eq!(cmd.get_program(), node.as_os_str());
            cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(
            args("/src/loki/daemon/main.ts", "/src/loki/mod/boot.ts"),
            ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "/src/loki/daemon/main.ts", "--loki-daemon", "--dir", "/home/x/.loki", "--mod", "/src/loki/mod/boot.ts", "--token-file", "/home/x/.loki/token"]
        );
        assert_eq!(args("/data/daemon/daemon.mjs", "/data/mod/loki-mod.mjs")[..2], ["--disable-warning=ExperimentalWarning", "/data/daemon/daemon.mjs"], "a bundle needs no type stripping");
    }

    #[test]
    fn a_daemon_that_keeps_dying_is_restarted_ever_more_slowly_up_to_thirty_seconds() {
        let secs: Vec<u64> = (0..8).map(|n| restart_delay(n).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn a_stopped_harness_is_marked_so_its_supervisor_leaves_it_down() {
        let h = Harness::default();
        assert!(!h.was_stopped());
        assert!(h.exited().is_none(), "no child yet");
        h.stop();
        assert!(h.was_stopped());
    }
}
