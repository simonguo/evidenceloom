//! Native task-store authority. No caller can obtain authority from a task body.
use super::*;
use rusqlite::{Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, MutexGuard};

static MUTATIONS: Mutex<()> = Mutex::new(());

pub fn coordinator() -> MutexGuard<'static, ()> {
    // A panic cannot grant authority: every subsequent operation checks durable metadata.
    MUTATIONS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionToken {
    pub collection_id: String,
    pub epoch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskHead {
    pub task_id: String,
    pub generation: String,
    pub revision: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct StorageError {
    pub code: String,
    pub message: String,
}

impl StorageError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
        }
    }
    pub fn invalid(message: impl ToString) -> Self {
        Self::new("storage_invalid_request", message)
    }
    pub fn unavailable(message: impl ToString) -> Self {
        Self::new("storage_unavailable", message)
    }
    fn conflict(message: impl ToString) -> Self {
        Self::new("storage_conflict", message)
    }
    fn unknown(message: impl ToString) -> Self {
        Self::new("storage_unknown_outcome", message)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageAuthority {
    pub collection: CollectionToken,
    pub heads: Vec<TaskHead>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStorage {
    #[serde(flatten)]
    pub authority: StorageAuthority,
    pub legacy_task_import_allowed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlMutationReceipt {
    pub protocol_version: u8,
    pub request_id: String,
    pub digest: String,
    pub operation: String,
    pub collection: CollectionToken,
    pub heads: Vec<TaskHead>,
    pub sql_committed: bool,
}

#[derive(Debug, Serialize)]
pub struct MutationReply {
    pub scope: &'static str,
    pub receipt: SqlMutationReceipt,
    pub rejection: Option<StorageError>,
    pub current: StorageAuthority,
}

#[derive(Debug, Serialize)]
pub struct QueryReply {
    pub scope: &'static str,
    pub receipt: Option<SqlMutationReceipt>,
    pub rejection: Option<StorageError>,
    pub current: StorageAuthority,
}

pub struct Packet {
    request_id: String,
    digest: String,
    collection: CollectionToken,
    operation: String,
    expected_heads: Vec<TaskHead>,
    tasks: Vec<Value>,
}

impl Packet {
    pub fn task_id(&self) -> Option<&str> {
        self.expected_heads
            .first()
            .map(|head| head.task_id.as_str())
    }
}

fn counter(value: &str) -> Result<i64, StorageError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(StorageError::invalid("Invalid task-store counter."));
    }
    value
        .parse::<i64>()
        .map_err(|_| StorageError::invalid("Task-store counter is out of range."))
}

fn increment(value: &str) -> Result<String, StorageError> {
    counter(value)?
        .checked_add(1)
        .map(|v| v.to_string())
        .ok_or_else(|| StorageError::conflict("Task-store counter is exhausted."))
}

fn validate_collection(collection: &CollectionToken) -> Result<(), StorageError> {
    if collection.collection_id.is_empty() || collection.collection_id.len() > 128 {
        return Err(StorageError::invalid("Invalid collection identity."));
    }
    counter(&collection.epoch)?;
    Ok(())
}

fn validate_head(head: &TaskHead) -> Result<(), StorageError> {
    if head.task_id.is_empty() || head.task_id.len() > 1024 {
        return Err(StorageError::invalid("Invalid task identity."));
    }
    let g = counter(&head.generation)?;
    let r = counter(&head.revision)?;
    match head.state.as_str() {
        "never_seen" if g == 0 && r == 0 => Ok(()),
        "live" | "tombstone" if g > 0 && r > 0 => Ok(()),
        _ => Err(StorageError::invalid("Invalid task head.")),
    }
}

pub fn parse(request: Value, allowed: &[&str]) -> Result<Packet, StorageError> {
    let object = request
        .as_object()
        .ok_or_else(|| StorageError::invalid("Expected a task mutation packet."))?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| StorageError::invalid("Missing task mutation operation."))?;
    if !allowed.contains(&operation) {
        return Err(StorageError::invalid(
            "Unsupported task mutation operation.",
        ));
    }
    let operation_fields: &[&str] = match operation {
        "create" | "recreate" | "update" => &["expectedHead", "task"],
        "delete" => &["expectedHead"],
        "import" => &["expectedHeads", "tasks"],
        "clear" => &[],
        _ => {
            return Err(StorageError::invalid(
                "Unsupported task mutation operation.",
            ))
        }
    };
    let common = ["protocolVersion", "requestId", "collection", "operation"];
    if object.len() != common.len() + operation_fields.len()
        || common
            .iter()
            .chain(operation_fields)
            .any(|key| !object.contains_key(*key))
        || request["protocolVersion"].as_u64() != Some(1)
    {
        return Err(StorageError::invalid(
            "Invalid task mutation packet fields.",
        ));
    }
    let request_id = request["requestId"]
        .as_str()
        .filter(|id| {
            (1..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
        })
        .ok_or_else(|| StorageError::invalid("Invalid mutation request identity."))?
        .to_string();
    let collection: CollectionToken =
        serde_json::from_value(request["collection"].clone()).map_err(StorageError::invalid)?;
    validate_collection(&collection)?;
    let expected_heads = if operation == "import" {
        serde_json::from_value::<Vec<TaskHead>>(request["expectedHeads"].clone())
            .map_err(StorageError::invalid)?
    } else if operation != "clear" {
        vec![serde_json::from_value(request["expectedHead"].clone())
            .map_err(StorageError::invalid)?]
    } else {
        vec![]
    };
    for head in &expected_heads {
        validate_head(head)?;
    }
    let tasks = if operation == "import" {
        request["tasks"]
            .as_array()
            .ok_or_else(|| StorageError::invalid("Invalid task import batch."))?
            .clone()
    } else if matches!(operation, "create" | "recreate" | "update") {
        vec![request["task"].clone()]
    } else {
        vec![]
    };
    let mut ids = std::collections::BTreeSet::new();
    for head in &expected_heads {
        if !ids.insert(head.task_id.as_str()) {
            return Err(StorageError::invalid("Duplicate task heads."));
        }
    }
    if !tasks.is_empty() || operation == "import" {
        let task_ids: Option<std::collections::BTreeSet<_>> =
            tasks.iter().map(|task| task["id"].as_str()).collect();
        if task_ids.as_ref() != Some(&ids) || tasks.len() != ids.len() {
            return Err(StorageError::invalid(
                "Task bodies and expected heads do not agree.",
            ));
        }
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(
            memory::canonical_json(&request)
                .map_err(StorageError::invalid)?
                .as_bytes()
        )
    );
    Ok(Packet {
        request_id,
        digest,
        collection,
        operation: operation.into(),
        expected_heads,
        tasks,
    })
}

pub fn initialize(conn: &Connection, pristine: bool) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE task_store_metadata (
        id INTEGER PRIMARY KEY CHECK(id=1), collection_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch>=0),
        legacy_import_closed INTEGER NOT NULL CHECK(legacy_import_closed IN (0,1)));
        CREATE TABLE task_store_heads (
        task_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
        state TEXT NOT NULL CHECK(state IN ('live','tombstone')));
        CREATE TABLE task_mutation_requests (
        request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, operation TEXT NOT NULL,
        collection_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch>=0),
        outcome TEXT NOT NULL CHECK(outcome IN ('pending','committed','rejected')),
        receipt_json TEXT, rejection_json TEXT,
        CHECK((outcome='pending' AND receipt_json IS NULL AND rejection_json IS NULL)
           OR (outcome='committed' AND receipt_json IS NOT NULL AND rejection_json IS NULL)
           OR (outcome='rejected' AND receipt_json IS NULL AND rejection_json IS NOT NULL)));")
        .map_err(|e| e.to_string())?;
    // Validate the old task store before granting migrated live heads.
    let tasks = load_tasks_from_conn(conn)?;
    conn.execute(
        "INSERT INTO task_store_metadata VALUES(1,lower(hex(randomblob(32))),0,?1)",
        [i64::from(!pristine || !tasks.is_empty())],
    )
    .map_err(|e| e.to_string())?;
    for task in tasks {
        conn.execute(
            "INSERT INTO task_store_heads VALUES(?1,1,1,'live')",
            [task.id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn current(conn: &Connection) -> Result<StorageAuthority, StorageError> {
    let (collection_id, epoch, closed): (String, i64, i64) = conn
        .query_row(
            "SELECT collection_id,epoch,legacy_import_closed FROM task_store_metadata WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(StorageError::unavailable)?;
    if collection_id.len() != 64
        || !collection_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || epoch < 0
        || ![0, 1].contains(&closed)
    {
        return Err(StorageError::unavailable("Task-store metadata is invalid."));
    }
    let mut statement = conn
        .prepare("SELECT task_id,generation,revision,state FROM task_store_heads ORDER BY task_id")
        .map_err(StorageError::unavailable)?;
    let mut heads = Vec::new();
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(StorageError::unavailable)?;
    for row in rows {
        let (task_id, generation, revision, state) = row.map_err(StorageError::unavailable)?;
        let head = TaskHead {
            task_id,
            generation: generation.to_string(),
            revision: revision.to_string(),
            state,
        };
        validate_head(&head)
            .map_err(|_| StorageError::unavailable("Stored task head is invalid."))?;
        if head.state == "never_seen" {
            return Err(StorageError::unavailable("Stored task head is invalid."));
        }
        heads.push(head);
    }
    let mut bodies = conn
        .prepare("SELECT id FROM tasks ORDER BY id")
        .map_err(StorageError::unavailable)?;
    let body_ids = bodies
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(StorageError::unavailable)?
        .collect::<rusqlite::Result<std::collections::BTreeSet<_>>>()
        .map_err(StorageError::unavailable)?;
    let live_ids = heads
        .iter()
        .filter(|head| head.state == "live")
        .map(|head| head.task_id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    if body_ids != live_ids {
        return Err(StorageError::unavailable(
            "Task bodies and native heads disagree.",
        ));
    }
    Ok(StorageAuthority {
        collection: CollectionToken {
            collection_id,
            epoch: epoch.to_string(),
        },
        heads,
    })
}

pub fn snapshot_storage(
    conn: &Connection,
    tasks: &[AnalysisTaskRecord],
) -> Result<SnapshotStorage, StorageError> {
    let authority = current(conn)?;
    let live: std::collections::BTreeSet<_> = authority
        .heads
        .iter()
        .filter(|h| h.state == "live")
        .map(|h| h.task_id.as_str())
        .collect();
    let bodies: std::collections::BTreeSet<_> = tasks.iter().map(|t| t.id.as_str()).collect();
    if live != bodies {
        return Err(StorageError::unavailable(
            "Task bodies and native heads disagree.",
        ));
    }
    let closed: bool = conn
        .query_row(
            "SELECT legacy_import_closed FROM task_store_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(StorageError::unavailable)?;
    Ok(SnapshotStorage {
        authority,
        legacy_task_import_allowed: !closed,
    })
}

fn immediate(conn: &Connection) -> Result<Transaction<'_>, StorageError> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(StorageError::unavailable)
}

enum Outcome {
    Missing,
    Pending,
    Committed(SqlMutationReceipt),
    Rejected(StorageError),
}

struct StoredOutcome {
    digest: String,
    operation: String,
    collection_id: String,
    epoch: i64,
    state: String,
    receipt: Option<String>,
    rejection: Option<String>,
}

fn outcome(conn: &Connection, packet: &Packet) -> Result<Outcome, StorageError> {
    let row: Option<StoredOutcome> = conn.query_row(
        "SELECT digest,operation,collection_id,epoch,outcome,receipt_json,rejection_json FROM task_mutation_requests WHERE request_id=?1",
        [&packet.request_id], |r| Ok(StoredOutcome {digest:r.get(0)?,operation:r.get(1)?,collection_id:r.get(2)?,epoch:r.get(3)?,state:r.get(4)?,receipt:r.get(5)?,rejection:r.get(6)?}))
        .optional().map_err(StorageError::unavailable)?;
    let Some(StoredOutcome {
        digest,
        operation,
        collection_id,
        epoch,
        state,
        receipt,
        rejection,
    }) = row
    else {
        return Ok(Outcome::Missing);
    };
    if digest != packet.digest {
        return Err(StorageError::conflict(
            "Mutation request identity was reused for another packet.",
        ));
    }
    if operation != packet.operation
        || collection_id != packet.collection.collection_id
        || epoch.to_string() != packet.collection.epoch
    {
        return Err(StorageError::unavailable(
            "Stored mutation binding is invalid.",
        ));
    }
    match (state.as_str(), receipt, rejection) {
        ("pending", None, None) => Ok(Outcome::Pending),
        ("committed", Some(raw), None) => {
            let receipt: SqlMutationReceipt =
                serde_json::from_str(&raw).map_err(StorageError::unavailable)?;
            if receipt.protocol_version != 1
                || !receipt.sql_committed
                || receipt.request_id != packet.request_id
                || receipt.digest != packet.digest
                || receipt.operation != packet.operation
                || receipt.collection.collection_id != packet.collection.collection_id
            {
                return Err(StorageError::unavailable(
                    "Stored mutation receipt is invalid.",
                ));
            }
            let expected_epoch = if packet.operation == "clear" {
                increment(&packet.collection.epoch)?
            } else {
                packet.collection.epoch.clone()
            };
            if receipt.collection.epoch != expected_epoch || receipt.heads != next_heads(packet)? {
                return Err(StorageError::unavailable(
                    "Stored mutation outcome does not match its packet.",
                ));
            }
            validate_collection(&receipt.collection)
                .map_err(|_| StorageError::unavailable("Stored receipt collection is invalid."))?;
            for head in &receipt.heads {
                validate_head(head)
                    .map_err(|_| StorageError::unavailable("Stored receipt head is invalid."))?;
            }
            Ok(Outcome::Committed(receipt))
        }
        ("rejected", None, Some(raw)) => {
            let error: StorageError =
                serde_json::from_str(&raw).map_err(StorageError::unavailable)?;
            if ![
                "storage_invalid_request",
                "storage_conflict",
                "storage_owned",
                "storage_unavailable",
                "storage_unknown_outcome",
                "storage_partial_clear",
            ]
            .contains(&error.code.as_str())
                || safe_rejection(error.clone()) != error
            {
                return Err(StorageError::unavailable("Stored rejection is invalid."));
            }
            Ok(Outcome::Rejected(error))
        }
        _ => Err(StorageError::unavailable(
            "Stored mutation outcome is invalid.",
        )),
    }
}

pub fn query(conn: &Connection, packet: &Packet) -> Result<QueryReply, StorageError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)
        .map_err(StorageError::unavailable)?;
    let current = current(&tx)?;
    let (receipt, rejection) = match outcome(&tx, packet)? {
        Outcome::Committed(receipt) => (Some(receipt), None),
        Outcome::Rejected(error) => (None, Some(error)),
        Outcome::Pending | Outcome::Missing => (None, None),
    };
    tx.commit().map_err(StorageError::unavailable)?;
    Ok(QueryReply {
        scope: "sql",
        receipt,
        rejection,
        current,
    })
}

fn reply(
    conn: &Connection,
    receipt: SqlMutationReceipt,
    scope: &'static str,
) -> Result<MutationReply, StorageError> {
    Ok(MutationReply {
        scope,
        receipt,
        rejection: None,
        current: current(conn)?,
    })
}

pub fn replay(conn: &Connection, packet: &Packet) -> Result<Option<MutationReply>, StorageError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)
        .map_err(StorageError::unavailable)?;
    let result = match outcome(&tx, packet)? {
        Outcome::Committed(receipt) => Some(reply(&tx, receipt, "sql")?),
        Outcome::Rejected(error) => return Err(error),
        Outcome::Pending => {
            return Err(StorageError::unknown(
                "The original clear outcome is not confirmed.",
            ))
        }
        Outcome::Missing => None,
    };
    tx.commit().map_err(StorageError::unavailable)?;
    Ok(result)
}

fn bind(conn: &Connection, packet: &Packet) -> Result<(), StorageError> {
    conn.execute("INSERT INTO task_mutation_requests(request_id,digest,operation,collection_id,epoch,outcome) VALUES(?1,?2,?3,?4,?5,'pending')",
        params![packet.request_id,packet.digest,packet.operation,packet.collection.collection_id,counter(&packet.collection.epoch)?])
        .map_err(StorageError::unavailable)?;
    Ok(())
}

fn safe_rejection(error: StorageError) -> StorageError {
    // Durable metadata survives privacy clear: never retain decoder/domain/SQL payload text.
    let message = match error.code.as_str() {
        "storage_invalid_request" => "The task body or research attachments are invalid.",
        "storage_conflict" => "The captured task-store authority no longer permits this mutation.",
        "storage_owned" => "The task store is owned by an active analysis. Complete or stop it before removing data.",
        "storage_partial_clear" => "Settings or credentials may have been partially cleared; complete clearing is not confirmed.",
        _ => "The task SQL mutation did not complete; inspect its original request outcome before proceeding.",
    };
    StorageError {
        code: error.code,
        message: message.into(),
    }
}

fn reject(conn: &Connection, packet: &Packet, error: &StorageError) -> Result<(), StorageError> {
    let raw = serde_json::to_string(error).map_err(StorageError::unavailable)?;
    let changed = conn.execute("UPDATE task_mutation_requests SET outcome='rejected',rejection_json=?2 WHERE request_id=?1 AND outcome='pending'",
        params![packet.request_id,raw]).map_err(StorageError::unavailable)?;
    if changed != 1 {
        return Err(StorageError::unknown(
            "Could not confirm rejection recording.",
        ));
    }
    Ok(())
}

fn commit_receipt(
    conn: &Connection,
    packet: &Packet,
    heads: Vec<TaskHead>,
) -> Result<SqlMutationReceipt, StorageError> {
    let receipt = SqlMutationReceipt {
        protocol_version: 1,
        request_id: packet.request_id.clone(),
        digest: packet.digest.clone(),
        operation: packet.operation.clone(),
        collection: current(conn)?.collection,
        heads,
        sql_committed: true,
    };
    let raw = serde_json::to_string(&receipt).map_err(StorageError::unavailable)?;
    let changed = conn.execute("UPDATE task_mutation_requests SET outcome='committed',receipt_json=?2 WHERE request_id=?1 AND outcome='pending'",
        params![packet.request_id,raw]).map_err(StorageError::unavailable)?;
    if changed != 1 {
        return Err(StorageError::unknown(
            "Could not confirm receipt recording.",
        ));
    }
    Ok(receipt)
}

fn check_authority(conn: &Connection, packet: &Packet) -> Result<StorageAuthority, StorageError> {
    let current = current(conn)?;
    if current.collection != packet.collection {
        return Err(StorageError::conflict("The task collection changed."));
    }
    for expected in &packet.expected_heads {
        let actual = current
            .heads
            .iter()
            .find(|h| h.task_id == expected.task_id)
            .cloned()
            .unwrap_or_else(|| TaskHead {
                task_id: expected.task_id.clone(),
                generation: "0".into(),
                revision: "0".into(),
                state: "never_seen".into(),
            });
        if actual != *expected {
            return Err(StorageError::conflict("The task changed or was removed."));
        }
    }
    Ok(current)
}

fn write_head(conn: &Connection, head: &TaskHead) -> Result<(), StorageError> {
    conn.execute("INSERT INTO task_store_heads VALUES(?1,?2,?3,?4) ON CONFLICT(task_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,state=excluded.state",
        params![head.task_id,counter(&head.generation)?,counter(&head.revision)?,head.state]).map_err(StorageError::unavailable)?;
    Ok(())
}

fn next_heads(packet: &Packet) -> Result<Vec<TaskHead>, StorageError> {
    let mut heads = Vec::new();
    for expected in &packet.expected_heads {
        let mut head = expected.clone();
        match packet.operation.as_str() {
            "create" | "import" if expected.state == "never_seen" => {
                head.generation = "1".into();
                head.revision = "1".into();
                head.state = "live".into();
            }
            "recreate" if expected.state == "tombstone" => {
                head.generation = increment(&head.generation)?;
                head.revision = "1".into();
                head.state = "live".into();
            }
            "update" if expected.state == "live" => {
                head.revision = increment(&head.revision)?;
            }
            "delete" => {
                if expected.state == "never_seen" {
                    head.generation = "1".into();
                    head.revision = "1".into();
                } else {
                    head.revision = increment(&head.revision)?;
                }
                head.state = "tombstone".into();
            }
            _ => {
                return Err(StorageError::conflict(
                    "This operation cannot use the captured task head.",
                ))
            }
        }
        // Compute all counters before the first attachment write for this operation.
        heads.push(head);
    }
    Ok(heads)
}

pub(super) fn effects(conn: &Connection, packet: &Packet) -> Result<Vec<TaskHead>, StorageError> {
    check_authority(conn, packet)?;
    if packet.operation == "import" {
        let closed: bool = conn
            .query_row(
                "SELECT legacy_import_closed FROM task_store_metadata WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(StorageError::unavailable)?;
        if closed || !current(conn)?.heads.is_empty() {
            return Err(StorageError::conflict("Legacy task import is closed."));
        }
    }
    let heads = next_heads(packet)?;
    for value in &packet.tasks {
        let task: AnalysisTaskRecord = serde_json::from_value(value.clone())
            .map_err(|_| StorageError::invalid("The task body could not be decoded."))?;
        let task = normalize_task(task);
        validate_task_input(&task)
            .map_err(|_| StorageError::invalid("The task research attachments are invalid."))?;
        // Existing immutable-history errors and SQLite errors remain distinct conservative outcomes.
        upsert_task(conn, &task).map_err(|_| {
            StorageError::unavailable("The saved task or report attachments could not be updated.")
        })?;
    }
    if packet.operation == "delete" {
        super::analysis_journal::purge_projected_task(conn, &packet.expected_heads[0].task_id)
            .map_err(|_| {
                StorageError::new(
                    "storage_owned",
                    "Unconfirmed research output prevents removing this task.",
                )
            })?;
        conn.execute(
            "DELETE FROM tasks WHERE id=?1",
            [&packet.expected_heads[0].task_id],
        )
        .map_err(StorageError::unavailable)?;
    }
    for head in &heads {
        write_head(conn, head)?;
    }
    prune_evidence(conn).map_err(|_| {
        StorageError::unavailable("The task attachment prune could not be completed.")
    })?;
    conn.execute(
        "UPDATE task_store_metadata SET legacy_import_closed=1 WHERE id=1",
        [],
    )
    .map_err(StorageError::unavailable)?;
    Ok(heads)
}

pub fn execute(conn: &Connection, packet: &Packet) -> Result<MutationReply, StorageError> {
    if packet.operation == "clear" {
        return Err(StorageError::invalid(
            "Clear requires the guarded external-stage command.",
        ));
    }
    let tx = immediate(conn)?;
    match outcome(&tx, packet)? {
        Outcome::Committed(receipt) => return reply(&tx, receipt, "sql"),
        Outcome::Rejected(error) => return Err(error),
        Outcome::Pending => {
            return Err(StorageError::unknown(
                "The original mutation outcome is pending.",
            ))
        }
        Outcome::Missing => {}
    }
    bind(&tx, packet)?;
    tx.execute_batch("SAVEPOINT task_effects")
        .map_err(StorageError::unavailable)?;
    match effects(&tx, packet) {
        Ok(heads) => {
            let receipt = commit_receipt(&tx, packet, heads)?;
            tx.execute_batch("RELEASE task_effects")
                .map_err(StorageError::unavailable)?;
            let result = reply(&tx, receipt, "sql")?;
            tx.commit()
                .map_err(|e| StorageError::unknown(e.to_string()))?;
            Ok(result)
        }
        Err(error) => {
            let error = safe_rejection(error);
            tx.execute_batch("ROLLBACK TO task_effects; RELEASE task_effects")
                .map_err(StorageError::unavailable)?;
            reject(&tx, packet, &error)?;
            tx.commit()
                .map_err(|e| StorageError::unknown(e.to_string()))?;
            Err(error)
        }
    }
}

pub fn reject_owned(
    conn: &Connection,
    packet: &Packet,
    _message: String,
) -> Result<MutationReply, StorageError> {
    let tx = immediate(conn)?;
    match outcome(&tx, packet)? {
        Outcome::Committed(receipt) => return reply(&tx, receipt, "sql"),
        Outcome::Rejected(error) => return Err(error),
        Outcome::Pending => {
            return Err(StorageError::unknown(
                "The original mutation outcome is pending.",
            ))
        }
        Outcome::Missing => {}
    }
    bind(&tx, packet)?;
    let error = StorageError::new(
        "storage_owned",
        "The task store is owned by an active analysis. Complete or stop it before removing data.",
    );
    reject(&tx, packet, &error)?;
    tx.commit()
        .map_err(|e| StorageError::unknown(e.to_string()))?;
    Err(error)
}

pub fn clear<F>(
    conn: &Connection,
    packet: &Packet,
    external: F,
) -> Result<MutationReply, StorageError>
where
    F: FnOnce() -> Result<(), String>,
{
    // The caller retains runtime admission and the mutation coordinator across both transactions.
    if packet.operation != "clear" {
        return Err(StorageError::invalid("Only clear packets can clear data."));
    }
    let tx = immediate(conn)?;
    match outcome(&tx, packet)? {
        Outcome::Committed(receipt) => return reply(&tx, receipt, "sql"),
        Outcome::Rejected(error) => return Err(error),
        Outcome::Pending => {
            return Err(StorageError::unknown(
                "The original clear outcome is pending.",
            ))
        }
        Outcome::Missing => {}
    }
    bind(&tx, packet)?;
    let epoch = match check_authority(&tx, packet).and_then(|_| increment(&packet.collection.epoch))
    {
        Ok(epoch) => epoch,
        Err(error) => {
            let error = safe_rejection(error);
            reject(&tx, packet, &error)?;
            tx.commit()
                .map_err(|e| StorageError::unknown(e.to_string()))?;
            return Err(error);
        }
    };
    if super::analysis_journal::assert_removal_allowed(&tx, None).is_err() {
        let error = safe_rejection(StorageError::new(
            "storage_owned",
            "Unconfirmed research output prevents clearing data.",
        ));
        reject(&tx, packet, &error)?;
        tx.commit()
            .map_err(|e| StorageError::unknown(e.to_string()))?;
        return Err(error);
    }
    tx.commit()
        .map_err(|e| StorageError::unknown(e.to_string()))?;
    if external().is_err() {
        let tx = immediate(conn)?;
        let error = safe_rejection(StorageError::new("storage_partial_clear", "Settings or credentials may have been partially cleared; complete clearing is not confirmed."));
        reject(&tx, packet, &error)?;
        tx.commit()
            .map_err(|e| StorageError::unknown(e.to_string()))?;
        return Err(error);
    }
    let tx = immediate(conn)?;
    // The second check detects an unsupported external writer without blind clearing.
    check_authority(&tx, packet)
        .map_err(|e| StorageError::new("storage_partial_clear", e.message))?;
    clear_sql(&tx).map_err(|_| {
        StorageError::new(
            "storage_partial_clear",
            "External clearing finished but task SQL clearing is not confirmed.",
        )
    })?;
    tx.execute("DELETE FROM task_store_heads", [])
        .map_err(StorageError::unavailable)?;
    tx.execute(
        "UPDATE task_store_metadata SET epoch=?1,legacy_import_closed=1 WHERE id=1",
        [counter(&epoch)?],
    )
    .map_err(StorageError::unavailable)?;
    let receipt = commit_receipt(&tx, packet, vec![])?;
    let result = reply(&tx, receipt, "desktop_clear")?;
    tx.commit()
        .map_err(|e| StorageError::unknown(e.to_string()))?;
    Ok(result)
}

#[cfg(test)]
mod tests;
