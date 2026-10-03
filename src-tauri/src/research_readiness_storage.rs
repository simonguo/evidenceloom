//! A run UUID has one immutable assessment; task/version owners share its copy.
use crate::{research_memory as memory, research_readiness as readiness};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
type Result<T> = std::result::Result<T, String>;
fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| readiness::ERROR.into())
}

pub fn initialize(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS research_readiness_receipts (
        assessment_sha256 TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    );",
    ))
}
pub fn store(conn: &Connection, value: &Value, evidence: &Value) -> Result<String> {
    readiness::validate_receipt(value, evidence)?;
    let hash = value["assessment_sha256"]
        .as_str()
        .ok_or(readiness::ERROR)?;
    let run_id = value["run_id"].as_str().ok_or(readiness::ERROR)?;
    let payload = memory::canonical_json(value).map_err(|_| readiness::ERROR)?;
    let saved: Option<(String, String)> = sql(conn
        .query_row(
            "SELECT assessment_sha256,payload FROM research_readiness_receipts WHERE run_id=?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())?;
    if saved
        .is_some_and(|(saved_hash, saved_payload)| saved_hash != hash || saved_payload != payload)
    {
        return Err(readiness::ERROR.into());
    }
    sql(conn.execute("INSERT OR IGNORE INTO research_readiness_receipts(assessment_sha256,run_id,payload) VALUES (?1,?2,?3)", params![hash,run_id,payload]))?;
    // A corrupt hash row must never be hidden by INSERT OR IGNORE.
    if load(conn, hash, evidence)? != *value {
        return Err(readiness::ERROR.into());
    }
    Ok(hash.into())
}
pub fn load(conn: &Connection, hash: &str, evidence: &Value) -> Result<Value> {
    let (run_id, raw): (String, String) = sql(conn.query_row(
        "SELECT run_id,payload FROM research_readiness_receipts WHERE assessment_sha256=?1",
        params![hash],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ))?;
    let value = memory::parse_json(&raw).map_err(|_| readiness::ERROR)?;
    readiness::validate_receipt(&value, evidence)?;
    if value["assessment_sha256"] != hash || value["run_id"] != run_id {
        return Err(readiness::ERROR.into());
    }
    Ok(value)
}
pub fn prune(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM research_readiness_receipts WHERE assessment_sha256 NOT IN (
        SELECT readiness_assessment_sha256 FROM tasks WHERE readiness_assessment_sha256 IS NOT NULL
        UNION SELECT readiness_assessment_sha256 FROM task_report_versions WHERE readiness_assessment_sha256 IS NOT NULL
    );"))
}
pub fn clear(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM research_readiness_receipts;"))
}
