//! Deterministic input receipts bound to the saved provider evidence.
use crate::{evidence, research_memory as memory};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
#[path = "research_readiness/derive.rs"]
mod derive;
#[path = "research_readiness/market_inputs.rs"]
mod market_inputs;
#[path = "research_readiness/quality.rs"]
mod quality;
#[path = "research_readiness/rating.rs"]
mod rating;
use derive::derive_checks;

pub const ERROR: &str = "Invalid or conflicting research readiness";
type Result<T> = std::result::Result<T, String>;
const ANALYSTS: &[&str] = &["market", "social", "news", "fundamentals"];
pub(crate) const INDICATORS: &[&str] = &[
    "close_10_ema",
    "close_50_sma",
    "close_200_sma",
    "rsi",
    "boll",
    "boll_ub",
    "boll_lb",
    "macd",
    "macds",
    "macdh",
    "atr",
];
const ADVISORY: &[&str] = &["price_vintage", "exchange_calendar_coverage"];
const REASONS: &[&str] = &[
    "historical_availability_unknown",
    "future_analysis_date",
    "market_not_selected",
    "missing_required_verification",
    "provider_unavailable",
    "empty_observations",
    "partial_observations",
    "unknown_source_provenance",
    "verification_quality_unknown",
    "invalid_ohlcv",
    "conflicting_daily_rows",
    "provisional_daily_rows",
    "unknown_bar_completion",
    "insufficient_indicator_history",
    "unsupported_indicator",
    "indicator_calculation_failed",
    "missing_selected_source",
    "unknown_price_basis",
    "unknown_price_vintage",
    "unknown_exchange_calendar",
    "stale_or_unknown_session_coverage",
    "price_basis_conflict",
    "source_withheld",
];
fn ensure(valid: bool) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(ERROR.into())
    }
}
fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>> {
    let map = value.as_object().ok_or(ERROR)?;
    ensure(map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))?;
    Ok(map)
}
fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| ERROR.into())
}
fn list(value: &Value) -> Result<&Vec<Value>> {
    value.as_array().ok_or_else(|| ERROR.into())
}
fn choice(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|text| allowed.contains(&text))
}
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn record_id(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 35
            && text.starts_with("ev-")
            && text[3..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn sorted_unique(value: &Value, valid: impl Fn(&Value) -> bool) -> Result<()> {
    let values = list(value)?;
    ensure(values.iter().all(&valid))?;
    for pair in values.windows(2) {
        ensure(string(&pair[0])? < string(&pair[1])?)?;
    }
    Ok(())
}
fn checked_hash(value: &Value, field: &str) -> Result<()> {
    ensure(
        digest(&value[field])
            && memory::hash_component(value, field).map_err(|_| ERROR)? == value[field],
    )
}
fn required(selected: &Value) -> Result<Vec<String>> {
    let mut keys = vec![
        "temporal_availability".into(),
        "market_verification".into(),
        "indicator_warmup".into(),
    ];
    for analyst in list(selected)? {
        keys.push(format!("selected_sources.{}", string(analyst)?));
    }
    Ok(keys)
}
pub fn validate_policy(value: &Value, analysis_date: &str) -> Result<()> {
    memory::bounded(value).map_err(|_| ERROR)?;
    exact(
        value,
        &[
            "schema_version",
            "policy_version",
            "selected_analysts",
            "required_checks",
            "research_started_at",
            "research_as_of",
            "research_calendar_date",
            "host_utc_offset",
            "temporal_mode",
            "max_tool_rounds",
            "max_complete_row_age_days",
            "required_indicators",
            "policy_sha256",
        ],
    )?;
    ensure(value["schema_version"] == 1 && value["policy_version"] == "research-readiness-v1")?;
    let selected = list(&value["selected_analysts"])?;
    let unique: BTreeSet<_> = selected.iter().filter_map(Value::as_str).collect();
    ensure(
        !selected.is_empty()
            && selected.len() == unique.len()
            && selected.iter().all(|analyst| choice(analyst, ANALYSTS)),
    )?;
    ensure(value["required_checks"] == json!(required(&value["selected_analysts"])?))?;
    let started = memory::timestamp(&value["research_started_at"]).map_err(|_| ERROR)?;
    ensure(string(&value["research_started_at"])?.len() == 27)?;
    ensure(value["research_as_of"] == format!("{analysis_date}T23:59:59.999999Z"))?;
    memory::timestamp(&value["research_as_of"]).map_err(|_| ERROR)?;
    let offset = memory::offset(&value["host_utc_offset"]).map_err(|_| ERROR)?;
    ensure(offset.abs() <= 14 * 60 && value["host_utc_offset"] != "-00:00")?;
    let calendar = string(&value["research_calendar_date"])?;
    ensure(
        memory::day(calendar)
            == Some((started + offset * 60 * 1_000_000).div_euclid(86_400 * 1_000_000)),
    )?;
    let mode = if analysis_date == calendar {
        "same_host_date"
    } else if analysis_date < calendar {
        "historical_date_only"
    } else {
        "future_date"
    };
    ensure(
        value["temporal_mode"] == mode
            && value["max_tool_rounds"]
                .as_u64()
                .is_some_and(|count| (1..=10000).contains(&count)),
    )?;
    ensure(
        value["max_complete_row_age_days"] == 3
            && value["required_indicators"] == json!(INDICATORS),
    )?;
    checked_hash(value, "policy_sha256")
}

fn data_hashes(record: &Value) -> Vec<String> {
    record["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|source| source["data_sha256"].as_str().map(str::to_string))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}
fn observed_sources<'a>(record: &'a Value, evidence: &Value) -> Vec<&'a Value> {
    record["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|source| {
            if choice(&source["provider"], &["unknown", "local_calculation"])
                || source["historical_availability"] == "withheld"
            {
                return false;
            }
            let Some(hash) = source["data_sha256"].as_str() else {
                return false;
            };
            let Some(raw) = evidence["artifacts"][hash]["payload"].as_str() else {
                return false;
            };
            let Ok(data) = serde_json::from_str::<Value>(raw) else {
                return false;
            };
            if let Some(map) = data.as_object() {
                let collections: Vec<_> = [
                    "rows",
                    "articles",
                    "transactions",
                    "posts",
                    "messages",
                    "values",
                    "fields",
                ]
                .iter()
                .filter_map(|key| map.get(*key))
                .collect();
                if !collections.is_empty() {
                    return collections.iter().any(|value| truthy(value));
                }
            }
            truthy(&data)
        })
        .collect()
}
fn evidence_inputs(evidence: &Value) -> Result<Value> {
    let mut records: Vec<_> = list(&evidence["records"])?.iter().collect();
    records.sort_by_key(|record| record["id"].as_str().unwrap_or_default());
    Ok(json!(records.into_iter().map(|record| json!({"record_id":record["id"],"output_sha256":record["output_sha256"],"data_sha256s":data_hashes(record)})).collect::<Vec<_>>()))
}
fn bind_evidence(value: &Value, evidence: &Value) -> Result<()> {
    ensure(
        value["run_id"] == evidence["run_id"]
            && value["instrument"] == evidence["instrument"]
            && value["analysis_date"] == evidence["analysis_date"]
            && value["policy"]["research_as_of"] == evidence["research_as_of"],
    )?;
    let policy = &value["policy"];
    let manifest = &evidence["manifest"];
    ensure(
        manifest["research_readiness_policy_sha256"] == policy["policy_sha256"]
            && manifest["analysts"] == policy["selected_analysts"]
            && manifest["max_tool_rounds"] == policy["max_tool_rounds"],
    )?;
    ensure(value["evidence_inputs"] == evidence_inputs(evidence)?)
}
pub fn derive_status(checks: &Value) -> Result<&'static str> {
    let unmet: Vec<_> = list(checks)?
        .iter()
        .filter(|check| check["required"] == true && check["status"] != "passed")
        .collect();
    Ok(if unmet.is_empty() {
        "ready"
    } else if unmet
        .iter()
        .any(|check| choice(&check["status"], &["missing", "unavailable", "invalid"]))
    {
        "insufficient_evidence"
    } else {
        "review_required"
    })
}
pub fn validate_receipt(value: &Value, evidence: &Value) -> Result<()> {
    memory::bounded(value).map_err(|_| ERROR)?;
    exact(
        value,
        &[
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "policy",
            "evidence_inputs",
            "checks",
            "status",
            "recommendation_allowed",
            "assessment_sha256",
        ],
    )?;
    ensure(
        value["schema_version"] == 1
            && memory::uuid(string(&value["run_id"])?)
            && !string(&value["instrument"])?.is_empty()
            && memory::day(string(&value["analysis_date"])?).is_some(),
    )?;
    validate_policy(&value["policy"], string(&value["analysis_date"])?)?;
    let inputs = list(&value["evidence_inputs"])?;
    for input in inputs {
        exact(input, &["record_id", "output_sha256", "data_sha256s"])?;
        ensure(record_id(&input["record_id"]) && digest(&input["output_sha256"]))?;
        sorted_unique(&input["data_sha256s"], digest)?;
    }
    sorted_unique(
        &json!(inputs
            .iter()
            .map(|input| input["record_id"].clone())
            .collect::<Vec<_>>()),
        record_id,
    )?;
    let checks = list(&value["checks"])?;
    let required = required(&value["policy"]["selected_analysts"])?;
    let expected: Vec<_> = required
        .iter()
        .map(String::as_str)
        .chain(ADVISORY.iter().copied())
        .collect();
    ensure(
        checks
            .iter()
            .map(|check| check["key"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            == expected,
    )?;
    for check in checks {
        exact(
            check,
            &[
                "key",
                "required",
                "status",
                "reason_codes",
                "evidence_ids",
                "artifact_sha256s",
            ],
        )?;
        ensure(
            check["required"] == required.iter().any(|key| check["key"] == *key)
                && choice(
                    &check["status"],
                    &[
                        "passed",
                        "missing",
                        "unavailable",
                        "partial",
                        "invalid",
                        "not_selected",
                        "unknown",
                    ],
                ),
        )?;
        sorted_unique(&check["reason_codes"], |reason| choice(reason, REASONS))?;
        sorted_unique(&check["evidence_ids"], record_id)?;
        sorted_unique(&check["artifact_sha256s"], digest)?;
    }
    ensure(
        value["status"] == derive_status(&value["checks"])?
            && value["recommendation_allowed"] == (value["status"] == "ready"),
    )?;
    checked_hash(value, "assessment_sha256")?;
    evidence::validate_bundle(evidence, None).map_err(|_| ERROR)?;
    bind_evidence(value, evidence)?;
    ensure(value["checks"] == derive_checks(&value["policy"], evidence)?)
}

pub fn validate_fields(receipt: Option<&Value>, marker: Option<&Value>) -> Result<()> {
    if let Some(marker) = marker {
        memory::validate_invalid(marker).map_err(|_| ERROR)?;
        ensure(receipt.is_none())?;
    }
    Ok(())
}

pub struct SnapshotBinding<'a> {
    pub ticker: &'a str,
    pub analysis_date: &'a str,
    pub analysts: &'a Value,
    pub run_id: Option<&'a str>,
    pub completed: bool,
    pub decision: &'a str,
    pub reports: &'a Value,
    pub memory: Option<&'a Value>,
}
pub fn validate_snapshot(
    value: &Value,
    evidence: Option<&Value>,
    binding: SnapshotBinding<'_>,
) -> Result<()> {
    validate_receipt(value, evidence.ok_or(ERROR)?)?;
    ensure(
        value["instrument"] == binding.ticker
            && value["analysis_date"] == binding.analysis_date
            && value["policy"]["selected_analysts"] == *binding.analysts
            && binding
                .run_id
                .is_none_or(|run_id| value["run_id"] == run_id),
    )?;
    let allowed = value["recommendation_allowed"] == true;
    if let Some(memory) = binding.memory {
        let decision = &memory["decision_snapshot"]["decision"];
        ensure(
            value["run_id"] == memory["run_id"]
                && memory::timestamp(&value["policy"]["research_started_at"]).map_err(|_| ERROR)?
                    == memory::timestamp(&decision["research_started_at"]).map_err(|_| ERROR)?
                && value["policy"]["research_calendar_date"] == decision["analysis_calendar_date"]
                && value["policy"]["host_utc_offset"] == decision["host_utc_offset"],
        )?;
        if !allowed {
            ensure(decision["rating"] == "REVIEW")?;
        }
    }
    if !allowed && binding.completed {
        ensure(
            binding.decision == "REVIEW"
                && rating::extract(string(&binding.reports["final_trade_decision"])?)
                    == Some("REVIEW"),
        )?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn receipt() -> Value {
        memory::parse_json(include_str!(
            "../../tests/fixtures/research_readiness_v1.json"
        ))
        .unwrap()
    }
    pub fn evidence() -> Value {
        memory::parse_json(include_str!(
            "../../tests/fixtures/research_readiness_evidence_v1.json"
        ))
        .unwrap()
    }
    pub fn rehash(value: &mut Value, field: &str) {
        value[field] = memory::hash_component(value, field).unwrap().into();
    }
    pub fn rehash_evidence(value: &mut Value) {
        value["manifest_sha256"] = evidence::canonical_hash(&value["manifest"]).unwrap().into();
        rehash(value, "bundle_sha256");
    }
    pub fn assess(evidence: &Value, policy: &Value) -> Value {
        let checks = derive_checks(policy, evidence).unwrap();
        let status = derive_status(&checks).unwrap();
        let mut result = json!({"schema_version":1,"run_id":evidence["run_id"],"instrument":evidence["instrument"],"analysis_date":evidence["analysis_date"],"policy":policy,"evidence_inputs":evidence_inputs(evidence).unwrap(),"checks":checks,"status":status,"recommendation_allowed":status=="ready"});
        rehash(&mut result, "assessment_sha256");
        result
    }
    pub fn mutate_quality(evidence: &mut Value, mutate: impl FnOnce(&mut Value)) {
        let (old_hash, mut artifact, mut quality) = evidence["artifacts"]
            .as_object()
            .unwrap()
            .iter()
            .find_map(|(hash, artifact)| {
                if artifact["kind"] != "normalized_data" {
                    return None;
                }
                let quality = memory::parse_json(artifact["payload"].as_str().unwrap()).unwrap();
                (quality["kind"] == "market_verification_quality")
                    .then(|| (hash.clone(), artifact.clone(), quality))
            })
            .unwrap();
        mutate(&mut quality);
        artifact["payload"] = memory::canonical_json(&quality).unwrap().into();
        let new_hash = evidence::canonical_hash(&artifact).unwrap();
        evidence["artifacts"]
            .as_object_mut()
            .unwrap()
            .remove(&old_hash);
        evidence["artifacts"]
            .as_object_mut()
            .unwrap()
            .insert(new_hash.clone(), artifact);
        for record in evidence["records"].as_array_mut().unwrap() {
            for source in record["sources"].as_array_mut().unwrap() {
                if source["data_sha256"] == old_hash {
                    source["data_sha256"] = new_hash.clone().into();
                }
            }
        }
        rehash_evidence(evidence);
    }
    pub fn mutate_provider_table(evidence: &mut Value, mutate: impl FnOnce(&mut Value)) {
        let old_hash = evidence["records"][0]["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["provider"] == "yfinance")
            .unwrap()["data_sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut artifact = evidence["artifacts"][&old_hash].clone();
        let mut table = memory::parse_json(artifact["payload"].as_str().unwrap()).unwrap();
        mutate(&mut table);
        artifact["payload"] = memory::canonical_json(&table).unwrap().into();
        let hash = evidence::canonical_hash(&artifact).unwrap();
        let artifacts = evidence["artifacts"].as_object_mut().unwrap();
        artifacts.remove(&old_hash);
        artifacts.insert(hash.clone(), artifact);
        for record in evidence["records"].as_array_mut().unwrap() {
            for source in record["sources"].as_array_mut().unwrap() {
                if source["data_sha256"] == old_hash {
                    source["data_sha256"] = hash.clone().into();
                }
            }
        }
        rehash_evidence(evidence);
    }
    pub fn false_ready(evidence: &Value, policy: &Value) -> Value {
        let mut value = assess(evidence, policy);
        for check in value["checks"].as_array_mut().unwrap() {
            if check["required"] == true {
                check["status"] = "passed".into();
                check["reason_codes"] = json!([]);
            }
        }
        value["status"] = "ready".into();
        value["recommendation_allowed"] = true.into();
        rehash(&mut value, "assessment_sha256");
        value
    }
}

#[cfg(test)]
mod tests {
    use super::{test_support::*, *};
    #[test]
    fn python_ready_fixture_is_exactly_derived_and_payloads_remain_opaque() {
        let saved = receipt();
        let evidence = evidence();
        assert_eq!(assess(&evidence, &saved["policy"]), saved);
        validate_receipt(&saved, &evidence).unwrap();
        let source = evidence["artifacts"]
            .as_object()
            .unwrap()
            .values()
            .find(|artifact| {
                artifact["kind"] == "normalized_data"
                    && artifact["payload"]
                        .as_str()
                        .unwrap()
                        .contains("124.07345678901234")
            })
            .unwrap();
        assert!(source["payload"].as_str().unwrap().contains("4.0"));
        assert!(source["payload"]
            .as_str()
            .unwrap()
            .contains("4.7720792539784895e-08"));
        assert_eq!(saved["checks"][4]["status"], "unknown");
    }
    #[test]
    fn rehashed_false_ready_cannot_override_invalid_rows_warmup_and_unknown_inputs() {
        for mode in [
            "invalid",
            "conflict",
            "warmup",
            "unsupported",
            "failed",
            "basis",
            "stale",
            "timezone",
            "malformed",
            "future_observation",
            "completion",
            "convention",
            "in_window",
        ] {
            let mut evidence = evidence();
            let saved = receipt();
            mutate_quality(&mut evidence, |quality| match mode {
                "invalid" => {
                    quality["rows"]["received"] = 251.into();
                    quality["rows"]["invalid"] = 1.into();
                    quality["integrity_status"] = "invalid".into();
                    quality["issues"] = json!(["incoherent_ohlc"]);
                }
                "conflict" => {
                    quality["rows"]["received"] = 252.into();
                    quality["rows"]["invalid"] = 2.into();
                    quality["rows"]["conflicting_duplicate_dates"] = json!(["2026-01-08"]);
                    quality["integrity_status"] = "invalid".into();
                    quality["issues"] = json!(["conflicting_duplicate_date"]);
                }
                "warmup" => {
                    for key in ["valid", "usable_complete"] {
                        quality["rows"][key] = 100.into();
                    }
                    for item in quality["indicator_assessments"]
                        .as_object_mut()
                        .unwrap()
                        .values_mut()
                    {
                        item["usable_rows"] = 100.into();
                    }
                    quality["indicator_assessments"]["close_200_sma"]["status"] =
                        "insufficient_warmup".into();
                    quality["indicator_assessments"]["close_200_sma"]["value"] = Value::Null;
                }
                "unsupported" => {
                    quality["indicator_assessments"]["rsi"]["status"] = "unsupported".into();
                    quality["indicator_assessments"]["rsi"]["value"] = Value::Null;
                }
                "failed" => {
                    quality["indicator_assessments"]["rsi"]["status"] = "calculation_failed".into();
                    quality["indicator_assessments"]["rsi"]["value"] = Value::Null;
                }
                "basis" => quality["price_basis"] = json!({"status":"unknown","value":null}),
                "stale" => {
                    quality["rows"]["latest_received_date"] = "2026-01-04".into();
                    quality["rows"]["latest_usable_date"] = "2026-01-04".into();
                }
                "timezone" => {
                    quality["source_timezone"] = Value::Null;
                    quality["timezone_origin"] = "unknown".into();
                }
                "malformed" => quality["rows"]["valid"] = (-1).into(),
                "future_observation" => {
                    quality["observed_at"] = "2026-01-09T11:00:00.000000Z".into()
                }
                "completion" => quality["completion_status"] = "unknown".into(),
                "convention" => quality["timezone_origin"] = "symbol_market_convention".into(),
                "in_window" => quality["rows"]["in_window"] = 0.into(),
                _ => unreachable!(),
            });
            evidence::validate_bundle(&evidence, None).unwrap();
            let derived = assess(&evidence, &saved["policy"]);
            validate_receipt(&derived, &evidence).unwrap();
            assert_ne!(derived["status"], "ready", "{mode}");
            assert!(
                validate_receipt(&false_ready(&evidence, &saved["policy"]), &evidence).is_err(),
                "{mode}"
            );
            assert!(derived["checks"][1]["reason_codes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|reason| derived["checks"][2]["reason_codes"]
                    .as_array()
                    .unwrap()
                    .contains(reason)));
        }
    }
    #[test]
    fn rehashed_provider_inputs_cannot_preserve_a_ready_quality_claim() {
        let policy = receipt()["policy"].clone();
        for mode in [
            "high",
            "volume",
            "boolean",
            "large",
            "offset",
            "zone",
            "date",
            "source_clock",
            "empty",
        ] {
            let mut evidence = evidence();
            mutate_provider_table(&mut evidence, |table| {
                let columns: Vec<_> = table["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|column| column.as_str().unwrap().to_owned())
                    .collect();
                let index =
                    |field: &str| columns.iter().position(|column| column == field).unwrap();
                match mode {
                    "high" => table["rows"][0][index("High")] = 1.into(),
                    "volume" => table["rows"][0][index("Volume")] = (-1).into(),
                    "boolean" => table["rows"][0][index("Volume")] = true.into(),
                    "large" => {
                        table["rows"][0][index("Open")] = 9_007_199_254_740_993_u64.into();
                        table["rows"][0][index("High")] = 9_007_199_254_740_992_u64.into();
                    }
                    "offset" => table["rows"][0][index("SourceUTCOffset")] = "+00:00".into(),
                    "zone" => table["rows"][0][index("SourceTimezone")] = "america/new_york".into(),
                    "date" => table["rows"][0][index("Date")] = "2026-01-09T00:00:00Z".into(),
                    "source_clock" => {
                        let position = index("SourceTimestamp");
                        table["columns"].as_array_mut().unwrap().remove(position);
                        for row in table["rows"].as_array_mut().unwrap() {
                            row.as_array_mut().unwrap().remove(position);
                        }
                    }
                    "empty" => table["rows"] = json!([]),
                    _ => unreachable!(),
                }
            });
            evidence::validate_bundle(&evidence, None).unwrap();
            let before = evidence.clone();
            let derived = assess(&evidence, &policy);
            validate_receipt(&derived, &evidence).unwrap();
            assert_eq!(derived["checks"][1]["status"], "unknown", "{mode}");
            assert!(
                validate_receipt(&false_ready(&evidence, &policy), &evidence).is_err(),
                "{mode}"
            );
            assert_eq!(before, evidence);
        }
    }
    #[test]
    fn unavailable_empty_partial_and_withheld_receipts_cannot_be_made_ready() {
        for (state, status, reason) in [
            ("unavailable", "unavailable", "provider_unavailable"),
            ("empty", "missing", "empty_observations"),
            ("partial", "partial", "partial_observations"),
            ("withheld", "unavailable", "source_withheld"),
        ] {
            let mut evidence = evidence();
            let saved = receipt();
            evidence["records"][0]["status"] = state.into();
            rehash_evidence(&mut evidence);
            let derived = assess(&evidence, &saved["policy"]);
            validate_receipt(&derived, &evidence).unwrap();
            assert_eq!(derived["checks"][1]["status"], status);
            assert!(derived["checks"][1]["reason_codes"]
                .as_array()
                .unwrap()
                .contains(&json!(reason)));
            assert!(
                validate_receipt(&false_ready(&evidence, &saved["policy"]), &evidence).is_err()
            );
        }
    }
    #[test]
    fn quality_requires_actual_same_record_provider_and_matching_requested_instrument() {
        let saved = receipt();
        for mode in ["provider", "symbol", "date", "local"] {
            let mut evidence = evidence();
            match mode {
                "provider" => mutate_quality(&mut evidence, |quality| {
                    quality["provider"] = "tencent".into()
                }),
                "symbol" => evidence["records"][0]["parameters"]["symbol"] = "OTHER".into(),
                "date" => evidence["records"][0]["parameters"]["curr_date"] = "2026-01-08".into(),
                "local" => {
                    for source in evidence["records"][0]["sources"].as_array_mut().unwrap() {
                        if source["provider"] == "local_calculation" {
                            source["provider"] = "yfinance".into();
                        }
                    }
                }
                _ => unreachable!(),
            }
            rehash_evidence(&mut evidence);
            let derived = assess(&evidence, &saved["policy"]);
            validate_receipt(&derived, &evidence).unwrap();
            assert_ne!(derived["checks"][1]["status"], "passed", "{mode}");
            assert!(
                validate_receipt(&false_ready(&evidence, &saved["policy"]), &evidence).is_err()
            );
        }
    }
    #[test]
    fn manifest_references_identity_policy_and_check_shape_are_strict() {
        let saved = receipt();
        let evidence = evidence();
        for field in ["run_id", "instrument", "analysis_date", "assessment_sha256"] {
            let mut changed = saved.clone();
            changed[field] = "other".into();
            assert!(validate_receipt(&changed, &evidence).is_err());
        }
        let mut changed = saved.clone();
        changed["policy"]["host_utc_offset"] = "+15:00".into();
        rehash(&mut changed["policy"], "policy_sha256");
        rehash(&mut changed, "assessment_sha256");
        assert!(validate_receipt(&changed, &evidence).is_err());
        let mut changed = saved.clone();
        changed["checks"][0]["required"] = false.into();
        rehash(&mut changed, "assessment_sha256");
        assert!(validate_receipt(&changed, &evidence).is_err());
        let mut changed = saved.clone();
        changed["checks"][0]["error"] = "private body".into();
        rehash(&mut changed, "assessment_sha256");
        assert!(validate_receipt(&changed, &evidence).is_err());
        let mut changed = saved.clone();
        changed["policy"]["max_tool_rounds"] = 21.into();
        rehash(&mut changed["policy"], "policy_sha256");
        rehash(&mut changed, "assessment_sha256");
        assert!(validate_receipt(&changed, &evidence).is_err());
        let mut changed = saved.clone();
        changed["evidence_inputs"][0]["data_sha256s"]
            .as_array_mut()
            .unwrap()
            .pop();
        rehash(&mut changed, "assessment_sha256");
        assert!(validate_receipt(&changed, &evidence).is_err());
    }
    #[test]
    fn explicit_invalid_markers_never_coexist_with_a_receipt() {
        let saved = receipt();
        let marker = json!({"status":"invalid","reason":"hash_mismatch"});
        validate_fields(None, Some(&marker)).unwrap();
        assert!(validate_fields(Some(&saved), Some(&marker)).is_err());
        assert!(validate_fields(
            None,
            Some(&json!({"status":"invalid","reason":"hash_mismatch","error":"private body"}))
        )
        .is_err());
    }
}
