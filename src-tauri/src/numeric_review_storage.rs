//! Content-addressed report text and append-only per-version review histories.
use crate::{numeric_review as numeric, research_memory as memory};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
type Result<T> = std::result::Result<T, String>;
fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| numeric::ERROR.into())
}

pub fn initialize(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("CREATE TABLE IF NOT EXISTS numeric_report_snapshots (
        snapshot_sha256 TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS numeric_review_receipts (
        review_sha256 TEXT PRIMARY KEY, review_id TEXT NOT NULL UNIQUE,
        snapshot_sha256 TEXT NOT NULL REFERENCES numeric_report_snapshots(snapshot_sha256), payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_numeric_reviews (
        version_id TEXT NOT NULL REFERENCES task_report_versions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, review_sha256 TEXT NOT NULL REFERENCES numeric_review_receipts(review_sha256),
        PRIMARY KEY(version_id,position), UNIQUE(version_id,review_sha256)
    );"))
}

pub fn store_snapshot(conn: &Connection, value: &Value, evidence: &Value) -> Result<String> {
    numeric::validate_snapshot(value, evidence)?;
    let hash = value["snapshot_sha256"].as_str().ok_or(numeric::ERROR)?;
    let run = value["run_id"].as_str().ok_or(numeric::ERROR)?;
    let payload = memory::canonical_json(value).map_err(|_| numeric::ERROR)?;
    let saved: Option<(String, String)> = sql(conn
        .query_row(
            "SELECT snapshot_sha256,payload FROM numeric_report_snapshots WHERE run_id=?1",
            params![run],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())?;
    if saved
        .is_some_and(|(saved_hash, saved_payload)| saved_hash != hash || saved_payload != payload)
    {
        return Err(numeric::ERROR.into());
    }
    sql(conn.execute("INSERT OR IGNORE INTO numeric_report_snapshots(snapshot_sha256,run_id,payload) VALUES (?1,?2,?3)",params![hash,run,payload]))?;
    if load_snapshot(conn, hash, evidence)? != *value {
        return Err(numeric::ERROR.into());
    }
    Ok(hash.into())
}

pub fn load_snapshot(conn: &Connection, hash: &str, evidence: &Value) -> Result<Value> {
    let (run, raw): (String, String) = sql(conn.query_row(
        "SELECT run_id,payload FROM numeric_report_snapshots WHERE snapshot_sha256=?1",
        params![hash],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ))?;
    let value = memory::parse_json(&raw).map_err(|_| numeric::ERROR)?;
    numeric::validate_snapshot(&value, evidence)?;
    if value["run_id"] != run || value["snapshot_sha256"] != hash {
        return Err(numeric::ERROR.into());
    }
    Ok(value)
}

pub fn load_reviews(
    conn: &Connection,
    task_id: &str,
    version_id: &str,
    snapshot: Option<&Value>,
    evidence: Option<&Value>,
) -> Result<Value> {
    // Keep broken links visible. An inner join would silently truncate history
    // if a receipt were removed while external SQLite foreign keys were off.
    let mut statement = sql(conn.prepare("SELECT r.position,r.review_sha256,n.review_id,n.snapshot_sha256,n.payload FROM report_numeric_reviews r LEFT JOIN numeric_review_receipts n ON n.review_sha256=r.review_sha256 WHERE r.version_id=?1 ORDER BY r.position ASC"))?;
    let rows = sql(statement.query_map(params![version_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    }))?;
    let mut reviews = Vec::new();
    for row in rows {
        let (position, hash, id, snapshot_hash, raw) = sql(row)?;
        let review = memory::parse_json(&raw).map_err(|_| numeric::ERROR)?;
        if position != reviews.len() as i64
            || review["review_sha256"] != hash
            || review["review_id"] != id
            || snapshot.ok_or(numeric::ERROR)?["snapshot_sha256"] != snapshot_hash
        {
            return Err(numeric::ERROR.into());
        }
        reviews.push(review);
    }
    let reviews = Value::Array(reviews);
    numeric::validate_reviews(&reviews, snapshot, evidence, task_id, version_id)?;
    Ok(reviews)
}

pub fn append_reviews(
    conn: &Connection,
    task_id: &str,
    version_id: &str,
    snapshot: Option<&Value>,
    evidence: Option<&Value>,
    incoming: &Value,
) -> Result<()> {
    numeric::validate_reviews(incoming, snapshot, evidence, task_id, version_id)?;
    let saved = load_reviews(conn, task_id, version_id, snapshot, evidence)?;
    let saved = saved.as_array().ok_or(numeric::ERROR)?;
    let incoming = incoming.as_array().ok_or(numeric::ERROR)?;
    if incoming.len() < saved.len() || incoming[..saved.len()] != *saved {
        return Err(numeric::ERROR.into());
    }
    for (position, review) in incoming.iter().enumerate().skip(saved.len()) {
        let hash = review["review_sha256"].as_str().ok_or(numeric::ERROR)?;
        let id = review["review_id"].as_str().ok_or(numeric::ERROR)?;
        let snapshot_hash = snapshot.ok_or(numeric::ERROR)?["snapshot_sha256"]
            .as_str()
            .ok_or(numeric::ERROR)?;
        let payload = memory::canonical_json(review).map_err(|_| numeric::ERROR)?;
        let existing: Option<(String,String,String)> = sql(conn.query_row("SELECT review_sha256,snapshot_sha256,payload FROM numeric_review_receipts WHERE review_id=?1 OR review_sha256=?2",params![id,hash],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional())?;
        if existing.is_some_and(|(saved_hash, saved_snapshot, saved_payload)| {
            saved_hash != hash || saved_snapshot != snapshot_hash || saved_payload != payload
        }) {
            return Err(numeric::ERROR.into());
        }
        sql(conn.execute("INSERT OR IGNORE INTO numeric_review_receipts(review_sha256,review_id,snapshot_sha256,payload) VALUES (?1,?2,?3,?4)",params![hash,id,snapshot_hash,payload]))?;
        sql(conn.execute("INSERT INTO report_numeric_reviews(version_id,position,review_sha256) VALUES (?1,?2,?3)",params![version_id,position as i64,hash]))?;
    }
    // Recheck referenced bodies, including rows whose insert was ignored.
    if load_reviews(conn, task_id, version_id, snapshot, evidence)?
        != Value::Array(incoming.clone())
    {
        return Err(numeric::ERROR.into());
    }
    Ok(())
}

pub fn prune(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM numeric_review_receipts WHERE review_sha256 NOT IN (SELECT review_sha256 FROM report_numeric_reviews);
        DELETE FROM numeric_report_snapshots WHERE snapshot_sha256 NOT IN (
        SELECT numeric_snapshot_sha256 FROM tasks WHERE numeric_snapshot_sha256 IS NOT NULL
        UNION SELECT numeric_snapshot_sha256 FROM task_report_versions WHERE numeric_snapshot_sha256 IS NOT NULL
        UNION SELECT snapshot_sha256 FROM numeric_review_receipts);"))
}
pub fn clear(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM report_numeric_reviews; DELETE FROM numeric_review_receipts; DELETE FROM numeric_report_snapshots;"))
}
