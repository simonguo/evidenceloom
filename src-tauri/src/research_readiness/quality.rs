//! Inspect decoded typed data without reserializing its original payload.
use super::{
    choice, ensure, exact, list, memory, observed_sources, sorted_unique, string, Result, ERROR,
    INDICATORS,
};
use serde_json::Value;

const ISSUES: &[&str] = &[
    "invalid_source_timestamp",
    "missing_or_nonfinite_open",
    "missing_or_nonfinite_high",
    "missing_or_nonfinite_low",
    "missing_or_nonfinite_close",
    "missing_or_nonfinite_volume",
    "nonpositive_price",
    "negative_volume",
    "incoherent_ohlc",
    "conflicting_duplicate_date",
    "provisional_daily_rows",
    "source_timezone_unknown",
    "price_basis_unknown",
];
pub(super) fn warmup(name: &str) -> Option<u64> {
    match name {
        "close_10_ema" => Some(10),
        "close_50_sma" => Some(50),
        "close_200_sma" => Some(200),
        "rsi" | "atr" => Some(15),
        "boll" | "boll_ub" | "boll_lb" => Some(20),
        "macd" => Some(26),
        "macds" | "macdh" => Some(34),
        "vwma" => Some(14),
        _ => None,
    }
}
fn day(value: &Value) -> Result<i64> {
    memory::day(string(value)?).ok_or_else(|| ERROR.into())
}
fn count(value: &Value) -> Result<u64> {
    let count = value.as_u64().ok_or(ERROR)?;
    ensure(count <= 1_000_000)?;
    Ok(count)
}
fn utc(value: &Value) -> Result<i64> {
    ensure(string(value)?.len() == 27)?;
    memory::timestamp(value).map_err(|_| ERROR.into())
}
pub(super) fn validate(
    value: &Value,
    record: &Value,
    evidence: &Value,
    policy: &Value,
) -> Result<()> {
    exact(
        value,
        &[
            "kind",
            "schema_version",
            "policy_version",
            "symbol",
            "analysis_date",
            "observed_at",
            "provider",
            "source_timezone",
            "timezone_origin",
            "requested_window",
            "integrity_status",
            "completion_status",
            "completion_policy",
            "price_basis",
            "revision_status",
            "calendar_coverage_status",
            "rows",
            "issues",
            "indicator_assessments",
        ],
    )?;
    ensure(
        value["kind"] == "market_verification_quality"
            && value["schema_version"].as_u64() == Some(1)
            && value["policy_version"] == "provider-daily-integrity-v1"
            && value["completion_policy"]
                == "original_local_and_utc_dates_elapsed_midnight_daily_label"
            && value["symbol"] == evidence["instrument"]
            && value["analysis_date"] == evidence["analysis_date"]
            && value["revision_status"] == "unknown"
            && value["calendar_coverage_status"] == "unknown",
    )?;
    let observed = utc(&value["observed_at"])?;
    ensure(
        utc(&policy["research_started_at"])? <= observed
            && observed <= utc(&policy["research_as_of"])?
            && observed <= memory::timestamp(&record["fetched_at"]).map_err(|_| ERROR)?,
    )?;
    ensure(
        choice(
            &value["provider"],
            &[
                "yfinance",
                "eastmoney",
                "tencent",
                "alpha_vantage",
                "akshare",
            ],
        ) && observed_sources(record, evidence)
            .iter()
            .any(|source| source["provider"] == value["provider"]),
    )?;
    let zone = &value["source_timezone"];
    ensure(
        zone.is_null()
            || zone
                .as_str()
                .is_some_and(|text| !text.is_empty() && text.chars().count() <= 128),
    )?;
    ensure(choice(
        &value["timezone_origin"],
        &[
            "timestamp",
            "provider_metadata",
            "symbol_market_convention",
            "unknown",
        ],
    ))?;
    exact(&value["requested_window"], &["start", "end"])?;
    let window = &value["requested_window"];
    let analysis_date = day(&evidence["analysis_date"])?;
    ensure(
        day(&window["end"])? <= analysis_date
            && (window["start"].is_null() || day(&window["start"])? <= day(&window["end"])?),
    )?;
    ensure(
        choice(&value["integrity_status"], &["valid", "invalid", "empty"])
            && choice(
                &value["completion_status"],
                &[
                    "complete_provider_daily_rows",
                    "provisional",
                    "unknown",
                    "empty",
                ],
            ),
    )?;
    let basis = &value["price_basis"];
    exact(basis, &["status", "value"])?;
    ensure(
        (basis["status"] == "observed"
            && basis["value"]
                .as_str()
                .is_some_and(|text| !text.is_empty() && text.chars().count() <= 1024))
            || (basis["status"] == "unknown" && basis["value"].is_null()),
    )?;
    let rows = &value["rows"];
    exact(
        rows,
        &[
            "received",
            "in_window",
            "valid",
            "invalid",
            "identical_duplicates_collapsed",
            "provisional",
            "unknown_completion",
            "usable_complete",
            "conflicting_duplicate_dates",
            "latest_received_date",
            "latest_usable_date",
        ],
    )?;
    let received = count(&rows["received"])?;
    for key in [
        "received",
        "in_window",
        "valid",
        "invalid",
        "identical_duplicates_collapsed",
        "provisional",
        "unknown_completion",
        "usable_complete",
    ] {
        ensure(count(&rows[key])? <= received)?;
    }
    ensure(
        count(&rows["usable_complete"])?
            + count(&rows["provisional"])?
            + count(&rows["unknown_completion"])?
            == count(&rows["valid"])?,
    )?;
    sorted_unique(&rows["conflicting_duplicate_dates"], |value| {
        value
            .as_str()
            .is_some_and(|text| memory::day(text).is_some())
    })?;
    for label in list(&rows["conflicting_duplicate_dates"])? {
        ensure(day(label)? <= analysis_date)?;
    }
    for key in ["latest_received_date", "latest_usable_date"] {
        ensure(rows[key].is_null() || day(&rows[key])? <= analysis_date)?;
    }
    ensure((count(&rows["usable_complete"])? > 0) != rows["latest_usable_date"].is_null())?;
    if !rows["latest_usable_date"].is_null() {
        ensure(
            !rows["latest_received_date"].is_null()
                && day(&rows["latest_usable_date"])? <= day(&rows["latest_received_date"])?,
        )?;
    }
    let integrity = if count(&rows["invalid"])? > 0 {
        "invalid"
    } else if count(&rows["valid"])? > 0 {
        "valid"
    } else {
        "empty"
    };
    ensure(value["integrity_status"] == integrity)?;
    sorted_unique(&value["issues"], |issue| choice(issue, ISSUES))?;
    let indicators = value["indicator_assessments"].as_object().ok_or(ERROR)?;
    ensure(indicators.len() <= 128)?;
    for (name, item) in indicators {
        ensure(!name.is_empty() && name.chars().count() <= 128)?;
        exact(item, &["status", "required_rows", "usable_rows", "value"])?;
        ensure(choice(
            &item["status"],
            &[
                "available",
                "insufficient_warmup",
                "unavailable_input",
                "unsupported",
                "calculation_failed",
            ],
        ))?;
        let expected = warmup(name);
        ensure(match expected {
            Some(expected) => item["required_rows"].as_u64() == Some(expected),
            None => item["required_rows"].is_null(),
        })?;
        ensure(item["usable_rows"].as_u64() == rows["usable_complete"].as_u64())?;
        if item["status"] == "available" {
            ensure(
                expected.is_some_and(|required| {
                    item["usable_rows"]
                        .as_u64()
                        .is_some_and(|rows| rows >= required)
                }) && item["value"].as_f64().is_some_and(f64::is_finite),
            )?;
        } else {
            ensure(item["value"].is_null())?;
        }
    }
    // The policy list is independently frozen; missing assessments become unknown.
    ensure(
        policy["required_indicators"]
            .as_array()
            .is_some_and(|items| items.len() == INDICATORS.len()),
    )?;
    super::market_inputs::validate(value, record, evidence)
}
