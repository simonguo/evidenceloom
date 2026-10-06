use super::*;
use crate::storage::{self, analysis_journal as sql, task_mutation};
use rusqlite::Connection;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{mpsc, OnceLock},
    thread,
};
const UTC: &str = "2026-10-05T00:00:00.000Z";
static BINARY: OnceLock<PathBuf> = OnceLock::new();
fn fixture_root() -> PathBuf {
    std::env::var_os("EVIDENCELOOM_RECOVERY_FIXTURE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/recovery-fixtures")
        })
}
fn binary() -> &'static PathBuf {
    BINARY.get_or_init(|| {
        let directory = fixture_root().join(format!("compiler-{}", std::process::id()));
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
        fs::write(directory.join("stdout.log"), output.stdout).unwrap();
        fs::write(directory.join("stderr.log"), output.stderr).unwrap();
        assert!(
            output.status.success(),
            "owned fictional runner compilation failed"
        );
        binary
    })
}
struct OwnedBackend {
    conn: Mutex<Connection>,
}
impl OwnedBackend {
    fn new() -> Self {
        #[cfg(feature = "desktop-acceptance")]
        crate::desktop_acceptance::tasks::install_for_command_unit_tests();
        let conn = Connection::open_in_memory().unwrap();
        storage::initialize_analysis_journal_fixture(&conn).unwrap();
        let collection = task_mutation::current(&conn).unwrap().collection;
        let task = json!({"id":"fiction","ticker":"FICTION","instrumentName":"Fictional company","analysisDate":"2026-10-05","assetType":"stock","researchDepth":1,"analysts":["market"],"outputLanguage":"en","status":"pending","createdAt":UTC,"updatedAt":UTC,"decision":"","stats":{"llmCalls":0,"toolCalls":0,"tokensIn":0,"tokensOut":0,"elapsedSeconds":0},"agentStatuses":{},"reportSections":{},"reportVersions":[],"evaluationReviews":[],"logs":[],"error":""});
        let request=task_mutation::parse(json!({"protocolVersion":1,"requestId":"create-fiction","collection":collection,"operation":"create","expectedHead":{"taskId":"fiction","generation":"0","revision":"0","state":"never_seen"},"task":task}),&["create"]).unwrap();
        task_mutation::execute(&conn, &request).unwrap();
        Self {
            conn: Mutex::new(conn),
        }
    }
}
impl JournalBackend for OwnedBackend {
    fn terminal_observed(&self, journal_id: &str) -> Result<bool, RecoveryError> {
        sql::terminal_observed(&self.conn.lock().unwrap(), journal_id)
    }
    fn interrupt_prior_epochs(&self, current_epoch: &str) -> Result<(), RecoveryError> {
        sql::interrupt_prior_epochs(&self.conn.lock().unwrap(), current_epoch)
    }
    fn bootstrap(&self) -> Result<SqlRecoveryCut, RecoveryError> {
        sql::bootstrap(&self.conn.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn current(&self, journal_id: &str) -> Result<SqlCurrent, RecoveryError> {
        sql::current(
            &self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            journal_id,
        )
    }
    fn attachment_current(&self, journal_id: &str) -> Result<SqlAttachmentCut, RecoveryError> {
        sql::attachment_current(
            &self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            journal_id,
        )
    }
    fn admit(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        seed: &AdmissionSeed,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
        sql::admit(
            &self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            packet,
            seed,
        )
    }
    fn reject_admission(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        seed: &AdmissionSeed,
        rejection: &RecoveryError,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
        sql::reject_admission(
            &self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            packet,
            seed,
            rejection,
        )
    }
    fn query_admission(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
        sql::query_admission(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), packet)
    }
    fn accept_start(
        &self,
        packet: &ParsedRecoveryRequest<StartRequest>,
    ) -> Result<SqlOutcome<StartReceipt>, RecoveryError> {
        sql::accept_start(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), packet)
    }
    fn query_start(
        &self,
        packet: &ParsedRecoveryRequest<StartRequest>,
    ) -> Result<SqlOutcome<StartReceipt>, RecoveryError> {
        sql::query_start(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), packet)
    }
    fn append(&self, draft: &PublicationDraft) -> Result<JournalEnvelope, RecoveryError> {
        sql::append(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), draft)
    }
    fn seal(&self, record: &SealRecord) -> Result<JournalSummary, RecoveryError> {
        sql::seal(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), record)
    }
    fn read(&self, request: &ReadRequest) -> Result<ReadReply, RecoveryError> {
        sql::read(
            &self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            request,
        )
    }
    fn project(
        &self,
        packet: &ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError> {
        sql::project(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), packet)
    }
    fn query_projection(
        &self,
        packet: &ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError> {
        sql::query_projection(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), packet)
    }
    fn record_control(
        &self,
        packet: &ParsedRecoveryRequest<StopRequest>,
        record: &ControlRecord,
    ) -> Result<SqlOutcome<ControlReceipt>, RecoveryError> {
        sql::record_control(
            &self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            packet,
            record,
        )
    }
    fn query_control(
        &self,
        packet: &ParsedRecoveryRequest<StopRequest>,
    ) -> Result<SqlOutcome<ControlReceipt>, RecoveryError> {
        sql::query_control(&self.conn.lock().unwrap_or_else(|e| e.into_inner()), packet)
    }
}
struct Harness {
    coordinator: Arc<Coordinator>,
    backend: Arc<OwnedBackend>,
    workers: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    gates: Mutex<HashMap<String, FixtureGate>>,
}
struct FixtureGate {
    origin: RunIdentity,
    gate: PathBuf,
    marker: PathBuf,
}
static FIXTURE_SEQUENCE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
impl Harness {
    fn new() -> Self {
        let backend = Arc::new(OwnedBackend::new());
        let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
        coordinator
            .initialize(backend.clone(), "a".repeat(64))
            .unwrap();
        Self {
            coordinator,
            backend,
            workers: Arc::new(Mutex::new(Vec::new())),
            gates: Mutex::new(HashMap::new()),
        }
    }
    fn command(&self, publisher: &Publisher, mode: &str) -> Result<Command, RecoveryError> {
        let mut command = Command::new(binary());
        command.arg(mode);
        if ["waiting", "controlled_safe"].contains(&mode) {
            let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::SeqCst);
            let directory =
                fixture_root().join(format!("controlled-{}-{sequence}", std::process::id()));
            fs::create_dir_all(fixture_root()).map_err(|_| RecoveryError::unavailable())?;
            fs::create_dir(&directory).map_err(|_| RecoveryError::unavailable())?;
            let gate = directory.join("release");
            let marker = directory.join("started");
            command
                .arg(&gate)
                .arg(&marker)
                .arg(&publisher.run.journal_id);
            self.gates.lock().unwrap().insert(
                publisher.run.journal_id.clone(),
                FixtureGate {
                    origin: publisher.run.origin.clone(),
                    gate,
                    marker,
                },
            );
        }
        Ok(command)
    }
    fn release_worker(&self, origin: &RunIdentity, journal: &str) -> Result<Value, RecoveryError> {
        self.coordinator.exact_session(origin, journal)?;
        let gates = self.gates.lock().unwrap();
        let gate = gates
            .get(journal)
            .filter(|g| g.origin == *origin)
            .ok_or_else(RecoveryError::invalid)?;
        if fs::read_to_string(&gate.marker).ok().as_deref() != Some(journal) {
            return Err(RecoveryError::fixed("analysis_busy"));
        }
        use std::io::Write;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&gate.gate)
        {
            Ok(mut file) => file
                .write_all(journal.as_bytes())
                .map_err(|_| RecoveryError::unavailable())?,
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && fs::read_to_string(&gate.gate).ok().as_deref() == Some(journal) => {}
            Err(_) => return Err(RecoveryError::unavailable()),
        }
        Ok(json!({"released":true,"workerStarted":true}))
    }
    fn admission(&self, id: &str) -> ParsedRecoveryRequest<AdmissionRequest> {
        let cut = self.backend.bootstrap().unwrap();
        let task = serde_json::to_value(&cut.tasks[0]).unwrap();
        let snapshot = json!({"ticker":task["ticker"],"instrumentName":task["instrumentName"],"analysisDate":task["analysisDate"],"assetType":task["assetType"],"researchDepth":task["researchDepth"],"analysts":task["analysts"],"outputLanguage":task["outputLanguage"]});
        let mut input = snapshot.clone();
        input.as_object_mut().unwrap().remove("instrumentName");
        let settings = json!({"llmProvider":"openai","quickThinkLlm":"fiction-model","deepThinkLlm":"fiction-model","temperature":"","openaiReasoningEffort":"","googleThinkingLevel":"","anthropicEffort":"","coreStockApis":"fixture","technicalIndicators":"fixture","fundamentalData":"fixture","newsData":"fixture","newsArticleLimit":1,"globalNewsArticleLimit":1,"globalNewsLookbackDays":1,"maxDebateRounds":0,"maxRiskRounds":0,"analystConcurrencyLimit":1,"benchmarkTicker":"","checkpointEnabled":false,"systemLanguage":"en"});
        let manifest = json!({"appVersion":"fixture","llmProvider":"openai","quickThinkLlm":"fiction-model","deepThinkLlm":"fiction-model","coreStockApis":"fixture","technicalIndicators":"fixture","fundamentalData":"fixture","newsData":"fixture","maxDebateRounds":0,"maxRiskRounds":0,"benchmarkTicker":""});
        parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":id,"runtimeEpoch":"a".repeat(64),"collection":cut.storage.authority.collection,"expectedHead":cut.storage.authority.heads[0],"context":{"originalTaskSnapshot":snapshot,"input":input,"requestedSettings":settings,"originalRunContext":{"runId":"11111111-1111-4111-8111-111111111111","manifest":manifest}}}).to_string()).unwrap()
    }
    fn reserve(&self, id: &str) -> AdmissionReceipt {
        self.coordinator
            .reserve(
                self.admission(id),
                |_| Ok(CredentialSnapshot::default()),
                Arc::new(|_| {}),
            )
            .unwrap()
            .receipt
            .unwrap()
    }
    fn read(&self, receipt: &AdmissionReceipt, after: &str) -> ReadReply {
        self.backend
            .read(&ReadRequest {
                recovery_protocol_version: 1,
                journal_id: receipt.journal_id.clone(),
                origin: receipt.origin.clone(),
                binding: receipt.binding.clone(),
                after_seq: after.into(),
                through_seq: None,
                limit: 64,
            })
            .unwrap()
    }
    fn project(
        &self,
        page: &ReadReply,
        mut task: Value,
        id: &str,
    ) -> OutcomeReply<ProjectionReceipt> {
        let head = self
            .backend
            .current(&page.header.journal_id)
            .unwrap()
            .head
            .unwrap();
        task["updatedAt"] = page.rows.last().unwrap().seed.updated_at.clone().into();
        let packet=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":id,"journalId":page.header.journal_id,"origin":page.header.origin,"binding":page.header.binding,"expectedHead":head,"expectedAppliedSeq":page.after_seq,"throughSeq":page.last_seq,"rangeDigest":page.range_proof.as_ref().unwrap().digest,"projection":{"task":task}}).to_string()).unwrap();
        let result = self.backend.project(&packet).unwrap();
        let reply =
            self.coordinator
                .outcome(result, "analysis_projection_sql", &page.header.journal_id);
        self.coordinator.refresh().unwrap();
        reply
    }
    fn reset(&self, receipt: &AdmissionReceipt) {
        let page = self.read(receipt, "0");
        let mut task = serde_json::to_value(
            self.backend
                .current(&receipt.journal_id)
                .unwrap()
                .task
                .unwrap(),
        )
        .unwrap();
        task["status"] = "running".into();
        task["queuedAt"] = "".into();
        task["queueOrder"] = Value::Null;
        task["decision"] = "".into();
        task["error"] = "".into();
        task["stats"] =
            json!({"llmCalls":0,"toolCalls":0,"tokensIn":0,"tokensOut":0,"elapsedSeconds":0});
        task["agentStatuses"] = json!({});
        task["reportSections"] = json!({});
        task["evaluationReviews"] = json!([]);
        task["logs"] = json!([]);
        for key in [
            "outputQuality",
            "evidenceBundle",
            "evidenceValidation",
            "memoryBundle",
            "memoryValidation",
            "researchReadiness",
            "readinessValidation",
            "reportTextSnapshot",
            "numericValidation",
            "effectiveRequestIdentity",
            "identityValidation",
        ] {
            task.as_object_mut().unwrap().remove(key);
        }
        assert!(self
            .project(&page, task, &format!("reset-{}", receipt.origin.run_id))
            .receipt
            .is_some());
    }
    fn start(&self, receipt: &AdmissionReceipt, mode: &str) -> OutcomeReply<StartReceipt> {
        let packet=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":format!("start-{}",receipt.origin.run_id),"origin":receipt.origin,"journalId":receipt.journal_id,"binding":receipt.binding,"headerDigest":receipt.header_digest}).to_string()).unwrap();
        let mut input = self.admission("input-only").request.context["input"].clone();
        for (k, v) in self.admission("input-settings").request.context["requestedSettings"]
            .as_object()
            .unwrap()
        {
            input[k] = v.clone();
        }
        let workers = self.workers.clone();
        let mode = mode.to_owned();
        let command_harness = self;
        self.coordinator
            .start(
                packet,
                input,
                Arc::new(|_| {}),
                move |execution, publisher, input| {
                    let command = command_harness.command(&publisher, &mode)?;
                    let worker = thread::spawn(move || {
                        run_owned_worker(execution, publisher, command, input.to_string())
                    });
                    workers.lock().unwrap().push(worker);
                    Ok(())
                },
            )
            .unwrap()
    }
    fn join_workers(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if self.workers.lock().unwrap().iter().all(|w| w.is_finished()) {
                break;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let workers = std::mem::take(&mut *self.workers.lock().unwrap());
        let mut joined = true;
        // Every worker must be consumed even if an earlier join failed.
        for worker in workers {
            let result = worker.join().is_ok();
            joined &= result;
        }
        joined
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let observation = self.coordinator.observe();
        if let Some(owner) = observation.owner {
            if let Ok(run) = self
                .coordinator
                .exact_session(&owner.origin, &owner.journal_id)
            {
                self.coordinator.mark_cancel(&run);
                if let Some(cleanup) = self
                    .coordinator
                    .registry
                    .cancel(&run.origin.task_id, &run.origin.run_id)
                {
                    let _ =
                        cleanup.wait(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT);
                }
                if !run.start_claimed.load(Ordering::SeqCst)
                    && !run.preparing.load(Ordering::SeqCst)
                {
                    let _ = self
                        .coordinator
                        .finish_prestart(&run, Arc::new(|_| {}), None);
                }
            }
        }
        let _ = self.join_workers();
    }
}

#[test]
fn analysis_recovery_real_owned_worker_requires_reset_and_cursor_then_allows_second_run() {
    let harness = Harness::new();
    let first = harness.reserve("first");
    assert!(harness.start(&first, "empty").rejection.is_some());
    harness.reset(&first);
    // A known rejected start cannot be restamped/retried with its old ID. This
    // separate accepted start intent follows the confirmed reset.
    let p=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"after-reset-start","origin":first.origin,"journalId":first.journal_id,"binding":first.binding,"headerDigest":first.header_digest}).to_string()).unwrap();
    let context = harness.admission("context").request.context;
    let mut input = context["input"].clone();
    for (k, v) in context["requestedSettings"].as_object().unwrap() {
        input[k] = v.clone();
    }
    let workers = harness.workers.clone();
    assert!(harness
        .coordinator
        .start(
            p,
            input,
            Arc::new(|_| {}),
            move |execution, publisher, input| {
                let mut command = Command::new(binary());
                command.arg("empty");
                workers.lock().unwrap().push(thread::spawn(move || {
                    run_owned_worker(execution, publisher, command, input.to_string())
                }));
                Ok(())
            }
        )
        .unwrap()
        .receipt
        .is_some());
    let joined = harness.join_workers();
    assert!(
        joined,
        "successful path requires consuming the actual owned worker"
    );
    assert_eq!(harness.coordinator.observe().runtime_gate, "occupied");
    assert_eq!(
        harness
            .coordinator
            .begin(&harness.admission("premature"))
            .err()
            .unwrap()
            .code,
        "analysis_busy"
    );
    let page = harness.read(&first, "1");
    assert!(page.summary.sealed_through_seq.is_some());
    assert_eq!(page.summary.cleanup_state, "confirmed");
    let mut task = serde_json::to_value(
        harness
            .backend
            .current(&first.journal_id)
            .unwrap()
            .task
            .unwrap(),
    )
    .unwrap();
    task["status"] = "error".into();
    task["error"] = RecoveryError::fixed("analysis_empty_result").message.into();
    let completion = page
        .rows
        .iter()
        .find(|r| r.kind == "analysis" && r.payload["event"]["type"] == "completed")
        .unwrap();
    task["logs"] = json!([{"id":completion.seed.log_id,"type":"error","message":task["error"],"timestamp":completion.seed.log_timestamp}]);
    assert!(harness
        .project(&page, task, "final-first")
        .receipt
        .is_some());
    assert_eq!(harness.coordinator.observe().runtime_gate, "vacant");
    let second = harness.reserve("second");
    assert_ne!(first.origin.run_id, second.origin.run_id);
    harness.reset(&second);
    assert!(harness.start(&second, "empty").receipt.is_some());
    assert!(harness.join_workers());
}
#[test]
fn analysis_recovery_prestart_cancel_is_sealed_without_a_phantom_worker() {
    let harness = Harness::new();
    let receipt = harness.reserve("no-worker");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    harness.coordinator.mark_cancel(&run);
    harness
        .coordinator
        .finish_prestart(&run, Arc::new(|_| {}), None)
        .unwrap();
    let page = harness.read(&receipt, "0");
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.rows[1].kind, "worker_outcome");
    assert_eq!(page.rows[1].payload["outcome"], "not_started");
    assert_eq!(page.summary.cleanup_state, "confirmed");
    assert_eq!(harness.coordinator.observe().runtime_gate, "occupied");
}
#[test]
fn analysis_recovery_known_inventory_failure_never_writes_header_or_private_body() {
    let harness = Harness::new();
    let original = harness.admission("inventory-error");
    let result = harness
        .coordinator
        .reserve(
            original.clone(),
            |_| Err(RecoveryError::fixed("analysis_identity_unavailable")),
            Arc::new(|_| {}),
        )
        .unwrap();
    assert_eq!(
        result.rejection.unwrap().code,
        "analysis_identity_unavailable"
    );
    assert!(result.receipt.is_none());
    assert!(harness.backend.bootstrap().unwrap().journals.is_empty());
    assert_eq!(harness.coordinator.observe().runtime_gate, "vacant");
    let replay = harness.coordinator.query_reservation(&original).unwrap();
    assert!(replay.rejection.is_some());
    match replay.current {
        RecoveryCurrent::Coherent {
            task,
            head,
            journal,
            ..
        } => {
            assert!(task.is_some());
            assert!(head.is_some());
            assert!(journal.is_none());
        }
        _ => panic!("actual current task must survive no-header rejection query"),
    }
}
#[test]
fn analysis_recovery_ordinary_critical_retains_later_safe_original_event() {
    let harness = Harness::new();
    let receipt = harness.reserve("critical-stream");
    harness.reset(&receipt);
    assert!(harness
        .start(&receipt, "critical_then_safe")
        .receipt
        .is_some());
    assert!(harness.join_workers());
    let page = harness.read(&receipt, "1");
    assert!(page
        .rows
        .iter()
        .any(|r| r.kind == "publication_unavailable" && r.payload["outcome"] == "analysis_failed"));
    assert!(page.rows.iter().any(|r| r.kind == "analysis"
        && r.payload["event"]["reportSections"]["market_report"]
            == "Later fictional safe report."));
    assert!(page.summary.sealed_through_seq.is_some());
}
#[test]
fn analysis_recovery_pending_preheader_witness_can_cancel_while_inventory_is_blocked() {
    let harness = Harness::new();
    let packet = harness.admission("pending-inventory");
    let coordinator = harness.coordinator.clone();
    let copied = packet.clone();
    let (entered, seen) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let worker = thread::spawn(move || {
        coordinator.reserve(
            copied,
            |_| {
                entered.send(()).unwrap();
                gate.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(CredentialSnapshot::default())
            },
            Arc::new(|_| {}),
        )
    });
    let acknowledged = seen.recv_timeout(Duration::from_secs(2)).is_ok();
    let query = harness.coordinator.query_reservation(&packet);
    let matched = query
        .as_ref()
        .ok()
        .and_then(|q| q.matched_reservation.clone());
    if let Some(matched) = &matched {
        if let Ok(run) = harness
            .coordinator
            .exact_session(&matched.origin, &matched.journal_id)
        {
            harness.coordinator.mark_cancel(&run);
        }
    }
    let released = release.send(()).is_ok();
    let deadline = Instant::now() + Duration::from_secs(6);
    while !worker.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let result = if worker.is_finished() {
        Some(worker.join())
    } else {
        None
    };
    assert!(
        acknowledged && released,
        "missing/late inventory witness remains a failure"
    );
    assert!(matches!(result,Some(Ok(Ok(ref reply))) if reply.receipt.is_some()),"success requires consuming the actual worker; no force-kill of a stuck Rust thread is claimed");
    let matched = matched.expect("exact original reservation witness");
    let page = harness
        .backend
        .read(&ReadRequest {
            recovery_protocol_version: 1,
            journal_id: matched.journal_id,
            origin: matched.origin,
            binding: matched.binding,
            after_seq: "0".into(),
            through_seq: None,
            limit: 64,
        })
        .unwrap();
    assert_eq!(page.summary.worker_outcome.as_deref(), Some("not_started"));
    assert_eq!(page.summary.cleanup_state, "confirmed");
}

/// Owned JSONL command bridge for frontend acceptance. Replies and wake notices
/// are actual production wire serialization; this fixture owns no gate logic.
/// Run explicitly with --ignored --exact and a persistent owned fixture root.
#[test]
#[ignore = "owned frontend/native command bridge; stdin-controlled"]
fn analysis_recovery_command_bridge() {
    use std::io::BufRead;
    let harness = Harness::new();
    let mut mode = "safe".to_owned();
    for line in std::io::stdin().lock().lines() {
        let raw = match line {
            Ok(raw) => raw,
            Err(_) => break,
        };
        let request = match parser::raw_json(&raw, PACKET_BYTES) {
            Ok(value) => value,
            Err(error) => {
                println!("RECOVERY_REPLY {}", json!({"id":null,"error":error}));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let command = request["command"].as_str().unwrap_or("");
        let args = &request["args"];
        let wake: WakeSink = Arc::new(|notice| {
            println!("RECOVERY_WAKE {}", serde_json::to_string(&notice).unwrap())
        });
        let result = (|| -> Result<Value, RecoveryError> {
            let raw = args["requestJson"].as_str().unwrap_or("");
            match command {
                "fixture_queue_tasks" => {
                    let conn = harness.backend.conn.lock().unwrap();
                    let cut = sql::bootstrap(&conn)?;
                    let task = serde_json::to_value(
                        cut.tasks
                            .iter()
                            .find(|t| t.id == "fiction")
                            .ok_or_else(RecoveryError::invalid)?,
                    )
                    .map_err(|_| RecoveryError::unavailable())?;
                    let mut first = task.clone();
                    first["status"] = "queued".into();
                    let head = cut
                        .storage
                        .authority
                        .heads
                        .iter()
                        .find(|h| h.task_id == "fiction")
                        .unwrap();
                    let packet=task_mutation::parse(json!({"protocolVersion":1,"requestId":"fixture-queue-first","collection":cut.storage.authority.collection,"operation":"update","expectedHead":head,"task":first}),&["update"]).map_err(|_|RecoveryError::invalid())?;
                    task_mutation::execute(&conn, &packet)
                        .map_err(|_| RecoveryError::unavailable())?;
                    let mut second = task;
                    second["id"] = "fiction-second".into();
                    second["ticker"] = "FICTION2".into();
                    second["instrumentName"] = "Second fictional company".into();
                    second["status"] = "queued".into();
                    second["createdAt"] = "2026-10-05T00:00:00.001Z".into();
                    second["updatedAt"] = "2026-10-05T00:00:00.001Z".into();
                    let packet=task_mutation::parse(json!({"protocolVersion":1,"requestId":"fixture-create-second","collection":cut.storage.authority.collection,"operation":"create","expectedHead":{"taskId":"fiction-second","generation":"0","revision":"0","state":"never_seen"},"task":second}),&["create"]).map_err(|_|RecoveryError::invalid())?;
                    task_mutation::execute(&conn, &packet)
                        .map_err(|_| RecoveryError::unavailable())?;
                    Ok(json!({"prepared":true}))
                }
                "load_desktop_data" => {
                    let cut = harness.backend.bootstrap()?;
                    serde_json::to_value(
                        json!({"settings":{},"storage":cut.storage,"tasks":cut.tasks}),
                    )
                    .map_err(|_| RecoveryError::unavailable())
                }
                "query_desktop_task_mutation" => {
                    let packet = task_mutation::parse(
                        args["request"].clone(),
                        &["create", "recreate", "update", "delete", "clear", "import"],
                    )
                    .map_err(|_| RecoveryError::invalid())?;
                    serde_json::to_value(
                        task_mutation::query(&harness.backend.conn.lock().unwrap(), &packet)
                            .map_err(|_| RecoveryError::unavailable())?,
                    )
                    .map_err(|_| RecoveryError::unavailable())
                }
                "fixture_mode" => {
                    let next = args["mode"].as_str().ok_or_else(RecoveryError::invalid)?;
                    if ![
                        "safe",
                        "safe_float",
                        "empty",
                        "critical_then_safe",
                        "no_terminal",
                        "malformed",
                        "waiting",
                        "controlled_safe",
                    ]
                    .contains(&next)
                    {
                        return Err(RecoveryError::invalid());
                    }
                    mode = next.into();
                    Ok(json!({"configured":true}))
                }
                "fixture_wait" => Ok(
                    json!({"joined":harness.join_workers(),"runtime":harness.coordinator.observe()}),
                ),
                "fixture_release_worker" => {
                    parser::exact(args, &["origin", "journalId"])?;
                    let origin: RunIdentity = serde_json::from_value(args["origin"].clone())
                        .map_err(|_| RecoveryError::invalid())?;
                    parser::identity(&origin)?;
                    let journal = args["journalId"]
                        .as_str()
                        .filter(|s| parser::hex(s))
                        .ok_or_else(RecoveryError::invalid)?;
                    harness.release_worker(&origin, journal)
                }
                "attach_analysis_recovery" | "query_analysis_attachment" => {
                    let p = parser::parse::<AttachRequest>(raw)?;
                    serde_json::to_value(fit_reply(
                        harness
                            .coordinator
                            .attachment(&p, command == "attach_analysis_recovery")?,
                    )?)
                    .map_err(|_| RecoveryError::unavailable())
                }
                "query_analysis_runtime" => {
                    parser::parse::<ProtocolRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.observe())
                        .map_err(|_| RecoveryError::unavailable())
                }
                "load_analysis_recovery" => {
                    parser::parse::<ProtocolRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.snapshot()?)
                        .map_err(|_| RecoveryError::unavailable())
                }
                "reserve_analysis" => {
                    let p = parser::parse::<AdmissionRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.reserve(
                        p,
                        |_| Ok(CredentialSnapshot::default()),
                        wake,
                    )?)
                    .map_err(|_| RecoveryError::unavailable())
                }
                "query_analysis_reservation" => {
                    let p = parser::parse::<AdmissionRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.query_reservation(&p)?)
                        .map_err(|_| RecoveryError::unavailable())
                }
                "start_analysis" => {
                    let p = parser::parse::<StartRequest>(raw)?;
                    let input = parser::execution_input(
                        args["executionInputJson"]
                            .as_str()
                            .ok_or_else(RecoveryError::invalid)?,
                    )?;
                    let workers = harness.workers.clone();
                    let mode = mode.clone();
                    let command_harness = &harness;
                    serde_json::to_value(harness.coordinator.start(
                        p,
                        input,
                        wake,
                        move |execution, publisher, input| {
                            let command = command_harness.command(&publisher, &mode)?;
                            workers.lock().unwrap().push(thread::spawn(move || {
                                run_owned_worker(execution, publisher, command, input.to_string())
                            }));
                            Ok(())
                        },
                    )?)
                    .map_err(|_| RecoveryError::unavailable())
                }
                "query_analysis_start" => {
                    let p = parser::parse::<StartRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.outcome(
                        harness.backend.query_start(&p)?,
                        "analysis_start",
                        &p.request.journal_id,
                    ))
                    .map_err(|_| RecoveryError::unavailable())
                }
                "read_analysis_journal" => {
                    let p = parser::parse::<ReadRequest>(raw)?;
                    serde_json::to_value(harness.backend.read(&p.request)?)
                        .map_err(|_| RecoveryError::unavailable())
                }
                "commit_analysis_projection" => {
                    let p = parser::parse::<ProjectionRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.project(p)?)
                        .map_err(|_| RecoveryError::unavailable())
                }
                "query_analysis_projection" => {
                    let p = parser::parse::<ProjectionRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.outcome(
                        harness.backend.query_projection(&p)?,
                        "analysis_projection_sql",
                        &p.request.journal_id,
                    ))
                    .map_err(|_| RecoveryError::unavailable())
                }
                "stop_analysis" => {
                    let p = parser::parse::<StopRequest>(raw)?;
                    serde_json::to_value(harness.coordinator.stop(p, wake)?)
                        .map_err(|_| RecoveryError::unavailable())
                }
                "query_analysis_control" => {
                    let p = parser::parse::<StopRequest>(raw)?;
                    let result = harness.backend.query_control(&p)?;
                    if let Some(receipt) = &result.receipt {
                        harness.coordinator.reconcile_control(receipt);
                    }
                    serde_json::to_value(harness.coordinator.outcome(
                        result,
                        "analysis_control",
                        &p.request.journal_id,
                    ))
                    .map_err(|_| RecoveryError::unavailable())
                }
                "save_desktop_task" => {
                    let p = task_mutation::parse(
                        args["request"].clone(),
                        &["create", "recreate", "update"],
                    )
                    .map_err(|_| RecoveryError::invalid())?;
                    serde_json::to_value(
                        task_mutation::execute(&harness.backend.conn.lock().unwrap(), &p)
                            .map_err(|_| RecoveryError::unavailable())?,
                    )
                    .map_err(|_| RecoveryError::unavailable())
                }
                _ => Err(RecoveryError::invalid()),
            }
        })();
        let result = result.and_then(fit_reply);
        match result {
            Ok(reply) => println!("RECOVERY_REPLY {}", json!({"id":id,"ok":reply})),
            Err(error) => println!("RECOVERY_REPLY {}", json!({"id":id,"error":error})),
        }
    }
    assert!(
        harness.join_workers(),
        "bridge success requires owned worker joins"
    );
}

#[test]
fn analysis_recovery_known_request_conflict_has_no_cancel_or_cleanup_effect() {
    let harness = Harness::new();
    let receipt = harness.reserve("already-bound-admission");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let request=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"already-bound-admission","origin":receipt.origin,"journalId":receipt.journal_id,"mode":"stop","expectedControlRevision":null}).to_string()).unwrap();
    let error = harness
        .coordinator
        .stop(request, Arc::new(|_| {}))
        .unwrap_err();
    assert_eq!(error.code, "analysis_request_conflict");
    assert!(!run.cancelled.load(Ordering::SeqCst));
    assert!(run.execution.lock().unwrap().is_some());
    assert_eq!(
        harness
            .backend
            .current(&receipt.journal_id)
            .unwrap()
            .journal
            .unwrap()
            .latest_seq,
        "1"
    );
}
#[test]
fn analysis_recovery_sql_future_first_poll_yields_while_actual_owned_connection_is_locked() {
    use std::{future::Future, task::Poll};
    let backend = Arc::new(OwnedBackend::new());
    let held = backend.conn.lock().unwrap();
    let owned = backend.clone();
    let (witness, observed) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut future = std::pin::pin!(crate::recovery_blocking(move || owned
            .bootstrap()
            .map(|_| json!({"sqlReadCompleted":true}))));
        let mut first = true;
        tauri::async_runtime::block_on(std::future::poll_fn(|cx| {
            let polled = future.as_mut().poll(cx);
            if first {
                first = false;
                let _ = witness.send(matches!(polled, Poll::Pending));
            }
            polled
        }))
    });
    let yielded = observed.recv_timeout(Duration::from_secs(2));
    drop(held);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !worker.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let joined = if worker.is_finished() {
        Some(worker.join())
    } else {
        None
    };
    assert!(
        yielded.unwrap_or(false),
        "real helper must yield before the supervisor releases the SQL lock"
    );
    assert!(matches!(joined,Some(Ok(Ok(_)))),"successful path requires consuming the owned worker; a stuck Rust thread cannot be force-killed");
}
#[test]
fn analysis_recovery_worker_panic_is_consumed_and_sealed_as_failure() {
    let harness = Harness::new();
    let receipt = harness.reserve("panic-run");
    harness.reset(&receipt);
    let packet=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"panic-start","origin":receipt.origin,"journalId":receipt.journal_id,"binding":receipt.binding,"headerDigest":receipt.header_digest}).to_string()).unwrap();
    let context = harness.admission("panic-context").request.context;
    let mut input = context["input"].clone();
    for (k, v) in context["requestedSettings"].as_object().unwrap() {
        input[k] = v.clone();
    }
    assert!(harness
        .coordinator
        .start(
            packet,
            input,
            Arc::new(|_| {}),
            |_execution, _publisher, _input| panic!("owned controlled launch panic")
        )
        .unwrap()
        .receipt
        .is_some());
    let page = harness.read(&receipt, "1");
    assert_eq!(page.summary.worker_outcome.as_deref(), Some("failed"));
    assert_eq!(page.summary.cleanup_state, "confirmed");
    assert_eq!(
        page.rows.last().unwrap().payload["code"],
        "analysis_worker_failed"
    );
}
#[test]
fn analysis_recovery_reader_panic_is_consumed_into_real_reader_outcome() {
    struct PanicReader;
    impl std::io::Read for PanicReader {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("owned controlled read panic");
        }
    }
    let harness = Harness::new();
    let receipt = harness.reserve("reader-panic");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let publisher = Publisher::new(harness.coordinator.clone(), run.clone(), Arc::new(|_| {}));
    let worker = spawn_reader(PanicReader, publisher, "stdout");
    assert!(worker.join().is_ok());
    assert!(run.reader_failed.load(Ordering::SeqCst));
    assert!(run.cancelled.load(Ordering::SeqCst));
    let page = harness.read(&receipt, "1");
    assert_eq!(page.rows[0].payload["outcome"], "read_failed");
    assert_eq!(page.rows[0].payload["code"], "analysis_reader_failed");
}
#[test]
fn analysis_recovery_real_unfinished_reader_retains_owner_then_explicit_retry_seals() {
    let harness = Harness::new();
    let receipt = harness.reserve("unfinished-reader");
    harness.reset(&receipt);
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let start = StartRequest {
        recovery_protocol_version: 1,
        request_id: "controlled-claim".into(),
        origin: receipt.origin.clone(),
        journal_id: receipt.journal_id.clone(),
        binding: receipt.binding.clone(),
        header_digest: receipt.header_digest.clone(),
    };
    let mut execution = harness.coordinator.claim_start(&run, &start).unwrap();
    let (released, gate) = mpsc::channel();
    let publisher = Publisher::new(harness.coordinator.clone(), run.clone(), Arc::new(|_| {}));
    execution.reader(thread::spawn(move || {
        let _ = gate.recv_timeout(Duration::from_secs(8));
        let _ = publisher.reader("stdout", true);
    }));
    let first = execution.finish(Instant::now() + Duration::from_millis(30));
    harness.coordinator.set_worker_outcome(
        &run,
        WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some("analysis_worker_failed".into()),
        },
    );
    harness.coordinator.automatic_cleanup(&run, false).unwrap();
    let before = harness.coordinator.observe();
    let cleanup_revision = before.owner.as_ref().unwrap().control_revision.clone();
    let signalled = released.send(()).is_ok();
    let request=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"explicit-reader-retry","origin":receipt.origin,"journalId":receipt.journal_id,"mode":"retry_cleanup","expectedControlRevision":cleanup_revision}).to_string()).unwrap();
    let retry = harness.coordinator.stop(request, Arc::new(|_| {}));
    assert!(first.is_err());
    assert_eq!(before.owner.unwrap().cleanup_state, "failed");
    assert!(signalled);
    assert_eq!(retry.unwrap().receipt.unwrap().outcome, "cleanup_confirmed");
    let page = harness.read(&receipt, "1");
    assert!(page.summary.sealed_through_seq.is_some());
    assert_eq!(
        harness.coordinator.observe().runtime_gate,
        "occupied",
        "durability gate must still wait for real projection"
    );
}

struct ControlledBackend {
    inner: Arc<OwnedBackend>,
    admit_unknown: AtomicBool,
    append_unknown: AtomicBool,
    worker_append_unknown: AtomicBool,
    attachment_unavailable: AtomicBool,
    attachment_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    record_control_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    bootstrap_calls: std::sync::atomic::AtomicUsize,
    hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl ControlledBackend {
    fn new(inner: Arc<OwnedBackend>) -> Self {
        Self {
            inner,
            admit_unknown: AtomicBool::new(false),
            append_unknown: AtomicBool::new(false),
            worker_append_unknown: AtomicBool::new(false),
            attachment_unavailable: AtomicBool::new(false),
            attachment_hook: Mutex::new(None),
            record_control_hook: Mutex::new(None),
            bootstrap_calls: std::sync::atomic::AtomicUsize::new(0),
            hook: Mutex::new(None),
        }
    }
}
impl JournalBackend for ControlledBackend {
    fn terminal_observed(&self, journal_id: &str) -> Result<bool, RecoveryError> {
        self.inner.terminal_observed(journal_id)
    }
    fn interrupt_prior_epochs(&self, current_epoch: &str) -> Result<(), RecoveryError> {
        self.inner.interrupt_prior_epochs(current_epoch)
    }
    fn bootstrap(&self) -> Result<SqlRecoveryCut, RecoveryError> {
        let cut = self.inner.bootstrap()?;
        let n = self.bootstrap_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if n == 3 {
            if let Some(hook) = self.hook.lock().unwrap().take() {
                hook();
            }
        }
        Ok(cut)
    }
    fn current(&self, journal_id: &str) -> Result<SqlCurrent, RecoveryError> {
        self.inner.current(journal_id)
    }
    fn attachment_current(&self, journal_id: &str) -> Result<SqlAttachmentCut, RecoveryError> {
        if self.attachment_unavailable.load(Ordering::SeqCst) {
            return Err(RecoveryError::unavailable());
        }
        let cut = self.inner.attachment_current(journal_id)?;
        let hook = self.attachment_hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        Ok(cut)
    }
    fn admit(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        seed: &AdmissionSeed,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
        let result = self.inner.admit(packet, seed)?;
        if self.admit_unknown.swap(false, Ordering::SeqCst) {
            Err(RecoveryError::fixed("analysis_admission_unknown"))
        } else {
            Ok(result)
        }
    }
    fn reject_admission(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        seed: &AdmissionSeed,
        rejection: &RecoveryError,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
        self.inner.reject_admission(packet, seed, rejection)
    }
    fn query_admission(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
        self.inner.query_admission(packet)
    }
    fn accept_start(
        &self,
        packet: &ParsedRecoveryRequest<StartRequest>,
    ) -> Result<SqlOutcome<StartReceipt>, RecoveryError> {
        self.inner.accept_start(packet)
    }
    fn query_start(
        &self,
        packet: &ParsedRecoveryRequest<StartRequest>,
    ) -> Result<SqlOutcome<StartReceipt>, RecoveryError> {
        self.inner.query_start(packet)
    }
    fn append(&self, draft: &PublicationDraft) -> Result<JournalEnvelope, RecoveryError> {
        let row = self.inner.append(draft)?;
        let unknown = (draft.kind == "analysis"
            && draft.payload["event"]["type"] == "completed"
            && self.append_unknown.swap(false, Ordering::SeqCst))
            || (draft.kind == "worker_outcome"
                && self.worker_append_unknown.swap(false, Ordering::SeqCst));
        if unknown {
            Err(RecoveryError::fixed("analysis_projection_unknown"))
        } else {
            Ok(row)
        }
    }
    fn seal(&self, record: &SealRecord) -> Result<JournalSummary, RecoveryError> {
        self.inner.seal(record)
    }
    fn read(&self, request: &ReadRequest) -> Result<ReadReply, RecoveryError> {
        self.inner.read(request)
    }
    fn project(
        &self,
        packet: &ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError> {
        self.inner.project(packet)
    }
    fn query_projection(
        &self,
        packet: &ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError> {
        self.inner.query_projection(packet)
    }
    fn record_control(
        &self,
        packet: &ParsedRecoveryRequest<StopRequest>,
        record: &ControlRecord,
    ) -> Result<SqlOutcome<ControlReceipt>, RecoveryError> {
        let hook = self.record_control_hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        self.inner.record_control(packet, record)
    }
    fn query_control(
        &self,
        packet: &ParsedRecoveryRequest<StopRequest>,
    ) -> Result<SqlOutcome<ControlReceipt>, RecoveryError> {
        self.inner.query_control(packet)
    }
}
#[test]
fn analysis_recovery_committed_admission_lost_ack_preserves_original_credentials_and_reconciles() {
    let backend = Arc::new(OwnedBackend::new());
    let controlled = Arc::new(ControlledBackend::new(backend.clone()));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(controlled.clone(), "a".repeat(64))
        .unwrap();
    let harness = Harness {
        backend,
        coordinator,
        workers: Arc::new(Mutex::new(Vec::new())),
        gates: Mutex::new(HashMap::new()),
    };
    controlled.admit_unknown.store(true, Ordering::SeqCst);
    let packet = harness.admission("lost-admission-ack");
    let result = harness.coordinator.reserve(
        packet.clone(),
        |_| {
            Ok(CredentialSnapshot {
                provider: "openai".into(),
                inventory: Arc::new(SecretInventory::new(vec![
                    "owned-original-private-inventory".into(),
                ])),
                ..Default::default()
            })
        },
        Arc::new(|_| {}),
    );
    assert_eq!(result.unwrap_err().code, "analysis_admission_unknown");
    let witness = harness.coordinator.pending_match(&packet).unwrap();
    let run = harness
        .coordinator
        .exact_session(&witness.origin, &witness.journal_id)
        .unwrap();
    assert!(run.credentials.lock().unwrap().is_some());
    let confirmed = harness.coordinator.query_reservation(&packet).unwrap();
    let receipt = confirmed.receipt.unwrap();
    assert_eq!(
        run.state.lock().unwrap().header_digest.as_deref(),
        Some(receipt.header_digest.as_str())
    );
    assert_eq!(
        run.credentials
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .inventory
            .values(),
        &["owned-original-private-inventory"]
    );
    harness.reset(&receipt);
    assert!(harness.start(&receipt, "empty").receipt.is_some());
    assert!(harness.join_workers());
    assert!(harness
        .read(&receipt, "1")
        .summary
        .sealed_through_seq
        .is_some());
}
#[test]
fn analysis_recovery_snapshot_retries_real_removal_aba_and_returns_the_winning_sql_cut() {
    let backend = Arc::new(OwnedBackend::new());
    let controlled = Arc::new(ControlledBackend::new(backend.clone()));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(controlled.clone(), "a".repeat(64))
        .unwrap();
    let deleting = coordinator.clone();
    let owned = backend.clone();
    *controlled.hook.lock().unwrap() = Some(Box::new(move || {
        let _permit = deleting.removal_permit(Some("fiction")).unwrap();
        let conn = owned.conn.lock().unwrap();
        let authority = task_mutation::current(&conn).unwrap();
        let request=task_mutation::parse(json!({"protocolVersion":1,"requestId":"delete-at-cut","operation":"delete","collection":authority.collection,"expectedHead":authority.heads[0]}),&["delete"]).unwrap();
        task_mutation::execute(&conn, &request).unwrap();
    }));
    let cut = coordinator.snapshot().unwrap();
    assert!(cut.coherent);
    assert!(cut.tasks.is_empty());
    assert_eq!(cut.storage.heads[0].state, "tombstone");
    assert!(
        controlled.bootstrap_calls.load(Ordering::SeqCst) >= 4,
        "old SQL cut must be retried after exact removal revision ABA"
    );
}

#[test]
fn analysis_recovery_new_runtime_classifies_old_epoch_and_refuses_new_projection_effect() {
    let harness = Harness::new();
    let receipt = harness.reserve("prior-host-run");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    harness.coordinator.mark_cancel(&run);
    harness
        .coordinator
        .finish_prestart(&run, Arc::new(|_| {}), None)
        .unwrap();
    let page = harness.read(&receipt, "0");
    let mut task = serde_json::to_value(
        harness
            .backend
            .current(&receipt.journal_id)
            .unwrap()
            .task
            .unwrap(),
    )
    .unwrap();
    task["status"] = "stopped".into();
    task["updatedAt"] = page.rows.last().unwrap().observed_at.clone().into();
    let expected_head = harness
        .backend
        .current(&receipt.journal_id)
        .unwrap()
        .head
        .unwrap();
    let original=parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"old-epoch-new-projection","journalId":receipt.journal_id,"origin":receipt.origin,"binding":receipt.binding,"expectedHead":expected_head,"expectedAppliedSeq":"0","throughSeq":page.last_seq,"rangeDigest":page.range_proof.as_ref().unwrap().digest,"projection":{"task":task}}).to_string()).unwrap();
    let restarted = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    restarted
        .initialize(harness.backend.clone(), "b".repeat(64))
        .unwrap();
    let snapshot = restarted.snapshot().unwrap();
    assert_eq!(snapshot.journals[0].history_state, "interrupted");
    assert!(snapshot.runtime.owner.is_none());
    assert_eq!(snapshot.runtime.journal_gate, "blocked");
    assert_eq!(
        restarted.project(original).unwrap_err().code,
        "analysis_stale_origin"
    );
    assert_eq!(
        harness
            .backend
            .current(&receipt.journal_id)
            .unwrap()
            .journal
            .unwrap()
            .applied_seq,
        "0"
    );
}

#[test]
fn analysis_recovery_complete_reply_bound_keeps_real_known_receipt_and_marks_current_unavailable() {
    let harness = Harness::new();
    let original = harness.admission("bounded-known-receipt");
    harness
        .coordinator
        .reserve(
            original.clone(),
            |_| Ok(CredentialSnapshot::default()),
            Arc::new(|_| {}),
        )
        .unwrap();
    let mut reply = harness.coordinator.query_reservation(&original).unwrap();
    let known = serde_json::to_value(reply.receipt.as_ref().unwrap()).unwrap();
    if let RecoveryCurrent::Coherent {
        task: Some(task), ..
    } = &mut reply.current
    {
        task["reportSections"] = json!({"fictional":"x".repeat(16*1024)});
    } else {
        panic!("fixture requires actual coherent task reply");
    }
    let bounded = reply.fit(4096).unwrap();
    assert_eq!(
        serde_json::to_value(bounded.receipt.as_ref().unwrap()).unwrap(),
        known
    );
    assert!(
        matches!(bounded.current,RecoveryCurrent::Unavailable{ref error,..} if error.code=="analysis_limit_exceeded")
    );
    assert!(serde_json::to_vec(&bounded).unwrap().len() <= 4096);
    assert!(bounded.fit(1).is_err(),"even degraded runtime+known receipt must fit the complete envelope; no partial ready/body is invented");
}

#[test]
fn analysis_recovery_actual_committed_completed_with_lost_append_ack_uses_sql_terminal_truth() {
    let backend = Arc::new(OwnedBackend::new());
    let controlled = Arc::new(ControlledBackend::new(backend.clone()));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(controlled.clone(), "a".repeat(64))
        .unwrap();
    let harness = Harness {
        backend,
        coordinator,
        workers: Arc::new(Mutex::new(Vec::new())),
        gates: Mutex::new(HashMap::new()),
    };
    let receipt = harness.reserve("lost-append");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let publisher = Publisher::new(harness.coordinator.clone(), run.clone(), Arc::new(|_| {}));
    controlled.append_unknown.store(true, Ordering::SeqCst);
    let original = json!({"type":"completed","reportSections":{"market_report":"Fictional safely committed result."}});
    let result = publisher.append("analysis", json!({"event":original}));
    assert_eq!(result.unwrap_err().code, "analysis_projection_unknown");
    assert!(!run.terminal_observed.load(Ordering::SeqCst));
    // The owned fixture has no process/readers; retire its actual Registry guard.
    let mut execution = run.execution.lock().unwrap().take().unwrap();
    execution
        .finish(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT)
        .unwrap();
    publisher
        .finish(WorkerOutcomePayload {
            outcome: "succeeded".into(),
            code: Some("analysis_missing_terminal".into()),
        })
        .unwrap();
    harness.coordinator.automatic_cleanup(&run, true).unwrap();
    let page = harness.read(&receipt, "1");
    assert_eq!(page.rows.last().unwrap().payload["outcome"], "succeeded");
    assert_eq!(page.rows.last().unwrap().payload["code"], Value::Null);
    assert!(page.summary.sealed_through_seq.is_some());
    assert_eq!(
        page.rows[0].payload["event"]["reportSections"]["market_report"],
        "Fictional safely committed result."
    );
}

#[test]
fn analysis_recovery_worker_outcome_commit_then_unknown_reuses_original_tail_before_seal() {
    let backend = Arc::new(OwnedBackend::new());
    let controlled = Arc::new(ControlledBackend::new(backend.clone()));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(controlled.clone(), "a".repeat(64))
        .unwrap();
    let harness = Harness {
        backend,
        coordinator,
        workers: Arc::new(Mutex::new(Vec::new())),
        gates: Mutex::new(HashMap::new()),
    };
    let receipt = harness.reserve("lost-worker-tail");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let publisher = Publisher::new(harness.coordinator.clone(), run.clone(), Arc::new(|_| {}));
    let mut execution = run.execution.lock().unwrap().take().unwrap();
    execution
        .finish(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT)
        .unwrap();
    controlled
        .worker_append_unknown
        .store(true, Ordering::SeqCst);
    let outcome = WorkerOutcomePayload {
        outcome: "not_started".into(),
        code: None,
    };
    assert_eq!(
        publisher.finish(outcome.clone()).unwrap_err().code,
        "analysis_projection_unknown"
    );
    let before = harness.read(&receipt, "1");
    assert!(before.summary.sealed_through_seq.is_none());
    assert_eq!(before.rows.len(), 1);
    let original = serde_json::to_value(&before.rows[0]).unwrap();
    publisher.finish(outcome.clone()).unwrap();
    publisher.finish(outcome).unwrap();
    let after = harness.read(&receipt, "1");
    assert_eq!(after.rows.len(), 1);
    assert_eq!(serde_json::to_value(&after.rows[0]).unwrap(), original);
    assert_eq!(
        after.summary.sealed_through_seq,
        Some(before.summary.latest_seq)
    );
}
#[test]
fn analysis_recovery_corrupt_current_header_does_not_discard_known_receipt_or_widen_current_error_union(
) {
    let harness = Harness::new();
    let original = harness.admission("known-receipt-corrupt-current");
    let reply = harness
        .coordinator
        .reserve(
            original.clone(),
            |_| Ok(CredentialSnapshot::default()),
            Arc::new(|_| {}),
        )
        .unwrap();
    let receipt = reply.receipt.unwrap();
    harness
        .backend
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE analysis_journals SET header_json='{}' WHERE journal_id=?1",
            [&receipt.journal_id],
        )
        .unwrap();
    let query = harness.coordinator.query_reservation(&original).unwrap();
    assert_eq!(query.receipt.unwrap().header_digest, receipt.header_digest);
    assert!(
        matches!(query.current,RecoveryCurrent::Unavailable{ref error,..} if error.code=="analysis_storage_unavailable")
    );
}

fn attach_packet(
    coordinator: &Coordinator,
    receipt: &AdmissionReceipt,
    id: &str,
) -> ParsedRecoveryRequest<AttachRequest> {
    parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":id,"runtimeEpoch":receipt.origin.runtime_epoch,
        "expectedObservationRevision":coordinator.observe().observation_revision,"origin":receipt.origin,
        "journalId":receipt.journal_id,"binding":receipt.binding,"admissionRequestId":receipt.request_id,
        "admissionDigest":receipt.digest,"expectedHeaderDigest":receipt.header_digest}).to_string()).unwrap()
}
fn stop_packet(receipt: &AdmissionReceipt, id: &str) -> ParsedRecoveryRequest<StopRequest> {
    parser::parse(
        &json!({"recoveryProtocolVersion":1,"requestId":id,"origin":receipt.origin,
        "journalId":receipt.journal_id,"mode":"stop","expectedControlRevision":null})
        .to_string(),
    )
    .unwrap()
}
#[test]
fn analysis_recovery_attachment_progress_lower_bound_query_identity_and_historical_outcome() {
    let harness = Harness::new();
    let receipt = harness.reserve("attach-progress");
    let original = attach_packet(&harness.coordinator, &receipt, "watch-progress");
    let unknown = harness.coordinator.attachment(&original, false).unwrap();
    assert!(
        unknown.receipt.is_none() && unknown.rejection.is_none() && unknown.attachment.is_none()
    );
    assert!(harness
        .coordinator
        .state
        .lock()
        .unwrap()
        .attachments
        .is_empty());
    harness.coordinator.changed();
    let ack = harness.coordinator.attachment(&original, true).unwrap();
    assert!(ack.receipt.is_some());
    assert!(
        matches!(ack.attachment, Some(CurrentAttachment::Durable { authority, .. }) if authority == "live")
    );
    let query = harness.coordinator.attachment(&original, false).unwrap();
    assert_eq!(query.receipt.unwrap().digest, original.digest);
    let mut conflict = original.original.clone();
    conflict["expectedHeaderDigest"] = Value::Null;
    assert_eq!(
        harness
            .coordinator
            .attachment(&parser::parse(&conflict.to_string()).unwrap(), false)
            .unwrap_err()
            .code,
        "analysis_request_conflict"
    );
    let mut future = original.original;
    future["requestId"] = "watch-future".into();
    future["expectedObservationRevision"] = MAX_COUNTER.to_string().into();
    let future = harness
        .coordinator
        .attachment(&parser::parse(&future.to_string()).unwrap(), true)
        .unwrap();
    assert_eq!(future.rejection.unwrap().code, "analysis_stale_origin");
    assert!(!harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap()
        .cancelled
        .load(Ordering::SeqCst));
}
#[test]
fn analysis_recovery_attachment_applied_anchor_does_not_use_unprojected_terminal() {
    let harness = Harness::new();
    let receipt = harness.reserve("attach-prefix");
    harness.reset(&receipt);
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let publisher = Publisher::new(harness.coordinator.clone(), run, Arc::new(|_| {}));
    publisher.event(&json!({"type":"completed","reportSections":{"market_report":"Owned unapplied terminal."}})).unwrap();
    let packet = attach_packet(&harness.coordinator, &receipt, "watch-unapplied");
    let reply = harness.coordinator.attachment(&packet, true).unwrap();
    let Some(CurrentAttachment::Durable { header, prefix, .. }) = reply.attachment else {
        panic!("available anchor required")
    };
    assert_eq!(header.header_digest, receipt.header_digest);
    assert_eq!(prefix.applied_seq, "1");
    assert!(!prefix.safe_terminal_through_applied && !prefix.projection_completed);
    assert!(prefix.critical_failure.is_none());
    assert!(
        matches!(reply.current, RecoveryCurrent::Coherent { head: Some(head), journal: Some(journal), .. }
        if head.revision == prefix.head.revision && journal.applied_seq == prefix.applied_seq && journal.latest_seq == "2")
    );
}
#[test]
fn analysis_recovery_attachment_preheader_witness_keeps_exact_cancel_identity() {
    let harness = Harness::new();
    let admission = harness.admission("pending-watch");
    let run = harness.coordinator.begin(&admission).unwrap();
    let packet = parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"watch-preheader","runtimeEpoch":run.origin.runtime_epoch,
        "expectedObservationRevision":harness.coordinator.observe().observation_revision,"origin":run.origin,
        "journalId":run.journal_id,"binding":run.binding,"admissionRequestId":admission.request.request_id,
        "admissionDigest":admission.digest,"expectedHeaderDigest":null}).to_string()).unwrap();
    let reply = harness.coordinator.attachment(&packet, true).unwrap();
    assert!(reply.receipt.is_some());
    assert!(
        matches!(reply.attachment, Some(CurrentAttachment::Volatile { witness, .. }) if witness.reason == "header_pending" && witness.header_digest.is_none())
    );
    harness.coordinator.mark_cancel(&run);
    run.preparing.store(false, Ordering::SeqCst);
    harness.coordinator.finish_without_header(&run).unwrap();
    let reply = harness.coordinator.attachment(&packet, false).unwrap();
    assert!(reply.receipt.is_some() && reply.attachment.is_none());
    assert!(harness.coordinator.observe().owner.is_none());
}
#[test]
fn analysis_recovery_attachment_non_eviction_cap_precedes_new_intent_and_known_query_survives() {
    let harness = Harness::new();
    let receipt = harness.reserve("attachment-cap");
    let mut first = None;
    for i in 0..OUTCOME_CAP {
        let packet = attach_packet(&harness.coordinator, &receipt, &format!("watch-{i}"));
        assert!(harness
            .coordinator
            .attachment(&packet, true)
            .unwrap()
            .receipt
            .is_some());
        if i == 0 {
            first = Some(packet);
        }
    }
    assert_eq!(
        harness
            .coordinator
            .attachment(
                &attach_packet(&harness.coordinator, &receipt, "watch-over-cap"),
                true
            )
            .unwrap_err()
            .code,
        "analysis_limit_exceeded"
    );
    assert!(harness
        .coordinator
        .attachment(&first.unwrap(), false)
        .unwrap()
        .receipt
        .is_some());
    let query = harness
        .coordinator
        .attachment(
            &attach_packet(&harness.coordinator, &receipt, "never-observed"),
            false,
        )
        .unwrap();
    assert!(query.receipt.is_none() && query.rejection.is_none());
    assert_eq!(
        harness.coordinator.state.lock().unwrap().attachments.len(),
        OUTCOME_CAP
    );
    assert!(!harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap()
        .cancelled
        .load(Ordering::SeqCst));
}
#[test]
fn analysis_recovery_different_stop_ids_join_one_real_reader_cleanup_and_keep_own_receipts() {
    let harness = Harness::new();
    let receipt = harness.reserve("different-stop-flight");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let (release, reader_wait) = mpsc::channel();
    let (reader_started, started) = mpsc::channel();
    let completed = Arc::new(AtomicBool::new(false));
    let done = completed.clone();
    run.execution
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .reader(thread::spawn(move || {
            let _ = reader_started.send(());
            let received = reader_wait.recv_timeout(Duration::from_secs(8));
            done.store(received.is_ok(), Ordering::SeqCst);
        }));
    let started = started.recv_timeout(Duration::from_secs(2)).is_ok();
    let first_coordinator = harness.coordinator.clone();
    let first = stop_packet(&receipt, "stop-one");
    let one = thread::spawn(move || first_coordinator.stop(first, Arc::new(|_| {})));
    let deadline = Instant::now() + Duration::from_secs(2);
    while run.cleanup_flight.lock().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let flight = run.cleanup_flight.lock().unwrap().clone();
    let second_coordinator = harness.coordinator.clone();
    let second = stop_packet(&receipt, "stop-two");
    let two = thread::spawn(move || second_coordinator.stop(second, Arc::new(|_| {})));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !run.attempts.lock().unwrap().contains_key("stop-two") && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let both_pending = run.attempts.lock().unwrap().len() == 2;
    let release_sent = release.send(()).is_ok();
    // Release both before assertions; a successful path must consume both.
    // Timeout fails without claiming a detached stuck thread was terminated.
    let deadline = Instant::now() + Duration::from_secs(8);
    while (!one.is_finished() || !two.is_finished()) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let one = if one.is_finished() {
        Some(one.join())
    } else {
        None
    };
    let two = if two.is_finished() {
        Some(two.join())
    } else {
        None
    };
    let same_flight = flight
        .zip(run.cleanup_flight.lock().unwrap().clone())
        .is_some_and(|(a, b)| Arc::ptr_eq(&a, &b));
    assert!(
        started && both_pending && release_sent && completed.load(Ordering::SeqCst) && same_flight
    );
    let first = one
        .expect("first Stop must be joined")
        .unwrap()
        .unwrap()
        .receipt
        .unwrap();
    let second = two
        .expect("second Stop must be joined")
        .unwrap()
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(first.request_id, "stop-one");
    assert_eq!(second.request_id, "stop-two");
    assert_eq!(first.outcome, "cleanup_confirmed");
    assert_eq!(second.outcome, "cleanup_confirmed");
    assert_ne!(first.control_revision, second.control_revision);
    assert_eq!(run.attempts.lock().unwrap().len(), 2);
}

#[test]
fn analysis_recovery_known_failed_fresh_stop_never_retries_reader_and_explicit_current_retry_does()
{
    let harness = Harness::new();
    let receipt = harness.reserve("failed-fresh-stop");
    harness.reset(&receipt);
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let mut execution = harness
        .coordinator
        .claim_start(
            &run,
            &StartRequest {
                recovery_protocol_version: 1,
                request_id: "failed-claim".into(),
                origin: receipt.origin.clone(),
                journal_id: receipt.journal_id.clone(),
                binding: receipt.binding.clone(),
                header_digest: receipt.header_digest.clone(),
            },
        )
        .unwrap();
    let (release, gate) = mpsc::channel();
    let completed = Arc::new(AtomicBool::new(false));
    let done = completed.clone();
    execution.reader(thread::spawn(move || {
        done.store(
            gate.recv_timeout(Duration::from_secs(8)).is_ok(),
            Ordering::SeqCst,
        );
    }));
    let original = execution.finish(Instant::now() + Duration::from_millis(30));
    harness.coordinator.set_worker_outcome(
        &run,
        WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some("analysis_worker_failed".into()),
        },
    );
    harness.coordinator.automatic_cleanup(&run, false).unwrap();
    let flight = run.cleanup_flight.lock().unwrap().clone().unwrap();
    let fresh = harness.coordinator.stop(
        stop_packet(&receipt, "fresh-known-failed"),
        Arc::new(|_| {}),
    );
    let not_joined = !completed.load(Ordering::SeqCst);
    let same = Arc::ptr_eq(
        &flight,
        run.cleanup_flight.lock().unwrap().as_ref().unwrap(),
    );
    let revision = run.state.lock().unwrap().control_revision.clone();
    let retry = parser::parse(&json!({"recoveryProtocolVersion":1,"requestId":"retry-known-failed","origin":receipt.origin,
        "journalId":receipt.journal_id,"mode":"retry_cleanup","expectedControlRevision":revision}).to_string()).unwrap();
    let retry_coordinator = harness.coordinator.clone();
    let retry_worker = thread::spawn(move || retry_coordinator.stop(retry, Arc::new(|_| {})));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !run
        .attempts
        .lock()
        .unwrap()
        .contains_key("retry-known-failed")
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
    let attachment = harness.coordinator.attachment(
        &attach_packet(&harness.coordinator, &receipt, "watch-retry-pending"),
        true,
    );
    let released = release.send(()).is_ok();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !retry_worker.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let retried = if retry_worker.is_finished() {
        Some(retry_worker.join())
    } else {
        None
    };
    assert!(original.is_err() && not_joined && same && released);
    assert!(
        matches!(attachment.unwrap().attachment, Some(CurrentAttachment::Durable {control: ControlReconciliation::Pending {attempt: Some(attempt), ..}, ..}) if attempt.request_id == "retry-known-failed")
    );
    assert_eq!(
        fresh.unwrap().receipt.unwrap().outcome,
        "cleanup_incomplete"
    );
    assert_eq!(
        retried
            .expect("retry must be joined")
            .unwrap()
            .unwrap()
            .receipt
            .unwrap()
            .outcome,
        "cleanup_confirmed"
    );
    assert!(completed.load(Ordering::SeqCst));
    assert!(!Arc::ptr_eq(
        &flight,
        run.cleanup_flight.lock().unwrap().as_ref().unwrap()
    ));
}
#[test]
fn analysis_recovery_control_attempt_cap_rejects_before_new_cleanup_and_known_reply_reads_fresh_cut(
) {
    let harness = Harness::new();
    let receipt = harness.reserve("control-cap");
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let first = stop_packet(&receipt, "control-0");
    let initial = harness
        .coordinator
        .stop(first.clone(), Arc::new(|_| {}))
        .unwrap();
    let flight = run.cleanup_flight.lock().unwrap().clone().unwrap();
    for i in 1..OUTCOME_CAP {
        let reply = harness
            .coordinator
            .stop(
                stop_packet(&receipt, &format!("control-{i}")),
                Arc::new(|_| {}),
            )
            .unwrap();
        assert_eq!(reply.receipt.unwrap().outcome, "cleanup_confirmed");
    }
    let revision = run.state.lock().unwrap().control_revision.clone();
    let rejected = harness
        .coordinator
        .stop(stop_packet(&receipt, "control-over-cap"), Arc::new(|_| {}))
        .unwrap_err();
    assert_eq!(rejected.code, "analysis_limit_exceeded");
    assert_eq!(run.state.lock().unwrap().control_revision, revision);
    assert!(Arc::ptr_eq(
        &flight,
        run.cleanup_flight.lock().unwrap().as_ref().unwrap()
    ));
    let known = harness.coordinator.stop(first, Arc::new(|_| {})).unwrap();
    assert_eq!(
        known.receipt.unwrap().control_revision,
        initial.receipt.unwrap().control_revision
    );
    assert!(
        matches!(known.current, RecoveryCurrent::Coherent {journal:Some(j),..} if j.control_revision == revision)
    );
    assert_eq!(run.attempts.lock().unwrap().len(), OUTCOME_CAP);
}
#[test]
fn analysis_recovery_attachment_known_runtime_receipt_survives_sql_unavailable_and_corruption() {
    let inner = Arc::new(OwnedBackend::new());
    let backend = Arc::new(ControlledBackend::new(inner));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(backend.clone(), "a".repeat(64))
        .unwrap();
    let harness = Harness {
        coordinator,
        backend: backend.inner.clone(),
        workers: Arc::new(Mutex::new(Vec::new())),
        gates: Mutex::new(HashMap::new()),
    };
    let receipt = harness.reserve("attach-unknown-current");
    backend.attachment_unavailable.store(true, Ordering::SeqCst);
    let packet = attach_packet(&harness.coordinator, &receipt, "watch-known-unknown");
    let reply = harness.coordinator.attachment(&packet, true).unwrap();
    assert!(reply.receipt.is_some());
    assert!(
        matches!(reply.current,RecoveryCurrent::Unavailable {error,..} if error.code == "analysis_storage_unavailable")
    );
    assert!(
        matches!(reply.attachment,Some(CurrentAttachment::Volatile {witness,..}) if witness.reason == "storage_unavailable")
    );
    backend
        .attachment_unavailable
        .store(false, Ordering::SeqCst);
    let restored = harness.coordinator.attachment(&packet, false).unwrap();
    assert!(matches!(
        restored.attachment,
        Some(CurrentAttachment::Durable { .. })
    ));
    {
        let conn = backend.inner.conn.lock().unwrap();
        let raw: String = conn
            .query_row(
                "SELECT header_json FROM analysis_journals WHERE journal_id=?1",
                [&receipt.journal_id],
                |r| r.get(0),
            )
            .unwrap();
        let mut header: Value = serde_json::from_str(&raw).unwrap();
        header["headerDigest"] = "e".repeat(64).into();
        conn.execute(
            "UPDATE analysis_journals SET header_json=?1 WHERE journal_id=?2",
            rusqlite::params![header.to_string(), receipt.journal_id],
        )
        .unwrap();
    }
    let corrupt = harness.coordinator.attachment(&packet, false).unwrap();
    assert!(corrupt.receipt.is_some());
    assert!(
        matches!(corrupt.current,RecoveryCurrent::Unavailable {error,..} if error.code == "analysis_storage_unavailable")
    );
    assert!(
        matches!(corrupt.attachment,Some(CurrentAttachment::Volatile {witness,..}) if witness.reason == "storage_unavailable")
    );
}
#[test]
fn analysis_recovery_attachment_complete_reply_limit_keeps_known_ack_without_durable_parent() {
    let harness = Harness::new();
    let receipt = harness.reserve("attach-reply-limit");
    let packet = attach_packet(&harness.coordinator, &receipt, "watch-limit");
    let mut reply = harness.coordinator.attachment(&packet, true).unwrap();
    if let RecoveryCurrent::Coherent {
        task: Some(task), ..
    } = &mut reply.current
    {
        task["ownedOversizedFictionalField"] = "x".repeat(16_384).into();
    }
    let fitted = reply.fit(8192).unwrap();
    assert!(fitted.receipt.is_some());
    assert!(
        matches!(fitted.current,RecoveryCurrent::Unavailable {error,..} if error.code=="analysis_limit_exceeded")
    );
    assert!(
        matches!(fitted.attachment,Some(CurrentAttachment::Volatile {witness,..}) if witness.reason=="storage_unavailable")
    );
}

#[test]
fn analysis_recovery_attachment_retired_receipt_cannot_adopt_replacement_owner() {
    let harness = Harness::new();
    let receipt = harness.reserve("old-attachment-run");
    harness.reset(&receipt);
    let packet = attach_packet(&harness.coordinator, &receipt, "watch-old-run");
    assert!(harness
        .coordinator
        .attachment(&packet, true)
        .unwrap()
        .receipt
        .is_some());
    harness
        .coordinator
        .stop(stop_packet(&receipt, "stop-old-run"), Arc::new(|_| {}))
        .unwrap();
    let page = harness.read(&receipt, "1");
    let mut task = serde_json::to_value(
        harness
            .backend
            .current(&receipt.journal_id)
            .unwrap()
            .task
            .unwrap(),
    )
    .unwrap();
    task["status"] = "stopped".into();
    assert!(harness
        .project(&page, task, "project-old-stop")
        .receipt
        .is_some());
    let retired = harness.coordinator.attachment(&packet, false).unwrap();
    assert!(
        matches!(retired.attachment,Some(CurrentAttachment::Durable {authority,..}) if authority=="retired")
    );
    let replacement = harness.reserve("replacement-owner");
    assert_ne!(receipt.origin, replacement.origin);
    let old = harness.coordinator.attachment(&packet, false).unwrap();
    assert!(old.receipt.is_some() && old.attachment.is_none());
    assert!(
        matches!(old.current,RecoveryCurrent::Coherent {runtime,..} if runtime.owner.as_ref().is_some_and(|o|o.origin==replacement.origin))
    );
    assert!(!harness
        .coordinator
        .exact_session(&replacement.origin, &replacement.journal_id)
        .unwrap()
        .cancelled
        .load(Ordering::SeqCst));
}
#[test]
fn analysis_recovery_attachment_retries_observation_change_and_returns_one_winning_canonical_cut() {
    let inner = Arc::new(OwnedBackend::new());
    let backend = Arc::new(ControlledBackend::new(inner));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(backend.clone(), "a".repeat(64))
        .unwrap();
    let harness = Harness {
        coordinator,
        backend: backend.inner.clone(),
        workers: Arc::new(Mutex::new(Vec::new())),
        gates: Mutex::new(HashMap::new()),
    };
    let receipt = harness.reserve("attach-cut-race");
    let old_head = harness
        .backend
        .current(&receipt.journal_id)
        .unwrap()
        .head
        .unwrap();
    let changed_backend = backend.inner.clone();
    let changed_coordinator = harness.coordinator.clone();
    *backend.attachment_hook.lock().unwrap() = Some(Box::new(move || {
        let conn = changed_backend.conn.lock().unwrap();
        let authority = task_mutation::current(&conn).unwrap();
        let mut task =
            serde_json::to_value(sql::bootstrap(&conn).unwrap().tasks[0].clone()).unwrap();
        task["error"] = "Owned newer canonical state.".into();
        let packet=task_mutation::parse(json!({"protocolVersion":1,"requestId":"attach-cut-owned-update","operation":"update","collection":authority.collection,
            "expectedHead":authority.heads[0],"task":task}),&["update"]).unwrap();
        let receipt = task_mutation::execute(&conn, &packet).unwrap().receipt;
        assert!(receipt.sql_committed);
        assert_eq!(receipt.operation, "update");
        drop(conn);
        changed_coordinator.changed();
    }));
    let packet = attach_packet(&harness.coordinator, &receipt, "watch-cut-race");
    let reply = harness.coordinator.attachment(&packet, true).unwrap();
    let Some(CurrentAttachment::Durable { prefix, .. }) = reply.attachment else {
        panic!("winning anchor required")
    };
    assert_ne!(prefix.head.revision, old_head.revision);
    assert!(
        matches!(reply.current,RecoveryCurrent::Coherent {task:Some(task),head:Some(head),journal:Some(journal),..}
        if task["error"]=="Owned newer canonical state." && head.revision==prefix.head.revision && journal.applied_seq==prefix.applied_seq)
    );
}
#[test]
fn analysis_recovery_controlled_owned_worker_release_is_exact_and_terminal_is_actual_journal_data()
{
    let harness = Harness::new();
    let receipt = harness.reserve("controlled-worker");
    harness.reset(&receipt);
    let started = harness.start(&receipt, "controlled_safe").receipt.is_some();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut marker = false;
    while Instant::now() < deadline {
        marker = harness
            .gates
            .lock()
            .unwrap()
            .get(&receipt.journal_id)
            .is_some_and(|g| {
                fs::read_to_string(&g.marker).ok().as_deref() == Some(receipt.journal_id.as_str())
            });
        if marker {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let mut wrong = receipt.origin.clone();
    wrong.run_id = "analysis-999999".into();
    let mismatch = harness.release_worker(&wrong, &receipt.journal_id);
    let before_release = harness
        .gates
        .lock()
        .unwrap()
        .get(&receipt.journal_id)
        .is_some_and(|g| !g.gate.exists());
    let release = harness.release_worker(&receipt.origin, &receipt.journal_id);
    let original_joined = harness.join_workers();
    // Supervisor cleanup cannot turn a failed original release/join into a pass.
    if !original_joined {
        let _ = harness.coordinator.stop(
            stop_packet(&receipt, "controlled-finally-stop"),
            Arc::new(|_| {}),
        );
        let _ = harness.join_workers();
    }
    let page = harness.read(&receipt, "1");
    assert!(
        started
            && marker
            && mismatch.is_err()
            && before_release
            && release.is_ok()
            && original_joined
    );
    assert_eq!(release.unwrap()["workerStarted"], true);
    assert!(page.rows.iter().any(|r| r.kind == "analysis"
        && r.payload["event"]["type"] == "completed"
        && r.payload["event"]["reportSections"]["market_report"] == "Fictional owned research."));
    assert_eq!(page.summary.cleanup_state, "confirmed");
    assert_eq!(
        page.summary.sealed_through_seq,
        Some(page.summary.latest_seq.clone())
    );
    assert_eq!(harness.coordinator.observe().runtime_gate, "occupied");
}

#[test]
fn analysis_recovery_late_failed_receipt_preserves_real_join_and_exact_sql_retry() {
    let inner = Arc::new(OwnedBackend::new());
    let backend = Arc::new(ControlledBackend::new(inner));
    let coordinator = Arc::new(Coordinator::new(Arc::new(Registry::default())));
    coordinator
        .initialize(backend.clone(), "a".repeat(64))
        .unwrap();
    let harness = Harness {
        coordinator,
        backend: backend.inner.clone(),
        workers: Arc::new(Mutex::new(Vec::new())),
        gates: Mutex::new(HashMap::new()),
    };
    let receipt = harness.reserve("late-failed-control");
    harness.reset(&receipt);
    let run = harness
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let mut execution = harness
        .coordinator
        .claim_start(
            &run,
            &StartRequest {
                recovery_protocol_version: 1,
                request_id: "claim-late-control".into(),
                origin: receipt.origin.clone(),
                journal_id: receipt.journal_id.clone(),
                binding: receipt.binding.clone(),
                header_digest: receipt.header_digest.clone(),
            },
        )
        .unwrap();
    let (release_reader, reader_gate) = mpsc::channel();
    let reader_done = Arc::new(AtomicBool::new(false));
    let completed = reader_done.clone();
    execution.reader(thread::spawn(move || {
        completed.store(
            reader_gate.recv_timeout(Duration::from_secs(12)).is_ok(),
            Ordering::SeqCst,
        );
    }));
    let first_finish = execution.finish(Instant::now() + Duration::from_millis(30));
    harness.coordinator.set_worker_outcome(
        &run,
        WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some("analysis_worker_failed".into()),
        },
    );
    harness.coordinator.automatic_cleanup(&run, false).unwrap();
    let original_revision = run.state.lock().unwrap().control_revision.clone();
    let (record_entered, entered) = mpsc::channel();
    let (release_record, record_gate) = mpsc::channel();
    let record_released = Arc::new(AtomicBool::new(false));
    let hook_released = record_released.clone();
    *backend.record_control_hook.lock().unwrap() = Some(Box::new(move || {
        let _ = record_entered.send(());
        hook_released.store(
            record_gate.recv_timeout(Duration::from_secs(8)).is_ok(),
            Ordering::SeqCst,
        );
    }));
    let retry = parser::parse(
        &json!({"recoveryProtocolVersion":1,"requestId":"late-incomplete-retry",
        "origin":receipt.origin,"journalId":receipt.journal_id,"mode":"retry_cleanup",
        "expectedControlRevision":original_revision})
        .to_string(),
    )
    .unwrap();
    let retry_coordinator = harness.coordinator.clone();
    let worker = thread::spawn(move || retry_coordinator.stop(retry, Arc::new(|_| {})));
    // This witness occurs after the production cleanup deadline and before the
    // actual SQL write of its incomplete observation; no fabricated receipt.
    let at_record = entered.recv_timeout(Duration::from_secs(5)).is_ok();
    let reader_released = release_reader.send(()).is_ok();
    let joined = harness
        .coordinator
        .registry
        .cancel(&run.origin.task_id, &run.origin.run_id)
        .is_some_and(|cleanup| {
            cleanup
                .wait(Instant::now() + Duration::from_secs(3))
                .is_ok()
        });
    let contributed = harness.coordinator.automatic_cleanup(&run, joined);
    let observed_confirmed = run.state.lock().unwrap().cleanup_state == "confirmed";
    let record_signalled = release_record.send(()).is_ok();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !worker.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let old_reply = if worker.is_finished() {
        Some(worker.join())
    } else {
        None
    };
    // Both gates were released before assertions. Success requires consuming
    // the caller and production joining the reader, not detached-thread claims.
    assert!(
        first_finish.is_err()
            && at_record
            && reader_released
            && joined
            && contributed.is_ok()
            && observed_confirmed
            && record_signalled
            && record_released.load(Ordering::SeqCst)
            && reader_done.load(Ordering::SeqCst)
    );
    let old_reply = old_reply
        .expect("late control caller must be joined")
        .unwrap()
        .unwrap();
    let old = old_reply.receipt.unwrap();
    assert_eq!(old.outcome, "cleanup_incomplete");
    assert!(
        matches!(old_reply.current, RecoveryCurrent::Coherent {runtime,journal:Some(journal),..}
        if runtime.owner.as_ref().is_some_and(|o|o.cleanup_state=="confirmed") && journal.cleanup_state=="failed")
    );
    assert_eq!(run.state.lock().unwrap().cleanup_state, "confirmed");
    assert!(
        harness
            .coordinator
            .registry
            .cancel(&run.origin.task_id, &run.origin.run_id)
            .is_none(),
        "the actual known reader owner was retired after joining"
    );
    assert_eq!(harness.coordinator.observe().runtime_gate, "occupied");
    let watch = harness
        .coordinator
        .attachment(
            &attach_packet(&harness.coordinator, &receipt, "watch-physical-vs-sql"),
            true,
        )
        .unwrap();
    assert!(
        matches!(watch.attachment, Some(CurrentAttachment::Durable {control:ControlReconciliation::Known {receipt,..},..})
        if receipt.outcome=="cleanup_incomplete")
    );
    let retry = parser::parse(
        &json!({"recoveryProtocolVersion":1,"requestId":"confirm-known-joined",
        "origin":receipt.origin,"journalId":receipt.journal_id,"mode":"retry_cleanup",
        "expectedControlRevision":old.control_revision})
        .to_string(),
    )
    .unwrap();
    let confirmed = harness.coordinator.stop(retry, Arc::new(|_| {})).unwrap();
    assert_eq!(confirmed.receipt.unwrap().outcome, "cleanup_confirmed");
    assert_eq!(run.state.lock().unwrap().cleanup_state, "confirmed");
    let current = harness
        .backend
        .current(&receipt.journal_id)
        .unwrap()
        .journal
        .unwrap();
    assert_eq!(current.cleanup_state, "confirmed");
    assert!(current.sealed_through_seq.is_some());
    assert_eq!(
        harness.coordinator.observe().runtime_gate,
        "occupied",
        "result cursor remains a separate gate"
    );
}

// UNEXECUTED: coherent SQL fixture only; no runner launch in these bodies.
#[test]
fn shutdown_closes_previously_admitted_owner_start_and_keeps_exact_arc() {
    let h = Harness::new();
    let receipt = h.reserve("admitted-before-closure");
    let original = h
        .coordinator
        .exact_session(&receipt.origin, &receipt.journal_id)
        .unwrap();
    let capture = h.coordinator.close_admission_capture(|| {});
    assert!(Arc::ptr_eq(capture.owner.as_ref().unwrap(), &original));
    assert!(capture.ownership.as_ref().unwrap().retained());
    let request = StartRequest {
        recovery_protocol_version: 1,
        request_id: "late-start".into(),
        origin: receipt.origin,
        journal_id: receipt.journal_id,
        binding: receipt.binding,
        header_digest: receipt.header_digest,
    };
    assert_eq!(
        h.coordinator
            .claim_start(&original, &request)
            .err()
            .unwrap()
            .code,
        "analysis_busy"
    );
    assert!(!original.start_claimed.load(Ordering::SeqCst));
    assert!(original.cancelled.load(Ordering::SeqCst));
}
#[test]
fn admission_closure_never_invents_new_runtime_wire_state() {
    let h = Harness::new();
    let capture = h.coordinator.close_admission_capture(|| {});
    assert!(capture.owner.is_none() && capture.ownership.is_none());
    let observed = h.coordinator.observe();
    assert_eq!(observed.runtime_gate, "vacant");
    assert_eq!(observed.journal_gate, "ready");
    assert_eq!(
        h.coordinator
            .begin(&h.admission("new-after-close"))
            .err()
            .unwrap()
            .code,
        "analysis_busy"
    );
}
