use super::*;
use crate::analysis_recovery::parser;

const UTC: &str = "2026-01-02T03:04:05.006Z";
fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema_with_origin(&conn, true).unwrap();
    let collection = task_mutation::current(&conn).unwrap().collection;
    let body = json!({"id":"fiction","ticker":"FICTION","instrumentName":"Fictional company","analysisDate":"2026-01-02","assetType":"stock","researchDepth":1,"analysts":["market"],"outputLanguage":"en","status":"pending","createdAt":UTC,"updatedAt":UTC,"decision":"","stats":{"llmCalls":0,"toolCalls":0,"tokensIn":0,"tokensOut":0,"elapsedSeconds":0},"agentStatuses":{},"reportSections":{},"reportVersions":[],"evaluationReviews":[],"logs":[],"error":""});
    let p=task_mutation::parse(json!({"protocolVersion":1,"requestId":"create-fiction","collection":collection,"operation":"create","expectedHead":{"taskId":"fiction","generation":"0","revision":"0","state":"never_seen"},"task":body}),&["create"]).unwrap();
    task_mutation::execute(&conn, &p).unwrap();
    conn
}
fn settings() -> Value {
    json!({"llmProvider":"openai","quickThinkLlm":"fiction-model","deepThinkLlm":"fiction-model","temperature":"","openaiReasoningEffort":"","googleThinkingLevel":"","anthropicEffort":"","coreStockApis":"fixture","technicalIndicators":"fixture","fundamentalData":"fixture","newsData":"fixture","newsArticleLimit":1,"globalNewsArticleLimit":1,"globalNewsLookbackDays":1,"maxDebateRounds":0,"maxRiskRounds":0,"analystConcurrencyLimit":1,"benchmarkTicker":"","checkpointEnabled":false,"systemLanguage":"en"})
}
fn context(task: &AnalysisTaskRecord) -> Value {
    let snapshot = task_snapshot(task);
    let mut input = snapshot.clone();
    input.as_object_mut().unwrap().remove("instrumentName");
    json!({"originalTaskSnapshot":snapshot,"input":input,"requestedSettings":settings(),"originalRunContext":{"runId":"11111111-1111-4111-8111-111111111111","manifest":{"appVersion":"fixture","llmProvider":"openai","quickThinkLlm":"fiction-model","deepThinkLlm":"fiction-model","coreStockApis":"fixture","technicalIndicators":"fixture","fundamentalData":"fixture","newsData":"fixture","maxDebateRounds":0,"maxRiskRounds":0,"benchmarkTicker":""}}})
}
fn admission(
    conn: &Connection,
    id: &str,
    run: &str,
) -> (ParsedRecoveryRequest<AdmissionRequest>, AdmissionSeed) {
    let authority = task_mutation::current(conn).unwrap();
    let task = load_tasks_from_conn(conn).unwrap().remove(0);
    let head = authority
        .heads
        .into_iter()
        .find(|h| h.task_id == task.id)
        .unwrap();
    let origin = RunIdentity {
        runtime_epoch: "a".repeat(64),
        task_id: task.id.clone(),
        run_id: run.into(),
    };
    let binding =
        json!({"collection":authority.collection,"taskId":task.id,"generation":head.generation});
    let p = json!({"recoveryProtocolVersion":1,"requestId":id,"runtimeEpoch":origin.runtime_epoch,"collection":binding["collection"],"expectedHead":head,"context":context(&task)});
    let journal_id = domain_hash(
        "evidenceloom-journal-v1",
        &json!({"origin":origin,"binding":binding,"admissionRequestId":id}),
    )
    .unwrap();
    (
        parser::parse(&encoded(&p).unwrap()).unwrap(),
        AdmissionSeed {
            origin,
            journal_id,
            accepted_at: UTC.into(),
        },
    )
}
fn reserve(conn: &Connection) -> (ParsedRecoveryRequest<AdmissionRequest>, AdmissionSeed) {
    let (p, s) = admission(conn, "reserve-fiction", "analysis-1");
    assert!(admit(conn, &p, &s).unwrap().receipt.is_some());
    (p, s)
}
fn page(conn: &Connection, seed: &AdmissionSeed, after: &str, limit: u8) -> ReadReply {
    let h = header(conn, &seed.journal_id).unwrap();
    read(
        conn,
        &ReadRequest {
            recovery_protocol_version: 1,
            journal_id: seed.journal_id.clone(),
            origin: seed.origin.clone(),
            binding: h.binding,
            after_seq: after.into(),
            through_seq: None,
            limit,
        },
    )
    .unwrap()
}
fn projection(
    conn: &Connection,
    page: &ReadReply,
    task: &AnalysisTaskRecord,
    id: &str,
) -> ParsedRecoveryRequest<ProjectionRequest> {
    let head = task_mutation::current(conn)
        .unwrap()
        .heads
        .into_iter()
        .find(|h| h.task_id == task.id)
        .unwrap();
    parser::parse(&encoded(&json!({"recoveryProtocolVersion":1,"requestId":id,"journalId":page.header.journal_id,"origin":page.header.origin,"binding":page.header.binding,"expectedHead":head,"expectedAppliedSeq":page.after_seq,"throughSeq":page.last_seq,"rangeDigest":page.range_proof.as_ref().unwrap().digest,"projection":{"task":task}})).unwrap()).unwrap()
}
fn reset(conn: &Connection, seed: &AdmissionSeed) {
    let p = page(conn, seed, "0", 1);
    let mut task = load_tasks_from_conn(conn).unwrap().remove(0);
    task.status = "running".into();
    task.updated_at = UTC.into();
    assert!(project(conn, &projection(conn, &p, &task, "reset-fiction"))
        .unwrap()
        .receipt
        .is_some());
}
fn publish(conn: &Connection, seed: &AdmissionSeed, kind: &str, payload: Value) -> JournalEnvelope {
    let h = header(conn, &seed.journal_id).unwrap();
    append(
        conn,
        &PublicationDraft {
            journal_id: seed.journal_id.clone(),
            origin: seed.origin.clone(),
            binding: h.binding,
            kind: kind.into(),
            observed_at: UTC.into(),
            payload,
        },
    )
    .unwrap()
}
fn control(
    conn: &Connection,
    seed: &AdmissionSeed,
    id: &str,
    mode: &str,
    revision: Option<&str>,
    outcome: &str,
) -> SqlOutcome<ControlReceipt> {
    let p=parser::parse(&encoded(&json!({"recoveryProtocolVersion":1,"requestId":id,"origin":seed.origin,"journalId":seed.journal_id,"mode":mode,"expectedControlRevision":revision})).unwrap()).unwrap();
    record_control(
        conn,
        &p,
        &ControlRecord {
            outcome: outcome.into(),
            observed_at: UTC.into(),
        },
    )
    .unwrap()
}
fn failure_task(conn: &Connection, row: &JournalEnvelope, code: &str) -> AnalysisTaskRecord {
    let mut task = load_tasks_from_conn(conn).unwrap().remove(0);
    task.status = "error".into();
    task.error = error(code).message;
    task.updated_at = row.observed_at.clone();
    let mut logs = task.logs.as_array().unwrap().clone();
    logs.retain(|v| v["id"] != row.seed.log_id);
    logs.insert(0, json!({"id":row.seed.log_id,"type":"error","message":task.error,"timestamp":row.seed.log_timestamp}));
    logs.truncate(100);
    task.logs = Value::Array(logs);
    task
}
fn ordinary_mutation(
    conn: &Connection,
    id: &str,
    operation: &str,
    body: Option<Value>,
) -> task_mutation::Packet {
    let authority = task_mutation::current(conn).unwrap();
    let head = authority
        .heads
        .into_iter()
        .find(|h| h.task_id == "fiction")
        .unwrap();
    let mut request = json!({"protocolVersion":1,"requestId":id,"collection":authority.collection,"operation":operation,"expectedHead":head});
    if let Some(body) = body {
        request["task"] = body;
    }
    task_mutation::parse(request, &[operation]).unwrap()
}
fn completed_task(conn: &Connection, row: &JournalEnvelope) -> AnalysisTaskRecord {
    let mut task = load_tasks_from_conn(conn).unwrap().remove(0);
    task.status = "completed".into();
    task.error.clear();
    task.updated_at = row.observed_at.clone();
    task.report_sections = row.payload["event"]["reportSections"].clone();
    if let Some(stats) = row.payload["event"].get("stats") {
        task.stats = stats.clone();
    }
    let number = task
        .report_versions
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v["versionNumber"].as_i64())
        .max()
        .unwrap_or(0)
        + 1;
    let frozen = json!({"id":row.seed.completion_version_id,"runId":"11111111-1111-4111-8111-111111111111","versionNumber":number,"createdAt":row.observed_at,"legacy":false,"task":task_snapshot(&task),"run":null,"decision":"","stats":task.stats,"reportSections":task.report_sections,"evaluationReviews":[],"numericReviews":[]});
    task.report_versions.as_array_mut().unwrap().push(frozen);
    task
}
fn seal_and_clean(
    conn: &Connection,
    seed: &AdmissionSeed,
    outcome: &str,
    code: Option<&str>,
) -> JournalEnvelope {
    let row = publish(
        conn,
        seed,
        "worker_outcome",
        json!({"outcome":outcome,"code":code}),
    );
    let h = header(conn, &seed.journal_id).unwrap();
    seal(
        conn,
        &SealRecord {
            journal_id: seed.journal_id.clone(),
            origin: seed.origin.clone(),
            binding: h.binding,
            worker_outcome: WorkerOutcomePayload {
                outcome: outcome.into(),
                code: code.map(str::to_owned),
            },
        },
    )
    .unwrap();
    control(
        conn,
        seed,
        "fixture-clean",
        "stop",
        None,
        "cleanup_confirmed",
    );
    row
}

#[test]
fn analysis_journal_admission_reset_receipt_and_original_query_are_atomic() {
    let conn = db();
    let (p, s) = reserve(&conn);
    let q = query_admission(&conn, &p).unwrap();
    assert_eq!(q.receipt.unwrap().accepted_seq, "1");
    assert_eq!(q.current.unwrap().journal.unwrap().applied_seq, "0");
    reset(&conn, &s);
    assert_eq!(summary(&conn, &s.journal_id).unwrap().applied_seq, "1");
    assert_eq!(
        admit(&conn, &p, &s).unwrap().receipt.unwrap().journal_id,
        s.journal_id
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM analysis_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn analysis_journal_other_unresolved_run_refuses_new_admission() {
    let conn = db();
    reserve(&conn);
    let (p, s) = admission(&conn, "reserve-second", "analysis-2");
    let r = admit(&conn, &p, &s).unwrap();
    assert_eq!(r.rejection.unwrap().code, "analysis_busy");
    let q = query_admission(&conn, &p).unwrap();
    assert!(q.receipt.is_none());
    assert!(q.current.unwrap().journal.is_none());
    assert_eq!(summaries(&conn).unwrap().len(), 1);
}
#[test]
fn analysis_journal_empty_completed_is_terminal_error_and_carries_across_pages() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let row = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{}}}),
    );
    let p = page(&conn, &s, "1", 1);
    let good = failure_task(&conn, &row, "analysis_empty_result");
    let mut fake = good.clone();
    fake.status = "completed".into();
    fake.error.clear();
    assert_eq!(
        project(&conn, &projection(&conn, &p, &fake, "fake-empty"))
            .unwrap()
            .rejection
            .unwrap()
            .code,
        "analysis_invalid_request"
    );
    assert!(
        project(&conn, &projection(&conn, &p, &good, "empty-result"))
            .unwrap()
            .receipt
            .is_some()
    );
    let worker = publish(
        &conn,
        &s,
        "worker_outcome",
        json!({"outcome":"succeeded","code":null}),
    );
    let p = page(&conn, &s, "2", 1);
    let mut good = load_tasks_from_conn(&conn).unwrap().remove(0);
    good.updated_at = worker.observed_at.clone();
    assert!(project(&conn, &projection(&conn, &p, &good, "empty-final"))
        .unwrap()
        .receipt
        .is_some());
    let h = header(&conn, &s.journal_id).unwrap();
    let final_summary = seal(
        &conn,
        &SealRecord {
            journal_id: s.journal_id.clone(),
            origin: s.origin.clone(),
            binding: h.binding,
            worker_outcome: WorkerOutcomePayload {
                outcome: "succeeded".into(),
                code: None,
            },
        },
    )
    .unwrap();
    assert_eq!(final_summary.result_state, "projected");
    assert_eq!(
        load_tasks_from_conn(&conn).unwrap()[0].report_versions,
        json!([])
    );
    assert_eq!(
        control(&conn, &s, "clean", "stop", None, "cleanup_confirmed")
            .receipt
            .unwrap()
            .outcome,
        "cleanup_confirmed"
    );
    assert_removal_allowed(&conn, None).unwrap();
}
#[test]
fn analysis_journal_js_whitespace_bom_and_nel_are_not_rust_trim() {
    for text in ["", "\u{FEFF}", "\u{00a0}\u{202f}\u{3000}", "\t\n\r"] {
        assert!(!has_content(&json!({"report":text})));
    }
    for text in ["\u{0085}", "\u{180e}", "\u{001c}", "text"] {
        assert!(has_content(&json!({"report":text})));
    }
    assert!(!has_content(&json!({"report":null})));
    assert!(!has_content(&json!({})));
}
#[test]
fn analysis_journal_read_fixed_cut_proof_is_per_page_and_never_stalls() {
    let conn = db();
    let (_, s) = reserve(&conn);
    publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"progress","message":"First fixture update"}}),
    );
    let first = page(&conn, &s, "0", 1);
    assert!(first.has_more);
    assert_eq!(first.range_proof.as_ref().unwrap().through_seq, "1");
    assert_eq!(first.through_seq, "2");
    let h = header(&conn, &s.journal_id).unwrap();
    let end = read(
        &conn,
        &ReadRequest {
            recovery_protocol_version: 1,
            journal_id: s.journal_id.clone(),
            origin: s.origin.clone(),
            binding: h.binding,
            after_seq: "2".into(),
            through_seq: Some("2".into()),
            limit: 1,
        },
    )
    .unwrap();
    assert!(!end.has_more);
    assert!(end.rows.is_empty());
    assert!(end.range_proof.is_none());
    conn.execute("DELETE FROM analysis_events WHERE seq=2", [])
        .unwrap();
    let h = header(&conn, &s.journal_id).unwrap();
    let missing = read(
        &conn,
        &ReadRequest {
            recovery_protocol_version: 1,
            journal_id: s.journal_id,
            origin: s.origin,
            binding: h.binding,
            after_seq: "1".into(),
            through_seq: Some("2".into()),
            limit: 1,
        },
    )
    .err()
    .unwrap();
    assert_eq!(missing.code, "analysis_journal_gap");
}
#[test]
fn analysis_journal_missing_terminal_worker_code_must_be_truthful() {
    let conn = db();
    let (_, s) = reserve(&conn);
    let h = header(&conn, &s.journal_id).unwrap();
    let wrong = PublicationDraft {
        journal_id: s.journal_id.clone(),
        origin: s.origin.clone(),
        binding: h.binding,
        kind: "worker_outcome".into(),
        observed_at: UTC.into(),
        payload: json!({"outcome":"succeeded","code":null}),
    };
    assert_eq!(
        append(&conn, &wrong).err().unwrap().code,
        "analysis_journal_corrupt"
    );
    publish(
        &conn,
        &s,
        "worker_outcome",
        json!({"outcome":"succeeded","code":"analysis_missing_terminal"}),
    );
    assert_eq!(summary(&conn, &s.journal_id).unwrap().latest_seq, "2");
}
#[test]
fn analysis_journal_repeated_unavailable_lines_leave_reader_worker_reserve() {
    let conn = db();
    let (_, s) = reserve(&conn);
    for _ in 0..8 {
        publish(
            &conn,
            &s,
            "publication_unavailable",
            json!({"sourceType":null,"channels":[{"channel":"event","reason":"malformed"}],"outcome":"analysis_failed","code":"analysis_publication_unavailable","safeAnalysis":null}),
        );
    }
    for stream in ["stdout", "stderr"] {
        publish(
            &conn,
            &s,
            "reader_outcome",
            json!({"stream":stream,"outcome":"eof","code":null}),
        );
    }
    publish(
        &conn,
        &s,
        "worker_outcome",
        json!({"outcome":"cancelled","code":null}),
    );
    let used: i64 = conn
        .query_row("SELECT terminal_rows FROM analysis_journals", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(used, 4);
}
#[test]
fn analysis_journal_cleanup_revision_does_not_move_sealed_research_cut() {
    let conn = db();
    let (_, s) = reserve(&conn);
    publish(
        &conn,
        &s,
        "worker_outcome",
        json!({"outcome":"not_started","code":"analysis_reservation_expired"}),
    );
    let h = header(&conn, &s.journal_id).unwrap();
    let sealed = seal(
        &conn,
        &SealRecord {
            journal_id: s.journal_id.clone(),
            origin: s.origin.clone(),
            binding: h.binding,
            worker_outcome: WorkerOutcomePayload {
                outcome: "not_started".into(),
                code: Some("analysis_reservation_expired".into()),
            },
        },
    )
    .unwrap();
    assert_eq!(
        control(
            &conn,
            &s,
            "failed-clean",
            "stop",
            None,
            "cleanup_incomplete"
        )
        .receipt
        .unwrap()
        .outcome,
        "cleanup_incomplete"
    );
    assert_eq!(
        control(
            &conn,
            &s,
            "retry-clean",
            "retry_cleanup",
            Some("1"),
            "cleanup_confirmed"
        )
        .receipt
        .unwrap()
        .control_revision,
        "2"
    );
    assert_eq!(
        summary(&conn, &s.journal_id).unwrap().sealed_through_seq,
        sealed.sealed_through_seq
    );
    assert_eq!(
        assert_removal_allowed(&conn, None).err().unwrap().code,
        "analysis_busy"
    );
}
#[test]
fn analysis_journal_current_failure_does_not_erase_known_receipt() {
    let conn = db();
    let (p, _) = reserve(&conn);
    conn.execute("DELETE FROM task_store_heads", []).unwrap();
    let r = query_admission(&conn, &p).unwrap();
    assert!(r.receipt.is_some());
    assert!(r.current.is_err());
}
#[test]
fn analysis_journal_copy_rotation_retains_original_binding_and_blocker() {
    let conn = db();
    let (_, s) = reserve(&conn);
    let before = encoded(&header(&conn, &s.journal_id).unwrap()).unwrap();
    let tx = immediate(&conn).unwrap();
    let collection = rotate_for_supported_copy(&tx).unwrap();
    tx.commit().unwrap();
    let cut = bootstrap(&conn).unwrap();
    assert_ne!(cut.journals[0].binding.collection, collection);
    assert_eq!(cut.journals[0].history_state, "interrupted");
    assert_eq!(
        encoded(&header(&conn, &s.journal_id).unwrap()).unwrap(),
        before
    );
    assert!(assert_removal_allowed(&conn, None).is_err());
}
#[test]
fn analysis_journal_version_eleven_missing_authority_is_not_backfilled() {
    let conn = db();
    conn.execute("DELETE FROM schema_migrations WHERE version=12", [])
        .unwrap();
    conn.execute("INSERT INTO schema_migrations(version) VALUES(11)", [])
        .unwrap();
    conn.execute_batch("DROP TABLE task_store_metadata")
        .unwrap();
    assert!(initialize_schema_with_origin(&conn, false).is_err());
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='task_store_metadata')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!exists);
}
#[test]
fn analysis_journal_version_twelve_missing_required_column_is_unavailable() {
    let conn = db();
    conn.execute_batch("ALTER TABLE analysis_journals DROP COLUMN projection_failure_code")
        .unwrap();
    assert!(initialize_schema_with_origin(&conn, false).is_err());
}
#[test]
fn analysis_journal_same_id_different_original_packet_is_never_rebound() {
    let conn = db();
    let (p, _) = reserve(&conn);
    let mut changed = p.original.clone();
    changed["context"]["requestedSettings"]["temperature"] = json!("0.5");
    let changed = parser::parse(&encoded(&changed).unwrap()).unwrap();
    assert_eq!(
        query_admission(&conn, &changed).err().unwrap().code,
        "analysis_request_conflict"
    );
}

#[test]
fn analysis_journal_critical_prefix_keeps_earlier_version_and_original_later_completion() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let completed = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Original report\r\n中文"}}}),
    );
    let first = page(&conn, &s, "1", 1);
    let task = completed_task(&conn, &completed);
    assert!(
        project(&conn, &projection(&conn, &first, &task, "first-version"))
            .unwrap()
            .receipt
            .is_some()
    );
    let frozen = load_tasks_from_conn(&conn).unwrap()[0]
        .report_versions
        .clone();
    let unavailable = publish(
        &conn,
        &s,
        "publication_unavailable",
        json!({"sourceType":"completed","channels":[{"channel":"reportSections","reason":"unsafe_content"}],"outcome":"analysis_failed","code":"analysis_publication_unavailable","safeAnalysis":{"type":"completed","decision":"REVIEW"}}),
    );
    let middle = page(&conn, &s, "2", 1);
    let task = failure_task(&conn, &unavailable, "analysis_publication_unavailable");
    assert!(project(
        &conn,
        &projection(&conn, &middle, &task, "withheld-version")
    )
    .unwrap()
    .receipt
    .is_some());
    let later = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Later original report"}}}),
    );
    let last = page(&conn, &s, "3", 1);
    let fake = completed_task(&conn, &later);
    assert_eq!(
        project(
            &conn,
            &projection(&conn, &last, &fake, "fake-recovery-version")
        )
        .unwrap()
        .rejection
        .unwrap()
        .code,
        "analysis_invalid_request"
    );
    let mut task = failure_task(&conn, &later, "analysis_publication_unavailable");
    task.report_sections = later.payload["event"]["reportSections"].clone();
    assert!(project(
        &conn,
        &projection(&conn, &last, &task, "truthful-later-report")
    )
    .unwrap()
    .receipt
    .is_some());
    assert_eq!(
        load_tasks_from_conn(&conn).unwrap()[0].report_versions,
        frozen
    );
    assert_eq!(page(&conn, &s, "3", 1).rows[0].payload, later.payload);
}

#[test]
fn analysis_journal_projection_cas_rejection_replays_original_and_new_parent_can_win() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let completed = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Report"}}}),
    );
    let p = page(&conn, &s, "1", 1);
    let task = completed_task(&conn, &completed);
    let stale = projection(&conn, &p, &task, "old-parent");
    let mut edit = load_tasks_from_conn(&conn).unwrap().remove(0);
    edit.instrument_name = "Canonical edited name".into();
    task_mutation::execute(
        &conn,
        &ordinary_mutation(&conn, "edit-input", "update", Some(value(&edit).unwrap())),
    )
    .unwrap();
    let failed = project(&conn, &stale).unwrap();
    assert_eq!(failed.rejection.unwrap().code, "analysis_conflict");
    assert_eq!(summary(&conn, &s.journal_id).unwrap().applied_seq, "1");
    assert_eq!(
        query_projection(&conn, &stale)
            .unwrap()
            .rejection
            .unwrap()
            .code,
        "analysis_conflict"
    );
    let canonical = completed_task(&conn, &completed);
    let fresh = projection(&conn, &p, &canonical, "new-parent");
    let receipt = project(&conn, &fresh).unwrap().receipt.unwrap();
    assert_eq!(
        query_projection(&conn, &fresh)
            .unwrap()
            .receipt
            .unwrap()
            .digest,
        receipt.digest
    );
    assert_eq!(
        project(&conn, &fresh).unwrap().receipt.unwrap().head,
        receipt.head
    );
    let stored = load_tasks_from_conn(&conn).unwrap().remove(0);
    assert_eq!(
        stored.report_versions[0]["task"]["instrumentName"],
        "Canonical edited name"
    );
    assert_eq!(
        header(&conn, &s.journal_id).unwrap().context["originalTaskSnapshot"]["instrumentName"],
        "Fictional company"
    );
    assert_eq!(stored.report_versions.as_array().unwrap().len(), 1);
}

#[test]
fn analysis_journal_pending_delete_is_durable_refusal_and_complete_delete_purges_body() {
    let conn = db();
    let (_, s) = reserve(&conn);
    let original_binding = header(&conn, &s.journal_id).unwrap().binding;
    let pending = ordinary_mutation(&conn, "delete-pending", "delete", None);
    assert_eq!(
        task_mutation::execute(&conn, &pending).err().unwrap().code,
        "storage_owned"
    );
    assert!(header(&conn, &s.journal_id).is_ok());
    assert_eq!(load_tasks_from_conn(&conn).unwrap().len(), 1);
    reset(&conn, &s);
    let worker = seal_and_clean(&conn, &s, "not_started", Some("analysis_start_failed"));
    let p = page(&conn, &s, "1", 1);
    let task = failure_task(&conn, &worker, "analysis_start_failed");
    assert!(project(
        &conn,
        &projection(&conn, &p, &task, "failed-start-projection")
    )
    .unwrap()
    .receipt
    .is_some());
    let removable = ordinary_mutation(&conn, "delete-complete", "delete", None);
    task_mutation::execute(&conn, &removable).unwrap();
    assert!(load_tasks_from_conn(&conn).unwrap().is_empty());
    assert_eq!(
        header(&conn, &s.journal_id).err().unwrap().code,
        "analysis_journal_body_unavailable"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM analysis_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM analysis_controls", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let row: (Option<String>, String) = conn
        .query_row(
            "SELECT header_json,body_state FROM analysis_journals",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, (None, "purged".into()));
    // Replaying the previously refused original delete remains refusal.
    assert_eq!(
        task_mutation::execute(&conn, &pending).err().unwrap().code,
        "storage_owned"
    );
    let mut recreated = task;
    recreated.status = "pending".into();
    recreated.error.clear();
    recreated.logs = json!([]);
    task_mutation::execute(
        &conn,
        &ordinary_mutation(
            &conn,
            "recreate-fiction",
            "recreate",
            Some(value(&recreated).unwrap()),
        ),
    )
    .unwrap();
    assert_eq!(load_tasks_from_conn(&conn).unwrap().len(), 1);
    assert_eq!(
        task_mutation::current(&conn).unwrap().heads[0].generation,
        "2"
    );
    assert_eq!(
        read(
            &conn,
            &ReadRequest {
                recovery_protocol_version: 1,
                journal_id: s.journal_id.clone(),
                origin: s.origin.clone(),
                binding: original_binding,
                after_seq: "0".into(),
                through_seq: None,
                limit: 1
            }
        )
        .err()
        .unwrap()
        .code,
        "analysis_journal_body_unavailable"
    );
}

#[test]
fn analysis_journal_purge_is_rolled_back_with_callers_transaction() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let worker = seal_and_clean(&conn, &s, "not_started", Some("analysis_start_failed"));
    let p = page(&conn, &s, "1", 1);
    let task = failure_task(&conn, &worker, "analysis_start_failed");
    project(
        &conn,
        &projection(&conn, &p, &task, "final-before-rollback"),
    )
    .unwrap()
    .receipt
    .unwrap();
    let before = encoded(&header(&conn, &s.journal_id).unwrap()).unwrap();
    {
        let tx = immediate(&conn).unwrap();
        purge_projected_task(&tx, "fiction").unwrap();
        tx.rollback().unwrap();
    }
    assert_eq!(
        encoded(&header(&conn, &s.journal_id).unwrap()).unwrap(),
        before
    );
    assert_eq!(page(&conn, &s, "1", 1).rows[0].payload, worker.payload);
}

#[test]
fn analysis_journal_inventory_failure_records_only_metadata_and_original_query() {
    let conn = db();
    let (p, s) = admission(&conn, "inventory-rejection", "analysis-1");
    let result = reject_admission(&conn, &p, &s, &error("analysis_storage_unavailable")).unwrap();
    assert!(result.receipt.is_none());
    assert_eq!(
        query_admission(&conn, &p).unwrap().rejection.unwrap().code,
        result.rejection.unwrap().code
    );
    assert!(result.current.unwrap().journal.is_none());
    assert!(summaries(&conn).unwrap().is_empty());
    let metadata: String = conn.query_row("SELECT origin_json||binding_json||COALESCE(receipt_json,'')||COALESCE(rejection_json,'') FROM analysis_requests", [], |r| r.get(0)).unwrap();
    assert!(!metadata.contains("fiction-model"));
    assert!(!metadata.contains("originalTaskSnapshot"));
    assert!(!metadata.contains("requestedSettings"));
    assert!(!metadata.contains("11111111-1111-4111-8111-111111111111"));
    let (second, seed) = admission(&conn, "next-valid-reservation", "analysis-2");
    assert!(admit(&conn, &second, &seed).unwrap().receipt.is_some());
}

#[test]
fn analysis_journal_projection_counter_exhaustion_keeps_cursor_and_task_atomic() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let completed = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Report"}}}),
    );
    conn.execute(
        "UPDATE task_store_heads SET revision=?1 WHERE task_id='fiction'",
        [i64::MAX],
    )
    .unwrap();
    let before = value(&load_tasks_from_conn(&conn).unwrap().remove(0)).unwrap();
    let p = page(&conn, &s, "1", 1);
    let proposed = completed_task(&conn, &completed);
    let attempt = projection(&conn, &p, &proposed, "exhausted-revision");
    assert!(project(&conn, &attempt).unwrap().rejection.is_some());
    assert_eq!(summary(&conn, &s.journal_id).unwrap().applied_seq, "1");
    assert_eq!(
        value(&load_tasks_from_conn(&conn).unwrap().remove(0)).unwrap(),
        before
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM task_report_versions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(query_projection(&conn, &attempt)
        .unwrap()
        .rejection
        .is_some());
}

#[test]
fn analysis_journal_seed_identity_cannot_authorize_fabricated_log_content() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let row = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"progress","message":"Original progress","messageType":"info","agent":"market","timestamp":""}}),
    );
    let p = page(&conn, &s, "1", 1);
    let mut task = load_tasks_from_conn(&conn).unwrap().remove(0);
    task.updated_at = row.observed_at.clone();
    task.logs = json!([{"id":row.seed.log_id,"type":"info","message":"Original progress","timestamp":"","agent":"market"}]);
    for (key, replacement) in [
        ("type", "success"),
        ("message", "Fabricated result"),
        ("agent", "invented"),
    ] {
        let mut forged = task.clone();
        forged.logs[0][key] = json!(replacement);
        let id = format!("forged-{key}");
        assert_eq!(
            project(&conn, &projection(&conn, &p, &forged, &id))
                .unwrap()
                .rejection
                .unwrap()
                .code,
            "analysis_invalid_request"
        );
        assert_eq!(summary(&conn, &s.journal_id).unwrap().applied_seq, "1");
    }
    project(&conn, &projection(&conn, &p, &task, "original-message"))
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(load_tasks_from_conn(&conn).unwrap()[0].logs, task.logs);
}

#[test]
fn analysis_journal_stats_projection_accepts_js_number_roundtrip_without_rewriting_journal() {
    for (literal, rendered) in [("1.0", 1), ("1e0", 1), ("0.0", 0), ("-0.0", 0)] {
        let conn = db();
        let (_, s) = reserve(&conn);
        reset(&conn, &s);
        let event: Value = serde_json::from_str(&format!("{{\"event\":{{\"type\":\"completed\",\"reportSections\":{{\"market_report\":\"Report\"}},\"stats\":{{\"llmCalls\":1,\"toolCalls\":0,\"tokensIn\":1,\"tokensOut\":1,\"elapsedSeconds\":{literal}}}}}}}")).unwrap();
        let row = publish(&conn, &s, "analysis", event);
        let original = encoded(&row).unwrap();
        let p = page(&conn, &s, "1", 1);
        let mut task = completed_task(&conn, &row);
        task.stats["elapsedSeconds"] = json!(rendered);
        task.report_versions[0]["stats"]["elapsedSeconds"] = json!(rendered);
        project(&conn, &projection(&conn, &p, &task, "number-roundtrip"))
            .unwrap()
            .receipt
            .unwrap();
        assert_eq!(encoded(&page(&conn, &s, "1", 1).rows[0]).unwrap(), original);
    }
}

#[test]
fn analysis_journal_completion_version_cannot_forge_original_run_identity() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let row = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Report"}}}),
    );
    let p = page(&conn, &s, "1", 1);
    let task = completed_task(&conn, &row);
    let mut forged = task.clone();
    forged.report_versions[0]["runId"] = json!("another-research-run");
    assert_eq!(
        project(&conn, &projection(&conn, &p, &forged, "forged-run-id"))
            .unwrap()
            .rejection
            .unwrap()
            .code,
        "analysis_invalid_request"
    );
    project(&conn, &projection(&conn, &p, &task, "original-run-id"))
        .unwrap()
        .receipt
        .unwrap();
}

#[test]
fn analysis_journal_actual_sql_wire_corpus_serializes_original_publication_and_number_forms() {
    let mut replies = Vec::new();
    for literal in ["1.0", "1e0", "0.0", "-0.0"] {
        let conn = db();
        let (_, s) = reserve(&conn);
        replies.push(value(&page(&conn, &s, "0", 1)).unwrap());
        reset(&conn, &s);
        let event: Value = serde_json::from_str(&format!("{{\"event\":{{\"type\":\"completed\",\"reportSections\":{{\"market_report\":\"Unicode 中\\r\\n原文\",\"news_report\":null}},\"stats\":{{\"llmCalls\":1,\"toolCalls\":0,\"tokensIn\":1,\"tokensOut\":1,\"elapsedSeconds\":{literal}}}}}}}")).unwrap();
        publish(&conn, &s, "analysis", event);
        publish(
            &conn,
            &s,
            "publication_unavailable",
            json!({"sourceType":"completed","channels":[{"channel":"memoryBundle","reason":"unsafe_content"}],"outcome":"optional_unavailable","code":"analysis_publication_unavailable","safeAnalysis":{"type":"completed","reportSections":{"market_report":"Safe sibling original"},"timestamp":""}}),
        );
        publish(
            &conn,
            &s,
            "publication_unavailable",
            json!({"sourceType":null,"channels":[{"channel":"event","reason":"malformed"}],"outcome":"analysis_failed","code":"analysis_publication_unavailable","safeAnalysis":null}),
        );
        publish(
            &conn,
            &s,
            "analysis",
            json!({"event":{"type":"completed","reportSections":{"market_report":"Later preserved original"}}}),
        );
        publish(
            &conn,
            &s,
            "reader_outcome",
            json!({"stream":"stdout","outcome":"eof","code":null}),
        );
        seal_and_clean(&conn, &s, "succeeded", None);
        let reply = page(&conn, &s, "1", 64);
        assert_eq!(reply.rows.len(), 6);
        assert_eq!(reply.summary.sealed_through_seq.as_deref(), Some("7"));
        for row in &reply.rows {
            crate::analysis_recovery::parser::validate_envelope_value(&value(row).unwrap())
                .unwrap();
        }
        replies.push(value(&reply).unwrap());
    }
    let corpus = json!({"producer":"actual-native-sql-read-v1","readReplies":replies});
    // Explicit validation orchestration supplies a fresh owned output. Ordinary
    // test runs still exercise the actual producer without writing artifacts.
    if let Some(path) = std::env::var_os("EVIDENCELOOM_RECOVERY_CORPUS_OUTPUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(encoded(&corpus).unwrap().as_bytes())
            .unwrap();
        file.sync_all().unwrap();
    }
}

#[test]
fn analysis_journal_existing_float_stats_version_roundtrips_without_changing_saved_core() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let row = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Original report"},"stats":{"llmCalls":1,"toolCalls":0,"tokensIn":1,"tokensOut":1,"elapsedSeconds":1.0}}}),
    );
    let first = page(&conn, &s, "1", 1);
    let task = completed_task(&conn, &row);
    project(
        &conn,
        &projection(&conn, &first, &task, "original-float-version"),
    )
    .unwrap()
    .receipt
    .unwrap();
    let frozen: String = conn
        .query_row("SELECT snapshot FROM task_report_versions", [], |r| {
            r.get(0)
        })
        .unwrap();
    publish(
        &conn,
        &s,
        "reader_outcome",
        json!({"stream":"stdout","outcome":"eof","code":null}),
    );
    let next = page(&conn, &s, "2", 1);
    let mut roundtrip = load_tasks_from_conn(&conn).unwrap().remove(0);
    roundtrip.updated_at = UTC.into();
    roundtrip.stats["elapsedSeconds"] = json!(1);
    roundtrip.report_versions[0]["stats"]["elapsedSeconds"] = json!(1);
    project(
        &conn,
        &projection(&conn, &next, &roundtrip, "js-roundtrip-existing-version"),
    )
    .unwrap()
    .receipt
    .unwrap();
    let saved: String = conn
        .query_row("SELECT snapshot FROM task_report_versions", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(saved, frozen);
    assert_eq!(summary(&conn, &s.journal_id).unwrap().applied_seq, "3");
}

#[test]
fn analysis_journal_research_quota_preserves_fixed_failure_reader_worker_and_seal_capacity() {
    let conn = db();
    let (_, s) = reserve(&conn);
    conn.execute(
        "UPDATE analysis_journals SET research_rows=?1,payload_bytes=?2",
        params![RUN_ROWS, RUN_BYTES - TERMINAL_BYTES],
    )
    .unwrap();
    let h = header(&conn, &s.journal_id).unwrap();
    let normal = PublicationDraft {
        journal_id: s.journal_id.clone(),
        origin: s.origin.clone(),
        binding: h.binding.clone(),
        kind: "analysis".into(),
        observed_at: UTC.into(),
        payload: json!({"event":{"type":"progress","message":"Quota fixture"}}),
    };
    assert_eq!(
        append(&conn, &normal).err().unwrap().code,
        "analysis_limit_exceeded"
    );
    let withheld = PublicationDraft {
        kind: "publication_unavailable".into(),
        payload: json!({"sourceType":null,"channels":[{"channel":"event","reason":"limit_exceeded"}],"outcome":"analysis_failed","code":"analysis_publication_unavailable","safeAnalysis":null}),
        ..normal
    };
    assert_eq!(append(&conn, &withheld).unwrap().seq, "2");
    assert_eq!(
        append(&conn, &withheld).err().unwrap().code,
        "analysis_limit_exceeded"
    );
    for stream in ["stdout", "stderr"] {
        publish(
            &conn,
            &s,
            "reader_outcome",
            json!({"stream":stream,"outcome":"eof","code":null}),
        );
    }
    seal_and_clean(&conn, &s, "cancelled", None);
    assert_eq!(
        summary(&conn, &s.journal_id)
            .unwrap()
            .sealed_through_seq
            .as_deref(),
        Some("5")
    );
    assert_eq!(page(&conn, &s, "1", 64).rows.len(), 4);
}

#[test]
fn analysis_journal_ordinary_empty_error_can_be_replaced_by_later_real_completion() {
    let conn = db();
    let (_, s) = reserve(&conn);
    reset(&conn, &s);
    let empty = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{}}}),
    );
    let first = page(&conn, &s, "1", 1);
    let task = failure_task(&conn, &empty, "analysis_empty_result");
    project(&conn, &projection(&conn, &first, &task, "ordinary-empty"))
        .unwrap()
        .receipt
        .unwrap();
    let completed = publish(
        &conn,
        &s,
        "analysis",
        json!({"event":{"type":"completed","reportSections":{"market_report":"Actual later report"}}}),
    );
    let next = page(&conn, &s, "2", 1);
    let task = completed_task(&conn, &completed);
    project(&conn, &projection(&conn, &next, &task, "ordinary-recovery"))
        .unwrap()
        .receipt
        .unwrap();
    let canonical = load_tasks_from_conn(&conn).unwrap().remove(0);
    assert_eq!(canonical.status, "completed");
    assert!(canonical.error.is_empty());
    assert_eq!(canonical.report_versions.as_array().unwrap().len(), 1);
    assert_eq!(
        canonical.logs[0]["message"],
        error("analysis_empty_result").message
    );
}

#[test]
fn analysis_journal_new_native_epoch_marks_unresolved_physical_run_without_adoption() {
    let conn = db();
    let (_, s) = reserve(&conn);
    let before = encoded(&header(&conn, &s.journal_id).unwrap()).unwrap();
    let collection = task_mutation::current(&conn).unwrap().collection;
    interrupt_prior_epochs(&conn, &"b".repeat(64)).unwrap();
    let cut = bootstrap(&conn).unwrap();
    assert_eq!(cut.journals[0].history_state, "interrupted");
    assert_eq!(cut.journals[0].origin, s.origin);
    assert_eq!(cut.journals[0].latest_seq, "1");
    assert_eq!(cut.journals[0].applied_seq, "0");
    assert_eq!(cut.journals[0].cleanup_state, "pending");
    assert_eq!(
        encoded(&header(&conn, &s.journal_id).unwrap()).unwrap(),
        before
    );
    assert_eq!(
        task_mutation::current(&conn).unwrap().collection,
        collection
    );
    assert_eq!(
        assert_removal_allowed(&conn, None).err().unwrap().code,
        "analysis_busy"
    );
}

#[test]
fn analysis_journal_metadata_duplicates_and_header_mismatch_fail_closed_before_bootstrap() {
    for mode in [
        "origin_duplicate",
        "binding_duplicate",
        "bad_header_digest",
        "valid_header_wrong_origin",
    ] {
        let conn = db();
        let (_, s) = reserve(&conn);
        if mode == "origin_duplicate" || mode == "binding_duplicate" {
            let column = if mode == "origin_duplicate" {
                "origin_json"
            } else {
                "binding_json"
            };
            let raw: String = conn
                .query_row(
                    &format!("SELECT {column} FROM analysis_journals"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let prefix = if mode == "origin_duplicate" {
                format!("{{\"runtimeEpoch\":\"{}\",", "b".repeat(64))
            } else {
                "{\"generation\":\"999\",".into()
            };
            let corrupt = prefix + &raw[1..];
            conn.execute(
                &format!("UPDATE analysis_journals SET {column}=?1"),
                [corrupt],
            )
            .unwrap();
        } else {
            let mut corrupted = value(&header(&conn, &s.journal_id).unwrap()).unwrap();
            if mode == "bad_header_digest" {
                corrupted["headerDigest"] = json!("0".repeat(64));
            } else {
                corrupted["origin"]["runtimeEpoch"] = json!("b".repeat(64));
                corrupted.as_object_mut().unwrap().remove("headerDigest");
                corrupted["headerDigest"] = json!(hash(&corrupted).unwrap());
            }
            conn.execute(
                "UPDATE analysis_journals SET header_json=?1",
                [encoded(&corrupted).unwrap()],
            )
            .unwrap();
        }
        assert!(
            initialize_schema_with_origin(&conn, false).is_err(),
            "{mode}"
        );
        assert!(bootstrap(&conn).is_err(), "{mode}");
        assert!(current(&conn, &s.journal_id).is_err(), "{mode}");
    }
}

#[test]
fn analysis_journal_seal_requires_the_original_validated_last_worker_envelope() {
    for mode in ["duplicate", "bad_digest"] {
        let conn = db();
        let (_, s) = reserve(&conn);
        let worker = publish(
            &conn,
            &s,
            "worker_outcome",
            json!({"outcome":"not_started","code":null}),
        );
        let original = encoded(&worker).unwrap();
        let corrupted = if mode == "duplicate" {
            "{\"kind\":\"worker_outcome\",".to_owned() + &original[1..]
        } else {
            let mut v = value(&worker).unwrap();
            v["payloadDigest"] = json!("0".repeat(64));
            encoded(&v).unwrap()
        };
        conn.execute(
            "UPDATE analysis_events SET envelope_json=?1 WHERE seq=2",
            [corrupted],
        )
        .unwrap();
        let h = header(&conn, &s.journal_id).unwrap();
        assert_eq!(
            seal(
                &conn,
                &SealRecord {
                    journal_id: s.journal_id.clone(),
                    origin: s.origin.clone(),
                    binding: h.binding,
                    worker_outcome: WorkerOutcomePayload {
                        outcome: "not_started".into(),
                        code: None
                    }
                }
            )
            .err()
            .unwrap()
            .code,
            "analysis_journal_corrupt"
        );
        assert!(summary(&conn, &s.journal_id)
            .unwrap()
            .sealed_through_seq
            .is_none());
    }
}
