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
use crate::{research_memory as memory, research_memory_storage as memory_store};
use crate::{research_readiness as readiness, research_readiness_storage as readiness_store};

const SCHEMA_VERSION: i64 = 8;
const SECRET_PREFIX: &str = "enc:v1:";

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

#[derive(Debug, Deserialize, Serialize)]
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
    pub logs: Value,
    pub error: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDesktopData {
    pub settings: Option<Value>,
    pub tasks: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub settings: Option<PublicSettings>,
    pub tasks: Vec<AnalysisTaskRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_migration_error: Option<String>,
}

pub fn load_snapshot(app: &AppHandle) -> Result<DesktopSnapshot, String> {
    let conn = open_database(app)?;
    let (settings, secret_migration_error) = load_settings_from_conn(app, &conn)?;
    let tasks = load_tasks_from_conn(&conn)?;
    Ok(DesktopSnapshot {
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

pub fn save_task(app: &AppHandle, task: AnalysisTaskRecord) -> Result<(), String> {
    let mut conn = open_database(app)?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    upsert_task(&transaction, &normalize_task(task))?;
    prune_evidence(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn delete_task(app: &AppHandle, task_id: String) -> Result<(), String> {
    let conn = open_database(app)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
        .map_err(|error| error.to_string())?;
    prune_evidence(&conn)?;
    Ok(())
}

pub fn clear_data(app: &AppHandle) -> Result<(), String> {
    let conn = open_database(app)?;
    let current_provider = load_settings_from_conn(app, &conn)?
        .0
        .map(|settings| settings.llm_provider);
    secrets::delete_all_secrets(current_provider.as_deref())?;
    memory_store::clear(&conn)?;
    readiness_store::clear(&conn)?;
    conn.execute_batch(
        "DELETE FROM task_report_versions;
         DELETE FROM task_reports;
         DELETE FROM task_logs;
         DELETE FROM tasks;
         DELETE FROM evidence_bundle_artifacts;
         DELETE FROM evidence_bundles;
         DELETE FROM evidence_artifacts;
         DELETE FROM settings;",
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn import_legacy(
    app: &AppHandle,
    legacy: LegacyDesktopData,
) -> Result<DesktopSnapshot, String> {
    let conn = open_database(app)?;
    let (current_settings, current_migration_error) = load_settings_from_conn(app, &conn)?;
    let mut secret_migration_error = current_migration_error;
    if current_settings.is_none() {
        if let Some(settings) = legacy.settings {
            let mut parsed = serde_json::from_value::<StoredSettings>(settings.clone())
                .map_err(|error| error.to_string())?;
            match migrate_legacy_secrets(app, &settings, &parsed.llm_provider) {
                Ok(()) => {
                    mark_legacy_secret_status(&mut parsed, &settings);
                    save_settings_to_conn(&conn, &parsed)?;
                }
                Err(error) => secret_migration_error = Some(error),
            }
        }
    }

    if load_tasks_from_conn(&conn)?.is_empty() {
        if let Some(Value::Array(tasks)) = legacy.tasks {
            for task_value in tasks {
                let task = serde_json::from_value::<AnalysisTaskRecord>(task_value)
                    .map(normalize_task)
                    .map_err(|error| error.to_string())?;
                upsert_task(&conn, &task)?;
            }
        }
    }

    let (settings, database_migration_error) = load_settings_from_conn(app, &conn)?;
    if secret_migration_error.is_none() {
        secret_migration_error = database_migration_error;
    }
    Ok(DesktopSnapshot {
        settings: settings.map(public_settings),
        tasks: load_tasks_from_conn(&conn)?,
        secret_migration_error,
    })
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    initialize_schema(&conn)?;
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
            fs::copy(&legacy, &database).map_err(|error| {
                format!(
                    "Failed to copy the legacy desktop database from {}: {error}",
                    legacy.to_string_lossy()
                )
            })?;
            break;
        }
    }
    Ok(database)
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

fn initialize_schema(conn: &Connection) -> Result<(), String> {
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
    backfill_legacy_report_versions(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
        params![SCHEMA_VERSION],
    )
    .map_err(|error| error.to_string())?;
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
                    instrument_name, queued_at, queue_order, created_at, updated_at, decision, stats, agent_statuses, report_sections, error, origin, output_quality, evidence_bundle_sha256, evidence_validation, memory_bundle_sha256, memory_validation, readiness_assessment_sha256, readiness_validation
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
        validate_task_readiness(task)?;
        validate_memory_fields(
            task.memory_bundle.as_ref(),
            task.memory_validation.as_ref(),
            Some(&task.evaluation_reviews),
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
        "SELECT snapshot, evidence_bundle_sha256, memory_bundle_sha256,id,run_id,version_number,created_at,readiness_assessment_sha256 FROM task_report_versions WHERE task_id = ?1 ORDER BY version_number ASC",
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

fn upsert_task(conn: &Connection, task: &AnalysisTaskRecord) -> Result<(), String> {
    validate_task_readiness(task)?;
    validate_memory_fields(
        task.memory_bundle.as_ref(),
        task.memory_validation.as_ref(),
        Some(&task.evaluation_reviews),
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
            queued_at, queue_order, created_at, updated_at, decision, stats, agent_statuses, report_sections, error, output_quality, evidence_bundle_sha256, evidence_validation, memory_bundle_sha256, memory_validation, readiness_assessment_sha256, readiness_validation
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
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
            readiness_validation = excluded.readiness_validation",
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
            );
            let existing: Option<FrozenVersionRow> = conn.query_row("SELECT snapshot, evidence_bundle_sha256, memory_bundle_sha256,task_id,readiness_assessment_sha256 FROM task_report_versions WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(|error| error.to_string())?;
            if let Some((snapshot, hash, saved_memory_hash, saved_task, saved_readiness_hash)) =
                existing
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
                if saved != frozen
                    || hash != evidence_hash
                    || saved_memory_hash != memory_hash
                    || saved_readiness_hash != readiness_hash
                    || saved_task != task.id
                {
                    return Err("A frozen report version cannot be changed".into());
                }
            }
            conn.execute(
                "INSERT OR IGNORE INTO task_report_versions
                    (id, task_id, version_number, run_id, created_at, snapshot, evidence_bundle_sha256, memory_bundle_sha256, readiness_assessment_sha256)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
                ],
            )
            .map_err(|error| error.to_string())?;
            if let Some(reviews) = reviews {
                memory_store::append_reviews(conn, id, completion.as_ref(), &reviews)?;
            }
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

    fn evidence_task_fixture() -> (AnalysisTaskRecord, Value) {
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

    fn memory_task_fixture() -> (AnalysisTaskRecord, Value) {
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

    fn readiness_task_fixture() -> AnalysisTaskRecord {
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
            DELETE FROM schema_migrations WHERE version=8;
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
