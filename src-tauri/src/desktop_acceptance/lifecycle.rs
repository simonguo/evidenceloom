//! Shares production process ownership and records acceptance lifecycle cleanup.
use super::{
    control::ControlState,
    driver::FinishReason,
    error,
    tasks::{NativeTasks, TaskFacts},
    AcceptanceError,
};
use crate::{
    analysis_recovery::{
        parser,
        runtime::{Coordinator, WakeSink},
        wire::{ControlReceipt, JournalSummary, RunBinding, RunIdentity, StopRequest},
    },
    json_command::Supervisor,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

// Policy choices, not measured SLAs. No new private IPC or budget consumption.
const GLOBAL_DEADLINE: Duration = Duration::from_secs(900);
const IDLE_DEADLINE: Duration = Duration::from_secs(180);
const HEARTBEAT_GRACE: Duration = Duration::from_secs(180);
const HEARTBEAT_LOSS: Duration = Duration::from_secs(10);
const HEARTBEAT_READ_DEADLINE: Duration = Duration::from_secs(2);
const CLEANUP_DEADLINE: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_millis(250);
const FINAL_BYTES: usize = 8 * 1024;
const FINAL_WRITE_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Cause {
    DriverComplete,
    DriverFailed,
    WindowClose,
    ExitRequested,
    GlobalDeadline,
    IdleDeadline,
    HeartbeatLost,
}
impl Cause {
    fn code(self) -> u8 {
        self as u8 + 1
    }
    fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::DriverComplete),
            2 => Some(Self::DriverFailed),
            3 => Some(Self::WindowClose),
            4 => Some(Self::ExitRequested),
            5 => Some(Self::GlobalDeadline),
            6 => Some(Self::IdleDeadline),
            7 => Some(Self::HeartbeatLost),
            _ => None,
        }
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Facts {
    admission_closed: Option<bool>,
    private_controls_closed: Option<bool>,
    auxiliary_initial_cleanup_confirmed: Option<bool>,
    auxiliary_cleanup_confirmed: Option<bool>,
    captured_owner: Option<CapturedOwner>,
    captured_registry_owner_retained: Option<bool>,
    stop_receipt: Option<ControlReceipt>,
    stop_rejection_code: Option<String>,
    stop_call_error_code: Option<String>,
    stop_query_available: bool,
    journal: Option<JournalSummary>,
    current_sql_available: bool,
    runtime_initialization: Option<String>,
    runtime_gate: Option<String>,
    journal_gate: Option<String>,
    runtime_owner_present: Option<bool>,
    blocker_count: Option<usize>,
    snapshot_coherent: Option<bool>,
    journal_count: Option<usize>,
    unsettled_journal_count: Option<usize>,
    writer_mutex_available: Option<bool>,
    // Actual original Tauri handles, including late Publisher/SQL calls and
    // inventory CPU validation. Mutex availability is separately diagnostic.
    native_tasks: Option<TaskFacts>,
    heartbeat_worker_joined: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedOwner {
    origin: RunIdentity,
    journal_id: String,
    binding: RunBinding,
    header_digest: Option<String>,
    preparing: bool,
    start_claimed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalRecord<'a> {
    schema_version: u8,
    record_kind: &'static str,
    session_id: &'a str,
    build_id: &'a str,
    first_cause: Cause,
    failure_observed: bool,
    status: &'static str,
    error_code: Option<&'static str>,
    cleanup_worker_joined: bool,
    watchdog_worker_joined: bool,
    // The current exit dispatcher executes cleanup/write/exit in order. It is
    // never counted as a completed activity and never attempts to join itself.
    exit_dispatcher_is_current_thread: bool,
    facts: &'a Facts,
    native_exit_eligible: bool,
    native_exit_authorized: bool,
    record_writer_join_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Heartbeat {
    schema_version: u8,
    session_id: String,
    build_id: String,
    counter: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestDisposition {
    Accepted,
    AlreadyFinalized,
}

// Per-call probe only: it never exists in a normal production build. Sender
// drop releases/aborts the test commit on every early error or panic path.
#[cfg(test)]
struct ExitCommitProbe {
    observed: Sender<()>,
    release: Receiver<()>,
}

pub(crate) struct LifecycleIdentity {
    pub(crate) root: PathBuf,
    pub(crate) session_id: String,
    pub(crate) build_id: String,
}

pub(crate) struct NativeLifecycle {
    root: PathBuf,
    session_id: String,
    build_id: String,
    recovery: Arc<Coordinator>,
    auxiliary: Arc<Supervisor>,
    controls: Arc<ControlState>,
    tasks: Arc<NativeTasks>,
    wake: WakeSink,
    // Only short request/authorization decisions use this gate. Cleanup,
    // filesystem I/O, writer waits and App.exit always run outside it.
    exit_decision: Mutex<()>,
    requested: AtomicU8,
    failure_observed: AtomicBool,
    exit_authorized: AtomicBool,
    exit_code: AtomicI32,
    signal: Sender<()>,
    receiver: Mutex<Option<Receiver<()>>>,
    watchdog: Mutex<Option<JoinHandle<()>>>,
    watchdog_joined: AtomicBool,
    exit_dispatcher: Mutex<Option<JoinHandle<()>>>,
    // A timed-out helper remains owned here. No detached-handle success.
    pending_cleanup: Mutex<Option<JoinHandle<()>>>,
    pending_record: Mutex<Option<JoinHandle<std::io::Result<()>>>>,
    heartbeat_read: Mutex<Option<(Instant, JoinHandle<Option<u64>>)>>,
}
impl NativeLifecycle {
    pub(crate) fn new(
        identity: LifecycleIdentity,
        recovery: Arc<Coordinator>,
        auxiliary: Arc<Supervisor>,
        controls: Arc<ControlState>,
        wake: WakeSink,
        tasks: Arc<NativeTasks>,
    ) -> Arc<Self> {
        let LifecycleIdentity {
            root,
            session_id,
            build_id,
        } = identity;
        let (signal, receiver) = mpsc::channel();
        Arc::new(Self {
            root,
            session_id,
            build_id,
            recovery,
            auxiliary,
            controls,
            tasks,
            wake,
            exit_decision: Mutex::new(()),
            requested: AtomicU8::new(0),
            failure_observed: AtomicBool::new(false),
            exit_authorized: AtomicBool::new(false),
            exit_code: AtomicI32::new(-1),
            signal,
            receiver: Mutex::new(Some(receiver)),
            watchdog: Mutex::new(None),
            watchdog_joined: AtomicBool::new(false),
            exit_dispatcher: Mutex::new(None),
            pending_cleanup: Mutex::new(None),
            pending_record: Mutex::new(None),
            heartbeat_read: Mutex::new(None),
        })
    }
    pub(crate) fn request_driver_finish(
        &self,
        reason: FinishReason,
    ) -> Result<(), AcceptanceError> {
        match self.request(match reason {
            FinishReason::Complete => Cause::DriverComplete,
            FinishReason::Failed => Cause::DriverFailed,
        }) {
            RequestDisposition::Accepted => Ok(()), // C02 reply stays unverified/exit=false.
            RequestDisposition::AlreadyFinalized => Err(error("acceptance_finish_failed")),
        }
    }
    pub(crate) fn request(&self, cause: Cause) -> RequestDisposition {
        let _decision = self.exit_decision.lock().unwrap_or_else(|e| e.into_inner());
        if self.exit_authorized.load(Ordering::SeqCst) {
            return RequestDisposition::AlreadyFinalized;
        }
        if !matches!(cause, Cause::DriverComplete) {
            self.failure_observed.store(true, Ordering::SeqCst);
        }
        if self
            .requested
            .compare_exchange(0, cause.code(), Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let _ = self.signal.send(());
        }
        RequestDisposition::Accepted
    }
    pub(crate) fn exit_authorized(&self) -> bool {
        self.exit_authorized.load(Ordering::SeqCst)
    }
    pub(crate) fn authorized_exit_code(&self) -> Option<i32> {
        self.exit_authorized()
            .then(|| self.exit_code.load(Ordering::SeqCst))
    }
    pub(crate) fn start(
        self: &Arc<Self>,
        exit: Arc<dyn Fn(i32) + Send + Sync>,
    ) -> Result<(), AcceptanceError> {
        let receiver = self
            .receiver
            .lock()
            .map_err(|_| error("acceptance_finish_failed"))?
            .take()
            .ok_or_else(|| error("acceptance_finish_failed"))?;
        let lifecycle = self.clone();
        let handle = thread::Builder::new()
            .name("acceptance-native-watchdog".into())
            .spawn(move || lifecycle.watch(receiver))
            .map_err(|_| error("acceptance_finish_failed"))?;
        *self
            .watchdog
            .lock()
            .map_err(|_| error("acceptance_finish_failed"))? = Some(handle);
        let lifecycle = self.clone();
        // Join the original watchdog on a separate off-UI exit dispatcher. The
        // watchdog returns after selecting the first cause; it never self-joins.
        let dispatcher = thread::Builder::new()
            .name("acceptance-native-exit-dispatch".into())
            .spawn(move || {
                let handle = lifecycle
                    .watchdog
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                let joined = handle.is_some_and(|handle| handle.join().is_ok());
                lifecycle.watchdog_joined.store(joined, Ordering::SeqCst);
                if !joined {
                    lifecycle.request(Cause::DriverFailed);
                }
                let cause = Cause::from_code(lifecycle.requested.load(Ordering::SeqCst))
                    .unwrap_or(Cause::DriverFailed);
                lifecycle.shutdown(cause, exit);
            })
            .map_err(|_| error("acceptance_finish_failed"))?;
        *self
            .exit_dispatcher
            .lock()
            .map_err(|_| error("acceptance_finish_failed"))? = Some(dispatcher);
        Ok(())
    }
    fn heartbeat_counter(&self) -> Option<u64> {
        let path = self.root.join("launcher-heartbeat.json");
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 {
            return None;
        }
        let raw = super::read_regular(&path, 1024).ok()?;
        let value = parser::raw_json(&raw, 1024).ok()?;
        parser::exact(
            &value,
            &["schemaVersion", "sessionId", "buildId", "counter"],
        )
        .ok()?;
        let heartbeat: Heartbeat = serde_json::from_value(value).ok()?;
        if heartbeat.schema_version != 1
            || heartbeat.session_id != self.session_id
            || heartbeat.build_id != self.build_id
        {
            return None;
        }
        parser::counter(&heartbeat.counter).ok()
    }
    fn poll_heartbeat(self: &Arc<Self>) -> Option<u64> {
        let mut slot = self
            .heartbeat_read
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some((started, handle)) = slot.as_ref() {
            if Instant::now().duration_since(*started) >= HEARTBEAT_READ_DEADLINE {
                self.request(Cause::HeartbeatLost);
                if handle.is_finished() {
                    if let Some((_, handle)) = slot.take() {
                        let _ = handle.join();
                    }
                }
                return None; // A late read is not a fresh launcher heartbeat.
            }
            if !handle.is_finished() {
                return None; // Retain the actual handle; never block watchdog on filesystem I/O.
            }
            if let Some((_, handle)) = slot.take() {
                return handle.join().ok().flatten();
            }
        }
        let lifecycle = self.clone();
        match thread::Builder::new()
            .name("acceptance-native-heartbeat-read".into())
            .spawn(move || lifecycle.heartbeat_counter())
        {
            Ok(handle) => *slot = Some((Instant::now(), handle)),
            Err(_) => {
                self.request(Cause::HeartbeatLost);
            }
        }
        None
    }
    fn watch(self: Arc<Self>, receiver: Receiver<()>) {
        let started = Instant::now();
        let mut progress_at = started;
        let mut progress = self.controls.activity_revision();
        let mut heartbeat_at = None;
        let mut heartbeat_counter = None;
        let mut heartbeat_read_at = started;
        loop {
            if self.controls.driver_failed_native() {
                self.request(Cause::DriverFailed);
            }
            if self.requested.load(Ordering::SeqCst) != 0 {
                break;
            }
            let now = Instant::now();
            let current = self.controls.activity_revision();
            if current > progress {
                progress = current;
                progress_at = now;
            }
            if now >= heartbeat_read_at {
                if let Some(counter) = self.poll_heartbeat() {
                    if heartbeat_counter.is_none_or(|prior| counter > prior) {
                        heartbeat_counter = Some(counter);
                        heartbeat_at = Some(now);
                    }
                }
                heartbeat_read_at = now + Duration::from_secs(1);
            }
            if now.duration_since(started) >= GLOBAL_DEADLINE {
                self.request(Cause::GlobalDeadline);
            } else if now.duration_since(progress_at) >= IDLE_DEADLINE {
                self.request(Cause::IdleDeadline);
            } else if heartbeat_at.is_some_and(|at| now.duration_since(at) >= HEARTBEAT_LOSS)
                || (heartbeat_at.is_none() && now.duration_since(started) >= HEARTBEAT_GRACE)
            {
                self.request(Cause::HeartbeatLost);
            }
            let _ = receiver.recv_timeout(TICK);
        }
        // The exit dispatcher joins this actual thread before cleanup certification.
    }
    fn collect(self: &Arc<Self>, facts: &Arc<Mutex<Facts>>, deadline: Instant) {
        // No UI/event-loop thread, sink mutex or analysis worker performs these waits.
        // Atomic control closure cannot wait on its diagnostic/file sink. Any
        // already-admitted control effect is an original task and must settle.
        let private_closed = self.controls.close_private_controls().is_ok();
        let capture = self.recovery.close_admission_capture(|| {
            self.tasks.close();
            self.auxiliary.close_admission();
        });
        {
            let mut observed = facts.lock().unwrap_or_else(|e| e.into_inner());
            observed.admission_closed = Some(true);
            observed.private_controls_closed = Some(private_closed);
            observed.captured_owner = capture.owner.as_ref().map(|run| CapturedOwner {
                origin: run.origin.clone(),
                journal_id: run.journal_id.clone(),
                binding: run.binding.clone(),
                header_digest: None, // No manufactured header when admission SQL is preparing/unknown.
                preparing: run.preparing.load(Ordering::SeqCst),
                start_claimed: run.start_claimed.load(Ordering::SeqCst),
            });
        }
        // Fan-out is unnecessary at MAX_OWNERS=8; every owner receives the same
        // remaining deadline and the original cleanup_all witness is retained.
        let auxiliary_deadline = (Instant::now() + Duration::from_secs(8)).min(deadline);
        let aux = self.auxiliary.cleanup_all(auxiliary_deadline).is_ok();
        {
            let mut observed = facts.lock().unwrap_or_else(|e| e.into_inner());
            observed.auxiliary_initial_cleanup_confirmed = Some(aux);
            observed.auxiliary_cleanup_confirmed = Some(aux);
        }
        if Instant::now() >= deadline {
            return;
        }
        if let Some(run) = &capture.owner {
            // The exact captured Arc survives refresh/removal. Never select a
            // successor or invent a retry revision after any unknown outcome.
            let packet = serde_json::to_string(&StopRequest {
                recovery_protocol_version: 1,
                request_id: format!("shutdown:{}", self.session_id),
                origin: run.origin.clone(),
                journal_id: run.journal_id.clone(),
                mode: "stop".into(),
                expected_control_revision: None,
            })
            .ok()
            .and_then(|raw| parser::parse::<StopRequest>(&raw).ok());
            if let Some(packet) = packet {
                if let Err(error) = self.recovery.stop(packet.clone(), self.wake.clone()) {
                    facts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .stop_call_error_code = Some(error.code);
                }
                let joined = self.tasks.drain(deadline);
                facts.lock().unwrap_or_else(|e| e.into_inner()).native_tasks = Some(joined);
                if Instant::now() >= deadline {
                    return;
                }
                if let Ok(backend) = self.recovery.backend() {
                    if let Ok(query) = backend.query_control(&packet) {
                        let mut observed = facts.lock().unwrap_or_else(|e| e.into_inner());
                        observed.stop_query_available = true;
                        observed.stop_receipt = query.receipt;
                        observed.stop_rejection_code = query.rejection.map(|error| error.code);
                    }
                    if let Ok(attachment) = backend.attachment_current(&run.journal_id) {
                        if let Some(header) = attachment.header.filter(|header| {
                            header.origin == run.origin
                                && header.binding == run.binding
                                && header.journal_id == run.journal_id
                        }) {
                            if let Some(owner) = facts
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .captured_owner
                                .as_mut()
                            {
                                owner.header_digest = Some(header.header_digest);
                            }
                        }
                    }
                    if let Ok(current) = backend.current(&run.journal_id) {
                        let mut observed = facts.lock().unwrap_or_else(|e| e.into_inner());
                        observed.current_sql_available = true;
                        observed.journal = current.journal.filter(|journal| {
                            journal.origin == run.origin
                                && journal.binding == run.binding
                                && journal.journal_id == run.journal_id
                        });
                    }
                }
            }
            let writer_available = run.writer.try_lock().is_ok();
            facts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .writer_mutex_available = Some(writer_available);
        }
        if facts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .native_tasks
            .is_none()
        {
            let joined = self.tasks.drain(deadline);
            facts.lock().unwrap_or_else(|e| e.into_inner()).native_tasks = Some(joined);
        }
        // A final witness after joining all admitted callers cannot race a late
        // auxiliary prepare/reader. This is the same closed original pool and
        // handles; no new run, purpose supersession or SQL revision is created.
        if facts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .native_tasks
            .as_ref()
            .is_some_and(|tasks| tasks.pending == 0 && tasks.accepted == tasks.joined)
        {
            let final_aux = self.auxiliary.cleanup_all(deadline).is_ok();
            facts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .auxiliary_cleanup_confirmed = Some(final_aux);
        }
        // After the watchdog joined, no future heartbeat reader can be started.
        let heartbeat = self
            .heartbeat_read
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let heartbeat_joined = match heartbeat {
            None => true,
            Some((started, handle)) => {
                while !handle.is_finished() && Instant::now() < deadline {
                    thread::park_timeout(
                        TICK.min(deadline.saturating_duration_since(Instant::now())),
                    );
                }
                if handle.is_finished() {
                    handle.join().is_ok()
                } else {
                    *self
                        .heartbeat_read
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some((started, handle));
                    false
                }
            }
        };
        facts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .heartbeat_worker_joined = heartbeat_joined;
        facts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .captured_registry_owner_retained = Some(
            capture
                .ownership
                .as_ref()
                .is_some_and(|owner| owner.retained()),
        );
        if let Ok(snapshot) = self.recovery.snapshot() {
            let mut observed = facts.lock().unwrap_or_else(|e| e.into_inner());
            observed.runtime_initialization = Some(snapshot.runtime.initialization);
            observed.runtime_gate = Some(snapshot.runtime.runtime_gate);
            observed.journal_gate = Some(snapshot.runtime.journal_gate);
            observed.runtime_owner_present = Some(snapshot.runtime.owner.is_some());
            observed.blocker_count =
                Some(snapshot.runtime.blockers.len() + snapshot.clear_blockers.len());
            observed.snapshot_coherent = Some(snapshot.coherent);
            observed.journal_count = Some(snapshot.journals.len());
            observed.unsettled_journal_count = Some(
                snapshot
                    .journals
                    .iter()
                    .filter(|journal| {
                        journal.cleanup_state != "confirmed"
                            || journal.sealed_through_seq.as_ref() != Some(&journal.applied_seq)
                    })
                    .count(),
            );
        }
    }
    fn shutdown(self: &Arc<Self>, cause: Cause, exit: Arc<dyn Fn(i32) + Send + Sync>) {
        let deadline = Instant::now() + CLEANUP_DEADLINE;
        let facts = Arc::new(Mutex::new(Facts::default()));
        let lifecycle = self.clone();
        let work_facts = facts.clone();
        let handle = thread::Builder::new()
            .name("acceptance-native-cleanup".into())
            .spawn(move || lifecycle.collect(&work_facts, deadline));
        let mut joined = false;
        if let Ok(handle) = handle {
            while !handle.is_finished() && Instant::now() < deadline {
                // Bounded readiness observation, never an assumed IPC ACK or self-join.
                thread::park_timeout(TICK.min(deadline.saturating_duration_since(Instant::now())));
            }
            if handle.is_finished() {
                joined = handle.join().is_ok();
            } else {
                *self
                    .pending_cleanup
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(handle);
            }
        }
        let observed = facts.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let failed = self.failure_observed.load(Ordering::SeqCst);
        let watchdog_joined = self.watchdog_joined.load(Ordering::SeqCst);
        let eligible = watchdog_joined && cleanup_gate(&observed, joined);
        let passed = eligible && !failed && matches!(cause, Cause::DriverComplete);
        let record = FinalRecord {
            schema_version: 1,
            record_kind: "native_shutdown",
            session_id: &self.session_id,
            build_id: &self.build_id,
            first_cause: cause,
            failure_observed: failed,
            status: if passed { "completed" } else { "failed" },
            error_code: if !eligible {
                Some("acceptance_lifecycle_incomplete")
            } else if !passed {
                Some("acceptance_driver_failed")
            } else {
                None
            },
            cleanup_worker_joined: joined,
            watchdog_worker_joined: watchdog_joined,
            exit_dispatcher_is_current_thread: true,
            facts: &observed,
            native_exit_eligible: eligible,
            // Serialization precedes this file writer's actual join. A late
            // file after timeout cannot fabricate a native authorization.
            native_exit_authorized: false,
            record_writer_join_required: true,
        };
        // Independent create-new bounded record: driver sink quotas cannot erase
        // cleanup evidence. Filesystem failure also denies exit; no retry success.
        if self.write_final(&record).is_ok() {
            if let Some(code) = self.commit_exit_after_writer_join(
                eligible,
                passed,
                #[cfg(test)]
                None,
            ) {
                exit(code);
            }
        }
    }
    fn commit_exit_after_writer_join(
        &self,
        eligible: bool,
        record_passed: bool,
        #[cfg(test)] probe: Option<&ExitCommitProbe>,
    ) -> Option<i32> {
        let _decision = self.exit_decision.lock().unwrap_or_else(|e| e.into_inner());
        if !eligible || self.exit_authorized.load(Ordering::SeqCst) {
            return None;
        }
        let failed = self.failure_observed.load(Ordering::SeqCst);
        #[cfg(test)]
        if let Some(probe) = probe {
            if probe.observed.send(()).is_err() || probe.release.recv().is_err() {
                return None;
            }
        }
        // A failure accepted while the writer ran cannot authorize success from
        // an earlier completed record. That file remains a historical snapshot;
        // exit1 fails the launcher's required original-App exit0 conjunction.
        let code = if record_passed && !failed { 0 } else { 1 };
        self.exit_code.store(code, Ordering::SeqCst);
        self.exit_authorized.store(true, Ordering::SeqCst);
        Some(code)
    }
    fn write_final(&self, record: &FinalRecord<'_>) -> Result<(), AcceptanceError> {
        let mut bytes =
            serde_json::to_vec(record).map_err(|_| error("acceptance_finish_failed"))?;
        bytes.push(b'\n');
        if bytes.len() > FINAL_BYTES {
            return Err(error("acceptance_finish_failed"));
        }
        let root = self.root.clone();
        let handle = thread::Builder::new()
            .name("acceptance-native-final-record".into())
            .spawn(move || -> std::io::Result<()> {
                let metadata = fs::symlink_metadata(&root)?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(std::io::Error::other(
                        "owned final record directory invalid",
                    ));
                }
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(root.join("native-shutdown.json"))?;
                file.write_all(&bytes)?;
                file.sync_all()
            })
            .map_err(|_| error("acceptance_finish_failed"))?;
        let deadline = Instant::now() + FINAL_WRITE_DEADLINE;
        while !handle.is_finished() && Instant::now() < deadline {
            thread::park_timeout(TICK.min(deadline.saturating_duration_since(Instant::now())));
        }
        if !handle.is_finished() {
            *self
                .pending_record
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(handle);
            return Err(error("acceptance_finish_failed"));
        }
        match handle.join() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) | Err(_) => Err(error("acceptance_finish_failed")),
        }
    }
}
fn cleanup_gate(facts: &Facts, joined: bool) -> bool {
    facts.native_tasks.as_ref().is_some_and(|tasks| {
        tasks.closed && tasks.pending == 0 && tasks.accepted == tasks.joined && !tasks.panicked
    }) && facts.heartbeat_worker_joined
        && joined
        && facts.admission_closed == Some(true)
        && facts.private_controls_closed == Some(true)
        && facts.auxiliary_cleanup_confirmed == Some(true)
        && facts.captured_registry_owner_retained == Some(false)
        && facts.runtime_initialization.as_deref() == Some("ready")
        && facts.runtime_gate.as_deref() == Some("vacant")
        && facts.journal_gate.as_deref() == Some("ready")
        && facts.runtime_owner_present == Some(false)
        && facts.blocker_count == Some(0)
        && facts.snapshot_coherent == Some(true)
        && facts.unsettled_journal_count == Some(0)
        && (facts.captured_owner.is_none()
            || (facts
                .captured_owner
                .as_ref()
                .is_some_and(|owner| owner.header_digest.is_some())
                && facts.stop_call_error_code.is_none()
                && facts.stop_rejection_code.is_none()
                && facts.stop_query_available
                && facts.current_sql_available
                && facts.stop_receipt.as_ref().is_some_and(|receipt| {
                    receipt.sql_committed && receipt.outcome == "cleanup_confirmed"
                })
                && facts.journal.as_ref().is_some_and(|journal| {
                    journal.cleanup_state == "confirmed"
                        && journal.sealed_through_seq.as_ref() == Some(&journal.applied_seq)
                })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_native_facts_cannot_authorize_exit() {
        assert!(!cleanup_gate(&Facts::default(), true));
    }
    #[test]
    fn runtime_vacancy_and_auxiliary_success_cannot_certify_unjoined_publishers() {
        let facts = Facts {
            admission_closed: Some(true),
            private_controls_closed: Some(true),
            auxiliary_cleanup_confirmed: Some(true),
            captured_registry_owner_retained: Some(false),
            runtime_initialization: Some("ready".into()),
            runtime_gate: Some("vacant".into()),
            journal_gate: Some("ready".into()),
            runtime_owner_present: Some(false),
            blocker_count: Some(0),
            writer_mutex_available: Some(true),
            ..Facts::default()
        };
        assert!(!cleanup_gate(&facts, true));
    }
    fn confirmed_empty_cut() -> Facts {
        Facts {
            admission_closed: Some(true),
            private_controls_closed: Some(true),
            auxiliary_cleanup_confirmed: Some(true),
            captured_registry_owner_retained: Some(false),
            runtime_initialization: Some("ready".into()),
            runtime_gate: Some("vacant".into()),
            journal_gate: Some("ready".into()),
            runtime_owner_present: Some(false),
            blocker_count: Some(0),
            snapshot_coherent: Some(true),
            journal_count: Some(0),
            unsettled_journal_count: Some(0),
            native_tasks: Some(TaskFacts {
                closed: true,
                accepted: 7,
                joined: 7,
                pending: 0,
                panicked: false,
            }),
            heartbeat_worker_joined: true,
            ..Facts::default()
        }
    }
    #[test]
    fn actual_closed_drained_joined_cut_can_be_exit_eligible() {
        assert!(cleanup_gate(&confirmed_empty_cut(), true));
    }
    #[test]
    fn window_close_while_accepted_save_is_pending_cannot_authorize_exit() {
        let mut facts = confirmed_empty_cut();
        let tasks = facts.native_tasks.as_mut().unwrap();
        tasks.joined -= 1;
        tasks.pending = 1;
        assert!(!cleanup_gate(&facts, true));
    }
    #[test]
    fn actual_join_error_or_missing_heartbeat_join_denies_exit() {
        let mut facts = confirmed_empty_cut();
        facts.native_tasks.as_mut().unwrap().panicked = true;
        assert!(!cleanup_gate(&facts, true));
        let mut facts = confirmed_empty_cut();
        facts.heartbeat_worker_joined = false;
        assert!(!cleanup_gate(&facts, true));
        assert!(!cleanup_gate(&confirmed_empty_cut(), false));
    }
    #[test]
    fn unknown_sql_gate_or_retained_exact_owner_denies_exit() {
        let mut facts = confirmed_empty_cut();
        facts.journal_gate = Some("unknown".into());
        assert!(!cleanup_gate(&facts, true));
        let mut facts = confirmed_empty_cut();
        facts.captured_registry_owner_retained = Some(true);
        assert!(!cleanup_gate(&facts, true));
        let mut facts = confirmed_empty_cut();
        facts.unsettled_journal_count = Some(1);
        assert!(!cleanup_gate(&facts, true));
        let mut facts = confirmed_empty_cut();
        facts.snapshot_coherent = None;
        assert!(!cleanup_gate(&facts, true));
    }
    #[test]
    fn serialized_record_cannot_claim_its_own_future_writer_join() {
        let facts = confirmed_empty_cut();
        let record = FinalRecord {
            schema_version: 1,
            record_kind: "native_shutdown",
            session_id: "session",
            build_id: "build",
            first_cause: Cause::DriverComplete,
            failure_observed: false,
            status: "completed",
            error_code: None,
            cleanup_worker_joined: true,
            watchdog_worker_joined: true,
            exit_dispatcher_is_current_thread: true,
            facts: &facts,
            native_exit_eligible: true,
            native_exit_authorized: false,
            record_writer_join_required: true,
        };
        let value = serde_json::to_value(record).unwrap();
        assert_eq!(value["nativeExitEligible"], true);
        assert_eq!(value["nativeExitAuthorized"], false);
        assert_eq!(value["recordWriterJoinRequired"], true);
    }
    #[test]
    fn all_trigger_codes_preserve_their_fixed_cause() {
        for cause in [
            Cause::DriverComplete,
            Cause::DriverFailed,
            Cause::WindowClose,
            Cause::ExitRequested,
            Cause::GlobalDeadline,
            Cause::IdleDeadline,
            Cause::HeartbeatLost,
        ] {
            assert_eq!(Cause::from_code(cause.code()).unwrap().code(), cause.code());
        }
        assert!(Cause::from_code(0).is_none());
    }
    // Decision-gate regressions only. No cleanup, file writer, App, shared task
    // registry or real fixture is started; actual writer/App tests remain open.
    fn decision_lifecycle() -> Arc<NativeLifecycle> {
        let root = PathBuf::from("fictional-unused-decision-root");
        NativeLifecycle::new(
            LifecycleIdentity {
                root: root.clone(),
                session_id: "fictional-session".into(),
                build_id: "fictional-build".into(),
            },
            Arc::new(Coordinator::new(Arc::new(
                crate::analysis_execution::Registry::default(),
            ))),
            Arc::new(Supervisor::default()),
            Arc::new(ControlState::new(
                root,
                "fictional-session".into(),
                "fictional-build".into(),
            )),
            Arc::new(|_| {}),
            Arc::new(NativeTasks::default()),
        )
    }
    fn join_decision_worker<T>(handle: JoinHandle<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !handle.is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(
            handle.is_finished(),
            "decision worker did not reach known-finished state"
        );
        handle
            .join()
            .unwrap_or_else(|_| panic!("decision worker panicked"))
    }
    #[test]
    fn accepted_failure_during_record_writer_interval_cannot_commit_success() {
        let lifecycle = decision_lifecycle();
        assert_eq!(
            lifecycle.request(Cause::DriverComplete),
            RequestDisposition::Accepted
        );
        let (prepared, ready) = mpsc::channel();
        let (release, waiting) = mpsc::channel();
        let committing = lifecycle.clone();
        let worker = thread::spawn(move || {
            prepared.send(()).unwrap();
            // This channel models only the decision's external writer interval.
            // Drop of the sender on a panic aborts it without blocked helpers.
            if waiting.recv().is_err() {
                return None;
            }
            committing.commit_exit_after_writer_join(true, true, None)
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            lifecycle.request(Cause::WindowClose),
            RequestDisposition::Accepted
        );
        assert!(lifecycle.failure_observed.load(Ordering::SeqCst));
        release.send(()).unwrap();
        assert_eq!(join_decision_worker(worker), Some(1));
        assert_eq!(lifecycle.authorized_exit_code(), Some(1));
        assert!(matches!(
            Cause::from_code(lifecycle.requested.load(Ordering::SeqCst)),
            Some(Cause::DriverComplete)
        ));
    }
    #[test]
    fn event_after_committed_exit_is_explicitly_finalized_not_accepted_failure() {
        let lifecycle = decision_lifecycle();
        assert_eq!(
            lifecycle.request(Cause::DriverComplete),
            RequestDisposition::Accepted
        );
        assert_eq!(
            lifecycle.commit_exit_after_writer_join(true, true, None),
            Some(0)
        );
        assert_eq!(
            lifecycle.request(Cause::ExitRequested),
            RequestDisposition::AlreadyFinalized
        );
        assert!(!lifecycle.failure_observed.load(Ordering::SeqCst));
        assert_eq!(lifecycle.authorized_exit_code(), Some(0));
        assert_eq!(
            lifecycle.commit_exit_after_writer_join(true, true, None),
            None
        );
    }
    #[test]
    fn actual_commit_gate_excludes_request_between_failure_read_and_authorization() {
        let lifecycle = decision_lifecycle();
        assert_eq!(
            lifecycle.request(Cause::DriverComplete),
            RequestDisposition::Accepted
        );
        let (observed, reached) = mpsc::channel();
        let (release, waiting) = mpsc::channel();
        let committing = lifecycle.clone();
        let commit = thread::spawn(move || {
            let probe = ExitCommitProbe {
                observed,
                release: waiting,
            };
            committing.commit_exit_after_writer_join(true, true, Some(&probe))
        });
        reached.recv_timeout(Duration::from_secs(2)).unwrap();
        // The real production decision function holds the same actual mutex
        // across its failure observation and authorization, not only a recheck.
        assert!(matches!(
            lifecycle.exit_decision.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        let (attempting, attempt) = mpsc::channel();
        let requesting = lifecycle.clone();
        let request = thread::spawn(move || {
            attempting.send(()).unwrap();
            requesting.request(Cause::ExitRequested)
        });
        attempt.recv_timeout(Duration::from_secs(2)).unwrap();
        release.send(()).unwrap();
        assert_eq!(join_decision_worker(commit), Some(0));
        assert_eq!(
            join_decision_worker(request),
            RequestDisposition::AlreadyFinalized
        );
        assert!(!lifecycle.failure_observed.load(Ordering::SeqCst));
        assert_eq!(lifecycle.authorized_exit_code(), Some(0));
    }
    #[test]
    fn unknown_cleanup_eligibility_keeps_actual_exit_decision_open_and_unauthorized() {
        let lifecycle = decision_lifecycle();
        assert_eq!(
            lifecycle.request(Cause::DriverComplete),
            RequestDisposition::Accepted
        );
        assert_eq!(
            lifecycle.commit_exit_after_writer_join(false, true, None),
            None
        );
        assert!(!lifecycle.exit_authorized());
        assert_eq!(
            lifecycle.request(Cause::WindowClose),
            RequestDisposition::Accepted
        );
        assert!(lifecycle.failure_observed.load(Ordering::SeqCst));
    }
}
