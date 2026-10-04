use super::{decimal::Decimal, ensure, raw::Raw, spans, string, Result, ERROR};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::OnceLock;

pub(super) struct Derived {
    pub provider: Value,
    pub data_sha256: Value,
    pub raw_number_lexeme: Value,
    pub result: Value,
}

fn date_component(label: &str) -> Option<String> {
    static LABEL: OnceLock<regex::Regex> = OnceLock::new();
    let expression = LABEL.get_or_init(|| regex::Regex::new(r"\A([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?\z").expect("saved local ISO Date label"));
    if !expression.is_match(label) || crate::research_memory::day(&label[..10]).is_none() {
        return None;
    }
    if label.len() > 10 {
        for (start, maximum) in [(11, 23), (14, 59), (17, 59)] {
            if label[start..start + 2].parse::<u32>().ok()? > maximum {
                return None;
            }
        }
        if label.ends_with("-00:00") {
            return None;
        }
        if label.len() >= 25 && ['+', '-'].contains(&(label.as_bytes()[label.len() - 6] as char)) {
            let offset = &label[label.len() - 6..];
            let hour = offset[1..3].parse::<u32>().ok()?;
            let minute = offset[4..6].parse::<u32>().ok()?;
            if hour > 14 || minute > 59 || hour == 14 && minute != 0 {
                return None;
            }
        }
    }
    Some(label[..10].into())
}

type Cell = (Option<String>, Option<String>, Option<&'static str>);
fn cell(payload: &str, selector: &Value) -> Result<Cell> {
    let parsed = Raw::parse(payload)?;
    let mut table = &parsed;
    for key in selector["table_path"].as_array().ok_or(ERROR)? {
        let Some(next) = table.object().and_then(|table| table.get(key.as_str()?)) else {
            return Ok((None, None, Some("table_missing")));
        };
        table = next;
    }
    let Some(table) = table.object() else {
        return Ok((None, None, Some("table_missing")));
    };
    let Some(columns) = table.get("columns").and_then(Raw::array) else {
        return Ok((None, None, Some("table_missing")));
    };
    let Some(rows) = table.get("rows").and_then(Raw::array) else {
        return Ok((None, None, Some("table_missing")));
    };
    if columns.is_empty()
        || columns.len() > 256
        || rows.len() > 100_000
        || columns
            .iter()
            .any(|column| column.text().is_none_or(str::is_empty))
        || rows
            .iter()
            .any(|row| row.array().is_none_or(|row| row.len() != columns.len()))
    {
        return Ok((None, None, Some("table_missing")));
    }
    let columns: Vec<_> = columns
        .iter()
        .map(|column| column.text().expect("checked columns"))
        .collect();
    if columns.iter().copied().collect::<BTreeSet<_>>().len() != columns.len() {
        return Ok((None, None, Some("table_ambiguous")));
    }
    let Some(date_index) = columns.iter().position(|column| *column == "Date") else {
        return Ok((None, None, Some("table_missing")));
    };
    let rows: Vec<_> = rows
        .iter()
        .map(|row| row.array().expect("checked rows"))
        .collect();
    let labels: Option<Vec<_>> = rows.iter().map(|row| row[date_index].text()).collect();
    let Some(labels) = labels else {
        return Ok((None, None, Some("table_missing")));
    };
    if labels.iter().copied().collect::<BTreeSet<_>>().len() != labels.len() {
        return Ok((None, None, Some("row_ambiguous")));
    }
    let selected_date = string(&selector["row_date"])?;
    let Some(row_index) = labels.iter().position(|label| *label == selected_date) else {
        return Ok((None, None, Some("row_missing")));
    };
    if date_component(selected_date).is_none() {
        return Ok((None, None, Some("row_missing")));
    }
    let label = Some(selected_date.into());
    let Some(field_index) = columns.iter().position(|field| *field == selector["field"]) else {
        return Ok((None, label, Some("field_missing")));
    };
    let Raw::Number(number) = &rows[row_index][field_index] else {
        return Ok((None, label, Some("field_not_numeric")));
    };
    if Decimal::parse(number).is_none() {
        return Ok((None, label, Some("number_unsupported")));
    }
    Ok((Some(number.clone()), label, None))
}

pub(super) fn derive(review: &Value, snapshot: &Value, evidence: &Value) -> Result<Derived> {
    let operand = &review["operand"];
    let records = evidence["records"].as_array().ok_or(ERROR)?;
    let matches: Vec<_> = records
        .iter()
        .filter(|record| record["id"] == operand["evidence_id"])
        .collect();
    ensure(matches.len() == 1)?;
    let record = matches[0];
    ensure(record["instrument"] == snapshot["instrument"])?;
    let source_index = operand["source_index"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(ERROR)?;
    let source = record["sources"]
        .as_array()
        .and_then(|sources| sources.get(source_index))
        .ok_or(ERROR)?;
    ensure(operand["data_sha256"] == source["data_sha256"])?;
    let (lexeme, label, mut reason) =
        if source["historical_availability"] == "withheld" || record["status"] == "withheld" {
            (None, None, Some("source_withheld"))
        } else if !["available", "partial"]
            .iter()
            .any(|status| record["status"] == *status)
        {
            (None, None, Some("source_unavailable"))
        } else if source["data_sha256"].is_null() {
            (None, None, Some("table_missing"))
        } else {
            let artifact = &evidence["artifacts"][string(&source["data_sha256"])?];
            ensure(artifact["kind"] == "normalized_data")?;
            cell(string(&artifact["payload"])?, &operand["selector"])?
        };
    let section = string(&snapshot["report_sections"][string(&review["target"]["section_key"])?])?;
    let context = json!({"instrument":snapshot["instrument"],"row_date":label,"units":source["units"],"provider":source["provider"],"historical_availability":source["historical_availability"],"adjustments":source["adjustments"],"transformations":source["transformations"]});
    let expected = json!({"instrument":snapshot["instrument"],"row_date":label.as_deref().and_then(date_component),"units":source["units"]});
    let mut context_results = serde_json::Map::new();
    for key in super::CONTEXT_KEYS {
        let binding = &review["context_bindings"][key];
        let status = if binding.is_null() {
            "unreviewed"
        } else if expected[key].is_null() || !spans::supported_context(section, binding)? {
            "missing"
        } else if binding["text"] == expected[key] {
            "match"
        } else {
            "mismatch"
        };
        context_results.insert(key.into(), status.into());
    }
    let places = review["rounding"]["places"].as_u64().ok_or(ERROR)? as usize;
    let rounded = lexeme
        .as_deref()
        .and_then(Decimal::parse)
        .map(|number| number.rounded(places))
        .transpose()?;
    let supported = spans::supported(section, &review["numeric_span"])?;
    let selected = Decimal::parse(string(&review["numeric_span"]["text"])?);
    let comparable = supported && selected.is_some() && rounded.is_some();
    let statuses: Vec<_> = context_results.values().filter_map(Value::as_str).collect();
    let status = if statuses.contains(&"mismatch") {
        reason = Some("context_mismatch");
        "mismatch"
    } else if comparable
        && !selected
            .as_ref()
            .expect("comparable decimal")
            .equals_rounded(rounded.as_deref().expect("comparable rounded number"))
    {
        reason = Some("value_mismatch");
        "mismatch"
    } else if statuses.contains(&"missing") {
        reason = Some("context_missing");
        "missing"
    } else if reason.is_some_and(|reason| reason != "number_unsupported") {
        "missing"
    } else if !supported {
        reason = Some("selection_unsupported");
        "manual_inference"
    } else if !comparable {
        reason = Some("number_unsupported");
        "manual_inference"
    } else {
        reason = Some("value_match");
        "match"
    };
    let mut dimensions = super::policy()["unreviewed_dimensions"]
        .as_array()
        .ok_or(ERROR)?
        .clone();
    for key in super::CONTEXT_KEYS {
        if ["unreviewed", "missing"]
            .iter()
            .any(|state| context_results[key] == *state)
        {
            dimensions.push(key.into());
        }
    }
    Ok(Derived {
        provider: source["provider"].clone(),
        data_sha256: source["data_sha256"].clone(),
        raw_number_lexeme: lexeme.into(),
        result: json!({"status":status,"reason":reason,"rounded_decimal":rounded,"context_results":context_results,"unreviewed_dimensions":dimensions,"source_context":context}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_table_selection_missing_cells_dates_and_opaque_precision_are_distinct() {
        let selector = json!({"table_path":[],"row_date":"2026-01-08","field":"Close"});
        for (payload, expected) in [
            (r#"{}"#, "table_missing"),
            (
                r#"{"columns":["Date","Close"],"rows":[["2026-01-07",1]]}"#,
                "row_missing",
            ),
            (
                r#"{"columns":["Date","Open"],"rows":[["2026-01-08",1]]}"#,
                "field_missing",
            ),
            (
                r#"{"columns":["Date","Close"],"rows":[["2026-01-08",true]]}"#,
                "field_not_numeric",
            ),
            (
                r#"{"columns":["Date","Close"],"rows":[["2026-01-08","1.005"]]}"#,
                "field_not_numeric",
            ),
            (
                r#"{"columns":["Date","Close"],"rows":[["2026-01-08",1e1280]]}"#,
                "number_unsupported",
            ),
            (
                r#"{"columns":["Date","Close"],"rows":[["2026-01-08",1],["2026-01-07",2],["2026-01-07",3]]}"#,
                "row_ambiguous",
            ),
        ] {
            let (raw, _, reason) = cell(payload, &selector).unwrap();
            assert_eq!(reason, Some(expected));
            assert!(raw.is_none());
        }
        let (raw, label, reason) = cell(
            r#"{"columns":["Date","Close"],"rows":[["2026-01-08",123.45678901234567]]}"#,
            &selector,
        )
        .unwrap();
        assert_eq!(raw.as_deref(), Some("123.45678901234567"));
        assert_eq!(label.as_deref(), Some("2026-01-08"));
        assert!(reason.is_none());
        for date in [
            "2026-01-08T23:59:59.123456789+14:00",
            "2026-01-08 09:30:00.1Z",
        ] {
            assert_eq!(date_component(date).as_deref(), Some("2026-01-08"));
        }
        for date in [
            "2026-02-30",
            "2026-01-08T24:00:00Z",
            "2026-01-08T09:30:00-00:00",
            "2026-01-08T09:30:00+14:01",
        ] {
            assert!(date_component(date).is_none());
        }
    }
}
