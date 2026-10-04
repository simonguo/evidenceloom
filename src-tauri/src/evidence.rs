use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::OnceLock};

const PROVIDERS: &[&str] = &[
    "yfinance",
    "eastmoney",
    "tencent",
    "alpha_vantage",
    "akshare",
    "stocktwits",
    "reddit",
    "local_calculation",
    "unknown",
];
const TOOLS: &[&str] = &[
    "get_stock_data",
    "get_indicators",
    "get_fundamentals",
    "get_balance_sheet",
    "get_cashflow",
    "get_income_statement",
    "get_news",
    "get_global_news",
    "get_insider_transactions",
    "get_market_data_snapshot",
    "get_verified_market_snapshot",
    "fetch_stocktwits_messages",
    "fetch_reddit_posts",
    "fetch_china_sentiment_sources",
    "resolve_instrument_context",
];
const PARAMETERS: &[&str] = &[
    "ticker",
    "symbol",
    "instrument",
    "trade_date",
    "curr_date",
    "start_date",
    "end_date",
    "indicator",
    "look_back_days",
    "lookback_days",
    "limit",
    "limit_per_sub",
    "subreddits",
    "queries",
    "freq",
    "interval",
    "time_period",
    "series_type",
];
const MANIFEST_KEYS: &[&str] = &[
    "core_version",
    "upstream_revision",
    "app_version",
    "llm_provider",
    "quick_think_llm",
    "deep_think_llm",
    "analysts",
    "max_debate_rounds",
    "max_risk_discuss_rounds",
    "max_tool_rounds",
    "analyst_concurrency_limit",
    "output_language",
    "temperature",
    "max_tokens",
    "data_vendors",
    "tool_vendors",
    "trade_date",
    "asset_type",
    "holding_period_days",
    "benchmark_ticker",
    "code_revision",
    "code_dirty",
    "code_sha256",
    "prompt_templates_sha256",
    "memory_input_sha256",
    "instrument_identity_context_sha256",
    "model_context_sha256",
    "research_readiness_policy_sha256",
    "effective_request_identity_policy_sha256",
];
const REPORT_KEYS: &[&str] = &[
    "market_report",
    "sentiment_report",
    "news_report",
    "fundamentals_report",
    "investment_plan",
    "trader_investment_plan",
    "final_trade_decision",
    "investment_debate_state.bull_history",
    "investment_debate_state.bear_history",
    "investment_debate_state.judge_decision",
    "risk_debate_state.aggressive_history",
    "risk_debate_state.conservative_history",
    "risk_debate_state.neutral_history",
    "risk_debate_state.judge_decision",
];
type Check = Result<(), String>;
fn ensure(ok: bool) -> Check {
    if ok {
        Ok(())
    } else {
        Err("Invalid research evidence bundle".into())
    }
}
fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let map = value
        .as_object()
        .ok_or("Invalid research evidence bundle")?;
    ensure(map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))?;
    Ok(map)
}
fn choice(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|text| allowed.contains(&text))
}
fn text(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len() <= 8_000_000)
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn hash(value: &Value) -> bool {
    value.as_str().is_some_and(|s| hex(s, 64))
}
fn evidence_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.starts_with("ev-") && hex(&s[3..], 32))
}
fn citation_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}
fn date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}
fn timestamp(value: &Value) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    let utc = s.strip_suffix('Z');
    let Some(s) = utc else {
        return false;
    };
    if !s.is_ascii()
        || s.len() < 19
        || !date(&s[..10])
        || &s[10..11] != "T"
        || &s[13..14] != ":"
        || &s[16..17] != ":"
    {
        return false;
    }
    let hour = s[11..13].parse::<u32>().unwrap_or(99);
    let minute = s[14..16].parse::<u32>().unwrap_or(99);
    let second = s[17..19].parse::<u32>().unwrap_or(99);
    hour < 24
        && minute < 60
        && second < 60
        && (s.len() == 19
            || (s.len() >= 21
                && s.len() <= 26
                && &s[19..20] == "."
                && s[20..].bytes().all(|b| b.is_ascii_digit())))
}
fn safe_json(value: &Value, depth: usize, integer_only: bool) -> Check {
    ensure(depth <= 32)?;
    match value {
        Value::Number(number) if integer_only => ensure(
            number
                .as_i64()
                .is_some_and(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n)),
        ),
        Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            ensure(
                s.len() <= 8_000_000
                    && ![
                        "/users/",
                        "/home/",
                        "/tmp/",
                        "/private/",
                        "/var/folders/",
                        "c:\\users\\",
                    ]
                    .iter()
                    .any(|bad| lower.contains(bad)),
            )?;
            for label in [
                "api_key",
                "api-key",
                "api key",
                "access_token",
                "access-token",
                "access token",
                "authorization",
                "password",
                "secret",
            ] {
                for tail in lower.split(label).skip(1) {
                    let tail = tail.trim_start();
                    if let Some(value) = tail.strip_prefix('=').or_else(|| tail.strip_prefix(':')) {
                        ensure(value.trim_start().starts_with("[redacted]"))?;
                    }
                }
            }
            ensure(
                !lower
                    .split("bearer ")
                    .skip(1)
                    .any(|tail| !tail.starts_with("[redacted]")),
            )?;
            for prefix in [
                "sk-",
                "sk_",
                "hy-",
                "hy_",
                "ghp-",
                "ghp_",
                "github_pat-",
                "github_pat_",
            ] {
                ensure(!lower.split(prefix).skip(1).any(|tail| {
                    tail.bytes()
                        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
                        .count()
                        >= 16
                }))?;
            }
            static URL: OnceLock<regex::Regex> = OnceLock::new();
            for found in URL
                .get_or_init(|| {
                    regex::Regex::new(r#"(?i)https?://[^\s<>"\)\]\}]+"#).expect("fixed URL pattern")
                })
                .find_iter(s)
            {
                ensure(public_url(&Value::String(found.as_str().to_owned())))?;
            }
            Ok(())
        }
        Value::Array(items) => {
            ensure(items.len() <= 100_000)?;
            for item in items {
                safe_json(item, depth + 1, integer_only)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, item) in map {
                safe_json(&Value::String(key.clone()), depth + 1, integer_only)?;
                let key = key.to_ascii_lowercase().replace(['_', '-'], "");
                ensure(
                    ![
                        "apikey",
                        "authorization",
                        "cookie",
                        "cookies",
                        "header",
                        "headers",
                        "credential",
                        "credentials",
                        "secret",
                        "secrets",
                        "password",
                        "accesstoken",
                        "refreshtoken",
                        "raw",
                        "rawresponse",
                        "exception",
                        "error",
                        "traceback",
                        "endpoint",
                        "baseurl",
                        "backendurl",
                        "projectroot",
                        "storagedir",
                        "pythonpath",
                        "__proto__",
                        "proto",
                        "constructor",
                        "prototype",
                    ]
                    .contains(&key.as_str()),
                )?;
                safe_json(item, depth + 1, integer_only)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn public_url(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(s) = value.as_str() else {
        return false;
    };
    let Ok(url) = tauri::Url::parse(s) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let comparison_host = host.trim_end_matches('.');
    let authority = s
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or_default())
        .unwrap_or_default();
    ["http", "https"].contains(&url.scheme())
        && s.starts_with(&format!("{}://", url.scheme()))
        && authority == host
        && !authority.contains(':')
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.port().is_none()
        && s.len() <= 2048
        && host.contains('.')
        && host.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || [b'.', b'_', b'-'].contains(&byte)
        })
        && host.parse::<std::net::IpAddr>().is_err()
        && !comparison_host.split('.').all(|label| {
            !label.is_empty()
                && (label.bytes().all(|byte| byte.is_ascii_digit())
                    || label.strip_prefix("0x").is_some_and(|value| {
                        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    }))
        })
        && comparison_host != "localhost"
        && !["local", "internal", "localhost", "invalid", "test"]
            .iter()
            .any(|end| comparison_host.ends_with(&format!(".{end}")))
}
pub fn canonical_hash(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Evidence could not be serialized")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub fn validate_bundle(value: &Value, reports: Option<&Value>) -> Check {
    let bundle = exact(
        value,
        &[
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "research_as_of",
            "as_of_policy",
            "market_timezone",
            "created_at",
            "manifest",
            "manifest_sha256",
            "records",
            "artifacts",
            "citation_audit",
            "bundle_sha256",
        ],
    )?;
    ensure(
        bundle["schema_version"] == 1
            && text(&bundle["instrument"])
            && !bundle["instrument"].as_str().unwrap_or("").is_empty()
            && bundle["instrument"].as_str().unwrap_or("").len() <= 128,
    )?;
    for (key, allowed) in [
        (
            "data_vendors",
            &[
                "core_stock_apis",
                "technical_indicators",
                "fundamental_data",
                "news_data",
            ][..],
        ),
        ("tool_vendors", TOOLS),
    ] {
        if let Some(vendors) = bundle["manifest"].get(key) {
            ensure(vendors.as_object().is_some_and(|map| {
                map.iter()
                    .all(|(name, value)| allowed.contains(&name.as_str()) && value.is_string())
            }))?;
        }
    }
    let run = bundle["run_id"].as_str().unwrap_or("");
    ensure(
        run.len() == 36
            && run.split('-').map(str::len).collect::<Vec<_>>() == vec![8, 4, 4, 4, 12]
            && hex(&run.replace('-', ""), 32),
    )?;
    let analysis_date = bundle["analysis_date"].as_str().unwrap_or("");
    ensure(
        date(analysis_date)
            && bundle["research_as_of"] == format!("{analysis_date}T23:59:59.999999Z")
            && timestamp(&bundle["created_at"]),
    )?;
    ensure(
        bundle["as_of_policy"] == "analysis_date_end_utc"
            && (bundle["market_timezone"].is_null() || text(&bundle["market_timezone"])),
    )?;
    ensure(
        bundle["manifest"].is_object()
            && hash(&bundle["manifest_sha256"])
            && hash(&bundle["bundle_sha256"]),
    )?;
    ensure(
        bundle["manifest"]
            .as_object()
            .unwrap()
            .iter()
            .all(|(key, value)| {
                MANIFEST_KEYS.contains(&key.as_str()) && (!key.ends_with("_sha256") || hash(value))
            }),
    )?;
    safe_json(value, 0, true)?;
    ensure(canonical_hash(&bundle["manifest"])? == bundle["manifest_sha256"])?;
    let records = bundle["records"]
        .as_array()
        .ok_or("Invalid research evidence records")?;
    let artifacts = bundle["artifacts"]
        .as_object()
        .ok_or("Invalid research evidence artifacts")?;
    ensure(records.len() <= 4096 && artifacts.len() <= 16384)?;
    for (key, artifact) in artifacts {
        exact(artifact, &["kind", "payload"])?;
        ensure(
            hex(key, 64)
                && choice(&artifact["kind"], &["tool_text", "normalized_data"])
                && text(&artifact["payload"])
                && canonical_hash(artifact)? == *key,
        )?;
        if artifact["kind"] == "normalized_data" {
            let normalized: Value =
                serde_json::from_str(artifact["payload"].as_str().unwrap_or(""))
                    .map_err(|_| "Invalid normalized evidence data")?;
            safe_json(&normalized, 0, false)?;
        }
    }
    let mut ids = BTreeSet::new();
    let mut used = BTreeSet::new();
    for record in records {
        exact(
            record,
            &[
                "id",
                "analyst",
                "tool",
                "instrument",
                "parameters",
                "status",
                "fetched_at",
                "output_sha256",
                "sources",
                "attempts",
            ],
        )?;
        ensure(
            evidence_id(&record["id"]) && ids.insert(record["id"].as_str().unwrap().to_string()),
        )?;
        ensure(
            choice(
                &record["analyst"],
                &["market", "social", "news", "fundamentals", "identity"],
            ) && choice(
                &record["status"],
                &["available", "partial", "empty", "unavailable", "withheld"],
            ) && record["instrument"] == bundle["instrument"]
                && record["parameters"].is_object()
                && timestamp(&record["fetched_at"]),
        )?;
        ensure(
            choice(&record["tool"], TOOLS)
                && record["parameters"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .all(|key| PARAMETERS.contains(&key.as_str())),
        )?;
        let output_hash = record["output_sha256"].as_str().unwrap_or("");
        let output = artifacts
            .get(output_hash)
            .ok_or("Missing saved model input")?;
        ensure(
            output["kind"] == "tool_text"
                && output["payload"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with(&format!("[E:{}]\n", record["id"].as_str().unwrap())),
        )?;
        used.insert(output_hash.to_string());
        ensure(
            record["sources"]
                .as_array()
                .is_some_and(|items| items.len() <= 1024)
                && record["attempts"]
                    .as_array()
                    .is_some_and(|items| items.len() <= 1024),
        )?;
        for source in record["sources"]
            .as_array()
            .ok_or("Invalid research evidence sources")?
        {
            exact(
                source,
                &[
                    "provider",
                    "url",
                    "observed_window",
                    "publication_dates",
                    "historical_availability",
                    "units",
                    "adjustments",
                    "transformations",
                    "data_sha256",
                ],
            )?;
            ensure(
                choice(&source["provider"], PROVIDERS)
                    && public_url(&source["url"])
                    && choice(
                        &source["historical_availability"],
                        &["unknown", "within_as_of", "withheld"],
                    ),
            )?;
            if !source["observed_window"].is_null() {
                let window = exact(&source["observed_window"], &["start", "end"])?;
                let start = window["start"].as_str().unwrap_or("");
                let end = window["end"].as_str().unwrap_or("");
                ensure(
                    date(start)
                        && date(end)
                        && start <= end
                        && (end <= analysis_date
                            || (source["historical_availability"] == "withheld"
                                && record["status"] == "withheld")),
                )?;
            }
            if !source["publication_dates"].is_null() {
                ensure(
                    source["publication_dates"]
                        .as_array()
                        .is_some_and(|items| items.len() <= 10000),
                )?;
                for published in source["publication_dates"]
                    .as_array()
                    .ok_or("Invalid evidence publication dates")?
                {
                    ensure(
                        timestamp(published)
                            && ((&published.as_str().unwrap()[..10]) <= analysis_date
                                || (source["historical_availability"] == "withheld"
                                    && record["status"] == "withheld")),
                    )?;
                }
            }
            ensure(
                (source["units"].is_null() || text(&source["units"]))
                    && (source["adjustments"].is_null() || text(&source["adjustments"]))
                    && source["transformations"]
                        .as_array()
                        .is_some_and(|items| items.iter().all(text)),
            )?;
            if !source["data_sha256"].is_null() {
                let key = source["data_sha256"].as_str().unwrap_or("");
                ensure(
                    artifacts
                        .get(key)
                        .is_some_and(|artifact| artifact["kind"] == "normalized_data"),
                )?;
                used.insert(key.to_string());
            }
        }
        for attempt in record["attempts"]
            .as_array()
            .ok_or("Invalid research evidence attempts")?
        {
            exact(attempt, &["provider", "status", "elapsed_ms"])?;
            ensure(
                choice(&attempt["provider"], PROVIDERS)
                    && choice(
                        &attempt["status"],
                        &[
                            "available",
                            "empty",
                            "unavailable",
                            "withheld",
                            "not_configured",
                        ],
                    )
                    && attempt["elapsed_ms"]
                        .as_u64()
                        .is_some_and(|n| n <= 9_007_199_254_740_991),
            )?;
        }
    }
    let audit = bundle["citation_audit"]
        .as_object()
        .ok_or("Invalid citation resolution audit")?;
    ensure(
        used.len() == artifacts.len()
            && audit.keys().all(|key| REPORT_KEYS.contains(&key.as_str())),
    )?;
    for item in audit.values() {
        exact(item, &["referenced_ids", "unresolved_ids", "status"])?;
        let referenced = item["referenced_ids"]
            .as_array()
            .ok_or("Invalid citation IDs")?;
        ensure(referenced.len() <= 10000 && referenced.iter().all(citation_id))?;
        let references: BTreeSet<String> = referenced
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        ensure(references.len() == referenced.len())?;
        let missing: Vec<Value> = referenced
            .iter()
            .filter(|id| !ids.contains(id.as_str().unwrap()))
            .cloned()
            .collect();
        let unresolved = item["unresolved_ids"]
            .as_array()
            .ok_or("Invalid unresolved citation IDs")?;
        ensure(unresolved.iter().all(citation_id))?;
        ensure(
            *unresolved == missing
                && item["status"]
                    == if !missing.is_empty() {
                        "unresolved"
                    } else if !references.is_empty() {
                        "resolved"
                    } else {
                        "none"
                    },
        )?;
    }
    if let Some(reports) = reports.and_then(Value::as_object) {
        for (key, report) in reports {
            let mut referenced = BTreeSet::new();
            for segment in report.as_str().unwrap_or("").split("[E:").skip(1) {
                let token = segment.split_once(']').map(|(id, _)| id).unwrap_or("");
                referenced.insert(if citation_id(&Value::String(token.to_string())) {
                    token.to_string()
                } else {
                    "invalid-citation".to_string()
                });
            }
            let recorded: BTreeSet<String> = audit
                .get(key)
                .and_then(|v| v["referenced_ids"].as_array())
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            ensure(recorded == referenced)?;
        }
    }
    let mut body = bundle.clone();
    body.remove("bundle_sha256");
    ensure(
        serde_json::to_vec(value)
            .map_err(|_| "Invalid evidence serialization")?
            .len()
            <= 64 * 1024 * 1024,
    )?;
    ensure(canonical_hash(&Value::Object(body))? == bundle["bundle_sha256"])
}

pub fn validate_invalid(value: &Value) -> Check {
    exact(value, &["status", "reason"])?;
    ensure(
        value["status"] == "invalid"
            && choice(
                &value["reason"],
                &[
                    "malformed",
                    "hash_mismatch",
                    "citation_mismatch",
                    "unsafe_content",
                    "verification_unavailable",
                ],
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/evidence_bundle_v1.json")).unwrap()
    }
    #[test]
    fn evidence_url_boundary_preserves_canonical_public_hosts_and_rejects_private_aliases() {
        for url in [
            "https://internal.local./private",
            "https://gateway.internal./private",
            "https://host.localhost./private",
            "https://host.invalid./private",
            "https://host.test../private",
            "https://localhost./private",
            "https://%65xample.com/private",
            "https://bücher.example/private",
            "https://unsafe!.example.com/private",
            "https://0x7f.0.0.1/private",
            "https://127.1/private",
            "https://example.com:443/data",
            "https://example.com:/data",
            "https://example.com/data?",
            "https://example.com/data#",
            "https://user:password@example.com/data",
            "https://@example.com/data",
            "HTTPS://example.com/data",
            "https://EXAMPLE.com/data",
        ] {
            assert!(!public_url(&url.into()));
            assert!(safe_json(&format!("Saved source: {url}").into(), 0, true).is_err());
            let mut bundle = fixture();
            bundle["records"][0]["sources"][0]["url"] = url.into();
            let mut body = bundle.as_object().unwrap().clone();
            body.remove("bundle_sha256");
            bundle["bundle_sha256"] = canonical_hash(&Value::Object(body)).unwrap().into();
            assert!(validate_bundle(&bundle, None).is_err());
        }
        for url in [
            "https://123.example.com/data",
            "https://xn--bcher-kva.example/data",
            "https://example.com./data",
            "https://example.com/data",
        ] {
            assert!(public_url(&url.into()));
            safe_json(&format!("Saved source: {url}").into(), 0, true).unwrap();
            let mut bundle = fixture();
            bundle["records"][0]["sources"][0]["url"] = url.into();
            let mut body = bundle.as_object().unwrap().clone();
            body.remove("bundle_sha256");
            bundle["bundle_sha256"] = canonical_hash(&Value::Object(body)).unwrap().into();
            validate_bundle(&bundle, None).unwrap();
        }
    }
    #[test]
    fn verifies_python_generated_hashes_and_preserves_decimal_json_text() {
        let value = fixture();
        validate_bundle(&value, None).unwrap();
        assert_eq!(
            value["artifacts"]["ead52a216ad5191b06a9bd39d85fdfa04968f33699f9afd0244d5bc962581b90"]
                ["payload"],
            "{\"close\":123.45678901234567,\"integral\":1.0,\"tiny\":1e-07}"
        );
    }
    #[test]
    fn rejects_corruption_unknown_fields_private_urls_and_metadata_only_artifacts() {
        let original = fixture();
        let mut corrupt = original.clone();
        corrupt["artifacts"]["ead52a216ad5191b06a9bd39d85fdfa04968f33699f9afd0244d5bc962581b90"]
            ["payload"] = Value::String("{\"close\":123.46}".into());
        assert!(validate_bundle(&corrupt, None).is_err());
        let mut dirty = original.clone();
        dirty["error"] = "secret error body".into();
        assert!(validate_bundle(&dirty, None).is_err());
        let mut unsafe_url = original.clone();
        unsafe_url["records"][0]["sources"][0]["url"] =
            "https://user:password@private.invalid/data?api_key=secret".into();
        assert!(validate_bundle(&unsafe_url, None).is_err());
        let mut partial = original.clone();
        partial["artifacts"] = serde_json::json!({});
        assert!(validate_bundle(&partial, None).is_err());
        let mut invalid = original.clone();
        invalid["records"][0]["sources"][0]
            .as_object_mut()
            .unwrap()
            .remove("publication_dates");
        assert!(validate_bundle(&invalid, None).is_err());
        assert!(validate_invalid(
            &serde_json::json!({"status":"invalid", "reason":"private raw error"})
        )
        .is_err());
    }
    #[test]
    fn malformed_citations_remain_unresolved_and_unknown_vendor_keys_are_rejected() {
        let mut bundle = fixture();
        let id = bundle["records"][0]["id"].as_str().unwrap().to_string();
        bundle["citation_audit"]["market_report"] = serde_json::json!({"referenced_ids":[id,"invalid-citation"], "unresolved_ids":["invalid-citation"], "status":"unresolved"});
        let mut body = bundle.as_object().unwrap().clone();
        body.remove("bundle_sha256");
        bundle["bundle_sha256"] = canonical_hash(&Value::Object(body)).unwrap().into();
        let reports = serde_json::json!({"market_report":format!("Saved [E:{id}], malformed [E:bad id], unclosed [E:")});
        validate_bundle(&bundle, Some(&reports)).unwrap();
        bundle["manifest"]["data_vendors"] =
            serde_json::json!({"raw_endpoint":"https://example.com"});
        assert!(validate_bundle(&bundle, None).is_err());
    }
}
