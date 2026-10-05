//! Feature-only, main-window controls. No caller paths or research body sink.
use super::{ensure, error, sha256, strict, AcceptanceError};
use crate::analysis_recovery::{
    parser,
    runtime::{Coordinator, Session},
    wire::{ReadRequest, RunBinding, RunIdentity, RuntimeObservation},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::Command,
    sync::Mutex,
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
}
#[derive(Default)]
struct State {
    workers: HashMap<String, WorkerWitness>,
    outcomes: HashMap<String, (String, ControlReply)>,
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
}
impl ControlState {
    pub(crate) fn new(root: PathBuf, session_id: String, build_id: String) -> Self {
        Self {
            root,
            session_id,
            build_id,
            state: Mutex::new(State::default()),
        }
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
        if let Some(prior) = state.workers.get(&witness.journal_id) {
            ensure(prior == &witness, "acceptance_control_invalid")?;
            return Ok(prior.clone());
        }
        ensure(
            state.workers.len() < RECORD_LIMIT,
            "acceptance_control_invalid",
        )?;
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
        let mut line = serde_json::to_vec(&SinkRecord {
            schema_version: 1,
            session_id: &self.session_id,
            build_id: &self.build_id,
            request_id: request,
            status: &reply.status,
            worker: reply.worker.as_ref(),
        })
        .map_err(|_| error("acceptance_control_invalid"))?;
        line.push(b'\n');
        ensure(
            line.len() <= LINE_LIMIT
                && state.records < RECORD_LIMIT
                && state.bytes + line.len() <= TOTAL_LIMIT,
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
        state.records += 1;
        state.bytes += sink.line.len();
        state
            .outcomes
            .insert(request.into(), (digest, reply.clone()));
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
    ) -> Result<Option<ControlReply>, AcceptanceError> {
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
        let digest = sha256(raw.as_bytes());
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("acceptance_control_invalid"))?;
        if let Some(prior) = self.prior(&state, &request.request_id, &digest)? {
            return Ok(prior);
        }
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
        let digest = sha256(raw.as_bytes());
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
            return Ok(prior);
        }
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
    tauri::async_runtime::spawn_blocking(move || {
        controls.checkpoint(&coordinator.observe(), &request_json)
    })
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
    tauri::async_runtime::spawn_blocking(move || {
        controls.release(&coordinator.observe(), &request_json)
    })
    .await
    .map_err(|_| error("acceptance_control_invalid"))?
}
pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("desktop-acceptance")
        .invoke_handler(tauri::generate_handler![checkpoint, release_worker])
        .build()
}
