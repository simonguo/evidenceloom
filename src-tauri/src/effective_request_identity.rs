//! Saved outer selectors are compared independently; provider identity stays unknown.
use crate::{evidence, numeric_review as numeric, research_memory as memory};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub const ERROR: &str = "Invalid or conflicting effective outer-request assessment";
pub const POLICY_SHA256: &str = "933c826dc91d445488363e984acb5b66a5082fe548efbc4cfe930a7e71b5aa23";
type Result<T> = std::result::Result<T, String>;
const ALIGNMENTS: &[&str] = &[
    "consistent",
    "conflict",
    "unknown",
    "proxy",
    "not_applicable",
];
fn ensure(condition: bool) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(ERROR.into())
    }
}
fn text(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| ERROR.into())
}
fn policy() -> &'static Value {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| {
        memory::parse_json(include_str!(
            "../../docs/contracts/effective_request_identity_policy_v1.json"
        ))
        .expect("frozen request policy")
    })
}
fn normalized(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    if text.len() > 256 {
        return None;
    }
    let text = text
        .trim_matches([' ', '\t', '\r', '\n', '\x0c', '\x0b'])
        .to_ascii_uppercase();
    (!text.is_empty()).then_some(text)
}
fn mainland(value: &str) -> Option<(String, String)> {
    static MAINLAND: OnceLock<Regex> = OnceLock::new();
    let captures = MAINLAND
        .get_or_init(|| Regex::new(r"\A(?:(SH|SZ)([0-9]{6})|([0-9]{6})\.(SH|SS|SZ))\z").unwrap())
        .captures(value)?;
    let venue = captures.get(1).or_else(|| captures.get(4))?.as_str();
    let code = captures.get(2).or_else(|| captures.get(3))?.as_str();
    Some((if venue == "SS" { "SH" } else { venue }.into(), code.into()))
}
fn hk(value: &str) -> Option<String> {
    let code = value.strip_suffix(".HK")?;
    if !(1..=4).contains(&code.len()) || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(format!("{code:0>4}"))
}
fn qualified(value: &str) -> Option<(String, String)> {
    mainland(value).or_else(|| hk(value).map(|code| ("HK".into(), code)))
}
fn pair(value: &str) -> Option<(String, String)> {
    let value = value.strip_suffix("=X").unwrap_or(value);
    for quote in policy()["currency_codes"].as_array()? {
        let quote = quote.as_str()?;
        for base in policy()["currency_codes"]
            .as_array()?
            .iter()
            .chain(policy()["crypto_bases"].as_array()?.iter())
        {
            let base = base.as_str()?;
            if value == format!("{base}{quote}") || value == format!("{base}-{quote}") {
                return Some((base.into(), quote.into()));
            }
        }
    }
    None
}
type Relation = (&'static str, &'static str, &'static str, Option<String>);
fn relation(expected: Option<&str>, selected: Option<&str>) -> Relation {
    let (Some(expected), Some(selected)) = (expected, selected) else {
        return (
            "unknown",
            "effective_request_unusable",
            "no_proved_effective_selector",
            None,
        );
    };
    if expected == selected {
        return (
            "consistent",
            "effective_request_aligned",
            if expected.is_ascii() {
                "ascii_literal"
            } else {
                "exact_preserved_literal"
            },
            None,
        );
    }
    let proxies = &policy()["proxy_pairs"];
    if proxies[expected] == selected || proxies[selected] == expected {
        return (
            "proxy",
            "declared_proxy_reference",
            "explicit_yahoo_reference_pair",
            None,
        );
    }
    let a = qualified(expected);
    let b = qualified(selected);
    if let (Some(a), Some(b)) = (&a, &b) {
        if a == b {
            return (
                "consistent",
                "effective_request_aligned",
                if a.0 == "HK" {
                    "hk_explicit_suffix_padding_v1"
                } else {
                    "mainland_explicit_venue_v1"
                },
                Some(a.0.clone()),
            );
        }
        if a.1 == b.1 && a.0 != b.0 {
            return (
                "conflict",
                "explicit_venue_conflict",
                "mainland_explicit_venue_v1",
                None,
            );
        }
    }
    for (bare, qualified) in [(expected, &b), (selected, &a)] {
        if let Some((venue, code)) = qualified {
            if (1..=6).contains(&bare.len()) && bare.bytes().all(|byte| byte.is_ascii_digit()) {
                let bare_code = if venue == "HK" && bare.len() <= 4 {
                    format!("{bare:0>4}")
                } else {
                    bare.into()
                };
                if bare_code == *code {
                    return (
                        "unknown",
                        "unqualified_venue",
                        "no_bare_venue_inference",
                        None,
                    );
                }
            }
        }
    }
    if !expected.is_ascii() || !selected.is_ascii() {
        return (
            "unknown",
            "unreviewed_identifier_relation",
            "no_unicode_normalization",
            None,
        );
    }
    if expected.contains('+') || selected.contains('+') {
        return (
            "unknown",
            "unreviewed_identifier_relation",
            "unsupported_broker_qualifier",
            None,
        );
    }
    if [expected, selected]
        .iter()
        .any(|value| value.ends_with(".HK") && hk(value).is_none())
    {
        return (
            "unknown",
            "unreviewed_identifier_relation",
            "outside_reviewed_hk_rule",
            None,
        );
    }
    if [expected, selected].iter().any(|value| {
        [".SH", ".SS", ".SZ"]
            .iter()
            .any(|suffix| value.ends_with(suffix))
            && mainland(value).is_none()
    }) {
        return (
            "unknown",
            "unreviewed_identifier_relation",
            "malformed_qualified_identifier",
            None,
        );
    }
    if pair(expected).is_some() && pair(expected) == pair(selected) {
        return (
            "unknown",
            "unreviewed_identifier_relation",
            "pair_namespace_not_captured",
            None,
        );
    }
    for (discussion, pair_text) in [(expected, selected), (selected, expected)] {
        if let (Some(base), Some(parts)) = (discussion.strip_suffix(".X"), pair(pair_text)) {
            if base == parts.0 {
                return (
                    "unknown",
                    "unreviewed_identifier_relation",
                    "discussion_namespace_not_captured",
                    None,
                );
            }
        }
    }
    static PLAIN: OnceLock<Regex> = OnceLock::new();
    let plain = PLAIN.get_or_init(|| Regex::new(r"\A\^?[A-Z0-9][A-Z0-9._=-]{0,63}\z").unwrap());
    if plain.is_match(expected) && plain.is_match(selected) {
        return (
            "conflict",
            "effective_request_conflict",
            "different_saved_ascii_literal",
            None,
        );
    }
    (
        "unknown",
        "unreviewed_identifier_relation",
        "unsupported_identifier_notation",
        None,
    )
}
fn assess_selector(instrument: &Value, tool: &Value, parameters: &Value) -> Result<Value> {
    let tool_name = text(tool)?;
    let scope = policy()["tool_scopes"].get(tool_name).ok_or(ERROR)?;
    let parameters = parameters.as_object().ok_or(ERROR)?;
    let selector = scope["selector"].as_str();
    let mut extras: Vec<&str> = ["instrument", "symbol", "ticker"]
        .into_iter()
        .filter(|key| Some(*key) != selector && parameters.contains_key(*key))
        .collect();
    if scope["content_scope"] == "legacy_tool_scope_unknown" {
        extras.clear();
    }
    let (alignment, reason, rule, venue) = if scope["content_scope"] == "global_query" {
        (
            "not_applicable",
            "global_query_not_instrument_scoped",
            "global_query",
            None,
        )
    } else if selector.is_none() {
        (
            "unknown",
            "legacy_tool_scope_unknown",
            "legacy_unknown",
            None,
        )
    } else if !parameters.contains_key(selector.ok_or(ERROR)?) {
        (
            "unknown",
            "effective_request_missing",
            "no_proved_effective_selector",
            None,
        )
    } else {
        relation(
            normalized(instrument).as_deref(),
            normalized(&parameters[selector.ok_or(ERROR)?]).as_deref(),
        )
    };
    let ambiguous = !extras.is_empty() && alignment != "conflict";
    Ok(
        json!({"tool":tool,"content_scope":scope["content_scope"],"canonical_selector_key":scope["selector"],
        "canonical_alignment":alignment,"canonical_reason":reason,"canonical_rule":rule,
        "record_alignment":if ambiguous {"unknown"} else {alignment},
        "record_reason":if ambiguous {"unexpected_selector_metadata"} else {reason},
        "venue":venue,"unexpected_selector_keys":extras}),
    )
}
fn unsafe_record(record: &Value) -> bool {
    record["content_scope"] != "global_query"
        && matches!(
            record["record_alignment"].as_str(),
            Some("conflict" | "unknown" | "proxy")
        )
}
fn derive_records(bundle: &Value) -> Result<Vec<Value>> {
    let mut records: Vec<_> = bundle["records"].as_array().ok_or(ERROR)?.iter().collect();
    ensure(records.len() <= 100_000)?;
    records.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    records
        .into_iter()
        .map(|record| {
            let mut projection = assess_selector(
                &bundle["instrument"],
                &record["tool"],
                &record["parameters"],
            )?;
            let sources = record["sources"].as_array().ok_or(ERROR)?;
            ensure(sources.len() <= 10_000)?;
            projection["evidence_id"] = record["id"].clone();
            projection["sources"] = Value::Array(
                sources
                    .iter()
                    .enumerate()
                    .map(|(index, source)| {
                        json!({
            "source_index":index,"provider":source["provider"],"data_sha256":source["data_sha256"],
            "provider_request":"unknown","provider_entity":"unknown"})
                    })
                    .collect(),
            );
            Ok(projection)
        })
        .collect()
}
fn reviewed_timestamp(value: &Value) -> Result<i64> {
    let value_text = text(value)?;
    ensure(value_text.len() == 27 && value_text.as_bytes()[19] == b'.')?;
    memory::timestamp(value).map_err(|_| ERROR.into())
}
fn derive_assessment(bundle: &Value, snapshot: &Value, reviewed_at: &Value) -> Result<Value> {
    ensure(reviewed_timestamp(reviewed_at)? >= reviewed_timestamp(&snapshot["captured_at"])?)?;
    let records = derive_records(bundle)?;
    let mut summary = json!({"record_count":records.len(),"source_count":records.iter().map(|record|record["sources"].as_array().map_or(0,Vec::len)).sum::<usize>()});
    for alignment in ALIGNMENTS {
        summary[format!("{alignment}_count")] = json!(records
            .iter()
            .filter(|record| record["record_alignment"] == *alignment)
            .count());
    }
    summary["unsafe_record_ids"] = json!(records
        .iter()
        .filter(|record| unsafe_record(record))
        .map(|record| record["evidence_id"].clone())
        .collect::<Vec<_>>());
    let mut value = json!({"schema_version":1,"scope":policy()["scope"],"policy_version":policy()["policy_version"],
        "policy_sha256":memory::hash_value(policy()).map_err(|_|ERROR)?,"run_id":bundle["run_id"],"instrument":bundle["instrument"],
        "analysis_date":bundle["analysis_date"],"evidence_bundle_sha256":bundle["bundle_sha256"],"report_snapshot_sha256":snapshot["snapshot_sha256"],
        "reviewed_at":reviewed_at,"records":records,"summary":summary});
    value["assessment_sha256"] =
        json!(memory::hash_component(&value, "assessment_sha256").map_err(|_| ERROR)?);
    Ok(value)
}
pub fn validate_receipt(value: &Value, bundle: &Value, snapshot: &Value) -> Result<()> {
    memory::bounded(value).map_err(|_| ERROR)?;
    evidence::validate_bundle(bundle, None).map_err(|_| ERROR)?;
    numeric::validate_snapshot(snapshot, bundle).map_err(|_| ERROR)?;
    let expected = derive_assessment(bundle, snapshot, &value["reviewed_at"])?;
    if let Some(marker) = bundle["manifest"].get("effective_request_identity_policy_sha256") {
        ensure(*marker == POLICY_SHA256)?;
        if !expected["summary"]["unsafe_record_ids"]
            .as_array()
            .ok_or(ERROR)?
            .is_empty()
        {
            ensure(
                crate::research_readiness::extract_rating(text(
                    &snapshot["report_sections"]["final_trade_decision"],
                )?) == Some("REVIEW"),
            )?;
        }
    }
    ensure(expected == *value)
}
pub fn validate_fields(receipt: Option<&Value>, invalid: Option<&Value>) -> Result<()> {
    ensure(!(receipt.is_some() && invalid.is_some()))?;
    if let Some(receipt) = receipt {
        ensure(receipt.is_object())?;
    }
    if let Some(marker) = invalid {
        let map = marker.as_object().ok_or(ERROR)?;
        ensure(
            map.len() == 2
                && marker["status"] == "invalid"
                && matches!(
                    marker["reason"].as_str(),
                    Some(
                        "malformed"
                            | "hash_mismatch"
                            | "reference_mismatch"
                            | "unsafe_content"
                            | "verification_unavailable"
                    )
                ),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_policy_and_selector_cases() {
        let fixture = memory::parse_json(include_str!(
            "../../tests/fixtures/effective_request_identity_v1.json"
        ))
        .unwrap();
        assert_eq!(fixture["policy"], *policy());
        assert_eq!(
            fixture["policy_sha256"],
            memory::hash_value(policy()).unwrap()
        );
        for case in fixture["cases"].as_array().unwrap() {
            let input = &case["input"];
            let expected = &case["expected"];
            let actual = assess_selector(
                &input["run_instrument"],
                &input["tool"],
                &input["parameters"],
            )
            .unwrap();
            assert_eq!(actual, *expected, "{}", case["name"]);
        }
    }
    fn fixture() -> Value {
        memory::parse_json(include_str!(
            "../../tests/fixtures/effective_request_identity_v1.json"
        ))
        .unwrap()
    }
    fn rehash(value: &mut Value, field: &str) {
        value[field] = json!(memory::hash_component(value, field).unwrap());
    }
    #[test]
    fn full_saved_assessment_preserves_non_head_and_null_sources() {
        let fixture = fixture();
        validate_receipt(
            &fixture["assessment"],
            &fixture["evidence"],
            &fixture["snapshot"],
        )
        .unwrap();
        assert_eq!(
            fixture["assessment"]["records"][0]["sources"][1]["provider"],
            "yfinance"
        );
        assert!(fixture["assessment"]["records"][0]["sources"][2]["data_sha256"].is_null());
    }
    #[test]
    fn coherent_hashes_cannot_hide_conflicts_coverage_or_chronology() {
        let fixture = fixture();
        for attack in 0..12 {
            let mut value = fixture["assessment"].clone();
            match attack {
                0 => {
                    value["records"].as_array_mut().unwrap().remove(1);
                }
                1 => {
                    value["records"][0]["sources"]
                        .as_array_mut()
                        .unwrap()
                        .remove(1);
                }
                2 => value["records"].as_array_mut().unwrap().reverse(),
                3 => {
                    let duplicate = value["records"][0].clone();
                    value["records"].as_array_mut().unwrap().push(duplicate);
                }
                4 => {
                    value["records"][1]["canonical_alignment"] = json!("consistent");
                    value["records"][1]["record_alignment"] = json!("consistent");
                }
                5 => value["records"][0]["sources"][1]["provider_entity"] = json!("confirmed"),
                6 => value["records"][0]["sources"][1]["provider"] = json!("tencent"),
                7 => {
                    value["records"][0]["sources"][2]["data_sha256"] =
                        value["records"][0]["sources"][0]["data_sha256"].clone()
                }
                8 => value["summary"]["unsafe_record_ids"] = json!([]),
                9 => value["reviewed_at"] = json!("2026-01-09T10:59:59.999999Z"),
                10 => value["report_snapshot_sha256"] = json!("0".repeat(64)),
                _ => value["unknown_field"] = json!(true),
            }
            rehash(&mut value, "assessment_sha256");
            assert!(
                validate_receipt(&value, &fixture["evidence"], &fixture["snapshot"]).is_err(),
                "attack {attack}"
            );
        }
    }
    #[test]
    fn marked_unsafe_requests_require_first_authoritative_review_rating() {
        let fixture = fixture();
        let mut evidence = fixture["evidence"].clone();
        evidence["manifest"]["effective_request_identity_policy_sha256"] = json!(POLICY_SHA256);
        evidence["manifest_sha256"] = json!(memory::hash_value(&evidence["manifest"]).unwrap());
        rehash(&mut evidence, "bundle_sha256");
        for (rating, allowed) in [
            ("Rating: REVIEW", true),
            ("Rating: Buy\nRating: REVIEW", false),
            ("Ｒａｔｉｎｇ： Ｂｕｙ\nRating: REVIEW", false),
        ] {
            let mut snapshot = fixture["snapshot"].clone();
            snapshot["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
            snapshot["report_sections"]["final_trade_decision"] = json!(rating);
            rehash(&mut snapshot, "snapshot_sha256");
            let value =
                derive_assessment(&evidence, &snapshot, &fixture["assessment"]["reviewed_at"])
                    .unwrap();
            assert_eq!(
                validate_receipt(&value, &evidence, &snapshot).is_ok(),
                allowed
            );
        }
    }
}
