use crate::storage::task_mutation::{CollectionToken, StorageAuthority, TaskHead};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
pub const CONTROL_BYTES: usize = 64 * 1024;
pub const CONTEXT_BYTES: usize = 64 * 1024;
pub const INPUT_BYTES: usize = 512 * 1024;
pub const PACKET_BYTES: usize = 256 * 1024 * 1024;
pub const TEXT_BYTES: usize = 8 * 1024 * 1024;
pub const SCALAR_BYTES: usize = 4096;
pub const MAX_DEPTH: usize = 64;
pub const MAX_COUNTER: u64 = i64::MAX as u64;
pub const MAX_SAFE_NUMBER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecoveryError {
    pub code: String,
    pub message: String,
}
impl RecoveryError {
    pub fn fixed(code: &str) -> Self {
        let message = match code {
            "analysis_invalid_request" => "Analysis invalid request.",
            "analysis_identity_unavailable" => "Analysis identity unavailable.",
            "analysis_busy" => "Analysis busy.",
            "analysis_stale_origin" => "Analysis stale origin.",
            "analysis_conflict" => "Analysis conflict.",
            "analysis_request_conflict" => "Analysis request conflict.",
            "analysis_admission_unknown" => "Analysis admission unknown.",
            "analysis_start_unknown" => "Analysis start unknown.",
            "analysis_cleanup_incomplete" => "Analysis cleanup incomplete.",
            "analysis_projection_unknown" => "Analysis projection unknown.",
            "analysis_storage_unavailable" => "Analysis storage unavailable.",
            "analysis_journal_gap" => "Analysis journal gap.",
            "analysis_journal_corrupt" => "Analysis journal corrupt.",
            "analysis_publication_unavailable" => "Analysis publication unavailable.",
            "analysis_limit_exceeded" => "Analysis limit exceeded.",
            "analysis_counter_exhausted" => "Analysis counter exhausted.",
            "analysis_interrupted" => "Analysis interrupted.",
            "analysis_partial_clear" => "Analysis partial clear.",
            "analysis_observation_changed" => "Analysis observation changed.",
            "analysis_reader_failed" => "Analysis reader failed.",
            "analysis_worker_failed" => "Analysis worker failed.",
            "analysis_start_failed" => "Analysis start failed.",
            "analysis_reservation_expired" => "Analysis reservation expired.",
            "analysis_missing_terminal" => "Analysis missing terminal.",
            "analysis_empty_result" => "Analysis completed without report content.",
            "analysis_journal_body_unavailable" => "Analysis journal body unavailable.",
            _ => return Self::invalid(),
        };
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn invalid() -> Self {
        Self::fixed("analysis_invalid_request")
    }
    pub fn unavailable() -> Self {
        Self::fixed("analysis_storage_unavailable")
    }
}
impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RecoveryError {}

#[derive(Clone, Debug)]
pub struct ParsedRecoveryRequest<T> {
    pub original: Value,
    pub digest: String,
    pub request: T,
}

macro_rules! dto {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    };
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunIdentity {
    pub runtime_epoch: String,
    pub task_id: String,
    pub run_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunBinding {
    pub collection: CollectionToken,
    pub task_id: String,
    pub generation: String,
}
dto!(ProtocolRequest {
    recovery_protocol_version: u8
});
dto!(AdmissionRequest {
    recovery_protocol_version: u8,
    request_id: String,
    runtime_epoch: String,
    collection: CollectionToken,
    expected_head: TaskHead,
    context: Value
});
dto!(JournalHeader {
    recovery_protocol_version: u8,
    journal_id: String,
    origin: RunIdentity,
    binding: RunBinding,
    reserved_head: TaskHead,
    admission_request_id: String,
    admission_digest: String,
    header_digest: String,
    accepted_at: String,
    context: Value
});
dto!(AdmissionReceipt {
    recovery_protocol_version: u8,
    request_id: String,
    digest: String,
    origin: RunIdentity,
    journal_id: String,
    binding: RunBinding,
    header_digest: String,
    accepted_seq: String,
    sql_committed: bool
});
dto!(StartRequest {
    recovery_protocol_version: u8,
    request_id: String,
    origin: RunIdentity,
    journal_id: String,
    binding: RunBinding,
    header_digest: String
});
dto!(StartReceipt {
    recovery_protocol_version: u8,
    request_id: String,
    digest: String,
    origin: RunIdentity,
    journal_id: String,
    binding: RunBinding,
    accepted: bool,
    sql_committed: bool
});
dto!(StopRequest {
    recovery_protocol_version: u8, request_id: String, origin: RunIdentity,
    journal_id: String, mode: String, expected_control_revision: Option<String>
});
dto!(ControlReceipt {
    recovery_protocol_version: u8,
    request_id: String,
    digest: String,
    origin: RunIdentity,
    journal_id: String,
    control_revision: String,
    outcome: String,
    sql_committed: bool
});
dto!(EventSeed {
    updated_at: String, log_id: String, log_timestamp: String,
    completion_version_id: Option<String>, completion_created_at: Option<String>
});
dto!(JournalEnvelope {
    recovery_protocol_version: u8,
    journal_id: String,
    origin: RunIdentity,
    binding: RunBinding,
    seq: String,
    kind: String,
    observed_at: String,
    payload: Value,
    seed: EventSeed,
    payload_digest: String
});
dto!(PublicationIssue {
    channel: String,
    reason: String
});
dto!(UnavailablePayload {
    source_type: Option<String>, channels: Vec<PublicationIssue>, outcome: String,
    code: String, safe_analysis: Option<Value>
});
dto!(ReaderOutcomePayload { stream: String, outcome: String, code: Option<String> });
dto!(WorkerOutcomePayload { outcome: String, code: Option<String> });
dto!(JournalSummary {
    journal_id: String, origin: RunIdentity, binding: RunBinding, body_state: String,
    latest_seq: String, applied_seq: String, sealed_through_seq: Option<String>,
    control_revision: String, worker_outcome: Option<String>, cleanup_state: String,
    result_state: String, history_state: String
});
dto!(NativeOwner {
    origin: RunIdentity,
    admission_request_id: String,
    admission_digest: String,
    journal_id: String,
    binding: RunBinding,
    phase: String,
    control_revision: String,
    cleanup_state: String
});
dto!(RuntimeBlocker { code: String, origin: Option<RunIdentity>, journal_id: Option<String> });
dto!(RuntimeObservation {
    recovery_protocol_version: u8, initialization: String, runtime_epoch: Option<String>,
    observation_revision: String, owner: Option<NativeOwner>, runtime_gate: String,
    journal_gate: String, blockers: Vec<RuntimeBlocker>
});

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryCurrent {
    Coherent {
        storage: StorageAuthority,
        task: Option<Value>,
        head: Option<TaskHead>,
        journal: Option<JournalSummary>,
        runtime: Box<RuntimeObservation>,
    },
    Unavailable {
        error: RecoveryError,
        runtime: RuntimeObservation,
    },
}
dto!(RecoverySnapshotStorage {
    collection: CollectionToken, heads: Vec<TaskHead>, legacy_task_import_allowed: bool
});
dto!(ClearBlocker {
    request_id: String,
    digest: String,
    collection: CollectionToken,
    status: String,
    code: String
});
dto!(RecoverySnapshot {
    recovery_protocol_version: u8, storage: RecoverySnapshotStorage, tasks: Vec<Value>,
    journals: Vec<JournalSummary>, clear_blockers: Vec<ClearBlocker>,
    runtime: RuntimeObservation, coherent: bool
});
dto!(ReadRequest {
    recovery_protocol_version: u8, journal_id: String, origin: RunIdentity,
    binding: RunBinding, after_seq: String, through_seq: Option<String>, limit: u8
});
dto!(RangeProof {
    from_seq: String,
    through_seq: String,
    digest: String
});
dto!(ReadReply {
    recovery_protocol_version: u8, header: JournalHeader, summary: JournalSummary,
    after_seq: String, through_seq: String, last_seq: String, has_more: bool,
    rows: Vec<JournalEnvelope>, range_proof: Option<RangeProof>
});
dto!(ProjectionBody { task: Value });
dto!(ProjectionRequest {
    recovery_protocol_version: u8,
    request_id: String,
    journal_id: String,
    origin: RunIdentity,
    binding: RunBinding,
    expected_head: TaskHead,
    expected_applied_seq: String,
    through_seq: String,
    range_digest: String,
    projection: ProjectionBody
});
dto!(ProjectionReceipt {
    recovery_protocol_version: u8,
    request_id: String,
    digest: String,
    journal_id: String,
    origin: RunIdentity,
    binding: RunBinding,
    from_seq: String,
    through_seq: String,
    range_digest: String,
    head: TaskHead,
    sql_committed: bool
});
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutcomeReply<T> {
    pub recovery_protocol_version: u8,
    pub scope: String,
    pub receipt: Option<T>,
    pub rejection: Option<RecoveryError>,
    pub current: RecoveryCurrent,
}
dto!(MatchedReservation {
    request_id: String, digest: String, origin: RunIdentity,
    journal_id: String, binding: RunBinding, header_digest: Option<String>
});
dto!(AdmissionOutcomeReply {
    recovery_protocol_version: u8, scope: String, receipt: Option<AdmissionReceipt>,
    rejection: Option<RecoveryError>, matched_reservation: Option<MatchedReservation>,
    current: RecoveryCurrent
});
dto!(WakeNotice {
    recovery_protocol_version: u8,
    journal_id: String,
    origin: RunIdentity,
    latest_seq: String,
    control_revision: String
});

/// Count the complete compact JSON serialization, including all wrapper fields,
/// without allocating a second copy of a potentially large research body.
pub fn check_reply_bytes(value: &impl Serialize, limit: usize) -> Result<(), RecoveryError> {
    struct Counter {
        bytes: usize,
        limit: usize,
        exceeded: bool,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let next = self.bytes.checked_add(bytes.len());
            if next.is_none_or(|n| n > self.limit) {
                self.exceeded = true;
                return Err(std::io::Error::other("recovery reply limit"));
            }
            self.bytes = next.unwrap();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        limit,
        exceeded: false,
    };
    serde_json::to_writer(&mut counter, value).map_err(|_| {
        if counter.exceeded {
            RecoveryError::fixed("analysis_limit_exceeded")
        } else {
            RecoveryError::unavailable()
        }
    })
}
pub trait ReplyBoundary: Serialize + Sized {
    fn fit(self, limit: usize) -> Result<Self, RecoveryError> {
        check_reply_bytes(&self, limit)?;
        Ok(self)
    }
}
impl ReplyBoundary for RuntimeObservation {}
impl ReplyBoundary for RecoverySnapshot {}
impl ReplyBoundary for ReadReply {}
impl ReplyBoundary for () {}
fn unavailable_limit(current: &RecoveryCurrent) -> RecoveryCurrent {
    let runtime = match current {
        RecoveryCurrent::Coherent { runtime, .. } => runtime.as_ref().clone(),
        RecoveryCurrent::Unavailable { runtime, .. } => runtime.clone(),
    };
    RecoveryCurrent::Unavailable {
        error: RecoveryError::fixed("analysis_limit_exceeded"),
        runtime,
    }
}
impl<T: Serialize> ReplyBoundary for OutcomeReply<T> {
    fn fit(mut self, limit: usize) -> Result<Self, RecoveryError> {
        if let Err(error) = check_reply_bytes(&self, limit) {
            if error.code != "analysis_limit_exceeded" {
                return Err(error);
            }
            self.current = unavailable_limit(&self.current);
        }
        check_reply_bytes(&self, limit)?;
        Ok(self)
    }
}
impl ReplyBoundary for AdmissionOutcomeReply {
    fn fit(mut self, limit: usize) -> Result<Self, RecoveryError> {
        if let Err(error) = check_reply_bytes(&self, limit) {
            if error.code != "analysis_limit_exceeded" {
                return Err(error);
            }
            self.current = unavailable_limit(&self.current);
        }
        check_reply_bytes(&self, limit)?;
        Ok(self)
    }
}
// The owned JSONL bridge serializes these same typed replies into Value. It
// applies the same boundary and preserves known outcomes; no gate logic lives here.
impl ReplyBoundary for Value {
    fn fit(mut self, limit: usize) -> Result<Self, RecoveryError> {
        if let Err(error) = check_reply_bytes(&self, limit) {
            if error.code != "analysis_limit_exceeded" {
                return Err(error);
            }
            if self.get("receipt").is_some() && self.get("rejection").is_some() {
                if let Some(runtime) = self.get("current").and_then(|c| c.get("runtime")).cloned() {
                    self["current"] = serde_json::json!({"state":"unavailable","error":RecoveryError::fixed("analysis_limit_exceeded"),"runtime":runtime});
                }
            }
        }
        check_reply_bytes(&self, limit)?;
        Ok(self)
    }
}
pub fn fit_reply<T: ReplyBoundary>(value: T) -> Result<T, RecoveryError> {
    value.fit(PACKET_BYTES)
}
