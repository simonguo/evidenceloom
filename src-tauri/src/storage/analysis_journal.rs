//! Durable research output authority. Every effect is fenced by the original
//! SQL incarnation and packet; this module never acquires a process mutex.
use super::*;
use crate::analysis_recovery::publication;
use crate::analysis_recovery::wire::*;
use rusqlite::{Transaction, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde_json::json;
use sha2::{Digest, Sha256};

const MAX_REPLY: usize = 256 * 1024 * 1024;
const MAX_ENVELOPE: usize = 240 * 1024 * 1024;
const PAGE_SOFT: usize = 4 * 1024 * 1024;
const RUN_BYTES: i64 = 1024 * 1024 * 1024;
const RUN_ROWS: i64 = 100_000;
const TERMINAL_BYTES: i64 = 256 * 1024;
const TERMINAL_ROWS: i64 = 8;

pub struct SqlCurrent {
    pub storage: task_mutation::StorageAuthority,
    pub task: Option<AnalysisTaskRecord>,
    pub head: Option<task_mutation::TaskHead>,
    pub journal: Option<JournalSummary>,
}
pub struct SqlRecoveryCut {
    pub storage: task_mutation::SnapshotStorage,
    pub tasks: Vec<AnalysisTaskRecord>,
    pub journals: Vec<JournalSummary>,
    pub clear_blockers: Vec<ClearBlocker>,
}
pub struct SqlOutcome<T> {
    pub receipt: Option<T>,
    pub rejection: Option<RecoveryError>,
    pub current: Result<SqlCurrent, RecoveryError>,
}
#[derive(Clone)]
pub struct AdmissionSeed {
    pub origin: RunIdentity,
    pub journal_id: String,
    pub accepted_at: String,
}
#[derive(Clone)]
pub struct PublicationDraft {
    pub journal_id: String,
    pub origin: RunIdentity,
    pub binding: RunBinding,
    pub kind: String,
    pub observed_at: String,
    pub payload: Value,
}
#[derive(Clone)]
pub struct SealRecord {
    pub journal_id: String,
    pub origin: RunIdentity,
    pub binding: RunBinding,
    pub worker_outcome: WorkerOutcomePayload,
}
#[derive(Clone)]
pub struct ControlRecord {
    pub outcome: String,
    pub observed_at: String,
}

pub fn error(code: &str) -> RecoveryError {
    RecoveryError::fixed(code)
}
fn unavailable<T>(_: T) -> RecoveryError {
    error("analysis_storage_unavailable")
}
fn invalid(_: impl std::fmt::Display) -> RecoveryError {
    error("analysis_invalid_request")
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T, RecoveryError> {
    serde_json::from_value(value).map_err(invalid)
}
fn encoded(value: &impl Serialize) -> Result<String, RecoveryError> {
    serde_json::to_string(value).map_err(unavailable)
}
fn value(value: &impl Serialize) -> Result<Value, RecoveryError> {
    serde_json::to_value(value).map_err(unavailable)
}
fn hash(value: &Value) -> Result<String, RecoveryError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(memory::canonical_json(value).map_err(invalid)?.as_bytes())
    ))
}
fn domain_hash(domain: &str, value: &Value) -> Result<String, RecoveryError> {
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update(b"\n");
    hash.update(memory::canonical_json(value).map_err(invalid)?.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}
fn counter(value: &Value) -> Result<i64, RecoveryError> {
    let s = value
        .as_str()
        .ok_or_else(|| error("analysis_invalid_request"))?;
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(error("analysis_invalid_request"));
    }
    s.parse().map_err(|_| error("analysis_counter_exhausted"))
}
fn next(n: i64) -> Result<i64, RecoveryError> {
    n.checked_add(1)
        .ok_or_else(|| error("analysis_counter_exhausted"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, RecoveryError> {
    v[key]
        .as_str()
        .ok_or_else(|| error("analysis_invalid_request"))
}
fn immediate(conn: &Connection) -> Result<Transaction<'_>, RecoveryError> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(unavailable)
}
fn deferred(conn: &Connection) -> Result<Transaction<'_>, RecoveryError> {
    Transaction::new_unchecked(conn, TransactionBehavior::Deferred).map_err(unavailable)
}
fn bounded(value: &impl Serialize) -> Result<(), RecoveryError> {
    if encoded(value)?.len() > MAX_REPLY {
        return Err(error("analysis_limit_exceeded"));
    }
    Ok(())
}

pub fn initialize(conn: &Connection, previous: u32, _pristine: bool) -> Result<(), RecoveryError> {
    let tables = [
        "analysis_journals",
        "analysis_events",
        "analysis_controls",
        "analysis_requests",
    ];
    let mut present = 0;
    for table in tables {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        present += usize::from(exists);
    }
    if (present != 0 || previous >= 12) && present != 4 {
        return Err(error("analysis_storage_unavailable"));
    }
    if present == 0 {
        // A complete existing journal is validated below, never recreated.
        // A partial journal is unavailable at every version.
        conn.execute_batch("CREATE TABLE analysis_journals (
            journal_id TEXT PRIMARY KEY, origin_json TEXT NOT NULL, binding_json TEXT NOT NULL,
            header_json TEXT, latest_seq INTEGER NOT NULL DEFAULT 0 CHECK(typeof(latest_seq)='integer' AND latest_seq>=0),
            applied_seq INTEGER NOT NULL DEFAULT 0 CHECK(typeof(applied_seq)='integer' AND applied_seq>=0 AND applied_seq<=latest_seq),
            sealed_seq INTEGER CHECK(sealed_seq IS NULL OR (typeof(sealed_seq)='integer' AND sealed_seq>0 AND sealed_seq<=latest_seq)),
            control_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(control_revision)='integer' AND control_revision>=0),
            worker_outcome TEXT CHECK(worker_outcome IS NULL OR worker_outcome IN ('succeeded','failed','cancelled','not_started')),
            cleanup_state TEXT NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','confirmed','failed','unknown')),
            result_state TEXT NOT NULL DEFAULT 'unsealed' CHECK(result_state IN ('unsealed','pending','projected','failed_projection','unknown','discarded')),
            history_state TEXT NOT NULL DEFAULT 'current' CHECK(history_state IN ('current','historical','interrupted','discarded')),
            body_state TEXT NOT NULL DEFAULT 'available' CHECK(body_state IN ('available','purged','unavailable')),
            payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(payload_bytes)='integer' AND payload_bytes>=0),
            research_rows INTEGER NOT NULL DEFAULT 0 CHECK(typeof(research_rows)='integer' AND research_rows>=0),
            terminal_rows INTEGER NOT NULL DEFAULT 0 CHECK(typeof(terminal_rows)='integer' AND terminal_rows>=0),
            terminal_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(terminal_bytes)='integer' AND terminal_bytes>=0),
            critical_seq INTEGER CHECK(critical_seq IS NULL OR (typeof(critical_seq)='integer' AND critical_seq>0 AND critical_seq<=latest_seq)),
            terminal_observed INTEGER NOT NULL DEFAULT 0 CHECK(terminal_observed IN (0,1)),
            projection_failure_code TEXT, projection_completed INTEGER NOT NULL DEFAULT 0 CHECK(projection_completed IN (0,1)));
            CREATE TABLE analysis_events (
            journal_id TEXT NOT NULL REFERENCES analysis_journals(journal_id),
            seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0), envelope_json TEXT NOT NULL,
            PRIMARY KEY(journal_id,seq));
            CREATE TABLE analysis_controls (
            journal_id TEXT NOT NULL REFERENCES analysis_journals(journal_id),
            revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
            outcome TEXT NOT NULL CHECK(outcome IN ('cleanup_confirmed','cleanup_incomplete')),
            observed_at TEXT NOT NULL, PRIMARY KEY(journal_id,revision));
            CREATE TABLE analysis_requests (
            request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('admission','start','projection','control')),
            journal_id TEXT NOT NULL, origin_json TEXT NOT NULL, binding_json TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('pending','committed','rejected')),
            receipt_json TEXT, rejection_json TEXT,
            CHECK((outcome='pending' AND receipt_json IS NULL AND rejection_json IS NULL)
             OR (outcome='committed' AND receipt_json IS NOT NULL AND rejection_json IS NULL)
             OR (outcome='rejected' AND receipt_json IS NULL AND rejection_json IS NOT NULL)));")
            .map_err(unavailable)?;
    }
    // Preparing each query also detects missing columns in an existing schema.
    conn.prepare("SELECT request_id,digest,kind,journal_id,origin_json,binding_json,outcome,receipt_json,rejection_json FROM analysis_requests").map_err(unavailable)?;
    conn.prepare("SELECT journal_id,seq,envelope_json FROM analysis_events")
        .map_err(unavailable)?;
    conn.prepare("SELECT journal_id,revision,outcome,observed_at FROM analysis_controls")
        .map_err(unavailable)?;
    conn.prepare("SELECT journal_id,origin_json,binding_json,header_json,latest_seq,applied_seq,sealed_seq,control_revision,worker_outcome,cleanup_state,result_state,history_state,body_state,payload_bytes,research_rows,terminal_rows,terminal_bytes,critical_seq,terminal_observed,projection_failure_code,projection_completed FROM analysis_journals").map_err(unavailable)?;
    let corrupt:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM analysis_journals WHERE
        typeof(payload_bytes)!='integer' OR payload_bytes<0 OR payload_bytes>1073741824 OR
        typeof(research_rows)!='integer' OR research_rows<0 OR research_rows>100000 OR
        typeof(terminal_rows)!='integer' OR terminal_rows<0 OR terminal_rows>8 OR
        typeof(terminal_bytes)!='integer' OR terminal_bytes<0 OR terminal_bytes>262144 OR
        terminal_observed NOT IN (0,1) OR projection_completed NOT IN (0,1) OR
        (critical_seq IS NOT NULL AND (typeof(critical_seq)!='integer' OR critical_seq<=0 OR critical_seq>latest_seq)) OR
        (body_state='available' AND header_json IS NULL) OR
        (body_state='purged' AND (header_json IS NOT NULL OR latest_seq!=0 OR applied_seq!=0 OR sealed_seq IS NOT NULL OR result_state!='discarded')))",[],|r|r.get(0)).map_err(unavailable)?;
    if corrupt {
        return Err(error("analysis_journal_corrupt"));
    }
    let summaries = summaries(conn)?;
    for s in summaries.iter().filter(|s| s.body_state == "available") {
        header(conn, &s.journal_id)?;
    }
    Ok(())
}

fn summaries(conn: &Connection) -> Result<Vec<JournalSummary>, RecoveryError> {
    let mut stmt = conn.prepare("SELECT journal_id,origin_json,binding_json,body_state,latest_seq,applied_seq,sealed_seq,control_revision,worker_outcome,cleanup_state,result_state,history_state FROM analysis_journals ORDER BY journal_id").map_err(unavailable)?;
    let rows = stmt.query_map([], |r| Ok(json!({
        "journalId":r.get::<_,String>(0)?,"origin":crate::analysis_recovery::parser::raw_json(&r.get::<_,String>(1)?,65536).map_err(|_|rusqlite::Error::InvalidQuery)?,
        "binding":crate::analysis_recovery::parser::raw_json(&r.get::<_,String>(2)?,65536).map_err(|_|rusqlite::Error::InvalidQuery)?,
        "bodyState":r.get::<_,String>(3)?,"latestSeq":r.get::<_,i64>(4)?.to_string(),"appliedSeq":r.get::<_,i64>(5)?.to_string(),
        "sealedThroughSeq":r.get::<_,Option<i64>>(6)?.map(|n|n.to_string()),"controlRevision":r.get::<_,i64>(7)?.to_string(),
        "workerOutcome":r.get::<_,Option<String>>(8)?,"cleanupState":r.get::<_,String>(9)?,
        "resultState":r.get::<_,String>(10)?,"historyState":r.get::<_,String>(11)?
    }))).map_err(unavailable)?;
    rows.map(|row| {
        let row = row.map_err(unavailable)?;
        validate_summary(&row)?;
        decode(row).map_err(|_| error("analysis_journal_corrupt"))
    })
    .collect()
}
fn validate_summary(v: &Value) -> Result<(), RecoveryError> {
    let s: JournalSummary = decode(v.clone()).map_err(|_| error("analysis_journal_corrupt"))?;
    crate::analysis_recovery::parser::binding(&s.binding, &s.origin)
        .map_err(|_| error("analysis_journal_corrupt"))?;
    if !crate::analysis_recovery::parser::hex(&s.journal_id)
        || !["available", "purged", "unavailable"].contains(&s.body_state.as_str())
        || !["pending", "confirmed", "failed", "unknown"].contains(&s.cleanup_state.as_str())
        || ![
            "unsealed",
            "pending",
            "projected",
            "failed_projection",
            "unknown",
            "discarded",
        ]
        .contains(&s.result_state.as_str())
        || !["current", "historical", "interrupted", "discarded"]
            .contains(&s.history_state.as_str())
        || s.worker_outcome
            .as_deref()
            .is_some_and(|s| !["succeeded", "failed", "cancelled", "not_started"].contains(&s))
    {
        return Err(error("analysis_journal_corrupt"));
    }
    let latest = counter(&v["latestSeq"])?;
    let applied = counter(&v["appliedSeq"])?;
    counter(&v["controlRevision"])?;
    let seal = if v["sealedThroughSeq"].is_null() {
        None
    } else {
        Some(counter(&v["sealedThroughSeq"])?)
    };
    if applied > latest
        || seal.is_some_and(|s| s == 0 || s > latest)
        || (v["resultState"] == "projected" && seal != Some(applied))
    {
        return Err(error("analysis_journal_corrupt"));
    }
    Ok(())
}
fn summary(conn: &Connection, id: &str) -> Result<JournalSummary, RecoveryError> {
    summaries(conn)?
        .into_iter()
        .find(|s| s.journal_id == id)
        .ok_or_else(|| error("analysis_journal_body_unavailable"))
}
fn header(conn: &Connection, id: &str) -> Result<JournalHeader, RecoveryError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT header_json FROM analysis_journals WHERE journal_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(unavailable)?
        .flatten();
    let raw = raw.ok_or_else(|| error("analysis_journal_body_unavailable"))?;
    let mut v = crate::analysis_recovery::parser::raw_json(&raw, MAX_REPLY)
        .map_err(|_| error("analysis_journal_corrupt"))?;
    let digest = v
        .as_object_mut()
        .and_then(|m| m.remove("headerDigest"))
        .ok_or_else(|| error("analysis_journal_corrupt"))?;
    if digest != hash(&v)? {
        return Err(error("analysis_journal_corrupt"));
    }
    v["headerDigest"] = digest;
    let h: JournalHeader = decode(v).map_err(|_| error("analysis_journal_corrupt"))?;
    let (origin, binding): (String, String) = conn
        .query_row(
            "SELECT origin_json,binding_json FROM analysis_journals WHERE journal_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(unavailable)?;
    let metadata_origin: RunIdentity =
        decode(crate::analysis_recovery::parser::raw_json(&origin, 65536)?)
            .map_err(|_| error("analysis_journal_corrupt"))?;
    let metadata_binding: RunBinding =
        decode(crate::analysis_recovery::parser::raw_json(&binding, 65536)?)
            .map_err(|_| error("analysis_journal_corrupt"))?;
    crate::analysis_recovery::parser::binding(&h.binding, &h.origin)?;
    crate::analysis_recovery::parser::head(&h.reserved_head, true)?;
    crate::analysis_recovery::publication::validate_context_shape(&h.context)?;
    if h.recovery_protocol_version != 1
        || h.journal_id != id
        || !crate::analysis_recovery::parser::hex(&h.admission_digest)
        || !crate::analysis_recovery::parser::request_id(&h.admission_request_id)
        || h.reserved_head.task_id != h.binding.task_id
        || h.reserved_head.generation != h.binding.generation
        || h.origin != metadata_origin
        || h.binding != metadata_binding
    {
        return Err(error("analysis_journal_corrupt"));
    }
    check_utc(&h.accepted_at)?;
    Ok(h)
}

fn current_for(
    conn: &Connection,
    id: Option<&str>,
    task_id: Option<&str>,
) -> Result<SqlCurrent, RecoveryError> {
    let storage = task_mutation::current(conn).map_err(unavailable)?;
    let journal = match id {
        Some(id) => summaries(conn)?.into_iter().find(|j| j.journal_id == id),
        None => None,
    };
    if let Some(s) = journal.as_ref().filter(|s| s.body_state == "available") {
        header(conn, &s.journal_id)?;
    }
    let requested = task_id.or_else(|| journal.as_ref().map(|j| j.binding.task_id.as_str()));
    let head = requested
        .and_then(|id| storage.heads.iter().find(|h| h.task_id == id))
        .cloned();
    let task = if head.as_ref().is_some_and(|h| h.state == "live") {
        load_tasks_from_conn(conn)
            .map_err(unavailable)?
            .into_iter()
            .find(|t| Some(t.id.as_str()) == requested)
    } else {
        None
    };
    Ok(SqlCurrent {
        storage,
        task,
        head,
        journal,
    })
}
pub fn current(conn: &Connection, journal_id: &str) -> Result<SqlCurrent, RecoveryError> {
    current_cut(conn, Some(journal_id), None)
}
pub fn terminal_observed(conn: &Connection, journal_id: &str) -> Result<bool, RecoveryError> {
    let tx = deferred(conn)?;
    header(&tx, journal_id)?;
    let observed: i64 = tx
        .query_row(
            "SELECT terminal_observed FROM analysis_journals WHERE journal_id=?1",
            [journal_id],
            |r| r.get(0),
        )
        .map_err(unavailable)?;
    if ![0, 1].contains(&observed) {
        return Err(error("analysis_journal_corrupt"));
    }
    tx.commit().map_err(unavailable)?;
    Ok(observed == 1)
}
fn current_cut(
    conn: &Connection,
    journal_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<SqlCurrent, RecoveryError> {
    let tx = deferred(conn)?;
    let result = current_for(&tx, journal_id, task_id)?;
    tx.commit().map_err(unavailable)?;
    Ok(result)
}
pub fn bootstrap(conn: &Connection) -> Result<SqlRecoveryCut, RecoveryError> {
    let tx = deferred(conn)?;
    let tasks = load_tasks_from_conn(&tx).map_err(unavailable)?;
    let storage = task_mutation::snapshot_storage(&tx, &tasks).map_err(unavailable)?;
    // Include all physical bindings. A supported copy must not hide an
    // incomplete journal merely because its original collection was rotated.
    let journals = summaries(&tx)?;
    for s in journals.iter().filter(|s| s.body_state == "available") {
        header(&tx, &s.journal_id)?;
    }
    let mut statement = tx.prepare("SELECT request_id,digest,collection_id,epoch,outcome,rejection_json FROM task_mutation_requests WHERE operation='clear' AND (outcome='pending' OR outcome='rejected') ORDER BY request_id").map_err(unavailable)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(unavailable)?;
    let mut clear_blockers = Vec::new();
    for row in rows {
        let (request_id, digest, collection_id, epoch, outcome, rejection) =
            row.map_err(unavailable)?;
        let partial = rejection
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(unavailable)?
            .is_some_and(|r| r["code"] == "storage_partial_clear");
        if outcome == "pending" || partial {
            clear_blockers.push(decode(json!({"requestId":request_id,"digest":digest,
                "collection":{"collectionId":collection_id,"epoch":epoch.to_string()},
                "status":if partial {"partial"} else {"pending"},
                "code":if partial {"storage_partial_clear"} else {"storage_unknown_outcome"}}))?);
        }
    }
    drop(statement);
    bounded(
        &json!({"storage":&storage,"tasks":&tasks,"journals":&journals,"clearBlockers":&clear_blockers}),
    )?;
    tx.commit().map_err(unavailable)?;
    Ok(SqlRecoveryCut {
        storage,
        tasks,
        journals,
        clear_blockers,
    })
}

struct RequestOutcome<T> {
    journal_id: String,
    receipt: Option<T>,
    rejection: Option<RecoveryError>,
}
fn check_packet<T: Serialize>(packet: &ParsedRecoveryRequest<T>) -> Result<(), RecoveryError> {
    if hash(&packet.original)? != packet.digest || value(&packet.request)? != packet.original {
        return Err(error("analysis_invalid_request"));
    }
    Ok(())
}
fn outcome<T: DeserializeOwned>(
    conn: &Connection,
    id: &str,
    digest: &str,
    kind: &str,
) -> Result<Option<RequestOutcome<T>>, RecoveryError> {
    type Row = (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let row: Option<Row> = conn.query_row("SELECT digest,kind,journal_id,outcome,receipt_json,rejection_json,origin_json,binding_json FROM analysis_requests WHERE request_id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(unavailable)?;
    let Some((stored_digest, stored_kind, journal_id, state, receipt, rejection, origin, binding)) =
        row
    else {
        return Ok(None);
    };
    if stored_digest != digest || stored_kind != kind {
        return Err(error("analysis_request_conflict"));
    }
    let origin = crate::analysis_recovery::parser::raw_json(&origin, 64 * 1024)
        .map_err(|_| error("analysis_journal_corrupt"))?;
    let binding = crate::analysis_recovery::parser::raw_json(&binding, 64 * 1024)
        .map_err(|_| error("analysis_journal_corrupt"))?;
    let typed_origin: RunIdentity = decode(origin.clone())?;
    let typed_binding: RunBinding = decode(binding.clone())?;
    crate::analysis_recovery::parser::binding(&typed_binding, &typed_origin)
        .map_err(|_| error("analysis_journal_corrupt"))?;
    if !crate::analysis_recovery::parser::hex(&journal_id) {
        return Err(error("analysis_journal_corrupt"));
    }
    let (receipt, rejection) = match (state.as_str(), receipt, rejection) {
        ("pending", None, None) => (None, None),
        ("committed", Some(raw), None) => {
            let v = crate::analysis_recovery::parser::raw_json(&raw, 64 * 1024)
                .map_err(|_| error("analysis_journal_corrupt"))?;
            if v["requestId"] != id
                || v["digest"] != digest
                || v["journalId"] != journal_id
                || v["sqlCommitted"] != true
                || v["recoveryProtocolVersion"] != 1
                || v["origin"] != origin
                || (kind != "control" && v["binding"] != binding)
            {
                return Err(error("analysis_journal_corrupt"));
            }
            (
                Some(decode(v).map_err(|_| error("analysis_journal_corrupt"))?),
                None,
            )
        }
        ("rejected", None, Some(raw)) => {
            let r: RecoveryError = decode(
                crate::analysis_recovery::parser::raw_json(&raw, 64 * 1024)
                    .map_err(|_| error("analysis_journal_corrupt"))?,
            )?;
            if r != error(&r.code) {
                return Err(error("analysis_journal_corrupt"));
            }
            (None, Some(r))
        }
        _ => return Err(error("analysis_journal_corrupt")),
    };
    Ok(Some(RequestOutcome {
        journal_id,
        receipt,
        rejection,
    }))
}
fn bind(
    conn: &Connection,
    packet: &Value,
    digest: &str,
    kind: &str,
    journal_id: &str,
    origin: &Value,
    binding: &Value,
) -> Result<(), RecoveryError> {
    conn.execute("INSERT INTO analysis_requests(request_id,digest,kind,journal_id,origin_json,binding_json,outcome) VALUES(?1,?2,?3,?4,?5,?6,'pending')",
        params![text(packet,"requestId")?,digest,kind,journal_id,encoded(origin)?,encoded(binding)?]).map_err(unavailable)?;
    Ok(())
}
fn finish_request(
    conn: &Connection,
    id: &str,
    receipt: Option<&Value>,
    rejection: Option<&RecoveryError>,
) -> Result<(), RecoveryError> {
    let changed = conn.execute("UPDATE analysis_requests SET outcome=?2,receipt_json=?3,rejection_json=?4 WHERE request_id=?1 AND outcome='pending'",
        params![id,if receipt.is_some(){"committed"}else{"rejected"},receipt.map(encoded).transpose()?,rejection.map(encoded).transpose()?]).map_err(unavailable)?;
    if changed != 1 {
        return Err(error("analysis_projection_unknown"));
    }
    Ok(())
}
fn sql_outcome<T>(
    conn: &Connection,
    outcome: RequestOutcome<T>,
    task_id: Option<&str>,
) -> SqlOutcome<T> {
    // Keep this Result separate: failure to read current authority never erases
    // a known historical receipt or rejection.
    let current = current_for(conn, Some(&outcome.journal_id), task_id);
    SqlOutcome {
        receipt: outcome.receipt,
        rejection: outcome.rejection,
        current,
    }
}
fn query<T: Serialize, R: DeserializeOwned>(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<T>,
    kind: &str,
    task_id: Option<&str>,
) -> Result<SqlOutcome<R>, RecoveryError> {
    check_packet(packet)?;
    let tx = deferred(conn)?;
    let found = outcome(
        &tx,
        text(&packet.original, "requestId")?,
        &packet.digest,
        kind,
    )?;
    let mut result = match found {
        Some(found) => sql_outcome(&tx, found, task_id),
        None => SqlOutcome {
            receipt: None,
            rejection: None,
            current: current_for(&tx, None, task_id),
        },
    };
    if tx.commit().is_err() {
        result.current = Err(error("analysis_storage_unavailable"));
    }
    Ok(result)
}
pub fn query_admission(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<AdmissionRequest>,
) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
    query(
        conn,
        packet,
        "admission",
        packet.original["expectedHead"]["taskId"].as_str(),
    )
}
pub fn reject_admission(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<AdmissionRequest>,
    seed: &AdmissionSeed,
    rejection: &RecoveryError,
) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
    check_packet(packet)?;
    crate::analysis_recovery::parser::identity(&seed.origin)?;
    let p = &packet.original;
    let tx = immediate(conn)?;
    if let Some(found) = outcome(&tx, text(p, "requestId")?, &packet.digest, "admission")? {
        return Ok(sql_outcome(
            &tx,
            found,
            p["expectedHead"]["taskId"].as_str(),
        ));
    }
    let binding = json!({"collection":p["collection"],"taskId":p["expectedHead"]["taskId"],"generation":p["expectedHead"]["generation"]});
    let origin = value(&seed.origin)?;
    if origin["taskId"] != binding["taskId"]
        || origin["runtimeEpoch"] != p["runtimeEpoch"]
        || domain_hash(
            "evidenceloom-journal-v1",
            &json!({"origin":origin,"binding":binding,"admissionRequestId":p["requestId"]}),
        )? != seed.journal_id
    {
        return Err(error("analysis_invalid_request"));
    }
    bind(
        &tx,
        p,
        &packet.digest,
        "admission",
        &seed.journal_id,
        &origin,
        &binding,
    )?;
    let rejection = error(&rejection.code);
    finish_request(&tx, text(p, "requestId")?, None, Some(&rejection))?;
    tx.commit()
        .map_err(|_| error("analysis_admission_unknown"))?;
    Ok(SqlOutcome {
        receipt: None,
        rejection: Some(rejection),
        current: current_cut(conn, None, p["expectedHead"]["taskId"].as_str()),
    })
}
pub fn query_start(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<StartRequest>,
) -> Result<SqlOutcome<StartReceipt>, RecoveryError> {
    query(
        conn,
        packet,
        "start",
        packet.original["origin"]["taskId"].as_str(),
    )
}
pub fn query_projection(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<ProjectionRequest>,
) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError> {
    query(
        conn,
        packet,
        "projection",
        packet.original["origin"]["taskId"].as_str(),
    )
}
pub fn query_control(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<StopRequest>,
) -> Result<SqlOutcome<ControlReceipt>, RecoveryError> {
    query(
        conn,
        packet,
        "control",
        packet.original["origin"]["taskId"].as_str(),
    )
}

pub fn admit(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<AdmissionRequest>,
    seed: &AdmissionSeed,
) -> Result<SqlOutcome<AdmissionReceipt>, RecoveryError> {
    check_packet(packet)?;
    let tx = immediate(conn)?;
    let p = &packet.original;
    let task_id = text(&p["expectedHead"], "taskId")?;
    if let Some(found) = outcome(&tx, text(p, "requestId")?, &packet.digest, "admission")? {
        return Ok(sql_outcome(&tx, found, Some(task_id)));
    }
    let origin = value(&seed.origin)?;
    let binding = json!({"collection":p["collection"],"taskId":task_id,"generation":p["expectedHead"]["generation"]});
    if origin["taskId"] != task_id
        || origin["runtimeEpoch"] != p["runtimeEpoch"]
        || domain_hash(
            "evidenceloom-journal-v1",
            &json!({"origin":origin,"binding":binding,"admissionRequestId":p["requestId"]}),
        )? != seed.journal_id
    {
        return Err(error("analysis_invalid_request"));
    }
    bind(
        &tx,
        p,
        &packet.digest,
        "admission",
        &seed.journal_id,
        &origin,
        &binding,
    )?;
    tx.execute_batch("SAVEPOINT analysis_admission")
        .map_err(unavailable)?;
    let effects = (|| {
        let canonical = current_for(&tx, None, Some(task_id))?;
        if value(&canonical.storage.collection)? != p["collection"]
            || canonical.head.as_ref().map(value).transpose()? != Some(p["expectedHead"].clone())
            || p["expectedHead"]["state"] != "live"
        {
            return Err(error("analysis_conflict"));
        }
        let task = canonical.task.ok_or_else(|| error("analysis_conflict"))?;
        crate::analysis_recovery::publication::validate_context_shape(&p["context"])?;
        if task_snapshot(&task) != p["context"]["originalTaskSnapshot"] {
            return Err(error("analysis_conflict"));
        }
        assert_removal_allowed(&tx, None)?;
        let clear_blocked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM task_mutation_requests WHERE operation='clear' AND (outcome='pending' OR (outcome='rejected' AND rejection_json LIKE '%storage_partial_clear%')))",[],|r|r.get(0)).map_err(unavailable)?;
        if clear_blocked {
            return Err(error("analysis_partial_clear"));
        }
        let mut h = json!({"recoveryProtocolVersion":1,"journalId":seed.journal_id,"origin":origin,"binding":binding,"reservedHead":p["expectedHead"],"admissionRequestId":p["requestId"],"admissionDigest":packet.digest,"acceptedAt":seed.accepted_at,"context":p["context"]});
        h["headerDigest"] = hash(&h)?.into();
        let _: JournalHeader = decode(h.clone())?;
        tx.execute("INSERT INTO analysis_journals(journal_id,origin_json,binding_json,header_json) VALUES(?1,?2,?3,?4)",
            params![seed.journal_id,encoded(&origin)?,encoded(&binding)?,encoded(&h)?]).map_err(unavailable)?;
        append_in(
            &tx,
            &PublicationDraft {
                journal_id: seed.journal_id.clone(),
                origin: seed.origin.clone(),
                binding: decode(binding.clone())?,
                kind: "accepted".into(),
                observed_at: seed.accepted_at.clone(),
                payload: json!({"resetVersion":1}),
            },
        )?;
        Ok(
            json!({"recoveryProtocolVersion":1,"requestId":p["requestId"],"digest":packet.digest,"origin":origin,"journalId":seed.journal_id,"binding":binding,"headerDigest":h["headerDigest"],"acceptedSeq":"1","sqlCommitted":true}),
        )
    })();
    let (receipt, rejection) = match effects {
        Ok(receipt) => {
            finish_request(&tx, text(p, "requestId")?, Some(&receipt), None)?;
            tx.execute_batch("RELEASE analysis_admission")
                .map_err(unavailable)?;
            (Some(decode(receipt)?), None)
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO analysis_admission; RELEASE analysis_admission")
                .map_err(unavailable)?;
            let error = self::error(&error.code);
            finish_request(&tx, text(p, "requestId")?, None, Some(&error))?;
            (None, Some(error))
        }
    };
    tx.commit()
        .map_err(|_| error("analysis_admission_unknown"))?;
    // A rejection may have no journal body. Its current task authority is still
    // readable without fabricating a journal that was never committed.
    let current = current_cut(
        conn,
        if receipt.is_some() {
            Some(seed.journal_id.as_str())
        } else {
            None
        },
        Some(task_id),
    );
    Ok(SqlOutcome {
        receipt,
        rejection,
        current,
    })
}
fn task_snapshot(task: &AnalysisTaskRecord) -> Value {
    json!({"ticker":task.ticker,"instrumentName":task.instrument_name,"analysisDate":task.analysis_date,
        "assetType":task.asset_type,"researchDepth":task.research_depth,"analysts":task.analysts,"outputLanguage":task.output_language})
}

fn check_binding(
    conn: &Connection,
    p: &Value,
    require_live: bool,
) -> Result<JournalSummary, RecoveryError> {
    let s = summary(conn, text(p, "journalId")?)?;
    if value(&s.origin)? != p["origin"]
        || (p.get("binding").is_some() && value(&s.binding)? != p["binding"])
    {
        return Err(error("analysis_stale_origin"));
    }
    if s.body_state != "available" {
        return Err(error("analysis_journal_body_unavailable"));
    }
    if require_live {
        let authority = task_mutation::current(conn).map_err(unavailable)?;
        if authority.collection != s.binding.collection
            || !authority.heads.iter().any(|h| {
                h.task_id == s.binding.task_id
                    && h.generation == s.binding.generation
                    && h.state == "live"
            })
        {
            return Err(error("analysis_conflict"));
        }
    }
    Ok(s)
}
fn check_utc(s: &str) -> Result<(), RecoveryError> {
    crate::analysis_recovery::parser::utc(s)
}
pub fn accept_start(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<StartRequest>,
) -> Result<SqlOutcome<StartReceipt>, RecoveryError> {
    check_packet(packet)?;
    let tx = immediate(conn)?;
    let p = &packet.original;
    if let Some(found) = outcome(&tx, text(p, "requestId")?, &packet.digest, "start")? {
        return Ok(sql_outcome(&tx, found, None));
    }
    bind(
        &tx,
        p,
        &packet.digest,
        "start",
        text(p, "journalId")?,
        &p["origin"],
        &p["binding"],
    )?;
    let result = (|| {
        let s = check_binding(&tx, p, true)?;
        let h = header(&tx, &s.journal_id)?;
        if h.header_digest != text(p, "headerDigest")?
            || counter(&json!(s.applied_seq))? < 1
            || s.sealed_through_seq.is_some()
        {
            return Err(error("analysis_conflict"));
        }
        let claimed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM analysis_requests WHERE journal_id=?1 AND kind='start' AND outcome='committed')",[&s.journal_id],|r|r.get(0)).map_err(unavailable)?;
        if claimed {
            return Err(error("analysis_busy"));
        }
        Ok(
            json!({"recoveryProtocolVersion":1,"requestId":p["requestId"],"digest":packet.digest,"origin":p["origin"],"journalId":p["journalId"],"binding":p["binding"],"accepted":true,"sqlCommitted":true}),
        )
    })();
    let (receipt, rejection) = match result {
        Ok(v) => {
            finish_request(&tx, text(p, "requestId")?, Some(&v), None)?;
            (Some(decode(v)?), None)
        }
        Err(e) => {
            let e = error(&e.code);
            finish_request(&tx, text(p, "requestId")?, None, Some(&e))?;
            (None, Some(e))
        }
    };
    tx.commit().map_err(|_| error("analysis_start_unknown"))?;
    Ok(SqlOutcome {
        receipt,
        rejection,
        current: current_cut(conn, Some(text(p, "journalId")?), None),
    })
}
fn append_in(
    conn: &Connection,
    draft: &PublicationDraft,
) -> Result<JournalEnvelope, RecoveryError> {
    check_utc(&draft.observed_at)?;
    crate::analysis_recovery::publication::validate_payload(&draft.kind, &draft.payload)?;
    let s = check_binding(
        conn,
        &json!({"journalId":draft.journal_id,"origin":draft.origin,"binding":draft.binding}),
        true,
    )?;
    if s.sealed_through_seq.is_some() {
        return Err(error("analysis_conflict"));
    }
    let seq = next(counter(&json!(s.latest_seq))?)?;
    if (draft.kind == "accepted") != (seq == 1) {
        return Err(error("analysis_journal_corrupt"));
    }
    let event = match draft.kind.as_str() {
        "analysis" => draft.payload.get("event"),
        "publication_unavailable" => draft.payload.get("safeAnalysis").filter(|v| !v.is_null()),
        _ => None,
    };
    let log_timestamp = crate::analysis_recovery::publication::expected_log_timestamp(
        &draft.kind,
        &draft.payload,
        &draft.observed_at,
    )?;
    let completion = event.is_some_and(|e| e["type"] == "completed")
        && (draft.kind == "analysis" || draft.payload["outcome"] == "optional_unavailable");
    let seed = json!({"updatedAt":draft.observed_at,"logId":format!("log:{}:{seq}",draft.journal_id),
        "logTimestamp":log_timestamp,"completionVersionId":completion.then(||format!("report:{}:{seq}",draft.journal_id)),
        "completionCreatedAt":completion.then(||draft.observed_at.clone())});
    let payload_digest = hash(
        &json!({"kind":draft.kind,"observedAt":draft.observed_at,"payload":draft.payload,"seed":seed}),
    )?;
    let envelope = json!({"recoveryProtocolVersion":1,"journalId":draft.journal_id,"origin":draft.origin,"binding":draft.binding,
        "seq":seq.to_string(),"kind":draft.kind,"observedAt":draft.observed_at,"payload":draft.payload,"seed":seed,"payloadDigest":payload_digest});
    let raw = encoded(&envelope)?;
    if raw.len() > MAX_ENVELOPE {
        return Err(error("analysis_limit_exceeded"));
    }
    let first_critical: bool = conn
        .query_row(
            "SELECT critical_seq IS NULL FROM analysis_journals WHERE journal_id=?1",
            [&draft.journal_id],
            |r| r.get(0),
        )
        .map_err(unavailable)?;
    // Only the first bounded critical marker can use the emergency research
    // reserve. Repeated malformed lines cannot consume the reader/worker slots.
    let reserve = matches!(draft.kind.as_str(), "reader_outcome" | "worker_outcome")
        || (first_critical
            && draft.kind == "publication_unavailable"
            && draft.payload["outcome"] == "analysis_failed"
            && draft.payload["safeAnalysis"].is_null());
    let (bytes,rows,terminal_rows,terminal_bytes): (i64,i64,i64,i64) = conn.query_row("SELECT payload_bytes,research_rows,terminal_rows,terminal_bytes FROM analysis_journals WHERE journal_id=?1",[&draft.journal_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(unavailable)?;
    let len = i64::try_from(raw.len()).map_err(|_| error("analysis_limit_exceeded"))?;
    let new_bytes = bytes
        .checked_add(len)
        .ok_or_else(|| error("analysis_counter_exhausted"))?;
    if reserve {
        if next(terminal_rows)? > TERMINAL_ROWS
            || terminal_bytes
                .checked_add(len)
                .is_none_or(|n| n > TERMINAL_BYTES)
            || new_bytes > RUN_BYTES
        {
            return Err(error("analysis_limit_exceeded"));
        }
    } else if next(rows)? > RUN_ROWS || new_bytes > RUN_BYTES - TERMINAL_BYTES {
        return Err(error("analysis_limit_exceeded"));
    }
    let critical =
        draft.kind == "publication_unavailable" && draft.payload["outcome"] == "analysis_failed";
    let terminal = completion
        || (event.is_some_and(|e| e["type"] == "error")
            && (draft.kind == "analysis" || draft.payload["outcome"] == "optional_unavailable"));
    if draft.kind == "worker_outcome" {
        let observed: bool = conn
            .query_row(
                "SELECT terminal_observed FROM analysis_journals WHERE journal_id=?1",
                [&draft.journal_id],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        if draft.payload["outcome"] == "succeeded"
            && (draft.payload["code"] == "analysis_missing_terminal") == observed
        {
            return Err(error("analysis_journal_corrupt"));
        }
    }
    let envelope = crate::analysis_recovery::parser::validate_envelope_value(&envelope)?;
    conn.execute(
        "INSERT INTO analysis_events(journal_id,seq,envelope_json) VALUES(?1,?2,?3)",
        params![draft.journal_id, seq, raw],
    )
    .map_err(unavailable)?;
    conn.execute("UPDATE analysis_journals SET latest_seq=?2,payload_bytes=?3,research_rows=?4,terminal_rows=?5,terminal_bytes=?6,critical_seq=COALESCE(critical_seq,?7),terminal_observed=MAX(terminal_observed,?8) WHERE journal_id=?1",
        params![draft.journal_id,seq,new_bytes,if reserve{rows}else{next(rows)?},if reserve{next(terminal_rows)?}else{terminal_rows},if reserve{terminal_bytes+len}else{terminal_bytes},if critical{Some(seq)}else{None},i64::from(terminal)]).map_err(unavailable)?;
    Ok(envelope)
}
pub fn append(
    conn: &Connection,
    draft: &PublicationDraft,
) -> Result<JournalEnvelope, RecoveryError> {
    let tx = immediate(conn)?;
    let envelope = append_in(&tx, draft)?;
    tx.commit()
        .map_err(|_| error("analysis_projection_unknown"))?;
    Ok(envelope)
}
pub fn seal(conn: &Connection, record: &SealRecord) -> Result<JournalSummary, RecoveryError> {
    let tx = immediate(conn)?;
    let s = check_binding(
        &tx,
        &json!({"journalId":record.journal_id,"origin":record.origin,"binding":record.binding}),
        true,
    )?;
    if s.sealed_through_seq.is_some() {
        if s.worker_outcome.as_deref() != Some(record.worker_outcome.outcome.as_str()) {
            return Err(error("analysis_conflict"));
        }
        return Ok(s);
    }
    let through = counter(&json!(s.latest_seq))?;
    let after = through
        .checked_sub(1)
        .ok_or_else(|| error("analysis_journal_corrupt"))?;
    let rows = rows_in(&tx, &s, after, through, 1)?;
    let last = rows.first().ok_or_else(|| error("analysis_journal_gap"))?;
    if last.kind != "worker_outcome" || last.payload != value(&record.worker_outcome)? {
        return Err(error("analysis_journal_corrupt"));
    }
    tx.execute("UPDATE analysis_journals SET sealed_seq=latest_seq,worker_outcome=?2,result_state=CASE WHEN applied_seq=latest_seq THEN 'projected' ELSE 'pending' END WHERE journal_id=?1 AND sealed_seq IS NULL",params![record.journal_id,record.worker_outcome.outcome]).map_err(unavailable)?;
    let s = summary(&tx, &record.journal_id)?;
    tx.commit()
        .map_err(|_| error("analysis_projection_unknown"))?;
    Ok(s)
}

fn rows_in(
    conn: &Connection,
    s: &JournalSummary,
    after: i64,
    through: i64,
    limit: usize,
) -> Result<Vec<JournalEnvelope>, RecoveryError> {
    let mut statement=conn.prepare("SELECT seq,envelope_json FROM analysis_events WHERE journal_id=?1 AND seq>?2 AND seq<=?3 ORDER BY seq LIMIT ?4").map_err(unavailable)?;
    let rows = statement
        .query_map(params![s.journal_id, after, through, limit as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(unavailable)?;
    let mut expected = after;
    let mut total = 0usize;
    let mut result = Vec::new();
    for row in rows {
        let (seq, raw) = row.map_err(unavailable)?;
        if raw.len() > MAX_ENVELOPE {
            return Err(error("analysis_journal_corrupt"));
        }
        if seq != next(expected)? {
            return Err(error("analysis_journal_gap"));
        }
        if !result.is_empty() && total.checked_add(raw.len()).is_none_or(|n| n > PAGE_SOFT) {
            break;
        }
        let parsed = crate::analysis_recovery::parser::raw_json(&raw, MAX_ENVELOPE)
            .map_err(|_| error("analysis_journal_corrupt"))?;
        let envelope = crate::analysis_recovery::parser::validate_envelope_value(&parsed)
            .map_err(|_| error("analysis_journal_corrupt"))?;
        if envelope.journal_id != s.journal_id
            || envelope.origin != s.origin
            || envelope.binding != s.binding
            || counter(&json!(envelope.seq))? != seq
        {
            return Err(error("analysis_journal_corrupt"));
        }
        total = total
            .checked_add(raw.len())
            .ok_or_else(|| error("analysis_limit_exceeded"))?;
        result.push(envelope);
        expected = seq;
        if total >= PAGE_SOFT {
            break;
        }
    }
    if result.is_empty() && after < through {
        return Err(error("analysis_journal_gap"));
    }
    Ok(result)
}
fn proof(
    s: &JournalSummary,
    from: i64,
    through: i64,
    rows: &[JournalEnvelope],
) -> Result<String, RecoveryError> {
    domain_hash(
        "evidenceloom-journal-range-v1",
        &json!({"journalId":s.journal_id,"origin":s.origin,"binding":s.binding,
        "fromSeq":from.to_string(),"throughSeq":through.to_string(),"payloadDigests":rows.iter().map(|r|&r.payload_digest).collect::<Vec<_>>()}),
    )
}
fn read_in(conn: &Connection, request: &ReadRequest) -> Result<ReadReply, RecoveryError> {
    let p = value(request)?;
    let s = check_binding(conn, &p, false)?;
    let h = header(conn, &request.journal_id)?;
    let after = counter(&json!(request.after_seq))?;
    let through = match &request.through_seq {
        Some(s) => counter(&json!(s))?,
        None => counter(&json!(s.latest_seq))?,
    };
    if request.recovery_protocol_version != 1
        || request.limit < 1
        || request.limit > 64
        || after > through
        || through > counter(&json!(s.latest_seq))?
    {
        return Err(error("analysis_invalid_request"));
    }
    let rows = if after == through {
        Vec::new()
    } else {
        rows_in(conn, &s, after, through, request.limit as usize)?
    };
    let last = rows
        .last()
        .map(|r| counter(&json!(r.seq)))
        .transpose()?
        .unwrap_or(after);
    let range_proof = if rows.is_empty() {
        None
    } else {
        Some(RangeProof {
            from_seq: after.to_string(),
            through_seq: last.to_string(),
            digest: proof(&s, after, last, &rows)?,
        })
    };
    let reply = ReadReply {
        recovery_protocol_version: 1,
        header: h,
        summary: s,
        after_seq: after.to_string(),
        through_seq: through.to_string(),
        last_seq: last.to_string(),
        has_more: last < through,
        rows,
        range_proof,
    };
    bounded(&reply)?;
    Ok(reply)
}
pub fn read(conn: &Connection, request: &ReadRequest) -> Result<ReadReply, RecoveryError> {
    let tx = deferred(conn)?;
    let reply = read_in(&tx, request)?;
    tx.commit().map_err(unavailable)?;
    Ok(reply)
}

/// Match JavaScript String.trim exactly; Rust's Unicode whitespace set differs.
fn has_content(sections: &Value) -> bool {
    sections.as_object().is_some_and(|sections| {
        sections.values().any(|value| {
            value
                .as_str()
                .is_some_and(|text| !publication::ecmascript_blank(text))
        })
    })
}
fn immutable_version(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(m) = v.as_object_mut() {
        m.remove("evaluationReviews");
        m.remove("numericReviews");
    }
    v
}
fn prefix(prior: &Value, next: &Value) -> bool {
    match (prior.as_array(), next.as_array()) {
        (Some(a), Some(b)) => b.len() >= a.len() && a.iter().zip(b).all(|(a, b)| a == b),
        (None, None) => true,
        _ => false,
    }
}
fn prepend_journal_log(
    logs: &mut Vec<Value>,
    row: &JournalEnvelope,
    kind: &str,
    message: &str,
    agent: Option<&Value>,
) {
    let mut log = json!({"id":row.seed.log_id,"type":kind,"message":message,"timestamp":row.seed.log_timestamp});
    if let Some(agent) = agent {
        log["agent"] = agent.clone();
    }
    logs.retain(|old| old["id"] != row.seed.log_id);
    logs.insert(0, log);
    logs.truncate(100);
}
// JavaScript parses 1, 1.0 and 1e0 into the same finite Number. Preserve the
// original journal bytes/digest while accepting its faithful JSON projection.
fn same_stats(left: &Value, right: &Value) -> bool {
    match (left.as_object(), right.as_object()) {
        (Some(left), Some(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    value
                        .as_f64()
                        .zip(right.get(key).and_then(Value::as_f64))
                        .is_some_and(|(a, b)| a.is_finite() && b.is_finite() && a == b)
                })
        }
        _ => false,
    }
}
pub(super) fn same_version_core(left: &Value, right: &Value) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    let (Some(left), Some(right)) = (left.as_object_mut(), right.as_object_mut()) else {
        return false;
    };
    match (left.remove("stats"), right.remove("stats")) {
        (Some(a), Some(b)) if a == b || same_stats(&a, &b) => {}
        (None, None) => {}
        _ => return false,
    }
    left == right
}
fn projection_truth(
    conn: &Connection,
    s: &JournalSummary,
    parent: &AnalysisTaskRecord,
    proposed: &AnalysisTaskRecord,
    rows: &[JournalEnvelope],
) -> Result<(Option<String>, bool), RecoveryError> {
    if proposed.id != parent.id || task_snapshot(proposed) != task_snapshot(parent) {
        return Err(error("analysis_conflict"));
    }
    let prior = parent
        .report_versions
        .as_array()
        .ok_or_else(|| error("analysis_journal_corrupt"))?;
    let versions = proposed
        .report_versions
        .as_array()
        .ok_or_else(|| error("analysis_invalid_request"))?;
    if versions.len() < prior.len() {
        return Err(error("analysis_conflict"));
    }
    for (before, after) in prior.iter().zip(versions) {
        if !same_version_core(&immutable_version(before), &immutable_version(after))
            || !prefix(&before["evaluationReviews"], &after["evaluationReviews"])
            || !prefix(&before["numericReviews"], &after["numericReviews"])
        {
            return Err(error("analysis_conflict"));
        }
    }
    let critical: Option<i64> = conn
        .query_row(
            "SELECT critical_seq FROM analysis_journals WHERE journal_id=?1",
            [&s.journal_id],
            |r| r.get(0),
        )
        .map_err(unavailable)?;
    let mut sections = parent.report_sections.clone();
    let mut stats = parent.stats.clone();
    let (carried_failure,carried_completion):(Option<String>,bool)=conn.query_row("SELECT projection_failure_code,projection_completed FROM analysis_journals WHERE journal_id=?1",[&s.journal_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(unavailable)?;
    if carried_failure
        .as_ref()
        .is_some_and(|c| error(c).code != *c)
    {
        return Err(error("analysis_journal_corrupt"));
    }
    let mut failure: Option<&str> = carried_failure.as_deref();
    let mut completed = carried_completion;
    let mut logs = parent
        .logs
        .as_array()
        .ok_or_else(|| error("analysis_journal_corrupt"))?
        .clone();
    let mut eligible = std::collections::BTreeMap::<String, (String, Value, Value)>::new();
    for row in rows {
        let seq = counter(&json!(row.seq))?;
        let sticky = critical.is_some_and(|n| n <= seq);
        let mut fixed_log: Option<&str> = None;
        if row.kind == "accepted" {
            if seq != 1 {
                return Err(error("analysis_journal_corrupt"));
            }
            sections = json!({});
            failure = None;
            completed = false;
            stats =
                json!({"llmCalls":0,"toolCalls":0,"tokensIn":0,"tokensOut":0,"elapsedSeconds":0});
            logs.clear();
            if rows.len() == 1
                && (!proposed.decision.is_empty()
                    || !proposed.error.is_empty()
                    || !proposed.queued_at.is_empty()
                    || proposed.queue_order.is_some()
                    || !["running", "stopped"].contains(&proposed.status.as_str())
                    || proposed.agent_statuses != json!({})
                    || proposed.logs != json!([])
                    || proposed.evaluation_reviews != json!([])
                    || proposed.output_quality.is_some()
                    || proposed.evidence_bundle.is_some()
                    || proposed.evidence_validation.is_some()
                    || proposed.memory_bundle.is_some()
                    || proposed.memory_validation.is_some()
                    || proposed.research_readiness.is_some()
                    || proposed.readiness_validation.is_some()
                    || proposed.report_text_snapshot.is_some()
                    || proposed.numeric_validation.is_some()
                    || proposed.effective_request_identity.is_some()
                    || proposed.identity_validation.is_some())
            {
                return Err(error("analysis_invalid_request"));
            }
        }
        let event = if row.kind == "analysis" {
            row.payload.get("event")
        } else if row.kind == "publication_unavailable" {
            row.payload.get("safeAnalysis").filter(|v| !v.is_null())
        } else {
            None
        };
        if let Some(event) = event {
            if [event.get("message"), event.get("error")]
                .into_iter()
                .flatten()
                .any(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            {
                prepend_journal_log(
                    &mut logs,
                    row,
                    event
                        .get("messageType")
                        .unwrap_or(&event["type"])
                        .as_str()
                        .ok_or_else(|| error("analysis_journal_corrupt"))?,
                    event
                        .get("error")
                        .or_else(|| event.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    event.get("agent"),
                );
            }
            if row.kind == "publication_unavailable" {
                prepend_journal_log(
                    &mut logs,
                    row,
                    "warning",
                    &error("analysis_publication_unavailable").message,
                    event.get("agent"),
                );
            }
            if let Some(snapshot) = event.get("reportSections").filter(|v| !v.is_null()) {
                sections = snapshot.clone();
            }
            if let Some(next) = event.get("stats") {
                stats = next.clone();
            }
            if event["type"] == "error" {
                failure = Some("analysis_worker_failed");
                completed = false;
                if event
                    .get("error")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                {
                    fixed_log = failure;
                }
            }
            if event["type"] == "completed" {
                if !has_content(&sections) {
                    failure = Some("analysis_empty_result");
                    completed = false;
                    fixed_log = failure;
                } else if !sticky
                    && (row.kind == "analysis" || row.payload["outcome"] == "optional_unavailable")
                {
                    failure = None;
                    completed = true;
                    let id = row
                        .seed
                        .completion_version_id
                        .as_ref()
                        .ok_or_else(|| error("analysis_journal_corrupt"))?;
                    eligible.insert(
                        id.clone(),
                        (row.observed_at.clone(), sections.clone(), stats.clone()),
                    );
                }
            }
        }
        if row.kind == "reader_outcome" && row.payload["outcome"] != "eof" {
            failure = Some("analysis_reader_failed");
            completed = false;
            fixed_log = failure;
        }
        if row.kind == "worker_outcome" {
            match row.payload["outcome"].as_str() {
                _ if row.payload["code"].as_str().is_some() => {
                    failure = row.payload["code"].as_str();
                    completed = false;
                    fixed_log = failure;
                }
                _ if sticky => {
                    failure = Some("analysis_publication_unavailable");
                    completed = false;
                    fixed_log = failure;
                }
                Some("cancelled" | "not_started") => {
                    completed = false;
                }
                _ => {}
            }
        }
        // A later safe completion cannot hide a prior critical withheld result.
        if sticky && matches!(row.kind.as_str(), "analysis" | "publication_unavailable") {
            failure = Some("analysis_publication_unavailable");
            completed = false;
            fixed_log = failure;
        }
        if let Some(code) = fixed_log {
            prepend_journal_log(&mut logs, row, "error", &error(code).message, None);
        }
    }
    if let Some(last) = rows.last() {
        if proposed.updated_at != last.observed_at {
            return Err(error("analysis_invalid_request"));
        }
        let through = counter(&json!(last.seq))?;
        if failure.is_none() && critical.is_some_and(|n| n <= through) {
            failure = Some("analysis_publication_unavailable");
        }
    }
    if let Some(code) = failure {
        if proposed.status != "error" || proposed.error != error(code).message {
            return Err(error("analysis_invalid_request"));
        }
    } else if completed != (proposed.status == "completed") {
        return Err(error("analysis_invalid_request"));
    }
    if proposed.report_sections != sections || !same_stats(&proposed.stats, &stats) {
        return Err(error("analysis_invalid_request"));
    }
    let mut number = prior
        .iter()
        .filter_map(|v| v["versionNumber"].as_i64())
        .max()
        .unwrap_or(0);
    let context = header(conn, &s.journal_id)?.context;
    for version in &versions[prior.len()..] {
        let id = text(version, "id")?;
        let Some((created_at, reports, stats)) = eligible.remove(id) else {
            return Err(error("analysis_invalid_request"));
        };
        number = next(number)?;
        let run_id = version
            .get("evidenceBundle")
            .map(|bundle| &bundle["run_id"])
            .unwrap_or(&context["originalRunContext"]["runId"]);
        if version["createdAt"] != created_at
            || version["reportSections"] != reports
            || version["task"] != task_snapshot(parent)
            || version["versionNumber"] != number
            || !same_stats(&version["stats"], &stats)
            || version["runId"] != *run_id
            || version["legacy"] != false
        {
            return Err(error("analysis_invalid_request"));
        }
    }
    // Seed identity alone cannot authorize a fabricated display message. Match
    // the production reducer's full prepend, replacement and bounded history.
    if proposed.logs != Value::Array(logs) {
        return Err(error("analysis_invalid_request"));
    }
    Ok((failure.map(str::to_owned), completed))
}
pub fn project(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<ProjectionRequest>,
) -> Result<SqlOutcome<ProjectionReceipt>, RecoveryError> {
    check_packet(packet)?;
    let tx = immediate(conn)?;
    let p = &packet.original;
    if let Some(found) = outcome(&tx, text(p, "requestId")?, &packet.digest, "projection")? {
        return Ok(sql_outcome(&tx, found, None));
    }
    bind(
        &tx,
        p,
        &packet.digest,
        "projection",
        text(p, "journalId")?,
        &p["origin"],
        &p["binding"],
    )?;
    tx.execute_batch("SAVEPOINT analysis_projection")
        .map_err(unavailable)?;
    let effects = (|| {
        let s = check_binding(&tx, p, true)?;
        let captured = current_for(&tx, Some(&s.journal_id), None)?;
        if captured.head.as_ref().map(value).transpose()? != Some(p["expectedHead"].clone())
            || s.applied_seq != text(p, "expectedAppliedSeq")?
        {
            return Err(error("analysis_conflict"));
        }
        let from = counter(&p["expectedAppliedSeq"])?;
        let through = counter(&p["throughSeq"])?;
        if through <= from || through > counter(&json!(s.latest_seq))? || through - from > 64 {
            return Err(error("analysis_invalid_request"));
        }
        let rows = rows_in(&tx, &s, from, through, 64)?;
        if rows.last().map(|r| r.seq.as_str()) != Some(text(p, "throughSeq")?)
            || proof(&s, from, through, &rows)? != text(p, "rangeDigest")?
        {
            return Err(error("analysis_journal_gap"));
        }
        let parent = captured.task.ok_or_else(|| error("analysis_conflict"))?;
        let task: AnalysisTaskRecord = decode(p["projection"]["task"].clone())?;
        let (failure, completed) = projection_truth(&tx, &s, &parent, &task, &rows)?;
        let ordinary = json!({"protocolVersion":1,"requestId":p["requestId"],"collection":s.binding.collection,"operation":"update","expectedHead":p["expectedHead"],"task":p["projection"]["task"]});
        let ordinary = task_mutation::parse(ordinary, &["update"])
            .map_err(|_| error("analysis_invalid_request"))?;
        let heads = task_mutation::effects(&tx, &ordinary).map_err(|e| {
            if e.code == "storage_conflict" {
                error("analysis_conflict")
            } else {
                error("analysis_invalid_request")
            }
        })?;
        tx.execute("UPDATE analysis_journals SET applied_seq=?2,result_state=CASE WHEN sealed_seq=?2 THEN 'projected' WHEN sealed_seq IS NULL THEN 'unsealed' ELSE 'pending' END,projection_failure_code=?3,projection_completed=?4 WHERE journal_id=?1",params![s.journal_id,through,failure,i64::from(completed)]).map_err(unavailable)?;
        Ok(
            json!({"recoveryProtocolVersion":1,"requestId":p["requestId"],"digest":packet.digest,"journalId":s.journal_id,"origin":s.origin,"binding":s.binding,"fromSeq":from.to_string(),"throughSeq":through.to_string(),"rangeDigest":p["rangeDigest"],"head":heads[0],"sqlCommitted":true}),
        )
    })();
    let (receipt, rejection) = match effects {
        Ok(v) => {
            finish_request(&tx, text(p, "requestId")?, Some(&v), None)?;
            tx.execute_batch("RELEASE analysis_projection")
                .map_err(unavailable)?;
            (Some(decode(v)?), None)
        }
        Err(e) => {
            tx.execute_batch("ROLLBACK TO analysis_projection; RELEASE analysis_projection")
                .map_err(unavailable)?;
            let e = error(&e.code);
            finish_request(&tx, text(p, "requestId")?, None, Some(&e))?;
            (None, Some(e))
        }
    };
    tx.commit()
        .map_err(|_| error("analysis_projection_unknown"))?;
    Ok(SqlOutcome {
        receipt,
        rejection,
        current: current_cut(conn, Some(text(p, "journalId")?), None),
    })
}

pub fn record_control(
    conn: &Connection,
    packet: &ParsedRecoveryRequest<StopRequest>,
    record: &ControlRecord,
) -> Result<SqlOutcome<ControlReceipt>, RecoveryError> {
    check_packet(packet)?;
    check_utc(&record.observed_at)?;
    if !["cleanup_confirmed", "cleanup_incomplete"].contains(&record.outcome.as_str()) {
        return Err(error("analysis_invalid_request"));
    }
    let tx = immediate(conn)?;
    let p = &packet.original;
    if let Some(found) = outcome(&tx, text(p, "requestId")?, &packet.digest, "control")? {
        return Ok(sql_outcome(&tx, found, None));
    }
    // No synthetic control receipt for an admission whose durable header is
    // unknown. The caller still has its exact in-memory cancellation witness.
    let s = check_binding(&tx, p, false)?;
    bind(
        &tx,
        p,
        &packet.digest,
        "control",
        &s.journal_id,
        &p["origin"],
        &value(&s.binding)?,
    )?;
    let revision = counter(&json!(s.control_revision))?;
    let valid = match text(p, "mode")? {
        "stop" => p["expectedControlRevision"].is_null(),
        "retry_cleanup" => counter(&p["expectedControlRevision"])? == revision,
        _ => false,
    };
    if !valid {
        let e = error("analysis_conflict");
        finish_request(&tx, text(p, "requestId")?, None, Some(&e))?;
        tx.commit()
            .map_err(|_| error("analysis_cleanup_incomplete"))?;
        return Ok(SqlOutcome {
            receipt: None,
            rejection: Some(e),
            current: current_cut(conn, Some(&s.journal_id), None),
        });
    }
    let next = next(revision)?;
    tx.execute("INSERT INTO analysis_controls(journal_id,revision,outcome,observed_at) VALUES(?1,?2,?3,?4)",params![s.journal_id,next,record.outcome,record.observed_at]).map_err(unavailable)?;
    tx.execute(
        "UPDATE analysis_journals SET control_revision=?2,cleanup_state=?3 WHERE journal_id=?1",
        params![
            s.journal_id,
            next,
            if record.outcome == "cleanup_confirmed" {
                "confirmed"
            } else {
                "failed"
            }
        ],
    )
    .map_err(unavailable)?;
    let receipt = json!({"recoveryProtocolVersion":1,"requestId":p["requestId"],"digest":packet.digest,"origin":s.origin,"journalId":s.journal_id,"controlRevision":next.to_string(),"outcome":record.outcome,"sqlCommitted":true});
    finish_request(&tx, text(p, "requestId")?, Some(&receipt), None)?;
    let receipt = decode(receipt)?;
    tx.commit()
        .map_err(|_| error("analysis_cleanup_incomplete"))?;
    Ok(SqlOutcome {
        receipt: Some(receipt),
        rejection: None,
        current: current_cut(conn, Some(&s.journal_id), None),
    })
}

pub fn assert_removal_allowed(
    conn: &Connection,
    task_id: Option<&str>,
) -> Result<(), RecoveryError> {
    for s in summaries(conn)? {
        if task_id.is_some_and(|id| id != s.binding.task_id) || s.body_state == "purged" {
            continue;
        }
        if s.sealed_through_seq.as_ref() != Some(&s.applied_seq)
            || s.cleanup_state != "confirmed"
            || s.result_state != "projected"
        {
            return Err(error("analysis_busy"));
        }
    }
    Ok(())
}
fn purge(conn: &Connection, task_id: Option<&str>) -> Result<(), RecoveryError> {
    assert_removal_allowed(conn, task_id)?;
    for s in summaries(conn)? {
        if task_id.is_some_and(|id| id != s.binding.task_id) {
            continue;
        }
        // All original research context and event bodies disappear atomically
        // with the caller's fenced task/attachment transaction. Metadata-only
        // receipt history remains queryable and cannot authorize resurrection.
        conn.execute(
            "DELETE FROM analysis_events WHERE journal_id=?1",
            [&s.journal_id],
        )
        .map_err(unavailable)?;
        conn.execute(
            "DELETE FROM analysis_controls WHERE journal_id=?1",
            [&s.journal_id],
        )
        .map_err(unavailable)?;
        conn.execute("UPDATE analysis_journals SET header_json=NULL,body_state='purged',history_state='discarded',result_state='discarded',latest_seq=0,applied_seq=0,sealed_seq=NULL,payload_bytes=0,research_rows=0,terminal_rows=0,terminal_bytes=0,critical_seq=NULL,terminal_observed=0,projection_failure_code=NULL,projection_completed=0 WHERE journal_id=?1",[&s.journal_id]).map_err(unavailable)?;
    }
    Ok(())
}
/// Join the caller's existing transaction; never commit or acquire runtime.
pub fn purge_projected_task(conn: &Connection, task_id: &str) -> Result<(), RecoveryError> {
    purge(conn, Some(task_id))
}
pub fn purge_projected_collection(conn: &Connection) -> Result<(), RecoveryError> {
    purge(conn, None)
}
/// Supervised native initialization marks prior physical runs without adopting
/// their process identity, cursor, research context or publication authority.
pub fn interrupt_prior_epochs(conn: &Connection, epoch: &str) -> Result<(), RecoveryError> {
    if !crate::analysis_recovery::parser::hex(epoch) {
        return Err(error("analysis_identity_unavailable"));
    }
    let tx = immediate(conn)?;
    for s in summaries(&tx)? {
        if s.origin.runtime_epoch == epoch || s.body_state == "purged" {
            continue;
        }
        let complete = s.sealed_through_seq.as_ref() == Some(&s.applied_seq)
            && s.cleanup_state == "confirmed"
            && s.result_state == "projected";
        tx.execute(
            "UPDATE analysis_journals SET history_state=?2 WHERE journal_id=?1",
            params![
                s.journal_id,
                if complete {
                    "historical"
                } else {
                    "interrupted"
                }
            ],
        )
        .map_err(unavailable)?;
    }
    tx.commit().map_err(unavailable)
}
/// Only the supported WAL-aware copy calls this inside its unpublished
/// migration transaction. Original headers/bindings/hashes remain unchanged.
pub fn rotate_for_supported_copy(
    conn: &Connection,
) -> Result<task_mutation::CollectionToken, RecoveryError> {
    conn.execute("UPDATE task_store_metadata SET collection_id=lower(hex(randomblob(32))),epoch=0,legacy_import_closed=1 WHERE id=1",[]).map_err(unavailable)?;
    conn.execute("UPDATE analysis_journals SET history_state=CASE WHEN body_state='purged' THEN 'discarded' WHEN sealed_seq=applied_seq AND cleanup_state='confirmed' AND result_state='projected' THEN 'historical' ELSE 'interrupted' END",[]).map_err(unavailable)?;
    Ok(task_mutation::current(conn)
        .map_err(unavailable)?
        .collection)
}

#[cfg(test)]
mod tests;
