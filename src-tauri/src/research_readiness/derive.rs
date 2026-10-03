use super::{
    data_hashes, ensure, json, list, memory, observed_sources, quality, string, Result, ERROR,
};
use serde_json::Value;
use std::collections::BTreeSet;

type Findings = Vec<(&'static str, &'static str)>;
fn receipt_findings(record: &Value) -> Result<Findings> {
    Ok(match string(&record["status"])? {
        "available" => vec![],
        "unavailable" => vec![("unavailable", "provider_unavailable")],
        "withheld" => vec![("unavailable", "source_withheld")],
        "empty" => vec![("missing", "empty_observations")],
        "partial" => vec![("partial", "partial_observations")],
        _ => return Err(ERROR.into()),
    })
}
fn check(key: &str, required: bool, records: &[&Value], findings: &Findings) -> Value {
    let status = [
        "invalid",
        "unavailable",
        "missing",
        "partial",
        "unknown",
        "not_selected",
    ]
    .into_iter()
    .find(|status| findings.iter().any(|finding| finding.0 == *status))
    .unwrap_or("passed");
    let reasons: BTreeSet<_> = findings.iter().map(|finding| finding.1).collect();
    let ids: BTreeSet<_> = records
        .iter()
        .filter_map(|record| record["id"].as_str())
        .collect();
    let hashes: BTreeSet<_> = records
        .iter()
        .flat_map(|record| data_hashes(record))
        .collect();
    json!({"key":key,"required":required,"status":status,"reason_codes":reasons,"evidence_ids":ids,"artifact_sha256s":hashes})
}
pub(super) fn derive_checks(policy: &Value, evidence: &Value) -> Result<Value> {
    let mut records: Vec<_> = list(&evidence["records"])?.iter().collect();
    records.sort_by_key(|record| record["id"].as_str().unwrap_or_default());
    let mut temporal = vec![];
    if policy["temporal_mode"] != "same_host_date" {
        temporal.push((
            "unknown",
            if policy["temporal_mode"] == "historical_date_only" {
                "historical_availability_unknown"
            } else {
                "future_analysis_date"
            },
        ));
    } else {
        let cutoff = memory::timestamp(&policy["research_as_of"]).map_err(|_| ERROR)?;
        for record in &records {
            if memory::timestamp(&record["fetched_at"]).map_err(|_| ERROR)? > cutoff {
                temporal.push(("unknown", "historical_availability_unknown"));
                break;
            }
        }
    }
    let mut checks = vec![check("temporal_availability", true, &records, &temporal)];
    let market: Vec<_> = records
        .iter()
        .copied()
        .filter(|record| {
            record["analyst"] == "market"
                && record["tool"] == "get_verified_market_snapshot"
                && record["parameters"]["symbol"] == evidence["instrument"]
                && record["parameters"]["curr_date"] == evidence["analysis_date"]
        })
        .collect();
    let mut market_findings = vec![];
    let mut indicator_findings = vec![];
    let mut bases = BTreeSet::new();
    if !list(&policy["selected_analysts"])?
        .iter()
        .any(|analyst| analyst == "market")
    {
        market_findings.push(("not_selected", "market_not_selected"));
    } else if market.is_empty() {
        market_findings.push(("missing", "missing_required_verification"));
    } else {
        for record in &market {
            market_findings.extend(receipt_findings(record)?);
            let mut qualities = vec![];
            let mut malformed = false;
            for digest in data_hashes(record) {
                let artifact = &evidence["artifacts"][&digest];
                let parsed = string(&artifact["payload"]).and_then(memory::parse_json);
                match parsed {
                    Ok(value)
                        if value.is_object() && value["kind"] == "market_verification_quality" =>
                    {
                        let local =
                            record["sources"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|source| {
                                    source["data_sha256"] == digest
                                        && source["provider"] == "local_calculation"
                                });
                        if local && quality::validate(&value, record, evidence, policy).is_ok() {
                            qualities.push(value);
                        } else {
                            malformed = true;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => malformed = true,
                }
            }
            if malformed || qualities.len() != 1 {
                market_findings.push(("unknown", "verification_quality_unknown"));
                indicator_findings.push(("unknown", "verification_quality_unknown"));
                continue;
            }
            let value = &qualities[0];
            let rows = &value["rows"];
            if value["integrity_status"] == "invalid" {
                market_findings.push(("invalid", "invalid_ohlcv"));
            }
            if !list(&rows["conflicting_duplicate_dates"])?.is_empty() {
                market_findings.push(("invalid", "conflicting_daily_rows"));
            }
            if value["integrity_status"] == "empty" {
                market_findings.push(("missing", "empty_observations"));
            }
            if rows["unknown_completion"].as_u64().unwrap_or(0) > 0
                || value["source_timezone"].is_null()
                || value["timezone_origin"] == "unknown"
            {
                market_findings.push(("unknown", "unknown_bar_completion"));
            }
            if rows["usable_complete"] == 0 {
                market_findings.push(if rows["provisional"].as_u64().unwrap_or(0) > 0 {
                    ("partial", "provisional_daily_rows")
                } else {
                    ("unknown", "unknown_bar_completion")
                });
            } else {
                let latest = memory::day(string(&rows["latest_usable_date"])?).ok_or(ERROR)?;
                let analysis = memory::day(string(&evidence["analysis_date"])?).ok_or(ERROR)?;
                if analysis - latest > policy["max_complete_row_age_days"].as_i64().ok_or(ERROR)? {
                    market_findings.push(("unknown", "stale_or_unknown_session_coverage"));
                }
            }
            if value["price_basis"]["status"] == "unknown" {
                market_findings.push(("unknown", "unknown_price_basis"));
            } else {
                bases.insert(string(&value["price_basis"]["value"])?.to_string());
            }
            for name in list(&policy["required_indicators"])? {
                let indicator = &value["indicator_assessments"][string(name)?];
                let state = indicator["status"].as_str().unwrap_or("unavailable_input");
                if state != "available" {
                    indicator_findings.push(match state {
                        "insufficient_warmup" => ("partial", "insufficient_indicator_history"),
                        "unsupported" => ("partial", "unsupported_indicator"),
                        "calculation_failed" => ("partial", "indicator_calculation_failed"),
                        "unavailable_input" => ("unknown", "verification_quality_unknown"),
                        _ => return Err(ERROR.into()),
                    });
                }
            }
        }
    }
    if bases.len() > 1 {
        market_findings.push(("unknown", "price_basis_conflict"));
    }
    checks.push(check(
        "market_verification",
        true,
        &market,
        &market_findings,
    ));
    indicator_findings.extend(market_findings);
    checks.push(check(
        "indicator_warmup",
        true,
        &market,
        &indicator_findings,
    ));
    for analyst in list(&policy["selected_analysts"])? {
        let selected: Vec<_> = records
            .iter()
            .copied()
            .filter(|record| record["analyst"] == *analyst)
            .collect();
        let mut findings = vec![];
        for record in &selected {
            findings.extend(receipt_findings(record)?);
        }
        if selected.is_empty() {
            findings.push(("missing", "missing_selected_source"));
        } else if !selected.iter().any(|record| {
            record["status"] == "available" && !observed_sources(record, evidence).is_empty()
        }) {
            findings.push(("unknown", "unknown_source_provenance"));
        }
        for record in &selected {
            if record["status"] == "available" && observed_sources(record, evidence).is_empty() {
                findings.push(("unknown", "unknown_source_provenance"));
            }
        }
        checks.push(check(
            &format!("selected_sources.{}", string(analyst)?),
            true,
            &selected,
            &findings,
        ));
    }
    checks.push(check(
        "price_vintage",
        false,
        &market,
        &vec![("unknown", "unknown_price_vintage")],
    ));
    checks.push(check(
        "exchange_calendar_coverage",
        false,
        &market,
        &vec![("unknown", "unknown_exchange_calendar")],
    ));
    ensure(checks.len() == 5 + list(&policy["selected_analysts"])?.len())?;
    Ok(json!(checks))
}
