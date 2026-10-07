use super::*;
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};

fn db(pristine: bool) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema_with_origin(&conn, pristine).unwrap();
    conn
}

fn task(id: &str) -> Value {
    json!({"id":id,"ticker":"FICTION","analysisDate":"2026-01-02","assetType":"stock",
        "researchDepth":1,"analysts":[],"outputLanguage":"en","status":"pending",
        "createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z",
        "decision":"","stats":{},"agentStatuses":{},"reportSections":{},"logs":[],"error":""})
}

fn absent(id: &str) -> TaskHead {
    TaskHead {
        task_id: id.into(),
        generation: "0".into(),
        revision: "0".into(),
        state: "never_seen".into(),
    }
}

fn request(
    conn: &Connection,
    id: &str,
    op: &str,
    head: Option<&TaskHead>,
    body: Option<Value>,
) -> Value {
    let mut value = json!({"protocolVersion":1,"requestId":id,"collection":current(conn).unwrap().collection,"operation":op});
    if let Some(head) = head {
        value["expectedHead"] = json!(head);
    }
    if let Some(body) = body {
        value["task"] = body;
    }
    value
}

fn packet(value: Value) -> Packet {
    parse(
        value,
        &["create", "recreate", "update", "delete", "import", "clear"],
    )
    .unwrap()
}
fn head(conn: &Connection, id: &str) -> TaskHead {
    current(conn)
        .unwrap()
        .heads
        .into_iter()
        .find(|h| h.task_id == id)
        .unwrap()
}
fn create(conn: &Connection, id: &str) -> TaskHead {
    execute(
        conn,
        &packet(request(
            conn,
            &format!("create-{id}-{}", current(conn).unwrap().collection.epoch),
            "create",
            Some(&absent(id)),
            Some(task(id)),
        )),
    )
    .unwrap();
    head(conn, id)
}
fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn fixture_directory(label: &str) -> PathBuf {
    let root = std::env::var_os("EVIDENCELOOM_TASK_FENCE_FIXTURE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/task-mutation-fixtures")
        });
    fs::create_dir_all(&root).unwrap();
    let sequence = COPY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let directory = root.join(format!("{label}-{}-{sequence}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    directory
}

fn file_database(path: &std::path::Path, pristine: bool) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    initialize_schema_with_origin(&conn, pristine).unwrap();
    conn
}

#[test]
fn task_mutation_legacy_copy_includes_committed_wal_and_never_overwrites_target() {
    let directory = fixture_directory("legacy-copy");
    let source = directory.join("legacy.db");
    let target = directory.join("current.db");
    let legacy = Connection::open(&source).unwrap();
    initialize_tables(&legacy).unwrap();
    legacy
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let (task, _) = crate::storage::tests::evidence_task_fixture();
    upsert_task(&legacy, &task).unwrap();
    legacy
        .execute("INSERT INTO schema_migrations(version) VALUES(10)", [])
        .unwrap();
    assert!(directory.join("legacy.db-wal").is_file());
    copy_legacy_database(&source, &target).unwrap();
    let copied = file_database(&target, false);
    let snapshot = snapshot_from_conn(&copied, None, None).unwrap();
    assert_eq!(snapshot.tasks[0].report_sections, task.report_sections);
    assert_eq!(snapshot.tasks[0].report_versions, task.report_versions);
    assert!(!snapshot.storage.legacy_task_import_allowed);
    let authority = current(&copied).unwrap().collection;
    let another = directory.join("another.db");
    let another_db = file_database(&another, true);
    create(&another_db, "another");
    drop(another_db);
    copy_legacy_database(&another, &target).unwrap();
    assert_eq!(current(&copied).unwrap().collection, authority);
    assert_eq!(load_tasks_from_conn(&copied).unwrap()[0].id, task.id);
    assert!(!fs::read_dir(&directory).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".evidenceloom-copy-")));
}

#[test]
fn task_mutation_failed_legacy_copy_removes_only_owned_temporary_file() {
    let directory = fixture_directory("failed-copy");
    let invalid = directory.join("invalid.db");
    let target = directory.join("current.db");
    fs::write(&invalid, b"fictional invalid database").unwrap();
    assert!(copy_legacy_database(&invalid, &target).is_err());
    assert!(!target.exists());
    assert_eq!(fs::read(&invalid).unwrap(), b"fictional invalid database");
    assert!(!fs::read_dir(&directory).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".evidenceloom-copy-")));
}

#[test]
fn task_mutation_copy_of_pristine_schema_rotates_collection_and_closes_import_without_changing_source(
) {
    let directory = fixture_directory("schema-eleven-copy");
    let source = directory.join("source.db");
    let target = directory.join("copied.db");
    let original = file_database(&source, true);
    assert!(
        snapshot_storage(&original, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
    let identity = current(&original).unwrap().collection;
    copy_legacy_database(&source, &target).unwrap();
    let copied = file_database(&target, false);
    assert_ne!(current(&copied).unwrap().collection, identity);
    assert_eq!(current(&original).unwrap().collection, identity);
    assert!(
        !snapshot_storage(&copied, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
    assert!(
        snapshot_storage(&original, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
}

#[test]
fn task_mutation_sql_clear_failure_rolls_back_all_attachments_and_original_pending_never_replays() {
    let conn = db(true);
    let (task, _) = crate::storage::tests::evidence_task_fixture();
    execute(
        &conn,
        &packet(request(
            &conn,
            "full-task",
            "create",
            Some(&absent(&task.id)),
            Some(json!(task)),
        )),
    )
    .unwrap();
    let original = head(&conn, &task.id);
    let artifacts = count(&conn, "evidence_artifacts");
    conn.execute_batch("CREATE TRIGGER no_clear BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'owned private failure marker'); END;").unwrap();
    let pending = packet(request(&conn, "failed-sql-clear", "clear", None, None));
    let calls = AtomicUsize::new(0);
    assert_eq!(
        clear(&conn, &pending, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err()
        .code,
        "storage_partial_clear"
    );
    assert_eq!(head(&conn, &task.id), original);
    assert_eq!(count(&conn, "evidence_artifacts"), artifacts);
    assert_eq!(
        load_tasks_from_conn(&conn).unwrap()[0].report_versions,
        task.report_versions
    );
    let queried = query(&conn, &pending).unwrap();
    assert!(queried.receipt.is_none() && queried.rejection.is_none());
    assert_eq!(
        clear(&conn, &pending, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err()
        .code,
        "storage_unknown_outcome"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn task_mutation_corrupt_counter_or_mismatched_live_body_cannot_grant_authority() {
    let conn = db(true);
    create(&conn, "a");
    conn.execute("DELETE FROM tasks", []).unwrap();
    assert_eq!(current(&conn).unwrap_err().code, "storage_unavailable");
    let conn = db(true);
    conn.execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE task_store_metadata SET epoch=9223372036854775808;").unwrap();
    assert_eq!(current(&conn).unwrap_err().code, "storage_unavailable");
}

#[test]
fn task_mutation_wrong_native_entrypoint_rejects_before_effects() {
    let conn = db(true);
    let clearing = packet(request(&conn, "clear", "clear", None, None));
    assert_eq!(
        execute(&conn, &clearing).unwrap_err().code,
        "storage_invalid_request"
    );
    let creating = packet(request(
        &conn,
        "create",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    ));
    let calls = AtomicUsize::new(0);
    assert_eq!(
        clear(&conn, &creating, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err()
        .code,
        "storage_invalid_request"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(count(&conn, "task_mutation_requests"), 0);
}

#[test]
fn task_mutation_concurrent_database_initialization_issues_one_identity() {
    let directory = fixture_directory("concurrent-open");
    let path = directory.join("current.db");
    let gate = Arc::new(std::sync::Barrier::new(3));
    let mut workers = vec![];
    for _ in 0..2 {
        let path = path.clone();
        let gate = gate.clone();
        workers.push(thread::spawn(move || {
            let db = Connection::open(path).unwrap();
            db.busy_timeout(Duration::from_secs(5)).unwrap();
            gate.wait();
            initialize_schema_with_origin(&db, true).map_err(StorageError::unavailable)?;
            current(&db)
        }));
    }
    gate.wait();
    let outcomes: Vec<_> = workers.into_iter().map(|worker| worker.join()).collect();
    let first = outcomes[0].as_ref().unwrap().as_ref().unwrap();
    let second = outcomes[1].as_ref().unwrap().as_ref().unwrap();
    assert_eq!(first.collection, second.collection);
    let db = file_database(&path, false);
    assert_eq!(count(&db, "task_store_metadata"), 1);
    assert_eq!(count(&db, "task_store_heads"), 0);
}

#[test]
fn task_mutation_clear_holds_coordinator_across_external_gap_and_late_writer_cannot_enter() {
    let directory = fixture_directory("clear-gap");
    let path = directory.join("current.db");
    let db = file_database(&path, true);
    create(&db, "a");
    let late = request(
        &db,
        "late-writer",
        "update",
        Some(&head(&db, "a")),
        Some(task("a")),
    );
    let clearing = packet(request(&db, "clearing", "clear", None, None));
    drop(db);
    let (inside, entered) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let clear_path = path.clone();
    let clear_worker = thread::spawn(move || {
        let _coordinator = coordinator();
        let db = Connection::open(clear_path).unwrap();
        clear(&db, &clearing, || {
            inside.send(()).map_err(|_| "fixture receiver closed")?;
            gate.recv_timeout(Duration::from_secs(5))
                .map_err(|_| "fixture external gate timed out")?;
            Ok(())
        })
    });
    let entered_result = entered.recv_timeout(Duration::from_secs(2));
    let (attempted, attempt) = mpsc::channel();
    let (admitted, admit) = mpsc::channel();
    let writer_path = path.clone();
    let writer = thread::spawn(move || {
        attempted.send(()).unwrap();
        let _coordinator = coordinator();
        admitted.send(()).unwrap();
        let db = Connection::open(writer_path).unwrap();
        execute(&db, &packet(late))
    });
    let attempted_result = attempt.recv_timeout(Duration::from_secs(2));
    let before = admit.recv_timeout(Duration::from_millis(100));
    let _ = release.send(());
    let clear_result = clear_worker.join();
    let writer_result = writer.join();
    assert!(entered_result.is_ok());
    assert!(attempted_result.is_ok());
    assert!(before.is_err());
    assert_eq!(clear_result.unwrap().unwrap().scope, "desktop_clear");
    assert_eq!(writer_result.unwrap().unwrap_err().code, "storage_conflict");
    let db = file_database(&path, false);
    assert_eq!(count(&db, "tasks"), 0);
    assert_eq!(current(&db).unwrap().collection.epoch, "1");
}

#[test]
fn task_mutation_snapshot_transaction_observes_task_and_head_at_one_cut() {
    let directory = fixture_directory("snapshot-cut");
    let path = directory.join("current.db");
    let db = file_database(&path, true);
    create(&db, "a");
    drop(db);
    let gate = Arc::new(std::sync::Barrier::new(2));
    let writer_gate = gate.clone();
    let writer_path = path.clone();
    let worker = thread::spawn(move || {
        let db = Connection::open(writer_path).unwrap();
        db.busy_timeout(Duration::from_secs(5)).unwrap();
        writer_gate.wait();
        for index in 1..=30 {
            let live = head(&db, "a");
            let mut body = task("a");
            body["error"] = json!((index + 1).to_string());
            execute(
                &db,
                &packet(request(
                    &db,
                    &format!("write-{index}"),
                    "update",
                    Some(&live),
                    Some(body),
                )),
            )?;
        }
        Ok::<_, StorageError>(())
    });
    let reader = Connection::open(&path).unwrap();
    reader.busy_timeout(Duration::from_secs(5)).unwrap();
    gate.wait();
    let mut observed = vec![];
    for _ in 0..30 {
        let snapshot = snapshot_from_conn(&reader, None, None);
        let valid = snapshot.map(|snapshot| {
            let body = &snapshot.tasks[0];
            let revision = &snapshot.storage.authority.heads[0].revision;
            body.error.is_empty() && revision == "1" || body.error == *revision
        });
        observed.push(valid);
    }
    let joined = worker.join();
    assert!(joined.unwrap().is_ok());
    for cut in observed {
        assert!(cut.unwrap());
    }
}

#[test]
fn task_mutation_pristine_identity_persists_and_existing_empty_closes_import() {
    let conn = db(true);
    let before = current(&conn).unwrap();
    assert!(
        snapshot_storage(&conn, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
    initialize_schema_with_origin(&conn, true).unwrap();
    assert_eq!(before.collection, current(&conn).unwrap().collection);
    assert!(
        !snapshot_storage(&db(false), &[])
            .unwrap()
            .legacy_task_import_allowed
    );
    assert_ne!(
        before.collection.collection_id,
        current(&db(true)).unwrap().collection.collection_id
    );
}

#[test]
fn task_mutation_schema_ten_migration_seeds_heads_and_preserves_original_reports() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_tables(&conn).unwrap();
    let (task, _) = crate::storage::tests::evidence_task_fixture();
    upsert_task(&conn, &task).unwrap();
    conn.execute("INSERT INTO schema_migrations(version) VALUES(10)", [])
        .unwrap();
    initialize_schema_with_origin(&conn, false).unwrap();
    assert_eq!(head(&conn, &task.id).generation, "1");
    assert_eq!(head(&conn, &task.id).revision, "1");
    assert_eq!(
        load_tasks_from_conn(&conn).unwrap()[0].report_sections,
        task.report_sections
    );
    assert_eq!(
        load_tasks_from_conn(&conn).unwrap()[0].report_versions,
        task.report_versions
    );
    assert!(
        !snapshot_storage(&conn, &load_tasks_from_conn(&conn).unwrap())
            .unwrap()
            .legacy_task_import_allowed
    );
}

#[test]
fn task_mutation_ordinary_open_never_backfills_after_migration() {
    let conn = db(false);
    create(&conn, "report");
    conn.execute(
        "UPDATE tasks SET status='completed',report_sections=?1",
        ["{\"final_report\":\"fictional late body\"}"],
    )
    .unwrap();
    initialize_schema_with_origin(&conn, false).unwrap();
    assert_eq!(count(&conn, "task_report_versions"), 0);
}

#[test]
fn task_mutation_missing_authority_and_future_schema_fail_closed() {
    let conn = db(true);
    conn.execute_batch("DROP TABLE task_store_metadata;")
        .unwrap();
    assert!(initialize_schema_with_origin(&conn, true).is_err());
    let conn = db(true);
    conn.execute(
        "INSERT INTO schema_migrations(version) VALUES(?1)",
        [SCHEMA_VERSION + 1],
    )
    .unwrap();
    assert!(initialize_schema_with_origin(&conn, false).is_err());
}

#[test]
fn task_mutation_tokenless_unknown_fields_and_numeric_counters_reject_before_binding() {
    let conn = db(true);
    let cases = vec![
        task("old"),
        json!({"taskId":"old"}),
        json!({}),
        {
            let mut r = request(&conn, "bad", "create", Some(&absent("a")), Some(task("a")));
            r["extra"] = json!(true);
            r
        },
        {
            let mut r = request(&conn, "bad", "create", Some(&absent("a")), Some(task("a")));
            r["expectedHead"]["revision"] = json!(0);
            r
        },
        {
            let mut r = request(&conn, "bad", "clear", None, None);
            r["collection"]["extra"] = json!(true);
            r
        },
    ];
    for value in cases {
        assert_eq!(
            parse(value, &["create", "clear"]).err().unwrap().code,
            "storage_invalid_request"
        );
    }
    assert_eq!(count(&conn, "task_mutation_requests"), 0);
    assert_eq!(count(&conn, "tasks"), 0);
}

#[test]
fn task_mutation_counter_encoding_and_request_identity_boundaries() {
    for invalid in [
        "",
        "00",
        "01",
        "-1",
        "+1",
        "1.0",
        "9223372036854775808",
        "١",
    ] {
        assert!(counter(invalid).is_err(), "{invalid}");
    }
    assert_eq!(counter("9223372036854775807").unwrap(), i64::MAX);
    assert_eq!(
        increment("9223372036854775807").unwrap_err().code,
        "storage_conflict"
    );
    let conn = db(true);
    for id in ["".into(), "x".repeat(129), "bad.id".into(), "中文".into()] {
        assert!(parse(request(&conn, &id, "clear", None, None), &["clear"]).is_err());
    }
    assert!(parse(
        request(&conn, &"a".repeat(128), "clear", None, None),
        &["clear"]
    )
    .is_ok());
}

#[test]
fn task_mutation_absent_delete_fences_initial_create_and_recreate_changes_generation() {
    let conn = db(true);
    let stale = packet(request(
        &conn,
        "late-create",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    ));
    execute(
        &conn,
        &packet(request(
            &conn,
            "delete-first",
            "delete",
            Some(&absent("a")),
            None,
        )),
    )
    .unwrap();
    assert_eq!(
        head(&conn, "a"),
        TaskHead {
            task_id: "a".into(),
            generation: "1".into(),
            revision: "1".into(),
            state: "tombstone".into()
        }
    );
    assert_eq!(execute(&conn, &stale).unwrap_err().code, "storage_conflict");
    assert_eq!(count(&conn, "tasks"), 0);
    let tomb = head(&conn, "a");
    execute(
        &conn,
        &packet(request(
            &conn,
            "recreate",
            "recreate",
            Some(&tomb),
            Some(task("a")),
        )),
    )
    .unwrap();
    assert_eq!(head(&conn, "a").generation, "2");
    assert_eq!(head(&conn, "a").revision, "1");
    assert_eq!(execute(&conn, &stale).unwrap_err().code, "storage_conflict");
}

#[test]
fn task_mutation_create_first_then_delete_prevents_update_insert() {
    let conn = db(true);
    let live = create(&conn, "a");
    let late = packet(request(
        &conn,
        "late-update",
        "update",
        Some(&live),
        Some(task("a")),
    ));
    execute(
        &conn,
        &packet(request(&conn, "remove", "delete", Some(&live), None)),
    )
    .unwrap();
    assert_eq!(execute(&conn, &late).unwrap_err().code, "storage_conflict");
    assert_eq!(count(&conn, "tasks"), 0);
    let tomb = head(&conn, "a");
    assert_eq!(
        execute(
            &conn,
            &packet(request(
                &conn,
                "bad-update",
                "update",
                Some(&tomb),
                Some(task("a"))
            ))
        )
        .unwrap_err()
        .code,
        "storage_conflict"
    );
}

#[test]
fn task_mutation_same_id_aba_rejects_original_save_delete_and_reviews() {
    let conn = db(true);
    let first = create(&conn, "a");
    let old_save = packet(request(
        &conn,
        "old-save",
        "update",
        Some(&first),
        Some(task("a")),
    ));
    let old_delete = packet(request(&conn, "old-delete", "delete", Some(&first), None));
    execute(
        &conn,
        &packet(request(&conn, "delete-a", "delete", Some(&first), None)),
    )
    .unwrap();
    let tomb = head(&conn, "a");
    execute(
        &conn,
        &packet(request(
            &conn,
            "new-a",
            "recreate",
            Some(&tomb),
            Some(task("a")),
        )),
    )
    .unwrap();
    let second = head(&conn, "a");
    for old in [&old_save, &old_delete] {
        assert_eq!(execute(&conn, old).unwrap_err().code, "storage_conflict");
    }
    assert_eq!(head(&conn, "a"), second);
    assert_eq!(count(&conn, "tasks"), 1);
}

#[test]
fn task_mutation_attachment_cas_runs_before_any_private_write() {
    let conn = db(true);
    let (task, _) = crate::storage::tests::evidence_task_fixture();
    let late = packet(request(
        &conn,
        "stale-evidence",
        "create",
        Some(&absent(&task.id)),
        Some(json!(task)),
    ));
    execute(
        &conn,
        &packet(request(
            &conn,
            "tombstone",
            "delete",
            Some(&absent(&task.id)),
            None,
        )),
    )
    .unwrap();
    assert_eq!(execute(&conn, &late).unwrap_err().code, "storage_conflict");
    for table in [
        "tasks",
        "task_reports",
        "task_report_versions",
        "evidence_artifacts",
        "evidence_bundles",
        "evidence_bundle_artifacts",
    ] {
        assert_eq!(count(&conn, table), 0, "{table}");
    }
}

#[test]
fn task_mutation_reports_evidence_and_history_survive_valid_mutation_and_atomic_delete() {
    let conn = db(true);
    let (task, _) = crate::storage::tests::evidence_task_fixture();
    let value = json!(task);
    execute(
        &conn,
        &packet(request(
            &conn,
            "evidence-create",
            "create",
            Some(&absent(&task.id)),
            Some(value.clone()),
        )),
    )
    .unwrap();
    let original = load_tasks_from_conn(&conn).unwrap().remove(0);
    assert_eq!(original.report_sections, task.report_sections);
    assert_eq!(original.report_versions, task.report_versions);
    let live = head(&conn, &task.id);
    execute(
        &conn,
        &packet(request(
            &conn,
            "evidence-update",
            "update",
            Some(&live),
            Some(value),
        )),
    )
    .unwrap();
    assert_eq!(
        load_tasks_from_conn(&conn).unwrap()[0].evidence_bundle,
        task.evidence_bundle
    );
    let live = head(&conn, &task.id);
    execute(
        &conn,
        &packet(request(
            &conn,
            "evidence-delete",
            "delete",
            Some(&live),
            None,
        )),
    )
    .unwrap();
    for table in [
        "tasks",
        "task_reports",
        "task_report_versions",
        "evidence_artifacts",
        "evidence_bundles",
        "evidence_bundle_artifacts",
    ] {
        assert_eq!(count(&conn, table), 0, "{table}");
    }
    assert_eq!(current(&conn).unwrap().heads[0].state, "tombstone");
}

#[test]
fn task_mutation_failed_prune_rolls_back_body_and_retains_rejected_digest() {
    let conn = db(true);
    create(&conn, "a");
    let live = head(&conn, "a");
    conn.execute_batch("CREATE TRIGGER no_prune BEFORE DELETE ON evidence_artifacts BEGIN SELECT RAISE(ABORT,'owned prune failure'); END;
        INSERT INTO evidence_artifacts VALUES('owned-unused','{}');").unwrap();
    let delete = packet(request(
        &conn,
        "prune-rejection",
        "delete",
        Some(&live),
        None,
    ));
    assert!(execute(&conn, &delete).is_err());
    assert_eq!(head(&conn, "a"), live);
    assert_eq!(count(&conn, "tasks"), 1);
    let queried = query(&conn, &delete).unwrap();
    assert!(queried.receipt.is_none());
    assert!(queried.rejection.is_some());
    assert_eq!(count(&conn, "evidence_artifacts"), 1);
}

#[test]
fn task_mutation_lost_ack_replay_does_not_increment_and_historical_receipt_is_not_current() {
    let conn = db(true);
    let create = packet(request(
        &conn,
        "lost",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    ));
    let first = execute(&conn, &create).unwrap();
    let again = execute(&conn, &create).unwrap();
    assert_eq!(first.receipt.digest, again.receipt.digest);
    assert_eq!(head(&conn, "a").revision, "1");
    let live = head(&conn, "a");
    execute(
        &conn,
        &packet(request(&conn, "remove", "delete", Some(&live), None)),
    )
    .unwrap();
    let old = query(&conn, &create).unwrap();
    assert_eq!(old.receipt.unwrap().heads[0].state, "live");
    assert_eq!(old.current.heads[0].state, "tombstone");
}

#[test]
fn task_mutation_digest_includes_ignored_task_fields_and_original_normalization_input() {
    let conn = db(true);
    let mut body = task("a");
    body["status"] = json!("running");
    body["futureExtension"] = json!({"raw":"fictional"});
    let raw = request(
        &conn,
        "digest",
        "create",
        Some(&absent("a")),
        Some(body.clone()),
    );
    let original = packet(raw.clone());
    execute(&conn, &original).unwrap();
    assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].status, "stopped");
    let mut changed = raw.clone();
    changed["task"]["futureExtension"]["raw"] = json!("changed");
    assert_eq!(
        query(&conn, &packet(changed)).unwrap_err().code,
        "storage_conflict"
    );
    let mut normalized = raw;
    normalized["task"]["status"] = json!("stopped");
    assert_eq!(
        query(&conn, &packet(normalized)).unwrap_err().code,
        "storage_conflict"
    );
    let reordered: Value =
        serde_json::from_str(&serde_json::to_string(&json!(original.collection)).unwrap()).unwrap();
    assert_eq!(reordered, json!(original.collection));
}

#[test]
fn task_mutation_known_rejection_binds_id_and_query_does_not_apply() {
    let conn = db(true);
    create(&conn, "a");
    let rejected = packet(request(
        &conn,
        "rejected",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    ));
    let error = execute(&conn, &rejected).unwrap_err();
    assert_eq!(error.code, "storage_conflict");
    assert_eq!(
        query(&conn, &rejected).unwrap().rejection,
        Some(error.clone())
    );
    assert_eq!(execute(&conn, &rejected).unwrap_err(), error);
    let changed = packet(request(
        &conn,
        "rejected",
        "update",
        Some(&head(&conn, "a")),
        Some(task("a")),
    ));
    assert_eq!(
        execute(&conn, &changed).unwrap_err().code,
        "storage_conflict"
    );
    assert_eq!(head(&conn, "a").revision, "1");
    let never = packet(request(
        &conn,
        "not-observed",
        "delete",
        Some(&absent("b")),
        None,
    ));
    let unknown = query(&conn, &never).unwrap();
    assert!(unknown.receipt.is_none() && unknown.rejection.is_none());
    assert_eq!(count(&conn, "task_store_heads"), 1);
}

#[test]
fn task_mutation_owned_rejection_checks_prior_outcome_and_never_writes_task() {
    let conn = db(true);
    let original = packet(request(
        &conn,
        "owned",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    ));
    let error = reject_owned(&conn, &original, "owned-private-marker".into()).unwrap_err();
    assert_eq!(error.code, "storage_owned");
    assert!(!error.message.contains("owned-private-marker"));
    assert_eq!(count(&conn, "tasks"), 0);
    assert_eq!(query(&conn, &original).unwrap().rejection, Some(error));
    let changed = packet(request(
        &conn,
        "owned",
        "create",
        Some(&absent("b")),
        Some(task("b")),
    ));
    assert_eq!(
        reject_owned(&conn, &changed, "busy".into())
            .unwrap_err()
            .code,
        "storage_conflict"
    );
    let committed = packet(request(
        &conn,
        "done",
        "create",
        Some(&absent("b")),
        Some(task("b")),
    ));
    execute(&conn, &committed).unwrap();
    assert_eq!(
        reject_owned(&conn, &committed, "busy".into())
            .unwrap()
            .scope,
        "sql"
    );
}

#[test]
fn task_mutation_clear_advances_epoch_and_delayed_create_or_save_cannot_repopulate() {
    let conn = db(true);
    let live = create(&conn, "a");
    let save = packet(request(
        &conn,
        "late",
        "update",
        Some(&live),
        Some(task("a")),
    ));
    let initial = packet(request(
        &conn,
        "late-first",
        "create",
        Some(&absent("b")),
        Some(task("b")),
    ));
    let clear_packet = packet(request(&conn, "clear", "clear", None, None));
    let result = clear(&conn, &clear_packet, || Ok(())).unwrap();
    assert_eq!(result.scope, "desktop_clear");
    assert_eq!(result.current.collection.epoch, "1");
    assert!(result.current.heads.is_empty());
    for old in [&save, &initial] {
        assert_eq!(execute(&conn, old).unwrap_err().code, "storage_conflict");
    }
    assert_eq!(count(&conn, "tasks"), 0);
    create(&conn, "a");
    assert_eq!(head(&conn, "a").generation, "1");
}

#[test]
fn task_mutation_clear_replay_and_pending_never_repeat_external_stage() {
    let conn = db(true);
    let clear_packet = packet(request(&conn, "clear", "clear", None, None));
    let calls = AtomicUsize::new(0);
    let first = clear(&conn, &clear_packet, || {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert_eq!(first.scope, "desktop_clear");
    assert_eq!(
        clear(&conn, &clear_packet, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap()
        .scope,
        "sql"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let pending = packet(request(&conn, "pending", "clear", None, None));
    let tx = immediate(&conn).unwrap();
    bind(&tx, &pending).unwrap();
    tx.commit().unwrap();
    let queried = query(&conn, &pending).unwrap();
    assert!(queried.receipt.is_none() && queried.rejection.is_none());
    assert_eq!(
        clear(&conn, &pending, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err()
        .code,
        "storage_unknown_outcome"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let mut changed = request(&conn, "pending", "clear", None, None);
    changed["collection"]["epoch"] = json!("0");
    assert_eq!(
        query(&conn, &packet(changed)).unwrap_err().code,
        "storage_conflict"
    );
}

#[test]
fn task_mutation_external_failure_is_partial_and_its_original_packet_never_repeats() {
    let conn = db(true);
    create(&conn, "a");
    let clear_packet = packet(request(&conn, "partial", "clear", None, None));
    let calls = AtomicUsize::new(0);
    let failure = clear(&conn, &clear_packet, || {
        calls.fetch_add(1, Ordering::SeqCst);
        Err("owned-private-marker".into())
    })
    .unwrap_err();
    assert_eq!(failure.code, "storage_partial_clear");
    assert!(!failure.message.contains("owned-private-marker"));
    assert_eq!(count(&conn, "tasks"), 1);
    assert_eq!(
        clear(&conn, &clear_packet, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err(),
        failure
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(query(&conn, &clear_packet).unwrap().rejection.is_some());
}

#[test]
fn task_mutation_clear_checks_conflict_and_overflow_before_external_effects() {
    let conn = db(true);
    let mut raw = request(&conn, "conflict", "clear", None, None);
    raw["collection"]["epoch"] = json!("1");
    let stale = packet(raw);
    let calls = AtomicUsize::new(0);
    assert_eq!(
        clear(&conn, &stale, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err()
        .code,
        "storage_conflict"
    );
    conn.execute("UPDATE task_store_metadata SET epoch=?1", [i64::MAX])
        .unwrap();
    let exhausted = packet(request(&conn, "overflow", "clear", None, None));
    assert_eq!(
        clear(&conn, &exhausted, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err()
        .code,
        "storage_conflict"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn task_mutation_revision_and_generation_overflow_write_no_attachments() {
    let conn = db(true);
    create(&conn, "a");
    conn.execute("UPDATE task_store_heads SET revision=?1", [i64::MAX])
        .unwrap();
    let before = head(&conn, "a");
    let update = packet(request(
        &conn,
        "overflow-update",
        "update",
        Some(&before),
        Some(task("a")),
    ));
    assert_eq!(
        execute(&conn, &update).unwrap_err().code,
        "storage_conflict"
    );
    assert_eq!(head(&conn, "a"), before);
    conn.execute(
        "UPDATE task_store_heads SET state='tombstone',generation=?1,revision=1",
        [i64::MAX],
    )
    .unwrap();
    conn.execute("DELETE FROM tasks", []).unwrap();
    let before = head(&conn, "a");
    let recreate = packet(request(
        &conn,
        "overflow-recreate",
        "recreate",
        Some(&before),
        Some(task("a")),
    ));
    assert_eq!(
        execute(&conn, &recreate).unwrap_err().code,
        "storage_conflict"
    );
    assert_eq!(count(&conn, "tasks"), 0);
}

#[test]
fn task_mutation_legacy_batch_is_atomic_and_empty_import_closes_forever() {
    let conn = db(true);
    let mut bad = task("b");
    bad["researchDepth"] = json!("invalid owned value");
    let batch = packet(
        json!({"protocolVersion":1,"requestId":"bad-import","collection":current(&conn).unwrap().collection,"operation":"import","expectedHeads":[absent("a"),absent("b")],"tasks":[task("a"),bad]}),
    );
    assert_eq!(
        execute(&conn, &batch).unwrap_err().code,
        "storage_invalid_request"
    );
    assert_eq!(count(&conn, "tasks"), 0);
    assert_eq!(count(&conn, "task_store_heads"), 0);
    assert!(
        snapshot_storage(&conn, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
    let empty = packet(
        json!({"protocolVersion":1,"requestId":"empty-import","collection":current(&conn).unwrap().collection,"operation":"import","expectedHeads":[],"tasks":[]}),
    );
    execute(&conn, &empty).unwrap();
    assert!(
        !snapshot_storage(&conn, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
    initialize_schema_with_origin(&conn, true).unwrap();
    let late = packet(
        json!({"protocolVersion":1,"requestId":"late-import","collection":current(&conn).unwrap().collection,"operation":"import","expectedHeads":[absent("a")],"tasks":[task("a")]}),
    );
    assert_eq!(execute(&conn, &late).unwrap_err().code, "storage_conflict");
}

#[test]
fn task_mutation_existing_and_copied_empty_store_never_reimports() {
    let conn = db(false);
    let batch = packet(
        json!({"protocolVersion":1,"requestId":"legacy","collection":current(&conn).unwrap().collection,"operation":"import","expectedHeads":[absent("a")],"tasks":[task("a")]}),
    );
    assert_eq!(execute(&conn, &batch).unwrap_err().code, "storage_conflict");
    assert_eq!(count(&conn, "tasks"), 0);
    let conn = db(true);
    execute(
        &conn,
        &packet(request(
            &conn,
            "delete-before-import",
            "delete",
            Some(&absent("a")),
            None,
        )),
    )
    .unwrap();
    assert!(
        !snapshot_storage(&conn, &[])
            .unwrap()
            .legacy_task_import_allowed
    );
}

#[test]
fn task_mutation_settings_import_rejects_tasks_field_presence_before_any_callback() {
    let calls = AtomicUsize::new(0);
    for tasks in [Value::Null, json!([]), json!([task("a")])] {
        let result = with_settings_only_legacy(json!({"settings":null,"tasks":tasks}), |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(result.unwrap_err().code, "storage_invalid_request");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    with_settings_only_legacy(json!({"settings":null}), |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn task_mutation_complete_current_cut_contains_unaffected_tombstones() {
    let conn = db(true);
    create(&conn, "live");
    execute(
        &conn,
        &packet(request(
            &conn,
            "gone",
            "delete",
            Some(&absent("gone")),
            None,
        )),
    )
    .unwrap();
    let latest = head(&conn, "live");
    let updated = execute(
        &conn,
        &packet(request(
            &conn,
            "update",
            "update",
            Some(&latest),
            Some(task("live")),
        )),
    )
    .unwrap();
    assert_eq!(updated.receipt.heads.len(), 1);
    assert_eq!(updated.current.heads.len(), 2);
    assert_eq!(updated.current.heads[0].state, "tombstone");
    let snap = snapshot_from_conn(&conn, None, None).unwrap();
    assert_eq!(snap.tasks.len(), 1);
    assert_eq!(snap.storage.authority.heads.len(), 2);
}

#[test]
fn task_mutation_foreign_collection_and_unsigned_json_do_not_gain_authority() {
    let a = db(true);
    let b = db(true);
    let mut raw = request(&a, "foreign", "create", Some(&absent("a")), Some(task("a")));
    raw["collection"] = json!(current(&b).unwrap().collection);
    assert_eq!(
        execute(&a, &packet(raw)).unwrap_err().code,
        "storage_conflict"
    );
    assert_eq!(count(&a, "tasks"), 0);
    let mut raw = request(&a, "unsigned", "clear", None, None);
    raw["collection"]["epoch"] = json!(18446744073709551615u64);
    assert!(parse(raw, &["clear"]).is_err());
}

#[test]
fn task_mutation_clear_retained_ledger_contains_no_original_body_or_bad_decode_marker() {
    let conn = db(true);
    let marker = "owned-private-report-marker";
    let mut bad = task("bad");
    bad["researchDepth"] = json!(marker);
    let rejected = packet(request(
        &conn,
        "bad-private-body",
        "create",
        Some(&absent("bad")),
        Some(bad),
    ));
    assert_eq!(
        execute(&conn, &rejected).unwrap_err().code,
        "storage_invalid_request"
    );
    let mut good = task("good");
    good["reportSections"] = json!({"final_report":marker});
    good["futureExtension"] = json!(marker);
    execute(
        &conn,
        &packet(request(
            &conn,
            "private-good",
            "create",
            Some(&absent("good")),
            Some(good),
        )),
    )
    .unwrap();
    clear(
        &conn,
        &packet(request(&conn, "privacy-clear", "clear", None, None)),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(count(&conn, "tasks"), 0);
    assert_eq!(count(&conn, "task_reports"), 0);
    assert_eq!(count(&conn, "task_mutation_requests"), 3);
    let mut rows=conn.prepare("SELECT request_id,digest,operation,collection_id,epoch,outcome,receipt_json,rejection_json FROM task_mutation_requests").unwrap();
    for row in rows
        .query_map([], |r| {
            let mut values = vec![];
            for i in 0..8 {
                values.push(format!("{:?}", r.get_ref(i)?));
            }
            Ok(values)
        })
        .unwrap()
    {
        assert!(!row.unwrap().join(" ").contains(marker));
    }
    assert!(!query(&conn, &rejected)
        .unwrap()
        .rejection
        .unwrap()
        .message
        .contains(marker));
}

#[test]
fn task_mutation_coordinator_serializes_clear_external_phase_and_real_mutation_attempt() {
    let _coordinator = coordinator();
    let (attempted, attempt) = mpsc::channel();
    let (acquired, acquire) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let worker = thread::spawn(move || {
        attempted.send(()).unwrap();
        let _lock = coordinator();
        acquired.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    let attempt_result = attempt.recv_timeout(Duration::from_secs(2));
    let before = acquire.recv_timeout(Duration::from_millis(100));
    drop(_coordinator);
    let after = acquire.recv_timeout(Duration::from_secs(2));
    let _ = release.send(());
    let joined = worker.join();
    assert!(attempt_result.is_ok());
    assert!(before.is_err());
    assert!(after.is_ok());
    assert!(joined.is_ok());
}

#[test]
fn task_mutation_same_sql_id_concurrent_requests_commit_once() {
    // Shared-memory SQLite connections, owned exclusively by this fixture.
    let name = format!(
        "file:task-fence-{}?mode=memory&cache=shared",
        std::process::id()
    );
    let conn = Connection::open(&name).unwrap();
    initialize_schema_with_origin(&conn, true).unwrap();
    let value = request(
        &conn,
        "concurrent",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    );
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut workers = vec![];
    for _ in 0..2 {
        let name = name.clone();
        let value = value.clone();
        let barrier = barrier.clone();
        workers.push(thread::spawn(move || {
            let db = Connection::open(name).unwrap();
            barrier.wait();
            let _lock = coordinator();
            execute(&db, &packet(value))
        }));
    }
    barrier.wait();
    let results: Vec<_> = workers.into_iter().map(|worker| worker.join()).collect();
    for result in results {
        assert!(result.unwrap().is_ok());
    }
    assert_eq!(head(&conn, "a").revision, "1");
    assert_eq!(count(&conn, "task_mutation_requests"), 1);
}

#[test]
fn task_mutation_known_memory_numeric_and_readiness_contracts_are_preserved() {
    for (index, task) in [
        crate::storage::tests::memory_task_fixture().0,
        crate::storage::tests::numeric_task_fixture().0,
        crate::storage::tests::readiness_task_fixture(),
    ]
    .into_iter()
    .enumerate()
    {
        let conn = db(true);
        let original = json!(task);
        execute(
            &conn,
            &packet(request(
                &conn,
                &format!("research-{index}"),
                "create",
                Some(&absent(&task.id)),
                Some(original),
            )),
        )
        .unwrap();
        let loaded = load_tasks_from_conn(&conn).unwrap().remove(0);
        assert_eq!(loaded.report_versions, task.report_versions);
        assert_eq!(loaded.report_sections, task.report_sections);
        assert_eq!(loaded.memory_bundle, task.memory_bundle);
        assert_eq!(
            loaded.effective_request_identity,
            task.effective_request_identity
        );
        assert_eq!(loaded.research_readiness, task.research_readiness);
        assert_eq!(loaded.report_text_snapshot, task.report_text_snapshot);
    }
}

#[test]
fn task_mutation_actual_runtime_guard_binds_owned_rejection_for_unstarted_preparing_and_failed_cleanup(
) {
    let conn = db(true);
    let live = create(&conn, "a");
    let runtime = Arc::new(crate::analysis_execution::Registry::default());
    let run_id = runtime.reserve("a".into()).unwrap();
    let deletion = packet(request(&conn, "owned-delete", "delete", Some(&live), None));
    let refused = crate::guard_task_sql(
        &runtime,
        Some("a"),
        || execute(&conn, &deletion),
        |message| reject_owned(&conn, &deletion, message),
    );
    let refused = refused.unwrap_err();
    assert_eq!(refused.code, "storage_owned");
    assert_eq!(query(&conn, &deletion).unwrap().rejection, Some(refused));
    let mut owner = runtime.start("a", &run_id).unwrap();
    let preparing = packet(request(&conn, "preparing-clear", "clear", None, None));
    let calls = AtomicUsize::new(0);
    let result = crate::guard_task_sql(
        &runtime,
        None,
        || {
            clear(&conn, &preparing, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        },
        |message| reject_owned(&conn, &preparing, message),
    );
    assert_eq!(result.unwrap_err().code, "storage_owned");
    let (started, inside) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    owner.reader(thread::spawn(move || {
        started.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let started_result = inside.recv_timeout(Duration::from_secs(2));
    let cleanup = owner.finish(std::time::Instant::now() + Duration::from_millis(5));
    let failed = packet(request(&conn, "failed-cleanup-clear", "clear", None, None));
    let refused = crate::guard_task_sql(
        &runtime,
        None,
        || {
            clear(&conn, &failed, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        },
        |message| reject_owned(&conn, &failed, message),
    );
    let retained = owner.ownership().retained();
    let _ = release.send(());
    let completed = owner.finish(std::time::Instant::now() + Duration::from_secs(3));
    // All gates released and the real Registry consumes the reader before asserting observations.
    assert!(started_result.is_ok());
    assert!(cleanup.is_err());
    assert!(retained);
    assert!(completed.is_ok());
    assert_eq!(refused.unwrap_err().code, "storage_owned");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(count(&conn, "tasks"), 1);
    let fresh = packet(request(
        &conn,
        "clear-after-confirmed-stop",
        "clear",
        None,
        None,
    ));
    assert_eq!(
        crate::guard_task_sql(
            &runtime,
            None,
            || clear(&conn, &fresh, || Ok(())),
            |message| reject_owned(&conn, &fresh, message)
        )
        .unwrap()
        .scope,
        "desktop_clear"
    );
}

#[test]
fn task_mutation_corrupt_historical_receipt_cannot_issue_a_different_task_head() {
    let conn = db(true);
    let creating = packet(request(
        &conn,
        "receipt",
        "create",
        Some(&absent("a")),
        Some(task("a")),
    ));
    execute(&conn, &creating).unwrap();
    let raw: String = conn
        .query_row(
            "SELECT receipt_json FROM task_mutation_requests WHERE request_id='receipt'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut changed: Value = serde_json::from_str(&raw).unwrap();
    changed["heads"][0]["generation"] = json!("2");
    conn.execute(
        "UPDATE task_mutation_requests SET receipt_json=?1 WHERE request_id='receipt'",
        [changed.to_string()],
    )
    .unwrap();
    assert_eq!(
        query(&conn, &creating).unwrap_err().code,
        "storage_unavailable"
    );
    assert_eq!(head(&conn, "a").generation, "1");
}

#[test]
fn task_mutation_shared_wire_corpus_matches_actual_sql_and_serialized_strings() {
    fn admitted(value: Value) -> (String, Packet) {
        let bytes = serde_json::to_string(&value).unwrap();
        let original = serde_json::from_str(&bytes).unwrap();
        (bytes, packet(original))
    }
    fn case<T: Serialize>(name: &str, kind: &str, request: &str, response: &T) -> Value {
        json!({"name": name, "kind": kind, "requestJson": request,
            "responseJson": serde_json::to_string(response).unwrap()})
    }

    // Fix authority only inside this owned in-memory database. No real settings,
    // Keychain, IPC, or OS clear is involved; every wire response below comes
    // from the actual production SQLite operation and its Rust serializer.
    let conn = db(true);
    conn.execute(
        "UPDATE task_store_metadata SET collection_id=?1,epoch=0 WHERE id=1",
        ["77".repeat(32)],
    )
    .unwrap();
    let mut body = task("wire-fictional-task");
    body["status"] = json!("idle");
    body["reportSections"] =
        json!({"market_report": "Owned fictional research\r\n  Unicode: 星帆  "});
    body["futureExtension"] = json!({"original": ["fictional", "原始"]});
    let (create_json, creating) = admitted(request(
        &conn,
        "wire-create",
        "create",
        Some(&absent("wire-fictional-task")),
        Some(body.clone()),
    ));
    let created = execute(&conn, &creating).unwrap();
    let original_head = head(&conn, "wire-fictional-task");
    let mut cases = vec![case("create_sql", "mutation", &create_json, &created)];

    body["instrumentName"] = json!("Owned fictional instrument");
    let (update_json, updating) = admitted(request(
        &conn,
        "wire-update",
        "update",
        Some(&original_head),
        Some(body.clone()),
    ));
    cases.push(case(
        "update_sql",
        "mutation",
        &update_json,
        &execute(&conn, &updating).unwrap(),
    ));
    let (delete_json, deleting) = admitted(request(
        &conn,
        "wire-unrelated-delete",
        "delete",
        Some(&absent("wire-unrelated-tombstone")),
        None,
    ));
    cases.push(case(
        "delete_never_seen_sql",
        "mutation",
        &delete_json,
        &execute(&conn, &deleting).unwrap(),
    ));
    let snapshot_json =
        serde_json::to_string(&snapshot_from_conn(&conn, None, None).unwrap()).unwrap();

    let (unknown_json, unobserved) = admitted(request(
        &conn,
        "wire-unobserved",
        "delete",
        Some(&absent("wire-unobserved-task")),
        None,
    ));
    let unresolved = query(&conn, &unobserved).unwrap();
    assert!(unresolved.receipt.is_none() && unresolved.rejection.is_none());
    cases.push(case(
        "query_unobserved",
        "query",
        &unknown_json,
        &unresolved,
    ));

    let (rejected_json, stale) = admitted(request(
        &conn,
        "wire-stale-update",
        "update",
        Some(&original_head),
        Some(body),
    ));
    let refusal = execute(&conn, &stale).unwrap_err();
    assert_eq!(refusal.code, "storage_conflict");
    let refused = query(&conn, &stale).unwrap();
    assert_eq!(refused.rejection, Some(refusal));
    cases.push(case(
        "query_durable_rejection",
        "query",
        &rejected_json,
        &refused,
    ));

    let (clear_json, clearing) = admitted(request(&conn, "wire-clear", "clear", None, None));
    let external_calls = AtomicUsize::new(0);
    let cleared = clear(&conn, &clearing, || {
        external_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert_eq!(cleared.scope, "desktop_clear");
    cases.push(case("clear_direct_ack", "mutation", &clear_json, &cleared));
    let duplicate = clear(&conn, &clearing, || {
        external_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert_eq!(duplicate.scope, "sql");
    assert_eq!(external_calls.load(Ordering::SeqCst), 1);
    cases.push(case(
        "clear_duplicate_sql",
        "mutation",
        &clear_json,
        &duplicate,
    ));
    cases.push(case(
        "query_historical_create_after_clear",
        "query",
        &create_json,
        &query(&conn, &creating).unwrap(),
    ));

    let generated = json!({"protocolVersion": 1, "snapshotJson": snapshot_json, "cases": cases});
    let expected: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/desktop_task_store_wire_v1.json"
    )))
    .unwrap();
    if expected != generated {
        // A fixture regeneration takes the actual serializer output, never a
        // separately handwritten reply oracle. Ordinary matching runs stay quiet.
        println!(
            "DESKTOP_TASK_STORE_WIRE_V1={}",
            serde_json::to_string(&generated).unwrap()
        );
    }
    // Values contain exact serialized request/response strings, so this also
    // detects field order, omission/null, escaping, and digest byte changes.
    assert_eq!(expected, generated);
}

#[test]
fn task_mutation_verified_projection_guard_preserves_ordinary_normalization() {
    let conn = db(true);
    let mut body = task("ordinary-running");
    body["status"] = json!("running");
    let create_packet = packet(request(
        &conn,
        "verified-guard-create",
        "create",
        Some(&absent("ordinary-running")),
        Some(body),
    ));
    assert_eq!(
        effects_for_verified_journal_projection(&conn, &create_packet)
            .unwrap_err()
            .code,
        "storage_invalid_request"
    );
    assert_eq!(count(&conn, "tasks"), 0);
    assert_eq!(count(&conn, "task_store_heads"), 0);

    let expected = create(&conn, "ordinary-running");
    let mut body = task("ordinary-running");
    body["status"] = json!("running");
    let mut multi_task = packet(request(
        &conn,
        "verified-guard-multi-task",
        "update",
        Some(&expected),
        Some(body.clone()),
    ));
    multi_task.tasks.push(task("unrelated-task"));
    assert_eq!(
        effects_for_verified_journal_projection(&conn, &multi_task)
            .unwrap_err()
            .code,
        "storage_invalid_request"
    );
    assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].status, "pending");
    assert_eq!(count(&conn, "tasks"), 1);
    assert_eq!(head(&conn, "ordinary-running"), expected);
    let mut multi_head = packet(request(
        &conn,
        "verified-guard-multi-head",
        "update",
        Some(&expected),
        Some(body.clone()),
    ));
    multi_head.expected_heads.push(absent("unrelated-task"));
    assert_eq!(
        effects_for_verified_journal_projection(&conn, &multi_head)
            .unwrap_err()
            .code,
        "storage_invalid_request"
    );
    assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].status, "pending");
    assert_eq!(count(&conn, "tasks"), 1);
    assert_eq!(head(&conn, "ordinary-running"), expected);

    let ordinary_update = packet(request(
        &conn,
        "ordinary-running-update",
        "update",
        Some(&expected),
        Some(body),
    ));
    execute(&conn, &ordinary_update).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT status FROM tasks WHERE id='ordinary-running'",
            [],
            |row| { row.get::<_, String>(0) }
        )
        .unwrap(),
        "stopped"
    );
    assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].status, "stopped");
    execute(&conn, &ordinary_update).unwrap();
    assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].status, "stopped");

    let import_conn = db(true);
    let mut body = task("ordinary-import");
    body["status"] = json!("running");
    let ordinary_import = packet(
        json!({"protocolVersion":1,"requestId":"ordinary-running-import","collection":current(&import_conn).unwrap().collection,"operation":"import","expectedHeads":[absent("ordinary-import")],"tasks":[body]}),
    );
    assert_eq!(
        effects_for_verified_journal_projection(&import_conn, &ordinary_import)
            .unwrap_err()
            .code,
        "storage_invalid_request"
    );
    assert_eq!(count(&import_conn, "tasks"), 0);
    assert_eq!(count(&import_conn, "task_store_heads"), 0);
    execute(&import_conn, &ordinary_import).unwrap();
    assert_eq!(
        import_conn
            .query_row(
                "SELECT status FROM tasks WHERE id='ordinary-import'",
                [],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
        "stopped"
    );
    assert_eq!(
        load_tasks_from_conn(&import_conn).unwrap()[0].status,
        "stopped"
    );
    execute(&import_conn, &ordinary_import).unwrap();
    assert_eq!(
        load_tasks_from_conn(&import_conn).unwrap()[0].status,
        "stopped"
    );
}
