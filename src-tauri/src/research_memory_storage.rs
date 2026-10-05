//! Validated, content-addressed mirrors. Python decision JSON remains authority.
use crate::research_memory as memory;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, String>;
fn sql<T>(value: rusqlite::Result<T>) -> Result<T> {
    value.map_err(|_| memory::ERROR.into())
}
fn ensure(valid: bool) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(memory::ERROR.into())
    }
}
fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| memory::ERROR.into())
}

pub fn initialize(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS research_memory_objects (
        sha256 TEXT PRIMARY KEY, kind TEXT NOT NULL, identity TEXT, metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_identity ON research_memory_objects(kind, identity);
    CREATE TABLE IF NOT EXISTS research_memory_links (
        parent_sha256 TEXT NOT NULL REFERENCES research_memory_objects(sha256) ON DELETE CASCADE,
        field TEXT NOT NULL, position INTEGER NOT NULL,
        child_sha256 TEXT NOT NULL REFERENCES research_memory_objects(sha256),
        PRIMARY KEY(parent_sha256, field, position)
    );
    CREATE TABLE IF NOT EXISTS report_memory_reviews (
        version_id TEXT NOT NULL REFERENCES task_report_versions(id) ON DELETE CASCADE,
        attachment_sha256 TEXT NOT NULL REFERENCES research_memory_objects(sha256),
        snapshot_sha256 TEXT NOT NULL REFERENCES research_memory_objects(sha256),
        PRIMARY KEY(version_id, attachment_sha256),
        UNIQUE(version_id, snapshot_sha256)
    );
    CREATE TABLE IF NOT EXISTS task_memory_reviews (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attachment_sha256 TEXT NOT NULL REFERENCES research_memory_objects(sha256),
        snapshot_sha256 TEXT NOT NULL REFERENCES research_memory_objects(sha256),
        PRIMARY KEY(task_id, attachment_sha256),
        UNIQUE(task_id, snapshot_sha256)
    );",
    ))
}

fn hash_key(kind: &str) -> Result<&'static str> {
    match kind {
        "artifact" => Ok("sha256"),
        "decision" => Ok("snapshot_sha256"),
        "context" => Ok("input_sha256"),
        "bundle" => Ok("bundle_sha256"),
        "review" => Ok("attachment_sha256"),
        _ => Err(memory::ERROR.into()),
    }
}
fn validate(kind: &str, value: &Value) -> Result<()> {
    match kind {
        "artifact" => memory::validate_artifact(value),
        "decision" => memory::validate_decision(value),
        "context" => memory::validate_context_snapshot(value),
        "bundle" => memory::validate_bundle(value),
        "review" => memory::validate_review_attachment(value, None),
        _ => Err(memory::ERROR.into()),
    }
}
fn store(conn: &Connection, kind: &str, value: &Value) -> Result<String> {
    validate(kind, value)?;
    let hash = string(&value[hash_key(kind)?])?.to_string();
    if kind == "bundle" {
        let mut query = sql(conn.prepare(
            "SELECT sha256 FROM research_memory_objects WHERE kind='bundle' AND identity=?1",
        ))?;
        let saved = sql(query.query_map(params![string(&value["run_id"])?], |row| {
            row.get::<_, String>(0)
        }))?;
        for saved in saved {
            ensure(sql(saved)? == hash)?;
        }
    }
    let mut metadata = value.as_object().ok_or(memory::ERROR)?.clone();
    let mut links: Vec<(String, i64, String)> = Vec::new();
    match kind {
        "bundle" => {
            for (field, child_kind) in [
                ("input_snapshot", "context"),
                ("decision_snapshot", "decision"),
            ] {
                let child = metadata.remove(field).ok_or(memory::ERROR)?;
                links.push((field.into(), 0, store(conn, child_kind, &child)?));
            }
        }
        "context" => {
            let artifact = metadata.remove("context_artifact").ok_or(memory::ERROR)?;
            links.push((
                "context_artifact".into(),
                0,
                store(conn, "artifact", &artifact)?,
            ));
            let decisions = metadata.remove("decisions").ok_or(memory::ERROR)?;
            for (index, decision) in decisions
                .as_array()
                .ok_or(memory::ERROR)?
                .iter()
                .enumerate()
            {
                links.push((
                    "decisions".into(),
                    index as i64,
                    store(conn, "decision", decision)?,
                ));
            }
        }
        "decision" => {
            let artifacts = metadata.remove("artifacts").ok_or(memory::ERROR)?;
            let map = artifacts.as_object().ok_or(memory::ERROR)?;
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                links.push((
                    "artifacts".into(),
                    index as i64,
                    store(conn, "artifact", &map[key])?,
                ));
            }
            // Different immutable snapshots of a decision can add settled facts,
            // but no saved non-null outcome/reflection may be contradicted.
            let mut query = sql(conn.prepare(
                "SELECT sha256 FROM research_memory_objects WHERE kind='decision' AND identity=?1",
            ))?;
            let existing = sql(query.query_map(params![string(&value["run_id"])?], |row| {
                row.get::<_, String>(0)
            }))?;
            for existing in existing {
                memory::merge_decision(&load(conn, &sql(existing)?, "decision")?, value)?;
            }
        }
        "review" => {
            let snapshot = metadata.remove("snapshot").ok_or(memory::ERROR)?;
            links.push(("snapshot".into(), 0, store(conn, "decision", &snapshot)?));
        }
        _ => {}
    }
    links.sort();
    let metadata = memory::canonical_json(&Value::Object(metadata))?;
    let identity = if kind == "decision" || kind == "bundle" {
        Some(string(&value["run_id"])?)
    } else {
        None
    };
    let existing: Option<(String, Option<String>, String)> = sql(conn
        .query_row(
            "SELECT kind,identity,metadata FROM research_memory_objects WHERE sha256=?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional())?;
    if let Some((saved_kind, saved_identity, saved_metadata)) = existing {
        ensure(
            saved_kind == kind
                && saved_identity.as_deref() == identity
                && saved_metadata == metadata,
        )?;
        ensure(load_links(conn, &hash)? == links)?;
    } else {
        sql(conn.execute("INSERT INTO research_memory_objects(sha256,kind,identity,metadata) VALUES(?1,?2,?3,?4)", params![hash,kind,identity,metadata]))?;
        for (field, position, child) in links {
            sql(conn.execute("INSERT INTO research_memory_links(parent_sha256,field,position,child_sha256) VALUES(?1,?2,?3,?4)", params![hash,field,position,child]))?;
        }
    }
    Ok(hash)
}
fn load_links(conn: &Connection, hash: &str) -> Result<Vec<(String, i64, String)>> {
    let mut query = sql(conn.prepare("SELECT field,position,child_sha256 FROM research_memory_links WHERE parent_sha256=?1 ORDER BY field,position,child_sha256"))?;
    let rows = sql(query.query_map(params![hash], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }))?;
    sql(rows.collect())
}
fn load(conn: &Connection, hash: &str, kind: &str) -> Result<Value> {
    load_inner(conn, hash, kind, &mut BTreeSet::new())
}
fn load_inner(
    conn: &Connection,
    hash: &str,
    kind: &str,
    visited: &mut BTreeSet<String>,
) -> Result<Value> {
    ensure(visited.len() <= 8 && visited.insert(hash.into()))?;
    let (saved_kind, identity, raw): (String, Option<String>, String) = sql(conn.query_row(
        "SELECT kind,identity,metadata FROM research_memory_objects WHERE sha256=?1",
        params![hash],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ))?;
    ensure(saved_kind == kind)?;
    let mut value = memory::parse_json(&raw)?;
    ensure(value.is_object())?;
    if kind == "decision" || kind == "bundle" {
        ensure(identity.as_deref() == Some(string(&value["run_id"])?))?;
    } else {
        ensure(identity.is_none())?;
    }
    let mut artifacts = Map::new();
    let mut decisions = Vec::new();
    let mut fields = BTreeSet::new();
    for (field, position, child_hash) in load_links(conn, hash)? {
        let child_kind = match (kind, field.as_str()) {
            ("bundle", "input_snapshot") => "context",
            ("bundle", "decision_snapshot") => "decision",
            ("context", "context_artifact") | ("decision", "artifacts") => "artifact",
            ("context", "decisions") | ("review", "snapshot") => "decision",
            _ => return Err(memory::ERROR.into()),
        };
        let child = load_inner(conn, &child_hash, child_kind, visited)?;
        match field.as_str() {
            "artifacts" => {
                ensure(
                    position == artifacts.len() as i64
                        && artifacts.insert(child_hash, child).is_none(),
                )?;
            }
            "decisions" => {
                ensure(position == decisions.len() as i64)?;
                decisions.push(child);
            }
            _ => {
                ensure(
                    position == 0 && fields.insert(field.clone()) && value.get(&field).is_none(),
                )?;
                value
                    .as_object_mut()
                    .ok_or(memory::ERROR)?
                    .insert(field, child);
            }
        }
    }
    if kind == "decision" {
        ensure(value.get("artifacts").is_none())?;
        value["artifacts"] = Value::Object(artifacts);
    }
    if kind == "context" {
        ensure(value.get("decisions").is_none())?;
        value["decisions"] = Value::Array(decisions);
    }
    validate(kind, &value)?;
    ensure(value[hash_key(kind)?] == hash)?;
    visited.remove(hash);
    Ok(value)
}
pub fn store_bundle(conn: &Connection, value: &Value) -> Result<String> {
    store(conn, "bundle", value)
}
pub fn load_bundle(conn: &Connection, hash: &str) -> Result<Value> {
    load(conn, hash, "bundle")
}

pub fn load_reviews(
    conn: &Connection,
    version_id: &str,
    completion: Option<&Value>,
) -> Result<Value> {
    load_reviews_for(conn, version_id, completion, false)
}
pub fn load_task_reviews(
    conn: &Connection,
    task_id: &str,
    completion: Option<&Value>,
) -> Result<Value> {
    load_reviews_for(conn, task_id, completion, true)
}
fn load_reviews_for(
    conn: &Connection,
    owner: &str,
    completion: Option<&Value>,
    task: bool,
) -> Result<Value> {
    let query = if task {
        "SELECT attachment_sha256,snapshot_sha256 FROM task_memory_reviews WHERE task_id=?1 ORDER BY attachment_sha256"
    } else {
        "SELECT attachment_sha256,snapshot_sha256 FROM report_memory_reviews WHERE version_id=?1 ORDER BY attachment_sha256"
    };
    let mut query = sql(conn.prepare(query))?;
    let hashes = sql(query.query_map(params![owner], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }))?;
    let mut reviews = Vec::new();
    let mut seen = BTreeSet::new();
    for hash in hashes {
        let (hash, snapshot_hash) = sql(hash)?;
        let review = load(conn, &hash, "review")?;
        ensure(
            review["snapshot"]["snapshot_sha256"] == snapshot_hash && seen.insert(snapshot_hash),
        )?;
        memory::validate_review_attachment(&review, Some(completion.ok_or(memory::ERROR)?))?;
        reviews.push(review);
    }
    reviews.sort_by(|first, second| {
        memory::timestamp(&first["reviewed_at"])
            .unwrap_or(0)
            .cmp(&memory::timestamp(&second["reviewed_at"]).unwrap_or(0))
            .then_with(|| {
                string(&first["attachment_sha256"])
                    .unwrap_or_default()
                    .cmp(string(&second["attachment_sha256"]).unwrap_or_default())
            })
    });
    for pair in reviews.windows(2) {
        check_review_progression(&pair[0], &pair[1])?;
    }
    Ok(Value::Array(reviews))
}
fn check_review_progression(first: &Value, second: &Value) -> Result<()> {
    memory::merge_decision(&first["snapshot"], &second["snapshot"])?;
    let (earlier, later) = if memory::timestamp(&first["reviewed_at"])?
        <= memory::timestamp(&second["reviewed_at"])?
    {
        (first, second)
    } else {
        (second, first)
    };
    for key in ["outcome", "reflection"] {
        ensure(
            earlier["snapshot"][key].is_null()
                || earlier["snapshot"][key] == later["snapshot"][key],
        )?;
    }
    if memory::timestamp(&first["reviewed_at"])? == memory::timestamp(&second["reviewed_at"])? {
        ensure(first["snapshot"] == second["snapshot"])?;
    }
    Ok(())
}
pub fn append_reviews(
    conn: &Connection,
    version_id: &str,
    completion: Option<&Value>,
    reviews: &Value,
) -> Result<()> {
    append_reviews_for(conn, version_id, completion, reviews, false)
}
pub fn append_task_reviews(
    conn: &Connection,
    task_id: &str,
    completion: Option<&Value>,
    reviews: &Value,
) -> Result<()> {
    append_reviews_for(conn, task_id, completion, reviews, true)
}
pub fn clear_task_reviews(conn: &Connection, task_id: &str) -> Result<()> {
    sql(conn.execute(
        "DELETE FROM task_memory_reviews WHERE task_id=?1",
        params![task_id],
    ))
    .map(|_| ())
}
fn append_reviews_for(
    conn: &Connection,
    owner: &str,
    completion: Option<&Value>,
    reviews: &Value,
    task: bool,
) -> Result<()> {
    let incoming = reviews.as_array().ok_or(memory::ERROR)?;
    if incoming.is_empty() {
        return Ok(());
    }
    let completion = completion.ok_or(memory::ERROR)?;
    let existing = load_reviews_for(conn, owner, Some(completion), task)?;
    let mut snapshots: BTreeSet<String> = existing
        .as_array()
        .ok_or(memory::ERROR)?
        .iter()
        .map(|review| string(&review["snapshot"]["snapshot_sha256"]).map(str::to_owned))
        .collect::<Result<_>>()?;
    let mut accepted: Vec<&Value> = existing.as_array().ok_or(memory::ERROR)?.iter().collect();
    for review in incoming {
        memory::validate_review_attachment(review, Some(completion))?;
        let snapshot_hash = string(&review["snapshot"]["snapshot_sha256"])?;
        if !snapshots.insert(snapshot_hash.into()) {
            continue;
        }
        for previous in &accepted {
            check_review_progression(previous, review)?;
        }
        let hash = store(conn, "review", review)?;
        let query = if task {
            "INSERT INTO task_memory_reviews(task_id,attachment_sha256,snapshot_sha256) VALUES(?1,?2,?3)"
        } else {
            "INSERT INTO report_memory_reviews(version_id,attachment_sha256,snapshot_sha256) VALUES(?1,?2,?3)"
        };
        sql(conn.execute(query, params![owner, hash, snapshot_hash]))?;
        accepted.push(review);
    }
    Ok(())
}

pub fn clear(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("DELETE FROM task_memory_reviews; DELETE FROM report_memory_reviews; DELETE FROM research_memory_links; DELETE FROM research_memory_objects;"))
}
pub fn prune(conn: &Connection) -> Result<()> {
    // Traverse immutable references so a source shared by a frozen input and a
    // later review survives until every task/version/review reference is gone.
    sql(conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS retained_memory_hashes(sha256 TEXT PRIMARY KEY);
        DELETE FROM retained_memory_hashes;
        INSERT INTO retained_memory_hashes WITH RECURSIVE retained(sha256) AS (
            SELECT memory_bundle_sha256 FROM tasks WHERE memory_bundle_sha256 IS NOT NULL
            UNION SELECT memory_bundle_sha256 FROM task_report_versions WHERE memory_bundle_sha256 IS NOT NULL
            UNION SELECT attachment_sha256 FROM report_memory_reviews
            UNION SELECT attachment_sha256 FROM task_memory_reviews
            UNION SELECT link.child_sha256 FROM research_memory_links link JOIN retained ON link.parent_sha256=retained.sha256
        ) SELECT sha256 FROM retained;
        DELETE FROM research_memory_links WHERE parent_sha256 NOT IN (SELECT sha256 FROM retained_memory_hashes);
        DELETE FROM research_memory_objects WHERE sha256 NOT IN (SELECT sha256 FROM retained_memory_hashes);
        DROP TABLE retained_memory_hashes;"))
}
