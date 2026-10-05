use super::*;
#[test]
fn analysis_recovery_raw_parser_rejects_nested_duplicates_and_unsafe_numbers() {
    for raw in [
        r#"{"a":{"x":1,"x":2}}"#,
        r#"{"a":9007199254740992}"#,
        r#"{"a":1e999}"#,
        r#"{} {}"#,
    ] {
        assert!(raw_json(raw, 1024).is_err());
    }
    assert_eq!(
        raw_json(r#"{"a":"  exact\r\n","b":null}"#, 1024).unwrap()["a"],
        "  exact\r\n"
    );
    assert!(raw_json("123", 2).is_err());
    assert!(raw_json(&format!("{}0{}", "[".repeat(65), "]".repeat(65)), 4096).is_err());
}
#[test]
fn analysis_recovery_counters_fail_closed_without_numeric_coercion() {
    for s in ["", "00", "01", "-1", "1.0", "9223372036854775808"] {
        assert!(counter(s).is_err());
    }
    assert_eq!(counter("9223372036854775807").unwrap(), MAX_COUNTER);
    assert_eq!(
        next_counter("9223372036854775807").unwrap_err().code,
        "analysis_counter_exhausted"
    );
}
#[test]
fn analysis_recovery_nullable_control_key_must_be_explicit() {
    let origin =
        serde_json::json!({"runtimeEpoch":"a".repeat(64),"taskId":"owned","runId":"analysis-0"});
    let request = serde_json::json!({"recoveryProtocolVersion":1,"requestId":"owned-stop","origin":origin,"journalId":"b".repeat(64),"mode":"stop","expectedControlRevision":null});
    assert!(parse::<StopRequest>(&request.to_string()).is_ok());
    let mut missing = request;
    missing
        .as_object_mut()
        .unwrap()
        .remove("expectedControlRevision");
    assert!(parse::<StopRequest>(&missing.to_string()).is_err());
}
#[test]
fn analysis_recovery_envelope_timestamp_and_accepted_sequence_are_bound() {
    use crate::storage::task_mutation::CollectionToken;
    let time = "2026-10-05T00:00:00.000Z";
    let mut row = JournalEnvelope {
        recovery_protocol_version: 1,
        journal_id: "b".repeat(64),
        origin: RunIdentity {
            runtime_epoch: "a".repeat(64),
            task_id: "owned".into(),
            run_id: "analysis-0".into(),
        },
        binding: RunBinding {
            collection: CollectionToken {
                collection_id: "c".repeat(64),
                epoch: "0".into(),
            },
            task_id: "owned".into(),
            generation: "1".into(),
        },
        seq: "2".into(),
        kind: "analysis".into(),
        observed_at: time.into(),
        payload: serde_json::json!({"event":{"type":"message","timestamp":"","message":"Fictional output"}}),
        seed: EventSeed {
            updated_at: time.into(),
            log_id: format!("log:{}:2", "b".repeat(64)),
            log_timestamp: "".into(),
            completion_version_id: None,
            completion_created_at: None,
        },
        payload_digest: String::new(),
    };
    let refresh = |row: &mut JournalEnvelope| {
        row.payload_digest=digest(&serde_json::json!({"kind":row.kind,"observedAt":row.observed_at,"payload":row.payload,"seed":row.seed})).unwrap();
    };
    refresh(&mut row);
    assert!(validate_envelope(&row).is_ok());
    row.seed.log_timestamp = time.into();
    refresh(&mut row);
    assert!(validate_envelope(&row).is_err());
    row.kind = "accepted".into();
    row.payload = serde_json::json!({"resetVersion":1});
    refresh(&mut row);
    assert!(validate_envelope(&row).is_err());
}

#[test]
fn analysis_recovery_attachment_raw_identity_and_nullable_fields_are_strict() {
    let request = serde_json::json!({
        "recoveryProtocolVersion":1,"requestId":"watch-original","runtimeEpoch":"a".repeat(64),
        "expectedObservationRevision":"0","origin":{"runtimeEpoch":"a".repeat(64),"taskId":"owned","runId":"analysis-0"},
        "journalId":"b".repeat(64),"binding":{"collection":{"collectionId":"c".repeat(64),"epoch":"0"},"taskId":"owned","generation":"1"},
        "admissionRequestId":"admitted-original","admissionDigest":"d".repeat(64),"expectedHeaderDigest":null
    });
    assert!(parse::<AttachRequest>(&request.to_string()).is_ok());
    let mut missing = request.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("expectedHeaderDigest");
    assert!(parse::<AttachRequest>(&missing.to_string()).is_err());
    for (key, bad) in [
        ("expectedObservationRevision", serde_json::json!("00")),
        ("runtimeEpoch", serde_json::json!("b".repeat(64))),
        ("expectedHeaderDigest", serde_json::json!("bad")),
        ("admissionRequestId", serde_json::json!("contains space")),
    ] {
        let mut changed = request.clone();
        changed[key] = bad;
        assert!(
            parse::<AttachRequest>(&changed.to_string()).is_err(),
            "{key}"
        );
    }
    let duplicate = request
        .to_string()
        .replacen("{", "{\"requestId\":\"duplicate\",", 1);
    assert!(parse::<AttachRequest>(&duplicate).is_err());
    let mut oversized = request;
    oversized["requestId"] = "x".repeat(CONTROL_BYTES).into();
    assert_eq!(
        parse::<AttachRequest>(&oversized.to_string())
            .unwrap_err()
            .code,
        "analysis_limit_exceeded"
    );
}
