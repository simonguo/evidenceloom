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

use crate::secrets;

const SCHEMA_VERSION: i64 = 3;
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    #[serde(flatten)]
    pub settings: StoredSettings,
    pub provider_configured: bool,
    pub alpha_vantage_configured: bool,
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
        settings: settings.map(public_settings).transpose()?,
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
    let conn = open_database(app)?;
    upsert_task(&conn, &normalize_task(task))
}

pub fn delete_task(app: &AppHandle, task_id: String) -> Result<(), String> {
    let conn = open_database(app)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clear_data(app: &AppHandle) -> Result<(), String> {
    let conn = open_database(app)?;
    let current_provider = load_settings_from_conn(app, &conn)?
        .0
        .map(|settings| settings.llm_provider);
    secrets::delete_all_secrets(current_provider.as_deref())?;
    conn.execute_batch(
        "DELETE FROM task_reports;
         DELETE FROM task_logs;
         DELETE FROM tasks;
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
            let parsed = serde_json::from_value::<StoredSettings>(settings.clone())
                .map_err(|error| error.to_string())?;
            match migrate_legacy_secrets(app, &settings, &parsed.llm_provider) {
                Ok(()) => save_settings_to_conn(&conn, &parsed)?,
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
        settings: settings.map(public_settings).transpose()?,
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
         CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);",
    )
    .map_err(|error| error.to_string())?;
    ensure_column(conn, "tasks", "instrument_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tasks", "queued_at", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tasks", "queue_order", "INTEGER")?;
    ensure_column(conn, "task_logs", "agent", "TEXT")?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
        params![SCHEMA_VERSION],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
    let settings = serde_json::from_value::<StoredSettings>(value.clone())
        .map_err(|error| error.to_string())?;
    if !contains_legacy_secrets(&value) {
        return Ok((Some(settings), None));
    }

    match migrate_legacy_secrets(app, &value, &settings.llm_provider) {
        Ok(()) => {
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

fn public_settings(settings: StoredSettings) -> Result<PublicSettings, String> {
    let status = secrets::status(&settings.llm_provider)?;
    Ok(PublicSettings {
        settings,
        provider_configured: status.provider_configured,
        alpha_vantage_configured: status.alpha_vantage_configured,
    })
}

fn load_tasks_from_conn(conn: &Connection) -> Result<Vec<AnalysisTaskRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ticker, analysis_date, asset_type, research_depth, analysts, output_language, status,
                    instrument_name, queued_at, queue_order, created_at, updated_at, decision, stats, agent_statuses, report_sections, error
             FROM tasks ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let task_id: String = row.get(0)?;
            let report_sections = load_report_sections(conn, &task_id)?;
            let logs = load_logs(conn, &task_id)?;
            Ok(AnalysisTaskRecord {
                id: task_id,
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
                logs,
                error: row.get(17)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
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

fn upsert_task(conn: &Connection, task: &AnalysisTaskRecord) -> Result<(), String> {
    conn.execute(
        "INSERT INTO tasks (
            id, ticker, instrument_name, analysis_date, asset_type, research_depth, analysts, output_language, status,
            queued_at, queue_order, created_at, updated_at, decision, stats, agent_statuses, report_sections, error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
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
            error = excluded.error",
        params![
            task.id,
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
        ],
    )
    .map_err(|error| error.to_string())?;

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

    Ok(())
}

fn contains_legacy_secrets(value: &Value) -> bool {
    value.get("apiKey").is_some() || value.get("alphaVantageApiKey").is_some()
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
}
