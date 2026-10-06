//! Feature-only, main-window controls. No caller paths or research body sink.
use super::{
    driver::{
        self, DriverReply, DriverReport, FinishHook, FinishReason, FinishReply, FinishRequest,
        TaskSlot, Verdict,
    },
    ensure, error, sha256, strict, AcceptanceError,
};
use crate::analysis_recovery::{
    parser,
    runtime::{Coordinator, Session},
    wire::{ReadRequest, RunBinding, RunIdentity, RuntimeObservation},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, Runtime};
const INPUT_LIMIT: usize = 8 * 1024;
const LINE_LIMIT: usize = 4 * 1024;
const RECORD_LIMIT: usize = 128;
const TOTAL_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerWitness {
    pub origin: RunIdentity,
    pub journal_id: String,
    pub binding: RunBinding,
    pub header_digest: String,
    pub release_nonce: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointRequest {
    schema_version: u8,
    session_id: String,
    request_id: String,
    checkpoint: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseRequest {
    schema_version: u8,
    session_id: String,
    request_id: String,
    origin: RunIdentity,
    journal_id: String,
    binding: RunBinding,
    header_digest: String,
    release_nonce: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlReply {
    schema_version: u8,
    session_id: String,
    request_id: String,
    status: String,
    worker: Option<WorkerWitness>,
    worker_started: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SinkRecord<'a> {
    schema_version: u8,
    session_id: &'a str,
    build_id: &'a str,
    request_id: &'a str,
    status: &'a str,
    worker: Option<&'a WorkerWitness>,
    worker_started: bool,
}
#[derive(Clone)]
enum RetainedReply {
    Control(ControlReply),
    Driver(Result<DriverReply, AcceptanceError>),
    Finish(Result<FinishReply, AcceptanceError>),
}
impl RetainedReply {
    fn control(self) -> Result<ControlReply, AcceptanceError> {
        match self {
            Self::Control(reply) => Ok(reply),
            _ => Err(error("acceptance_control_invalid")),
        }
    }
    fn driver(self) -> Result<DriverReply, AcceptanceError> {
        match self {
            Self::Driver(reply) => reply,
            _ => Err(error("acceptance_control_invalid")),
        }
    }
    fn finish(self) -> Result<FinishReply, AcceptanceError> {
        match self {
            Self::Finish(reply) => reply,
            _ => Err(error("acceptance_control_invalid")),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverSinkRecord<'a> {
    schema_version: u8,
    record_kind: &'static str,
    attestation: &'a DriverReport,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishSinkRecord<'a> {
    schema_version: u8,
    record_kind: &'static str,
    request: &'a FinishRequest,
    native_hook_state: &'static str,
    private_controls_closed: bool,
    admission_state: &'static str,
    cleanup_state: &'static str,
    native_exit_authorized: bool,
}
fn request_digest(command: &str, raw: &str) -> String {
    sha256(format!("{command}\0{raw}").as_bytes())
}
#[derive(Default)]
struct State {
    workers: HashMap<String, WorkerWitness>,
    outcomes: HashMap<String, (String, RetainedReply)>,
    driver_tasks: HashMap<TaskSlot, String>,
    driver_realms: HashSet<String>,
    last_driver_report: Option<DriverReport>,
    driver_failed: bool,
    finish_request: Option<FinishRequest>,
    #[cfg(test)]
    readonly_report_sink_once: bool,
    records: usize,
    bytes: usize,
}
struct PreparedSink {
    file: fs::File,
    line: Vec<u8>,
}
struct OwnedGateTemporary(Option<PathBuf>);
impl Drop for OwnedGateTemporary {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}
pub(crate) struct ControlState {
    root: PathBuf,
    session_id: String,
    build_id: String,
    state: Mutex<State>,
    activity_revision: AtomicU64,
    native_closed: AtomicBool,
    driver_failed_native: AtomicBool,
}
impl ControlState {
    pub(crate) fn new(root: PathBuf, session_id: String, build_id: String) -> Self {
        Self {
            root,
            session_id,
            build_id,
            state: Mutex::new(State::default()),
            activity_revision: AtomicU64::new(0),
            native_closed: AtomicBool::new(false),
            driver_failed_native: AtomicBool::new(false),
        }
    }
    pub(crate) fn driver_failed_native(&self) -> bool {
        self.driver_failed_native.load(Ordering::SeqCst)
    }
    pub(crate) fn activity_revision(&self) -> u64 {
        self.activity_revision.load(Ordering::SeqCst)
    }
    /// Native failure/window/watchdog closure cannot depend on the report budget.
    pub(crate) fn close_private_controls(&self) -> Result<(), AcceptanceError> {
        // Atomic latch never waits on driver sink I/O. Already-admitted effects
        // remain original NativeTasks and are joined before any exit certificate.
        self.native_closed.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn register(
        &self,
        coordinator: &Coordinator,
        run: &Session,
        command: &mut Command,
    ) -> Result<(), AcceptanceError> {
        let read = coordinator
            .backend()
            .map_err(|_| error("acceptance_control_invalid"))?
            .read(&ReadRequest {
                recovery_protocol_version: 1,
                journal_id: run.journal_id.clone(),
                origin: run.origin.clone(),
                binding: run.binding.clone(),
                after_seq: "0".into(),
                through_seq: Some("1".into()),
                limit: 1,
            })
            .map_err(|_| error("acceptance_control_invalid"))?;
        let witness = self.register_identity(
            &coordinator.observe(),
            run.origin.clone(),
            run.journal_id.clone(),
            run.binding.clone(),
            read.header.header_digest,
        )?;
        command
            .env("EVIDENCELOOM_ACCEPTANCE_CONTROL_ROOT", &self.root)
            .env("EVIDENCELOOM_ACCEPTANCE_SESSION_ID", &self.session_id)
            .env(
                "EVIDENCELOOM_ACCEPTANCE_RELEASE_NONCE",
                &witness.release_nonce,
            );
        Ok(())
    }
    pub(super) fn register_identity(
        &self,
        observation: &RuntimeObservation,
        origin: RunIdentity,
        journal_id: String,
        binding: RunBinding,
        header_digest: String,
    ) -> Result<WorkerWitness, AcceptanceError> {
        ensure(
            parser::binding(&binding, &origin).is_ok()
                && parser::hex(&header_digest)
                && !journal_id.is_empty()
                && journal_id.len() <= 128,
            "acceptance_control_invalid",
        )?;
        let owner = observation
            .owner
            .as_ref()
            .ok_or_else(|| error("acceptance_control_invalid"))?;
        ensure(
            owner.origin == origin && owner.binding == binding && owner.journal_id == journal_id,
            "acceptance_control_invalid",
        )?;
        let nonce = sha256(
            serde_json::to_string(&serde_json::json!([
                self.session_id,
                origin,
                journal_id,
                binding,
                header_digest
            ]))
            .map_err(|_| error("acceptance_control_invalid"))?
            .as_bytes(),
        );
        let witness = WorkerWitness {
            origin,
            journal_id,
            binding,
            header_digest,
            release_nonce: nonce,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("acceptance_control_invalid"))?;
        ensure(
            state.finish_request.is_none() && !self.native_closed.load(Ordering::SeqCst),
            "acceptance_control_invalid",
        )?;
        if let Some(prior) = state.workers.get(&witness.journal_id) {
            ensure(prior == &witness, "acceptance_control_invalid")?;
            return Ok(prior.clone());
        }
        ensure(state.workers.len() < 4, "acceptance_control_invalid")?;
        state
            .workers
            .insert(witness.journal_id.clone(), witness.clone());
        Ok(witness)
    }
    fn valid_request(
        &self,
        version: u8,
        session: &str,
        request: &str,
    ) -> Result<(), AcceptanceError> {
        ensure(
            version == 1
                && session == self.session_id
                && !request.is_empty()
                && request.len() <= 96
                && request
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b)),
            "acceptance_control_invalid",
        )
    }
    fn active_worker(
        &self,
        observation: &RuntimeObservation,
        state: &State,
    ) -> Result<Option<WorkerWitness>, AcceptanceError> {
        let Some(owner) = observation.owner.as_ref() else {
            return Ok(None);
        };
        Ok(state
            .workers
            .get(&owner.journal_id)
            .filter(|worker| worker.origin == owner.origin && worker.binding == owner.binding)
            .cloned())
    }
    fn worker_started(&self, worker: &WorkerWitness) -> Result<bool, AcceptanceError> {
        let path = self
            .root
            .join(format!("{}.started.json", worker.release_nonce));
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(error("acceptance_control_invalid")),
            Ok(meta) => {
                ensure(
                    meta.is_file()
                        && !meta.file_type().is_symlink()
                        && meta.len() <= LINE_LIMIT as u64,
                    "acceptance_control_invalid",
                )?;
                let raw = super::read_regular(&path, LINE_LIMIT)?;
                let value: serde_json::Value =
                    strict(&raw, LINE_LIMIT, "acceptance_control_invalid")?;
                ensure(
                    value
                        == serde_json::json!({"schemaVersion":1,"sessionId":self.session_id,"releaseNonce":worker.release_nonce,"status":"worker_started"}),
                    "acceptance_control_invalid",
                )?;
                Ok(true)
            }
        }
    }
    fn prepare_sink(
        &self,
        state: &State,
        request: &str,
        reply: &ControlReply,
    ) -> Result<PreparedSink, AcceptanceError> {
        let line = serde_json::to_vec(&SinkRecord {
            schema_version: 1,
            session_id: &self.session_id,
            build_id: &self.build_id,
            request_id: request,
            status: &reply.status,
            worker: reply.worker.as_ref(),
            worker_started: reply.worker_started,
        })
        .map_err(|_| error("acceptance_control_invalid"))?;
        self.prepare_line(state, line, false)
    }
    fn prepare_line(
        &self,
        state: &State,
        mut line: Vec<u8>,
        terminal: bool,
    ) -> Result<PreparedSink, AcceptanceError> {
        line.push(b'\n');
        // One final outcome/line is reserved: diagnostic exhaustion must never
        // prevent the first finish latch or its native lifecycle request.
        let record_limit = if terminal {
            RECORD_LIMIT
        } else {
            RECORD_LIMIT - 1
        };
        let byte_limit = if terminal {
            TOTAL_LIMIT
        } else {
            TOTAL_LIMIT - LINE_LIMIT
        };
        ensure(
            line.len() <= LINE_LIMIT
                && state.records < record_limit
                && state.bytes + line.len() <= byte_limit
                && (terminal || state.outcomes.len() < RECORD_LIMIT - 1),
            "acceptance_control_invalid",
        )?;
        let path = self.root.join("checkpoints.jsonl");
        let file = match fs::symlink_metadata(&path) {
            Ok(meta) => {
                ensure(
                    meta.is_file()
                        && !meta.file_type().is_symlink()
                        && meta.len() == state.bytes as u64,
                    "acceptance_control_invalid",
                )?;
                OpenOptions::new().append(true).open(&path)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ensure(state.bytes == 0, "acceptance_control_invalid")?;
                OpenOptions::new().create_new(true).append(true).open(&path)
            }
            Err(_) => return Err(error("acceptance_control_invalid")),
        }
        .map_err(|_| error("acceptance_control_invalid"))?;
        let metadata = file
            .metadata()
            .map_err(|_| error("acceptance_control_invalid"))?;
        ensure(
            metadata.is_file() && metadata.len() == state.bytes as u64,
            "acceptance_control_invalid",
        )?;
        Ok(PreparedSink { file, line })
    }
    fn retain_prepared(
        &self,
        state: &mut State,
        request: &str,
        digest: String,
        reply: ControlReply,
        mut sink: PreparedSink,
    ) -> Result<ControlReply, AcceptanceError> {
        // A late sink write failure may follow an already published gate. This
        // is deliberately not a durable transaction across these two files.
        sink.file
            .write_all(&sink.line)
            .map_err(|_| error("acceptance_control_invalid"))?;
        self.activity_revision.fetch_add(1, Ordering::SeqCst);
        state.records += 1;
        state.bytes += sink.line.len();
        state.outcomes.insert(
            request.into(),
            (digest, RetainedReply::Control(reply.clone())),
        );
        Ok(reply)
    }
    fn retain(
        &self,
        state: &mut State,
        request: &str,
        digest: String,
        reply: ControlReply,
    ) -> Result<ControlReply, AcceptanceError> {
        let sink = self.prepare_sink(state, request, &reply)?;
        self.retain_prepared(state, request, digest, reply, sink)
    }
    fn publish_release(&self, worker: &WorkerWitness) -> Result<(), AcceptanceError> {
        let gate = self
            .root
            .join(format!("{}.release.json", worker.release_nonce));
        let expected = serde_json::json!({"schemaVersion":1,"sessionId":self.session_id,"releaseNonce":worker.release_nonce,"status":"worker_released"});
        let verify_existing = || {
            ensure(
                strict::<serde_json::Value>(
                    &super::read_regular(&gate, LINE_LIMIT)?,
                    LINE_LIMIT,
                    "acceptance_control_invalid",
                )? == expected,
                "acceptance_control_invalid",
            )
        };
        match fs::symlink_metadata(&gate) {
            Ok(_) => return verify_existing(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("acceptance_control_invalid")),
        }
        let path = self
            .root
            .join(format!("{}.release.pending", worker.release_nonce));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| error("acceptance_control_invalid"))?;
        let mut temporary = OwnedGateTemporary(Some(path.clone()));
        let bytes =
            serde_json::to_vec(&expected).map_err(|_| error("acceptance_control_invalid"))?;
        file.write_all(&bytes)
            .map_err(|_| error("acceptance_control_invalid"))?;
        drop(file);
        // Same-directory hard_link publishes all bytes without overwriting an
        // existing gate. Unsupported filesystems fail closed.
        match fs::hard_link(&path, &gate) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => verify_existing()?,
            Err(_) => return Err(error("acceptance_control_invalid")),
        }
        fs::remove_file(&path).map_err(|_| error("acceptance_control_invalid"))?;
        temporary.0 = None;
        Ok(())
    }
    fn prior(
        &self,
        state: &State,
        request: &str,
        digest: &str,
    ) -> Result<Option<RetainedReply>, AcceptanceError> {
        if let Some((old, reply)) = state.outcomes.get(request) {
            ensure(old == digest, "acceptance_control_invalid")?;
            return Ok(Some(reply.clone()));
        }
        ensure(
            state.outcomes.len() < RECORD_LIMIT,
            "acceptance_control_invalid",
        )?;
        Ok(None)
    }
    pub(super) fn checkpoint(
        &self,
        observation: &RuntimeObservation,
        raw: &str,
    ) -> Result<ControlReply, AcceptanceError> {
        let request: CheckpointRequest = strict(raw, INPUT_LIMIT, "acceptance_control_invalid")?;
        self.valid_request(
            request.schema_version,
            &request.session_id,
            &request.request_id,
        )?;
        ensure(
            [
                "renderer_ready",
                "runtime_ready",
                "owner_observed",
                "projection_saved",
                "stop_confirmed",
                "run_complete",
            ]
            .contains(&request.checkpoint.as_str()),
            "acceptance_control_invalid",
        )?;
        let digest = request_digest("checkpoint", raw);
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("acceptance_control_invalid"))?;
        if let Some(prior) = self.prior(&state, &request.request_id, &digest)? {
            return prior.control();
        }
        ensure(
            state.finish_request.is_none() && !self.native_closed.load(Ordering::SeqCst),
            "acceptance_control_invalid",
        )?;
        ensure(
            request.checkpoint == "renderer_ready"
                || (request.checkpoint == "owner_observed" && observation.owner.is_some())
                || (request.checkpoint == "runtime_ready" && observation.initialization == "ready")
                || (["projection_saved", "stop_confirmed", "run_complete"]
                    .contains(&request.checkpoint.as_str())
                    && observation.runtime_gate == "vacant"
                    && observation.journal_gate == "ready"),
            "acceptance_control_invalid",
        )?;
        let worker = self.active_worker(observation, &state)?;
        let started = worker
            .as_ref()
            .map(|w| self.worker_started(w))
            .transpose()?
            .unwrap_or(false);
        let reply = ControlReply {
            schema_version: 1,
            session_id: self.session_id.clone(),
            request_id: request.request_id.clone(),
            status: request.checkpoint,
            worker,
            worker_started: started,
        };
        self.retain(&mut state, &request.request_id, digest, reply)
    }
    pub(super) fn release(
        &self,
        observation: &RuntimeObservation,
        raw: &str,
    ) -> Result<ControlReply, AcceptanceError> {
        let request: ReleaseRequest = strict(raw, INPUT_LIMIT, "acceptance_control_invalid")?;
        self.valid_request(
            request.schema_version,
            &request.session_id,
            &request.request_id,
        )?;
        let digest = request_digest("release_worker", raw);
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("acceptance_control_invalid"))?;
        // Even historical exact replays must still identify the live owner.
        let worker = self
            .active_worker(observation, &state)?
            .ok_or_else(|| error("acceptance_control_invalid"))?;
        ensure(
            worker.origin == request.origin
                && worker.binding == request.binding
                && worker.journal_id == request.journal_id
                && worker.header_digest == request.header_digest
                && worker.release_nonce == request.release_nonce,
            "acceptance_control_invalid",
        )?;
        if let Some(prior) = self.prior(&state, &request.request_id, &digest)? {
            return prior.control();
        }
        ensure(
            state.finish_request.is_none() && !self.native_closed.load(Ordering::SeqCst),
            "acceptance_control_invalid",
        )?;
        ensure(self.worker_started(&worker)?, "acceptance_control_invalid")?;
        // Open and validate the bounded fixed sink before any gate effect.
        let reply = ControlReply {
            schema_version: 1,
            session_id: self.session_id.clone(),
            request_id: request.request_id.clone(),
            status: "worker_released".into(),
            worker: Some(worker.clone()),
            worker_started: true,
        };
        let sink = self.prepare_sink(&state, &request.request_id, &reply)?;
        self.publish_release(&worker)?;
        self.retain_prepared(&mut state, &request.request_id, digest, reply, sink)
    }
    pub(super) fn report(&self, raw: &str) -> Result<DriverReply, AcceptanceError> {
        let request = driver::parse_report(raw, &self.session_id, &self.build_id)?;
        let digest = request_digest("driver_report", raw);
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("acceptance_control_invalid"))?;
        if let Some(prior) = self.prior(&state, &request.request_id, &digest)? {
            return prior.driver();
        }
        ensure(
            state.finish_request.is_none() && !self.native_closed.load(Ordering::SeqCst),
            "acceptance_control_invalid",
        )?;
        ensure(
            state.driver_realms.contains(&request.realm_nonce) || state.driver_realms.len() < 2,
            "acceptance_control_invalid",
        )?;
        for task in &request.tasks {
            ensure(
                state
                    .driver_tasks
                    .get(&task.slot)
                    .is_none_or(|id| id == &task.task_id)
                    && state
                        .driver_tasks
                        .iter()
                        .all(|(slot, id)| *slot == task.slot || id != &task.task_id),
                "acceptance_control_invalid",
            )?;
        }
        let line = serde_json::to_vec(&DriverSinkRecord {
            schema_version: 1,
            record_kind: "driver_attestation",
            attestation: &request,
        })
        .map_err(|_| error("acceptance_control_invalid"))?;
        let mut sink = self.prepare_line(&state, line, false)?;
        // Reserve the request domain/digest before any sticky failure effect or
        // write. Even a failed/partial append leaves a bounded cached error;
        // ordinary reservation can never consume the one terminal slot.
        state.outcomes.insert(
            request.request_id.clone(),
            (
                digest.clone(),
                RetainedReply::Driver(Err(error("acceptance_control_invalid"))),
            ),
        );
        state.driver_failed |= request.verdict == Verdict::Fail;
        if state.driver_failed {
            self.driver_failed_native.store(true, Ordering::SeqCst);
        }
        #[cfg(test)]
        if state.readonly_report_sink_once {
            state.readonly_report_sink_once = false;
            // Real owned read-only File: write_all returns a real I/O error.
            sink.file = fs::File::open(self.root.join("checkpoints.jsonl"))
                .map_err(|_| error("acceptance_control_invalid"))?;
        }
        sink.file.write_all(&sink.line).map_err(|_| {
            state.driver_failed = true;
            self.driver_failed_native.store(true, Ordering::SeqCst);
            error("acceptance_control_invalid")
        })?;
        let reply = DriverReply {
            schema_version: 1,
            session_id: self.session_id.clone(),
            build_id: self.build_id.clone(),
            request_id: request.request_id.clone(),
            status: "driver_attestation_recorded",
            attestation_only: true,
        };
        self.activity_revision.fetch_add(1, Ordering::SeqCst);
        state.records += 1;
        state.bytes += sink.line.len();
        state.outcomes.insert(
            request.request_id.clone(),
            (digest, RetainedReply::Driver(Ok(reply.clone()))),
        );
        state.driver_realms.insert(request.realm_nonce.clone());
        for task in &request.tasks {
            state.driver_tasks.insert(task.slot, task.task_id.clone());
        }
        state.last_driver_report = Some(request);
        Ok(reply)
    }
    #[cfg(test)]
    pub(super) fn readonly_next_report_sink_for_test(&self) {
        self.state.lock().unwrap().readonly_report_sink_once = true;
    }
    pub(super) fn finish(
        &self,
        raw: &str,
        hook: Option<Arc<FinishHook>>,
    ) -> Result<FinishReply, AcceptanceError> {
        let request = driver::parse_finish(raw, &self.session_id, &self.build_id)?;
        let digest = request_digest("finish_session", raw);
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| error("acceptance_control_invalid"))?;
            if let Some(prior) = self.prior(&state, &request.request_id, &digest)? {
                return prior.finish();
            }
            ensure(
                state.finish_request.is_none() && !self.native_closed.load(Ordering::SeqCst),
                "acceptance_control_invalid",
            )?;
            ensure(
                state.driver_realms.contains(&request.realm_nonce) || state.driver_realms.len() < 2,
                "acceptance_control_invalid",
            )?;
            if request.reason == FinishReason::Complete {
                ensure(
                    !state.driver_failed
                        && state.last_driver_report.as_ref().is_some_and(|r| {
                            r.realm_nonce == request.realm_nonce && driver::complete_attestation(r)
                        }),
                    "acceptance_control_invalid",
                )?;
            }
            // All private effects close before sink I/O. The first request and
            // pending outcome are retained; concurrent/retried finish never
            // invokes the lifecycle hook a second time.
            state.driver_realms.insert(request.realm_nonce.clone());
            state.finish_request = Some(request.clone());
            state.outcomes.insert(
                request.request_id.clone(),
                (
                    digest.clone(),
                    RetainedReply::Finish(Err(error("acceptance_finish_pending"))),
                ),
            );
        }
        let hook_attached = hook.is_some();
        // No sink mutex is held across the AppState lifecycle callback. The
        // concrete future adapter must use the shared production AuxSupervisor.
        let hook_state = match hook {
            None => "unintegrated",
            Some(hook) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                hook(request.reason)
            })) {
                Ok(Ok(())) => "requested",
                Ok(Err(_)) | Err(_) => "failed",
            },
        };
        let reply = FinishReply {
            schema_version: 1,
            session_id: self.session_id.clone(),
            build_id: self.build_id.clone(),
            request_id: request.request_id.clone(),
            status: "finish_requested",
            driver_reason: request.reason,
            private_controls_closed: true,
            native_lifecycle_hook_attached: hook_attached,
            admission_state: "unverified",
            cleanup_state: "unverified",
            native_exit_authorized: false,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("acceptance_control_invalid"))?;
        let retained = (|| {
            let line = serde_json::to_vec(&FinishSinkRecord {
                schema_version: 1,
                record_kind: "finish_request",
                request: &request,
                native_hook_state: hook_state,
                private_controls_closed: true,
                admission_state: "unverified",
                cleanup_state: "unverified",
                native_exit_authorized: false,
            })
            .map_err(|_| error("acceptance_finish_failed"))?;
            let mut sink = self
                .prepare_line(&state, line, true)
                .map_err(|_| error("acceptance_finish_failed"))?;
            sink.file
                .write_all(&sink.line)
                .map_err(|_| error("acceptance_finish_failed"))?;
            self.activity_revision.fetch_add(1, Ordering::SeqCst);
            state.records += 1;
            state.bytes += sink.line.len();
            if hook_state == "failed" {
                Err(error("acceptance_finish_failed"))
            } else {
                Ok(reply)
            }
        })();
        state.outcomes.insert(
            request.request_id,
            (digest, RetainedReply::Finish(retained.clone())),
        );
        retained
    }
}
#[tauri::command]
async fn checkpoint<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    request_json: String,
) -> Result<ControlReply, AcceptanceError> {
    ensure(window.label() == "main", "acceptance_control_invalid")?;
    let controls = app.state::<std::sync::Arc<ControlState>>().inner().clone();
    let coordinator = app.state::<crate::AppState>().recovery.clone();
    super::tasks::spawn_blocking(move || controls.checkpoint(&coordinator.observe(), &request_json))
        .await
        .map_err(|_| error("acceptance_control_invalid"))?
}
#[tauri::command]
async fn release_worker<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    request_json: String,
) -> Result<ControlReply, AcceptanceError> {
    ensure(window.label() == "main", "acceptance_control_invalid")?;
    let controls = app.state::<std::sync::Arc<ControlState>>().inner().clone();
    let coordinator = app.state::<crate::AppState>().recovery.clone();
    super::tasks::spawn_blocking(move || controls.release(&coordinator.observe(), &request_json))
        .await
        .map_err(|_| error("acceptance_control_invalid"))?
}
#[tauri::command]
async fn driver_report<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    request_json: String,
) -> Result<DriverReply, AcceptanceError> {
    ensure(window.label() == "main", "acceptance_control_invalid")?;
    let controls = app.state::<Arc<ControlState>>().inner().clone();
    super::tasks::spawn_blocking(move || controls.report(&request_json))
        .await
        .map_err(|_| error("acceptance_control_invalid"))?
}
#[tauri::command]
async fn finish_session<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    request_json: String,
) -> Result<FinishReply, AcceptanceError> {
    ensure(window.label() == "main", "acceptance_control_invalid")?;
    let controls = app.state::<Arc<ControlState>>().inner().clone();
    let lifecycle = app
        .state::<crate::AppState>()
        .acceptance_lifecycle
        .get()
        .cloned();
    let hook: Option<Arc<FinishHook>> = lifecycle.map(|lifecycle| {
        Arc::new(move |reason| lifecycle.request_driver_finish(reason)) as Arc<FinishHook>
    });
    super::tasks::spawn_blocking(move || controls.finish(&request_json, hook))
        .await
        .map_err(|_| error("acceptance_finish_failed"))?
}

pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("desktop-acceptance")
        .invoke_handler(tauri::generate_handler![
            checkpoint,
            release_worker,
            driver_report,
            finish_session
        ])
        .build()
}
