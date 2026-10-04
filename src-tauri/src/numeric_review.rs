//! Independently rederived saved-field comparisons against immutable report text.
#[path = "numeric_review/decimal.rs"]
mod decimal;
#[path = "numeric_review/engine.rs"]
mod engine;
#[path = "numeric_review/raw.rs"]
mod raw;
#[path = "numeric_review/spans.rs"]
mod spans;

use crate::{evidence, research_memory as memory};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::OnceLock;

pub const ERROR: &str = "Invalid or conflicting saved numeric review";
const SECTION_KEYS: [&str; 7] = [
    "market_report",
    "sentiment_report",
    "news_report",
    "fundamentals_report",
    "investment_plan",
    "trader_investment_plan",
    "final_trade_decision",
];
const CONTEXT_KEYS: [&str; 3] = ["instrument", "row_date", "units"];
const MAX_SECTION_BYTES: usize = 1_048_576;
type Result<T> = std::result::Result<T, String>;

fn ensure(condition: bool) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(ERROR.into())
    }
}
fn exact<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let map = value.as_object().ok_or(ERROR)?;
    ensure(map.len() == fields.len() && fields.iter().all(|key| map.contains_key(*key)))?;
    Ok(map)
}
fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| ERROR.into())
}
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn owner_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| !value.is_empty() && value.len() <= 256)
}
fn bounded(value: &Value) -> Result<()> {
    memory::bounded(value).map_err(|_| ERROR.into())
}
fn checked_hash(value: &Value, field: &str) -> Result<()> {
    ensure(
        digest(&value[field])
            && value[field] == memory::hash_component(value, field).map_err(|_| ERROR)?,
    )
}
pub fn raw_text_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn timestamp(value: &Value) -> Result<i64> {
    let text = string(value)?;
    ensure(text.len() == 27 && text.as_bytes()[19] == b'.')?;
    memory::timestamp(value).map_err(|_| ERROR.into())
}
fn policy() -> &'static Value {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| {
        memory::parse_json(include_str!(
            "../../docs/contracts/numeric_review_policy_v1.json"
        ))
        .expect("frozen numeric policy JSON")
    })
}

fn normalized_sections(reports: &Value) -> Result<Value> {
    let reports = reports.as_object().ok_or(ERROR)?;
    let mut result = Map::new();
    for key in SECTION_KEYS {
        let value = reports.get(key).cloned().unwrap_or(Value::Null);
        ensure(
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|value| value.len() <= MAX_SECTION_BYTES),
        )?;
        result.insert(key.into(), value);
    }
    Ok(Value::Object(result))
}

pub fn validate_snapshot(value: &Value, evidence: &Value) -> Result<()> {
    exact(
        value,
        &[
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "captured_at",
            "evidence_bundle_sha256",
            "report_sections",
            "snapshot_sha256",
        ],
    )?;
    bounded(value)?;
    ensure(
        value["schema_version"] == 1
            && memory::uuid(string(&value["run_id"])?)
            && digest(&value["evidence_bundle_sha256"]),
    )?;
    exact(&value["report_sections"], &SECTION_KEYS)?;
    ensure(normalized_sections(&value["report_sections"])? == value["report_sections"])?;
    let captured = timestamp(&value["captured_at"])?;
    evidence::validate_bundle(evidence, Some(&value["report_sections"])).map_err(|_| ERROR)?;
    // Audit arrays must match the deterministic sorted ID resolution result,
    // including empty sections. The ordinary Evidence report check uses sets.
    for key in SECTION_KEYS {
        if let Some(audit) = evidence["citation_audit"].get(key) {
            for field in ["referenced_ids", "unresolved_ids"] {
                let ids = audit[field].as_array().ok_or(ERROR)?;
                let mut sorted = ids.clone();
                sorted.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
                ensure(*ids == sorted)?;
            }
        }
    }
    ensure(
        value["run_id"] == evidence["run_id"]
            && value["instrument"] == evidence["instrument"]
            && value["analysis_date"] == evidence["analysis_date"]
            && value["evidence_bundle_sha256"] == evidence["bundle_sha256"],
    )?;
    ensure(captured >= memory::timestamp(&evidence["created_at"]).map_err(|_| ERROR)?)?;
    for record in evidence["records"].as_array().ok_or(ERROR)? {
        ensure(captured >= memory::timestamp(&record["fetched_at"]).map_err(|_| ERROR)?)?;
    }
    checked_hash(value, "snapshot_sha256")
}

pub fn validate_snapshot_binding(
    value: &Value,
    evidence: &Value,
    run_id: Option<&str>,
    instrument: &str,
    analysis_date: &str,
    reports: &Value,
) -> Result<()> {
    validate_snapshot(value, evidence)?;
    ensure(
        value["instrument"] == instrument
            && value["analysis_date"] == analysis_date
            && run_id.is_none_or(|run| value["run_id"] == run)
            && value["report_sections"] == normalized_sections(reports)?,
    )
}

pub fn validate_fields(
    snapshot: Option<&Value>,
    marker: Option<&Value>,
    reviews: Option<&Value>,
) -> Result<()> {
    if let Some(marker) = marker {
        exact(marker, &["status", "reason"])?;
        ensure(
            marker["status"] == "invalid"
                && [
                    "malformed",
                    "hash_mismatch",
                    "reference_mismatch",
                    "unsafe_content",
                    "verification_unavailable",
                ]
                .iter()
                .any(|reason| marker["reason"] == *reason)
                && snapshot.is_none(),
        )?;
    }
    if let Some(reviews) = reviews {
        let items = reviews.as_array().ok_or(ERROR)?;
        ensure(
            items.len() <= 1000 && (items.is_empty() || (snapshot.is_some() && marker.is_none())),
        )?;
        bounded(reviews)?;
    }
    Ok(())
}

fn review_shape(review: &Value, snapshot: &Value, task_id: &str, version_id: &str) -> Result<()> {
    exact(
        review,
        &[
            "schema_version",
            "review_id",
            "reviewed_at",
            "previous_review_sha256",
            "policy_version",
            "policy_sha256",
            "scope",
            "target",
            "numeric_span",
            "operand",
            "rounding",
            "context_bindings",
            "result",
            "review_sha256",
        ],
    )?;
    bounded(review)?;
    ensure(
        review["schema_version"] == 1
            && memory::uuid(string(&review["review_id"])?)
            && review["policy_version"] == policy()["policy_version"]
            && review["scope"] == policy()["scope"]
            && review["policy_sha256"] == memory::hash_value(policy()).map_err(|_| ERROR)?,
    )?;
    ensure(
        review["previous_review_sha256"].is_null() || digest(&review["previous_review_sha256"]),
    )?;
    ensure(timestamp(&review["reviewed_at"])? >= timestamp(&snapshot["captured_at"])?)?;
    exact(
        &review["target"],
        &[
            "task_id",
            "version_id",
            "run_id",
            "report_snapshot_sha256",
            "section_key",
            "section_utf8_sha256",
        ],
    )?;
    let target = &review["target"];
    ensure(
        owner_id(&target["task_id"])
            && owner_id(&target["version_id"])
            && target["task_id"] == task_id
            && target["version_id"] == version_id
            && target["run_id"] == snapshot["run_id"]
            && target["report_snapshot_sha256"] == snapshot["snapshot_sha256"]
            && SECTION_KEYS.contains(&string(&target["section_key"])?)
            && digest(&target["section_utf8_sha256"]),
    )?;
    let section = string(&snapshot["report_sections"][string(&target["section_key"])?])?;
    ensure(target["section_utf8_sha256"] == raw_text_hash(section))?;
    spans::text(section, &review["numeric_span"])?;
    exact(&review["context_bindings"], &CONTEXT_KEYS)?;
    for key in CONTEXT_KEYS {
        if !review["context_bindings"][key].is_null() {
            spans::text(section, &review["context_bindings"][key])?;
        }
    }
    let operand = &review["operand"];
    exact(
        operand,
        &[
            "evidence_id",
            "source_index",
            "provider",
            "data_sha256",
            "selector",
            "raw_number_lexeme",
        ],
    )?;
    ensure(
        string(&operand["evidence_id"])?.len() == 35
            && string(&operand["evidence_id"])?.starts_with("ev-")
            && string(&operand["evidence_id"])?[3..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && operand["source_index"]
                .as_u64()
                .is_some_and(|index| index < 1024)
            && (operand["data_sha256"].is_null() || digest(&operand["data_sha256"]))
            && (operand["raw_number_lexeme"].is_null()
                || operand["raw_number_lexeme"]
                    .as_str()
                    .is_some_and(|value| value.len() <= 256)),
    )?;
    exact(
        &operand["selector"],
        &["kind", "table_path", "row_date", "field"],
    )?;
    let selector = &operand["selector"];
    ensure(
        selector["kind"] == "table_cell"
            && policy()["table_paths"]
                .as_array()
                .ok_or(ERROR)?
                .contains(&selector["table_path"])
            && owner_id(&selector["field"])
            && selector["row_date"]
                .as_str()
                .is_some_and(|date| !date.is_empty() && date.len() <= 256),
    )?;
    exact(&review["rounding"], &["mode", "places"])?;
    ensure(
        review["rounding"]["mode"] == policy()["rounding_mode"]
            && review["rounding"]["places"]
                .as_u64()
                .is_some_and(|places| places <= 18),
    )?;
    exact(
        &review["result"],
        &[
            "status",
            "reason",
            "rounded_decimal",
            "context_results",
            "unreviewed_dimensions",
            "source_context",
        ],
    )?;
    exact(&review["result"]["context_results"], &CONTEXT_KEYS)?;
    exact(
        &review["result"]["source_context"],
        &[
            "instrument",
            "row_date",
            "units",
            "provider",
            "historical_availability",
            "adjustments",
            "transformations",
        ],
    )?;
    checked_hash(review, "review_sha256")
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retain the standalone receipt validator alongside batch validation"
    )
)]
pub fn validate_review(
    review: &Value,
    snapshot: &Value,
    evidence: &Value,
    task_id: &str,
    version_id: &str,
) -> Result<()> {
    validate_snapshot(snapshot, evidence)?;
    let mut prepared = engine::Prepared::new(snapshot, evidence)?;
    validate_bound_review(review, snapshot, &mut prepared, task_id, version_id)
}

fn validate_bound_review(
    review: &Value,
    snapshot: &Value,
    prepared: &mut engine::Prepared<'_>,
    task_id: &str,
    version_id: &str,
) -> Result<()> {
    review_shape(review, snapshot, task_id, version_id)?;
    let derived = prepared.derive(review)?;
    ensure(
        review["operand"]["provider"] == derived.provider
            && review["operand"]["data_sha256"] == derived.data_sha256
            && review["operand"]["raw_number_lexeme"] == derived.raw_number_lexeme
            && review["result"] == derived.result,
    )
}

pub fn validate_reviews(
    reviews: &Value,
    snapshot: Option<&Value>,
    evidence: Option<&Value>,
    task_id: &str,
    version_id: &str,
) -> Result<()> {
    validate_fields(snapshot, None, Some(reviews))?;
    let reviews = reviews.as_array().ok_or(ERROR)?;
    if reviews.is_empty() {
        return Ok(());
    }
    let snapshot = snapshot.ok_or(ERROR)?;
    let evidence = evidence.ok_or(ERROR)?;
    validate_snapshot(snapshot, evidence)?;
    let mut prepared = engine::Prepared::new(snapshot, evidence)?;
    let mut ids = BTreeSet::new();
    let mut previous = Value::Null;
    let mut previous_time = None;
    for review in reviews {
        validate_bound_review(review, snapshot, &mut prepared, task_id, version_id)?;
        let time = timestamp(&review["reviewed_at"])?;
        ensure(
            ids.insert(string(&review["review_id"])?)
                && review["previous_review_sha256"] == previous
                && previous_time.is_none_or(|previous| time >= previous),
        )?;
        previous = review["review_sha256"].clone();
        previous_time = Some(time);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn invalid_markers_are_explicit_and_never_coexist_with_authority() {
        let marker = json!({"status":"invalid","reason":"hash_mismatch"});
        validate_fields(None, Some(&marker), Some(&json!([]))).unwrap();
        assert!(validate_fields(Some(&json!({})), Some(&marker), None).is_err());
        assert!(validate_fields(None, Some(&marker), Some(&json!([{}]))).is_err());
        assert!(validate_fields(
            None,
            Some(&json!({"status":"invalid","reason":"malformed","error":"private body"})),
            None
        )
        .is_err());
    }

    #[test]
    fn python_fixture_has_identical_hashes_results_and_opaque_numbers() {
        let fixture = test_support::fixture();
        assert_eq!(fixture["policy"], *policy());
        assert_eq!(
            fixture["policy_sha256"],
            memory::hash_value(policy()).unwrap()
        );
        validate_snapshot(&fixture["snapshot"], &fixture["evidence"]).unwrap();
        validate_reviews(
            &fixture["reviews"],
            Some(&fixture["snapshot"]),
            Some(&fixture["evidence"]),
            "task-fictional",
            "version-fictional",
        )
        .unwrap();
        for vector in fixture["decimal_vectors"].as_array().unwrap() {
            let raw = vector["source"].as_str().unwrap();
            let expected = vector["rounded"]
                .as_str()
                .or_else(|| vector["expected"].as_str())
                .unwrap();
            let number = decimal::Decimal::parse(raw).unwrap();
            assert_eq!(
                number
                    .rounded(vector["places"].as_u64().unwrap() as usize)
                    .unwrap(),
                expected
            );
        }
        for vector in fixture["span_vectors"].as_array().unwrap() {
            let section = vector["section"].as_str().unwrap();
            assert_eq!(
                spans::supported(section, &vector["span"]).unwrap(),
                vector["supported"].as_bool().unwrap(),
                "{section}"
            );
        }
        for case in fixture["cases"].as_array().unwrap() {
            validate_review(
                &case["review"],
                &case["snapshot"],
                &case["evidence"],
                "task-fictional",
                "version-fictional",
            )
            .unwrap_or_else(|_| panic!("shared numeric case failed: {}", case["name"]));
        }
    }

    #[test]
    fn coherently_rehashed_results_and_cross_record_bindings_are_rejected() {
        let fixture = test_support::fixture();
        for pointer in [
            "/result/rounded_decimal",
            "/operand/raw_number_lexeme",
            "/result/reason",
            "/result/source_context/instrument",
            "/operand/provider",
            "/target/section_utf8_sha256",
        ] {
            let mut review = fixture["reviews"][0].clone();
            *review.pointer_mut(pointer).unwrap() = json!("forged");
            test_support::rehash(&mut review, "review_sha256");
            assert!(
                validate_review(
                    &review,
                    &fixture["snapshot"],
                    &fixture["evidence"],
                    "task-fictional",
                    "version-fictional"
                )
                .is_err(),
                "{pointer}"
            );
        }
        let mut review = fixture["reviews"][0].clone();
        review["operand"]["source_index"] = json!(1);
        test_support::rehash(&mut review, "review_sha256");
        assert!(validate_review(
            &review,
            &fixture["snapshot"],
            &fixture["evidence"],
            "task-fictional",
            "version-fictional"
        )
        .is_err());
        let mut snapshot = fixture["snapshot"].clone();
        snapshot["captured_at"] = json!("2026-01-09T00:00:00.000000Z");
        test_support::rehash(&mut snapshot, "snapshot_sha256");
        assert!(validate_snapshot(&snapshot, &fixture["evidence"]).is_err());
        assert!(validate_snapshot_binding(
            &fixture["snapshot"],
            &fixture["evidence"],
            None,
            "OTHER",
            "2026-01-09",
            &fixture["snapshot"]["report_sections"]
        )
        .is_err());
        let mut reports = fixture["snapshot"]["report_sections"].clone();
        reports["market_report"] = json!("Edited report");
        assert!(validate_snapshot_binding(
            &fixture["snapshot"],
            &fixture["evidence"],
            None,
            "FICT",
            "2026-01-09",
            &reports
        )
        .is_err());
    }

    #[test]
    fn numeric_batch_cache_keeps_record_source_selector_and_receipt_checks_independent() {
        let fixture = test_support::fixture();
        let mut evidence = fixture["evidence"].clone();
        let first_id = evidence["records"][0]["id"].as_str().unwrap().to_string();
        let second_id = format!("ev-{}", "b".repeat(32));
        let mut second_source = evidence["records"][0]["sources"][0].clone();
        second_source["provider"] = json!("tencent");
        evidence["records"][0]["sources"]
            .as_array_mut()
            .unwrap()
            .push(second_source);
        let mut record = evidence["records"][0].clone();
        record["id"] = second_id.clone().into();
        record["sources"].as_array_mut().unwrap().truncate(1);
        record["sources"][0]["provider"] = json!("eastmoney");
        record["sources"][0]["units"] = json!("EUR/share");
        let mut output = evidence["artifacts"][record["output_sha256"].as_str().unwrap()].clone();
        output["payload"] = output["payload"]
            .as_str()
            .unwrap()
            .replacen(&first_id, &second_id, 1)
            .into();
        let output_hash = memory::hash_value(&output).unwrap();
        evidence["artifacts"][&output_hash] = output;
        record["output_sha256"] = output_hash.into();
        evidence["records"].as_array_mut().unwrap().push(record);
        test_support::rehash(&mut evidence, "bundle_sha256");
        let mut snapshot = fixture["snapshot"].clone();
        snapshot["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
        test_support::rehash(&mut snapshot, "snapshot_sha256");
        let mut first = fixture["reviews"][0].clone();
        first["target"]["report_snapshot_sha256"] = snapshot["snapshot_sha256"].clone();
        test_support::rehash(&mut first, "review_sha256");
        let mut second = first.clone();
        second["review_id"] = json!("22222222-2222-4222-8222-222222222222");
        second["previous_review_sha256"] = first["review_sha256"].clone();
        second["operand"]["source_index"] = json!(1);
        second["operand"]["provider"] = json!("tencent");
        second["result"]["source_context"]["provider"] = json!("tencent");
        test_support::rehash(&mut second, "review_sha256");
        let mut third = first.clone();
        third["review_id"] = json!("33333333-3333-4333-8333-333333333333");
        third["previous_review_sha256"] = second["review_sha256"].clone();
        third["operand"]["evidence_id"] = second_id.into();
        third["operand"]["provider"] = json!("eastmoney");
        third["result"]["source_context"]["provider"] = json!("eastmoney");
        third["result"]["source_context"]["units"] = json!("EUR/share");
        test_support::rehash(&mut third, "review_sha256");
        let history = json!([first, second, third]);
        validate_reviews(
            &history,
            Some(&snapshot),
            Some(&evidence),
            "task-fictional",
            "version-fictional",
        )
        .unwrap();
        // All use the same exact saved number but have independently bound metadata.
        for (pointer, value) in [
            ("/operand/source_index", json!(0)),
            ("/operand/selector/field", json!("TieOne")),
            ("/operand/selector/row_date", json!("2026-01-07")),
            ("/operand/selector/table_path", json!(["latest_ohlcv"])),
            ("/result/reason", json!("value_mismatch")),
            ("/target/task_id", json!("other-owner")),
            ("/previous_review_sha256", Value::Null),
        ] {
            let mut wrong = json!([history[0].clone(), history[1].clone()]);
            *wrong[1].pointer_mut(pointer).unwrap() = value;
            test_support::rehash(&mut wrong[1], "review_sha256");
            assert!(
                validate_reviews(
                    &wrong,
                    Some(&snapshot),
                    Some(&evidence),
                    "task-fictional",
                    "version-fictional"
                )
                .is_err(),
                "{pointer}"
            );
        }
        let mut wrong = history.clone();
        wrong[2]["operand"]["evidence_id"] = history[0]["operand"]["evidence_id"].clone();
        test_support::rehash(&mut wrong[2], "review_sha256");
        assert!(validate_reviews(
            &wrong,
            Some(&snapshot),
            Some(&evidence),
            "task-fictional",
            "version-fictional"
        )
        .is_err());
    }

    #[test]
    fn numeric_batch_preparation_is_not_shared_across_operations() {
        let fixture = test_support::fixture();
        let first = json!([fixture["reviews"][0].clone()]);
        validate_reviews(
            &first,
            Some(&fixture["snapshot"]),
            Some(&fixture["evidence"]),
            "task-fictional",
            "version-fictional",
        )
        .unwrap();
        let mut evidence = fixture["evidence"].clone();
        let old_hash = evidence["records"][0]["sources"][0]["data_sha256"]
            .as_str()
            .unwrap()
            .to_string();
        let mut artifact = evidence["artifacts"][&old_hash].clone();
        artifact["payload"] = artifact["payload"]
            .as_str()
            .unwrap()
            .replace("125.02345678901236", "126.02345678901236")
            .into();
        let hash = memory::hash_value(&artifact).unwrap();
        evidence["artifacts"]
            .as_object_mut()
            .unwrap()
            .remove(&old_hash);
        evidence["artifacts"][&hash] = artifact;
        evidence["records"][0]["sources"][0]["data_sha256"] = hash.clone().into();
        test_support::rehash(&mut evidence, "bundle_sha256");
        let mut snapshot = fixture["snapshot"].clone();
        snapshot["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
        test_support::rehash(&mut snapshot, "snapshot_sha256");
        let mut changed = first.clone();
        changed[0]["target"]["report_snapshot_sha256"] = snapshot["snapshot_sha256"].clone();
        changed[0]["operand"]["data_sha256"] = hash.into();
        test_support::rehash(&mut changed[0], "review_sha256");
        // Coherent new parent hashes cannot reuse the preceding operation's match.
        assert!(validate_reviews(
            &changed,
            Some(&snapshot),
            Some(&evidence),
            "task-fictional",
            "version-fictional"
        )
        .is_err());
        changed[0]["operand"]["raw_number_lexeme"] = json!("126.02345678901236");
        changed[0]["result"]["rounded_decimal"] = json!("126.02");
        changed[0]["result"]["status"] = json!("mismatch");
        changed[0]["result"]["reason"] = json!("value_mismatch");
        test_support::rehash(&mut changed[0], "review_sha256");
        validate_reviews(
            &changed,
            Some(&snapshot),
            Some(&evidence),
            "task-fictional",
            "version-fictional",
        )
        .unwrap();
        validate_reviews(
            &first,
            Some(&fixture["snapshot"]),
            Some(&fixture["evidence"]),
            "task-fictional",
            "version-fictional",
        )
        .unwrap();
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn fixture() -> Value {
        memory::parse_json(include_str!("../../tests/fixtures/numeric_review_v1.json")).unwrap()
    }
    pub fn rehash(value: &mut Value, own_hash: &str) {
        value[own_hash] = memory::hash_component(value, own_hash).unwrap().into();
    }
}
