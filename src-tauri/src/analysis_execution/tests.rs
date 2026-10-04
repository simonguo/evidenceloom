use super::*;
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{mpsc, OnceLock},
    thread,
};

static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
static DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    std::env::var_os("EVIDENCELOOM_LIFECYCLE_FIXTURE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/lifecycle-fixtures")
        })
}

fn binary() -> &'static PathBuf {
    FIXTURE.get_or_init(|| {
        let directory = root().join(format!("compiled-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("fixture.rs");
        let binary = directory.join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        fs::write(&source, include_str!("fixture.rs")).unwrap();
        let output = Command::new("rustc")
            .args(["--edition=2021"])
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        fs::write(directory.join("compile.stdout"), &output.stdout).unwrap();
        fs::write(directory.join("compile.stderr"), &output.stderr).unwrap();
        assert!(output.status.success(), "owned fixture compile failed");
        binary
    })
}

struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = root().join(format!(
            "case-{}-{}",
            std::process::id(),
            DIRECTORY_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&directory).unwrap();
        Self { directory }
    }
    fn spawn(&self, mode: &str) -> OwnedProcess {
        let mut command = Command::new(binary());
        command
            .arg(mode)
            .arg(&self.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let process = OwnedProcess::spawn_owned(command, Instant::now() + CLEANUP_TIMEOUT)
            .unwrap_or_else(|failure| panic!("fixture spawn failed: {}", failure.error));
        until(|| {
            self.directory.join("ready").exists() && self.directory.join("heartbeat").exists()
        });
        process
    }
    fn counter(&self) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(n) = fs::read_to_string(self.directory.join("heartbeat"))
                .ok()
                .and_then(|s| s.lines().rev().find_map(|line| line.parse().ok()))
            {
                return n;
            }
            assert!(Instant::now() < deadline, "heartbeat unreadable");
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn assert_stopped(&self) {
        let first = self.counter();
        thread::sleep(Duration::from_millis(80));
        assert_eq!(
            first,
            self.counter(),
            "owned descendant still working after cleanup"
        );
    }
}

fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "owned fixture acknowledgement timed out"
        );
        thread::sleep(Duration::from_millis(2));
    }
}

struct Supervisor {
    registry: Arc<Registry>,
    run_id: String,
}
impl Supervisor {
    fn new(registry: &Arc<Registry>, run_id: &str) -> Self {
        Self {
            registry: registry.clone(),
            run_id: run_id.into(),
        }
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(request) = self.registry.cancel("task", &self.run_id) {
            let _ = request.wait(Instant::now() + CLEANUP_TIMEOUT);
        }
    }
}

#[test]
fn reservations_are_atomic_before_any_worker() {
    let registry = Arc::new(Registry::default());
    let (ready, acknowledged) = mpsc::channel();
    let mut starts = Vec::new();
    let mut workers = Vec::new();
    for _ in 0..2 {
        let registry = registry.clone();
        let ready = ready.clone();
        let (start, wait) = mpsc::channel();
        starts.push(start);
        workers.push(thread::spawn(move || {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            registry.reserve("task".into())
        }));
    }
    for _ in 0..2 {
        acknowledged.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    for start in starts {
        start.send(()).unwrap();
    }
    until(|| workers.iter().all(|worker| worker.is_finished()));
    let accepted: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .filter_map(Result::ok)
        .collect();
    assert_eq!(accepted.len(), 1);
    registry
        .cancel("task", &accepted[0])
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
}

#[test]
fn lease_expiry_never_reuses_identity_or_expires_started_owner() {
    let registry = Arc::new(Registry::default());
    let expired = registry.reserve_for("task".into(), Duration::ZERO).unwrap();
    assert!(registry.start("task", &expired).is_err());
    let current = registry
        .reserve_for("task".into(), Duration::from_millis(10))
        .unwrap();
    assert_ne!(expired, current);
    let mut guard = registry.start("task", &current).unwrap();
    thread::sleep(Duration::from_millis(15));
    assert!(registry.reserve("other".into()).is_err());
    assert!(registry.start("task", &current).is_err());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
}

#[test]
fn identity_exhaustion_is_fail_closed() {
    let registry = Registry::default();
    registry.next_id.store(u64::MAX, Ordering::SeqCst);
    assert!(registry.reserve("task".into()).is_err());
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn stale_stop_and_old_cleanup_never_touch_replacement() {
    let registry = Arc::new(Registry::default());
    let old_id = registry.reserve("task".into()).unwrap();
    let mut old = registry.start("task", &old_id).unwrap();
    let old_events = old.events();
    old.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    let new_id = registry.reserve("task".into()).unwrap();
    let mut current = registry.start("task", &new_id).unwrap();
    assert!(registry.cancel("task", &old_id).is_none());
    old.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert!(!old_events.allows_events());
    assert!(current.events().allows_events());
    assert!(registry.reserve("other".into()).is_err());
    current.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
}

#[test]
fn cancelled_unstarted_reservation_cannot_start() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
    assert!(registry.start("task", &id).is_err());
    assert!(registry.cancel("task", &id).is_none());
}

#[test]
fn preparing_cancel_retains_slot_and_timeout_can_retry() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let request = registry.cancel("task", &id).unwrap();
    assert!(guard.cancelled());
    assert_eq!(request.wait(Instant::now()).unwrap_err(), CLEANUP_ERROR);
    assert!(registry.reserve("other".into()).is_err());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert!(registry.cancel("task", &id).is_none());
    registry.reserve("other".into()).unwrap();
}

#[test]
fn cancel_during_spawn_is_applied_on_attachment_before_payload() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    let process = fixture.spawn("waiting");
    let request = registry.cancel("task", &id).unwrap();
    guard.attach(process).unwrap();
    assert!(guard.cancelled());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    request.wait(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert!(!fixture.directory.join("payload").exists());
    fixture.assert_stopped();
}

#[test]
fn natural_exit_cleans_descendant_and_drains_inherited_stdout() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    let mut process = fixture.spawn("exit-held");
    let mut stdout = process.child.stdout.take().unwrap();
    guard.attach(process).unwrap();
    let (done, received) = mpsc::channel();
    guard.reader(thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).unwrap();
        done.send(()).unwrap();
    }));
    until(|| guard.try_wait().unwrap().is_some());
    assert!(received.try_recv().is_err());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    received.recv_timeout(Duration::from_secs(1)).unwrap();
    fixture.assert_stopped();
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn final_output_is_drained_before_owner_retirement() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    let mut process = fixture.spawn("final");
    let mut stdin = process.child.stdin.take().unwrap();
    let mut stdout = process.child.stdout.take().unwrap();
    guard.attach(process).unwrap();
    let output = Arc::new(Mutex::new(String::new()));
    let saved = output.clone();
    let events = guard.events();
    guard.reader(thread::spawn(move || {
        let mut value = String::new();
        stdout.read_to_string(&mut value).unwrap();
        assert!(events.allows_events());
        *saved.lock().unwrap() = value;
    }));
    stdin.write_all(b"owned payload").unwrap();
    drop(stdin);
    until(|| guard.try_wait().unwrap().is_some());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert_eq!(&*output.lock().unwrap(), "final-report\n");
    fixture.assert_stopped();
}

#[test]
fn blocked_writer_does_not_hold_process_mutex_against_stop() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    let mut process = fixture.spawn("waiting");
    let mut stdin = process.child.stdin.take().unwrap();
    guard.attach(process).unwrap();
    let (began, acknowledgement) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut guard = guard;
        began.send(()).unwrap();
        let failed = stdin.write_all(&vec![b'x'; 8 * 1024 * 1024]).is_err();
        guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
        failed
    });
    acknowledgement
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
    until(|| worker.is_finished());
    assert!(worker.join().unwrap());
    fixture.assert_stopped();
}

#[test]
fn closed_stdin_error_cleans_owned_tree() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    let mut process = fixture.spawn("closed");
    let mut stdin = process.child.stdin.take().unwrap();
    guard.attach(process).unwrap();
    assert!(stdin.write_all(&vec![b'x'; 1024 * 1024]).is_err());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    fixture.assert_stopped();
}

#[test]
fn unfinished_reader_retains_owner_until_explicit_retry() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let (release, wait) = mpsc::channel();
    guard.reader(thread::spawn(move || {
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
    }));
    assert_eq!(guard.finish(Instant::now()).unwrap_err(), CLEANUP_ERROR);
    assert!(registry.reserve("other".into()).is_err());
    release.send(()).unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn termination_failure_is_retryable_and_success_is_idempotent() {
    let fixture = Fixture::new();
    let mut process = fixture.spawn("waiting");
    assert!(process
        .stop_with_termination(Instant::now() + CLEANUP_TIMEOUT, |_| Err(
            std::io::Error::other("injected signal failure")
        ))
        .is_err());
    let before = fixture.counter();
    until(|| fixture.counter() > before);
    process.stop(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert!(process.child.try_wait().unwrap().is_some());
    process
        .stop_with_termination(Instant::now(), |_| {
            panic!("finalized identity must never be signalled")
        })
        .unwrap();
    fixture.assert_stopped();
}

#[test]
fn reap_timeout_retains_process_for_retry() {
    let fixture = Fixture::new();
    let mut process = fixture.spawn("waiting");
    // Submit real owned termination, then inject a reap failure. Retry must
    // finish the known handles without signalling a finalized numeric identity.
    assert!(process
        .stop_with_reaping(Instant::now(), OwnedProcess::submit_termination, |_, _| {
            false
        })
        .is_err());
    process
        .stop_with_termination(Instant::now() + CLEANUP_TIMEOUT, |_| {
            panic!("termination already issued; retry must not re-signal")
        })
        .unwrap();
    fixture.assert_stopped();
}

#[test]
fn worker_panic_guard_cleans_and_releases_owner() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    guard.attach(fixture.spawn("waiting")).unwrap();
    let worker = thread::spawn(move || {
        let _guard = guard;
        panic!("owned worker injection");
    });
    until(|| worker.is_finished());
    assert!(worker.join().is_err());
    fixture.assert_stopped();
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn partial_spawn_failure_is_owned_until_cleanup() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    let command = Command::new(fixture.directory.join("does-not-exist"));
    let failure = match OwnedProcess::spawn_owned(command, Instant::now() + CLEANUP_TIMEOUT) {
        Ok(_) => panic!("missing executable unexpectedly started"),
        Err(failure) => failure,
    };
    #[cfg(unix)]
    assert!(
        failure.pending.is_some(),
        "anchor must remain owned on failed child spawn"
    );
    if let Some(pending) = failure.pending {
        guard.attach(pending).unwrap();
    }
    assert!(registry.reserve("other".into()).is_err());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn stop_acknowledgement_waits_for_preparing_worker_retirement() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let owner = guard.owner.clone();
    let (release, proceed) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut guard = guard;
        proceed.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(guard.cancelled());
        guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    });
    let request = registry.cancel("task", &id).unwrap();
    let (completed, result) = mpsc::channel();
    let stopping = thread::spawn(move || {
        completed
            .send(request.wait(Instant::now() + CLEANUP_TIMEOUT))
            .unwrap()
    });
    until(|| owner.state.lock().unwrap().phase == Phase::Cleaning);
    assert!(
        result.try_recv().is_err(),
        "stop acknowledged while worker still preparing"
    );
    assert!(registry.reserve("other".into()).is_err());
    release.send(()).unwrap();
    result
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    assert!(registry.active.lock().unwrap().is_none());
    until(|| worker.is_finished() && stopping.is_finished());
    worker.join().unwrap();
    stopping.join().unwrap();
}

#[test]
fn cleanup_lock_contention_respects_deadline_and_sync_cancel_is_short() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let owner = guard.owner.clone();
    let (held, acquired) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let locker = thread::spawn(move || {
        let _state = owner.state.lock().unwrap();
        held.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(3)).unwrap();
    });
    acquired.recv_timeout(Duration::from_secs(1)).unwrap();
    let started = Instant::now();
    let request = registry.cancel("task", &id).unwrap();
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(
        request
            .wait(Instant::now() + Duration::from_millis(20))
            .unwrap_err(),
        CLEANUP_ERROR
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(registry.reserve("other".into()).is_err());
    release.send(()).unwrap();
    until(|| locker.is_finished());
    locker.join().unwrap();
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
}

#[test]
fn deletion_rejects_active_and_cleanup_failed_same_task() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let called = AtomicBool::new(false);
    assert!(registry
        .delete_idle_task("task", || {
            called.store(true, Ordering::SeqCst);
            Ok(())
        })
        .is_err());
    let mut guard = registry.start("task", &id).unwrap();
    assert!(registry.delete_idle_task("task", || Ok(())).is_err());
    let (release, wait) = mpsc::channel();
    guard.reader(thread::spawn(move || {
        wait.recv_timeout(Duration::from_secs(3)).unwrap()
    }));
    assert_eq!(guard.finish(Instant::now()).unwrap_err(), CLEANUP_ERROR);
    assert!(registry
        .delete_idle_task("task", || {
            called.store(true, Ordering::SeqCst);
            Ok(())
        })
        .is_err());
    assert!(!called.load(Ordering::SeqCst));
    release.send(()).unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
    registry
        .delete_idle_task("task", || {
            called.store(true, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
    assert!(called.load(Ordering::SeqCst));
}

#[test]
fn deletion_of_unrelated_task_is_allowed_without_cancelling_owner() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("active".into()).unwrap();
    let mut guard = registry.start("active", &id).unwrap();
    registry.delete_idle_task("unrelated", || Ok(())).unwrap();
    assert!(!guard.cancelled());
    assert!(registry.reserve("another".into()).is_err());
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
}

#[test]
fn idle_clear_runs_once_and_propagates_callback_failure_without_blocking_admission() {
    let registry = Arc::new(Registry::default());
    let fixture = Fixture::new();
    let saved = fixture.directory.join("saved-report");
    fs::write(&saved, b"fictional saved research").unwrap();
    let calls = AtomicU64::new(0);
    let failure = registry.clear_idle_data(|| {
        calls.fetch_add(1, Ordering::SeqCst);
        Err::<(), _>("owned clear callback failed".into())
    });
    assert_eq!(failure.unwrap_err(), "owned clear callback failed");
    assert_eq!(fs::read(&saved).unwrap(), b"fictional saved research");
    let cleared = registry
        .clear_idle_data(|| {
            calls.fetch_add(1, Ordering::SeqCst);
            fs::remove_file(&saved).map_err(|error| error.to_string())?;
            Ok(17)
        })
        .unwrap();
    assert_eq!(cleared, 17);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!saved.exists());
    let id = registry.reserve("task".into()).unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
}

#[test]
fn clear_rejects_unstarted_and_preparing_owners_without_touching_saved_data() {
    let registry = Arc::new(Registry::default());
    let fixture = Fixture::new();
    let saved = fixture.directory.join("saved-report");
    fs::write(&saved, b"fictional saved research").unwrap();
    let id = registry.reserve("task".into()).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let calls = AtomicU64::new(0);
    let clear = || {
        calls.fetch_add(1, Ordering::SeqCst);
        fs::remove_file(&saved).map_err(|error| error.to_string())
    };
    let unstarted = registry.clear_idle_data(clear);
    let mut guard = registry.start("task", &id).unwrap();
    let preparing = registry.clear_idle_data(clear);
    let not_cancelled = !guard.cancelled();
    guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    assert!(unstarted.is_err() && preparing.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(&saved).unwrap(), b"fictional saved research");
    assert!(not_cancelled, "rejected clearing must not cancel the owner");
}

#[test]
fn cleanup_failed_owner_blocks_clear_until_explicit_retry_finishes_its_reader() {
    let registry = Arc::new(Registry::default());
    let fixture = Fixture::new();
    let saved = fixture.directory.join("saved-report");
    fs::write(&saved, b"fictional saved research").unwrap();
    let id = registry.reserve("task".into()).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let mut guard = registry.start("task", &id).unwrap();
    let (release, wait) = mpsc::channel();
    let (finished, worker_result) = mpsc::channel();
    guard.reader(thread::spawn(move || {
        let outcome = wait
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string());
        let _ = finished.send(outcome);
    }));
    let first_finish = guard.finish(Instant::now());
    let calls = AtomicU64::new(0);
    let blocked = registry.clear_idle_data(|| {
        calls.fetch_add(1, Ordering::SeqCst);
        fs::remove_file(&saved).map_err(|error| error.to_string())
    });
    let saved_while_blocked = fs::read(&saved);
    let retained = guard.ownership().retained();
    // Release and consume the owned reader before any observation assertion.
    let released = release.send(()).is_ok();
    let retry = registry
        .cancel("task", &id)
        .ok_or_else(|| "cleanup owner disappeared".to_string())
        .and_then(|request| request.wait(Instant::now() + CLEANUP_TIMEOUT));
    let reader_result = worker_result.recv_timeout(Duration::from_secs(3));
    let finish_after_retry = guard.finish(Instant::now() + CLEANUP_TIMEOUT);
    let clear_after_retry = registry.clear_idle_data(|| {
        calls.fetch_add(1, Ordering::SeqCst);
        fs::remove_file(&saved).map_err(|error| error.to_string())
    });
    assert_eq!(first_finish.unwrap_err(), CLEANUP_ERROR);
    assert!(blocked.is_err() && retained && released);
    assert_eq!(saved_while_blocked.unwrap(), b"fictional saved research");
    retry.unwrap();
    reader_result.unwrap().unwrap();
    finish_after_retry.unwrap();
    clear_after_retry.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!saved.exists());
}

#[test]
fn clear_preserves_run_identity_after_expiring_an_unstarted_lease() {
    let registry = Arc::new(Registry::default());
    let expired = registry.reserve_for("task".into(), Duration::ZERO).unwrap();
    registry.clear_idle_data(|| Ok(())).unwrap();
    let current = registry.reserve("task".into()).unwrap();
    assert_ne!(expired, current);
    assert!(registry.clear_idle_data(|| Ok(())).is_err());
    registry
        .cancel("task", &current)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
}

#[test]
fn clear_callback_and_concurrent_admission_have_no_check_gap() {
    let registry = Arc::new(Registry::default());
    let clearing = registry.clone();
    let clear_completed = Arc::new(AtomicBool::new(false));
    let cleared = clear_completed.clone();
    let fixture = Fixture::new();
    let saved = fixture.directory.join("saved-report");
    fs::write(&saved, b"fictional saved research").unwrap();
    let saved_for_clear = saved.clone();
    let (entered, inside) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let clear_worker = thread::spawn(move || {
        clearing.clear_idle_data(|| {
            entered.send(()).map_err(|error| error.to_string())?;
            wait.recv_timeout(Duration::from_secs(8))
                .map_err(|error| error.to_string())?;
            fs::remove_file(saved_for_clear).map_err(|error| error.to_string())?;
            cleared.store(true, Ordering::SeqCst);
            Ok(())
        })
    });
    let entered_result = inside.recv_timeout(Duration::from_secs(5));
    let reserving = registry.clone();
    let completed_at_admission = clear_completed.clone();
    let (attempted, attempt_result) = mpsc::channel();
    let (admitted, admission_result) = mpsc::channel();
    let reservation = thread::spawn(move || {
        // This is a real lock attempt, not an acknowledgement before reserve.
        let lock_held = matches!(reserving.active.try_lock(), Err(TryLockError::WouldBlock));
        let _ = attempted.send(lock_held);
        let outcome = reserving.reserve("task".into());
        let after_clear = completed_at_admission.load(Ordering::SeqCst);
        let _ = admitted.send(());
        (outcome, after_clear)
    });
    let attempted_while_locked = attempt_result.recv_timeout(Duration::from_secs(5));
    let admission_waited = matches!(
        admission_result.recv_timeout(Duration::from_millis(20)),
        Err(mpsc::RecvTimeoutError::Timeout)
    );
    let saved_before_release = fs::read(&saved);
    // Always release the callback and attempt bounded joins before assertions.
    // Success requires joined workers; a stuck Rust thread cannot be force-killed.
    let released = release.send(()).is_ok();
    let join_deadline = Instant::now() + Duration::from_secs(10);
    while (!clear_worker.is_finished() || !reservation.is_finished())
        && Instant::now() < join_deadline
    {
        thread::sleep(Duration::from_millis(2));
    }
    let clearing_result = clear_worker.is_finished().then(|| clear_worker.join());
    let reservation_result = reservation.is_finished().then(|| reservation.join());
    let reservation_outcome = reservation_result.and_then(Result::ok);
    let cleanup = reservation_outcome.as_ref().and_then(|(outcome, _)| {
        outcome.as_ref().ok().map(|id| {
            registry
                .cancel("task", id)
                .ok_or_else(|| "admitted owner disappeared".to_string())
                .and_then(|request| request.wait(Instant::now() + CLEANUP_TIMEOUT))
        })
    });
    assert!(entered_result.is_ok() && released);
    assert!(attempted_while_locked.unwrap());
    assert!(admission_waited);
    assert_eq!(saved_before_release.unwrap(), b"fictional saved research");
    clearing_result
        .expect("clear worker did not finish")
        .unwrap()
        .unwrap();
    let (admission, after_clear) = reservation_outcome.expect("reservation worker did not finish");
    admission.unwrap();
    assert!(after_clear, "reservation returned before clear completed");
    cleanup.expect("admitted owner was not supervised").unwrap();
    assert!(!saved.exists());
}

#[test]
fn deletion_closure_and_concurrent_reservation_have_no_check_gap() {
    let registry = Arc::new(Registry::default());
    let deleting = registry.clone();
    let (entered, inside) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let deletion = thread::spawn(move || {
        deleting.delete_idle_task("task", || {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(())
        })
    });
    inside.recv_timeout(Duration::from_secs(1)).unwrap();
    let reserving = registry.clone();
    let (began, attempted) = mpsc::channel();
    let (reserved, outcome) = mpsc::channel();
    let reservation = thread::spawn(move || {
        began.send(()).unwrap();
        reserved.send(reserving.reserve("task".into())).unwrap();
    });
    attempted.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(matches!(
        outcome.recv_timeout(Duration::from_millis(20)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    release.send(()).unwrap();
    let id = outcome
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    until(|| deletion.is_finished() && reservation.is_finished());
    deletion.join().unwrap().unwrap();
    reservation.join().unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
}

#[test]
fn reader_panic_is_joined_propagated_and_tree_is_cleaned() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    guard.attach(fixture.spawn("waiting")).unwrap();
    guard.reader(thread::spawn(|| panic!("owned reader injection")));
    assert_eq!(
        guard.finish(Instant::now() + CLEANUP_TIMEOUT).unwrap_err(),
        "Analysis output reader failed."
    );
    fixture.assert_stopped();
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn worker_panic_with_unfinished_reader_retains_owner_for_retry() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let guard = registry.start("task", &id).unwrap();
    let _supervisor = Supervisor::new(&registry, &id);
    let fixture = Fixture::new();
    guard.attach(fixture.spawn("waiting")).unwrap();
    let (release, wait) = mpsc::channel();
    guard.reader(thread::spawn(move || {
        wait.recv_timeout(Duration::from_secs(10)).unwrap()
    }));
    let worker = thread::spawn(move || {
        let _guard = guard;
        panic!("owned failed-cleanup worker injection");
    });
    until(|| worker.is_finished());
    assert!(worker.join().is_err());
    assert!(registry.reserve("other".into()).is_err());
    fixture.assert_stopped();
    release.send(()).unwrap();
    registry
        .cancel("task", &id)
        .unwrap()
        .wait(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
    assert!(registry.active.lock().unwrap().is_none());
}

#[test]
fn repeat_finish_never_acknowledges_unfinished_cleanup() {
    let registry = Arc::new(Registry::default());
    let id = registry.reserve("task".into()).unwrap();
    let mut guard = registry.start("task", &id).unwrap();
    let (release, wait) = mpsc::channel();
    guard.reader(thread::spawn(move || {
        wait.recv_timeout(Duration::from_secs(3)).unwrap()
    }));
    let first = guard.finish(Instant::now());
    let second = guard.finish(Instant::now());
    let retained = registry.reserve("another".into()).is_err();
    release.send(()).unwrap();
    let third = guard.finish(Instant::now() + CLEANUP_TIMEOUT);
    // Always retire the old implementation's retained owner before assertions.
    if let Some(request) = registry.cancel("task", &id) {
        request.wait(Instant::now() + CLEANUP_TIMEOUT).unwrap();
    }
    assert_eq!(first.unwrap_err(), CLEANUP_ERROR);
    assert_eq!(second.unwrap_err(), CLEANUP_ERROR);
    assert!(retained);
    third.unwrap();
    assert!(registry.active.lock().unwrap().is_none());
}
