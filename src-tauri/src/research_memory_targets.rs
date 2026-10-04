//! Frozen Yahoo request syntax and reference checks, never arithmetic certification.
use super::*;
use serde_json::value::RawValue;
use std::collections::BTreeMap;

const POLICY_SHA: &str = "b76b4c71e3dd367e356e9762cb656628f174241607e00d99c7dfa5f75cbebfc2";
const PROVIDER: &str = "yfinance";
const NAMESPACE: &str = "yahoo_finance_ticker";

fn policy() -> Result<Value, String> {
    parse_json(include_str!(
        "../../docs/contracts/memory_target_policy_v1.json"
    ))
}
pub(super) fn policy_artifact() -> Result<Value, String> {
    let mut artifact =
        serde_json::json!({"kind":"canonical_json", "payload":canonical_json(&policy()?)?});
    artifact["sha256"] = hash_component(&artifact, "sha256")?.into();
    ensure(artifact["sha256"] == POLICY_SHA)?;
    Ok(artifact)
}
fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern)
        .expect("fixed request syntax")
        .is_match(value)
}
fn derive(role: &str, requested: &Value) -> Result<Value, String> {
    let requested = string(requested)?;
    let mut target = serde_json::json!({"role":role,"requested_symbol":requested,"request_symbol":null,"relation":"unknown"});
    let symbol = requested.trim_matches([' ', '\t', '\n', '\r', '\u{000b}', '\u{000c}']);
    if !symbol.is_ascii() {
        return Ok(target);
    }
    let mut symbol = symbol.to_ascii_uppercase();
    if !matches(r"\A[A-Z0-9._^=\-]{1,64}\z", &symbol)
        || symbol.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Ok(target);
    }
    let qualified = matches(r"\A(?:[0-9]{6}\.(?:SH|SS|SZ)|[0-9]{1,4}\.HK)\z", &symbol);
    if ((matches(r"\A[0-9].*\.", &symbol)
        || [".SH", ".SS", ".SZ", ".HK"]
            .iter()
            .any(|suffix| symbol.ends_with(suffix)))
        && !qualified)
        || (matches(r"\A(?:SH|SZ)[0-9]", &symbol) && !matches(r"\A(?:SH|SZ)[0-9]{6}\z", &symbol))
    {
        return Ok(target);
    }
    let policy = policy()?;
    let mut relation = "exact";
    if let Some(proxy) = policy["proxy_aliases"].get(&symbol) {
        symbol = string(proxy)?.into();
        relation = "proxy";
    } else if matches(r"\A[0-9]{6}\.SH\z", &symbol) {
        symbol = format!("{}.SS", &symbol[..6]);
        relation = "venue_notation";
    } else if matches(r"\A(?:SH|SZ)[0-9]{6}\z", &symbol) {
        symbol = format!(
            "{}.{}",
            &symbol[2..],
            if symbol.starts_with("SH") { "SS" } else { "SZ" }
        );
        relation = "venue_notation";
    } else if matches(r"\A[0-9]{1,4}\.HK\z", &symbol) {
        symbol = format!("{:0>4}.HK", &symbol[..symbol.len() - 3]);
        relation = "venue_notation";
    } else if let Some(base) = symbol.strip_suffix("USD") {
        if policy["crypto_bases"]
            .as_array()
            .ok_or(ERROR)?
            .iter()
            .any(|value| value == base)
        {
            symbol = format!("{base}-USD");
            relation = "pair_notation";
        }
    }
    if relation == "exact" && symbol.len() == 6 {
        let currencies = policy["forex_currencies"].as_array().ok_or(ERROR)?;
        if currencies.iter().any(|value| value == &symbol[..3])
            && currencies.iter().any(|value| value == &symbol[3..])
        {
            symbol.push_str("=X");
            relation = "pair_notation";
        }
    }
    target["request_symbol"] = symbol.into();
    target["relation"] = relation.into();
    Ok(target)
}
pub(super) fn validate_binding(value: &Value) -> Check {
    bounded(value)?;
    shape(
        value,
        &[
            "schema_version",
            "research_started_at",
            "provider",
            "request_namespace",
            "adapter_id",
            "adapter_code_sha256",
            "resolver_code_sha256",
            "policy_version",
            "policy_artifact_sha256",
            "targets",
            "binding_sha256",
        ],
    )?;
    version(value)?;
    ensure(
        value["provider"] == PROVIDER
            && value["request_namespace"] == NAMESPACE
            && value["adapter_id"] == "yfinance-ticker-history-direct-v1"
            && value["policy_version"] == "yahoo-evaluation-target-v1"
            && value["policy_artifact_sha256"] == policy_artifact()?["sha256"],
    )?;
    for key in ["adapter_code_sha256", "resolver_code_sha256"] {
        sha(&value[key])?;
    }
    timestamp(&value["research_started_at"])?;
    let targets = value["targets"].as_array().ok_or(ERROR)?;
    ensure(targets.len() == 2)?;
    for (target, role) in targets.iter().zip(["instrument", "benchmark"]) {
        shape(
            target,
            &["role", "requested_symbol", "request_symbol", "relation"],
        )?;
        ensure(*target == derive(role, &target["requested_symbol"])?)?;
    }
    check_hash(value, "binding_sha256")
}

// Parsed values are suitable for reference predicates, but exact raw number
// tokens must participate in shared-observation equality. Preserve booleans and
// null separately; semantic equality through f64 cannot prove identical facts.
#[derive(PartialEq, Debug)]
enum Lexical {
    Null,
    Bool(bool),
    String(String),
    Number(String),
    Array(Vec<Lexical>),
    Object(BTreeMap<String, Lexical>),
}
fn lexical(raw: &RawValue, depth: usize) -> Result<Lexical, String> {
    ensure(depth <= 64)?;
    let text = raw.get();
    Ok(match text.as_bytes().first() {
        Some(b'{') => {
            let values: BTreeMap<String, Box<RawValue>> =
                serde_json::from_str(text).map_err(|_| ERROR)?;
            Lexical::Object(
                values
                    .into_iter()
                    .map(|(key, value)| Ok((key, lexical(&value, depth + 1)?)))
                    .collect::<Result<_, String>>()?,
            )
        }
        Some(b'[') => {
            let values: Vec<Box<RawValue>> = serde_json::from_str(text).map_err(|_| ERROR)?;
            Lexical::Array(
                values
                    .iter()
                    .map(|value| lexical(value, depth + 1))
                    .collect::<Result<_, _>>()?,
            )
        }
        Some(b'"') => Lexical::String(serde_json::from_str(text).map_err(|_| ERROR)?),
        Some(b'-' | b'0'..=b'9') => Lexical::Number(text.into()),
        Some(b't' | b'f') => Lexical::Bool(serde_json::from_str(text).map_err(|_| ERROR)?),
        Some(b'n') => Lexical::Null,
        _ => return Err(ERROR.into()),
    })
}
fn same_request(source: &Value) -> Result<String, String> {
    canonical_json(&serde_json::json!([
        source["provider"],
        source["request_namespace"],
        source["resolved_symbol"],
        source["request_parameters"]
    ]))
}
fn shared_observations(sources: &[Value], payload: &str) -> Check {
    let raw: BTreeMap<String, Box<RawValue>> = serde_json::from_str(payload).map_err(|_| ERROR)?;
    let raw_sources: Vec<Box<RawValue>> =
        serde_json::from_str(raw.get("sources").ok_or(ERROR)?.get()).map_err(|_| ERROR)?;
    ensure(raw_sources.len() == sources.len())?;
    let mut observations = BTreeMap::new();
    for (source, raw) in sources.iter().zip(raw_sources.iter()) {
        let Lexical::Object(mut body) = lexical(raw, 0)? else {
            return Err(ERROR.into());
        };
        for key in ["role", "requested_symbol", "relation"] {
            body.remove(key);
        }
        let key = same_request(source)?;
        if let Some(previous) = observations.get(&key) {
            ensure(previous == &body)?;
        }
        observations.insert(key, body);
    }
    Ok(())
}
pub(super) fn validate_saved_subjects(
    decision: &Value,
    contract: &Value,
    outcome: &Value,
    artifacts: &Value,
) -> Check {
    if outcome.is_null() {
        return Ok(());
    }
    let binding = &contract["target_binding"];
    let targets = binding["targets"].as_array().ok_or(ERROR)?;
    if !outcome["facts_sha256"].is_null() {
        let payload = string(&artifacts[string(&outcome["facts_sha256"])?]["payload"])?;
        let facts = parse_json(payload)?;
        shape(
            &facts,
            &[
                "schema_version",
                "decision_sha256",
                "contract_sha256",
                "observation_cutoff",
                "sources",
                "limitations",
                "target_binding_sha256",
            ],
        )?;
        ensure(
            facts["schema_version"].as_i64() == Some(2)
                && facts["decision_sha256"] == decision["decision_sha256"]
                && facts["contract_sha256"] == contract["contract_sha256"]
                && facts["target_binding_sha256"] == binding["binding_sha256"],
        )?;
        let sources = facts["sources"].as_array().ok_or(ERROR)?;
        ensure(sources.len() == 2)?;
        for (source, target) in sources.iter().zip(targets) {
            shape(
                source,
                &[
                    "role",
                    "provider",
                    "requested_symbol",
                    "resolved_symbol",
                    "request_namespace",
                    "relation",
                    "request_parameters",
                    "observed_at",
                    "timezone",
                    "currency",
                    "publication_at",
                    "price_vintage",
                    "revision",
                    "exchange_calendar_coverage",
                    "rows",
                    "issue",
                ],
            )?;
            ensure(
                source["role"] == target["role"]
                    && source["provider"] == PROVIDER
                    && source["request_namespace"] == NAMESPACE
                    && source["requested_symbol"] == target["requested_symbol"]
                    && source["resolved_symbol"] == target["request_symbol"]
                    && source["relation"] == target["relation"],
            )?;
        }
        shared_observations(sources, payload)?;
    }
    if !outcome["calculation_sha256"].is_null() {
        let calculation = parse_json(string(
            &artifacts[string(&outcome["calculation_sha256"])?]["payload"],
        )?)?;
        shape(
            &calculation,
            &[
                "schema_version",
                "contract_sha256",
                "target_binding_sha256",
                "reference_subjects",
                "entry_after_date",
                "entry_date",
                "exit_date",
                "holding_period_days",
                "holding_period_unit",
                "complete_instrument_dates",
                "complete_benchmark_dates",
                "common_complete_dates",
                "selected_common_dates",
                "endpoints",
                "raw_return",
                "benchmark_return",
                "return_difference",
                "raw_return_formula",
                "benchmark_return_formula",
                "difference_formula",
                "currency_policy",
                "interpretation",
            ],
        )?;
        ensure(
            calculation["schema_version"].as_i64() == Some(2)
                && calculation["contract_sha256"] == contract["contract_sha256"]
                && calculation["target_binding_sha256"] == binding["binding_sha256"]
                && calculation["reference_subjects"] == binding["targets"],
        )?;
        let endpoints = calculation["endpoints"].as_array().ok_or(ERROR)?;
        ensure(endpoints.len() == 2)?;
        for (endpoint, target) in endpoints.iter().zip(targets) {
            shape(endpoint, &["role", "resolved_symbol", "entry", "exit"])?;
            ensure(
                endpoint["role"] == target["role"]
                    && endpoint["resolved_symbol"] == target["request_symbol"],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        parse_json(include_str!(
            "../../tests/fixtures/memory_target_binding_v2.json"
        ))
        .unwrap()
    }
    fn rehash(value: &mut Value, key: &str) {
        value[key] = hash_component(value, key).unwrap().into();
    }
    fn replace_calculation(snapshot: &mut Value, body: Value) {
        let digest = snapshot["outcome"]["calculation_sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        snapshot["artifacts"]
            .as_object_mut()
            .unwrap()
            .remove(&digest);
        let mut artifact =
            serde_json::json!({"kind":"canonical_json","payload":canonical_json(&body).unwrap()});
        rehash(&mut artifact, "sha256");
        snapshot["outcome"]["calculation_sha256"] = artifact["sha256"].clone();
        let digest = artifact["sha256"].as_str().unwrap().to_owned();
        snapshot["artifacts"][digest] = artifact;
        rehash(&mut snapshot["outcome"], "outcome_sha256");
        rehash(snapshot, "snapshot_sha256");
    }
    #[test]
    fn memory_v2_fixture_policy_full_payload_and_legacy_context_references_bind() {
        let value = fixture();
        assert_eq!(value["policy_artifact"], policy_artifact().unwrap());
        validate_bundle_evidence(&value["bundle"], &value["evidence"]).unwrap();
        crate::evidence::validate_bundle(&value["evidence"], None).unwrap();
        validate_decision(&value["available_snapshot"]).unwrap();
        validate_decision(&value["legacy_completed_snapshot"]).unwrap();
        let snapshot = &value["available_snapshot"];
        let payload = snapshot["artifacts"][snapshot["outcome"]["facts_sha256"].as_str().unwrap()]
            ["payload"]
            .as_str()
            .unwrap();
        assert!(payload.contains("123.45678901234567") && payload.contains("1e-07"));
    }
    #[test]
    fn memory_v2_literal_notation_proxy_and_unreviewed_venue_rules_are_distinct() {
        for (raw, request, relation) in [
            ("FICT", Some("FICT"), "exact"),
            ("  fict\t", Some("FICT"), "exact"),
            ("600519.SH", Some("600519.SS"), "venue_notation"),
            ("SH600519", Some("600519.SS"), "venue_notation"),
            ("SZ000001", Some("000001.SZ"), "venue_notation"),
            ("700.HK", Some("0700.HK"), "venue_notation"),
            ("0700.HK", Some("0700.HK"), "venue_notation"),
            ("BTCUSD", Some("BTC-USD"), "pair_notation"),
            ("EURUSD", Some("EURUSD=X"), "pair_notation"),
            ("XAUUSD", Some("GC=F"), "proxy"),
            ("GC=F", Some("GC=F"), "exact"),
            ("000001", None, "unknown"),
            ("12345.SH", None, "unknown"),
            ("12345.HK", None, "unknown"),
            ("SH12345", None, "unknown"),
            ("FICT.HK", None, "unknown"),
            ("１２３", None, "unknown"),
            ("XAUUSD+", None, "unknown"),
        ] {
            let value = derive("instrument", &raw.into()).unwrap();
            assert_eq!(
                value["request_symbol"],
                request.map(Value::from).unwrap_or(Value::Null),
                "{raw}"
            );
            assert_eq!(value["relation"], relation, "{raw}");
            assert_eq!(value["requested_symbol"], raw);
        }
    }
    #[test]
    fn memory_v2_all_shared_target_and_request_collision_vectors_match() {
        let value = fixture();
        let vectors = value["target_vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 30);
        for vector in vectors {
            let target = derive("instrument", &vector["requested_symbol"]).unwrap();
            for key in ["requested_symbol", "request_symbol", "relation"] {
                assert_eq!(target[key], vector[key]);
            }
        }
        let vectors = value["shared_observation_vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 5);
        for vector in vectors {
            let first = derive("instrument", &vector["instrument"]).unwrap();
            let second = derive("benchmark", &vector["benchmark"]).unwrap();
            assert_eq!(first["request_symbol"], vector["request_symbol"]);
            assert_eq!(second["request_symbol"], vector["request_symbol"]);
            assert_eq!(first["relation"], vector["relations"][0]);
            assert_eq!(second["relation"], vector["relations"][1]);
        }
    }
    #[test]
    fn memory_v2_rehashed_false_selector_and_unknown_implementation_are_distinct() {
        for key in ["request_symbol", "relation", "role", "adapter_code_sha256"] {
            let mut value = fixture()["bundle"]["decision_snapshot"].clone();
            if key == "adapter_code_sha256" {
                value["contract"]["target_binding"][key] = "f".repeat(64).into();
                value["contract"]["evaluator_code_sha256"] = "e".repeat(64).into();
            } else {
                value["contract"]["target_binding"]["targets"][0][key] = "OTHER".into();
            }
            rehash(&mut value["contract"]["target_binding"], "binding_sha256");
            rehash(&mut value["contract"], "contract_sha256");
            value["decision"]["contract_sha256"] = value["contract"]["contract_sha256"].clone();
            rehash(&mut value["decision"], "decision_sha256");
            rehash(&mut value, "snapshot_sha256");
            assert_eq!(
                validate_decision(&value).is_ok(),
                key == "adapter_code_sha256"
            );
        }
    }
    #[test]
    fn memory_v2_marker_is_bidirectional_and_missing_completion_needs_diagnostic() {
        let value = fixture();
        let mut unmarked = value["evidence"].clone();
        unmarked["manifest"]
            .as_object_mut()
            .unwrap()
            .remove("memory_target_binding_sha256");
        assert!(validate_bundle_evidence(&value["bundle"], &unmarked).is_err());
        let legacy = super::super::test_support::bundle();
        let mut marked = super::super::test_support::evidence();
        marked["manifest"]["memory_target_binding_sha256"] = value["bundle"]["decision_snapshot"]
            ["contract"]["target_binding"]["binding_sha256"]
            .clone();
        assert!(validate_bundle_evidence(&legacy, &marked).is_err());
        assert!(validate_required_target_memory(Some(&marked), None, None, true).is_err());
        assert!(
            validate_required_target_memory(Some(&marked), None, Some(&Value::Null), true).is_err()
        );
        let invalid = serde_json::json!({"status":"invalid","reason":"reference_mismatch"});
        validate_required_target_memory(Some(&marked), None, Some(&invalid), true).unwrap();
        validate_required_target_memory(Some(&marked), None, None, false).unwrap();
    }
    #[test]
    fn memory_v2_shared_observation_ignores_order_space_but_preserves_number_tokens() {
        let source = serde_json::json!({"provider":"yfinance","request_namespace":"yahoo_finance_ticker","resolved_symbol":"FICT","request_parameters":{"interval":"1d"}});
        let sources = vec![source.clone(), source];
        shared_observations(&sources, r#"{"sources":[{"role":"instrument","n":1e-7,"b":true,"z":null},{"z":null,"b":true,"n":1e-7,"role":"benchmark"}]}"#).unwrap();
        for changed in ["0.0000001", "1e-07", "true", "9007199254740993"] {
            let payload = format!(r#"{{"sources":[{{"n":1e-7}},{{"n":{changed}}}]}}"#);
            assert!(shared_observations(&sources, &payload).is_err());
        }
        for payload in [
            r#"{"sources":[{"n":9007199254740992},{"n":9007199254740993}]}"#,
            r#"{"sources":[{"n":false},{"n":0}]}"#,
        ] {
            assert!(shared_observations(&sources, payload).is_err());
        }
        let payload = r#"{"sources":[{"provider":"yfinance","request_namespace":"yahoo_finance_ticker","resolved_symbol":"FICT","request_parameters":{"foo":1e-07}},{"provider":"yfinance","request_namespace":"yahoo_finance_ticker","resolved_symbol":"FICT","request_parameters":{"foo":0.0000001}}]}"#;
        let parsed = parse_json(payload).unwrap();
        let sources = parsed["sources"].as_array().unwrap();
        // Physical parameters use parsed canonical values, while the saved
        // source body preserves every number token for reference equality.
        assert_eq!(same_request(&sources[0]), same_request(&sources[1]));
        assert!(shared_observations(sources, payload).is_err());
    }
    #[test]
    fn memory_v2_reference_corruption_rejects_false_math_is_not_certified() {
        let original = fixture()["available_snapshot"].clone();
        let digest = original["outcome"]["calculation_sha256"].as_str().unwrap();
        let calculation =
            parse_json(original["artifacts"][digest]["payload"].as_str().unwrap()).unwrap();
        let mut false_math = original.clone();
        let mut body = calculation.clone();
        body["raw_return"] = 0.5.into();
        replace_calculation(&mut false_math, body);
        validate_decision(&false_math).unwrap(); // Archival validity is not arithmetic replay.
        for field in ["target_binding_sha256", "contract_sha256"] {
            let mut value = original.clone();
            let mut body = calculation.clone();
            body[field] = "f".repeat(64).into();
            replace_calculation(&mut value, body);
            assert!(validate_decision(&value).is_err());
        }
    }
}
