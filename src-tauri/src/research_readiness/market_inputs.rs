//! Offline proof of the source rows; typed summaries cannot override saved facts.
use super::{ensure, list, memory, string, Result, ERROR};
use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use regex::Regex;
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

const FIELDS: &[&str] = &["Open", "High", "Low", "Close", "Volume"];
const SOURCE: &[&str] = &[
    "SourceTimestamp",
    "SourceTimezone",
    "SourceUTCOffset",
    "TimezoneOrigin",
];
const OPTIONAL: &[&str] = &["HistoryRequestStart", "HistoryRequestEnd", "PriceBasis"];
const ZONES: &[&str] = &[
    "UTC",
    "Etc/UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Vancouver",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Tokyo",
    "Asia/Seoul",
    "Asia/Singapore",
    "Asia/Taipei",
    "Asia/Kolkata",
    "Asia/Calcutta",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Zurich",
    "Europe/Amsterdam",
    "Europe/Brussels",
    "Europe/Madrid",
    "Europe/Rome",
    "Europe/Stockholm",
    "Europe/Oslo",
    "Europe/Copenhagen",
    "Europe/Helsinki",
    "Europe/Vienna",
    "Europe/Lisbon",
    "Europe/Istanbul",
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Perth",
    "Pacific/Auckland",
    "Africa/Johannesburg",
];
type Row = Map<String, Value>;
enum Zone {
    Named(Tz),
    Fixed(FixedOffset),
}
impl Zone {
    fn local(&self, value: &NaiveDateTime) -> Option<DateTime<FixedOffset>> {
        match self {
            Self::Named(zone) => zone
                .from_local_datetime(value)
                .single()
                .map(|stamp| stamp.fixed_offset()),
            Self::Fixed(zone) => zone.from_local_datetime(value).single(),
        }
    }
    fn convert(&self, value: &DateTime<FixedOffset>) -> DateTime<FixedOffset> {
        match self {
            Self::Named(zone) => value.with_timezone(zone).fixed_offset(),
            Self::Fixed(zone) => value.with_timezone(zone),
        }
    }
}
fn offset(value: &str) -> Result<FixedOffset> {
    let minutes = memory::offset(&Value::String(value.into())).map_err(|_| ERROR)?;
    ensure(minutes.abs() <= 14 * 60 && value != "-00:00")?;
    FixedOffset::east_opt((minutes * 60) as i32).ok_or_else(|| ERROR.into())
}
fn zone(value: &Value) -> Option<Zone> {
    let value = value.as_str()?;
    if value == "UTC" {
        return FixedOffset::east_opt(0).map(Zone::Fixed);
    }
    if let Some(value) = value.strip_prefix("UTC") {
        return offset(value).ok().map(Zone::Fixed);
    }
    if !ZONES.contains(&value) {
        return None;
    }
    value.parse::<Tz>().ok().map(Zone::Named)
}
struct Stamp {
    label: i64,
    time: NaiveDateTime,
    zoned: Option<DateTime<FixedOffset>>,
}
fn stamp(row: &Row) -> Result<Stamp> {
    static STAMP: OnceLock<Regex> = OnceLock::new();
    let pattern = STAMP.get_or_init(|| Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})?$").expect("fixed source timestamp"));
    let value = string(&row["SourceTimestamp"])?;
    let capture = pattern.captures(value).ok_or(ERROR)?;
    if let Some(suffix) = capture.get(6).filter(|suffix| suffix.as_str() != "Z") {
        offset(suffix.as_str())?;
    }
    let label = memory::day(&capture[1]).ok_or(ERROR)?;
    ensure(capture[4].parse::<u32>().is_ok_and(|seconds| seconds < 60))?;
    let time = NaiveDateTime::parse_from_str(
        &value[..capture
            .get(6)
            .map_or(value.len(), |capture| capture.start())],
        "%Y-%m-%dT%H:%M:%S%.f",
    )
    .map_err(|_| ERROR)?;
    let origin = string(&row["TimezoneOrigin"])?;
    ensure(
        [
            "timestamp",
            "provider_metadata",
            "symbol_market_convention",
            "unknown",
        ]
        .contains(&origin),
    )?;
    let Some(zone) = zone(&row["SourceTimezone"]) else {
        return Ok(Stamp {
            label,
            time,
            zoned: None,
        });
    };
    let zoned = if capture.get(6).is_some() {
        let original = DateTime::parse_from_rfc3339(value).map_err(|_| ERROR)?;
        ensure(offset(string(&row["SourceUTCOffset"])?)? == *original.offset())?;
        let converted = zone.convert(&original);
        ensure(converted.naive_local() == original.naive_local())?;
        converted
    } else {
        ensure(row["SourceUTCOffset"].is_null() && origin != "timestamp")?;
        zone.local(&time).ok_or(ERROR)?
    };
    Ok(Stamp {
        label,
        time,
        zoned: Some(zoned),
    })
}
fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && value.abs() <= 9_007_199_254_740_991.0)
}
fn compare(first: &Value, second: &Value) -> Option<std::cmp::Ordering> {
    number(first)?.partial_cmp(&number(second)?)
}
fn valid(row: &Row) -> bool {
    use std::cmp::Ordering::{Greater, Less};
    let zero = Value::from(0);
    ["Open", "High", "Low", "Close"]
        .iter()
        .all(|field| compare(&row[*field], &zero) == Some(Greater))
        && compare(&row["Volume"], &zero).is_some_and(|comparison| comparison != Less)
        && ["Open", "Close", "Low"].iter().all(|field| {
            compare(&row["High"], &row[*field]).is_some_and(|comparison| comparison != Less)
        })
        && ["Open", "Close", "High"].iter().all(|field| {
            compare(&row["Low"], &row[*field]).is_some_and(|comparison| comparison != Greater)
        })
}
fn equal(first: &Value, second: &Value) -> bool {
    compare(first, second).map_or(first == second, |comparison| {
        comparison == std::cmp::Ordering::Equal
    })
}
fn signature_equal(first: &Row, second: &Row) -> bool {
    FIELDS
        .iter()
        .chain(SOURCE)
        .all(|field| equal(&first[*field], &second[*field]))
}
fn table(value: &Value) -> Result<Option<Vec<Row>>> {
    let Some(map) = value.as_object() else {
        return Ok(None);
    };
    if map.len() != 2 || !map.contains_key("columns") || !map.contains_key("rows") {
        return Ok(None);
    }
    let Some(columns) = map["columns"].as_array() else {
        return Ok(None);
    };
    let Some(columns) = columns
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(None);
    };
    if !["Date"]
        .iter()
        .chain(FIELDS)
        .chain(SOURCE)
        .all(|field| columns.contains(field))
    {
        return Ok(None);
    }
    ensure(
        columns.len() == columns.iter().collect::<BTreeSet<_>>().len()
            && columns.iter().all(|column| {
                *column == "Date"
                    || FIELDS.contains(column)
                    || SOURCE.contains(column)
                    || OPTIONAL.contains(column)
            }),
    )?;
    let rows = list(&map["rows"])?;
    ensure(!rows.is_empty() && rows.len() <= 1_000_000)?;
    rows.iter()
        .map(|row| {
            let values = list(row)?;
            ensure(
                values.len() == columns.len()
                    && values
                        .iter()
                        .all(|value| !value.is_array() && !value.is_object()),
            )?;
            let row: Row = columns
                .iter()
                .zip(values)
                .map(|(column, value)| ((*column).into(), value.clone()))
                .collect();
            ensure(
                FIELDS
                    .iter()
                    .all(|field| !row[*field].is_number() || number(&row[*field]).is_some()),
            )?;
            Ok(row)
        })
        .collect::<Result<Vec<_>>>()
        .map(Some)
}
fn day(value: &Value) -> Result<i64> {
    memory::day(string(value)?).ok_or_else(|| ERROR.into())
}
fn count(value: &Value) -> Result<usize> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| ERROR.into())
}
fn state(row: &Row, observed: &DateTime<Utc>, source_zone: &Value) -> Result<&'static str> {
    let stamp = stamp(row)?;
    if source_zone.as_str().is_none_or(str::is_empty)
        || !["timestamp", "provider_metadata"].contains(&string(&row["TimezoneOrigin"])?)
    {
        return Ok("unknown");
    }
    let Some(original) = stamp.zoned else {
        return Ok("unknown");
    };
    if stamp.time.hour() != 0
        || stamp.time.minute() != 0
        || stamp.time.second() != 0
        || stamp.time.nanosecond() != 0
    {
        return Ok("provisional");
    }
    let zone = zone(&row["SourceTimezone"]).ok_or(ERROR)?;
    let observed_local = zone.convert(&observed.fixed_offset());
    Ok(
        if original.date_naive() >= observed.date_naive()
            || original.date_naive() >= observed_local.date_naive()
        {
            "provisional"
        } else {
            "complete_provider_daily_rows"
        },
    )
}
fn proof(quality: &Value, source: &Value, rows: &[Row]) -> Result<()> {
    let counts = &quality["rows"];
    ensure(
        count(&counts["in_window"])? == rows.len() && count(&counts["received"])? >= rows.len(),
    )?;
    let observed = DateTime::parse_from_rfc3339(string(&quality["observed_at"])?)
        .map_err(|_| ERROR)?
        .with_timezone(&Utc);
    let requested = &quality["requested_window"];
    let end = day(&requested["end"])?;
    let start = if requested["start"].is_null() {
        None
    } else {
        Some(day(&requested["start"])?)
    };
    let window = &source["observed_window"];
    let saved_start = day(&window["start"])?;
    let saved_end = day(&window["end"])?;
    if rows[0].contains_key("PriceBasis") && quality["price_basis"]["status"] == "observed" {
        ensure(
            rows.iter()
                .all(|row| row["PriceBasis"] == quality["price_basis"]["value"]),
        )?;
    }
    if rows[0].contains_key("HistoryRequestStart") {
        let value = &rows[0]["HistoryRequestStart"];
        ensure(
            rows.iter().all(|row| &row["HistoryRequestStart"] == value)
                && value == &requested["start"],
        )?;
        day(value)?;
    }
    if rows[0].contains_key("HistoryRequestEnd") {
        let value = &rows[0]["HistoryRequestEnd"];
        ensure(rows.iter().all(|row| &row["HistoryRequestEnd"] == value) && day(value)? > end)?;
    }
    let mut groups: BTreeMap<i64, Vec<&Row>> = BTreeMap::new();
    for row in rows {
        let label = string(&row["Date"])?;
        ensure(label.is_ascii() && label.len() >= 10)?;
        let day = memory::day(&label[..10]).ok_or(ERROR)?;
        if label.len() > 10 {
            let tail = &label[10..];
            ensure(
                tail == "T00:00:00"
                    || tail.strip_prefix("T00:00:00.").is_some_and(|fraction| {
                        (1..=9).contains(&fraction.len())
                            && fraction.bytes().all(|byte| byte == b'0')
                    }),
            )?;
        }
        ensure(
            stamp(row)?.label == day
                && start.is_none_or(|start| day >= start)
                && day <= end
                && saved_start <= day
                && day <= saved_end,
        )?;
        groups.entry(day).or_default().push(row);
    }
    let first = *groups.first_key_value().ok_or(ERROR)?.0;
    let last = *groups.last_key_value().ok_or(ERROR)?.0;
    ensure(
        first == saved_start && last == saved_end && day(&counts["latest_received_date"])? == last,
    )?;
    let mut valid_rows = vec![];
    let mut conflicts = vec![];
    let mut collapsed = 0;
    for (label, group) in groups {
        if group
            .iter()
            .skip(1)
            .any(|row| !signature_equal(group[0], row))
        {
            conflicts.push(label);
        } else {
            collapsed += group.len() - 1;
            if valid(group[0]) {
                valid_rows.push(group[0]);
            }
        }
    }
    ensure(
        count(&counts["valid"])? == valid_rows.len()
            && count(&counts["identical_duplicates_collapsed"])? == collapsed,
    )?;
    let saved_conflicts = list(&counts["conflicting_duplicate_dates"])?
        .iter()
        .map(day)
        .collect::<Result<Vec<_>>>()?;
    ensure(saved_conflicts == conflicts)?;
    let invalid = rows.len() - valid_rows.len() - collapsed;
    ensure(
        invalid <= count(&counts["invalid"])?
            && count(&counts["invalid"])? <= invalid + count(&counts["received"])? - rows.len(),
    )?;
    let integrity = if count(&counts["invalid"])? > 0 {
        "invalid"
    } else if !valid_rows.is_empty() {
        "valid"
    } else {
        "empty"
    };
    ensure(quality["integrity_status"] == integrity)?;
    let zones: BTreeSet<_> = valid_rows
        .iter()
        .filter_map(|row| {
            row["SourceTimezone"]
                .as_str()
                .filter(|value| !value.is_empty())
        })
        .collect();
    let origins: BTreeSet<_> = valid_rows
        .iter()
        .filter_map(|row| row["TimezoneOrigin"].as_str())
        .collect();
    let mut zone_name = if zones.len() == 1 {
        zones.first().copied()
    } else {
        None
    };
    let mut origin = if origins.contains("provider_metadata") {
        "provider_metadata"
    } else if origins == BTreeSet::from(["timestamp"]) {
        "timestamp"
    } else if origins == BTreeSet::from(["symbol_market_convention"]) {
        "symbol_market_convention"
    } else {
        "unknown"
    };
    if zone_name.is_none()
        || !valid_rows
            .iter()
            .map(|row| stamp(row))
            .collect::<Result<Vec<_>>>()?
            .iter()
            .any(|stamp| stamp.zoned.is_some())
    {
        zone_name = None;
        origin = "unknown";
    }
    ensure(
        quality["source_timezone"].as_str() == zone_name && quality["timezone_origin"] == origin,
    )?;
    let states = valid_rows
        .iter()
        .map(|row| state(row, &observed, &quality["source_timezone"]))
        .collect::<Result<Vec<_>>>()?;
    let complete: Vec<_> = valid_rows
        .iter()
        .zip(&states)
        .filter_map(|(row, state)| (*state == "complete_provider_daily_rows").then_some(*row))
        .collect();
    ensure(
        count(&counts["usable_complete"])? == complete.len()
            && count(&counts["provisional"])?
                == states
                    .iter()
                    .filter(|state| **state == "provisional")
                    .count()
            && count(&counts["unknown_completion"])?
                == states.iter().filter(|state| **state == "unknown").count(),
    )?;
    let latest = complete
        .last()
        .map(|row| &string(&row["SourceTimestamp"]).unwrap()[..10]);
    ensure(counts["latest_usable_date"].as_str() == latest)?;
    let status = if complete.is_empty() {
        if states.contains(&"provisional") {
            "provisional"
        } else if states.contains(&"unknown") {
            "unknown"
        } else {
            "empty"
        }
    } else {
        states.last().copied().ok_or(ERROR)?
    };
    ensure(quality["completion_status"] == status)
}
pub(super) fn validate(quality: &Value, record: &Value, evidence: &Value) -> Result<()> {
    let mut tables = 0;
    for source in list(&record["sources"])? {
        if source["provider"] != quality["provider"]
            || source["historical_availability"] == "withheld"
        {
            continue;
        }
        let Some(hash) = source["data_sha256"].as_str() else {
            continue;
        };
        let artifact = &evidence["artifacts"][hash];
        ensure(artifact["kind"] == "normalized_data")?;
        let value = memory::parse_json(string(&artifact["payload"])?).map_err(|_| ERROR)?;
        if let Some(rows) = table(&value)? {
            tables += 1;
            proof(quality, source, &rows)?;
        }
    }
    ensure(tables > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research_readiness::test_support;
    use serde_json::json;

    fn fixture() -> (Value, Value, Vec<Row>) {
        let evidence = test_support::evidence();
        let record = &evidence["records"][0];
        let source = record["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["provider"] == "yfinance")
            .unwrap()
            .clone();
        let quality = record["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|source| {
                let value = memory::parse_json(
                    evidence["artifacts"][source["data_sha256"].as_str().unwrap()]["payload"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                (value["kind"] == "market_verification_quality").then_some(value)
            })
            .unwrap();
        let payload = memory::parse_json(
            evidence["artifacts"][source["data_sha256"].as_str().unwrap()]["payload"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        (quality, source, table(&payload).unwrap().unwrap())
    }
    fn clock_row(timestamp: &str, name: &str, utc_offset: Value, origin: &str) -> Row {
        json!({"SourceTimestamp":timestamp,"SourceTimezone":name,"SourceUTCOffset":utc_offset,"TimezoneOrigin":origin}).as_object().unwrap().clone()
    }
    #[test]
    fn saved_rows_reject_summary_count_clock_and_window_contradictions() {
        let (quality, source, rows) = fixture();
        proof(&quality, &source, &rows).unwrap();
        for mode in [
            "completion",
            "origin",
            "zone",
            "in_window",
            "latest",
            "end",
            "valid",
        ] {
            let mut changed = quality.clone();
            match mode {
                "completion" => changed["completion_status"] = "unknown".into(),
                "origin" => changed["timezone_origin"] = "symbol_market_convention".into(),
                "zone" => changed["source_timezone"] = "Not_A_Real_Timezone".into(),
                "in_window" => changed["rows"]["in_window"] = 0.into(),
                "latest" => changed["rows"]["latest_usable_date"] = "2026-01-09".into(),
                "end" => changed["requested_window"]["end"] = "2026-01-01".into(),
                "valid" => changed["rows"]["valid"] = 251.into(),
                _ => unreachable!(),
            }
            assert!(proof(&changed, &source, &rows).is_err(), "{mode}");
        }
        let mut changed = quality;
        changed["rows"]["received"] = 252.into();
        changed["rows"]["invalid"] = 2.into();
        changed["integrity_status"] = "invalid".into();
        proof(&changed, &source, &rows).unwrap();
        changed["rows"]["valid"] = 252.into();
        assert!(proof(&changed, &source, &rows).is_err());
    }
    #[test]
    fn date_labels_require_exact_midnight_grammar() {
        let (quality, source, rows) = fixture();
        let date = rows[0]["Date"].as_str().unwrap()[..10].to_owned();
        for suffix in ["", "T00:00:00", "T00:00:00.0", "T00:00:00.000000000"] {
            let mut changed = rows.clone();
            changed[0]["Date"] = format!("{date}{suffix}").into();
            proof(&quality, &source, &changed).unwrap();
        }
        for suffix in [
            " 00:00:00",
            "T00:00",
            "T00:00:00Z",
            "T00:00:00+00:00",
            "T00:00:00.",
            "T00:00:00.0000000000",
            "T00:00:00.000000001",
            "T00:00:00,0",
        ] {
            let mut changed = rows.clone();
            changed[0]["Date"] = format!("{date}{suffix}").into();
            assert!(proof(&quality, &source, &changed).is_err(), "{suffix}");
        }
    }
    #[test]
    fn numeric_bound_bool_and_ohlcv_geometry_are_proved_from_rows() {
        let (quality, source, rows) = fixture();
        let mut boundary = rows.clone();
        for field in FIELDS {
            boundary[0][*field] = 9_007_199_254_740_991_u64.into();
        }
        proof(&quality, &source, &boundary).unwrap();
        for field in FIELDS {
            let mut changed = boundary.clone();
            changed[0][*field] = 9_007_199_254_740_992_u64.into();
            assert!(proof(&quality, &source, &changed).is_err(), "{field}");
        }
        let mut changed = rows.clone();
        changed[0]["Open"] = 9_007_199_254_740_993_u64.into();
        changed[0]["High"] = 9_007_199_254_740_992_u64.into();
        assert!(proof(&quality, &source, &changed).is_err());
        for (field, value) in [
            ("Volume", json!(-1)),
            ("Open", json!(true)),
            ("High", json!(1)),
            ("Close", Value::Null),
        ] {
            let mut changed = rows.clone();
            changed[0][field] = value;
            assert!(proof(&quality, &source, &changed).is_err(), "{field}");
        }
        for text in [
            "124.07345678901234",
            "4.7720792539784895e-08",
            "9007199254740991.0",
        ] {
            assert_eq!(
                memory::parse_json(text).unwrap().as_f64().unwrap(),
                text.parse::<f64>().unwrap()
            );
        }
    }
    #[test]
    fn identical_numeric_duplicates_and_conflicts_keep_distinct_meaning() {
        let (mut quality, source, mut rows) = fixture();
        rows.last_mut().unwrap()["Volume"] = 0.into();
        let mut duplicate = rows.last().unwrap().clone();
        duplicate["Volume"] = 0.0.into();
        rows.push(duplicate);
        quality["rows"]["received"] = 251.into();
        quality["rows"]["in_window"] = 251.into();
        quality["rows"]["identical_duplicates_collapsed"] = 1.into();
        proof(&quality, &source, &rows).unwrap();
        rows.last_mut().unwrap()["Volume"] = false.into();
        assert!(proof(&quality, &source, &rows).is_err());
        quality["rows"]["identical_duplicates_collapsed"] = 0.into();
        quality["rows"]["conflicting_duplicate_dates"] = json!(["2026-01-08"]);
        quality["rows"]["valid"] = 249.into();
        quality["rows"]["usable_complete"] = 249.into();
        quality["rows"]["invalid"] = 2.into();
        quality["rows"]["latest_usable_date"] = "2026-01-07".into();
        quality["integrity_status"] = "invalid".into();
        proof(&quality, &source, &rows).unwrap();
    }
    #[test]
    fn hard_numeric_bound_precedes_duplicate_signatures_even_for_invalid_quality() {
        let payload = json!({"columns":["Date","Open","High","Low","Close","Volume","SourceTimestamp","SourceTimezone","SourceUTCOffset","TimezoneOrigin"],"rows":[["2026-01-08",9_007_199_254_740_992_u64,9_007_199_254_740_992_u64,1,1,0,"2026-01-08T00:00:00Z","UTC","+00:00","timestamp"],["2026-01-08",9_007_199_254_740_993_u64,9_007_199_254_740_992_u64,1,1,0,"2026-01-08T00:00:00Z","UTC","+00:00","timestamp"]]});
        assert!(table(&payload).is_err());
    }
    #[test]
    fn honest_unknown_clocks_and_explicit_fixed_metadata_remain_classifiable() {
        let (quality, source, rows) = fixture();
        for name in [
            "UTC+08:00",
            "UTC-05:00",
            "Etc/UTC",
            "america/new_york",
            "US/Eastern",
        ] {
            let mut rows = rows.clone();
            let mut quality = quality.clone();
            for row in &mut rows {
                row["SourceTimestamp"] =
                    format!("{}T00:00:00", &row["Date"].as_str().unwrap()[..10]).into();
                row["SourceTimezone"] = name.into();
                row["SourceUTCOffset"] = Value::Null;
                row["TimezoneOrigin"] = "provider_metadata".into();
            }
            if zone(&json!(name)).is_none() {
                quality["source_timezone"] = Value::Null;
                quality["timezone_origin"] = "unknown".into();
                quality["rows"]["unknown_completion"] = 250.into();
                quality["rows"]["usable_complete"] = 0.into();
                quality["rows"]["latest_usable_date"] = Value::Null;
                quality["completion_status"] = "unknown".into();
            } else {
                quality["source_timezone"] = name.into();
                quality["timezone_origin"] = "provider_metadata".into();
            }
            proof(&quality, &source, &rows).unwrap();
        }
    }
    #[test]
    fn source_clock_registry_offsets_dst_and_nanoseconds_remain_conservative() {
        let observed = "2025-11-03T04:30:00Z".parse::<DateTime<Utc>>().unwrap();
        let row = clock_row(
            "2025-11-02T00:00:00-04:00",
            "America/New_York",
            json!("-04:00"),
            "timestamp",
        );
        assert_eq!(
            state(&row, &observed, &json!("America/New_York")).unwrap(),
            "provisional"
        );
        let row = clock_row(
            "2025-11-01T00:00:00-04:00",
            "America/New_York",
            json!("-04:00"),
            "provider_metadata",
        );
        assert_eq!(
            state(&row, &observed, &json!("America/New_York")).unwrap(),
            "complete_provider_daily_rows"
        );
        for zone_name in ["UTC", "Etc/UTC", "UTC+08:00", "UTC-05:00"] {
            let row = clock_row(
                "2025-11-01T00:00:00",
                zone_name,
                Value::Null,
                "provider_metadata",
            );
            assert_eq!(
                state(&row, &observed, &json!(zone_name)).unwrap(),
                "complete_provider_daily_rows"
            );
        }
        for zone_name in [
            "america/new_york",
            "US/Eastern",
            "Europe/Warsaw",
            "UTC-00:00",
            "UTC+14:01",
        ] {
            let row = clock_row(
                "2025-11-01T00:00:00",
                zone_name,
                Value::Null,
                "provider_metadata",
            );
            assert_eq!(state(&row, &observed, &Value::Null).unwrap(), "unknown");
        }
        for timestamp in ["2025-11-02T01:30:00", "2025-03-09T02:30:00"] {
            assert!(stamp(&clock_row(
                timestamp,
                "America/New_York",
                Value::Null,
                "provider_metadata"
            ))
            .is_err());
        }
        for timestamp in ["2025-11-01T00:00:00.000000001Z", "2025-11-01T00:00:01Z"] {
            assert_eq!(
                state(
                    &clock_row(timestamp, "UTC", json!("+00:00"), "timestamp"),
                    &observed,
                    &json!("UTC")
                )
                .unwrap(),
                "provisional"
            );
        }
        assert!(stamp(&clock_row(
            "2025-11-01T00:00:00-04:00",
            "America/New_York",
            json!("+00:00"),
            "timestamp"
        ))
        .is_err());
        assert!(stamp(&clock_row(
            "2025-11-01T00:00:00-05:00",
            "America/New_York",
            json!("-05:00"),
            "timestamp"
        ))
        .is_err());
        assert!(stamp(&clock_row(
            "2025-11-01T00:00:00-00:00",
            "UTC",
            json!("+00:00"),
            "timestamp"
        ))
        .is_err());
    }
    #[test]
    fn saved_optional_history_window_and_price_basis_bind_when_present() {
        let (mut quality, source, mut rows) = fixture();
        quality["requested_window"]["start"] = "2021-01-09".into();
        for row in &mut rows {
            row.insert("PriceBasis".into(), quality["price_basis"]["value"].clone());
            row.insert(
                "HistoryRequestStart".into(),
                quality["requested_window"]["start"].clone(),
            );
            row.insert("HistoryRequestEnd".into(), "2026-01-10".into());
        }
        proof(&quality, &source, &rows).unwrap();
        for (field, value) in [
            ("PriceBasis", json!("unadjusted")),
            ("HistoryRequestStart", json!("2020-01-01")),
            ("HistoryRequestEnd", json!("2026-01-09")),
        ] {
            let mut changed = rows.clone();
            changed[0][field] = value;
            assert!(proof(&quality, &source, &changed).is_err(), "{field}");
        }
    }
    #[test]
    fn every_enriched_table_must_support_quality_and_intermediate_tables_are_insufficient() {
        let mut evidence = test_support::evidence();
        let (quality, _, _) = fixture();
        validate(&quality, &evidence["records"][0], &evidence).unwrap();
        let source = evidence["records"][0]["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["provider"] == "yfinance")
            .unwrap()
            .clone();
        let old = source["data_sha256"].as_str().unwrap();
        let mut payload =
            memory::parse_json(evidence["artifacts"][old]["payload"].as_str().unwrap()).unwrap();
        payload["rows"][0][0] = "2026-01-10".into();
        let artifact =
            json!({"kind":"normalized_data","payload":memory::canonical_json(&payload).unwrap()});
        let digest = crate::evidence::canonical_hash(&artifact).unwrap();
        evidence["artifacts"]
            .as_object_mut()
            .unwrap()
            .insert(digest.clone(), artifact);
        let mut other = source.clone();
        other["data_sha256"] = digest.into();
        evidence["records"][0]["sources"]
            .as_array_mut()
            .unwrap()
            .push(other);
        assert!(validate(&quality, &evidence["records"][0], &evidence).is_err());
        let mut evidence = test_support::evidence();
        let artifact = json!({"kind":"normalized_data","payload":"{\"columns\":[\"Date\",\"Close\"],\"rows\":[[\"2026-01-08\",1.0]]}"});
        let digest = crate::evidence::canonical_hash(&artifact).unwrap();
        evidence["artifacts"]
            .as_object_mut()
            .unwrap()
            .insert(digest.clone(), artifact);
        for source in evidence["records"][0]["sources"].as_array_mut().unwrap() {
            if source["provider"] == "yfinance" {
                source["data_sha256"] = digest.clone().into();
            }
        }
        assert!(validate(&quality, &evidence["records"][0], &evidence).is_err());
    }
}
