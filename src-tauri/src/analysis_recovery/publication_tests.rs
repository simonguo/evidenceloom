use super::*;
#[test]
fn analysis_recovery_known_credential_inventory_is_acquired_before_publication() {
    let mut observed = Vec::new();
    let inventory = SecretInventory::acquire(
        |_| Ok(None),
        |name| {
            observed.push(name.to_owned());
            Ok((name == "ANTHROPIC_API_KEY").then(|| "owned-fictional-private-value".into()))
        },
    )
    .unwrap();
    assert_eq!(observed.len(), CREDENTIAL_ENV.len());
    let event = prepare_event(
        &json!({"type":"completed","reportSections":{"market_report":"owned-fictional-private-value"}}),
        &inventory,
    );
    assert_eq!(event.payload["outcome"], "analysis_failed");
    assert!(!event
        .payload
        .to_string()
        .contains("owned-fictional-private-value"));
}
#[test]
fn analysis_recovery_safe_report_and_optional_unavailable_preserve_exact_siblings() {
    let report = "  Fictional research\r\n";
    let event = prepare_event(
        &json!({"type":"completed","timestamp":"","reportSections":{"market_report":report,"empty":"","missing":null},"memoryBundle":{"unknown_private":"discard me"}}),
        &SecretInventory::default(),
    );
    assert_eq!(event.payload["outcome"], "optional_unavailable");
    assert_eq!(event.kind, "publication_unavailable");
    assert_eq!(
        event.payload["safeAnalysis"]["reportSections"]["market_report"],
        report
    );
    assert_eq!(event.payload["safeAnalysis"]["timestamp"], "");
    assert!(has_completion_seed(&event.kind, &event.payload));
    assert!(validate_payload(&event.kind, &event.payload).is_ok());
}
#[test]
fn analysis_recovery_null_report_is_critical_without_prior_report_fallback() {
    let event = prepare_event(
        &json!({"type":"completed","reportSections":null}),
        &SecretInventory::default(),
    );
    assert_eq!(event.payload["outcome"], "analysis_failed");
    assert_eq!(event.payload["channels"][0]["channel"], "reportSections");
    assert!(!has_completion_seed(&event.kind, &event.payload));
    assert!(event.payload["safeAnalysis"]
        .get("reportSections")
        .is_none());
}
#[test]
fn analysis_recovery_unsafe_explicit_timestamp_never_becomes_fallback_original() {
    let inventory = SecretInventory::new(vec!["owned-private-time".into()]);
    let event = prepare_event(
        &json!({"type":"message","timestamp":"owned-private-time","message":"fiction"}),
        &inventory,
    );
    assert_eq!(
        expected_log_timestamp(&event.kind, &event.payload, "2026-10-05T00:00:00.000Z").unwrap(),
        "[unavailable]"
    );
    assert_eq!(
        expected_log_timestamp(
            "analysis",
            &json!({"event":{"type":"message","timestamp":""}}),
            "2026-10-05T00:00:00.000Z"
        )
        .unwrap(),
        ""
    );
}
#[test]
fn analysis_recovery_ecmascript_whitespace_predicate_preserves_nel() {
    assert!(ecmascript_blank("\u{feff}\u{2028}\u{3000}\r\n\t"));
    assert!(!ecmascript_blank("\u{85}"));
    assert!(!ecmascript_blank("x"));
}
#[test]
fn analysis_recovery_publication_matrix_is_not_just_an_enum_check() {
    let bad = json!({"sourceType":"completed","channels":[{"channel":"reportSections","reason":"unsafe_content"}],"outcome":"optional_unavailable","code":"analysis_publication_unavailable","safeAnalysis":{"type":"completed"}});
    assert!(validate_payload("publication_unavailable", &bad).is_err());
}
