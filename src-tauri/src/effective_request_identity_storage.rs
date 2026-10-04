//! Immutable, content-addressed outer-request assessments shared by run owners.
use crate::{effective_request_identity as identity, research_memory as memory};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
type Result<T> = std::result::Result<T, String>;
fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| identity::ERROR.into())
}

pub fn initialize(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS effective_request_identity_receipts (
          assessment_sha256 TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE,
          snapshot_sha256 TEXT NOT NULL, payload TEXT NOT NULL
        );",
    ))
}
pub fn store(
    conn: &Connection,
    value: &Value,
    evidence: &Value,
    snapshot: &Value,
) -> Result<String> {
    identity::validate_receipt(value, evidence, snapshot)?;
    let hash = value["assessment_sha256"].as_str().ok_or(identity::ERROR)?;
    let run_id = value["run_id"].as_str().ok_or(identity::ERROR)?;
    let snapshot_hash = value["report_snapshot_sha256"]
        .as_str()
        .ok_or(identity::ERROR)?;
    let payload = memory::canonical_json(value).map_err(|_| identity::ERROR)?;
    let saved: Option<(String, String, String)> = sql(conn.query_row(
        "SELECT assessment_sha256,snapshot_sha256,payload FROM effective_request_identity_receipts WHERE run_id=?1",
        params![run_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).optional())?;
    if saved.is_some_and(|(saved_hash, saved_snapshot, saved_payload)| {
        saved_hash != hash || saved_snapshot != snapshot_hash || saved_payload != payload
    }) {
        return Err(identity::ERROR.into());
    }
    sql(conn.execute("INSERT OR IGNORE INTO effective_request_identity_receipts(assessment_sha256,run_id,snapshot_sha256,payload) VALUES (?1,?2,?3,?4)",params![hash,run_id,snapshot_hash,payload]))?;
    if load(conn, hash, evidence, snapshot)? != *value {
        return Err(identity::ERROR.into());
    }
    Ok(hash.into())
}
pub fn load(conn: &Connection, hash: &str, evidence: &Value, snapshot: &Value) -> Result<Value> {
    let (run_id,snapshot_hash,raw): (String,String,String) = sql(conn.query_row(
        "SELECT run_id,snapshot_sha256,payload FROM effective_request_identity_receipts WHERE assessment_sha256=?1",
        params![hash], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ))?;
    let value = memory::parse_json(&raw).map_err(|_| identity::ERROR)?;
    identity::validate_receipt(&value, evidence, snapshot)?;
    if value["assessment_sha256"] != hash
        || value["run_id"] != run_id
        || value["report_snapshot_sha256"] != snapshot_hash
    {
        return Err(identity::ERROR.into());
    }
    Ok(value)
}
pub fn prune(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM effective_request_identity_receipts WHERE assessment_sha256 NOT IN (
      SELECT identity_assessment_sha256 FROM tasks WHERE identity_assessment_sha256 IS NOT NULL
      UNION SELECT identity_assessment_sha256 FROM task_report_versions WHERE identity_assessment_sha256 IS NOT NULL
    );"))
}
pub fn clear(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM effective_request_identity_receipts;"))
}
