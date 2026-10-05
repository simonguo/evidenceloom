use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

use crate::evidence::{validate_bundle, validate_invalid};
use crate::output_quality::{normalize_output_quality, normalize_report_version_quality};
use crate::secrets;
use crate::{
    effective_request_identity as identity, effective_request_identity_storage as identity_store,
};
use crate::{numeric_review as numeric, numeric_review_storage as numeric_store};
use crate::{research_memory as memory, research_memory_storage as memory_store};
use crate::{research_readiness as readiness, research_readiness_storage as readiness_store};

pub mod analysis_journal;
pub mod task_mutation;
pub use task_mutation::{MutationReply, Packet, QueryReply, StorageError};

const SCHEMA_VERSION: i64 = 12;
const SECRET_PREFIX: &str = "enc:v1:";
static DATABASE_OPEN: std::sync::Mutex<()> = std::sync::Mutex::new(());
static COPY_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSettings {
    pub llm_provider: String,
    pub backend_url: String,
    pub quick_think_llm: String,
    pub deep_think_llm: String,
    #[serde(default)]
    pub temperature: String,
    #[serde(default)]
    pub openai_reasoning_effort: String,
    #[serde(default)]
    pub google_thinking_level: String,
    #[serde(default)]
    pub anthropic_effort: String,
    #[serde(default = "default_core_stock_apis")]
    pub core_stock_apis: String,
    #[serde(default = "default_technical_indicators")]
    pub technical_indicators: String,
    #[serde(default = "default_fundamental_data")]
    pub fundamental_data: String,
    #[serde(default = "default_news_data")]
    pub news_data: String,
    #[serde(default = "default_news_article_limit")]
    pub news_article_limit: i64,
    #[serde(default = "default_global_news_article_limit")]
    pub global_news_article_limit: i64,
    #[serde(default = "default_global_news_lookback_days")]
    pub global_news_lookback_days: i64,
    #[serde(default = "default_rounds")]
    pub max_debate_rounds: i64,
    #[serde(default = "default_rounds")]
    pub max_risk_rounds: i64,
    #[serde(default = "default_concurrency")]
    pub analyst_concurrency_limit: i64,
    #[serde(default)]
    pub benchmark_ticker: String,
    pub checkpoint_enabled: bool,
    pub python_path: String,
    pub project_root: String,
    pub system_language: String,
    #[serde(default)]
    pub provider_configured: bool,
    #[serde(default)]
    pub alpha_vantage_configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    #[serde(flatten)]
    pub settings: StoredSettings,
}

fn default_core_stock_apis() -> String {
    "eastmoney,yfinance".to_string()
}
fn default_technical_indicators() -> String {
    "yfinance".to_string()
}
fn default_fundamental_data() -> String {
    "akshare,yfinance".to_string()
}
fn default_news_data() -> String {
    "yfinance".to_string()
}
fn default_news_article_limit() -> i64 {
    20
}
fn default_global_news_article_limit() -> i64 {
    10
}
fn default_global_news_lookback_days() -> i64 {
    7
}
fn default_rounds() -> i64 {
    0
}
fn default_concurrency() -> i64 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisTaskRecord {
    pub id: String,
    #[serde(default = "default_task_origin")]
    pub origin: String,
    pub ticker: String,
    #[serde(default)]
    pub instrument_name: String,
    pub analysis_date: String,
    pub asset_type: String,
    pub research_depth: i64,
    pub analysts: Value,
    pub output_language: String,
    pub status: String,
    #[serde(default)]
    pub queued_at: String,
    #[serde(default)]
    pub queue_order: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub decision: String,
    pub stats: Value,
    pub agent_statuses: Value,
    pub report_sections: Value,
    #[serde(default = "empty_array")]
    pub report_versions: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_quality: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_bundle: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_validation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bundle: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_validation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_readiness: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_validation: Option<Value>,
    #[serde(default = "empty_array")]
    pub evaluation_reviews: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_text_snapshot: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numeric_validation: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_identity_attachment"
    )]
    pub effective_request_identity: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_identity_attachment"
    )]
    pub identity_validation: Option<Value>,
    pub logs: Value,
    pub error: String,
}

fn non_null_identity_attachment<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom(identity::ERROR));
    }
    Ok(Some(value))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDesktopData {
    pub settings: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub storage: task_mutation::SnapshotStorage,
    pub settings: Option<PublicSettings>,
    pub tasks: Vec<AnalysisTaskRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_migration_error: Option<String>,
}

pub fn load_snapshot(app: &AppHandle) -> Result<DesktopSnapshot, StorageError> {
    let conn = open_database(app).map_err(StorageError::unavailable)?;
    let (settings, secret_migration_error) =
        load_settings_from_conn(app, &conn).map_err(StorageError::unavailable)?;
    snapshot_from_conn(&conn, settings, secret_migration_error)
}

fn snapshot_from_conn(
    conn: &Connection,
    settings: Option<StoredSettings>,
    secret_migration_error: Option<String>,
) -> Result<DesktopSnapshot, StorageError> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Deferred)
        .map_err(StorageError::unavailable)?;
    let tasks = load_tasks_from_conn(&tx).map_err(StorageError::unavailable)?;
    let storage = task_mutation::snapshot_storage(&tx, &tasks)?;
    tx.commit().map_err(StorageError::unavailable)?;
    Ok(DesktopSnapshot {
        storage,
        settings: settings.map(public_settings),
        tasks,
        secret_migration_error,
    })
}

pub fn save_settings(app: &AppHandle, settings: StoredSettings) -> Result<(), String> {
    let conn = open_database(app)?;
    let settings_json = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO settings (id, value, updated_at) VALUES ('global', ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![settings_json],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn parse_request(request: Value, operations: &[&str]) -> Result<Packet, StorageError> {
    task_mutation::parse(request, operations)
}

pub fn save_task(app: &AppHandle, request: Value) -> Result<MutationReply, StorageError> {
    let packet = parse_request(request, &["create", "recreate", "update"])?;
    mutate_task(app, &packet)
}

pub fn import_tasks(app: &AppHandle, request: Value) -> Result<MutationReply, StorageError> {
    let packet = parse_request(request, &["import"])?;
    mutate_task(app, &packet)
}

fn mutate_task(app: &AppHandle, packet: &Packet) -> Result<MutationReply, StorageError> {
    let _coordinator = task_mutation::coordinator();
    let conn = open_database(app).map_err(StorageError::unavailable)?;
    task_mutation::execute(&conn, packet)
}

pub fn replay_task_mutation(
    app: &AppHandle,
    packet: &Packet,
) -> Result<Option<MutationReply>, StorageError> {
    let conn = open_database(app).map_err(StorageError::unavailable)?;
    task_mutation::replay(&conn, packet)
}

pub fn query_task_mutation(app: &AppHandle, request: Value) -> Result<QueryReply, StorageError> {
    let packet = parse_request(
        request,
        &["create", "recreate", "update", "delete", "import", "clear"],
    )?;
    let conn = open_database(app).map_err(StorageError::unavailable)?;
    task_mutation::query(&conn, &packet)
}

pub fn reject_owned_task_mutation(
    app: &AppHandle,
    packet: &Packet,
    message: String,
) -> Result<MutationReply, StorageError> {
    let _coordinator = task_mutation::coordinator();
    let conn = open_database(app).map_err(StorageError::unavailable)?;
    task_mutation::reject_owned(&conn, packet, message)
}

pub fn delete_task(app: &AppHandle, packet: &Packet) -> Result<MutationReply, StorageError> {
    mutate_task(app, packet)
}

pub fn clear_data(app: &AppHandle, packet: &Packet) -> Result<MutationReply, StorageError> {
    let _coordinator = task_mutation::coordinator();
    let conn = open_database(app).map_err(StorageError::unavailable)?;
    task_mutation::clear(&conn, packet, || {
        // Read only: settings loading can migrate secrets and must not precede the fence.
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE id='global'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        let provider = raw
            .map(|raw| serde_json::from_str::<StoredSettings>(&raw))
            .transpose()
            .map_err(|e| e.to_string())?
            .map(|s| s.llm_provider);
        secrets::delete_all_secrets(provider.as_deref())
    })
}

fn clear_sql(conn: &Connection) -> Result<(), String> {
    analysis_journal::purge_projected_collection(conn).map_err(|error| error.message)?;
    memory_store::clear(conn)?;
    readiness_store::clear(conn)?;
    identity_store::clear(conn)?;
    numeric_store::clear(conn)?;
    conn.execute_batch(
        "DELETE FROM task_report_versions; DELETE FROM task_reports; DELETE FROM task_logs;
        DELETE FROM tasks; DELETE FROM evidence_bundle_artifacts; DELETE FROM evidence_bundles;
        DELETE FROM evidence_artifacts; DELETE FROM settings;",
    )
    .map_err(|e| e.to_string())
}

fn settings_only_legacy(legacy: Value) -> Result<LegacyDesktopData, StorageError> {
    let object = legacy
        .as_object()
        .ok_or_else(|| StorageError::invalid("Invalid settings import packet."))?;
    if object.keys().any(|key| key != "settings") {
        return Err(StorageError::invalid(
            "Task import requires a fenced task-only request.",
        ));
    }
    serde_json::from_value(legacy)
        .map_err(|_| StorageError::invalid("Invalid settings import packet."))
}

fn with_settings_only_legacy<T>(
    legacy: Value,
    apply: impl FnOnce(LegacyDesktopData) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    // Presence, rather than Option decoding, rejects even tasks:null and tasks:[].
    apply(settings_only_legacy(legacy)?)
}

pub fn import_legacy(app: &AppHandle, legacy: Value) -> Result<DesktopSnapshot, StorageError> {
    with_settings_only_legacy(legacy, |legacy| {
        let conn = open_database(app).map_err(StorageError::unavailable)?;
        let (current_settings, mut secret_migration_error) =
            load_settings_from_conn(app, &conn).map_err(StorageError::unavailable)?;
        if current_settings.is_none() {
            if let Some(settings) = legacy.settings {
                let mut parsed = serde_json::from_value::<StoredSettings>(settings.clone())
                    .map_err(|_| StorageError::invalid("Invalid legacy settings."))?;
                match migrate_legacy_secrets(app, &settings, &parsed.llm_provider) {
                    Ok(()) => {
                        mark_legacy_secret_status(&mut parsed, &settings);
                        save_settings_to_conn(&conn, &parsed).map_err(StorageError::unavailable)?;
                    }
                    Err(error) => secret_migration_error = Some(error),
                }
            }
        }
        let (settings, error) =
            load_settings_from_conn(app, &conn).map_err(StorageError::unavailable)?;
        if secret_migration_error.is_none() {
            secret_migration_error = error;
        }
        snapshot_from_conn(&conn, settings, secret_migration_error)
    })
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let _opening = DATABASE_OPEN
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // database_path performs any supported legacy copy before this observation.
    let pristine = !path.exists();
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    initialize_schema_with_origin(&conn, pristine)?;
    Ok(conn)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let database = app_data.join("evidenceloom.db");
    if database.exists() {
        return Ok(database);
    }

    for legacy in database_migration_candidates(&app_data) {
        if legacy.is_file() {
            fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
            copy_legacy_database(&legacy, &database)?;
            break;
        }
    }
    Ok(database)
}

fn copy_legacy_database(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or("Invalid task database destination.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = None;
    for _ in 0..128 {
        let sequence = COPY_SEQUENCE
            .fetch_update(
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
                |value| value.checked_add(1),
            )
            .map_err(|_| "Database copy identity exhausted.")?;
        let path = parent.join(format!(
            ".evidenceloom-copy-{}-{sequence}.db",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => {
                drop(file);
                temporary = Some(path);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary = temporary.ok_or("Could not reserve a database copy file.")?;
    struct OwnedCopy(PathBuf);
    impl Drop for OwnedCopy {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let owned = OwnedCopy(temporary);
    let source = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    source
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    // SQLite provides a consistent copy, including committed WAL content; do not copy a live main file.
    source
        .execute(
            "VACUUM INTO ?1",
            [owned.0.to_str().ok_or("Unsupported database copy path.")?],
        )
        .map_err(|e| e.to_string())?;
    // Publish an already migrated/import-closed copy. Another opener must never observe a copied open marker.
    let copied = Connection::open(&owned.0).map_err(|e| e.to_string())?;
    initialize_schema_with_origin_kind(&copied, false, true)?;
    drop(copied);
    match fs::hard_link(&owned.0, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!(
            "Could not publish the legacy task database: {error}"
        )),
    }
}

fn database_migration_candidates(app_data: &std::path::Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        app_data.join("marketquorum.db"),
        app_data.join("tradingagents.db"),
    ];
    if let Some(parent) = app_data.parent() {
        candidates.push(
            parent
                .join("io.github.simonguo.marketquorum")
                .join("marketquorum.db"),
        );
        candidates.push(
            parent
                .join("com.tradingagents.desktop")
                .join("tradingagents.db"),
        );
    }
    candidates
}

fn legacy_data_candidates(app_data: &std::path::Path, filename: &str) -> Vec<PathBuf> {
    let mut candidates = vec![app_data.join(filename)];
    if let Some(parent) = app_data.parent() {
        candidates.push(parent.join("com.tradingagents.desktop").join(filename));
    }
    candidates
}

#[cfg(test)]
fn initialize_schema(conn: &Connection) -> Result<(), String> {
    initialize_schema_with_origin(conn, false)
}

/// Owned native-command fixtures use the production migration without an
/// AppHandle, user database, settings hydration, or credential access.
#[cfg(test)]
pub(crate) fn initialize_analysis_journal_fixture(conn: &Connection) -> Result<(), String> {
    initialize_schema_with_origin(conn, true)
}

fn initialize_schema_with_origin(conn: &Connection, pristine: bool) -> Result<(), String> {
    initialize_schema_with_origin_kind(conn, pristine, false)
}

fn initialize_schema_with_origin_kind(
    conn: &Connection,
    pristine: bool,
    copied: bool,
) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys=ON")
        .map_err(|e| e.to_string())?;
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let has_migrations: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')", [], |row|row.get(0)).map_err(|e|e.to_string())?;
    let previous: Option<i64> = if has_migrations {
        tx.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?
    } else {
        None
    };
    if previous.is_some_and(|version| version > SCHEMA_VERSION) {
        return Err("Task database is newer than this application.".into());
    }
    let existing_tables: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    // Version 11 introduced native mutation authority. Raising the current
    // version must never authorize reconstruction of damaged version-11 data.
    if previous.is_some_and(|version| version >= 11) {
        for table in [
            "task_store_metadata",
            "task_store_heads",
            "task_mutation_requests",
        ] {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                return Err("Task-store authority is missing.".into());
            }
        }
        tx.prepare("SELECT request_id,digest,operation,collection_id,epoch,outcome,receipt_json,rejection_json FROM task_mutation_requests")
            .map_err(|_| "Task-store authority is invalid.")?;
    }
    initialize_tables(&tx)?;
    let has_metadata: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_store_metadata')", [], |row|row.get(0)).map_err(|e|e.to_string())?;
    if !has_metadata {
        if previous.is_some_and(|version| version >= 11) {
            return Err("Task-store authority is missing.".into());
        }
        backfill_legacy_report_versions(&tx)?;
        task_mutation::initialize(&tx, pristine && previous.is_none() && existing_tables == 0)?;
    }
    task_mutation::current(&tx).map_err(|_| "Task-store authority is invalid.")?;
    // A missing/corrupt journal at version 12 is unavailable, not a new empty
    // history. Migration and validation share this existing transaction.
    analysis_journal::initialize(
        &tx,
        previous.unwrap_or(0) as u32,
        pristine && previous.is_none() && existing_tables == 0,
    )
    .map_err(|error| error.message)?;
    if copied {
        analysis_journal::rotate_for_supported_copy(&tx).map_err(|error| error.message)?;
        tx.execute(
            "UPDATE task_store_metadata SET legacy_import_closed=1 WHERE id=1",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version) VALUES(?1)",
        params![SCHEMA_VERSION],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Call from blocking work. SQL never acquires a runtime/process mutex.
pub fn with_analysis_journal<T, F>(
    app: &AppHandle,
    operation: F,
) -> Result<T, crate::analysis_recovery::wire::RecoveryError>
where
    F: FnOnce(&Connection) -> Result<T, crate::analysis_recovery::wire::RecoveryError>,
{
    let _mutation = task_mutation::coordinator();
    let conn =
        open_database(app).map_err(|_| analysis_journal::error("analysis_storage_unavailable"))?;
    operation(&conn)
}

/// Production backing store for the shared native coordinator. The caller
/// schedules blocking work; the SQL adapter performs no credential or IPC work.
#[derive(Clone)]
pub struct AppJournalBackend {
    app: AppHandle,
}
impl AppJournalBackend {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}
impl crate::analysis_recovery::runtime::JournalBackend for AppJournalBackend {
    fn terminal_observed(
        &self,
        journal_id: &str,
    ) -> Result<bool, crate::analysis_recovery::wire::RecoveryError> {
        with_analysis_journal(&self.app, |c| {
            analysis_journal::terminal_observed(c, journal_id)
        })
    }
    fn interrupt_prior_epochs(
        &self,
        epoch: &str,
    ) -> Result<(), crate::analysis_recovery::wire::RecoveryError> {
        with_analysis_journal(&self.app, |c| {
            analysis_journal::interrupt_prior_epochs(c, epoch)
        })
    }
    fn bootstrap(
        &self,
    ) -> Result<analysis_journal::SqlRecoveryCut, crate::analysis_recovery::wire::RecoveryError>
    {
        with_analysis_journal(&self.app, analysis_journal::bootstrap)
    }
    fn current(
        &self,
        id: &str,
    ) -> Result<analysis_journal::SqlCurrent, crate::analysis_recovery::wire::RecoveryError> {
        with_analysis_journal(&self.app, |c| analysis_journal::current(c, id))
    }
    fn admit(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::AdmissionRequest,
        >,
        s: &analysis_journal::AdmissionSeed,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::AdmissionReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::admit(c, p, s))
    }
    fn reject_admission(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::AdmissionRequest,
        >,
        s: &analysis_journal::AdmissionSeed,
        e: &crate::analysis_recovery::wire::RecoveryError,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::AdmissionReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| {
            analysis_journal::reject_admission(c, p, s, e)
        })
    }
    fn query_admission(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::AdmissionRequest,
        >,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::AdmissionReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::query_admission(c, p))
    }
    fn accept_start(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::StartRequest,
        >,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::StartReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::accept_start(c, p))
    }
    fn query_start(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::StartRequest,
        >,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::StartReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::query_start(c, p))
    }
    fn append(
        &self,
        d: &analysis_journal::PublicationDraft,
    ) -> Result<
        crate::analysis_recovery::wire::JournalEnvelope,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::append(c, d))
    }
    fn seal(
        &self,
        r: &analysis_journal::SealRecord,
    ) -> Result<
        crate::analysis_recovery::wire::JournalSummary,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::seal(c, r))
    }
    fn read(
        &self,
        r: &crate::analysis_recovery::wire::ReadRequest,
    ) -> Result<
        crate::analysis_recovery::wire::ReadReply,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::read(c, r))
    }
    fn project(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::ProjectionRequest,
        >,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::ProjectionReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::project(c, p))
    }
    fn query_projection(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::ProjectionRequest,
        >,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::ProjectionReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::query_projection(c, p))
    }
    fn record_control(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::StopRequest,
        >,
        r: &analysis_journal::ControlRecord,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::ControlReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::record_control(c, p, r))
    }
    fn query_control(
        &self,
        p: &crate::analysis_recovery::wire::ParsedRecoveryRequest<
            crate::analysis_recovery::wire::StopRequest,
        >,
    ) -> Result<
        analysis_journal::SqlOutcome<crate::analysis_recovery::wire::ControlReceipt>,
        crate::analysis_recovery::wire::RecoveryError,
    > {
        with_analysis_journal(&self.app, |c| analysis_journal::query_control(c, p))
    }
}

fn initialize_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         );
         CREATE TABLE IF NOT EXISTS settings (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            origin TEXT NOT NULL DEFAULT 'analysis',
            ticker TEXT NOT NULL,
            instrument_name TEXT NOT NULL DEFAULT '',
            analysis_date TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            research_depth INTEGER NOT NULL,
            analysts TEXT NOT NULL,
            output_language TEXT NOT NULL,
            status TEXT NOT NULL,
            queued_at TEXT NOT NULL DEFAULT '',
            queue_order INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            decision TEXT NOT NULL DEFAULT '',
            stats TEXT NOT NULL,
            agent_statuses TEXT NOT NULL,
            report_sections TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            output_quality TEXT
         );
         CREATE TABLE IF NOT EXISTS task_logs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            agent TEXT
         );
         CREATE TABLE IF NOT EXISTS task_reports (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            report_key TEXT NOT NULL,
            content TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (task_id, report_key)
         );
         CREATE TABLE IF NOT EXISTS task_report_versions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            version_number INTEGER NOT NULL,
            run_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            UNIQUE(task_id, version_number),
            UNIQUE(task_id, run_id)
         );
         CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
         CREATE INDEX IF NOT EXISTS idx_task_report_versions_task_id
            ON task_report_versions(task_id, version_number DESC);
         CREATE TABLE IF NOT EXISTS evidence_artifacts (
            sha256 TEXT PRIMARY KEY,
            payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS evidence_bundles (
            sha256 TEXT PRIMARY KEY,
            metadata TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS evidence_bundle_artifacts (
            bundle_sha256 TEXT NOT NULL REFERENCES evidence_bundles(sha256) ON DELETE CASCADE,
            artifact_sha256 TEXT NOT NULL REFERENCES evidence_artifacts(sha256),
            PRIMARY KEY(bundle_sha256, artifact_sha256)
         );",
    )
    .map_err(|error| error.to_string())?;
    memory_store::initialize(conn)?;
    readiness_store::initialize(conn)?;
    numeric_store::initialize(conn)?;
    identity_store::initialize(conn)?;
    ensure_column(conn, "tasks", "identity_assessment_sha256", "TEXT")?;
    ensure_column(conn, "tasks", "identity_validation", "TEXT")?;
    ensure_column(
        conn,
        "task_report_versions",
        "identity_assessment_sha256",
        "TEXT",
    )?;
    ensure_column(conn, "tasks", "instrument_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tasks", "origin", "TEXT NOT NULL DEFAULT 'analysis'")?;
    ensure_column(conn, "tasks", "queued_at", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tasks", "queue_order", "INTEGER")?;
    ensure_column(conn, "tasks", "output_quality", "TEXT")?;
    ensure_column(conn, "tasks", "evidence_bundle_sha256", "TEXT")?;
    ensure_column(conn, "tasks", "evidence_validation", "TEXT")?;
    ensure_column(conn, "tasks", "memory_bundle_sha256", "TEXT")?;
    ensure_column(conn, "tasks", "memory_validation", "TEXT")?;
    ensure_column(conn, "tasks", "readiness_assessment_sha256", "TEXT")?;
    ensure_column(conn, "tasks", "readiness_validation", "TEXT")?;
    ensure_column(conn, "tasks", "numeric_snapshot_sha256", "TEXT")?;
    ensure_column(conn, "tasks", "numeric_validation", "TEXT")?;
    ensure_column(
        conn,
        "task_report_versions",
        "numeric_snapshot_sha256",
        "TEXT",
    )?;
    ensure_column(
        conn,
        "task_report_versions",
        "readiness_assessment_sha256",
        "TEXT",
    )?;
    ensure_column(conn, "task_report_versions", "memory_bundle_sha256", "TEXT")?;
    ensure_column(
        conn,
        "task_report_versions",
        "evidence_bundle_sha256",
        "TEXT",
    )?;
    ensure_column(conn, "task_logs", "agent", "TEXT")?;
    Ok(())
}

fn backfill_legacy_report_versions(conn: &Connection) -> Result<(), String> {
    let candidates = {
        let mut stmt = conn
            .prepare(
                "SELECT id, ticker, instrument_name, analysis_date, asset_type, research_depth,
                        analysts, output_language, updated_at, created_at, decision, stats, report_sections
                 FROM tasks
                 WHERE status = 'completed'
                   AND NOT EXISTS (
                     SELECT 1 FROM task_report_versions versions WHERE versions.task_id = tasks.id
                   )",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    for (
        task_id,
        ticker,
        instrument_name,
        analysis_date,
        asset_type,
        research_depth,
        analysts,
        output_language,
        updated_at,
        created_at,
        decision,
        stats,
        embedded_reports,
    ) in candidates
    {
        let report_sections = merge_report_sections(
            parse_json(embedded_reports, Value::Object(Default::default())),
            load_report_sections(conn, &task_id).map_err(|error| error.to_string())?,
        );
        if !has_report_content(&report_sections) {
            continue;
        }

        let created_at = if updated_at.trim().is_empty() {
            created_at
        } else {
            updated_at
        };
        let version_id = format!("legacy-report-{task_id}");
        let run_id = format!("legacy-run-{task_id}");
        let snapshot = serde_json::json!({
            "id": version_id,
            "runId": run_id,
            "versionNumber": 1,
            "createdAt": created_at,
            "legacy": true,
            "task": {
                "ticker": ticker,
                "instrumentName": instrument_name,
                "analysisDate": analysis_date,
                "assetType": asset_type,
                "researchDepth": research_depth,
                "analysts": parse_json(analysts, Value::Array(Vec::new())),
                "outputLanguage": output_language,
            },
            "run": Value::Null,
            "decision": decision,
            "stats": parse_json(stats, Value::Object(Default::default())),
            "reportSections": report_sections,
        });
        conn.execute(
            "INSERT OR IGNORE INTO task_report_versions
                (id, task_id, version_number, run_id, created_at, snapshot)
             VALUES (?1, ?2, 1, ?3, ?4, ?5)",
            params![
                version_id,
                task_id,
                run_id,
                created_at,
                json_string(&snapshot)?,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn has_report_content(report_sections: &Value) -> bool {
    report_sections.as_object().is_some_and(|reports| {
        reports
            .values()
            .any(|content| content.as_str().is_some_and(|text| !text.trim().is_empty()))
    })
}

fn ensure_column(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    for row in rows {
        if row.map_err(|error| error.to_string())? == column_name {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"),
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_settings_from_conn(
    app: &AppHandle,
    conn: &Connection,
) -> Result<(Option<StoredSettings>, Option<String>), String> {
    let raw = conn
        .query_row(
            "SELECT value FROM settings WHERE id = 'global'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok((None, None));
    };
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    let mut settings = serde_json::from_value::<StoredSettings>(value.clone())
        .map_err(|error| error.to_string())?;
    let status_added = hydrate_secret_status_metadata(&mut settings, &value);
    if !contains_legacy_secrets(&value) {
        if status_added {
            save_settings_to_conn(conn, &settings)?;
        }
        return Ok((Some(settings), None));
    }

    match migrate_legacy_secrets(app, &value, &settings.llm_provider) {
        Ok(()) => {
            mark_legacy_secret_status(&mut settings, &value);
            save_settings_to_conn(conn, &settings)?;
            Ok((Some(settings), None))
        }
        Err(error) => Ok((Some(settings), Some(error))),
    }
}

fn save_settings_to_conn(conn: &Connection, settings: &StoredSettings) -> Result<(), String> {
    let settings_json = serde_json::to_string(settings).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO settings (id, value, updated_at) VALUES ('global', ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![settings_json],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn public_settings(settings: StoredSettings) -> PublicSettings {
    PublicSettings { settings }
}

fn load_tasks_from_conn(conn: &Connection) -> Result<Vec<AnalysisTaskRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ticker, analysis_date, asset_type, research_depth, analysts, output_language, status,
                    instrument_name, queued_at, queue_order, created_at, updated_at, decision, stats, agent_statuses, report_sections, error, origin, output_quality, evidence_bundle_sha256, evidence_validation, memory_bundle_sha256, memory_validation, readiness_assessment_sha256, readiness_validation, numeric_snapshot_sha256, numeric_validation, identity_assessment_sha256, identity_validation
             FROM tasks ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let task_id: String = row.get(0)?;
            let report_sections = load_report_sections(conn, &task_id)?;
            let report_versions = load_report_versions(conn, &task_id)?;
            let logs = load_logs(conn, &task_id)?;
            let evidence_bundle = row
                .get::<_, Option<String>>(20)?
                .map(|hash| load_evidence_bundle(conn, &hash))
                .transpose()?;
            let evidence_validation = row
                .get::<_, Option<String>>(21)?
                .map(|raw| {
                    let value: Value = serde_json::from_str(&raw).map_err(|_| {
                        evidence_sql_error("Invalid saved evidence validation status".into())
                    })?;
                    validate_invalid(&value).map_err(evidence_sql_error)?;
                    Ok::<Value, rusqlite::Error>(value)
                })
                .transpose()?;
            let memory_bundle = row
                .get::<_, Option<String>>(22)?
                .map(|hash| memory_store::load_bundle(conn, &hash).map_err(evidence_sql_error))
                .transpose()?;
            let memory_validation = row
                .get::<_, Option<String>>(23)?
                .map(|raw| {
                    let marker = memory::parse_json(&raw).map_err(evidence_sql_error)?;
                    memory::validate_invalid(&marker).map_err(evidence_sql_error)?;
                    Ok::<Value, rusqlite::Error>(marker)
                })
                .transpose()?;
            let evaluation_reviews =
                memory_store::load_task_reviews(conn, &task_id, memory_bundle.as_ref())
                    .map_err(evidence_sql_error)?;
            let research_readiness = row
                .get::<_, Option<String>>(24)?
                .map(|hash| {
                    readiness_store::load(
                        conn,
                        &hash,
                        evidence_bundle
                            .as_ref()
                            .ok_or_else(|| evidence_sql_error(readiness::ERROR.into()))?,
                    )
                    .map_err(evidence_sql_error)
                })
                .transpose()?;
            let readiness_validation = row
                .get::<_, Option<String>>(25)?
                .map(|raw| {
                    let marker = memory::parse_json(&raw).map_err(evidence_sql_error)?;
                    readiness::validate_fields(None, Some(&marker)).map_err(evidence_sql_error)?;
                    Ok::<Value, rusqlite::Error>(marker)
                })
                .transpose()?;
            let report_text_snapshot = row
                .get::<_, Option<String>>(26)?
                .map(|hash| {
                    numeric_store::load_snapshot(
                        conn,
                        &hash,
                        evidence_bundle
                            .as_ref()
                            .ok_or_else(|| evidence_sql_error(numeric::ERROR.into()))?,
                    )
                    .map_err(evidence_sql_error)
                })
                .transpose()?;
            let numeric_validation = row
                .get::<_, Option<String>>(27)?
                .map(|raw| {
                    let marker = memory::parse_json(&raw).map_err(evidence_sql_error)?;
                    numeric::validate_fields(None, Some(&marker), None)
                        .map_err(evidence_sql_error)?;
                    Ok::<Value, rusqlite::Error>(marker)
                })
                .transpose()?;
            let effective_request_identity = row
                .get::<_, Option<String>>(28)?
                .map(|hash| {
                    identity_store::load(
                        conn,
                        &hash,
                        evidence_bundle
                            .as_ref()
                            .ok_or_else(|| evidence_sql_error(identity::ERROR.into()))?,
                        report_text_snapshot
                            .as_ref()
                            .ok_or_else(|| evidence_sql_error(identity::ERROR.into()))?,
                    )
                    .map_err(evidence_sql_error)
                })
                .transpose()?;
            let identity_validation = row
                .get::<_, Option<String>>(29)?
                .map(|raw| {
                    let marker = memory::parse_json(&raw).map_err(evidence_sql_error)?;
                    identity::validate_fields(None, Some(&marker)).map_err(evidence_sql_error)?;
                    Ok::<Value, rusqlite::Error>(marker)
                })
                .transpose()?;
            Ok(AnalysisTaskRecord {
                id: task_id,
                origin: row.get(18)?,
                ticker: row.get(1)?,
                analysis_date: row.get(2)?,
                asset_type: row.get(3)?,
                research_depth: row.get(4)?,
                analysts: parse_json(row.get::<_, String>(5)?, Value::Array(Vec::new())),
                output_language: row.get(6)?,
                status: row.get(7)?,
                instrument_name: row.get(8)?,
                queued_at: row.get(9)?,
                queue_order: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                decision: row.get(13)?,
                stats: parse_json(row.get::<_, String>(14)?, Value::Object(Default::default())),
                agent_statuses: parse_json(
                    row.get::<_, String>(15)?,
                    Value::Object(Default::default()),
                ),
                report_sections: merge_report_sections(
                    parse_json(row.get::<_, String>(16)?, Value::Object(Default::default())),
                    report_sections,
                ),
                report_versions,
                output_quality: row
                    .get::<_, Option<String>>(19)?
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .and_then(|value| normalize_output_quality(&value)),
                evidence_bundle,
                evidence_validation,
                memory_bundle,
                memory_validation,
                research_readiness,
                readiness_validation,
                report_text_snapshot,
                numeric_validation,
                effective_request_identity,
                identity_validation,
                evaluation_reviews,
                logs,
                error: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?;

    let tasks = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for task in &tasks {
        validate_task_identity(task)?;
        validate_task_numeric(task)?;
        validate_task_readiness(task)?;
        validate_memory_fields(
            task.memory_bundle.as_ref(),
            task.memory_validation.as_ref(),
            Some(&task.evaluation_reviews),
        )?;
        memory::validate_required_target_memory(
            task.evidence_bundle.as_ref(),
            task.memory_bundle.as_ref(),
            task.memory_validation.as_ref(),
            task.status == "completed",
        )?;
        if let Some(bundle) = &task.memory_bundle {
            validate_task_memory(
                bundle,
                task.evidence_bundle.as_ref(),
                MemoryIdentity {
                    ticker: &task.ticker,
                    analysis_date: &task.analysis_date,
                    asset_type: &task.asset_type,
                },
                None,
                &task.decision,
                &task.report_sections,
            )?;
        }
        if task.evidence_bundle.is_some() && task.evidence_validation.is_some() {
            return Err("Contradictory saved evidence validation status".into());
        }
        if let Some(bundle) = &task.evidence_bundle {
            validate_bundle(
                bundle,
                if task.status == "completed" {
                    Some(&task.report_sections)
                } else {
                    None
                },
            )?;
        }
        if let Some(bundle) = &task.evidence_bundle {
            if bundle["instrument"] != task.ticker || bundle["analysis_date"] != task.analysis_date
            {
                return Err("Saved evidence does not match the research task".into());
            }
        }
    }
    Ok(tasks)
}

fn load_logs(conn: &Connection, task_id: &str) -> rusqlite::Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT id, type, message, timestamp, agent FROM task_logs WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 100",
    )?;
    let rows = stmt.query_map(params![task_id], |row| {
        let mut log = serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "type": row.get::<_, String>(1)?,
            "message": row.get::<_, String>(2)?,
            "timestamp": row.get::<_, String>(3)?,
        });
        if let Some(agent) = row.get::<_, Option<String>>(4)? {
            if !agent.trim().is_empty() {
                log["agent"] = Value::String(agent);
            }
        }
        Ok(log)
    })?;
    let logs = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(logs))
}

fn load_report_sections(conn: &Connection, task_id: &str) -> rusqlite::Result<Value> {
    let mut stmt =
        conn.prepare("SELECT report_key, content FROM task_reports WHERE task_id = ?1")?;
    let rows = stmt.query_map(params![task_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (key, content) = row?;
        map.insert(key, content.map(Value::String).unwrap_or(Value::Null));
    }
    Ok(Value::Object(map))
}

fn load_report_versions(conn: &Connection, task_id: &str) -> rusqlite::Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT snapshot, evidence_bundle_sha256, memory_bundle_sha256,id,run_id,version_number,created_at,readiness_assessment_sha256,numeric_snapshot_sha256,identity_assessment_sha256 FROM task_report_versions WHERE task_id = ?1 ORDER BY version_number ASC",
    )?;
    let rows = stmt.query_map(params![task_id], |row| {
        let raw = row.get::<_, String>(0)?;
        let mut version = normalize_report_version_quality(
            memory::parse_json(&raw)
                .map_err(|_| evidence_sql_error("Invalid saved report version".into()))?,
        );
        if version.get("evidenceBundle").is_some() {
            return Err(evidence_sql_error(
                "Unexpected inline evidence in a saved report version".into(),
            ));
        }
        if let Some(hash) = row.get::<_, Option<String>>(1)? {
            let bundle = load_evidence_bundle(conn, &hash)?;
            validate_bundle(&bundle, version.get("reportSections")).map_err(evidence_sql_error)?;
            if bundle["instrument"] != version["task"]["ticker"]
                || bundle["analysis_date"] != version["task"]["analysisDate"]
                || bundle["run_id"] != version["runId"]
            {
                return Err(evidence_sql_error(
                    "Saved evidence does not match its frozen report version".into(),
                ));
            }
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error("Invalid saved report version".into()))?
                .insert("evidenceBundle".into(), bundle);
        }
        if let Some(invalid) = version.get("evidenceValidation") {
            if version.get("evidenceBundle").is_some() {
                return Err(evidence_sql_error(
                    "Contradictory saved evidence validation status".into(),
                ));
            }
            validate_invalid(invalid).map_err(evidence_sql_error)?;
        }
        if version.get("memoryBundle").is_some() {
            return Err(evidence_sql_error(memory::ERROR.into()));
        }
        if let Some(marker) = version.get("memoryValidation") {
            memory::validate_invalid(marker).map_err(evidence_sql_error)?;
            if row.get::<_, Option<String>>(2)?.is_some() {
                return Err(evidence_sql_error(memory::ERROR.into()));
            }
        }
        if let Some(hash) = row.get::<_, Option<String>>(2)? {
            if version["id"] != row.get::<_, String>(3)?
                || version["runId"] != row.get::<_, String>(4)?
                || version["versionNumber"] != row.get::<_, i64>(5)?
                || version["createdAt"] != row.get::<_, String>(6)?
            {
                return Err(evidence_sql_error(memory::ERROR.into()));
            }
            let bundle = memory_store::load_bundle(conn, &hash).map_err(evidence_sql_error)?;
            validate_task_memory(
                &bundle,
                version.get("evidenceBundle"),
                MemoryIdentity::from_version(&version),
                Some(
                    version["runId"]
                        .as_str()
                        .ok_or_else(|| evidence_sql_error(memory::ERROR.into()))?,
                ),
                version["decision"].as_str().unwrap_or_default(),
                &version["reportSections"],
            )
            .map_err(evidence_sql_error)?;
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error(memory::ERROR.into()))?
                .insert("memoryBundle".into(), bundle);
        }
        if version
            .get("evaluationReviews")
            .is_some_and(|reviews| !reviews.as_array().is_some_and(Vec::is_empty))
        {
            return Err(evidence_sql_error(memory::ERROR.into()));
        }
        let reviews = memory_store::load_reviews(
            conn,
            version["id"].as_str().unwrap_or_default(),
            version.get("memoryBundle"),
        )
        .map_err(evidence_sql_error)?;
        if !reviews.as_array().is_some_and(Vec::is_empty) {
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error(memory::ERROR.into()))?
                .insert("evaluationReviews".into(), reviews);
        }
        memory::validate_required_target_memory(
            version.get("evidenceBundle"),
            version.get("memoryBundle"),
            version.get("memoryValidation"),
            true,
        )
        .map_err(evidence_sql_error)?;
        if version.get("researchReadiness").is_some() {
            return Err(evidence_sql_error(readiness::ERROR.into()));
        }
        if let Some(hash) = row.get::<_, Option<String>>(7)? {
            if version["id"] != row.get::<_, String>(3)?
                || version["runId"] != row.get::<_, String>(4)?
                || version["versionNumber"] != row.get::<_, i64>(5)?
                || version["createdAt"] != row.get::<_, String>(6)?
            {
                return Err(evidence_sql_error(readiness::ERROR.into()));
            }
            let receipt = readiness_store::load(
                conn,
                &hash,
                version
                    .get("evidenceBundle")
                    .ok_or_else(|| evidence_sql_error(readiness::ERROR.into()))?,
            )
            .map_err(evidence_sql_error)?;
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error(readiness::ERROR.into()))?
                .insert("researchReadiness".into(), receipt);
        }
        if version.get("reportTextSnapshot").is_some()
            || version
                .get("numericReviews")
                .is_some_and(|reviews| !reviews.as_array().is_some_and(Vec::is_empty))
        {
            return Err(evidence_sql_error(numeric::ERROR.into()));
        }
        if let Some(hash) = row.get::<_, Option<String>>(8)? {
            if version["id"] != row.get::<_, String>(3)?
                || version["runId"] != row.get::<_, String>(4)?
                || version["versionNumber"] != row.get::<_, i64>(5)?
                || version["createdAt"] != row.get::<_, String>(6)?
            {
                return Err(evidence_sql_error(numeric::ERROR.into()));
            }
            let snapshot = numeric_store::load_snapshot(
                conn,
                &hash,
                version
                    .get("evidenceBundle")
                    .ok_or_else(|| evidence_sql_error(numeric::ERROR.into()))?,
            )
            .map_err(evidence_sql_error)?;
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error(numeric::ERROR.into()))?
                .insert("reportTextSnapshot".into(), snapshot);
        }
        if version.get("effectiveRequestIdentity").is_some() {
            return Err(evidence_sql_error(identity::ERROR.into()));
        }
        if let Some(hash) = row.get::<_, Option<String>>(9)? {
            if version["id"] != row.get::<_, String>(3)?
                || version["runId"] != row.get::<_, String>(4)?
                || version["versionNumber"] != row.get::<_, i64>(5)?
                || version["createdAt"] != row.get::<_, String>(6)?
            {
                return Err(evidence_sql_error(identity::ERROR.into()));
            }
            let receipt = identity_store::load(
                conn,
                &hash,
                version
                    .get("evidenceBundle")
                    .ok_or_else(|| evidence_sql_error(identity::ERROR.into()))?,
                version
                    .get("reportTextSnapshot")
                    .ok_or_else(|| evidence_sql_error(identity::ERROR.into()))?,
            )
            .map_err(evidence_sql_error)?;
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error(identity::ERROR.into()))?
                .insert("effectiveRequestIdentity".into(), receipt);
        }
        validate_version_identity(&version).map_err(evidence_sql_error)?;
        let reviews = numeric_store::load_reviews(
            conn,
            task_id,
            version["id"].as_str().unwrap_or_default(),
            version.get("reportTextSnapshot"),
            version.get("evidenceBundle"),
        )
        .map_err(evidence_sql_error)?;
        if !reviews.as_array().is_some_and(Vec::is_empty) {
            version
                .as_object_mut()
                .ok_or_else(|| evidence_sql_error(numeric::ERROR.into()))?
                .insert("numericReviews".into(), reviews);
        }
        validate_version_numeric(&version, task_id).map_err(evidence_sql_error)?;
        validate_version_readiness(&version).map_err(evidence_sql_error)?;
        Ok(version)
    })?;
    let versions = rows
        .filter_map(|row| match row {
            Ok(Value::Null) => None,
            other => Some(other),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(versions))
}

fn evidence_sql_error(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn prune_evidence(conn: &Connection) -> Result<(), String> {
    identity_store::prune(conn)?;
    numeric_store::prune(conn)?;
    readiness_store::prune(conn)?;
    memory_store::prune(conn)?;
    conn.execute_batch("DELETE FROM evidence_bundles WHERE sha256 NOT IN (SELECT evidence_bundle_sha256 FROM tasks WHERE evidence_bundle_sha256 IS NOT NULL UNION SELECT evidence_bundle_sha256 FROM task_report_versions WHERE evidence_bundle_sha256 IS NOT NULL);
        DELETE FROM evidence_artifacts WHERE sha256 NOT IN (SELECT artifact_sha256 FROM evidence_bundle_artifacts);")
        .map_err(|error| error.to_string())
}

struct MemoryIdentity<'a> {
    ticker: &'a str,
    analysis_date: &'a str,
    asset_type: &'a str,
}
impl<'a> MemoryIdentity<'a> {
    fn from_version(version: &'a Value) -> Self {
        Self {
            ticker: version["task"]["ticker"].as_str().unwrap_or_default(),
            analysis_date: version["task"]["analysisDate"].as_str().unwrap_or_default(),
            asset_type: version["task"]["assetType"].as_str().unwrap_or_default(),
        }
    }
}
fn validate_task_memory(
    bundle: &Value,
    evidence: Option<&Value>,
    identity: MemoryIdentity<'_>,
    run_id: Option<&str>,
    decision: &str,
    reports: &Value,
) -> Result<(), String> {
    memory::validate_bundle_evidence(bundle, evidence.ok_or(memory::ERROR)?)?;
    memory::validate_report_binding(bundle, decision, reports)?;
    if bundle["instrument"] != identity.ticker
        || bundle["analysis_date"] != identity.analysis_date
        || run_id.is_some_and(|run_id| bundle["run_id"] != run_id)
        || bundle["decision_snapshot"]["decision"]["asset_type"] != identity.asset_type
    {
        return Err(memory::ERROR.into());
    }
    Ok(())
}

fn validate_memory_fields(
    bundle: Option<&Value>,
    marker: Option<&Value>,
    reviews: Option<&Value>,
) -> Result<(), String> {
    if let Some(marker) = marker {
        memory::validate_invalid(marker)?;
        if bundle.is_some() {
            return Err(memory::ERROR.into());
        }
    }
    if let Some(reviews) = reviews {
        let reviews = reviews.as_array().ok_or(memory::ERROR)?;
        for review in reviews {
            memory::validate_review_attachment(review, Some(bundle.ok_or(memory::ERROR)?))?;
        }
    }
    Ok(())
}

fn validate_version_readiness(version: &Value) -> Result<(), String> {
    readiness::validate_fields(
        version.get("researchReadiness"),
        version.get("readinessValidation"),
    )?;
    if let Some(receipt) = version.get("researchReadiness") {
        if let Some(settings) = version
            .get("run")
            .and_then(|run| run.get("runtimeRunSettings"))
        {
            for (setting, policy) in [
                ("research_readiness_policy_sha256", "policy_sha256"),
                ("max_tool_rounds", "max_tool_rounds"),
                ("analysts", "selected_analysts"),
            ] {
                if settings
                    .get(setting)
                    .is_some_and(|value| value != &receipt["policy"][policy])
                {
                    return Err(readiness::ERROR.into());
                }
            }
        }
        if version["id"].as_str().is_none_or(str::is_empty)
            || !version["versionNumber"]
                .as_u64()
                .is_some_and(|number| (1..=9_007_199_254_740_991).contains(&number))
        {
            return Err(readiness::ERROR.into());
        }
        memory::timestamp(&version["createdAt"]).map_err(|_| readiness::ERROR)?;
        readiness::validate_snapshot(
            receipt,
            version.get("evidenceBundle"),
            readiness::SnapshotBinding {
                ticker: version["task"]["ticker"].as_str().unwrap_or_default(),
                analysis_date: version["task"]["analysisDate"].as_str().unwrap_or_default(),
                analysts: &version["task"]["analysts"],
                run_id: Some(version["runId"].as_str().ok_or(readiness::ERROR)?),
                completed: true,
                decision: version["decision"].as_str().unwrap_or_default(),
                reports: &version["reportSections"],
                memory: version.get("memoryBundle"),
            },
        )?;
    }
    Ok(())
}
fn validate_task_readiness(task: &AnalysisTaskRecord) -> Result<(), String> {
    readiness::validate_fields(
        task.research_readiness.as_ref(),
        task.readiness_validation.as_ref(),
    )?;
    let mut hashes = std::collections::BTreeMap::new();
    if let Some(receipt) = &task.research_readiness {
        readiness::validate_snapshot(
            receipt,
            task.evidence_bundle.as_ref(),
            readiness::SnapshotBinding {
                ticker: &task.ticker,
                analysis_date: &task.analysis_date,
                analysts: &task.analysts,
                run_id: None,
                completed: task.status == "completed",
                decision: &task.decision,
                reports: &task.report_sections,
                memory: task.memory_bundle.as_ref(),
            },
        )?;
        hashes.insert(
            receipt["run_id"].as_str().ok_or(readiness::ERROR)?,
            receipt["assessment_sha256"]
                .as_str()
                .ok_or(readiness::ERROR)?,
        );
    }
    if let Some(versions) = task.report_versions.as_array() {
        for version in versions {
            validate_version_readiness(version)?;
            if let Some(receipt) = version.get("researchReadiness") {
                let run_id = receipt["run_id"].as_str().ok_or(readiness::ERROR)?;
                let hash = receipt["assessment_sha256"]
                    .as_str()
                    .ok_or(readiness::ERROR)?;
                if hashes
                    .insert(run_id, hash)
                    .is_some_and(|saved| saved != hash)
                {
                    return Err(readiness::ERROR.into());
                }
            }
        }
    } else if task.research_readiness.is_some() {
        return Err(readiness::ERROR.into());
    }
    Ok(())
}

fn store_evidence_bundle(conn: &Connection, bundle: &Value) -> Result<String, String> {
    validate_bundle(bundle, None)?;
    let hash = bundle["bundle_sha256"]
        .as_str()
        .ok_or("Missing evidence bundle hash")?
        .to_string();
    let mut metadata = bundle.as_object().ok_or("Invalid evidence bundle")?.clone();
    let artifacts = metadata
        .remove("artifacts")
        .ok_or("Missing evidence artifacts")?;
    let metadata = json_string(&Value::Object(metadata))?;
    let stored: Option<String> = conn
        .query_row(
            "SELECT metadata FROM evidence_bundles WHERE sha256 = ?1",
            params![hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if stored.as_ref().is_some_and(|stored| stored != &metadata) {
        return Err("Evidence bundle content conflicts with its saved hash".into());
    }
    conn.execute(
        "INSERT OR IGNORE INTO evidence_bundles (sha256, metadata) VALUES (?1, ?2)",
        params![hash, metadata],
    )
    .map_err(|error| error.to_string())?;
    for (artifact_hash, artifact) in artifacts.as_object().ok_or("Invalid evidence artifacts")? {
        let payload = json_string(artifact)?;
        let stored: Option<String> = conn
            .query_row(
                "SELECT payload FROM evidence_artifacts WHERE sha256 = ?1",
                params![artifact_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if stored.as_ref().is_some_and(|stored| stored != &payload) {
            return Err("Evidence artifact content conflicts with its saved hash".into());
        }
        conn.execute(
            "INSERT OR IGNORE INTO evidence_artifacts (sha256, payload) VALUES (?1, ?2)",
            params![artifact_hash, payload],
        )
        .map_err(|error| error.to_string())?;
        conn.execute("INSERT OR IGNORE INTO evidence_bundle_artifacts (bundle_sha256, artifact_sha256) VALUES (?1, ?2)", params![hash, artifact_hash]).map_err(|error| error.to_string())?;
    }
    Ok(hash)
}

fn load_evidence_bundle(conn: &Connection, hash: &str) -> rusqlite::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT metadata FROM evidence_bundles WHERE sha256 = ?1",
        params![hash],
        |row| row.get(0),
    )?;
    let mut bundle: Value = serde_json::from_str(&raw)
        .map_err(|_| evidence_sql_error("Invalid saved evidence bundle".into()))?;
    let mut stmt = conn.prepare("SELECT a.sha256, a.payload FROM evidence_artifacts a JOIN evidence_bundle_artifacts link ON a.sha256 = link.artifact_sha256 WHERE link.bundle_sha256 = ?1 ORDER BY a.sha256")?;
    let rows = stmt.query_map(params![hash], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut artifacts = serde_json::Map::new();
    for row in rows {
        let (hash, raw) = row?;
        artifacts.insert(
            hash,
            serde_json::from_str(&raw)
                .map_err(|_| evidence_sql_error("Invalid saved evidence artifact".into()))?,
        );
    }
    bundle
        .as_object_mut()
        .ok_or_else(|| evidence_sql_error("Invalid saved evidence bundle".into()))?
        .insert("artifacts".into(), Value::Object(artifacts));
    validate_bundle(&bundle, None).map_err(evidence_sql_error)?;
    if bundle["bundle_sha256"] != hash {
        return Err(evidence_sql_error(
            "Saved evidence bundle hash mismatch".into(),
        ));
    }
    Ok(bundle)
}

fn validate_task_identity(task: &AnalysisTaskRecord) -> Result<(), String> {
    identity::validate_fields(
        task.effective_request_identity.as_ref(),
        task.identity_validation.as_ref(),
    )?;
    if task.status == "completed"
        && task.evidence_bundle.as_ref().is_some_and(|bundle| {
            bundle["manifest"]
                .get("effective_request_identity_policy_sha256")
                .is_some()
        })
        && task.effective_request_identity.is_none()
        && task.identity_validation.is_none()
    {
        return Err(identity::ERROR.into());
    }
    let mut hashes = std::collections::BTreeMap::new();
    if let Some(receipt) = &task.effective_request_identity {
        if task.status != "completed"
            || task.id.is_empty()
            || task.id.len() > 256
            || receipt["instrument"] != task.ticker
            || receipt["analysis_date"] != task.analysis_date
        {
            return Err(identity::ERROR.into());
        }
        identity::validate_receipt(
            receipt,
            task.evidence_bundle.as_ref().ok_or(identity::ERROR)?,
            task.report_text_snapshot.as_ref().ok_or(identity::ERROR)?,
        )?;
        if task.evidence_bundle.as_ref().ok_or(identity::ERROR)?["manifest"]
            .get("effective_request_identity_policy_sha256")
            .is_some()
            && !receipt["summary"]["unsafe_record_ids"]
                .as_array()
                .ok_or(identity::ERROR)?
                .is_empty()
            && (task.decision != "REVIEW"
                || task.memory_bundle.as_ref().is_some_and(|bundle| {
                    bundle["decision_snapshot"]["decision"]["rating"] != "REVIEW"
                }))
        {
            return Err(identity::ERROR.into());
        }
        hashes.insert(
            receipt["run_id"].as_str().ok_or(identity::ERROR)?,
            receipt["assessment_sha256"]
                .as_str()
                .ok_or(identity::ERROR)?,
        );
    }
    for version in task.report_versions.as_array().ok_or(identity::ERROR)? {
        validate_version_identity(version)?;
        if let Some(receipt) = version.get("effectiveRequestIdentity") {
            if hashes
                .insert(
                    receipt["run_id"].as_str().ok_or(identity::ERROR)?,
                    receipt["assessment_sha256"]
                        .as_str()
                        .ok_or(identity::ERROR)?,
                )
                .is_some_and(|prior| {
                    prior != receipt["assessment_sha256"].as_str().unwrap_or_default()
                })
            {
                return Err(identity::ERROR.into());
            }
        }
    }
    Ok(())
}
fn validate_version_identity(version: &Value) -> Result<(), String> {
    identity::validate_fields(
        version.get("effectiveRequestIdentity"),
        version.get("identityValidation"),
    )?;
    if version["evidenceBundle"]["manifest"]
        .get("effective_request_identity_policy_sha256")
        .is_some()
        && version.get("effectiveRequestIdentity").is_none()
        && version.get("identityValidation").is_none()
    {
        return Err(identity::ERROR.into());
    }
    if let Some(receipt) = version.get("effectiveRequestIdentity") {
        if version["id"]
            .as_str()
            .is_none_or(|id| id.is_empty() || id.len() > 256)
            || !version["versionNumber"]
                .as_u64()
                .is_some_and(|number| (1..=9_007_199_254_740_991).contains(&number))
            || version["runId"] != receipt["run_id"]
            || version["task"]["ticker"] != receipt["instrument"]
            || version["task"]["analysisDate"] != receipt["analysis_date"]
        {
            return Err(identity::ERROR.into());
        }
        memory::timestamp(&version["createdAt"]).map_err(|_| identity::ERROR)?;
        identity::validate_receipt(
            receipt,
            version.get("evidenceBundle").ok_or(identity::ERROR)?,
            version.get("reportTextSnapshot").ok_or(identity::ERROR)?,
        )?;
        if version["evidenceBundle"]["manifest"]
            .get("effective_request_identity_policy_sha256")
            .is_some()
            && !receipt["summary"]["unsafe_record_ids"]
                .as_array()
                .ok_or(identity::ERROR)?
                .is_empty()
            && (version["decision"] != "REVIEW"
                || version.get("memoryBundle").is_some_and(|bundle| {
                    bundle["decision_snapshot"]["decision"]["rating"] != "REVIEW"
                }))
        {
            return Err(identity::ERROR.into());
        }
    }
    Ok(())
}

fn validate_task_numeric(task: &AnalysisTaskRecord) -> Result<(), String> {
    numeric::validate_fields(
        task.report_text_snapshot.as_ref(),
        task.numeric_validation.as_ref(),
        None,
    )?;
    if let Some(snapshot) = &task.report_text_snapshot {
        if task.status != "completed" || task.id.is_empty() || task.id.len() > 256 {
            return Err(numeric::ERROR.into());
        }
        numeric::validate_snapshot_binding(
            snapshot,
            task.evidence_bundle.as_ref().ok_or(numeric::ERROR)?,
            None,
            &task.ticker,
            &task.analysis_date,
            &task.report_sections,
        )?;
        validate_numeric_memory_chronology(snapshot, task.memory_bundle.as_ref())?;
    }
    if let Some(versions) = task.report_versions.as_array() {
        for version in versions {
            validate_version_numeric(version, &task.id)?;
        }
    }
    Ok(())
}
fn validate_version_numeric(version: &Value, task_id: &str) -> Result<(), String> {
    numeric::validate_fields(
        version.get("reportTextSnapshot"),
        version.get("numericValidation"),
        version.get("numericReviews"),
    )?;
    if let Some(snapshot) = version.get("reportTextSnapshot") {
        if version["id"]
            .as_str()
            .is_none_or(|id| id.is_empty() || id.len() > 256)
            || !version["versionNumber"]
                .as_i64()
                .is_some_and(|number| (1..=9_007_199_254_740_991).contains(&number))
            || version["createdAt"].as_str().is_none_or(str::is_empty)
        {
            return Err(numeric::ERROR.into());
        }
        numeric::validate_snapshot_binding(
            snapshot,
            version.get("evidenceBundle").ok_or(numeric::ERROR)?,
            Some(version["runId"].as_str().ok_or(numeric::ERROR)?),
            version["task"]["ticker"].as_str().ok_or(numeric::ERROR)?,
            version["task"]["analysisDate"]
                .as_str()
                .ok_or(numeric::ERROR)?,
            &version["reportSections"],
        )?;
        validate_numeric_memory_chronology(snapshot, version.get("memoryBundle"))?;
    }
    if let Some(reviews) = version.get("numericReviews") {
        numeric::validate_reviews(
            reviews,
            version.get("reportTextSnapshot"),
            version.get("evidenceBundle"),
            task_id,
            version["id"].as_str().ok_or(numeric::ERROR)?,
        )?;
    }
    Ok(())
}

fn validate_numeric_memory_chronology(
    snapshot: &Value,
    completion: Option<&Value>,
) -> Result<(), String> {
    if let Some(completion) = completion {
        if memory::timestamp(&snapshot["captured_at"]).map_err(|_| numeric::ERROR)?
            < memory::timestamp(&completion["decision_snapshot"]["decision"]["recorded_at"])
                .map_err(|_| numeric::ERROR)?
        {
            return Err(numeric::ERROR.into());
        }
    }
    Ok(())
}

fn validate_task_input(task: &AnalysisTaskRecord) -> Result<(), String> {
    validate_task_identity(task)?;
    validate_task_numeric(task)?;
    validate_task_readiness(task)?;
    validate_memory_fields(
        task.memory_bundle.as_ref(),
        task.memory_validation.as_ref(),
        Some(&task.evaluation_reviews),
    )?;
    memory::validate_required_target_memory(
        task.evidence_bundle.as_ref(),
        task.memory_bundle.as_ref(),
        task.memory_validation.as_ref(),
        task.status == "completed",
    )?;
    if let Some(bundle) = &task.memory_bundle {
        validate_task_memory(
            bundle,
            task.evidence_bundle.as_ref(),
            MemoryIdentity {
                ticker: &task.ticker,
                analysis_date: &task.analysis_date,
                asset_type: &task.asset_type,
            },
            None,
            &task.decision,
            &task.report_sections,
        )?;
    }
    if task.evidence_bundle.is_some() && task.evidence_validation.is_some() {
        return Err("Contradictory evidence validation status".into());
    }
    if let Some(bundle) = &task.evidence_bundle {
        validate_bundle(
            bundle,
            if task.status == "completed" {
                Some(&task.report_sections)
            } else {
                None
            },
        )?;
        if bundle["instrument"] != task.ticker || bundle["analysis_date"] != task.analysis_date {
            return Err("Evidence bundle does not match the research task".into());
        }
    }
    if let Some(invalid) = &task.evidence_validation {
        validate_invalid(invalid)?;
    }
    if let Value::Array(versions) = &task.report_versions {
        for version in versions {
            validate_memory_fields(
                version.get("memoryBundle"),
                version.get("memoryValidation"),
                version.get("evaluationReviews"),
            )?;
            memory::validate_required_target_memory(
                version.get("evidenceBundle"),
                version.get("memoryBundle"),
                version.get("memoryValidation"),
                true,
            )?;
            if let Some(bundle) = version.get("memoryBundle") {
                if version["id"].as_str().is_none_or(|id| id.is_empty())
                    || !version["versionNumber"]
                        .as_i64()
                        .is_some_and(|number| (1..=9_007_199_254_740_991).contains(&number))
                    || version["createdAt"]
                        .as_str()
                        .is_none_or(|time| time.is_empty())
                {
                    return Err(memory::ERROR.into());
                }
                validate_task_memory(
                    bundle,
                    version.get("evidenceBundle"),
                    MemoryIdentity::from_version(version),
                    Some(version["runId"].as_str().ok_or(memory::ERROR)?),
                    version["decision"].as_str().unwrap_or_default(),
                    &version["reportSections"],
                )?;
            }
            if let Some(reviews) = version.get("evaluationReviews") {
                for review in reviews.as_array().ok_or(memory::ERROR)? {
                    memory::validate_review_attachment(
                        review,
                        Some(version.get("memoryBundle").ok_or(memory::ERROR)?),
                    )?;
                }
            }
            if version.get("evidenceBundle").is_some()
                && version.get("evidenceValidation").is_some()
            {
                return Err("Contradictory frozen evidence validation status".into());
            }
            if let Some(bundle) = version.get("evidenceBundle") {
                validate_bundle(bundle, version.get("reportSections"))?;
                if bundle["instrument"] != version["task"]["ticker"]
                    || bundle["analysis_date"] != version["task"]["analysisDate"]
                    || bundle["run_id"] != version["runId"]
                {
                    return Err("Evidence bundle does not match its frozen report version".into());
                }
            }
            if let Some(invalid) = version.get("evidenceValidation") {
                validate_invalid(invalid)?;
            }
        }
    }
    Ok(())
}

fn upsert_task(conn: &Connection, task: &AnalysisTaskRecord) -> Result<(), String> {
    validate_task_input(task)?;
    let evidence_hash = task
        .evidence_bundle
        .as_ref()
        .map(|bundle| store_evidence_bundle(conn, bundle))
        .transpose()?;
    let memory_hash = task
        .memory_bundle
        .as_ref()
        .map(|bundle| memory_store::store_bundle(conn, bundle))
        .transpose()?;
    let readiness_hash = task
        .research_readiness
        .as_ref()
        .map(|receipt| {
            readiness_store::store(
                conn,
                receipt,
                task.evidence_bundle.as_ref().ok_or(readiness::ERROR)?,
            )
        })
        .transpose()?;
    let numeric_hash = task
        .report_text_snapshot
        .as_ref()
        .map(|snapshot| {
            numeric_store::store_snapshot(
                conn,
                snapshot,
                task.evidence_bundle.as_ref().ok_or(numeric::ERROR)?,
            )
        })
        .transpose()?;
    let identity_hash = task
        .effective_request_identity
        .as_ref()
        .map(|receipt| {
            identity_store::store(
                conn,
                receipt,
                task.evidence_bundle.as_ref().ok_or(identity::ERROR)?,
                task.report_text_snapshot.as_ref().ok_or(identity::ERROR)?,
            )
        })
        .transpose()?;
    let previous_memory_hash: Option<Option<String>> = conn
        .query_row(
            "SELECT memory_bundle_sha256 FROM tasks WHERE id=?1",
            params![task.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| memory::ERROR)?;
    if previous_memory_hash.flatten() != memory_hash {
        memory_store::clear_task_reviews(conn, &task.id)?;
    }
    let output_quality = task
        .output_quality
        .as_ref()
        .and_then(normalize_output_quality);
    conn.execute(
        "INSERT INTO tasks (
            id, origin, ticker, instrument_name, analysis_date, asset_type, research_depth, analysts, output_language, status,
            queued_at, queue_order, created_at, updated_at, decision, stats, agent_statuses, report_sections, error, output_quality, evidence_bundle_sha256, evidence_validation, memory_bundle_sha256, memory_validation, readiness_assessment_sha256, readiness_validation, numeric_snapshot_sha256, numeric_validation, identity_assessment_sha256, identity_validation
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)
         ON CONFLICT(id) DO UPDATE SET
            origin = excluded.origin,
            ticker = excluded.ticker,
            instrument_name = excluded.instrument_name,
            analysis_date = excluded.analysis_date,
            asset_type = excluded.asset_type,
            research_depth = excluded.research_depth,
            analysts = excluded.analysts,
            output_language = excluded.output_language,
            status = excluded.status,
            queued_at = excluded.queued_at,
            queue_order = excluded.queue_order,
            updated_at = excluded.updated_at,
            decision = excluded.decision,
            stats = excluded.stats,
            agent_statuses = excluded.agent_statuses,
            report_sections = excluded.report_sections,
            error = excluded.error,
            output_quality = excluded.output_quality,
            evidence_bundle_sha256 = excluded.evidence_bundle_sha256,
            evidence_validation = excluded.evidence_validation,
            memory_bundle_sha256 = excluded.memory_bundle_sha256,
            memory_validation = excluded.memory_validation,
            readiness_assessment_sha256 = excluded.readiness_assessment_sha256,
            readiness_validation = excluded.readiness_validation,
            numeric_snapshot_sha256 = excluded.numeric_snapshot_sha256,
            numeric_validation = excluded.numeric_validation,
            identity_assessment_sha256 = excluded.identity_assessment_sha256,
            identity_validation = excluded.identity_validation",
        params![
            task.id,
            task.origin,
            task.ticker,
            task.instrument_name,
            task.analysis_date,
            task.asset_type,
            task.research_depth,
            json_string(&task.analysts)?,
            task.output_language,
            task.status,
            task.queued_at,
            task.queue_order,
            task.created_at,
            task.updated_at,
            task.decision,
            json_string(&task.stats)?,
            json_string(&task.agent_statuses)?,
            json_string(&task.report_sections)?,
            task.error,
            output_quality.as_ref().map(json_string).transpose()?,
            evidence_hash,
            task.evidence_validation.as_ref().map(json_string).transpose()?,
            memory_hash,
            task.memory_validation.as_ref().map(json_string).transpose()?,
            readiness_hash,
            task.readiness_validation.as_ref().map(json_string).transpose()?,
            numeric_hash,
            task.numeric_validation.as_ref().map(json_string).transpose()?,
            identity_hash,
            task.identity_validation.as_ref().map(json_string).transpose()?,
        ],
    )
    .map_err(|error| error.to_string())?;
    memory_store::append_task_reviews(
        conn,
        &task.id,
        task.memory_bundle.as_ref(),
        &task.evaluation_reviews,
    )?;

    conn.execute("DELETE FROM task_logs WHERE task_id = ?1", params![task.id])
        .map_err(|error| error.to_string())?;
    if let Value::Array(logs) = &task.logs {
        for log in logs {
            let id = log.get("id").and_then(Value::as_str).unwrap_or_default();
            let log_type = log.get("type").and_then(Value::as_str).unwrap_or_default();
            let message = log
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let timestamp = log
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let agent = log.get("agent").and_then(Value::as_str).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR REPLACE INTO task_logs (id, task_id, type, message, timestamp, agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, task.id, log_type, message, timestamp, agent],
            )
            .map_err(|error| error.to_string())?;
        }
    }

    conn.execute(
        "DELETE FROM task_reports WHERE task_id = ?1",
        params![task.id],
    )
    .map_err(|error| error.to_string())?;
    if let Value::Object(reports) = &task.report_sections {
        for (key, content) in reports {
            conn.execute(
                "INSERT OR REPLACE INTO task_reports (task_id, report_key, content, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    task.id,
                    key,
                    content.as_str(),
                    task.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        }
    }

    if let Value::Array(versions) = &task.report_versions {
        for version in versions {
            let mut version = normalize_report_version_quality(version.clone());
            let identity_receipt = version
                .as_object_mut()
                .and_then(|map| map.remove("effectiveRequestIdentity"));
            let identity_hash = identity_receipt
                .as_ref()
                .map(|receipt| {
                    identity_store::store(
                        conn,
                        receipt,
                        version.get("evidenceBundle").ok_or(identity::ERROR)?,
                        version.get("reportTextSnapshot").ok_or(identity::ERROR)?,
                    )
                })
                .transpose()?;
            let numeric_snapshot = version
                .as_object_mut()
                .and_then(|map| map.remove("reportTextSnapshot"));
            let numeric_evidence = version.get("evidenceBundle").cloned();
            let numeric_hash = numeric_snapshot
                .as_ref()
                .map(|snapshot| {
                    numeric_store::store_snapshot(
                        conn,
                        snapshot,
                        numeric_evidence.as_ref().ok_or(numeric::ERROR)?,
                    )
                })
                .transpose()?;
            let numeric_reviews = version
                .as_object_mut()
                .and_then(|map| map.remove("numericReviews"));
            if numeric_reviews.is_some() {
                version["numericReviews"] = Value::Array(Vec::new());
            }
            let readiness_hash = version
                .get("researchReadiness")
                .map(|receipt| {
                    readiness_store::store(
                        conn,
                        receipt,
                        version.get("evidenceBundle").ok_or(readiness::ERROR)?,
                    )
                })
                .transpose()?;
            version
                .as_object_mut()
                .ok_or(readiness::ERROR)?
                .remove("researchReadiness");
            let reviews = version
                .as_object_mut()
                .and_then(|map| map.remove("evaluationReviews"));
            if reviews.is_some() {
                version["evaluationReviews"] = Value::Array(Vec::new());
            }
            let completion = version
                .as_object_mut()
                .and_then(|map| map.remove("memoryBundle"));
            let memory_hash = completion
                .as_ref()
                .map(|bundle| memory_store::store_bundle(conn, bundle))
                .transpose()?;
            let evidence_hash = version
                .as_object_mut()
                .and_then(|map| map.remove("evidenceBundle"))
                .map(|bundle| store_evidence_bundle(conn, &bundle))
                .transpose()?;
            let id = version
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let run_id = version
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version_number = version
                .get("versionNumber")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let created_at = version
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if id.is_empty() || run_id.is_empty() || version_number < 1 || created_at.is_empty() {
                continue;
            }
            type FrozenVersionRow = (
                String,
                Option<String>,
                Option<String>,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
            );
            let existing: Option<FrozenVersionRow> = conn.query_row("SELECT snapshot, evidence_bundle_sha256, memory_bundle_sha256,task_id,readiness_assessment_sha256,numeric_snapshot_sha256,identity_assessment_sha256 FROM task_report_versions WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(|error| error.to_string())?;
            if let Some((
                snapshot,
                hash,
                saved_memory_hash,
                saved_task,
                saved_readiness_hash,
                saved_numeric_hash,
                saved_identity_hash,
            )) = existing
            {
                let mut saved = normalize_report_version_quality(
                    serde_json::from_str::<Value>(&snapshot)
                        .map_err(|_| "Invalid saved report version")?,
                );
                let mut frozen = version.clone();
                saved
                    .as_object_mut()
                    .ok_or(memory::ERROR)?
                    .remove("evaluationReviews");
                frozen
                    .as_object_mut()
                    .ok_or(memory::ERROR)?
                    .remove("evaluationReviews");
                saved
                    .as_object_mut()
                    .ok_or(numeric::ERROR)?
                    .remove("numericReviews");
                frozen
                    .as_object_mut()
                    .ok_or(numeric::ERROR)?
                    .remove("numericReviews");
                if !analysis_journal::same_version_core(&saved, &frozen)
                    || hash != evidence_hash
                    || saved_memory_hash != memory_hash
                    || saved_readiness_hash != readiness_hash
                    || saved_numeric_hash != numeric_hash
                    || saved_identity_hash != identity_hash
                    || saved_task != task.id
                {
                    return Err("A frozen report version cannot be changed".into());
                }
            }
            conn.execute(
                "INSERT OR IGNORE INTO task_report_versions
                    (id, task_id, version_number, run_id, created_at, snapshot, evidence_bundle_sha256, memory_bundle_sha256, readiness_assessment_sha256, numeric_snapshot_sha256, identity_assessment_sha256)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    task.id,
                    version_number,
                    run_id,
                    created_at,
                    json_string(&version)?,
                    evidence_hash,
                    memory_hash,
                    readiness_hash,
                    numeric_hash,
                    identity_hash,
                ],
            )
            .map_err(|error| error.to_string())?;
            if let Some(reviews) = reviews {
                memory_store::append_reviews(conn, id, completion.as_ref(), &reviews)?;
            }
            numeric_store::append_reviews(
                conn,
                &task.id,
                id,
                numeric_snapshot.as_ref(),
                numeric_evidence.as_ref(),
                numeric_reviews
                    .as_ref()
                    .unwrap_or(&Value::Array(Vec::new())),
            )?;
        }
    }

    Ok(())
}

fn contains_legacy_secrets(value: &Value) -> bool {
    value.get("apiKey").is_some() || value.get("alphaVantageApiKey").is_some()
}

fn mark_legacy_secret_status(settings: &mut StoredSettings, value: &Value) {
    if value
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|secret| !secret.trim().is_empty())
    {
        settings.provider_configured = true;
    }
    if value
        .get("alphaVantageApiKey")
        .and_then(Value::as_str)
        .is_some_and(|secret| !secret.trim().is_empty())
    {
        settings.alpha_vantage_configured = true;
    }
}

fn hydrate_secret_status_metadata(settings: &mut StoredSettings, value: &Value) -> bool {
    let mut changed = false;
    if value.get("providerConfigured").is_none() {
        settings.provider_configured = secrets::provider_secret_id(&settings.llm_provider)
            .is_ok_and(|secret_id| secrets::detect_secret_without_prompt(&secret_id));
        changed = true;
    }
    if value.get("alphaVantageConfigured").is_none() {
        settings.alpha_vantage_configured =
            secrets::detect_secret_without_prompt(secrets::ALPHA_VANTAGE_SECRET_ID);
        changed = true;
    }
    changed
}

fn migrate_legacy_secrets(app: &AppHandle, value: &Value, provider: &str) -> Result<(), String> {
    let provider_secret = value
        .get("apiKey")
        .and_then(Value::as_str)
        .map(|secret| decrypt_legacy_secret(app, secret))
        .transpose()?;
    let alpha_vantage_secret = value
        .get("alphaVantageApiKey")
        .and_then(Value::as_str)
        .map(|secret| decrypt_legacy_secret(app, secret))
        .transpose()?;
    write_migrated_secrets(
        &secrets::SystemCredentialStore,
        provider,
        provider_secret.as_deref(),
        alpha_vantage_secret.as_deref(),
    )
}

fn write_migrated_secrets(
    store: &dyn secrets::CredentialStore,
    provider: &str,
    provider_secret: Option<&str>,
    alpha_vantage_secret: Option<&str>,
) -> Result<(), String> {
    if let Some(secret) = provider_secret.filter(|secret| !secret.trim().is_empty()) {
        let secret_id = secrets::provider_secret_id(provider).map_err(migration_error)?;
        store.set(&secret_id, secret).map_err(migration_error)?;
    }
    if let Some(secret) = alpha_vantage_secret.filter(|secret| !secret.trim().is_empty()) {
        store
            .set(secrets::ALPHA_VANTAGE_SECRET_ID, secret)
            .map_err(migration_error)?;
    }
    Ok(())
}

fn migration_error(error: String) -> String {
    format!(
        "Secure credential migration was not completed. Legacy encrypted data was retained and no plaintext fallback was created: {error}"
    )
}

fn decrypt_legacy_secret(app: &AppHandle, value: &str) -> Result<String, String> {
    if value.is_empty() || !value.starts_with(SECRET_PREFIX) {
        return Ok(value.to_string());
    }

    let encrypted = value.trim_start_matches(SECRET_PREFIX);
    let Some((nonce, ciphertext)) = encrypted.split_once(':') else {
        return Ok(String::new());
    };
    let nonce: [u8; 12] = STANDARD
        .decode(nonce)
        .map_err(|error| error.to_string())?
        .try_into()
        .map_err(|_| "Invalid legacy API-key nonce length".to_string())?;
    let ciphertext = STANDARD
        .decode(ciphertext)
        .map_err(|error| error.to_string())?;
    let key = load_legacy_secret_key(app)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| error.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "Failed to decrypt stored API key".to_string())?;
    String::from_utf8(plaintext).map_err(|error| error.to_string())
}

fn load_legacy_secret_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    for path in legacy_data_candidates(&app_data, "tradingagents.secret") {
        if path.is_file() {
            let key = fs::read(&path).map_err(|error| error.to_string())?;
            return key
                .try_into()
                .map_err(|_| "Invalid legacy secret key length".to_string());
        }
    }
    Err("Legacy encrypted settings exist, but their local encryption key is missing".to_string())
}

fn normalize_task(mut task: AnalysisTaskRecord) -> AnalysisTaskRecord {
    if task.status == "running" {
        task.status = "stopped".to_string();
    }
    task
}

fn parse_json(raw: String, fallback: Value) -> Value {
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn merge_report_sections(base: Value, stored: Value) -> Value {
    let mut map = match base {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    if let Value::Object(stored_map) = stored {
        for (key, value) in stored_map {
            map.insert(key, value);
        }
    }
    Value::Object(map)
}

fn json_string(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn default_task_origin() -> String {
    "analysis".to_string()
}

fn empty_array() -> Value {
    Value::Array(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::CredentialStore;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct FakeCredentialStore {
        values: Mutex<HashMap<String, String>>,
        fail_writes: bool,
    }

    impl secrets::CredentialStore for FakeCredentialStore {
        fn get(&self, secret_id: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(secret_id).cloned())
        }

        fn set(&self, secret_id: &str, value: &str) -> Result<(), String> {
            if self.fail_writes {
                return Err("simulated migration failure".to_string());
            }
            self.values
                .lock()
                .unwrap()
                .insert(secret_id.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, secret_id: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(secret_id);
            Ok(())
        }
    }

    #[test]
    fn successful_legacy_migration_writes_both_system_credentials() {
        let store = FakeCredentialStore::default();
        write_migrated_secrets(
            &store,
            "openai",
            Some("legacy-provider-secret"),
            Some("legacy-alpha-secret"),
        )
        .unwrap();

        assert_eq!(
            store.get("llm-provider-openai").unwrap().as_deref(),
            Some("legacy-provider-secret")
        );
        assert_eq!(
            store
                .get(secrets::ALPHA_VANTAGE_SECRET_ID)
                .unwrap()
                .as_deref(),
            Some("legacy-alpha-secret")
        );
    }

    #[test]
    fn failed_legacy_migration_reports_retention_and_creates_no_fallback() {
        let store = FakeCredentialStore {
            fail_writes: true,
            ..Default::default()
        };
        let error = write_migrated_secrets(
            &store,
            "openai",
            Some("legacy-provider-secret"),
            Some("legacy-alpha-secret"),
        )
        .unwrap_err();

        assert!(error.contains("Legacy encrypted data was retained"));
        assert_eq!(store.get("llm-provider-openai").unwrap(), None);
        assert_eq!(store.get(secrets::ALPHA_VANTAGE_SECRET_ID).unwrap(), None);
    }

    #[test]
    fn report_versions_are_unique_and_cascade_with_their_task() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks (
                id, origin, ticker, instrument_name, analysis_date, asset_type, research_depth,
                analysts, output_language, status, queued_at, queue_order, created_at, updated_at,
                decision, stats, agent_statuses, report_sections, error
             ) VALUES (
                'task-1', 'analysis', 'SPY', 'SPY', '2025-01-01', 'stock', 1,
                '[]', 'English', 'completed', '', NULL, '2025-01-01', '2025-01-02',
                'Hold', '{}', '{}', '{}', ''
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_report_versions
                (id, task_id, version_number, run_id, created_at, snapshot)
             VALUES ('version-1', 'task-1', 1, 'run-1', '2025-01-02', '{}')",
            [],
        )
        .unwrap();

        let duplicate_run = conn.execute(
            "INSERT INTO task_report_versions
                (id, task_id, version_number, run_id, created_at, snapshot)
             VALUES ('version-2', 'task-1', 2, 'run-1', '2025-01-03', '{}')",
            [],
        );
        assert!(duplicate_run.is_err());
        let duplicate_version = conn.execute(
            "INSERT INTO task_report_versions
                (id, task_id, version_number, run_id, created_at, snapshot)
             VALUES ('version-3', 'task-1', 1, 'run-3', '2025-01-03', '{}')",
            [],
        );
        assert!(duplicate_version.is_err());

        conn.execute("DELETE FROM tasks WHERE id = 'task-1'", [])
            .unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_report_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn output_quality_survives_storage_without_rewriting_frozen_versions() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let quality = serde_json::json!({
            "portfolio_manager": {
                "status": "unvalidated_text",
                "schema": "PortfolioDecision",
                "source": "raw_response",
                "reason": "schema_validation_failed"
            }
        });
        let snapshot = serde_json::json!({
            "id": "quality-version", "runId": "quality-run", "versionNumber": 1,
            "createdAt": "2026-10-04", "outputQuality": quality
        });
        let mut task = quality_task_fixture(quality.clone(), snapshot);
        upsert_task(&conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].output_quality.as_ref(), Some(&quality));
        assert_eq!(loaded[0].report_versions[0]["outputQuality"], quality);

        task.output_quality = None;
        task.status = "queued".to_string();
        upsert_task(&conn, &task).unwrap();
        let rerun = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(rerun[0].output_quality, None);
        assert_eq!(rerun[0].report_versions[0]["outputQuality"], quality);
    }

    fn quality_task_fixture(quality: Value, snapshot: Value) -> AnalysisTaskRecord {
        serde_json::from_value(serde_json::json!({
            "id": "quality-task", "ticker": "TEST", "analysisDate": "2026-10-04",
            "assetType": "stock", "researchDepth": 1, "analysts": [],
            "outputLanguage": "English", "status": "completed",
            "createdAt": "2026-10-04", "updatedAt": "2026-10-04", "decision": "REVIEW",
            "stats": {}, "agentStatuses": {}, "reportSections": {}, "logs": [], "error": "",
            "outputQuality": quality, "reportVersions": [snapshot]
        }))
        .unwrap()
    }

    pub(super) fn evidence_task_fixture() -> (AnalysisTaskRecord, Value) {
        let bundle: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/evidence_bundle_v1.json"))
                .unwrap();
        let version = serde_json::json!({
            "id":"evidence-version", "runId":bundle["run_id"], "versionNumber":1,
            "createdAt":"2025-02-14T12:00:02Z", "legacy":false,
            "task":{"ticker":bundle["instrument"], "analysisDate":bundle["analysis_date"]},
            "reportSections":{"market_report":"A fictional saved report."}, "evidenceBundle":bundle
        });
        let mut task = quality_task_fixture(Value::Null, version);
        task.ticker = bundle["instrument"].as_str().unwrap().into();
        task.analysis_date = bundle["analysis_date"].as_str().unwrap().into();
        task.report_sections = serde_json::json!({"market_report":"A fictional saved report."});
        task.evidence_bundle = Some(bundle.clone());
        (task, bundle)
    }

    pub(super) fn memory_task_fixture() -> (AnalysisTaskRecord, Value) {
        let bundle = memory::test_support::bundle();
        let evidence = memory::test_support::evidence();
        let snapshot = &bundle["decision_snapshot"];
        let reports = serde_json::json!({"final_trade_decision":snapshot["artifacts"][snapshot["decision"]["decision_text_sha256"].as_str().unwrap()]["payload"]});
        let version = serde_json::json!({"id":"memory-version","runId":bundle["run_id"],"versionNumber":1,"createdAt":"2025-02-14T12:06:00Z","legacy":false,"task":{"ticker":bundle["instrument"],"analysisDate":bundle["analysis_date"],"assetType":"stock"},"decision":snapshot["decision"]["rating"],"reportSections":reports,"evidenceBundle":evidence,"memoryBundle":bundle,"evaluationReviews":[]});
        let mut task = quality_task_fixture(Value::Null, version);
        task.ticker = bundle["instrument"].as_str().unwrap().into();
        task.analysis_date = bundle["analysis_date"].as_str().unwrap().into();
        task.decision = snapshot["decision"]["rating"].as_str().unwrap().into();
        task.report_sections = reports;
        task.evidence_bundle = Some(evidence);
        task.memory_bundle = Some(bundle.clone());
        (task, bundle)
    }
    fn save_test_task(conn: &mut Connection, task: &AnalysisTaskRecord) -> Result<(), String> {
        let transaction = conn.transaction().unwrap();
        upsert_task(&transaction, task)?;
        prune_evidence(&transaction)?;
        transaction.commit().map_err(|_| memory::ERROR.into())
    }

    fn memory_target_task_fixture() -> (AnalysisTaskRecord, Value) {
        let fixture = memory::parse_json(include_str!(
            "../../tests/fixtures/memory_target_binding_v2.json"
        ))
        .unwrap();
        let bundle = fixture["bundle"].clone();
        let evidence = fixture["evidence"].clone();
        let snapshot = &bundle["decision_snapshot"];
        let reports = serde_json::json!({"final_trade_decision":snapshot["artifacts"][snapshot["decision"]["decision_text_sha256"].as_str().unwrap()]["payload"]});
        let version = serde_json::json!({"id":"memory-version","runId":bundle["run_id"],"versionNumber":1,"createdAt":"2025-02-14T12:06:00Z","legacy":false,"task":{"ticker":bundle["instrument"],"analysisDate":bundle["analysis_date"],"assetType":"stock"},"decision":snapshot["decision"]["rating"],"reportSections":reports,"evidenceBundle":evidence,"memoryBundle":bundle,"evaluationReviews":[]});
        let mut task = quality_task_fixture(Value::Null, version);
        task.ticker = bundle["instrument"].as_str().unwrap().into();
        task.analysis_date = bundle["analysis_date"].as_str().unwrap().into();
        task.decision = snapshot["decision"]["rating"].as_str().unwrap().into();
        task.report_sections = reports;
        task.evidence_bundle = Some(evidence);
        task.memory_bundle = Some(bundle);
        (task, fixture)
    }

    #[test]
    fn memory_target_roundtrip_and_appended_review_preserve_original_completion() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, fixture) = memory_target_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        let completion = task.memory_bundle.clone();
        let review = memory::test_support::review(
            fixture["available_snapshot"].clone(),
            "2025-02-26T12:00:00.000000Z",
        );
        task.evaluation_reviews = serde_json::json!([review]);
        task.report_versions[0]["evaluationReviews"] = task.evaluation_reviews.clone();
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap().remove(0);
        assert_eq!(loaded.memory_bundle, completion);
        assert_eq!(loaded.evaluation_reviews, task.evaluation_reviews);
        assert_eq!(loaded.report_versions[0]["memoryBundle"], fixture["bundle"]);
        assert_eq!(
            loaded.report_versions[0]["evaluationReviews"],
            task.evaluation_reviews
        );
        assert_eq!(loaded.evidence_bundle, task.evidence_bundle);
    }

    #[test]
    fn memory_target_missing_null_or_unbound_completed_attachment_rejects_atomically() {
        for mode in [
            "task_missing",
            "task_null",
            "version_missing",
            "version_null",
            "marker_wrong",
        ] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize_schema(&conn).unwrap();
            let (original, _) = memory_target_task_fixture();
            save_test_task(&mut conn, &original).unwrap();
            let mut task: AnalysisTaskRecord =
                serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
            match mode {
                "task_missing" => task.memory_bundle = None,
                "task_null" => {
                    let mut raw = serde_json::to_value(&task).unwrap();
                    raw["memoryBundle"] = Value::Null;
                    task = serde_json::from_value(raw).unwrap();
                }
                "version_missing" => {
                    task.report_versions[0]
                        .as_object_mut()
                        .unwrap()
                        .remove("memoryBundle");
                }
                "version_null" => task.report_versions[0]["memoryBundle"] = Value::Null,
                _ => {
                    task.evidence_bundle.as_mut().unwrap()["manifest"]
                        ["memory_target_binding_sha256"] = "f".repeat(64).into();
                }
            }
            assert!(save_test_task(&mut conn, &task).is_err(), "{mode}");
            assert_eq!(
                load_tasks_from_conn(&conn).unwrap()[0].memory_bundle,
                original.memory_bundle
            );
        }
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, _) = memory_target_task_fixture();
        task.memory_bundle = None;
        task.memory_validation =
            Some(serde_json::json!({"status":"invalid","reason":"reference_mismatch"}));
        task.report_versions = serde_json::json!([]);
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap().remove(0);
        assert_eq!(loaded.memory_validation, task.memory_validation);
        assert!(loaded.memory_bundle.is_none());
    }

    #[test]
    fn memory_target_same_retained_uuid_cannot_upgrade_legacy_or_cross_owner() {
        for same_owner in [true, false] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize_schema(&conn).unwrap();
            let (legacy, original) = memory_task_fixture();
            save_test_task(&mut conn, &legacy).unwrap();
            let (mut next, _) = memory_target_task_fixture();
            if !same_owner {
                next.id = "other-task".into();
                next.report_versions[0]["id"] = "other-version".into();
            }
            assert!(save_test_task(&mut conn, &next).is_err());
            let loaded = load_tasks_from_conn(&conn).unwrap();
            assert_eq!(loaded.len(), 1);
            assert_eq!(loaded[0].memory_bundle.as_ref(), Some(&original));
            // Explicit deletion discards the last retained authority; no tombstones.
            conn.execute("DELETE FROM tasks", []).unwrap();
            prune_evidence(&conn).unwrap();
            save_test_task(&mut conn, &next).unwrap();
            assert_eq!(
                load_tasks_from_conn(&conn).unwrap()[0].memory_bundle,
                next.memory_bundle
            );
        }
    }

    fn identity_task_fixture() -> AnalysisTaskRecord {
        let fixture = memory::parse_json(include_str!(
            "../../tests/fixtures/effective_request_identity_v1.json"
        ))
        .unwrap();
        let version = serde_json::json!({
            "id":"identity-version", "runId":fixture["evidence"]["run_id"],"versionNumber":1,
            "createdAt":"2026-01-09T12:01:00.000000Z","task":{"ticker":"FICT","analysisDate":"2026-01-09"},
            "decision":"REVIEW","reportSections":fixture["snapshot"]["report_sections"],
            "evidenceBundle":fixture["evidence"],"reportTextSnapshot":fixture["snapshot"],
            "effectiveRequestIdentity":fixture["assessment"]
        });
        let mut task = quality_task_fixture(Value::Null, version);
        task.ticker = "FICT".into();
        task.analysis_date = "2026-01-09".into();
        task.report_sections = fixture["snapshot"]["report_sections"].clone();
        task.evidence_bundle = Some(fixture["evidence"].clone());
        task.report_text_snapshot = Some(fixture["snapshot"].clone());
        task.effective_request_identity = Some(fixture["assessment"].clone());
        task
    }
    #[test]
    fn request_identity_roundtrip_retry_and_rerun_preserve_original_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let mut task = identity_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(
            loaded[0].effective_request_identity,
            task.effective_request_identity
        );
        assert_eq!(
            loaded[0].report_versions[0]["effectiveRequestIdentity"],
            task.report_versions[0]["effectiveRequestIdentity"]
        );
        task.status = "queued".into();
        task.evidence_bundle = None;
        task.report_text_snapshot = None;
        task.effective_request_identity = None;
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert!(loaded[0].effective_request_identity.is_none());
        assert_eq!(
            loaded[0].report_versions[0]["effectiveRequestIdentity"],
            task.report_versions[0]["effectiveRequestIdentity"]
        );
        conn.execute("DELETE FROM tasks WHERE id=?1", params![task.id])
            .unwrap();
        prune_evidence(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM effective_request_identity_receipts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn request_identity_replacement_and_late_insertion_roll_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let task = identity_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        let mut changed = task.report_versions.clone();
        changed[0]["effectiveRequestIdentity"]["reviewed_at"] =
            serde_json::json!("2026-01-09T12:02:00.000000Z");
        readiness::test_support::rehash(
            &mut changed[0]["effectiveRequestIdentity"],
            "assessment_sha256",
        );
        let mut changed_task = identity_task_fixture();
        changed_task.report_versions = changed;
        changed_task.effective_request_identity =
            Some(changed_task.report_versions[0]["effectiveRequestIdentity"].clone());
        assert!(save_test_task(&mut conn, &changed_task).is_err());
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].effective_request_identity,
            task.effective_request_identity
        );
        let mut legacy = identity_task_fixture();
        legacy.id = "legacy-identity-task".into();
        legacy.report_versions[0]["id"] = serde_json::json!("legacy-identity-version");
        legacy.report_versions[0]
            .as_object_mut()
            .unwrap()
            .remove("effectiveRequestIdentity");
        legacy.effective_request_identity = None;
        save_test_task(&mut conn, &legacy).unwrap();
        legacy.report_versions[0]["effectiveRequestIdentity"] =
            task.effective_request_identity.clone().unwrap();
        assert!(save_test_task(&mut conn, &legacy).is_err());
    }
    fn marked_identity_task_fixture() -> AnalysisTaskRecord {
        let fixture = memory::parse_json(include_str!(
            "../../tests/fixtures/effective_request_identity_marked_v1.json"
        ))
        .unwrap();
        let mut task = identity_task_fixture();
        task.report_sections = fixture["snapshot"]["report_sections"].clone();
        task.evidence_bundle = Some(fixture["evidence"].clone());
        task.report_text_snapshot = Some(fixture["snapshot"].clone());
        task.effective_request_identity = Some(fixture["assessment"].clone());
        task.report_versions[0]["reportSections"] = task.report_sections.clone();
        task.report_versions[0]["evidenceBundle"] = fixture["evidence"].clone();
        task.report_versions[0]["reportTextSnapshot"] = fixture["snapshot"].clone();
        task.report_versions[0]["effectiveRequestIdentity"] = fixture["assessment"].clone();
        task
    }
    #[test]
    fn request_identity_marked_missing_or_false_typed_decision_cannot_be_saved() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let original = marked_identity_task_fixture();
        save_test_task(&mut conn, &original).unwrap();
        for attack in 0..4 {
            let mut task = marked_identity_task_fixture();
            match attack {
                0 => task.decision = "Buy".into(),
                1 => task.report_versions[0]["decision"] = serde_json::json!("Buy"),
                2 => task.effective_request_identity = None,
                _ => {
                    task.report_versions[0]
                        .as_object_mut()
                        .unwrap()
                        .remove("effectiveRequestIdentity");
                }
            }
            assert!(save_test_task(&mut conn, &task).is_err(), "attack {attack}");
            assert_eq!(
                serde_json::to_value(&load_tasks_from_conn(&conn).unwrap()[0]).unwrap(),
                serde_json::to_value(&original).unwrap()
            );
        }
    }
    #[test]
    fn request_identity_unknown_policy_retains_explicit_invalid_diagnostic() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let mut task = marked_identity_task_fixture();
        let mut evidence = task.evidence_bundle.clone().unwrap();
        evidence["manifest"]["effective_request_identity_policy_sha256"] =
            serde_json::json!("0".repeat(64));
        evidence["manifest_sha256"] =
            serde_json::json!(memory::hash_value(&evidence["manifest"]).unwrap());
        readiness::test_support::rehash(&mut evidence, "bundle_sha256");
        let mut snapshot = task.report_text_snapshot.clone().unwrap();
        snapshot["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
        readiness::test_support::rehash(&mut snapshot, "snapshot_sha256");
        task.evidence_bundle = Some(evidence.clone());
        task.report_text_snapshot = Some(snapshot.clone());
        task.effective_request_identity = None;
        task.identity_validation =
            Some(serde_json::json!({"status":"invalid","reason":"reference_mismatch"}));
        task.report_versions[0]["evidenceBundle"] = evidence;
        task.report_versions[0]["reportTextSnapshot"] = snapshot;
        task.report_versions[0]
            .as_object_mut()
            .unwrap()
            .remove("effectiveRequestIdentity");
        task.report_versions[0]["identityValidation"] = task.identity_validation.clone().unwrap();
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].identity_validation, task.identity_validation);
        assert_eq!(
            loaded[0].report_versions[0]["identityValidation"],
            task.identity_validation.unwrap()
        );
        assert!(loaded[0].effective_request_identity.is_none());
    }

    #[test]
    fn request_identity_v9_upgrade_keeps_legacy_absence_and_original_saved_payloads() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let mut legacy = identity_task_fixture();
        legacy.effective_request_identity = None;
        legacy.report_versions[0]
            .as_object_mut()
            .unwrap()
            .remove("effectiveRequestIdentity");
        save_test_task(&mut conn, &legacy).unwrap();
        let before = serde_json::to_value(&load_tasks_from_conn(&conn).unwrap()[0]).unwrap();
        conn.execute_batch(
            "DROP TABLE effective_request_identity_receipts;
            ALTER TABLE tasks DROP COLUMN identity_assessment_sha256;
            ALTER TABLE tasks DROP COLUMN identity_validation;
            ALTER TABLE task_report_versions DROP COLUMN identity_assessment_sha256;
            DELETE FROM schema_migrations WHERE version>=10;
            DROP TABLE analysis_events; DROP TABLE analysis_controls; DROP TABLE analysis_requests; DROP TABLE analysis_journals;
            DROP TABLE task_mutation_requests; DROP TABLE task_store_heads; DROP TABLE task_store_metadata;
            INSERT OR IGNORE INTO schema_migrations(version) VALUES(9);",
        )
        .unwrap();
        initialize_schema(&conn).unwrap();
        let after = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(serde_json::to_value(&after[0]).unwrap(), before);
        assert!(after[0].effective_request_identity.is_none());
        assert!(after[0].report_versions[0]
            .get("effectiveRequestIdentity")
            .is_none());
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM effective_request_identity_receipts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn request_identity_corrupt_rows_broken_links_and_null_inputs_remain_visible() {
        for sql in ["UPDATE effective_request_identity_receipts SET payload='{}'",
            "UPDATE effective_request_identity_receipts SET run_id='33333333-3333-4333-8333-333333333333'",
            "UPDATE effective_request_identity_receipts SET snapshot_sha256='broken'",
            "DELETE FROM effective_request_identity_receipts"] {
            let mut conn = Connection::open_in_memory().unwrap(); initialize_schema(&conn).unwrap();
            save_test_task(&mut conn,&identity_task_fixture()).unwrap(); conn.execute(sql,[]).unwrap();
            assert!(load_tasks_from_conn(&conn).is_err(),"{sql}");
        }
        for key in ["effectiveRequestIdentity", "identityValidation"] {
            let mut input = serde_json::to_value(identity_task_fixture()).unwrap();
            input[key] = Value::Null;
            assert!(serde_json::from_value::<AnalysisTaskRecord>(input).is_err());
        }
    }

    pub(super) fn numeric_task_fixture() -> (AnalysisTaskRecord, Value) {
        let fixture = numeric::test_support::fixture();
        let snapshot = fixture["snapshot"].clone();
        let evidence = fixture["evidence"].clone();
        let version = serde_json::json!({"id":"version-fictional","runId":snapshot["run_id"],"versionNumber":1,"createdAt":snapshot["captured_at"],"legacy":false,"task":{"ticker":snapshot["instrument"],"analysisDate":snapshot["analysis_date"]},"reportSections":snapshot["report_sections"],"evidenceBundle":evidence,"reportTextSnapshot":snapshot,"numericReviews":[]});
        let mut task = quality_task_fixture(Value::Null, version);
        task.id = "task-fictional".into();
        task.ticker = snapshot["instrument"].as_str().unwrap().into();
        task.analysis_date = snapshot["analysis_date"].as_str().unwrap().into();
        task.report_sections = snapshot["report_sections"].clone();
        task.evidence_bundle = Some(evidence);
        task.report_text_snapshot = Some(snapshot);
        (task, fixture)
    }

    #[test]
    fn numeric_migration_reload_preserves_complete_snapshot_review_and_payloads() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(
            "DELETE FROM schema_migrations WHERE version=?1",
            params![SCHEMA_VERSION],
        )
        .unwrap();
        initialize_schema(&conn).unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let (mut task, fixture) = numeric_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].report_text_snapshot,
            task.report_text_snapshot
        );
        for index in 1..=fixture["reviews"].as_array().unwrap().len() {
            task.report_versions[0]["numericReviews"] =
                Value::Array(fixture["reviews"].as_array().unwrap()[..index].to_vec());
            save_test_task(&mut conn, &task).unwrap();
            save_test_task(&mut conn, &task).unwrap();
            let loaded = load_tasks_from_conn(&conn).unwrap();
            assert_eq!(loaded[0].report_versions, task.report_versions);
            assert_eq!(loaded[0].evidence_bundle, task.evidence_bundle);
            assert_eq!(loaded[0].report_sections, task.report_sections);
        }
        let snapshots: i64 = conn
            .query_row("SELECT COUNT(*) FROM numeric_report_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(snapshots, 1);
        let raw: String = conn
            .query_row("SELECT snapshot FROM task_report_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let core: Value = serde_json::from_str(&raw).unwrap();
        assert!(core.get("reportTextSnapshot").is_none());
        assert!(core["numericReviews"].as_array().unwrap().is_empty());
        // Restart/current clearing preserves the full frozen historical owner.
        task.status = "pending".into();
        task.report_text_snapshot = None;
        task.evidence_bundle = None;
        task.report_sections = serde_json::json!({});
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert!(loaded[0].report_text_snapshot.is_none());
        assert_eq!(loaded[0].report_versions, task.report_versions);
        conn.execute("DELETE FROM tasks WHERE id=?1", params![task.id])
            .unwrap();
        prune_evidence(&conn).unwrap();
        for table in [
            "numeric_report_snapshots",
            "numeric_review_receipts",
            "report_numeric_reviews",
            "evidence_bundles",
            "evidence_artifacts",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }

    #[test]
    fn numeric_v8_upgrade_retains_legacy_unknown_and_does_not_invent_a_snapshot() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (task, _) = evidence_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        conn.execute_batch("DROP TABLE report_numeric_reviews; DROP TABLE numeric_review_receipts; DROP TABLE numeric_report_snapshots;
            ALTER TABLE tasks DROP COLUMN numeric_snapshot_sha256;
            ALTER TABLE tasks DROP COLUMN numeric_validation;
            ALTER TABLE task_report_versions DROP COLUMN numeric_snapshot_sha256;
            DELETE FROM schema_migrations WHERE version>=9;
            DROP TABLE analysis_events; DROP TABLE analysis_controls; DROP TABLE analysis_requests; DROP TABLE analysis_journals;
            DROP TABLE task_mutation_requests; DROP TABLE task_store_heads; DROP TABLE task_store_metadata;").unwrap();
        initialize_schema(&conn).unwrap();
        initialize_schema(&conn).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert!(loaded[0].report_text_snapshot.is_none());
        assert!(loaded[0].numeric_validation.is_none());
        assert!(loaded[0].report_versions[0]
            .get("reportTextSnapshot")
            .is_none());
        assert_eq!(loaded[0].report_versions, task.report_versions);
        assert_eq!(loaded[0].evidence_bundle, task.evidence_bundle);
    }

    #[test]
    fn numeric_stale_append_false_match_and_frozen_section_rewrite_roll_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, fixture) = numeric_task_fixture();
        task.report_versions[0]["numericReviews"] =
            Value::Array(fixture["reviews"].as_array().unwrap()[..2].to_vec());
        save_test_task(&mut conn, &task).unwrap();
        let original = load_tasks_from_conn(&conn).unwrap()[0]
            .report_versions
            .clone();
        let mut stale =
            serde_json::from_value::<AnalysisTaskRecord>(serde_json::to_value(&task).unwrap())
                .unwrap();
        stale.report_versions[0]["numericReviews"] =
            Value::Array(fixture["reviews"].as_array().unwrap()[..1].to_vec());
        assert!(save_test_task(&mut conn, &stale).is_err());
        stale.report_versions[0]
            .as_object_mut()
            .unwrap()
            .remove("numericReviews");
        assert!(save_test_task(&mut conn, &stale).is_err());
        stale.report_versions = original.clone();
        stale.report_versions[0]["numericReviews"][1]["result"]["status"] =
            serde_json::json!("match");
        stale.report_versions[0]["numericReviews"][1]["result"]["reason"] =
            serde_json::json!("value_match");
        numeric::test_support::rehash(
            &mut stale.report_versions[0]["numericReviews"][1],
            "review_sha256",
        );
        assert!(save_test_task(&mut conn, &stale).is_err());
        stale.report_versions = original.clone();
        stale.report_versions[0]["reportSections"]["market_report"] =
            serde_json::json!("rewritten");
        stale.report_versions[0]["reportTextSnapshot"]["report_sections"]["market_report"] =
            serde_json::json!("rewritten");
        numeric::test_support::rehash(
            &mut stale.report_versions[0]["reportTextSnapshot"],
            "snapshot_sha256",
        );
        assert!(save_test_task(&mut conn, &stale).is_err());
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].report_versions,
            original
        );
    }

    #[test]
    fn numeric_global_run_and_review_uuid_authorities_bind_across_tasks() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, fixture) = numeric_task_fixture();
        task.report_versions[0]["numericReviews"] =
            Value::Array(vec![fixture["reviews"][0].clone()]);
        save_test_task(&mut conn, &task).unwrap();
        let mut other =
            serde_json::from_value::<AnalysisTaskRecord>(serde_json::to_value(&task).unwrap())
                .unwrap();
        other.id = "other-task".into();
        other.report_versions[0]["id"] = serde_json::json!("other-version");
        other.report_versions[0]["numericReviews"] = serde_json::json!([]);
        // Identical snapshot copies share one authority.
        save_test_task(&mut conn, &other).unwrap();
        let mut changed =
            serde_json::from_value::<AnalysisTaskRecord>(serde_json::to_value(&other).unwrap())
                .unwrap();
        changed.report_text_snapshot.as_mut().unwrap()["captured_at"] =
            serde_json::json!("2026-01-09T11:01:00.000000Z");
        numeric::test_support::rehash(
            changed.report_text_snapshot.as_mut().unwrap(),
            "snapshot_sha256",
        );
        changed.report_versions[0]["reportTextSnapshot"] =
            changed.report_text_snapshot.clone().unwrap();
        assert!(save_test_task(&mut conn, &changed).is_err());
        let mut reused = fixture["reviews"][0].clone();
        reused["target"]["task_id"] = serde_json::json!("other-task");
        reused["target"]["version_id"] = serde_json::json!("other-version");
        numeric::test_support::rehash(&mut reused, "review_sha256");
        other.report_versions[0]["numericReviews"] = serde_json::json!([reused]);
        assert!(save_test_task(&mut conn, &other).is_err());
        other.report_versions[0]["numericReviews"][0]["review_id"] =
            serde_json::json!("33333333-3333-4333-8333-333333333333");
        numeric::test_support::rehash(
            &mut other.report_versions[0]["numericReviews"][0],
            "review_sha256",
        );
        save_test_task(&mut conn, &other).unwrap();
        assert_eq!(load_tasks_from_conn(&conn).unwrap().len(), 2);
        conn.execute("DELETE FROM tasks WHERE id=?1", params![task.id])
            .unwrap();
        prune_evidence(&conn).unwrap();
        let remaining = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].report_text_snapshot,
            other.report_text_snapshot
        );
        assert_eq!(
            remaining[0].report_versions[0]["numericReviews"],
            other.report_versions[0]["numericReviews"]
        );
        conn.execute("DELETE FROM tasks WHERE id=?1", params![other.id])
            .unwrap();
        prune_evidence(&conn).unwrap();
        for table in [
            "numeric_report_snapshots",
            "numeric_review_receipts",
            "report_numeric_reviews",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn numeric_corrupt_rows_indices_and_explicit_invalid_markers_fail_closed() {
        for query in [
            "UPDATE numeric_report_snapshots SET run_id='33333333-3333-4333-8333-333333333333'",
            "UPDATE numeric_review_receipts SET review_id='33333333-3333-4333-8333-333333333333' WHERE rowid=(SELECT MIN(rowid) FROM numeric_review_receipts)",
            "UPDATE report_numeric_reviews SET position=9 WHERE position=0",
            "UPDATE numeric_review_receipts SET payload='{}'",
            "UPDATE task_report_versions SET numeric_snapshot_sha256=NULL",
        ] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize_schema(&conn).unwrap();
            let (mut task, fixture) = numeric_task_fixture();
            task.report_versions[0]["numericReviews"] = fixture["reviews"].clone();
            save_test_task(&mut conn, &task).unwrap();
            conn.execute(query, []).unwrap();
            assert!(load_tasks_from_conn(&conn).is_err(), "{query}");
        }
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, _) = numeric_task_fixture();
        task.numeric_validation =
            Some(serde_json::json!({"status":"invalid","reason":"hash_mismatch"}));
        assert!(save_test_task(&mut conn, &task).is_err());
        task.report_text_snapshot = None;
        task.report_versions = serde_json::json!([]);
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].numeric_validation,
            task.numeric_validation
        );
        numeric_store::clear(&conn).unwrap();
        let counts: i64 = conn
            .query_row("SELECT COUNT(*) FROM numeric_report_snapshots", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(counts, 0);
    }

    #[test]
    fn numeric_owner_capture_chronology_includes_frozen_memory_decision() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, _) = memory_task_fixture();
        let mut sections = serde_json::json!({"market_report":null,"sentiment_report":null,"news_report":null,"fundamentals_report":null,"investment_plan":null,"trader_investment_plan":null,"final_trade_decision":null});
        sections["final_trade_decision"] = task.report_sections["final_trade_decision"].clone();
        let evidence = task.evidence_bundle.as_ref().unwrap();
        let mut snapshot = serde_json::json!({"schema_version":1,"run_id":evidence["run_id"],"instrument":evidence["instrument"],"analysis_date":evidence["analysis_date"],"captured_at":"2025-02-14T12:04:59.000000Z","evidence_bundle_sha256":evidence["bundle_sha256"],"report_sections":sections});
        numeric::test_support::rehash(&mut snapshot, "snapshot_sha256");
        // Standalone Evidence validation cannot establish Memory chronology.
        numeric::validate_snapshot(&snapshot, evidence).unwrap();
        task.report_text_snapshot = Some(snapshot.clone());
        assert!(save_test_task(&mut conn, &task).is_err());
        task.report_text_snapshot = None;
        task.report_versions[0]["reportTextSnapshot"] = snapshot.clone();
        assert!(save_test_task(&mut conn, &task).is_err());
        snapshot["captured_at"] = serde_json::json!("2025-02-14T12:05:00.000000Z");
        numeric::test_support::rehash(&mut snapshot, "snapshot_sha256");
        task.report_text_snapshot = Some(snapshot.clone());
        task.report_versions[0]["reportTextSnapshot"] = snapshot.clone();
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].report_text_snapshot,
            Some(snapshot)
        );
        // A coherent external hash rewrite still cannot pass the owner clock.
        let mut earlier = task.report_text_snapshot.clone().unwrap();
        earlier["captured_at"] = serde_json::json!("2025-02-14T12:04:59.000000Z");
        numeric::test_support::rehash(&mut earlier, "snapshot_sha256");
        conn.execute(
            "UPDATE numeric_report_snapshots SET snapshot_sha256=?1,payload=?2",
            params![
                earlier["snapshot_sha256"].as_str().unwrap(),
                json_string(&earlier).unwrap()
            ],
        )
        .unwrap();
        conn.execute(
            "UPDATE tasks SET numeric_snapshot_sha256=?1",
            params![earlier["snapshot_sha256"].as_str().unwrap()],
        )
        .unwrap();
        conn.execute(
            "UPDATE task_report_versions SET numeric_snapshot_sha256=?1",
            params![earlier["snapshot_sha256"].as_str().unwrap()],
        )
        .unwrap();
        assert!(load_tasks_from_conn(&conn).is_err());
    }

    #[test]
    fn numeric_missing_receipt_link_cannot_silently_erase_saved_history() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, fixture) = numeric_task_fixture();
        task.report_versions[0]["numericReviews"] = fixture["reviews"].clone();
        save_test_task(&mut conn, &task).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=OFF; DELETE FROM numeric_review_receipts; PRAGMA foreign_keys=ON;",
        )
        .unwrap();
        assert!(load_tasks_from_conn(&conn).is_err());
        assert!(save_test_task(&mut conn, &task).is_err());
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM report_numeric_reviews", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(links, fixture["reviews"].as_array().unwrap().len() as i64);
    }

    pub(super) fn readiness_task_fixture() -> AnalysisTaskRecord {
        let receipt = readiness::test_support::receipt();
        let evidence = readiness::test_support::evidence();
        let reports =
            serde_json::json!({"final_trade_decision":"Rating: Hold\nFictional research."});
        let version = serde_json::json!({"id":"readiness-version","runId":receipt["run_id"],"versionNumber":1,"createdAt":"2026-01-09T10:05:00.000000Z","legacy":false,"task":{"ticker":receipt["instrument"],"analysisDate":receipt["analysis_date"],"assetType":"stock","analysts":receipt["policy"]["selected_analysts"]},"decision":"Hold","reportSections":reports,"evidenceBundle":evidence,"researchReadiness":receipt});
        let mut task = quality_task_fixture(Value::Null, version);
        task.ticker = receipt["instrument"].as_str().unwrap().into();
        task.analysis_date = receipt["analysis_date"].as_str().unwrap().into();
        task.analysts = receipt["policy"]["selected_analysts"].clone();
        task.decision = "Hold".into();
        task.report_sections = reports;
        task.evidence_bundle = Some(evidence);
        task.research_readiness = Some(receipt);
        task
    }
    fn withheld_memory_task_fixture(text: &str, rating: &str) -> AnalysisTaskRecord {
        use readiness::test_support::{assess, receipt, rehash, rehash_evidence};
        let (mut task, mut bundle) = memory_task_fixture();
        let decision = &bundle["decision_snapshot"]["decision"];
        let mut policy = receipt()["policy"].clone();
        policy["research_started_at"] = decision["research_started_at"].clone();
        policy["research_as_of"] = decision["research_as_of"].clone();
        policy["research_calendar_date"] = decision["analysis_calendar_date"].clone();
        policy["host_utc_offset"] = decision["host_utc_offset"].clone();
        rehash(&mut policy, "policy_sha256");
        let evidence = task.evidence_bundle.as_mut().unwrap();
        evidence["manifest"]["max_tool_rounds"] = policy["max_tool_rounds"].clone();
        evidence["manifest"]["research_readiness_policy_sha256"] = policy["policy_sha256"].clone();
        rehash_evidence(evidence);
        let receipt = assess(evidence, &policy);
        let snapshot = &mut bundle["decision_snapshot"];
        let old_hash = snapshot["decision"]["decision_text_sha256"]
            .as_str()
            .unwrap()
            .to_string();
        let artifact = memory::test_support::artifact("text", text);
        let hash = artifact["sha256"].as_str().unwrap().to_string();
        snapshot["artifacts"]
            .as_object_mut()
            .unwrap()
            .remove(&old_hash);
        snapshot["artifacts"]
            .as_object_mut()
            .unwrap()
            .insert(hash.clone(), artifact);
        snapshot["contract"]["decision_text_sha256"] = hash.clone().into();
        rehash(&mut snapshot["contract"], "contract_sha256");
        snapshot["decision"]["contract_sha256"] = snapshot["contract"]["contract_sha256"].clone();
        snapshot["decision"]["decision_text_sha256"] = hash.into();
        snapshot["decision"]["rating"] = rating.into();
        snapshot["decision"]["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
        rehash(&mut snapshot["decision"], "decision_sha256");
        rehash(snapshot, "snapshot_sha256");
        bundle["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
        rehash(&mut bundle, "bundle_sha256");
        task.memory_bundle = Some(bundle.clone());
        task.research_readiness = Some(receipt.clone());
        task.analysts = policy["selected_analysts"].clone();
        task.decision = rating.into();
        task.report_sections = serde_json::json!({"final_trade_decision":text});
        task.report_versions[0]["task"]["analysts"] = task.analysts.clone();
        task.report_versions[0]["decision"] = rating.into();
        task.report_versions[0]["reportSections"] = task.report_sections.clone();
        task.report_versions[0]["memoryBundle"] = bundle;
        task.report_versions[0]["evidenceBundle"] = evidence.clone();
        task.report_versions[0]["researchReadiness"] = receipt;
        task
    }

    #[test]
    fn readiness_v7_upgrade_preserves_saved_memory_and_keeps_legacy_status_unknown() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (task, _) = memory_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        conn.execute_batch(
            "DROP TABLE research_readiness_receipts;
            ALTER TABLE tasks DROP COLUMN readiness_assessment_sha256;
            ALTER TABLE tasks DROP COLUMN readiness_validation;
            ALTER TABLE task_report_versions DROP COLUMN readiness_assessment_sha256;
            DELETE FROM schema_migrations WHERE version>=8;
            DROP TABLE analysis_events; DROP TABLE analysis_controls; DROP TABLE analysis_requests; DROP TABLE analysis_journals;
            DROP TABLE task_mutation_requests; DROP TABLE task_store_heads; DROP TABLE task_store_metadata;
            INSERT OR IGNORE INTO schema_migrations(version) VALUES(7);",
        )
        .unwrap();
        initialize_schema(&conn).unwrap();
        initialize_schema(&conn).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].memory_bundle, task.memory_bundle);
        assert_eq!(loaded[0].evidence_bundle, task.evidence_bundle);
        assert_eq!(loaded[0].report_versions, task.report_versions);
        assert!(loaded[0].research_readiness.is_none() && loaded[0].readiness_validation.is_none());
        assert!(loaded[0].report_versions[0]
            .get("researchReadiness")
            .is_none());
        assert!(loaded[0].report_versions[0]
            .get("readinessValidation")
            .is_none());
    }
    #[test]
    fn readiness_v8_save_reload_deduplicates_and_keeps_frozen_receipts_after_rerun() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        initialize_schema(&conn).unwrap();
        let mut task = readiness_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].research_readiness, task.research_readiness);
        assert_eq!(loaded[0].evidence_bundle, task.evidence_bundle);
        assert_eq!(loaded[0].report_versions[0], task.report_versions[0]);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM research_readiness_receipts",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let raw: String = conn
            .query_row("SELECT snapshot FROM task_report_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!raw.contains("researchReadiness") && !raw.contains("124.07345678901234"));
        task.status = "running".into();
        task.research_readiness = None;
        task.evidence_bundle = None;
        task.decision = String::new();
        task.report_sections = serde_json::json!({});
        save_test_task(&mut conn, &task).unwrap();
        let rerun = load_tasks_from_conn(&conn).unwrap();
        assert!(rerun[0].research_readiness.is_none());
        assert_eq!(rerun[0].report_versions[0], task.report_versions[0]);
        conn.execute("DELETE FROM tasks", []).unwrap();
        prune_evidence(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM research_readiness_receipts",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn readiness_withheld_requires_first_text_task_version_and_memory_review_rating() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let task = withheld_memory_task_fixture(
            "Rating: REVIEW\nFictional missing verification.",
            "REVIEW",
        );
        assert_eq!(
            task.research_readiness.as_ref().unwrap()["status"],
            "insufficient_evidence"
        );
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].research_readiness, task.research_readiness);
        assert_eq!(loaded[0].memory_bundle, task.memory_bundle);
        assert_eq!(loaded[0].report_versions[0], task.report_versions[0]);
        for text in [
            "Rating: Buy\nRating: REVIEW",
            "Ｒａｔｉｎｇ： Ｂｕｙ\nRating: REVIEW",
            "Rating: REVIEW or Buy\nRating: REVIEW",
            "Ratİng: Buy\nRating: REVIEW",
            "١. Rating: Buy\nRating: REVIEW",
            "Rating: Hold\u{338}\nRating: REVIEW",
            "Rating: REVİEW\nRating: REVIEW",
        ] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize_schema(&conn).unwrap();
            let task = withheld_memory_task_fixture(text, "REVIEW");
            memory::validate_report_binding(
                task.memory_bundle.as_ref().unwrap(),
                &task.decision,
                &task.report_sections,
            )
            .unwrap();
            assert!(save_test_task(&mut conn, &task).is_err());
            assert!(load_tasks_from_conn(&conn).unwrap().is_empty());
        }
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        assert!(save_test_task(
            &mut conn,
            &withheld_memory_task_fixture("Rating: REVIEW", "Buy")
        )
        .is_err());
    }
    #[test]
    fn readiness_explicit_invalid_markers_are_saved_and_contradictions_are_rejected() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let mut task = readiness_task_fixture();
        task.report_versions[0]["readinessValidation"] =
            serde_json::json!({"status":"invalid","reason":"malformed"});
        assert!(save_test_task(&mut conn, &task).is_err());
        assert!(load_tasks_from_conn(&conn).unwrap().is_empty());
        task.report_versions[0]
            .as_object_mut()
            .unwrap()
            .remove("readinessValidation");
        task.readiness_validation =
            Some(serde_json::json!({"status":"invalid","reason":"hash_mismatch"}));
        assert!(save_test_task(&mut conn, &task).is_err());
        assert!(load_tasks_from_conn(&conn).unwrap().is_empty());
        task.research_readiness = None;
        task.report_versions = serde_json::json!([]);
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].readiness_validation, task.readiness_validation);
        assert!(loaded[0].research_readiness.is_none());
        task.readiness_validation.as_mut().unwrap()["error"] = "private body".into();
        assert!(save_test_task(&mut conn, &task).is_err());
    }
    #[test]
    fn readiness_frozen_runtime_settings_bind_policy_on_save_and_reload() {
        for (key, value) in [
            (
                "research_readiness_policy_sha256",
                serde_json::json!("a".repeat(64)),
            ),
            ("max_tool_rounds", serde_json::json!(99)),
            ("analysts", serde_json::json!(["market", "news"])),
        ] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize_schema(&conn).unwrap();
            let mut task = readiness_task_fixture();
            let receipt = task.research_readiness.as_ref().unwrap();
            task.report_versions[0]["run"] = serde_json::json!({"runtimeRunSettings":{
                "research_readiness_policy_sha256":receipt["policy"]["policy_sha256"],
                "max_tool_rounds":receipt["policy"]["max_tool_rounds"],
                "analysts":receipt["policy"]["selected_analysts"]}});
            let mut bad = readiness_task_fixture();
            bad.report_versions = task.report_versions.clone();
            bad.report_versions[0]["run"]["runtimeRunSettings"][key] = value.clone();
            assert!(save_test_task(&mut conn, &bad).is_err(), "{key}");
            assert!(load_tasks_from_conn(&conn).unwrap().is_empty());
            save_test_task(&mut conn, &task).unwrap();
            assert_eq!(
                load_tasks_from_conn(&conn).unwrap()[0].report_versions,
                task.report_versions
            );
            let raw: String = conn
                .query_row("SELECT snapshot FROM task_report_versions", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let mut changed = memory::parse_json(&raw).unwrap();
            changed["run"]["runtimeRunSettings"][key] = value;
            conn.execute(
                "UPDATE task_report_versions SET snapshot=?1",
                params![json_string(&changed).unwrap()],
            )
            .unwrap();
            assert!(load_tasks_from_conn(&conn).is_err(), "{key}");
        }
    }
    #[test]
    fn readiness_same_uuid_has_one_assessment_across_different_owners_and_versions() {
        use readiness::test_support::{assess, rehash, rehash_evidence};
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let mut task = readiness_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        let original = load_tasks_from_conn(&conn).unwrap()[0]
            .research_readiness
            .clone();
        task.id = "different-owner".into();
        task.report_versions[0]["id"] = "different-version".into();
        let mut policy = task.research_readiness.as_ref().unwrap()["policy"].clone();
        policy["max_tool_rounds"] = 21.into();
        rehash(&mut policy, "policy_sha256");
        let evidence = task.evidence_bundle.as_mut().unwrap();
        evidence["manifest"]["max_tool_rounds"] = 21.into();
        evidence["manifest"]["research_readiness_policy_sha256"] = policy["policy_sha256"].clone();
        rehash_evidence(evidence);
        let receipt = assess(evidence, &policy);
        readiness::validate_receipt(&receipt, evidence).unwrap();
        task.research_readiness = Some(receipt.clone());
        task.report_versions[0]["researchReadiness"] = receipt;
        task.report_versions[0]["evidenceBundle"] = evidence.clone();
        assert!(save_test_task(&mut conn, &task).is_err());
        assert_eq!(load_tasks_from_conn(&conn).unwrap().len(), 1);
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].research_readiness,
            original
        );
    }
    #[test]
    fn readiness_corruption_in_payload_identity_and_version_columns_fails_reload() {
        for change in [
            "UPDATE research_readiness_receipts SET payload='{}'",
            "UPDATE research_readiness_receipts SET run_id='33333333-3333-4333-8333-333333333333'",
            "UPDATE task_report_versions SET run_id='33333333-3333-4333-8333-333333333333'",
        ] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize_schema(&conn).unwrap();
            save_test_task(&mut conn, &readiness_task_fixture()).unwrap();
            conn.execute(change, []).unwrap();
            assert!(load_tasks_from_conn(&conn).is_err());
        }
    }
    #[test]
    fn memory_v7_reload_keeps_exact_artifacts_and_freezes_versions_across_reruns() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, bundle) = memory_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].memory_bundle.as_ref(), Some(&bundle));
        assert_eq!(loaded[0].report_versions[0], task.report_versions[0]);
        assert_eq!(loaded[0].evaluation_reviews, serde_json::json!([]));
        let bundles: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM research_memory_objects WHERE kind='bundle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bundles, 1);
        let raw: String = conn
            .query_row("SELECT snapshot FROM task_report_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!raw.contains("123.45678901234567") && !raw.contains("memoryBundle"));
        let artifacts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM research_memory_objects WHERE kind='artifact'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut unique: std::collections::BTreeSet<String> = bundle["decision_snapshot"]
            ["artifacts"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for snapshot in bundle["input_snapshot"]["decisions"].as_array().unwrap() {
            unique.extend(snapshot["artifacts"].as_object().unwrap().keys().cloned());
        }
        unique.insert(
            bundle["input_snapshot"]["context_artifact"]["sha256"]
                .as_str()
                .unwrap()
                .into(),
        );
        assert_eq!(artifacts, unique.len() as i64);
        task.memory_bundle = None;
        task.evidence_bundle = None;
        task.status = "running".into();
        save_test_task(&mut conn, &task).unwrap();
        let replay = load_tasks_from_conn(&conn).unwrap();
        assert!(replay[0].memory_bundle.is_none());
        assert_eq!(replay[0].report_versions[0]["memoryBundle"], bundle);
        conn.execute("DELETE FROM tasks", []).unwrap();
        prune_evidence(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM research_memory_objects", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }
    #[test]
    fn memory_reviews_append_dedupe_and_never_rewrite_generated_bundle() {
        use memory::test_support::{review, settled};
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, bundle) = memory_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        let facts = review(settled(&bundle, false), "2025-02-20T13:00:00Z");
        let reflected = review(settled(&bundle, true), "2025-02-21T13:00:00Z");
        let reviews = serde_json::json!([facts, reflected]);
        task.evaluation_reviews = reviews.clone();
        task.report_versions[0]["evaluationReviews"] = reviews.clone();
        save_test_task(&mut conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].evaluation_reviews, reviews);
        assert_eq!(loaded[0].report_versions[0]["evaluationReviews"], reviews);
        assert_eq!(loaded[0].memory_bundle.as_ref(), Some(&bundle));
        assert_eq!(loaded[0].report_versions[0]["memoryBundle"], bundle);
        let duplicate = review(settled(&bundle, true), "2025-02-22T13:00:00Z");
        task.evaluation_reviews = serde_json::json!([duplicate]);
        task.report_versions[0]["evaluationReviews"] = task.evaluation_reviews.clone();
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].evaluation_reviews,
            reviews
        );
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM research_memory_objects WHERE kind='review'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        let mut conflicting = memory::test_support::settled(&bundle, true);
        conflicting["outcome"]["observed_at"] = "2025-02-20T14:00:00Z".into();
        memory::test_support::rehash(&mut conflicting["outcome"], "outcome_sha256");
        conflicting["reflection"]["outcome_sha256"] =
            conflicting["outcome"]["outcome_sha256"].clone();
        memory::test_support::rehash(&mut conflicting["reflection"], "reflection_sha256");
        memory::test_support::rehash(&mut conflicting, "snapshot_sha256");
        for snapshot in [conflicting, bundle["decision_snapshot"].clone()] {
            task.evaluation_reviews = serde_json::json!([review(snapshot, "2025-02-23T13:00:00Z")]);
            task.report_versions[0]["evaluationReviews"] = task.evaluation_reviews.clone();
            assert!(save_test_task(&mut conn, &task).is_err());
            assert_eq!(
                load_tasks_from_conn(&conn).unwrap()[0].report_versions[0]["evaluationReviews"],
                reviews
            );
        }
        // Re-observing an already attached facts snapshot is deduplicated even
        // after a reflection has been added; the original dated review stays.
        task.evaluation_reviews =
            serde_json::json!([review(settled(&bundle, false), "2025-02-24T13:00:00Z")]);
        task.report_versions[0]["evaluationReviews"] = task.evaluation_reviews.clone();
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].evaluation_reviews,
            reviews
        );
        task.evaluation_reviews = serde_json::json!([]);
        task.report_versions[0]["evaluationReviews"] = serde_json::json!([]);
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].report_versions[0]["evaluationReviews"],
            reviews
        );
        task.memory_bundle = None;
        task.evidence_bundle = None;
        task.status = "queued".into();
        save_test_task(&mut conn, &task).unwrap();
        let rerun = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(rerun[0].evaluation_reviews, serde_json::json!([]));
        assert_eq!(rerun[0].report_versions[0]["evaluationReviews"], reviews);
    }
    #[test]
    fn memory_bad_report_identity_and_frozen_settings_are_rejected_atomically() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, bundle) = memory_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        task.decision = "Sell".into();
        assert!(save_test_task(&mut conn, &task).is_err());
        task.decision = "Hold".into();
        task.report_sections["final_trade_decision"] = "Changed frozen text".into();
        assert!(save_test_task(&mut conn, &task).is_err());
        let (mut task, _) = memory_task_fixture();
        task.report_versions[0]["runId"] = "33333333-3333-4333-8333-333333333333".into();
        assert!(save_test_task(&mut conn, &task).is_err());
        let (mut task, _) = memory_task_fixture();
        task.report_versions[0]["task"]["researchDepth"] = 99.into();
        assert!(save_test_task(&mut conn, &task).is_err());
        let (mut task, _) = memory_task_fixture();
        let changed = task.memory_bundle.as_mut().unwrap();
        changed["input_snapshot"]["selected_at"] = "2025-02-14T12:00:01Z".into();
        changed["input_snapshot"]["availability_cutoff"] = "2025-02-14T12:00:01Z".into();
        memory::test_support::rehash(&mut changed["input_snapshot"], "input_sha256");
        memory::test_support::rehash(changed, "bundle_sha256");
        memory::validate_bundle_evidence(changed, task.evidence_bundle.as_ref().unwrap()).unwrap();
        assert!(save_test_task(&mut conn, &task).is_err());
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0]
                .memory_bundle
                .as_ref(),
            Some(&bundle)
        );
        let (mut task, _) = memory_task_fixture();
        task.memory_validation =
            Some(serde_json::json!({"status":"invalid","reason":"hash_mismatch"}));
        assert!(save_test_task(&mut conn, &task).is_err());
        task.memory_bundle = None;
        task.evaluation_reviews = serde_json::json!([]);
        save_test_task(&mut conn, &task).unwrap();
        assert_eq!(
            load_tasks_from_conn(&conn).unwrap()[0].memory_validation,
            task.memory_validation
        );
        task.memory_validation.as_mut().unwrap()["error"] = "private exception body".into();
        assert!(save_test_task(&mut conn, &task).is_err());
    }
    #[test]
    fn memory_corrupt_content_links_and_review_columns_fail_visible_reload() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (task, _) = memory_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        conn.execute(
            "UPDATE research_memory_objects SET metadata='{}' WHERE kind='artifact'",
            [],
        )
        .unwrap();
        assert!(load_tasks_from_conn(&conn).is_err());
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (task, _) = memory_task_fixture();
        save_test_task(&mut conn, &task).unwrap();
        conn.execute(
            "DELETE FROM research_memory_links WHERE field='decision_snapshot'",
            [],
        )
        .unwrap();
        assert!(load_tasks_from_conn(&conn).is_err());
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, bundle) = memory_task_fixture();
        task.report_versions[0]["evaluationReviews"] =
            serde_json::json!([memory::test_support::review(
                memory::test_support::settled(&bundle, true),
                "2025-02-22T12:00:00Z"
            )]);
        save_test_task(&mut conn, &task).unwrap();
        conn.execute(
            "UPDATE report_memory_reviews SET snapshot_sha256=?1",
            params![bundle["decision_snapshot"]["snapshot_sha256"]
                .as_str()
                .unwrap()],
        )
        .unwrap();
        assert!(load_tasks_from_conn(&conn).is_err());
    }

    #[test]
    fn evidence_task_and_frozen_version_reload_exact_values_with_deduplicated_payloads() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, bundle) = evidence_task_fixture();
        upsert_task(&conn, &task).unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].evidence_bundle.as_ref(), Some(&bundle));
        assert_eq!(loaded[0].report_versions[0]["evidenceBundle"], bundle);
        let bundles: i64 = conn
            .query_row("SELECT COUNT(*) FROM evidence_bundles", [], |r| r.get(0))
            .unwrap();
        let artifacts: i64 = conn
            .query_row("SELECT COUNT(*) FROM evidence_artifacts", [], |r| r.get(0))
            .unwrap();
        assert_eq!((bundles, artifacts), (1, 2));
        let raw: String = conn
            .query_row("SELECT snapshot FROM task_report_versions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!raw.contains("123.45678901234567"));
        task.evidence_bundle = None;
        task.status = "running".into();
        upsert_task(&conn, &task).unwrap();
        let replay = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(replay[0].evidence_bundle, None);
        assert_eq!(replay[0].report_versions[0]["evidenceBundle"], bundle);
    }

    #[test]
    fn malformed_or_conflicting_evidence_is_rejected_and_artifact_corruption_is_visible() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let (mut task, _) = evidence_task_fixture();
        task.evidence_validation =
            Some(serde_json::json!({"status":"invalid","reason":"hash_mismatch"}));
        assert!(upsert_task(&conn, &task).is_err());
        task.evidence_validation = None;
        {
            let transaction = conn.transaction().unwrap();
            upsert_task(&transaction, &task).unwrap();
            transaction.commit().unwrap();
        }
        task.evidence_bundle.as_mut().unwrap()["error"] = "secret exception".into();
        assert!(upsert_task(&conn, &task).is_err());
        task.evidence_bundle = None;
        task.report_versions[0]["reportSections"]["market_report"] = "Changed frozen report".into();
        {
            let transaction = conn.transaction().unwrap();
            assert!(upsert_task(&transaction, &task).is_err());
        }
        let unchanged = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(
            unchanged[0].report_versions[0]["reportSections"]["market_report"],
            "A fictional saved report."
        );
        conn.execute("UPDATE evidence_artifacts SET payload = '{\"kind\":\"normalized_data\",\"payload\":\"{}\"}' WHERE sha256 = ?1", params!["ead52a216ad5191b06a9bd39d85fdfa04968f33699f9afd0244d5bc962581b90"]).unwrap();
        assert!(load_tasks_from_conn(&conn).is_err());
    }

    #[test]
    fn storage_filters_quality_on_write_and_on_read_without_altering_snapshot_metadata() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let safe = serde_json::json!({
            "portfolio_manager": {"status": "unvalidated_text", "schema": "PortfolioDecision", "source": "raw_response", "reason": "no_tool_call"}
        });
        let dirty = serde_json::json!({
            "portfolio_manager": {"status": "unvalidated_text", "schema": "PortfolioDecision", "source": "raw_response", "reason": "no_tool_call", "error": "sensitive-body", "endpoint": "https://private.invalid"},
            "research_manager": {"status": "validated_schema", "schema": "ResearchPlan", "source": "raw_response"},
            "unknown_agent": {"error": "sensitive-body"}
        });
        let invalid = serde_json::json!({
            "trader": {"status": "unvalidated_text", "schema": "TraderProposal", "source": "structured", "reason": "no_tool_call"}
        });
        let snapshot = serde_json::json!({
            "id": "quality-version", "runId": "quality-run", "versionNumber": 1,
            "createdAt": "2026-10-04", "reportSections": {"market_report": "Original report"},
            "customMetadata": {"retained": true}, "outputQuality": dirty
        });
        let mut task = quality_task_fixture(dirty.clone(), snapshot.clone());
        let mut invalid_snapshot = snapshot.clone();
        invalid_snapshot["id"] = Value::String("invalid-version".to_string());
        invalid_snapshot["runId"] = Value::String("invalid-run".to_string());
        invalid_snapshot["versionNumber"] = Value::Number(2.into());
        invalid_snapshot["outputQuality"] = invalid.clone();
        task.report_versions
            .as_array_mut()
            .unwrap()
            .push(invalid_snapshot.clone());
        upsert_task(&conn, &task).unwrap();

        let raw_quality: String = conn
            .query_row(
                "SELECT output_quality FROM tasks WHERE id = 'quality-task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw_quality).unwrap(), safe);
        let mut expected_snapshot = snapshot.clone();
        expected_snapshot["outputQuality"] = safe.clone();
        invalid_snapshot
            .as_object_mut()
            .unwrap()
            .remove("outputQuality");
        for (id, expected) in [
            ("quality-version", &expected_snapshot),
            ("invalid-version", &invalid_snapshot),
        ] {
            let raw: String = conn
                .query_row(
                    "SELECT snapshot FROM task_report_versions WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), *expected);
            assert!(!raw.contains("sensitive-body") && !raw.contains("private.invalid"));
        }

        conn.execute(
            "UPDATE tasks SET output_quality = ?1 WHERE id = 'quality-task'",
            params![json_string(&dirty).unwrap()],
        )
        .unwrap();
        conn.execute(
            "UPDATE task_report_versions SET snapshot = ?1 WHERE id = 'quality-version'",
            params![json_string(&snapshot).unwrap()],
        )
        .unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap();
        assert_eq!(loaded[0].output_quality.as_ref(), Some(&safe));
        assert_eq!(loaded[0].report_versions[0], expected_snapshot);
        assert_eq!(loaded[0].report_versions[1], invalid_snapshot);

        task.output_quality = Some(invalid);
        upsert_task(&conn, &task).unwrap();
        let stored_invalid: Option<String> = conn
            .query_row(
                "SELECT output_quality FROM tasks WHERE id = 'quality-task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_invalid, None);
        assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].output_quality, None);
    }

    #[test]
    fn schema_upgrade_backfills_a_legacy_completed_report() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                ticker TEXT NOT NULL,
                instrument_name TEXT NOT NULL DEFAULT '',
                analysis_date TEXT NOT NULL,
                asset_type TEXT NOT NULL,
                research_depth INTEGER NOT NULL,
                analysts TEXT NOT NULL,
                output_language TEXT NOT NULL,
                status TEXT NOT NULL,
                queued_at TEXT NOT NULL DEFAULT '',
                queue_order INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                decision TEXT NOT NULL DEFAULT '',
                stats TEXT NOT NULL,
                agent_statuses TEXT NOT NULL,
                report_sections TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE task_reports (
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                report_key TEXT NOT NULL,
                content TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (task_id, report_key)
             );
             INSERT INTO tasks (
                id, ticker, instrument_name, analysis_date, asset_type, research_depth,
                analysts, output_language, status, queued_at, queue_order, created_at, updated_at,
                decision, stats, agent_statuses, report_sections, error
             ) VALUES (
                'legacy-task', 'OLD.TEST', 'Old Report', '2024-01-01', 'stock', 3,
                '[\"market\"]', 'English', 'completed', '', NULL,
                '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z',
                'Hold', '{\"llmCalls\":1}', '{}', '{}', ''
             );
             INSERT INTO task_reports (task_id, report_key, content, updated_at)
             VALUES (
                'legacy-task', 'market_report', 'Historical evidence',
                '2024-01-02T00:00:00Z'
             );",
        )
        .unwrap();

        initialize_schema(&conn).unwrap();
        assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].output_quality, None);

        let snapshot: String = conn
            .query_row(
                "SELECT snapshot FROM task_report_versions WHERE task_id = 'legacy-task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(version["legacy"], true);
        assert_eq!(version["versionNumber"], 1);
        assert_eq!(version["run"], Value::Null);
        assert_eq!(
            version["reportSections"]["market_report"],
            "Historical evidence"
        );
        assert_eq!(version["task"]["researchDepth"], 3);
        assert_eq!(version["stats"]["llmCalls"], 1);

        initialize_schema(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_report_versions WHERE task_id = 'legacy-task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
