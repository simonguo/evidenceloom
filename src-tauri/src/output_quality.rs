use serde_json::{json, Map, Value};

const SCHEMAS: [(&str, &str); 4] = [
    ("research_manager", "ResearchPlan"),
    ("trader", "TraderProposal"),
    ("portfolio_manager", "PortfolioDecision"),
    ("sentiment", "SentimentReport"),
];
const REASONS: [&str; 4] = [
    "structured_unavailable",
    "no_tool_call",
    "schema_validation_failed",
    "unsupported_format",
];

pub(crate) fn normalize_output_quality(value: &Value) -> Option<Value> {
    let input = value.as_object()?;
    let mut safe = Map::new();
    for (agent, schema) in SCHEMAS {
        let Some(record) = input.get(agent).and_then(Value::as_object) else {
            continue;
        };
        if record.get("schema").and_then(Value::as_str) != Some(schema) {
            continue;
        }
        let status = record.get("status").and_then(Value::as_str);
        let source = record.get("source").and_then(Value::as_str);
        let normalized = match (status, source) {
            (Some("validated_schema"), Some("structured")) if !record.contains_key("reason") => {
                json!({"status": "validated_schema", "schema": schema, "source": "structured"})
            }
            (Some("unvalidated_text"), Some(source @ ("raw_response" | "plain_generation"))) => {
                let Some(reason) = record.get("reason").and_then(Value::as_str) else {
                    continue;
                };
                if !REASONS.contains(&reason) {
                    continue;
                }
                json!({"status": "unvalidated_text", "schema": schema, "source": source, "reason": reason})
            }
            _ => continue,
        };
        safe.insert(agent.to_string(), normalized);
    }
    (!safe.is_empty()).then_some(Value::Object(safe))
}

pub(crate) fn normalize_report_version_quality(mut snapshot: Value) -> Value {
    if let Some(fields) = snapshot.as_object_mut() {
        let safe = fields
            .get("outputQuality")
            .and_then(normalize_output_quality);
        if let Some(safe) = safe {
            fields.insert("outputQuality".to_string(), safe);
        } else {
            fields.remove("outputQuality");
        }
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_quality_records_cross_the_boundary() {
        let input = json!({
            "research_manager": {"status": "validated_schema", "schema": "ResearchPlan", "source": "structured", "error": "secret-body"},
            "trader": {"status": "unvalidated_text", "schema": "TraderProposal", "source": "plain_generation", "reason": "structured_unavailable", "endpoint": "https://private.invalid"},
            "unknown_agent": {"status": "validated_schema", "schema": "Unknown", "source": "structured"}
        });
        assert_eq!(
            normalize_output_quality(&input),
            Some(json!({
                "research_manager": {"status": "validated_schema", "schema": "ResearchPlan", "source": "structured"},
                "trader": {"status": "unvalidated_text", "schema": "TraderProposal", "source": "plain_generation", "reason": "structured_unavailable"}
            }))
        );
    }

    #[test]
    fn contradictory_combinations_and_raw_error_reasons_are_rejected() {
        for invalid in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"research_manager": {"status": "validated_schema", "schema": "TraderProposal", "source": "structured"}}),
            json!({"research_manager": {"status": "validated_schema", "schema": "ResearchPlan", "source": "raw_response"}}),
            json!({"research_manager": {"status": "validated_schema", "schema": "ResearchPlan", "source": "structured", "reason": "no_tool_call"}}),
            json!({"research_manager": {"status": "validated_schema", "schema": "ResearchPlan", "source": "structured", "reason": null}}),
            json!({"trader": {"status": "unvalidated_text", "schema": "TraderProposal", "source": "structured", "reason": "no_tool_call"}}),
            json!({"trader": {"status": "unvalidated_text", "schema": "TraderProposal", "source": "raw_response", "reason": "HTTP 401 secret-key"}}),
            json!({"trader": {"status": "unvalidated_text", "schema": "TraderProposal", "source": "plain_generation"}}),
        ] {
            assert_eq!(normalize_output_quality(&invalid), None);
        }
    }

    #[test]
    fn snapshot_sanitization_preserves_every_unrelated_field_and_legacy_absence() {
        let legacy = json!({"id": "old", "decision": "Hold", "custom": {"key": "value"}});
        assert_eq!(normalize_report_version_quality(legacy.clone()), legacy);
        let mut invalid = legacy.clone();
        invalid["outputQuality"] = json!({"trader": {"error": "private"}});
        assert_eq!(normalize_report_version_quality(invalid), legacy);
    }
}
