use crate::node;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Default)]
pub struct Harness {
    slot: Mutex<Slot>,
}

#[derive(Default)]
struct Slot {
    running: Option<Running>,
    stops: u64,
    stopped: bool,
}

pub const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

pub struct Running {
    child: Child,
    #[cfg(windows)]
    _job: Option<job::Job>,
}

pub struct Launch<'a> {
    pub token_file: &'a Path,
    pub log_dir: &'a Path,
}

pub struct Daemon<'a> {
    pub node: &'a Path,
    pub entry: &'a Path,
    pub mod_entry: &'a Path,
    pub dir: &'a Path,
    pub path: &'a [PathBuf],
}

pub fn daemon_path(front: &[PathBuf], inherited: Option<&OsStr>) -> OsString {
    let rest: Vec<PathBuf> = inherited.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    std::env::join_paths(front.iter().chain(&rest)).unwrap_or_else(|e| {
        eprintln!("loki: the daemon's PATH: {e}");
        inherited.map(OsStr::to_os_string).unwrap_or_default()
    })
}

pub const EXIT_HELD: i32 = 3;

pub fn daemon_command(d: &Daemon, launch: &Launch) -> Command {
    let mut cmd = Command::new(d.node);
    cmd.arg("--disable-warning=ExperimentalWarning");
    if d.entry.extension().is_some_and(|e| e == "ts") {
        cmd.arg("--experimental-strip-types");
    }
    cmd.arg(d.entry)
        .args(["--loki-daemon", "--dir"])
        .arg(d.dir)
        .arg("--mod")
        .arg(d.mod_entry)
        .arg("--token-file")
        .arg(launch.token_file);
    if !d.path.is_empty() {
        cmd.env("PATH", daemon_path(d.path, std::env::var_os("PATH").as_deref()));
    }
    node::quiet(&mut cmd);
    cmd
}

pub fn restart_delay(recent_exits: usize) -> std::time::Duration {
    std::time::Duration::from_secs(1u64.checked_shl(recent_exits.min(5) as u32).unwrap_or(32).min(30))
}

pub const CRASH_LOOP_EXITS: usize = 3;

pub fn crash_loop_note(recent_exits: usize, log: &Path) -> Option<String> {
    (recent_exits >= CRASH_LOOP_EXITS).then(|| {
        format!("loki's daemon keeps stopping ({recent_exits} times in the last minute): its log is {}", log.display())
    })
}

pub const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;

pub fn rotate_log(log: &Path, max: u64) {
    let Ok(meta) = std::fs::metadata(log) else { return };
    if meta.len() <= max {
        return;
    }
    let mut aside = log.as_os_str().to_owned();
    aside.push(".1");
    let aside = std::path::PathBuf::from(aside);
    let _ = std::fs::remove_file(&aside);
    if let Err(e) = std::fs::rename(log, &aside) {
        eprintln!("loki: could not set the daemon's log aside: {e}");
    }
}

impl Harness {
    pub fn start_daemon(&self, d: &Daemon, launch: &Launch) -> Result<(), String> {
        let log = launch.log_dir.join("daemon.log");
        rotate_log(&log, LOG_MAX_BYTES);
        self.spawn(daemon_command(d, launch), &log)
    }

    pub fn exited(&self) -> Option<std::process::ExitStatus> {
        self.slot.lock().ok()?.running.as_mut()?.child.try_wait().ok()?
    }

    pub fn was_stopped(&self) -> bool {
        self.slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).stopped
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slot>, String> {
        self.slot.lock().map_err(|_| "the harness slot is poisoned".to_string())
    }

    fn spawn(&self, mut cmd: Command, log: &Path) -> Result<(), String> {
        let stops = self.lock()?.stops;
        if let Some(dir) = log.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let log = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
        let name = cmd_name(&cmd);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        #[cfg(target_os = "linux")]
        let child = death::spawn(cmd);
        #[cfg(not(target_os = "linux"))]
        let child = cmd.spawn();
        let child = child.map_err(|e| format!("could not start {name}: {e}"))?;
        #[cfg(windows)]
        let running = {
            let job = job::Job::kill_on_close().and_then(|j| j.assign(&child).map(|_| j));
            if let Err(e) = &job {
                eprintln!("loki: harness job object: {e}");
            }
            Running { child, _job: job.ok() }
        };
        #[cfg(not(windows))]
        let running = Running { child };
        self.install(running, stops, &name)
    }

    fn install(&self, running: Running, stops: u64, name: &str) -> Result<(), String> {
        let previous = {
            let mut g = self.lock()?;
            if g.stops != stops {
                drop(g);
                terminate(running);
                return Err(format!("{name} was stopped while it started"));
            }
            g.stopped = false;
            g.running.replace(running)
        };
        if let Some(old) = previous {
            terminate(old);
        }
        Ok(())
    }

    pub fn stop(&self) {
        let running = self.slot.lock().ok().and_then(|mut g| {
            g.stopped = true;
            g.stops += 1;
            g.running.take()
        });
        if let Some(running) = running {
            terminate(running);
        }
    }
}

fn terminate(mut running: Running) {
    let child = &mut running.child;
    #[cfg(unix)]
    {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
                let until = std::time::Instant::now() + STOP_GRACE;
                while std::time::Instant::now() < until {
                    if !matches!(child.try_wait(), Ok(None)) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn cmd_name(cmd: &Command) -> String {
    Path::new(cmd.get_program()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

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

    fn die_with_loki(cmd: &mut Command) {
        let parent = std::process::id() as libc::pid_t;
        // Safety: between fork and exec only async-signal-safe calls — prctl, getppid — and no allocation.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                // loki already gone: no start (a raw errno, as nothing may allocate here).
                if libc::getppid() != parent {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }

    pub fn spawn(mut cmd: Command) -> io::Result<Child> {
        static SPAWNER: OnceLock<Mutex<mpsc::Sender<Request>>> = OnceLock::new();
        die_with_loki(&mut cmd);
        let tx = SPAWNER.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Request>();
            std::thread::Builder::new()
                .name("loki-harness-spawner".into())
                .spawn(move || {
                    for (mut cmd, reply) in rx {
                        let _ = reply.send(cmd.spawn());
                    }
                })
                .expect("the harness spawner thread");
            Mutex::new(tx)
        });
        let (reply, answer) = mpsc::channel();
        tx.lock()
            .map_err(|_| io::Error::other("harness spawner poisoned"))?
            .send((cmd, reply))
            .map_err(|_| io::Error::other("harness spawner gone"))?;
        answer.recv().map_err(|_| io::Error::other("harness spawner gone"))?
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    unsafe impl Send for Job {}

    impl Job {
        pub fn kill_on_close() -> Result<Job, String> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(format!("CreateJobObjectW: {}", std::io::Error::last_os_error()));
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(format!("SetInformationJobObject: {}", std::io::Error::last_os_error()));
                }
                Ok(job)
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(format!("AssignProcessToJobObject: {}", std::io::Error::last_os_error()))
            } else {
                Ok(())
            }
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

    #[test]
    fn a_daemon_that_keeps_stopping_is_said_so_from_its_third_exit_in_a_minute() {
        let log = Path::new("logs").join("daemon.log");
        assert_eq!(crash_loop_note(0, &log), None);
        assert_eq!(crash_loop_note(CRASH_LOOP_EXITS - 1, &log), None);
        let note = crash_loop_note(CRASH_LOOP_EXITS, &log).expect("a note at the third exit");
        assert!(note.contains("keeps stopping (3 times in the last minute)"), "{note}");
        assert!(note.contains("daemon.log"), "{note}");
    }

    #[test]
    fn a_log_past_its_size_is_set_aside_once_and_a_smaller_one_is_left() {
        let dir = std::env::temp_dir().join(format!("loki-log-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("daemon.log");
        let aside = dir.join("daemon.log.1");
        std::fs::write(&log, b"short").unwrap();
        rotate_log(&log, 10);
        assert!(log.exists() && !aside.exists());
        std::fs::write(&log, b"longer than ten bytes").unwrap();
        std::fs::write(&aside, b"the one before").unwrap();
        rotate_log(&log, 10);
        assert!(!log.exists());
        assert_eq!(std::fs::read(&aside).unwrap(), b"longer than ten bytes");
        rotate_log(&log, 10);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_the_harness_dies_with_loki_but_not_with_the_thread_that_started_it() {
        let mut child = std::thread::spawn(|| {
            death::spawn({
                let mut c = Command::new("sleep");
                c.arg("30");
                c
            })
            .unwrap()
        })
        .join()
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(child.try_wait().unwrap().is_none(), "alive after the starting thread exited");
        let _ = child.kill();
        assert!(!child.wait().unwrap().success());
    }

    #[test]
    fn the_daemon_runs_its_sources_with_type_stripping_and_its_bundle_as_it_is() {
        let (node, dir, token) = (
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/home/x/.loki"),
            PathBuf::from("/home/x/.loki/token"),
        );
        let args = |entry: &str, mod_entry: &str| {
            let (entry, mod_entry) = (PathBuf::from(entry), PathBuf::from(mod_entry));
            let cmd = daemon_command(
                &Daemon { node: &node, entry: &entry, mod_entry: &mod_entry, dir: &dir, path: &[] },
                &launch(&token),
            );
            assert_eq!(cmd.get_program(), node.as_os_str());
            cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(
            args("/src/loki/daemon/main.ts", "/src/loki/mod/boot.ts"),
            [
                "--disable-warning=ExperimentalWarning",
                "--experimental-strip-types",
                "/src/loki/daemon/main.ts",
                "--loki-daemon",
                "--dir",
                "/home/x/.loki",
                "--mod",
                "/src/loki/mod/boot.ts",
                "--token-file",
                "/home/x/.loki/token"
            ]
        );
        assert_eq!(
            args("/data/daemon/daemon.mjs", "/data/mod/loki-mod.mjs")[..2],
            ["--disable-warning=ExperimentalWarning", "/data/daemon/daemon.mjs"],
            "a bundle needs no type stripping"
        );
    }

    #[test]
    fn the_daemons_path_begins_with_the_runtime_folders_then_the_inherited_path() {
        let runtime = [
            PathBuf::from("/home/x/.loki/runtime/node-22.23.5-linux-x64/bin"),
            PathBuf::from("/home/x/.loki/runtime/git-2.56.1-win-x64/cmd"),
            PathBuf::from("/home/x/.loki/runtime/git-2.56.1-win-x64/bin"),
        ];
        let inherited = std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]).unwrap();
        let path = daemon_path(&runtime, Some(&inherited));
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(dirs, [&runtime[..], &[PathBuf::from("/usr/bin"), PathBuf::from("/bin")]].concat());
        assert_eq!(
            std::env::split_paths(&daemon_path(&runtime, None)).collect::<Vec<_>>(),
            runtime,
            "no PATH to inherit"
        );
        let (node, entry, dir, token) =
            (PathBuf::from("node"), PathBuf::from("daemon.mjs"), PathBuf::from("/home/x/.loki"), PathBuf::from("t"));
        let env = |path: &[PathBuf]| {
            let cmd = daemon_command(
                &Daemon { node: &node, entry: &entry, mod_entry: &entry, dir: &dir, path },
                &launch(&token),
            );
            cmd.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v.map(|v| v.to_os_string()))
        };
        let set = env(&runtime).expect("PATH set for the runtime");
        assert_eq!(std::env::split_paths(&set).take(3).collect::<Vec<_>>(), runtime);
        assert_eq!(env(&[]), None);
    }

    #[test]
    fn a_daemon_that_keeps_dying_is_restarted_ever_more_slowly_up_to_thirty_seconds() {
        let secs: Vec<u64> = (0..8).map(|n| restart_delay(n).as_secs()).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[cfg(unix)]
    #[test]
    fn stopping_asks_the_daemon_to_go_before_it_kills_it() {
        let dir = std::env::temp_dir().join(format!("loki-harness-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let marker = dir.join("terminated");
        let _ = std::fs::remove_file(&marker);
        let h = Harness::default();
        let mut polite = Command::new("sh");
        polite.arg("-c").arg(format!("trap 'touch {}; exit 0' TERM; while :; do sleep 0.05; done", marker.display()));
        h.spawn(polite, &dir.join("polite.log")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        h.stop();
        assert!(marker.exists(), "the daemon's SIGTERM handler ran");
        let started = std::time::Instant::now();
        let mut stubborn = Command::new("sh");
        stubborn.arg("-c").arg("trap '' TERM; while :; do sleep 0.05; done");
        h.spawn(stubborn, &dir.join("stubborn.log")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        h.stop();
        assert!(started.elapsed() >= STOP_GRACE, "killed only after the grace");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_start_that_a_stop_overtook_ends_its_child_instead_of_keeping_it() {
        let h = Harness::default();
        let seen = h.slot.lock().unwrap().stops;
        h.stop();
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        assert!(h.install(Running { child }, seen, "sleep").is_err());
        assert!(h.was_stopped(), "the stop still holds: the supervisor leaves it down");
        assert!(h.exited().is_none(), "nothing kept in the slot");
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "the child is gone");
    }

    #[cfg(unix)]
    #[test]
    fn a_start_after_a_stop_clears_the_mark_so_the_supervisor_watches_it_again() {
        let dir = std::env::temp_dir().join(format!("loki-harness-restart-{}", std::process::id()));
        let h = Harness::default();
        h.stop();
        assert!(h.was_stopped());
        let mut sleeper = Command::new("sleep");
        sleeper.arg("30");
        h.spawn(sleeper, &dir.join("sleep.log")).unwrap();
        assert!(!h.was_stopped(), "the new start clears the stop");
        assert!(h.exited().is_none(), "the child is running");
        h.stop();
        assert!(h.was_stopped());
        let _ = std::fs::remove_dir_all(&dir);
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
