use super::{
    parser,
    publication::{self, SecretInventory},
    wire::*,
};
use crate::{
    analysis_execution::{Registry, RunGuard},
    storage::analysis_journal::{
        AdmissionSeed, ControlRecord, PublicationDraft, SealRecord, SqlAttachmentCut, SqlCurrent,
        SqlOutcome, SqlRecoveryCut,
    },
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

/// Both the desktop adapter and owned SQLite fixture delegate these calls to
/// the production Conn helpers. No process/runtime locks are taken by SQL.
pub trait JournalBackend: Send + Sync {
    fn interrupt_prior_epochs(&self, current_epoch: &str) -> Result<(), RecoveryError>;
    fn terminal_observed(&self, journal_id: &str) -> Result<bool, RecoveryError>;
    fn bootstrap(&self) -> Result<SqlRecoveryCut, RecoveryError>;
    fn current(&self, journal_id: &str) -> Result<SqlCurrent, RecoveryError>;
    fn attachment_current(&self, journal_id: &str) -> Result<SqlAttachmentCut, RecoveryError>;
    fn admit(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        seed: &AdmissionSeed,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError>;
    fn reject_admission(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        seed: &AdmissionSeed,
        rejection: &RecoveryError,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError>;
    fn query_admission(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
    ) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError>;
    fn accept_start(
        &self,
        packet: &ParsedRecoveryRequest<StartRequest>,
    ) -> Result<SqlOutcome<StartReceipt>, RecoveryError>;
    fn query_start(
        &self,
        packet: &ParsedRecoveryRequest<StartRequest>,
    ) -> Result<SqlOutcome<StartReceipt>, RecoveryError>;
    fn append(&self, draft: &PublicationDraft) -> Result<JournalEnvelope, RecoveryError>;
    fn seal(&self, record: &SealRecord) -> Result<JournalSummary, RecoveryError>;
    fn read(&self, request: &ReadRequest) -> Result<ReadReply, RecoveryError>;
    fn project(
        &self,
        packet: &ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError>;
    fn query_projection(
        &self,
        packet: &ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError>;
    fn record_control(
        &self,
        packet: &ParsedRecoveryRequest<StopRequest>,
        record: &ControlRecord,
    ) -> Result<SqlOutcome<ControlReceipt>, RecoveryError>;
    fn query_control(
        &self,
        packet: &ParsedRecoveryRequest<StopRequest>,
    ) -> Result<SqlOutcome<ControlReceipt>, RecoveryError>;
}

#[derive(Clone, Default)]
pub struct CredentialSnapshot {
    pub provider: String,
    pub provider_secret: Option<String>,
    pub alpha_secret: Option<String>,
    pub inherited: Vec<(String, Option<String>)>,
    pub inventory: Arc<SecretInventory>,
}

pub struct Coordinator {
    pub registry: Arc<Registry>,
    backend: OnceLock<Arc<dyn JournalBackend>>,
    state: Mutex<CoordinatorState>,
}
struct CoordinatorState {
    initialization: String,
    epoch: Option<String>,
    revision: u64,
    owner: Option<Arc<Session>>,
    removing: bool,
    journal_gate: String,
    blockers: Vec<RuntimeBlocker>,
    attachments: HashMap<String, AttachmentOutcome>,
    #[cfg(any(test, feature = "desktop-acceptance"))]
    admission_closed: bool,
}
#[derive(Clone)]
struct AttachmentOutcome {
    digest: String,
    receipt: Option<AttachReceipt>,
    rejection: Option<RecoveryError>,
}
const OUTCOME_CAP: usize = 1024;
pub struct Session {
    pub origin: RunIdentity,
    pub binding: RunBinding,
    pub journal_id: String,
    pub admission_request_id: String,
    pub admission_digest: String,
    pub context: Value,
    pub cancelled: AtomicBool,
    pub start_claimed: AtomicBool,
    pub finalizing: AtomicBool,
    pub fatal_publication: AtomicBool,
    pub journal_failed: AtomicBool,
    pub terminal_observed: AtomicBool,
    pub reader_failed: AtomicBool,
    pub preparing: AtomicBool,
    pub execution: Mutex<Option<RunGuard>>,
    pub credentials: Mutex<Option<CredentialSnapshot>>,
    final_publication: Mutex<Option<PublicationDraft>>,
    state: Mutex<SessionState>,
    pub writer: Mutex<()>,
    attempts: Mutex<HashMap<String, Arc<ControlAttempt>>>,
    cleanup_flight: Mutex<Option<Arc<CleanupFlight>>>,
    control_record: Mutex<()>,
    expires: Instant,
}
struct SessionState {
    phase: String,
    header_digest: Option<String>,
    control_revision: String,
    cleanup_state: String,
    worker_outcome: Option<WorkerOutcomePayload>,
    control_pending: Option<ControlAttemptWitness>,
    control_unknown: bool,
    latest_control: Option<ControlReceipt>,
}
struct ControlAttempt {
    digest: String,
    result: Mutex<Option<Result<ControlMetadata, RecoveryError>>>,
    changed: Condvar,
}
#[derive(Clone)]
struct ControlMetadata {
    receipt: Option<ControlReceipt>,
    rejection: Option<RecoveryError>,
}
struct CleanupFlight {
    attempt: Option<ControlAttemptWitness>,
    result: Mutex<Option<Result<bool, RecoveryError>>>,
    changed: Condvar,
}
#[cfg(any(test, feature = "desktop-acceptance"))]
pub(crate) struct ShutdownCapture {
    pub(crate) owner: Option<Arc<Session>>,
    pub(crate) ownership: Option<crate::analysis_execution::OwnershipObservation>,
}

impl Coordinator {
    pub fn new(registry: Arc<Registry>) -> Self {
        Self {
            registry,
            backend: OnceLock::new(),
            state: Mutex::new(CoordinatorState {
                initialization: "initializing".into(),
                epoch: None,
                revision: 0,
                owner: None,
                removing: false,
                journal_gate: "checking".into(),
                blockers: Vec::new(),
                attachments: HashMap::new(),
                #[cfg(any(test, feature = "desktop-acceptance"))]
                admission_closed: false,
            }),
        }
    }
    /// Feature/test-only production adapter. Capture original Session and
    /// Registry witness under the same mutex that admits and claims start.
    /// The auxiliary pool closure uses its own original admission mutex.
    #[cfg(any(test, feature = "desktop-acceptance"))]
    pub(crate) fn close_admission_capture(
        &self,
        close_auxiliary: impl FnOnce(),
    ) -> ShutdownCapture {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let owner = state.owner.clone();
        state.admission_closed = true;
        let ownership = self.registry.close_admission();
        if let Some(run) = &owner {
            run.cancelled.store(true, Ordering::SeqCst);
        }
        Self::bump(&mut state);
        drop(state);
        // No sink, SQL, physical cancellation or auxiliary admission lock is
        // acquired while holding Coordinator.state. Captured Arc is immutable.
        close_auxiliary();
        if let Some(run) = &owner {
            let _ = self
                .registry
                .cancel(&run.origin.task_id, &run.origin.run_id);
        }
        ShutdownCapture { owner, ownership }
    }

    pub fn backend(&self) -> Result<Arc<dyn JournalBackend>, RecoveryError> {
        self.backend
            .get()
            .cloned()
            .ok_or_else(RecoveryError::unavailable)
    }
    fn bump(s: &mut CoordinatorState) {
        if let Some(r) = s.revision.checked_add(1).filter(|n| *n <= MAX_COUNTER) {
            s.revision = r;
        } else {
            s.initialization = "unavailable".into();
            s.journal_gate = "unknown".into();
        }
    }
    pub fn initialization_failed(&self, code: &str) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.initialization = "unavailable".into();
        s.journal_gate = "unknown".into();
        s.blockers = vec![RuntimeBlocker {
            code: RecoveryError::fixed(code).code,
            origin: None,
            journal_id: None,
        }];
        Self::bump(&mut s);
    }
    pub fn initialize(
        &self,
        backend: Arc<dyn JournalBackend>,
        epoch: String,
    ) -> Result<(), RecoveryError> {
        parser::ensure(parser::hex(&epoch))?;
        self.backend
            .set(backend.clone())
            .map_err(|_| RecoveryError::invalid())?;
        backend.interrupt_prior_epochs(&epoch)?;
        let cut = backend.bootstrap()?;
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.epoch = Some(epoch);
        s.initialization = "ready".into();
        Self::apply_cut(&mut s, &cut);
        Self::bump(&mut s);
        Ok(())
    }
    fn apply_cut(s: &mut CoordinatorState, cut: &SqlRecoveryCut) {
        s.blockers = cut
            .journals
            .iter()
            .filter(|j| {
                j.result_state != "discarded"
                    && (j.sealed_through_seq.as_ref() != Some(&j.applied_seq)
                        || j.cleanup_state != "confirmed")
            })
            .map(|j| RuntimeBlocker {
                code: if j.history_state == "interrupted" {
                    "analysis_interrupted"
                } else {
                    "analysis_projection_unknown"
                }
                .into(),
                origin: Some(j.origin.clone()),
                journal_id: Some(j.journal_id.clone()),
            })
            .collect();
        s.blockers
            .extend(cut.clear_blockers.iter().map(|_| RuntimeBlocker {
                code: "analysis_partial_clear".into(),
                origin: None,
                journal_id: None,
            }));
        s.journal_gate = if s.blockers.is_empty() {
            "ready"
        } else {
            "blocked"
        }
        .into();
    }
    pub fn observe(&self) -> RuntimeObservation {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let owner = s.owner.as_ref().map(|owner| {
            let r = owner.state.lock().unwrap_or_else(|e| e.into_inner());
            NativeOwner {
                origin: owner.origin.clone(),
                admission_request_id: owner.admission_request_id.clone(),
                admission_digest: owner.admission_digest.clone(),
                journal_id: owner.journal_id.clone(),
                binding: owner.binding.clone(),
                phase: r.phase.clone(),
                control_revision: r.control_revision.clone(),
                cleanup_state: r.cleanup_state.clone(),
            }
        });
        RuntimeObservation {
            recovery_protocol_version: PROTOCOL_VERSION,
            initialization: s.initialization.clone(),
            runtime_epoch: s.epoch.clone(),
            observation_revision: s.revision.to_string(),
            runtime_gate: if s.initialization != "ready" {
                "unknown"
            } else if owner.is_some() || s.removing {
                "occupied"
            } else {
                "vacant"
            }
            .into(),
            owner,
            journal_gate: s.journal_gate.clone(),
            blockers: s.blockers.clone(),
        }
    }
    pub fn exact_session(
        &self,
        origin: &RunIdentity,
        journal: &str,
    ) -> Result<Arc<Session>, RecoveryError> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .owner
            .as_ref()
            .filter(|r| r.origin == *origin && r.journal_id == journal)
            .cloned()
            .ok_or_else(|| RecoveryError::fixed("analysis_stale_origin"))
    }
    fn changed(&self) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::bump(&mut s);
    }
    pub fn pending_match(
        &self,
        p: &ParsedRecoveryRequest<AdmissionRequest>,
    ) -> Option<MatchedReservation> {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let r = s.owner.as_ref()?;
        if r.admission_request_id != p.request.request_id || r.admission_digest != p.digest {
            return None;
        }
        let header_digest = r
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .header_digest
            .clone();
        Some(MatchedReservation {
            request_id: r.admission_request_id.clone(),
            digest: r.admission_digest.clone(),
            origin: r.origin.clone(),
            journal_id: r.journal_id.clone(),
            binding: r.binding.clone(),
            header_digest,
        })
    }
    pub fn begin(
        &self,
        p: &ParsedRecoveryRequest<AdmissionRequest>,
    ) -> Result<Arc<Session>, RecoveryError> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(any(test, feature = "desktop-acceptance"))]
        if s.admission_closed {
            return Err(RecoveryError::fixed("analysis_busy"));
        }
        if s.initialization != "ready" {
            return Err(RecoveryError::fixed("analysis_identity_unavailable"));
        }
        if s.epoch.as_deref() != Some(p.request.runtime_epoch.as_str()) {
            return Err(RecoveryError::fixed("analysis_stale_origin"));
        }
        if s.owner.is_some() || s.removing || s.journal_gate != "ready" {
            return Err(RecoveryError::fixed("analysis_busy"));
        }
        let run_id = self
            .registry
            .reserve(p.request.expected_head.task_id.clone())
            .map_err(|_| RecoveryError::fixed("analysis_busy"))?;
        // Claim preparing before any credential or SQL call. Old lease expiration
        // cannot silently remove this accepted lifecycle.
        let execution = self
            .registry
            .start(&p.request.expected_head.task_id, &run_id)
            .map_err(|_| RecoveryError::fixed("analysis_busy"))?;
        let origin = RunIdentity {
            runtime_epoch: p.request.runtime_epoch.clone(),
            task_id: p.request.expected_head.task_id.clone(),
            run_id,
        };
        let binding = RunBinding {
            collection: p.request.collection.clone(),
            task_id: origin.task_id.clone(),
            generation: p.request.expected_head.generation.clone(),
        };
        use sha2::{Digest, Sha256};
        let body=crate::research_memory::canonical_json(&serde_json::json!({"origin":origin,"binding":binding,"admissionRequestId":p.request.request_id})).map_err(|_|RecoveryError::invalid())?;
        let mut hash = Sha256::new();
        hash.update(b"evidenceloom-journal-v1\n");
        hash.update(body.as_bytes());
        let journal_id = format!("{:x}", hash.finalize());
        let owner = Arc::new(Session {
            origin,
            binding,
            journal_id,
            admission_request_id: p.request.request_id.clone(),
            admission_digest: p.digest.clone(),
            context: p.request.context.clone(),
            cancelled: AtomicBool::new(false),
            start_claimed: AtomicBool::new(false),
            finalizing: AtomicBool::new(false),
            fatal_publication: AtomicBool::new(false),
            journal_failed: AtomicBool::new(false),
            terminal_observed: AtomicBool::new(false),
            reader_failed: AtomicBool::new(false),
            preparing: AtomicBool::new(true),
            execution: Mutex::new(Some(execution)),
            credentials: Mutex::new(None),
            final_publication: Mutex::new(None),
            state: Mutex::new(SessionState {
                phase: "checking".into(),
                header_digest: None,
                control_revision: "0".into(),
                cleanup_state: "pending".into(),
                worker_outcome: None,
                control_pending: None,
                control_unknown: false,
                latest_control: None,
            }),
            writer: Mutex::new(()),
            attempts: Mutex::new(HashMap::new()),
            cleanup_flight: Mutex::new(None),
            control_record: Mutex::new(()),
            expires: Instant::now() + Duration::from_secs(30),
        });
        s.owner = Some(owner.clone());
        s.journal_gate = "blocked".into();
        Self::bump(&mut s);
        Ok(owner)
    }
    pub fn admitted(
        &self,
        run: &Arc<Session>,
        receipt: &AdmissionReceipt,
        credentials: CredentialSnapshot,
    ) {
        *run.credentials.lock().unwrap_or_else(|e| e.into_inner()) = Some(credentials);
        let mut r = run.state.lock().unwrap_or_else(|e| e.into_inner());
        r.header_digest = Some(receipt.header_digest.clone());
        r.phase = "reserved".into();
        drop(r);
        self.changed();
    }
    pub fn mark_cancel(&self, run: &Arc<Session>) {
        run.cancelled.store(true, Ordering::SeqCst);
        let _ = self
            .registry
            .cancel(&run.origin.task_id, &run.origin.run_id);
        self.changed();
    }
    pub fn expired(&self, run: &Arc<Session>) -> bool {
        Instant::now() >= run.expires && !run.start_claimed.load(Ordering::SeqCst)
    }
    pub fn claim_start(
        &self,
        run: &Arc<Session>,
        request: &StartRequest,
    ) -> Result<RunGuard, RecoveryError> {
        #[cfg(any(test, feature = "desktop-acceptance"))]
        let mut coordinator = self.state.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(any(test, feature = "desktop-acceptance"))]
        if coordinator.admission_closed
            || !coordinator
                .owner
                .as_ref()
                .is_some_and(|owner| Arc::ptr_eq(owner, run))
        {
            return Err(RecoveryError::fixed("analysis_busy"));
        }
        if request.binding != run.binding
            || run
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .header_digest
                .as_deref()
                != Some(request.header_digest.as_str())
            || run.cancelled.load(Ordering::SeqCst)
            || self.expired(run)
        {
            return Err(RecoveryError::fixed("analysis_stale_origin"));
        }
        if run.start_claimed.swap(true, Ordering::SeqCst) {
            return Err(RecoveryError::fixed("analysis_start_unknown"));
        }
        let execution = run
            .execution
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or_else(|| RecoveryError::fixed("analysis_start_unknown"))?;
        run.state.lock().unwrap_or_else(|e| e.into_inner()).phase = "preparing".into();
        #[cfg(any(test, feature = "desktop-acceptance"))]
        Self::bump(&mut coordinator);
        #[cfg(not(any(test, feature = "desktop-acceptance")))]
        self.changed();
        Ok(execution)
    }
    pub fn mark_running(&self, run: &Arc<Session>) {
        run.state.lock().unwrap_or_else(|e| e.into_inner()).phase = "running".into();
        self.changed();
    }
    pub fn record_cleanup(&self, run: &Arc<Session>, confirmed: bool) {
        let mut r = run.state.lock().unwrap_or_else(|e| e.into_inner());
        // A late failed observation cannot revoke a completed owned-handle join.
        if r.cleanup_state == "confirmed" && !confirmed {
            return;
        }
        r.cleanup_state = if confirmed { "confirmed" } else { "failed" }.into();
        r.phase = if confirmed {
            "result_pending"
        } else {
            "cleanup_failed"
        }
        .into();
        drop(r);
        self.changed();
    }
    pub fn set_worker_outcome(&self, run: &Arc<Session>, outcome: WorkerOutcomePayload) {
        run.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .worker_outcome = Some(outcome);
        self.changed();
    }
    pub fn reconcile_control(&self, receipt: &ControlReceipt) {
        if let Ok(run) = self.exact_session(&receipt.origin, &receipt.journal_id) {
            let mut state = run.state.lock().unwrap_or_else(|e| e.into_inner());
            let resolved = state
                .control_pending
                .as_ref()
                .is_some_and(|p| p.request_id == receipt.request_id && p.digest == receipt.digest);
            if resolved {
                state.control_unknown = false;
                state.control_pending = None;
            }
            if parser::counter(&receipt.control_revision).ok()
                > parser::counter(&state.control_revision).ok()
            {
                state.control_revision = receipt.control_revision.clone();
                state.latest_control = Some(receipt.clone());
                // SQL receipts describe their own earlier observation. A late
                // failure cannot undo a subsequently joined owned handle set.
                let confirmed =
                    state.cleanup_state == "confirmed" || receipt.outcome == "cleanup_confirmed";
                state.cleanup_state = if confirmed { "confirmed" } else { "failed" }.into();
                state.phase = if confirmed {
                    "result_pending"
                } else {
                    "cleanup_failed"
                }
                .into();
                drop(state);
                self.changed();
            } else if resolved {
                drop(state);
                self.changed();
            }
        }
    }
    pub fn current_reply(
        &self,
        current: Result<SqlCurrent, RecoveryError>,
        journal: &str,
    ) -> RecoveryCurrent {
        self.current_reply_from(current, || self.backend()?.current(journal))
    }
    /// Attachment acknowledges a new watch intent. Query is lookup-only and
    /// never turns an unrelated or unobserved request into an acknowledgement.
    pub fn attachment(
        &self,
        packet: &ParsedRecoveryRequest<AttachRequest>,
        admit: bool,
    ) -> Result<AttachReply, RecoveryError> {
        let outcome = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(old) = state.attachments.get(&packet.request.request_id) {
                if old.digest != packet.digest {
                    return Err(RecoveryError::fixed("analysis_request_conflict"));
                }
                Some(old.clone())
            } else if !admit {
                None
            } else {
                if state.attachments.len() >= OUTCOME_CAP {
                    return Err(RecoveryError::fixed("analysis_limit_exceeded"));
                }
                let request = &packet.request;
                let matched = state.initialization == "ready"
                    && state.epoch.as_deref() == Some(request.runtime_epoch.as_str())
                    && parser::counter(&request.expected_observation_revision)? <= state.revision
                    && state.owner.as_ref().is_some_and(|owner| {
                        owner.origin == request.origin
                            && owner.journal_id == request.journal_id
                            && owner.binding == request.binding
                            && owner.admission_request_id == request.admission_request_id
                            && owner.admission_digest == request.admission_digest
                            && request
                                .expected_header_digest
                                .as_ref()
                                .is_none_or(|digest| {
                                    owner
                                        .state
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .header_digest
                                        .as_ref()
                                        == Some(digest)
                                })
                    });
                let outcome = AttachmentOutcome {
                    digest: packet.digest.clone(),
                    receipt: matched.then(|| AttachReceipt {
                        recovery_protocol_version: PROTOCOL_VERSION,
                        request_id: request.request_id.clone(),
                        digest: packet.digest.clone(),
                        origin: request.origin.clone(),
                        journal_id: request.journal_id.clone(),
                        binding: request.binding.clone(),
                        admission_request_id: request.admission_request_id.clone(),
                        admission_digest: request.admission_digest.clone(),
                        matched_observation_revision: state.revision.to_string(),
                        confirmation: "runtime".into(),
                        permission: "same_runtime_watch_project_stop".into(),
                        may_start: false,
                    }),
                    rejection: (!matched).then(|| RecoveryError::fixed("analysis_stale_origin")),
                };
                state
                    .attachments
                    .insert(request.request_id.clone(), outcome.clone());
                Some(outcome)
            }
        };
        let mut current = RecoveryCurrent::Unavailable {
            error: RecoveryError::fixed("analysis_observation_changed"),
            runtime: self.observe(),
        };
        let mut attachment = None;
        for _ in 0..3 {
            let before = self.observe();
            let cut = self
                .backend()
                .and_then(|b| b.attachment_current(&packet.request.journal_id))
                .and_then(|mut cut| {
                    let task = cut
                        .current
                        .task
                        .take()
                        .map(serde_json::to_value)
                        .transpose()
                        .map_err(|_| RecoveryError::unavailable())?;
                    Ok((cut, task))
                });
            let after = self.observe();
            if before.observation_revision != after.observation_revision {
                continue;
            }
            let observed_revision = after.observation_revision.clone();
            let matched = outcome.as_ref().is_some_and(|o| o.receipt.is_some());
            let owner = after.owner.as_ref().filter(|o| {
                o.origin == packet.request.origin
                    && o.journal_id == packet.request.journal_id
                    && o.binding == packet.request.binding
                    && o.admission_request_id == packet.request.admission_request_id
                    && o.admission_digest == packet.request.admission_digest
            });
            match cut {
                Ok((cut, task)) => {
                    let projectable = cut.current.storage.collection
                        == packet.request.binding.collection
                        && task.is_some()
                        && cut.current.head.as_ref().is_some_and(|h| {
                            h.state == "live"
                                && h.task_id == packet.request.binding.task_id
                                && h.generation == packet.request.binding.generation
                        })
                        && cut.header.as_ref().is_some_and(|h| {
                            h.origin == packet.request.origin
                                && h.binding == packet.request.binding
                                && h.journal_id == packet.request.journal_id
                                && h.admission_request_id == packet.request.admission_request_id
                                && h.admission_digest == packet.request.admission_digest
                                && packet
                                    .request
                                    .expected_header_digest
                                    .as_ref()
                                    .is_none_or(|d| d == &h.header_digest)
                        })
                        && cut.prefix.is_some();
                    if matched {
                        let control = self.attachment_control(owner, cut.control);
                        if projectable && (owner.is_some() || after.owner.is_none()) {
                            attachment = Some(CurrentAttachment::Durable {
                                authority: if owner.is_some() { "live" } else { "retired" }.into(),
                                header: Box::new(cut.header.unwrap()),
                                prefix: Box::new(cut.prefix.unwrap()),
                                control,
                            });
                        } else if let Some(owner) = owner {
                            let reason = if cut
                                .current
                                .journal
                                .as_ref()
                                .is_some_and(|j| j.body_state != "available")
                            {
                                "body_unavailable"
                            } else if self
                                .exact_session(&owner.origin, &owner.journal_id)
                                .ok()
                                .is_some_and(|s| {
                                    s.state
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .header_digest
                                        .is_none()
                                })
                            {
                                "header_pending"
                            } else {
                                "binding_mismatch"
                            };
                            attachment = Some(CurrentAttachment::Volatile {
                                witness: Box::new(self.volatile_witness(owner, reason)),
                                control,
                            });
                        }
                    }
                    current = RecoveryCurrent::Coherent {
                        storage: cut.current.storage,
                        task,
                        head: cut.current.head,
                        journal: cut.current.journal,
                        runtime: Box::new(after),
                    };
                }
                Err(error) => {
                    if matched {
                        if let Some(owner) = owner {
                            attachment = Some(CurrentAttachment::Volatile {
                                witness: Box::new(
                                    self.volatile_witness(owner, "storage_unavailable"),
                                ),
                                control: self.attachment_control(
                                    Some(owner),
                                    ControlReconciliation::Unavailable {
                                        control_revision: None,
                                        error: current_read_error(error.clone()),
                                    },
                                ),
                            });
                        }
                    }
                    current = RecoveryCurrent::Unavailable {
                        error: current_read_error(error),
                        runtime: after,
                    };
                }
            }
            if self.observe().observation_revision != observed_revision {
                attachment = None;
                current = RecoveryCurrent::Unavailable {
                    error: RecoveryError::fixed("analysis_observation_changed"),
                    runtime: self.observe(),
                };
                continue;
            }
            break;
        }
        Ok(AttachReply {
            recovery_protocol_version: PROTOCOL_VERSION,
            scope: "analysis_attachment".into(),
            receipt: outcome.as_ref().and_then(|o| o.receipt.clone()),
            rejection: outcome.and_then(|o| o.rejection),
            current,
            attachment,
        })
    }
    fn volatile_witness(&self, owner: &NativeOwner, reason: &str) -> VolatileWitness {
        let header_digest = self
            .exact_session(&owner.origin, &owner.journal_id)
            .ok()
            .and_then(|s| {
                s.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .header_digest
                    .clone()
            });
        VolatileWitness {
            origin: owner.origin.clone(),
            journal_id: owner.journal_id.clone(),
            binding: owner.binding.clone(),
            admission_request_id: owner.admission_request_id.clone(),
            admission_digest: owner.admission_digest.clone(),
            header_digest,
            owner: owner.clone(),
            reason: reason.into(),
        }
    }
    fn attachment_control(
        &self,
        owner: Option<&NativeOwner>,
        control: ControlReconciliation,
    ) -> ControlReconciliation {
        if let Some(run) = owner.and_then(|o| self.exact_session(&o.origin, &o.journal_id).ok()) {
            let pending = {
                let attempts = run.attempts.lock().unwrap_or_else(|e| e.into_inner());
                attempts
                    .iter()
                    .filter(|(_, a)| a.result.lock().unwrap_or_else(|e| e.into_inner()).is_none())
                    .min_by(|(a, _), (b, _)| a.cmp(b))
                    .map(|(id, a)| ControlAttemptWitness {
                        request_id: id.clone(),
                        digest: a.digest.clone(),
                    })
            };
            let state = run.state.lock().unwrap_or_else(|e| e.into_inner());
            if pending.is_some() || state.control_unknown {
                return ControlReconciliation::Pending {
                    control_revision: state.control_revision.clone(),
                    attempt: pending.or_else(|| state.control_pending.clone()),
                };
            }
            drop(state);
            let flight = run
                .cleanup_flight
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Some(flight) = flight {
                if flight
                    .result
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_none()
                {
                    return ControlReconciliation::Pending {
                        control_revision: owner.unwrap().control_revision.clone(),
                        attempt: flight.attempt.clone(),
                    };
                }
            }
        }
        control
    }
    pub fn current_reply_from(
        &self,
        current: Result<SqlCurrent, RecoveryError>,
        mut read: impl FnMut() -> Result<SqlCurrent, RecoveryError>,
    ) -> RecoveryCurrent {
        if let Err(error) = current {
            return RecoveryCurrent::Unavailable {
                error: current_read_error(error),
                runtime: self.observe(),
            };
        }
        for _ in 0..3 {
            let before = self.observe();
            let current = read();
            let after = self.observe();
            if after.observation_revision == before.observation_revision {
                return match current {
                    Ok(c) => match c.task.map(serde_json::to_value).transpose() {
                        Ok(task) => RecoveryCurrent::Coherent {
                            storage: c.storage,
                            task,
                            head: c.head,
                            journal: c.journal,
                            runtime: Box::new(after),
                        },
                        Err(_) => RecoveryCurrent::Unavailable {
                            error: RecoveryError::unavailable(),
                            runtime: after,
                        },
                    },
                    Err(error) => RecoveryCurrent::Unavailable {
                        error: current_read_error(error),
                        runtime: after,
                    },
                };
            }
        }
        RecoveryCurrent::Unavailable {
            error: RecoveryError::fixed("analysis_observation_changed"),
            runtime: self.observe(),
        }
    }
    pub fn outcome<T>(&self, result: SqlOutcome<T>, scope: &str, journal: &str) -> OutcomeReply<T> {
        OutcomeReply {
            recovery_protocol_version: PROTOCOL_VERSION,
            scope: scope.into(),
            receipt: result.receipt,
            rejection: result.rejection,
            current: self.current_reply(result.current, journal),
        }
    }
    pub fn refresh(&self) -> Result<SqlRecoveryCut, RecoveryError> {
        let cut = self.backend()?.bootstrap()?;
        let owner = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .owner
            .clone();
        if let Some(run) = owner {
            let cleanup = run
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .cleanup_state
                == "confirmed";
            let current = self.backend()?.current(&run.journal_id)?;
            let ready = cleanup
                && current.journal.is_some_and(|j| {
                    j.origin == run.origin
                        && j.binding == run.binding
                        && j.cleanup_state == "confirmed"
                        && j.sealed_through_seq.as_ref() == Some(&j.applied_seq)
                });
            if ready {
                let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if s.owner.as_ref().is_some_and(|r| Arc::ptr_eq(r, &run)) {
                    s.owner = None;
                    Self::bump(&mut s);
                }
            }
        }
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let old = (
            s.journal_gate.clone(),
            serde_json::to_value(&s.blockers).ok(),
        );
        Self::apply_cut(&mut s, &cut);
        if old
            != (
                s.journal_gate.clone(),
                serde_json::to_value(&s.blockers).ok(),
            )
        {
            Self::bump(&mut s);
        }
        Ok(cut)
    }
    pub fn release_no_header(&self, run: &Arc<Session>) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.owner.as_ref().is_some_and(|r| Arc::ptr_eq(r, run)) {
            s.owner = None;
            s.journal_gate = "unknown".into();
            Self::bump(&mut s);
        }
        drop(s);
        let _ = self.refresh();
    }
    pub fn removal_permit(
        self: &Arc<Self>,
        task_id: Option<&str>,
    ) -> Result<RemovalPermit, RecoveryError> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.removing
            || s.owner
                .as_ref()
                .is_some_and(|r| task_id.is_none_or(|id| id == r.origin.task_id))
        {
            return Err(RecoveryError::fixed("analysis_busy"));
        }
        s.removing = true;
        Self::bump(&mut s);
        Ok(RemovalPermit {
            coordinator: self.clone(),
        })
    }
}
pub struct RemovalPermit {
    coordinator: Arc<Coordinator>,
}
impl Drop for RemovalPermit {
    fn drop(&mut self) {
        let mut s = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        s.removing = false;
        Coordinator::bump(&mut s);
    }
}

pub fn observed_at() -> Result<String, RecoveryError> {
    let time: chrono::DateTime<chrono::Utc> = std::time::SystemTime::now().into();
    let value = time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    parser::utc(&value)?;
    Ok(value)
}
pub fn entropy_epoch() -> Result<String, RecoveryError> {
    use aes_gcm::aead::{rand_core::RngCore, OsRng};
    let mut bytes = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| RecoveryError::fixed("analysis_identity_unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub type WakeSink = Arc<dyn Fn(WakeNotice) + Send + Sync>;
#[derive(Clone)]
pub struct Publisher {
    pub coordinator: Arc<Coordinator>,
    pub run: Arc<Session>,
    wake: WakeSink,
}
impl Publisher {
    pub fn new(coordinator: Arc<Coordinator>, run: Arc<Session>, wake: WakeSink) -> Self {
        Self {
            coordinator,
            run,
            wake,
        }
    }
    pub fn append(&self, kind: &str, payload: Value) -> Result<JournalEnvelope, RecoveryError> {
        let _writer = self.run.writer.lock().unwrap_or_else(|e| e.into_inner());
        let row = self.coordinator.backend()?.append(&PublicationDraft {
            journal_id: self.run.journal_id.clone(),
            origin: self.run.origin.clone(),
            binding: self.run.binding.clone(),
            kind: kind.into(),
            observed_at: observed_at()?,
            payload,
        });
        match row {
            Ok(row) => {
                let control_revision = self
                    .run
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .control_revision
                    .clone();
                (self.wake)(WakeNotice {
                    recovery_protocol_version: PROTOCOL_VERSION,
                    journal_id: row.journal_id.clone(),
                    origin: row.origin.clone(),
                    latest_seq: row.seq.clone(),
                    control_revision,
                });
                Ok(row)
            }
            Err(error) => {
                self.run.journal_failed.store(true, Ordering::SeqCst);
                Err(error)
            }
        }
    }
    /// At most one fixed critical publication can consume the reserved budget.
    /// After it, readers drain owned pipes but never forward further research.
    pub fn hard_failure(&self, reason: &str) -> Result<(), RecoveryError> {
        self.coordinator.mark_cancel(&self.run);
        if self.run.fatal_publication.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let marker = publication::unavailable(None, "event", reason);
        self.append(&marker.kind, marker.payload).map(|_| ())
    }
    pub fn event(&self, raw: &Value) -> Result<(), RecoveryError> {
        if self.run.fatal_publication.load(Ordering::SeqCst) {
            return Ok(());
        }
        let inventory = self
            .run
            .credentials
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|c| c.inventory.clone())
            .ok_or_else(RecoveryError::unavailable)?;
        let prepared = publication::prepare_event(raw, &inventory);
        let critical = prepared.kind == "publication_unavailable"
            && prepared.payload["outcome"] == "analysis_failed";
        let terminal = if prepared.kind == "analysis" {
            prepared.payload["event"]["type"].as_str()
        } else if !critical {
            prepared.payload["sourceType"].as_str()
        } else {
            None
        };
        let is_terminal = matches!(terminal, Some("completed" | "error"));
        match self.append(&prepared.kind, prepared.payload) {
            Ok(_) => {
                if is_terminal {
                    self.run.terminal_observed.store(true, Ordering::SeqCst);
                }
                Ok(())
            }
            Err(error) if error.code == "analysis_limit_exceeded" => {
                // A normal quota failure must still publish a fixed failure from
                // the terminal reserve; no raw body is retained or truncated.
                if !critical {
                    self.hard_failure("limit_exceeded")?;
                }
                self.coordinator.mark_cancel(&self.run);
                Err(error)
            }
            Err(error) => {
                self.coordinator.mark_cancel(&self.run);
                Err(error)
            }
        }
    }
    pub fn reader(&self, stream: &str, failed: bool) -> Result<(), RecoveryError> {
        if failed {
            self.run.reader_failed.store(true, Ordering::SeqCst);
            self.coordinator.mark_cancel(&self.run);
        }
        self.append("reader_outcome", serde_json::json!({"stream":stream,"outcome":if failed {"read_failed"} else {"eof"},"code":if failed {Some("analysis_reader_failed")} else {None::<&str>}})).map(|_| ())
    }
    pub fn finish(&self, mut outcome: WorkerOutcomePayload) -> Result<(), RecoveryError> {
        // The original terminal draft survives acknowledgement loss. A retry
        // verifies its exact committed tail before sealing, never appending a
        // second worker outcome or consuming another emergency row.
        let _writer = self.run.writer.lock().unwrap_or_else(|e| e.into_inner());
        let backend = self.coordinator.backend()?;
        let summary = backend
            .current(&self.run.journal_id)?
            .journal
            .ok_or_else(|| RecoveryError::fixed("analysis_projection_unknown"))?;
        if outcome.outcome == "succeeded" {
            outcome.code = if backend.terminal_observed(&self.run.journal_id)? {
                None
            } else {
                Some("analysis_missing_terminal".into())
            };
        }
        let payload = serde_json::to_value(&outcome).map_err(|_| RecoveryError::unavailable())?;
        let draft = {
            let mut original = self
                .run
                .final_publication
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(original) = original.as_ref() {
                if original.payload != payload {
                    return Err(RecoveryError::fixed("analysis_conflict"));
                }
                original.clone()
            } else {
                let draft = PublicationDraft {
                    journal_id: self.run.journal_id.clone(),
                    origin: self.run.origin.clone(),
                    binding: self.run.binding.clone(),
                    kind: "worker_outcome".into(),
                    observed_at: observed_at()?,
                    payload,
                };
                *original = Some(draft.clone());
                draft
            }
        };
        self.coordinator
            .set_worker_outcome(&self.run, outcome.clone());
        let latest = parser::counter(&summary.latest_seq)?;
        let tail = if latest > 0 {
            backend
                .read(&ReadRequest {
                    recovery_protocol_version: PROTOCOL_VERSION,
                    journal_id: self.run.journal_id.clone(),
                    origin: self.run.origin.clone(),
                    binding: self.run.binding.clone(),
                    after_seq: (latest - 1).to_string(),
                    through_seq: Some(latest.to_string()),
                    limit: 1,
                })?
                .rows
                .pop()
        } else {
            None
        };
        let row = if let Some(row) = tail.filter(|row| row.kind == "worker_outcome") {
            if row.observed_at != draft.observed_at
                || row.payload != draft.payload
                || row.origin != draft.origin
                || row.binding != draft.binding
                || row.journal_id != draft.journal_id
            {
                return Err(RecoveryError::fixed("analysis_projection_unknown"));
            }
            row
        } else {
            if summary.sealed_through_seq.is_some() {
                return Err(RecoveryError::fixed("analysis_journal_corrupt"));
            }
            backend.append(&draft)?
        };
        backend.seal(&SealRecord {
            journal_id: self.run.journal_id.clone(),
            origin: self.run.origin.clone(),
            binding: self.run.binding.clone(),
            worker_outcome: outcome,
        })?;
        (self.wake)(WakeNotice {
            recovery_protocol_version: PROTOCOL_VERSION,
            journal_id: self.run.journal_id.clone(),
            origin: self.run.origin.clone(),
            latest_seq: row.seq,
            control_revision: self
                .run
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .control_revision
                .clone(),
        });
        Ok(())
    }
}
impl Coordinator {
    pub fn snapshot(&self) -> Result<RecoverySnapshot, RecoveryError> {
        self.refresh()?;
        for _ in 0..3 {
            let before = self.observe();
            let cut = self.backend()?.bootstrap()?;
            let after = self.observe();
            if before.observation_revision == after.observation_revision {
                return Ok(RecoverySnapshot {
                    recovery_protocol_version: PROTOCOL_VERSION,
                    storage: RecoverySnapshotStorage {
                        collection: cut.storage.authority.collection,
                        heads: cut.storage.authority.heads,
                        legacy_task_import_allowed: cut.storage.legacy_task_import_allowed,
                    },
                    tasks: cut
                        .tasks
                        .into_iter()
                        .map(serde_json::to_value)
                        .collect::<Result<_, _>>()
                        .map_err(|_| RecoveryError::unavailable())?,
                    journals: cut.journals,
                    clear_blockers: cut.clear_blockers,
                    runtime: after,
                    coherent: true,
                });
            }
        }
        Err(RecoveryError::fixed("analysis_observation_changed"))
    }
    pub fn admission_reply(
        &self,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
        result: SqlOutcome<AdmissionReceipt>,
        _journal: &str,
    ) -> AdmissionOutcomeReply {
        AdmissionOutcomeReply {
            recovery_protocol_version: PROTOCOL_VERSION,
            scope: "analysis_admission".into(),
            receipt: result.receipt,
            rejection: result.rejection,
            matched_reservation: self.pending_match(packet),
            current: self.current_reply_from(result.current, || {
                self.backend()?.query_admission(packet)?.current
            }),
        }
    }
    pub fn query_reservation(
        self: &Arc<Self>,
        packet: &ParsedRecoveryRequest<AdmissionRequest>,
    ) -> Result<AdmissionOutcomeReply, RecoveryError> {
        let matched = self.pending_match(packet);
        let journal = matched
            .as_ref()
            .map(|r| r.journal_id.as_str())
            .unwrap_or("");
        match self.backend()?.query_admission(packet) {
            Ok(result) => {
                if let (Some(receipt), Some(_)) = (&result.receipt, &matched) {
                    if let Ok(run) = self.exact_session(&receipt.origin, &receipt.journal_id) {
                        let mut state = run.state.lock().unwrap_or_else(|e| e.into_inner());
                        state.header_digest = Some(receipt.header_digest.clone());
                        drop(state);
                        self.changed();
                        if run.cancelled.load(Ordering::SeqCst) || self.expired(&run) {
                            self.mark_cancel(&run);
                            let _ = self.finish_prestart(&run, Arc::new(|_| {}), None);
                        }
                    }
                }
                if result.rejection.is_some() {
                    if let Some(matched) = &matched {
                        if let Ok(run) = self.exact_session(&matched.origin, &matched.journal_id) {
                            if !run.preparing.load(Ordering::SeqCst) {
                                let _ = self.finish_without_header(&run);
                            }
                        }
                    }
                }
                Ok(self.admission_reply(packet, result, journal))
            }
            Err(error) if matched.is_some() => Ok(AdmissionOutcomeReply {
                recovery_protocol_version: PROTOCOL_VERSION,
                scope: "analysis_admission".into(),
                receipt: None,
                rejection: None,
                matched_reservation: matched,
                current: RecoveryCurrent::Unavailable {
                    error: current_read_error(error),
                    runtime: self.observe(),
                },
            }),
            Err(error) => Err(error),
        }
    }
    pub fn reserve(
        self: &Arc<Self>,
        packet: ParsedRecoveryRequest<AdmissionRequest>,
        credentials: impl FnOnce(&AdmissionRequest) -> Result<CredentialSnapshot, RecoveryError>,
        wake: WakeSink,
    ) -> Result<AdmissionOutcomeReply, RecoveryError> {
        // Replays bind the original request before testing current admission.
        if self.pending_match(&packet).is_some() {
            return self.query_reservation(&packet);
        }
        let run = match self.begin(&packet) {
            Ok(run) => run,
            Err(admission) => {
                let prior = self.backend()?.query_admission(&packet)?;
                if prior.receipt.is_some() || prior.rejection.is_some() {
                    return Ok(self.admission_reply(&packet, prior, ""));
                }
                return Err(admission);
            }
        };
        // This original owner is visible before the first credential or SQL
        // call. A replay retires only this newly allocated, unstarted owner.
        let prior = match self.backend()?.query_admission(&packet) {
            Ok(prior) => prior,
            Err(error) => {
                run.preparing.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        if prior.receipt.is_some() || prior.rejection.is_some() {
            run.preparing.store(false, Ordering::SeqCst);
            self.finish_without_header(&run)?;
            return Ok(self.admission_reply(&packet, prior, ""));
        }
        let seed = AdmissionSeed {
            origin: run.origin.clone(),
            journal_id: run.journal_id.clone(),
            accepted_at: observed_at()?,
        };
        let preparation = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            credentials(&packet.request).and_then(|snapshot| {
                publication::validate_context(&packet.request.context, &snapshot.inventory)?;
                Ok(snapshot)
            })
        }));
        let prepared = preparation
            .unwrap_or_else(|_| Err(RecoveryError::fixed("analysis_identity_unavailable")));
        let result = match prepared {
            Ok(snapshot) => {
                *run.credentials.lock().unwrap_or_else(|e| e.into_inner()) = Some(snapshot.clone());
                let result = self.backend()?.admit(&packet, &seed);
                if let Ok(result) = &result {
                    if let Some(receipt) = &result.receipt {
                        self.admitted(&run, receipt, snapshot);
                    }
                }
                result
            }
            Err(error) => self.backend()?.reject_admission(&packet, &seed, &error),
        };
        run.preparing.store(false, Ordering::SeqCst);
        match result {
            Ok(result) => {
                if result.rejection.is_some() {
                    self.finish_without_header(&run)?;
                } else if run.cancelled.load(Ordering::SeqCst) {
                    self.finish_prestart(&run, wake.clone(), None)?;
                } else {
                    // Expiry supervises the exact acknowledged owner; it never
                    // silently removes a committed accepted/reset event.
                    let coordinator = self.clone();
                    let expiring = run.clone();
                    #[cfg(feature = "desktop-acceptance")]
                    {
                        // Original expiry worker is captured before it runs and
                        // joins before final SQL observation. The existing exact
                        // Session cancellation latch releases its bounded wait.
                        let fallback_coordinator = coordinator.clone();
                        let fallback_run = expiring.clone();
                        let fallback_wake = wake.clone();
                        let expiry =
                            crate::desktop_acceptance::tasks::spawn_original_thread(move || {
                                while !expiring.cancelled.load(Ordering::SeqCst)
                                    && !expiring.start_claimed.load(Ordering::SeqCst)
                                    && Instant::now() < expiring.expires
                                {
                                    std::thread::park_timeout(
                                        std::time::Duration::from_millis(10).min(
                                            expiring
                                                .expires
                                                .saturating_duration_since(Instant::now()),
                                        ),
                                    );
                                }
                                if coordinator.expired(&expiring)
                                    && coordinator
                                        .exact_session(&expiring.origin, &expiring.journal_id)
                                        .is_ok()
                                {
                                    coordinator.mark_cancel(&expiring);
                                    let _ = coordinator.finish_prestart(
                                        &expiring,
                                        wake,
                                        Some("analysis_reservation_expired"),
                                    );
                                }
                            });
                        if expiry.is_err() {
                            // Capacity/closed admission cannot silently lose the
                            // exact owner's expiry supervision. Parent is still
                            // admitted and settles the original failure SQL here.
                            fallback_coordinator.mark_cancel(&fallback_run);
                            let _ = fallback_coordinator.finish_prestart(
                                &fallback_run,
                                fallback_wake,
                                Some("analysis_identity_unavailable"),
                            );
                        }
                    }
                    #[cfg(not(feature = "desktop-acceptance"))]
                    {
                        std::thread::spawn(move || {
                            std::thread::sleep(
                                expiring.expires.saturating_duration_since(Instant::now()),
                            );
                            if coordinator.expired(&expiring)
                                && coordinator
                                    .exact_session(&expiring.origin, &expiring.journal_id)
                                    .is_ok()
                            {
                                coordinator.mark_cancel(&expiring);
                                let _ = coordinator.finish_prestart(
                                    &expiring,
                                    wake,
                                    Some("analysis_reservation_expired"),
                                );
                            }
                        });
                    }
                }
                Ok(self.admission_reply(&packet, result, &run.journal_id))
            }
            Err(error) => Err(error), // retained matching pending witness
        }
    }
    fn finish_without_header(&self, run: &Arc<Session>) -> Result<(), RecoveryError> {
        let mut guard = run
            .execution
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(guard) = guard.as_mut() {
            let ownership = guard.ownership();
            let _ = guard.finish(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT);
            if ownership.retained() {
                self.record_cleanup(run, false);
                return Err(RecoveryError::fixed("analysis_cleanup_incomplete"));
            }
        }
        self.record_cleanup(run, true);
        self.release_no_header(run);
        Ok(())
    }
    pub fn finish_prestart(
        self: &Arc<Self>,
        run: &Arc<Session>,
        wake: WakeSink,
        code: Option<&str>,
    ) -> Result<(), RecoveryError> {
        if run.preparing.load(Ordering::SeqCst) || run.start_claimed.load(Ordering::SeqCst) {
            return Err(RecoveryError::fixed("analysis_cleanup_incomplete"));
        }
        if run.finalizing.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let result = (|| {
            let execution = run
                .execution
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let confirmed = if let Some(mut execution) = execution {
                let ownership = execution.ownership();
                let _ =
                    execution.finish(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT);
                !ownership.retained()
            } else if let Some(cleanup) = self
                .registry
                .cancel(&run.origin.task_id, &run.origin.run_id)
            {
                cleanup
                    .wait(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT)
                    .is_ok()
            } else {
                run.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .cleanup_state
                    == "confirmed"
            };
            self.record_cleanup(run, confirmed);
            if !confirmed {
                return Err(RecoveryError::fixed("analysis_cleanup_incomplete"));
            }
            if run
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .header_digest
                .is_none()
            {
                return Err(RecoveryError::fixed("analysis_admission_unknown"));
            }
            let publisher = Publisher::new(self.clone(), run.clone(), wake);
            publisher.finish(WorkerOutcomePayload {
                outcome: "not_started".into(),
                code: code.map(str::to_owned),
            })?;
            self.automatic_cleanup(run, true)?;
            Ok(())
        })();
        if result.is_err() {
            run.finalizing.store(false, Ordering::SeqCst);
        }
        result
    }
    fn control_reply(
        &self,
        metadata: ControlMetadata,
        journal: &str,
    ) -> OutcomeReply<ControlReceipt> {
        OutcomeReply {
            recovery_protocol_version: PROTOCOL_VERSION,
            scope: "analysis_control".into(),
            receipt: metadata.receipt,
            rejection: metadata.rejection,
            current: self.current_reply(self.backend().and_then(|b| b.current(journal)), journal),
        }
    }
    fn has_pending_control(run: &Session) -> bool {
        run.attempts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|a| a.result.lock().unwrap_or_else(|e| e.into_inner()).is_none())
    }
    fn perform_cleanup(self: &Arc<Self>, run: &Arc<Session>, wake: WakeSink) -> bool {
        self.mark_cancel(run);
        if !run.start_claimed.load(Ordering::SeqCst) && !run.preparing.load(Ordering::SeqCst) {
            let _ = self.finish_prestart(run, wake.clone(), None);
        }
        let confirmed = if run
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cleanup_state
            == "confirmed"
        {
            true
        } else if let Some(cleanup) = self
            .registry
            .cancel(&run.origin.task_id, &run.origin.run_id)
        {
            cleanup
                .wait(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT)
                .is_ok()
        } else {
            false
        };
        self.record_cleanup(run, confirmed);
        if confirmed && run.start_claimed.load(Ordering::SeqCst) {
            let outcome = run
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .worker_outcome
                .clone();
            if let Some(outcome) = outcome {
                if Publisher::new(self.clone(), run.clone(), wake)
                    .finish(outcome)
                    .is_err()
                {
                    run.journal_failed.store(true, Ordering::SeqCst);
                }
            }
        }
        confirmed
    }
    pub fn stop(
        self: &Arc<Self>,
        packet: ParsedRecoveryRequest<StopRequest>,
        wake: WakeSink,
    ) -> Result<OutcomeReply<ControlReceipt>, RecoveryError> {
        let backend = self.backend()?;
        // Durable binding conflicts are checked before cancellation or joining.
        match backend.query_control(&packet) {
            Ok(prior) if prior.receipt.is_some() || prior.rejection.is_some() => {
                if let Some(receipt) = &prior.receipt {
                    self.reconcile_control(receipt);
                }
                return Ok(self.outcome(prior, "analysis_control", &packet.request.journal_id));
            }
            Ok(_) => {}
            Err(error) if error.code == "analysis_storage_unavailable" => {}
            Err(error) => return Err(error),
        }
        let run = self.exact_session(&packet.request.origin, &packet.request.journal_id)?;
        let attempt = {
            let mut attempts = run.attempts.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(old) = attempts.get(&packet.request.request_id) {
                if old.digest != packet.digest {
                    return Err(RecoveryError::fixed("analysis_request_conflict"));
                }
                let old = old.clone();
                drop(attempts);
                let mut result = old.result.lock().unwrap_or_else(|e| e.into_inner());
                while result.is_none() {
                    result = old.changed.wait(result).unwrap_or_else(|e| e.into_inner());
                }
                let metadata = result.as_ref().unwrap().clone();
                drop(result);
                return metadata.map(|m| self.control_reply(m, &run.journal_id));
            }
            if attempts.len() >= OUTCOME_CAP {
                return Err(RecoveryError::fixed("analysis_limit_exceeded"));
            }
            let attempt = Arc::new(ControlAttempt {
                digest: packet.digest.clone(),
                result: Mutex::new(None),
                changed: Condvar::new(),
            });
            attempts.insert(packet.request.request_id.clone(), attempt.clone());
            attempt
        };
        let result: Result<ControlMetadata, RecoveryError> = (|| {
            let (flight, leader) = {
                let mut slot = run.cleanup_flight.lock().unwrap_or_else(|e| e.into_inner());
                let state = run.state.lock().unwrap_or_else(|e| e.into_inner());
                let retry = packet.request.mode == "retry_cleanup";
                if retry
                    && (packet.request.expected_control_revision.as_deref()
                        != Some(state.control_revision.as_str())
                        || state.control_unknown
                        || state
                            .latest_control
                            .as_ref()
                            .is_none_or(|r| r.outcome != "cleanup_incomplete")
                        || slot.as_ref().is_some_and(|f| {
                            f.result.lock().unwrap_or_else(|e| e.into_inner()).is_none()
                        }))
                {
                    return Err(RecoveryError::fixed("analysis_conflict"));
                }
                if !retry && slot.is_some() {
                    (slot.as_ref().unwrap().clone(), false)
                } else {
                    let flight = Arc::new(CleanupFlight {
                        attempt: Some(ControlAttemptWitness {
                            request_id: packet.request.request_id.clone(),
                            digest: packet.digest.clone(),
                        }),
                        result: Mutex::new(None),
                        changed: Condvar::new(),
                    });
                    *slot = Some(flight.clone());
                    (flight, true)
                }
            };
            if leader {
                let confirmed = self.perform_cleanup(&run, wake);
                *flight.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ok(confirmed));
                flight.changed.notify_all();
            }
            let confirmed = {
                let mut result = flight.result.lock().unwrap_or_else(|e| e.into_inner());
                while result.is_none() {
                    result = flight
                        .changed
                        .wait(result)
                        .unwrap_or_else(|e| e.into_inner());
                }
                result.as_ref().unwrap().clone()?
            };
            let _record = run.control_record.lock().unwrap_or_else(|e| e.into_inner());
            {
                let mut state = run.state.lock().unwrap_or_else(|e| e.into_inner());
                state.control_pending = Some(ControlAttemptWitness {
                    request_id: packet.request.request_id.clone(),
                    digest: packet.digest.clone(),
                });
                state.control_unknown = true;
            }
            self.changed();
            let result = backend.record_control(
                &packet,
                &ControlRecord {
                    outcome: if confirmed {
                        "cleanup_confirmed"
                    } else {
                        "cleanup_incomplete"
                    }
                    .into(),
                    observed_at: observed_at()?,
                },
            )?;
            if let Some(receipt) = &result.receipt {
                self.reconcile_control(receipt);
            } else if result.rejection.is_some() {
                let mut state = run.state.lock().unwrap_or_else(|e| e.into_inner());
                state.control_pending = None;
                state.control_unknown = false;
                drop(state);
                self.changed();
            }
            Ok(ControlMetadata {
                receipt: result.receipt,
                rejection: result.rejection,
            })
        })();
        *attempt.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        attempt.changed.notify_all();
        let _ = self.refresh();
        result.map(|m| self.control_reply(m, &run.journal_id))
    }
    pub fn automatic_cleanup(
        self: &Arc<Self>,
        run: &Arc<Session>,
        confirmed: bool,
    ) -> Result<(), RecoveryError> {
        self.record_cleanup(run, confirmed);
        let confirmed = run
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cleanup_state
            == "confirmed";
        // A worker/prestart finalizer contributes observed cleanup truth to an
        // explicit pending flight. It must never join/wait on that caller: the
        // caller can be waiting for this same worker's readers or finalization.
        if Self::has_pending_control(run) {
            return Ok(());
        }
        let (flight, leader) = {
            let mut slot = run.cleanup_flight.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(flight) = slot.as_ref() {
                if flight
                    .result
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_none()
                {
                    return Ok(());
                }
                (flight.clone(), false)
            } else {
                let flight = Arc::new(CleanupFlight {
                    attempt: None,
                    result: Mutex::new(None),
                    changed: Condvar::new(),
                });
                *slot = Some(flight.clone());
                (flight, true)
            }
        };
        let result: Result<bool, RecoveryError> = (|| {
            let _record = run.control_record.lock().unwrap_or_else(|e| e.into_inner());
            let raw = serde_json::to_string(&StopRequest {
                recovery_protocol_version: PROTOCOL_VERSION,
                request_id: format!("cleanup:{}", run.journal_id),
                origin: run.origin.clone(),
                journal_id: run.journal_id.clone(),
                mode: "stop".into(),
                expected_control_revision: None,
            })
            .map_err(|_| RecoveryError::invalid())?;
            let packet = parser::parse::<StopRequest>(&raw)?;
            {
                let mut state = run.state.lock().unwrap_or_else(|e| e.into_inner());
                state.control_pending = Some(ControlAttemptWitness {
                    request_id: packet.request.request_id.clone(),
                    digest: packet.digest.clone(),
                });
                state.control_unknown = true;
            }
            self.changed();
            let result = self.backend()?.record_control(
                &packet,
                &ControlRecord {
                    outcome: if confirmed {
                        "cleanup_confirmed"
                    } else {
                        "cleanup_incomplete"
                    }
                    .into(),
                    observed_at: observed_at()?,
                },
            )?;
            if let Some(receipt) = result.receipt {
                self.reconcile_control(&receipt);
            }
            Ok(confirmed)
        })();
        if leader || confirmed {
            // A completed owned-handle join can upgrade an earlier physical
            // observation. Historical SQL failure receipts remain immutable.
            *flight.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ok(confirmed));
            flight.changed.notify_all();
        }
        let _ = self.refresh();
        result.map(|_| ())
    }
}

/// Bounded line framing retains exact JSON bytes until strict parsing. Oversized
/// lines are discarded in bounded chunks, with one fixed failure publication.
fn consume_stream(
    mut input: impl std::io::Read,
    publisher: &Publisher,
    stream: &str,
) -> Result<(), RecoveryError> {
    use std::io::{BufRead, BufReader};
    let mut reader = BufReader::new(&mut input);
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let bytes = reader
            .fill_buf()
            .map_err(|_| RecoveryError::fixed("analysis_reader_failed"))?;
        if bytes.is_empty() {
            if !line.is_empty() && !oversized {
                consume_line(&line, publisher, stream)?;
            }
            return Ok(());
        }
        let newline = bytes.iter().position(|b| *b == b'\n');
        let count = newline.map(|n| n + 1).unwrap_or(bytes.len());
        if !publisher.run.fatal_publication.load(Ordering::SeqCst) && !oversized {
            if line
                .len()
                .checked_add(count)
                .is_none_or(|n| n > PACKET_BYTES)
            {
                line.clear();
                oversized = true;
                let _ = publisher.hard_failure("limit_exceeded");
            } else {
                line.extend_from_slice(&bytes[..count]);
            }
        }
        reader.consume(count);
        if newline.is_some() {
            if !oversized && !line.is_empty() {
                consume_line(&line, publisher, stream)?;
            }
            line.clear();
            oversized = false;
        }
    }
}
fn consume_line(bytes: &[u8], publisher: &Publisher, stream: &str) -> Result<(), RecoveryError> {
    if publisher.run.fatal_publication.load(Ordering::SeqCst) {
        return Ok(());
    }
    let raw =
        std::str::from_utf8(bytes).map_err(|_| RecoveryError::fixed("analysis_reader_failed"))?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    if stream == "stderr" {
        // Arbitrary exception text, file paths and raw diagnostics are transient.
        // They cannot become durable research provenance or leak credentials.
        publisher.event(&serde_json::json!({"type":"message","messageType":"stderr","message":"Analysis runner emitted diagnostic output."}))
    } else {
        match parser::raw_json(raw, PACKET_BYTES) {
            Ok(event) => publisher.event(&event),
            Err(_) => publisher.hard_failure("malformed"),
        }
    }
}
fn spawn_reader(
    input: impl std::io::Read + Send + 'static,
    publisher: Publisher,
    stream: &'static str,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            consume_stream(input, &publisher, stream)
        }));
        let failed = !matches!(outcome, Ok(Ok(())));
        let _ = publisher.reader(stream, failed);
    })
}
/// The same owned-process path is used by the desktop runner and fictional
/// fixtures. All output is durably admitted before a wake notification.
pub fn run_owned_worker(
    mut execution: RunGuard,
    publisher: Publisher,
    mut command: std::process::Command,
    input: String,
) {
    use std::io::Write;
    use std::process::Stdio;
    let observation = execution.ownership();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || -> Result<bool, RecoveryError> {
            if execution.cancelled() {
                return Ok(false);
            }
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut process = match crate::owned_process::OwnedProcess::spawn_owned(
                command,
                Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT,
            ) {
                Ok(process) => process,
                Err(failure) => {
                    if let Some(pending) = failure.pending {
                        execution
                            .attach(pending)
                            .map_err(|_| RecoveryError::fixed("analysis_cleanup_incomplete"))?;
                    }
                    return Err(RecoveryError::fixed("analysis_start_failed"));
                }
            };
            let stdin = process.child.stdin.take();
            let stdout = process.child.stdout.take();
            let stderr = process.child.stderr.take();
            execution
                .attach(process)
                .map_err(|_| RecoveryError::fixed("analysis_cleanup_incomplete"))?;
            if let Some(stdout) = stdout {
                execution.reader(spawn_reader(stdout, publisher.clone(), "stdout"));
            }
            if let Some(stderr) = stderr {
                execution.reader(spawn_reader(stderr, publisher.clone(), "stderr"));
            }
            publisher.coordinator.mark_running(&publisher.run);
            if execution.cancelled() {
                return Ok(false);
            }
            // Never hold the process mutex while writing a potentially blocked pipe.
            let mut stdin = stdin.ok_or_else(|| RecoveryError::fixed("analysis_start_failed"))?;
            stdin
                .write_all(input.as_bytes())
                .map_err(|_| RecoveryError::fixed("analysis_start_failed"))?;
            drop(stdin);
            loop {
                if execution.cancelled() {
                    return Ok(false);
                }
                if let Some(status) = execution
                    .try_wait()
                    .map_err(|_| RecoveryError::fixed("analysis_worker_failed"))?
                {
                    return Ok(status.success());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        },
    ));
    let finish = execution.finish(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT);
    let confirmed = !observation.retained();
    let reader_failed=publisher.run.reader_failed.load(Ordering::SeqCst)||finish.as_ref().is_err_and(|e|e!="Analysis cleanup incomplete. Retry stopping the task before starting another analysis.");
    let outcome = match result {
        Err(_) => WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some("analysis_worker_failed".into()),
        },
        Ok(Err(error)) => WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some(
                if error.code == "analysis_start_failed" {
                    "analysis_start_failed"
                } else {
                    "analysis_worker_failed"
                }
                .into(),
            ),
        },
        Ok(Ok(_)) if reader_failed => WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some("analysis_worker_failed".into()),
        },
        Ok(Ok(_)) if publisher.run.cancelled.load(Ordering::SeqCst) => WorkerOutcomePayload {
            outcome: "cancelled".into(),
            code: None,
        },
        Ok(Ok(false)) => WorkerOutcomePayload {
            outcome: "failed".into(),
            code: Some("analysis_worker_failed".into()),
        },
        Ok(Ok(true)) => WorkerOutcomePayload {
            outcome: "succeeded".into(),
            code: if publisher.run.terminal_observed.load(Ordering::SeqCst) {
                None
            } else {
                Some("analysis_missing_terminal".into())
            },
        },
    };
    publisher
        .coordinator
        .set_worker_outcome(&publisher.run, outcome.clone());
    if confirmed && publisher.finish(outcome).is_err() {
        publisher.run.journal_failed.store(true, Ordering::SeqCst);
    }
    let _ = publisher
        .coordinator
        .automatic_cleanup(&publisher.run, confirmed);
}

pub fn joined_worker_failed(
    publisher: Publisher,
    observation: crate::analysis_execution::OwnershipObservation,
) {
    let confirmed = if let Some(cleanup) = publisher
        .coordinator
        .registry
        .cancel(&publisher.run.origin.task_id, &publisher.run.origin.run_id)
    {
        cleanup
            .wait(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT)
            .is_ok()
    } else {
        !observation.retained()
    };
    let outcome = WorkerOutcomePayload {
        outcome: "failed".into(),
        code: Some("analysis_worker_failed".into()),
    };
    publisher
        .coordinator
        .set_worker_outcome(&publisher.run, outcome.clone());
    if confirmed {
        let _ = publisher.finish(outcome);
    }
    let _ = publisher
        .coordinator
        .automatic_cleanup(&publisher.run, confirmed);
}
#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

impl Coordinator {
    /// Shared command helper: neither a fixture transport nor the desktop IPC
    /// may duplicate launch/admission state decisions.
    pub fn start(
        self: &Arc<Self>,
        packet: ParsedRecoveryRequest<StartRequest>,
        input: Value,
        wake: WakeSink,
        launch: impl FnOnce(RunGuard, Publisher, Value) -> Result<(), RecoveryError>,
    ) -> Result<OutcomeReply<StartReceipt>, RecoveryError> {
        let backend = self.backend()?;
        let prior = backend.query_start(&packet)?;
        if prior.receipt.is_some() || prior.rejection.is_some() {
            return Ok(self.outcome(prior, "analysis_start", &packet.request.journal_id));
        }
        #[cfg(any(test, feature = "desktop-acceptance"))]
        if self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .admission_closed
        {
            return Err(RecoveryError::fixed("analysis_busy"));
        }
        let run = self.exact_session(&packet.request.origin, &packet.request.journal_id)?;
        publication::input_matches_context(&input, &run.context)?;
        let accepted = backend.accept_start(&packet)?;
        if accepted.receipt.is_some() && !run.start_claimed.load(Ordering::SeqCst) {
            let execution = self.claim_start(&run, &packet.request)?;
            let observation = execution.ownership();
            let publisher = Publisher::new(self.clone(), run, wake);
            let failed = publisher.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                launch(execution, publisher, input)
            }));
            if !matches!(result, Ok(Ok(()))) {
                joined_worker_failed(failed, observation);
            }
        }
        Ok(self.outcome(accepted, "analysis_start", &packet.request.journal_id))
    }
}

pub fn worker_failed_before_spawn(mut execution: RunGuard, publisher: Publisher, code: &str) {
    let observation = execution.ownership();
    let _ = execution.finish(Instant::now() + crate::analysis_execution::CLEANUP_TIMEOUT);
    let confirmed = !observation.retained();
    let outcome = WorkerOutcomePayload {
        outcome: "failed".into(),
        code: Some(
            if code == "analysis_start_failed" {
                "analysis_start_failed"
            } else {
                "analysis_worker_failed"
            }
            .into(),
        ),
    };
    publisher
        .coordinator
        .set_worker_outcome(&publisher.run, outcome.clone());
    if confirmed {
        let _ = publisher.finish(outcome);
    }
    let _ = publisher
        .coordinator
        .automatic_cleanup(&publisher.run, confirmed);
}

impl Coordinator {
    pub fn project(
        self: &Arc<Self>,
        packet: ParsedRecoveryRequest<ProjectionRequest>,
    ) -> Result<OutcomeReply<ProjectionReceipt>, RecoveryError> {
        let backend = self.backend()?;
        let prior = backend.query_projection(&packet)?;
        if prior.receipt.is_some() || prior.rejection.is_some() {
            return Ok(self.outcome(prior, "analysis_projection_sql", &packet.request.journal_id));
        }
        let run = self.exact_session(&packet.request.origin, &packet.request.journal_id)?;
        if run.binding != packet.request.binding {
            return Err(RecoveryError::fixed("analysis_stale_origin"));
        }
        let result = backend.project(&packet)?;
        let _ = self.refresh();
        Ok(self.outcome(
            result,
            "analysis_projection_sql",
            &packet.request.journal_id,
        ))
    }
}

fn current_read_error(error: RecoveryError) -> RecoveryError {
    if [
        "analysis_storage_unavailable",
        "analysis_observation_changed",
        "analysis_limit_exceeded",
    ]
    .contains(&error.code.as_str())
    {
        RecoveryError::fixed(&error.code)
    } else {
        RecoveryError::unavailable()
    }
}
