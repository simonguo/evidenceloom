use serde::{de, Deserialize, Deserializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::OnceLock;

pub const ERROR: &str = "Invalid or conflicting research memory";
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
type Check = Result<(), String>;

fn ensure(valid: bool) -> Check {
    if valid {
        Ok(())
    } else {
        Err(ERROR.into())
    }
}
fn shape(value: &Value, keys: &[&str]) -> Check {
    ensure(value.as_object().is_some_and(|map| {
        map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key))
    }))
}
fn text(value: &Value, nonempty: bool) -> Check {
    ensure(
        value
            .as_str()
            .is_some_and(|text| text.len() <= MAX_TEXT_BYTES && (!nonempty || !text.is_empty())),
    )?;
    privacy(string(value)?)
}
fn privacy(text: &str) -> Check {
    static PATTERNS: OnceLock<[regex::Regex; 4]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        regex::Regex::new(r"(?i)\b(?:sk|hy|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}").expect("fixed privacy pattern"),
        regex::Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").expect("fixed privacy pattern"),
        regex::Regex::new(r#"(?i)(\b(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\b["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,;"'}]+"#).expect("fixed privacy pattern"),
        regex::Regex::new(r#"(?:/(?:Users|home|tmp|private|var/folders)/[^\s<>"']+|[A-Za-z]:\\[^\s<>"']+)"#).expect("fixed privacy pattern"),
    ]);
    ensure(
        !patterns[0].is_match(text) && !patterns[1].is_match(text) && !patterns[3].is_match(text),
    )?;
    ensure(patterns[2].replace_all(text, "${1}[redacted]") == text)?;
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    for found in URL
        .get_or_init(|| {
            regex::Regex::new(r#"(?i)https?://[^\s<>"\)\]\}]+"#).expect("fixed URL pattern")
        })
        .find_iter(text)
    {
        let raw = found.as_str();
        let url = tauri::Url::parse(raw).map_err(|_| ERROR)?;
        let host = url.host_str().ok_or(ERROR)?;
        let authority = raw
            .split_once("://")
            .ok_or(ERROR)?
            .1
            .split('/')
            .next()
            .ok_or(ERROR)?;
        ensure(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && !authority.contains(':')
                && host.contains('.')
                && host.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || [b'.', b'_', b'-'].contains(&byte)
                })
                && host.trim_end_matches('.') != "localhost"
                && host.parse::<std::net::IpAddr>().is_err()
                && !host
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
                && ![".local", ".internal", ".localhost", ".invalid", ".test"]
                    .iter()
                    .any(|suffix| host.trim_end_matches('.').ends_with(suffix)),
        )?;
        ensure(authority == host && raw.starts_with(&format!("{}://", url.scheme())))?;
    }
    Ok(())
}
fn string(value: &Value) -> Result<&str, String> {
    value.as_str().ok_or_else(|| ERROR.into())
}
fn safe(value: &Value, depth: usize, integers_only: bool) -> Check {
    ensure(depth <= 64)?;
    match value {
        Value::Number(number) => ensure(if integers_only {
            number
                .as_i64()
                .is_some_and(|number| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number))
        } else {
            number.as_f64().is_some_and(f64::is_finite)
        }),
        Value::String(_) => text(value, false),
        Value::Array(items) => items
            .iter()
            .try_for_each(|item| safe(item, depth + 1, integers_only)),
        Value::Object(items) => items.iter().try_for_each(|(key, item)| {
            ensure(key.len() <= MAX_TEXT_BYTES)?;
            ensure(
                ![
                    "api_key",
                    "apikey",
                    "access_token",
                    "authorization",
                    "password",
                    "secret",
                    "headers",
                    "cookies",
                    "raw_response",
                    "backend_url",
                    "__proto__",
                    "constructor",
                    "prototype",
                ]
                .contains(&key.to_lowercase().as_str()),
            )?;
            privacy(key)?;
            if integers_only
                && key == "payload"
                && items.len() == 3
                && items.contains_key("sha256")
                && items
                    .get("kind")
                    .is_some_and(|kind| kind == "canonical_json")
            {
                ensure(
                    item.as_str()
                        .is_some_and(|payload| payload.len() <= MAX_TEXT_BYTES),
                )
            } else {
                safe(item, depth + 1, integers_only)
            }
        }),
        _ => Ok(()),
    }
}
fn bounded(value: &Value) -> Check {
    safe(value, 0, true)?;
    ensure(canonical_json(value)?.len() <= MAX_BYTES)
}
fn sha(value: &Value) -> Check {
    ensure(value.as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }))
}
pub fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
pub fn canonical_json(value: &Value) -> Result<String, String> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                let mut ordered = Map::new();
                for key in keys {
                    ordered.insert(key.clone(), sorted(&map[key]));
                }
                Value::Object(ordered)
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).map_err(|_| ERROR.into())
}
pub fn hash_value(value: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical_json(value)?.as_bytes())
    ))
}
pub fn hash_component(value: &Value, own_hash: &str) -> Result<String, String> {
    let mut body = value.as_object().ok_or(ERROR)?.clone();
    body.remove(own_hash);
    hash_value(&Value::Object(body))
}
fn check_hash(value: &Value, own_hash: &str) -> Check {
    sha(&value[own_hash])?;
    ensure(value[own_hash] == hash_component(value, own_hash)?)
}

// Value's ordinary deserializer keeps the last duplicate key. Saved records and
// subprocess responses need a strict parser before their hashes are checked.
struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = StrictValue;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("strict JSON")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictValue(value.into()))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StrictValue(value.into()))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StrictValue(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| StrictValue(Value::Number(number)))
                    .ok_or_else(|| E::custom(ERROR))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(StrictValue(value.into()))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(StrictValue(value.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom(ERROR));
                    }
                    values.insert(key, map.next_value::<StrictValue>()?.0);
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
pub fn parse_json(raw: &str) -> Result<Value, String> {
    ensure(raw.len() <= MAX_BYTES)?;
    serde_json::from_str::<StrictValue>(raw)
        .map(|value| value.0)
        .map_err(|_| ERROR.into())
}

fn day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [4, 7].contains(&index) || byte.is_ascii_digit())
    {
        return None;
    }
    let year = value[..4].parse::<i64>().ok()?;
    let month = value[5..7].parse::<usize>().ok()?;
    let date = value[8..].parse::<i64>().ok()?;
    if year == 0 || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if date < 1 || date > months[month - 1] {
        return None;
    }
    let prior = year - 1;
    Some(
        prior * 365 + prior / 4 - prior / 100
            + prior / 400
            + months[..month - 1].iter().sum::<i64>()
            + date
            - 1,
    )
}
pub fn timestamp(value: &Value) -> Result<i64, String> {
    let text = string(value)?;
    ensure(text.is_ascii() && (20..=27).contains(&text.len()) && text.ends_with('Z'))?;
    let date = day(&text[..10]).ok_or(ERROR)?;
    ensure(&text[10..11] == "T" && &text[13..14] == ":" && &text[16..17] == ":")?;
    ensure(
        [11, 12, 14, 15, 17, 18]
            .iter()
            .all(|index| text.as_bytes()[*index].is_ascii_digit()),
    )?;
    let hour = text[11..13].parse::<i64>().map_err(|_| ERROR)?;
    let minute = text[14..16].parse::<i64>().map_err(|_| ERROR)?;
    let second = text[17..19].parse::<i64>().map_err(|_| ERROR)?;
    ensure(hour < 24 && minute < 60 && second < 60)?;
    let fraction = &text[19..text.len() - 1];
    let micros = if fraction.is_empty() {
        0
    } else {
        ensure(
            (2..=7).contains(&fraction.len())
                && fraction.starts_with('.')
                && fraction[1..].bytes().all(|byte| byte.is_ascii_digit()),
        )?;
        let number = fraction[1..].parse::<i64>().map_err(|_| ERROR)?;
        number * 10_i64.pow((7 - fraction.len()) as u32)
    };
    Ok((date * 86400 + hour * 3600 + minute * 60 + second) * 1_000_000 + micros)
}
fn offset(value: &Value) -> Result<i64, String> {
    let text = string(value)?;
    ensure(
        text.len() == 6
            && text.is_ascii()
            && matches!(text.as_bytes()[0], b'+' | b'-')
            && text.as_bytes()[3] == b':',
    )?;
    ensure(
        [1, 2, 4, 5]
            .iter()
            .all(|index| text.as_bytes()[*index].is_ascii_digit()),
    )?;
    let hour = text[1..3].parse::<i64>().map_err(|_| ERROR)?;
    let minute = text[4..6].parse::<i64>().map_err(|_| ERROR)?;
    ensure(hour <= 23 && minute <= 59)?;
    Ok((hour * 60 + minute) * if text.starts_with('-') { -1 } else { 1 })
}
fn version(value: &Value) -> Check {
    ensure(value["schema_version"].as_i64() == Some(1))
}
fn date(value: &Value) -> Check {
    ensure(value.as_str().is_some_and(|text| day(text).is_some()))
}
fn reason(value: &Value) -> Check {
    ensure(value.as_str().is_some_and(|text| {
        !text.is_empty()
            && text.len() <= 80
            && text.as_bytes()[0].is_ascii_lowercase()
            && text
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    }))
}
pub fn validate_artifact(value: &Value) -> Check {
    shape(value, &["kind", "payload", "sha256"])?;
    ensure(
        value["payload"]
            .as_str()
            .is_some_and(|payload| payload.len() <= MAX_TEXT_BYTES),
    )?;
    match string(&value["kind"])? {
        "text" => {
            text(&value["payload"], false)?;
        }
        "canonical_json" => {
            // Numeric facts are opaque exact strings for hashing. Parsing checks
            // valid JSON, duplicate keys, finite numbers and bounds only.
            safe(&parse_json(string(&value["payload"])?)?, 0, false)?;
        }
        _ => return Err(ERROR.into()),
    }
    check_hash(value, "sha256")
}
fn artifact_ref(
    artifacts: &Value,
    reference: &Value,
    kind: &str,
    references: &mut BTreeSet<String>,
) -> Check {
    sha(reference)?;
    let hash = string(reference)?;
    ensure(
        artifacts
            .get(hash)
            .is_some_and(|artifact| artifact["kind"] == kind),
    )?;
    references.insert(hash.into());
    Ok(())
}

const POLICIES: &[(&str, &str)] = &[
    ("holding_period_unit", "common_complete_provider_daily_rows"),
    ("policy_version", "common-daily-close-v1"),
    (
        "entry_policy",
        "first_common_complete_date_after_recorded_source_and_utc_dates",
    ),
    ("exit_policy", "holding_count_common_row_transitions"),
    ("alignment_policy", "identical_session_date_no_fill"),
    ("session_policy", "provider_daily_rows_timezone_required"),
    (
        "completion_policy",
        "date_elapsed_in_source_timezone_and_utc",
    ),
    ("price_basis", "provider_adjusted_close"),
    ("return_policy", "simple_return_difference_no_fx"),
];
fn validate_contract(value: &Value) -> Check {
    let mut keys = vec![
        "schema_version",
        "analysis_date",
        "research_calendar_date",
        "host_utc_offset",
        "resolved_benchmark",
        "holding_period_days",
        "evaluation_mode",
        "not_evaluable_reason",
        "evaluator_version",
        "evaluator_code_sha256",
        "effective_history_parameters",
        "decision_text_sha256",
        "contract_sha256",
    ];
    keys.extend(POLICIES.iter().map(|(key, _)| *key));
    shape(value, &keys)?;
    version(value)?;
    date(&value["analysis_date"])?;
    date(&value["research_calendar_date"])?;
    offset(&value["host_utc_offset"])?;
    text(&value["resolved_benchmark"], true)?;
    ensure(
        value["holding_period_days"]
            .as_i64()
            .is_some_and(|days| (1..=10000).contains(&days)),
    )?;
    text(&value["evaluator_version"], true)?;
    sha(&value["evaluator_code_sha256"])?;
    sha(&value["decision_text_sha256"])?;
    for (key, policy) in POLICIES {
        ensure(value[*key] == *policy)?;
    }
    ensure(
        value["effective_history_parameters"]
            == serde_json::json!({"interval":"1d", "auto_adjust":false, "back_adjust":false, "actions":true, "repair":false, "rounding":false, "keepna":true, "prepost":false}),
    )?;
    let analysis = string(&value["analysis_date"])?;
    let research = string(&value["research_calendar_date"])?;
    if analysis == research {
        ensure(
            value["evaluation_mode"] == "prospective_reference"
                && value["not_evaluable_reason"].is_null(),
        )?;
    } else {
        ensure(
            analysis < research
                && value["evaluation_mode"] == "not_evaluable"
                && value["not_evaluable_reason"] == "historical_decision_availability_unknown",
        )?;
    }
    check_hash(value, "contract_sha256")
}

pub fn validate_decision(value: &Value) -> Check {
    bounded(value)?;
    shape(
        value,
        &[
            "schema_version",
            "run_id",
            "decision",
            "contract",
            "outcome",
            "reflection",
            "artifacts",
            "snapshot_sha256",
        ],
    )?;
    version(value)?;
    ensure(uuid(string(&value["run_id"])?))?;
    let decision = &value["decision"];
    let contract = &value["contract"];
    validate_contract(contract)?;
    shape(
        decision,
        &[
            "schema_version",
            "decision_id",
            "run_id",
            "instrument",
            "asset_type",
            "analysis_date",
            "research_started_at",
            "research_as_of",
            "recorded_at",
            "analysis_calendar_date",
            "host_utc_offset",
            "rating",
            "decision_text_sha256",
            "contract_sha256",
            "evidence_bundle_sha256",
            "decision_sha256",
        ],
    )?;
    version(decision)?;
    ensure(decision["decision_id"] == value["run_id"] && decision["run_id"] == value["run_id"])?;
    text(&decision["instrument"], true)?;
    text(&decision["asset_type"], true)?;
    date(&decision["analysis_date"])?;
    date(&decision["analysis_calendar_date"])?;
    let started = timestamp(&decision["research_started_at"])?;
    let recorded = timestamp(&decision["recorded_at"])?;
    timestamp(&decision["research_as_of"])?;
    ensure(
        decision["research_as_of"]
            == format!("{}T23:59:59.999999Z", string(&decision["analysis_date"])?),
    )?;
    ensure(
        recorded >= started
            && (started + offset(&decision["host_utc_offset"])? * 60_000_000)
                .div_euclid(86_400_000_000)
                == day(string(&decision["analysis_calendar_date"])?).ok_or(ERROR)?,
    )?;
    ensure(decision["rating"].as_str().is_some_and(|rating| {
        ["Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"].contains(&rating)
    }))?;
    sha(&decision["evidence_bundle_sha256"])?;
    for (left, right) in [
        ("contract_sha256", "contract_sha256"),
        ("decision_text_sha256", "decision_text_sha256"),
        ("analysis_date", "analysis_date"),
        ("analysis_calendar_date", "research_calendar_date"),
        ("host_utc_offset", "host_utc_offset"),
    ] {
        ensure(decision[left] == contract[right])?;
    }
    check_hash(decision, "decision_sha256")?;
    let artifacts = &value["artifacts"];
    let map = artifacts.as_object().ok_or(ERROR)?;
    ensure(map.len() <= 16)?;
    for (key, artifact) in map {
        validate_artifact(artifact)?;
        ensure(artifact["sha256"] == *key)?;
    }
    let mut references = BTreeSet::new();
    artifact_ref(
        artifacts,
        &decision["decision_text_sha256"],
        "text",
        &mut references,
    )?;
    text(
        &artifacts[string(&decision["decision_text_sha256"])?]["payload"],
        true,
    )?;
    let outcome = &value["outcome"];
    let reflection = &value["reflection"];
    if !outcome.is_null() {
        shape(
            outcome,
            &[
                "schema_version",
                "contract_sha256",
                "observed_at",
                "status",
                "reason",
                "facts_sha256",
                "calculation_sha256",
                "outcome_sha256",
            ],
        )?;
        version(outcome)?;
        ensure(
            outcome["contract_sha256"] == contract["contract_sha256"]
                && timestamp(&outcome["observed_at"])? >= recorded,
        )?;
        match string(&outcome["status"])? {
            "available" => {
                ensure(
                    contract["evaluation_mode"] == "prospective_reference"
                        && outcome["reason"].is_null(),
                )?;
                artifact_ref(
                    artifacts,
                    &outcome["facts_sha256"],
                    "canonical_json",
                    &mut references,
                )?;
                artifact_ref(
                    artifacts,
                    &outcome["calculation_sha256"],
                    "canonical_json",
                    &mut references,
                )?;
            }
            "not_evaluable" => {
                reason(&outcome["reason"])?;
                if !outcome["facts_sha256"].is_null() {
                    artifact_ref(
                        artifacts,
                        &outcome["facts_sha256"],
                        "canonical_json",
                        &mut references,
                    )?;
                }
                ensure(outcome["calculation_sha256"].is_null() && reflection.is_null())?;
                ensure(
                    contract["evaluation_mode"] != "not_evaluable"
                        || outcome["reason"] == contract["not_evaluable_reason"],
                )?;
            }
            _ => return Err(ERROR.into()),
        }
        check_hash(outcome, "outcome_sha256")?;
    }
    if !reflection.is_null() {
        shape(
            reflection,
            &[
                "schema_version",
                "outcome_sha256",
                "reflected_at",
                "model_context_sha256",
                "prompt_sha256",
                "response_sha256",
                "reflection_sha256",
            ],
        )?;
        version(reflection)?;
        ensure(
            !outcome.is_null()
                && outcome["status"] == "available"
                && reflection["outcome_sha256"] == outcome["outcome_sha256"]
                && timestamp(&reflection["reflected_at"])? >= timestamp(&outcome["observed_at"])?,
        )?;
        for (key, kind) in [
            ("model_context_sha256", "canonical_json"),
            ("prompt_sha256", "text"),
            ("response_sha256", "text"),
        ] {
            artifact_ref(artifacts, &reflection[key], kind, &mut references)?;
        }
        text(
            &artifacts[string(&reflection["response_sha256"])?]["payload"],
            true,
        )?;
        check_hash(reflection, "reflection_sha256")?;
    }
    ensure(map.keys().cloned().collect::<BTreeSet<_>>() == references)?;
    check_hash(value, "snapshot_sha256")
}
pub fn merge_decision(first: &Value, second: &Value) -> Result<Value, String> {
    validate_decision(first)?;
    validate_decision(second)?;
    for key in ["schema_version", "run_id", "decision", "contract"] {
        ensure(first[key] == second[key])?;
    }
    let mut merged = first.clone();
    for key in ["outcome", "reflection"] {
        ensure(first[key].is_null() || second[key].is_null() || first[key] == second[key])?;
        if merged[key].is_null() {
            merged[key] = second[key].clone();
        }
    }
    for (key, artifact) in second["artifacts"].as_object().ok_or(ERROR)? {
        ensure(
            merged["artifacts"]
                .get(key)
                .is_none_or(|existing| existing == artifact),
        )?;
        merged["artifacts"]
            .as_object_mut()
            .ok_or(ERROR)?
            .insert(key.clone(), artifact.clone());
    }
    merged["snapshot_sha256"] = hash_component(&merged, "snapshot_sha256")?.into();
    validate_decision(&merged)?;
    Ok(merged)
}

fn same_instrument(first: &str, second: &str) -> bool {
    first.eq_ignore_ascii_case(second)
}
fn render_context(instrument: &str, decisions: &[Value]) -> Result<String, String> {
    let mut sections = Vec::new();
    for same in [true, false] {
        let mut entries = Vec::new();
        for snapshot in decisions {
            let decision = &snapshot["decision"];
            if same_instrument(string(&decision["instrument"])?, instrument) != same {
                continue;
            }
            if entries.is_empty() {
                entries.push(if same {
                    format!("Past analyses of {instrument} (most recent first):")
                } else {
                    "Recent cross-instrument lessons:".into()
                });
            }
            let outcome = &snapshot["outcome"];
            let reflection = &snapshot["reflection"];
            let artifacts = &snapshot["artifacts"];
            let mut lines = vec![
                format!(
                    "Memory decision {} | {} | {} | {}",
                    string(&snapshot["run_id"])?,
                    string(&decision["instrument"])?,
                    string(&decision["analysis_date"])?,
                    string(&decision["rating"])?
                ),
                "Research reference evaluation; not execution or realized strategy profit.".into(),
            ];
            if same {
                lines.push("Decision:".into());
                lines.push(
                    string(&artifacts[string(&decision["decision_text_sha256"])?]["payload"])?
                        .into(),
                );
            }
            lines.extend([
                format!(
                    "Frozen benchmark: {}; horizon: {} common complete provider daily rows.",
                    string(&snapshot["contract"]["resolved_benchmark"])?,
                    snapshot["contract"]["holding_period_days"]
                        .as_i64()
                        .ok_or(ERROR)?
                ),
                format!("Outcome observed at: {}", string(&outcome["observed_at"])?),
                "Saved calculation:".into(),
                string(&artifacts[string(&outcome["calculation_sha256"])?]["payload"])?.into(),
                format!(
                    "Reflection completed at: {}",
                    string(&reflection["reflected_at"])?
                ),
                string(&artifacts[string(&reflection["response_sha256"])?]["payload"])?.into(),
            ]);
            entries.push(lines.join("\n"));
        }
        if !entries.is_empty() {
            sections.push(entries.join("\n\n"));
        }
    }
    Ok(sections.join("\n\n"))
}
pub fn validate_context_snapshot(value: &Value) -> Check {
    bounded(value)?;
    shape(
        value,
        &[
            "schema_version",
            "instrument",
            "selected_at",
            "research_cutoff",
            "availability_cutoff",
            "selector_version",
            "same_ticker_limit",
            "cross_ticker_limit",
            "decisions",
            "context_artifact",
            "raw_text_sha256",
            "context_sha256",
            "input_sha256",
        ],
    )?;
    version(value)?;
    ensure(value["selector_version"] == "recent-reflections-v1")?;
    text(&value["instrument"], true)?;
    let cutoff = timestamp(&value["availability_cutoff"])?;
    ensure(cutoff == timestamp(&value["selected_at"])?.min(timestamp(&value["research_cutoff"])?))?;
    for key in ["same_ticker_limit", "cross_ticker_limit"] {
        ensure(
            value[key]
                .as_i64()
                .is_some_and(|limit| (0..=128).contains(&limit)),
        )?;
    }
    let decisions = value["decisions"].as_array().ok_or(ERROR)?;
    ensure(decisions.len() <= 128)?;
    let instrument = string(&value["instrument"])?;
    let mut ids = BTreeSet::new();
    let mut same = 0;
    for decision in decisions {
        validate_decision(decision)?;
        ensure(ids.insert(string(&decision["run_id"])?))?;
        ensure(
            !decision["outcome"].is_null()
                && !decision["reflection"].is_null()
                && decision["outcome"]["status"] == "available",
        )?;
        for time in [
            &decision["decision"]["recorded_at"],
            &decision["outcome"]["observed_at"],
            &decision["reflection"]["reflected_at"],
        ] {
            ensure(timestamp(time)? <= cutoff)?;
        }
        if same_instrument(string(&decision["decision"]["instrument"])?, instrument) {
            same += 1;
        }
    }
    ensure(
        same <= value["same_ticker_limit"].as_u64().ok_or(ERROR)? as usize
            && decisions.len() - same
                <= value["cross_ticker_limit"].as_u64().ok_or(ERROR)? as usize,
    )?;
    let mut ordered = decisions
        .iter()
        .map(|snapshot| {
            Ok((
                same_instrument(string(&snapshot["decision"]["instrument"])?, instrument),
                timestamp(&snapshot["reflection"]["reflected_at"])?,
                timestamp(&snapshot["decision"]["recorded_at"])?,
                string(&snapshot["run_id"])?,
                snapshot,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    ordered.sort_by(|first, second| {
        second
            .0
            .cmp(&first.0)
            .then_with(|| second.1.cmp(&first.1))
            .then_with(|| second.2.cmp(&first.2))
            .then_with(|| second.3.cmp(first.3))
    });
    ensure(
        ordered
            .iter()
            .zip(decisions)
            .all(|(ordered, original)| ordered.4 == original),
    )?;
    let artifact = &value["context_artifact"];
    validate_artifact(artifact)?;
    ensure(
        artifact["kind"] == "text" && artifact["payload"] == render_context(instrument, decisions)?,
    )?;
    let payload = string(&artifact["payload"])?;
    ensure(
        value["raw_text_sha256"] == format!("{:x}", Sha256::digest(payload.as_bytes()))
            && value["context_sha256"] == hash_value(&artifact["payload"])?,
    )?;
    check_hash(value, "input_sha256")
}
pub fn validate_bundle(value: &Value) -> Check {
    bounded(value)?;
    shape(
        value,
        &[
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "evidence_bundle_sha256",
            "persistence_status",
            "input_snapshot",
            "decision_snapshot",
            "bundle_sha256",
        ],
    )?;
    version(value)?;
    ensure(uuid(string(&value["run_id"])?))?;
    text(&value["instrument"], true)?;
    date(&value["analysis_date"])?;
    sha(&value["evidence_bundle_sha256"])?;
    ensure(
        value["persistence_status"] == "durable" || value["persistence_status"] == "memory_only",
    )?;
    let context = &value["input_snapshot"];
    let snapshot = &value["decision_snapshot"];
    let decision = &snapshot["decision"];
    validate_context_snapshot(context)?;
    validate_decision(snapshot)?;
    ensure(
        snapshot["run_id"] == value["run_id"]
            && decision["instrument"] == value["instrument"]
            && context["instrument"] == value["instrument"]
            && decision["analysis_date"] == value["analysis_date"]
            && decision["evidence_bundle_sha256"] == value["evidence_bundle_sha256"]
            && decision["research_as_of"] == context["research_cutoff"]
            && timestamp(&context["selected_at"])? >= timestamp(&decision["research_started_at"])?
            && timestamp(&context["selected_at"])? <= timestamp(&decision["recorded_at"])?,
    )?;
    ensure(
        context["decisions"]
            .as_array()
            .ok_or(ERROR)?
            .iter()
            .all(|decision| decision["run_id"] != value["run_id"]),
    )?;
    check_hash(value, "bundle_sha256")
}
pub fn validate_bundle_evidence(value: &Value, evidence: &Value) -> Check {
    validate_bundle(value)?;
    if let Some(asset_type) = evidence["manifest"].get("asset_type") {
        ensure(*asset_type == value["decision_snapshot"]["decision"]["asset_type"])?;
    }
    ensure(
        value["run_id"] == evidence["run_id"]
            && value["instrument"] == evidence["instrument"]
            && value["analysis_date"] == evidence["analysis_date"]
            && value["evidence_bundle_sha256"] == evidence["bundle_sha256"]
            && value["input_snapshot"]["context_sha256"]
                == evidence["manifest"]["memory_input_sha256"]
            && value["decision_snapshot"]["contract"]["holding_period_days"]
                == evidence["manifest"]["holding_period_days"]
            && value["decision_snapshot"]["contract"]["resolved_benchmark"]
                == evidence["manifest"]["benchmark_ticker"],
    )
}
pub fn validate_report_binding(value: &Value, decision: &str, reports: &Value) -> Check {
    let snapshot = &value["decision_snapshot"];
    let hash = string(&snapshot["decision"]["decision_text_sha256"])?;
    ensure(
        snapshot["decision"]["rating"] == decision
            && snapshot["artifacts"][hash]["payload"] == reports["final_trade_decision"],
    )
}
pub fn validate_review_attachment(value: &Value, completion: Option<&Value>) -> Check {
    bounded(value)?;
    shape(
        value,
        &[
            "schema_version",
            "decision_id",
            "reviewed_at",
            "snapshot",
            "attachment_sha256",
        ],
    )?;
    version(value)?;
    ensure(uuid(string(&value["decision_id"])?))?;
    let snapshot = &value["snapshot"];
    validate_decision(snapshot)?;
    ensure(value["decision_id"] == snapshot["run_id"])?;
    let reviewed = timestamp(&value["reviewed_at"])?;
    ensure(reviewed >= timestamp(&snapshot["decision"]["recorded_at"])?)?;
    for (key, time) in [("outcome", "observed_at"), ("reflection", "reflected_at")] {
        if !snapshot[key].is_null() {
            ensure(reviewed >= timestamp(&snapshot[key][time])?)?;
        }
    }
    if let Some(completion) = completion {
        validate_bundle(completion)?;
        ensure(
            completion["run_id"] == value["decision_id"]
                && completion["decision_snapshot"]["decision"] == snapshot["decision"]
                && completion["decision_snapshot"]["contract"] == snapshot["contract"],
        )?;
        ensure(merge_decision(&completion["decision_snapshot"], snapshot)? == *snapshot)?;
    }
    check_hash(value, "attachment_sha256")
}

pub fn validate_requested_ids(ids: &[String]) -> Check {
    ensure((1..=20).contains(&ids.len()))?;
    let mut seen = BTreeSet::new();
    ensure(ids.iter().all(|id| uuid(id) && seen.insert(id)))
}

pub fn validate_invalid(value: &Value) -> Check {
    shape(value, &["status", "reason"])?;
    ensure(
        value["status"] == "invalid"
            && value["reason"].as_str().is_some_and(|reason| {
                [
                    "malformed",
                    "hash_mismatch",
                    "unsafe_content",
                    "reference_mismatch",
                    "temporal_mismatch",
                    "verification_unavailable",
                ]
                .contains(&reason)
            }),
    )
}

pub fn validate_inventory(value: &Value, ids: &[String]) -> Check {
    validate_requested_ids(ids)?;
    bounded(value)?;
    let mut keys = vec![
        "type",
        "schema_version",
        "requested_ids",
        "reviews",
        "missing_ids",
    ];
    if let Some(time) = value.get("timestamp") {
        let time = string(time)?;
        let bytes = time.as_bytes();
        ensure(
            bytes.len() == 8
                && bytes[2] == b':'
                && bytes[5] == b':'
                && [0, 1, 3, 4, 6, 7]
                    .iter()
                    .all(|i| bytes[*i].is_ascii_digit())
                && &time[..2] <= "23"
                && &time[3..5] <= "59"
                && &time[6..] <= "59",
        )?;
        keys.push("timestamp");
    }
    shape(value, &keys)?;
    version(value)?;
    ensure(
        value["type"] == "memory_inventory" && value["requested_ids"] == serde_json::json!(ids),
    )?;
    let requested: BTreeSet<_> = ids.iter().map(String::as_str).collect();
    let mut found = BTreeSet::new();
    let reviews = value["reviews"].as_array().ok_or(ERROR)?;
    let missing = value["missing_ids"].as_array().ok_or(ERROR)?;
    ensure(reviews.len() <= ids.len() && missing.len() <= ids.len())?;
    for review in reviews {
        validate_review_attachment(review, None)?;
        let id = string(&review["decision_id"])?;
        ensure(requested.contains(id) && found.insert(id))?;
    }
    for id in missing {
        let id = string(id)?;
        ensure(requested.contains(id) && found.insert(id))?;
    }
    ensure(found == requested)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn bundle() -> Value {
        parse_json(include_str!("../../tests/fixtures/memory_bundle_v1.json")).unwrap()
    }
    pub fn evidence() -> Value {
        parse_json(include_str!(
            "../../tests/fixtures/memory_evidence_bundle_v1.json"
        ))
        .unwrap()
    }
    pub fn rehash(value: &mut Value, key: &str) {
        value[key] = hash_component(value, key).unwrap().into();
    }
    pub fn artifact(kind: &str, payload: &str) -> Value {
        let mut value = serde_json::json!({"kind":kind,"payload":payload});
        rehash(&mut value, "sha256");
        value
    }
    pub fn settled(bundle: &Value, with_reflection: bool) -> Value {
        let mut value = bundle["decision_snapshot"].clone();
        let facts = artifact(
            "canonical_json",
            r#"{"fixture":"Saved fictional observations","prices":[123.45678901234567,1.0,1e-07]}"#,
        );
        let calculation = artifact(
            "canonical_json",
            r#"{"fixture":"Saved reference calculation","raw_return":0.012345678901234567,"benchmark_return":0.0012345678901234567}"#,
        );
        value["outcome"] = serde_json::json!({"schema_version":1,"contract_sha256":value["contract"]["contract_sha256"],"observed_at":"2025-02-20T12:00:00Z","status":"available","reason":null,"facts_sha256":facts["sha256"],"calculation_sha256":calculation["sha256"]});
        rehash(&mut value["outcome"], "outcome_sha256");
        let mut additions = vec![facts, calculation];
        if with_reflection {
            let model = artifact(
                "canonical_json",
                r#"{"llm_provider":"fictional","model":"offline"}"#,
            );
            let prompt = artifact("text", "Review the exact saved fictional calculation.");
            let response = artifact(
                "text",
                "Fictional reflection about reference performance; no execution claim.",
            );
            value["reflection"] = serde_json::json!({"schema_version":1,"outcome_sha256":value["outcome"]["outcome_sha256"],"reflected_at":"2025-02-21T12:00:00Z","model_context_sha256":model["sha256"],"prompt_sha256":prompt["sha256"],"response_sha256":response["sha256"]});
            rehash(&mut value["reflection"], "reflection_sha256");
            additions.extend([model, prompt, response]);
        }
        for artifact in additions {
            let key = artifact["sha256"].as_str().unwrap().to_owned();
            value["artifacts"][key] = artifact;
        }
        rehash(&mut value, "snapshot_sha256");
        validate_decision(&value).unwrap();
        value
    }
    pub fn review(snapshot: Value, time: &str) -> Value {
        let mut value = serde_json::json!({"schema_version":1,"decision_id":snapshot["run_id"],"reviewed_at":time,"snapshot":snapshot});
        rehash(&mut value, "attachment_sha256");
        value
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    #[test]
    fn python_fixture_hashes_bind_exact_context_evidence_and_full_precision() {
        let bundle = bundle();
        let evidence = evidence();
        validate_bundle_evidence(&bundle, &evidence).unwrap();
        crate::evidence::validate_bundle(&evidence, None).unwrap();
        let snapshot = &bundle["input_snapshot"]["decisions"][0];
        let facts = &snapshot["artifacts"][snapshot["outcome"]["facts_sha256"].as_str().unwrap()]
            ["payload"];
        let payload = facts.as_str().unwrap();
        for exact in ["123.45678901234567", "1.0", "1e-07"] {
            assert!(payload.contains(exact));
        }
        let mut changed = evidence.clone();
        changed["manifest"]
            .as_object_mut()
            .unwrap()
            .remove("memory_input_sha256");
        assert!(validate_bundle_evidence(&bundle, &changed).is_err());
        for field in ["benchmark_ticker", "holding_period_days"] {
            let mut changed = evidence.clone();
            changed["manifest"][field] = serde_json::json!("changed");
            assert!(validate_bundle_evidence(&bundle, &changed).is_err());
        }
        let mut corrupt = bundle.clone();
        corrupt["input_snapshot"]["context_artifact"]["payload"] = "corrupted".into();
        assert!(validate_bundle(&corrupt).is_err());
        let mut future = bundle.clone();
        future["input_snapshot"]["selected_at"] = "2025-02-14T12:06:00Z".into();
        assert!(validate_bundle(&future).is_err());
        let mut unrelated = bundle.clone();
        unrelated["run_id"] = "33333333-3333-4333-8333-333333333333".into();
        rehash(&mut unrelated, "bundle_sha256");
        assert!(validate_bundle(&unrelated).is_err());
    }
    #[test]
    fn evidence_asset_binding_checks_rehashed_bundles_and_allows_legacy_absence() {
        let original = bundle();
        let mut evidence = evidence();
        assert!(evidence["manifest"].get("asset_type").is_none());
        validate_bundle_evidence(&original, &evidence).unwrap();
        for asset_type in ["stock", "fx"] {
            evidence["manifest"]["asset_type"] = asset_type.into();
            evidence["manifest_sha256"] = hash_value(&evidence["manifest"]).unwrap().into();
            rehash(&mut evidence, "bundle_sha256");
            crate::evidence::validate_bundle(&evidence, None).unwrap();
            let mut bundle = original.clone();
            bundle["evidence_bundle_sha256"] = evidence["bundle_sha256"].clone();
            bundle["decision_snapshot"]["decision"]["evidence_bundle_sha256"] =
                evidence["bundle_sha256"].clone();
            rehash(
                &mut bundle["decision_snapshot"]["decision"],
                "decision_sha256",
            );
            rehash(&mut bundle["decision_snapshot"], "snapshot_sha256");
            rehash(&mut bundle, "bundle_sha256");
            validate_bundle(&bundle).unwrap();
            if asset_type == "stock" {
                validate_bundle_evidence(&bundle, &evidence).unwrap();
            } else {
                assert_eq!(
                    validate_bundle_evidence(&bundle, &evidence),
                    Err(ERROR.into())
                );
            }
        }
    }
    #[test]
    fn exact_artifact_payload_is_safe_after_decoding_and_is_never_reserialized() {
        let payload = r#"{"text":"Recorded decision:\nFictional","a":1.0,"b":1e-07,"c":0.123456789012345678901234567890}"#;
        let good = artifact("canonical_json", payload);
        validate_artifact(&good).unwrap();
        assert_eq!(good["payload"], payload);
        for payload in [
            r#"{"a":1,"a":2}"#,
            r#"{"a":1e999}"#,
            r#"{"text":"C:\\private\\fixture.txt"}"#,
            r#"{"text":"Bearer syntheticcredential"}"#,
            r#"{"nested":{"HEADERS":"synthetic"}}"#,
            r#"{"kind":"canonical_json","payload":"C:\\private\\fixture.txt","sha256":"synthetic"}"#,
        ] {
            assert_eq!(
                validate_artifact(&artifact("canonical_json", payload)),
                Err(ERROR.into())
            );
        }
        for value in [
            "sk-abcdefghijklmnop123456789",
            "Bearer abcdefghijklmnopqrstuvwxyz",
            "api_key=synthetic-secret",
            "https://example.com/data?token=synthetic",
            "https://user:password@example.com/data",
            "http://127.0.0.1/private",
            "https://example.com:443/data",
            "/Users/synthetic/private.txt",
            "C:\\synthetic\\private.txt",
        ] {
            assert_eq!(
                validate_artifact(&artifact("text", value)),
                Err(ERROR.into())
            );
        }
        validate_artifact(&artifact(
            "text",
            "api_key=[redacted]; https://example.com/data",
        ))
        .unwrap();
    }
    #[test]
    fn private_dns_and_canonical_host_rules_cover_text_and_decoded_json() {
        for url in [
            "https://internal.local./private",
            "https://gateway.internal./private",
            "https://host.localhost./private",
            "https://host.invalid./private",
            "https://host.test../private",
            "https://localhost./private",
            "https://%65xample.com/private",
            "https://unsafe!.example.com/private",
            "https://bücher.example/private",
            "https://0x7f.0.0.1/private",
            "https://127.1/private",
        ] {
            assert_eq!(validate_artifact(&artifact("text", url)), Err(ERROR.into()));
            let payload = serde_json::json!({"source":url}).to_string();
            assert_eq!(
                validate_artifact(&artifact("canonical_json", &payload)),
                Err(ERROR.into())
            );
        }
        for url in [
            "https://123.example.com/data",
            "https://xn--bcher-kva.example/data",
            "https://example.com./data",
        ] {
            validate_artifact(&artifact("text", url)).unwrap();
            let payload = serde_json::json!({"source":url}).to_string();
            validate_artifact(&artifact("canonical_json", &payload)).unwrap();
        }
    }
    #[test]
    fn outcomes_and_reviews_only_add_immutable_components() {
        let bundle = bundle();
        let pending = &bundle["decision_snapshot"];
        let facts = settled(&bundle, false);
        let reflected = settled(&bundle, true);
        assert_eq!(merge_decision(pending, &facts).unwrap(), facts);
        assert_eq!(merge_decision(&reflected, pending).unwrap(), reflected);
        let attachment = review(reflected.clone(), "2025-02-22T12:00:00Z");
        validate_review_attachment(&attachment, Some(&bundle)).unwrap();
        let mut conflicting = reflected.clone();
        conflicting["outcome"]["observed_at"] = "2025-02-20T13:00:00Z".into();
        rehash(&mut conflicting["outcome"], "outcome_sha256");
        conflicting["reflection"]["outcome_sha256"] =
            conflicting["outcome"]["outcome_sha256"].clone();
        rehash(&mut conflicting["reflection"], "reflection_sha256");
        rehash(&mut conflicting, "snapshot_sha256");
        validate_decision(&conflicting).unwrap();
        assert!(merge_decision(&reflected, &conflicting).is_err());
        let mut completed = bundle.clone();
        completed["decision_snapshot"] = reflected;
        rehash(&mut completed, "bundle_sha256");
        assert!(validate_review_attachment(
            &review(pending.clone(), "2025-02-23T12:00:00Z"),
            Some(&completed)
        )
        .is_err());
        let mut changed = pending.clone();
        changed["contract"]["holding_period_days"] = 3.into();
        rehash(&mut changed["contract"], "contract_sha256");
        changed["decision"]["contract_sha256"] = changed["contract"]["contract_sha256"].clone();
        rehash(&mut changed["decision"], "decision_sha256");
        rehash(&mut changed, "snapshot_sha256");
        assert!(validate_review_attachment(
            &review(changed, "2025-02-23T12:00:00Z"),
            Some(&bundle)
        )
        .is_err());
    }
    #[test]
    fn strict_json_rejects_duplicate_keys_nonfinite_values_and_bad_dates() {
        for raw in [
            r#"{"a":1,"a":2}"#,
            r#"{"a":{"b":1,"b":2}}"#,
            "NaN",
            "1e999",
            r#""\ud800""#,
        ] {
            assert_eq!(parse_json(raw), Err(ERROR.into()));
        }
        for time in [
            "2025-02-29T12:00:00Z",
            "2025-02-14T24:00:00Z",
            "2025-02-14T12:00:00.1234567Z",
            "2025-02-14T12:00:00+00:00",
        ] {
            assert!(timestamp(&time.into()).is_err());
        }
        assert_eq!(
            timestamp(&"2025-02-14T12:00:00.1Z".into()),
            timestamp(&"2025-02-14T12:00:00.100000Z".into())
        );
    }
}
