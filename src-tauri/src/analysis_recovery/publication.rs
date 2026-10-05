use super::{parser, wire::*};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::OnceLock};

pub const REQUESTED_SETTINGS: &[&str] = &[
    "llmProvider",
    "quickThinkLlm",
    "deepThinkLlm",
    "temperature",
    "openaiReasoningEffort",
    "googleThinkingLevel",
    "anthropicEffort",
    "coreStockApis",
    "technicalIndicators",
    "fundamentalData",
    "newsData",
    "newsArticleLimit",
    "globalNewsArticleLimit",
    "globalNewsLookbackDays",
    "maxDebateRounds",
    "maxRiskRounds",
    "analystConcurrencyLimit",
    "benchmarkTicker",
    "checkpointEnabled",
    "systemLanguage",
];
pub const INPUT_KEYS: &[&str] = &[
    "ticker",
    "analysisDate",
    "assetType",
    "researchDepth",
    "analysts",
    "outputLanguage",
];
const SNAPSHOT_KEYS: &[&str] = &[
    "ticker",
    "instrumentName",
    "analysisDate",
    "assetType",
    "researchDepth",
    "analysts",
    "outputLanguage",
];
const RUNTIME_KEYS: &[&str] = &[
    "version",
    "core_version",
    "upstream_revision",
    "trade_date",
    "asset_type",
    "llm_provider",
    "quick_think_llm",
    "deep_think_llm",
    "analysts",
    "output_language",
    "holding_period_days",
    "benchmark_ticker",
    "max_debate_rounds",
    "max_risk_discuss_rounds",
    "max_tool_rounds",
    "research_readiness_policy_sha256",
    "analyst_concurrency_limit",
    "temperature",
    "max_tokens",
    "data_vendors",
    "tool_vendors",
];
const EVENT_KEYS: &[&str] = &[
    "type",
    "timestamp",
    "message",
    "messageType",
    "agentStatuses",
    "reportSections",
    "stats",
    "decision",
    "runSettings",
    "outputQuality",
    "evidenceBundle",
    "memoryBundle",
    "error",
    "researchReadiness",
    "reportTextSnapshot",
    "effectiveRequestIdentity",
    "agent",
    "finalState",
];
const FINAL_KEYS: &[&str] = &[
    "final_rating",
    "output_quality",
    "evidence_bundle",
    "memory_bundle",
    "research_readiness",
    "report_text_snapshot",
    "effective_request_identity",
];
const TYPES: &[&str] = &[
    "started",
    "progress",
    "message",
    "report",
    "stats",
    "completed",
    "error",
];
const CHANNELS: &[&str] = &[
    "event",
    "timestamp",
    "message",
    "messageType",
    "agentStatuses",
    "reportSections",
    "stats",
    "decision",
    "runSettings",
    "outputQuality",
    "evidenceBundle",
    "memoryBundle",
    "error",
    "researchReadiness",
    "reportTextSnapshot",
    "effectiveRequestIdentity",
    "agent",
    "finalState.final_rating",
    "finalState.output_quality",
    "finalState.evidence_bundle",
    "finalState.memory_bundle",
    "finalState.research_readiness",
    "finalState.report_text_snapshot",
    "finalState.effective_request_identity",
];
pub const CREDENTIAL_ENV: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_CN_API_KEY",
    "ZHIPU_API_KEY",
    "ZHIPU_CN_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "OPENROUTER_API_KEY",
    "ALPHA_VANTAGE_API_KEY",
];

#[derive(Clone, Default)]
pub struct SecretInventory {
    values: Vec<String>,
}
impl SecretInventory {
    pub fn new(values: Vec<String>) -> Self {
        Self {
            values: values.into_iter().filter(|v| !v.is_empty()).collect(),
        }
    }
    /// Injection boundary: production supplies credential/environment closures;
    /// tests supply fictional values and never touch user credentials.
    pub fn acquire(
        mut stored: impl FnMut(&str) -> Result<Option<String>, RecoveryError>,
        mut inherited: impl FnMut(&str) -> Result<Option<String>, RecoveryError>,
    ) -> Result<Self, RecoveryError> {
        let mut values = Vec::new();
        for id in ["provider", "alpha"] {
            if let Some(v) = stored(id)? {
                values.push(v);
            }
        }
        for name in CREDENTIAL_ENV {
            if let Some(v) = inherited(name)? {
                values.push(v);
            }
        }
        Ok(Self::new(values))
    }
    pub fn values(&self) -> &[String] {
        &self.values
    }
}

type SafeResult = Result<(), &'static str>;
fn text(v: &Value, max: usize, inventory: &SecretInventory) -> SafeResult {
    let s = v.as_str().ok_or("malformed")?;
    if s.len() > max {
        return Err("limit_exceeded");
    }
    if inventory.values.iter().any(|secret| s.contains(secret)) {
        return Err("unsafe_content");
    }
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let patterns=PATTERNS.get_or_init(||[
        r"(?i)\b(?:sk|hy|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}",
        r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+",
        r#"(?i)\b(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\b["']?\s*[=:]\s*["']?[^\s,;"'}]+"#,
        r#"(?:/(?:Users|home|tmp|private|var/folders)/[^\s<>"']+|[A-Za-z]:\\[^\s<>"']+)"#,
    ].iter().map(|p|regex::Regex::new(p).expect("fixed publication pattern")).collect());
    if patterns.iter().any(|p| p.is_match(s)) {
        return Err("unsafe_content");
    }
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    for m in URL
        .get_or_init(|| {
            regex::Regex::new(r#"(?i)https?://[^\s<>"\)\]\}]+"#).expect("fixed publication URL")
        })
        .find_iter(s)
    {
        let u = tauri::Url::parse(m.as_str()).map_err(|_| "unsafe_content")?;
        if !u.username().is_empty()
            || u.password().is_some()
            || u.query().is_some()
            || u.fragment().is_some()
        {
            return Err("unsafe_content");
        }
    }
    Ok(())
}
fn safe_tree(v: &Value, inventory: &SecretInventory, depth: usize) -> SafeResult {
    if depth > MAX_DEPTH {
        return Err("limit_exceeded");
    }
    match v {
        Value::String(_) => text(v, TEXT_BYTES, inventory),
        Value::Number(n) => {
            if n.as_f64()
                .is_some_and(|n| n.is_finite() && n.abs() <= MAX_SAFE_NUMBER as f64)
            {
                Ok(())
            } else {
                Err("malformed")
            }
        }
        Value::Array(a) => a
            .iter()
            .try_for_each(|v| safe_tree(v, inventory, depth + 1)),
        Value::Object(o) => {
            for (k, v) in o {
                if [
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
                .contains(&k.to_lowercase().as_str())
                {
                    return Err("unsafe_content");
                }
                text(&Value::String(k.clone()), SCALAR_BYTES, inventory)?;
                safe_tree(v, inventory, depth + 1)?;
            }
            if o.get("kind").and_then(Value::as_str) == Some("canonical_json") {
                let raw = o
                    .get("payload")
                    .and_then(Value::as_str)
                    .ok_or("malformed")?;
                let parsed = parser::raw_json(raw, crate::research_memory::MAX_BYTES)
                    .map_err(|_| "malformed")?;
                safe_tree(&parsed, inventory, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn shape(v: &Value, allowed: &[&str]) -> SafeResult {
    let o = v.as_object().ok_or("malformed")?;
    if o.keys().all(|k| allowed.contains(&k.as_str())) {
        Ok(())
    } else {
        Err("malformed")
    }
}
fn integer(v: &Value, min: u64) -> SafeResult {
    if v.as_u64().is_some_and(|n| n >= min && n <= MAX_SAFE_NUMBER) {
        Ok(())
    } else {
        Err("malformed")
    }
}
fn analysts(v: &Value) -> SafeResult {
    let a = v.as_array().ok_or("malformed")?;
    let mut seen = std::collections::BTreeSet::new();
    if a.is_empty() || a.len() > 4 {
        return Err("malformed");
    }
    for k in a {
        let k = k.as_str().ok_or("malformed")?;
        if !["market", "social", "news", "fundamentals"].contains(&k) || !seen.insert(k) {
            return Err("malformed");
        }
    }
    Ok(())
}
fn input(v: &Value, inventory: &SecretInventory, snapshot: bool) -> SafeResult {
    parser::exact(v, if snapshot { SNAPSHOT_KEYS } else { INPUT_KEYS }).map_err(|_| "malformed")?;
    for k in ["ticker", "analysisDate", "outputLanguage"] {
        text(&v[k], SCALAR_BYTES, inventory)?;
    }
    if snapshot {
        text(&v["instrumentName"], SCALAR_BYTES, inventory)?;
    }
    if ![Some("stock"), Some("crypto")].contains(&v["assetType"].as_str()) {
        return Err("malformed");
    }
    integer(&v["researchDepth"], 1)?;
    analysts(&v["analysts"])
}
fn runtime_settings(v: &Value, inventory: &SecretInventory) -> SafeResult {
    shape(v, RUNTIME_KEYS)?;
    safe_tree(v, inventory, 0)?;
    for (k, value) in v.as_object().ok_or("malformed")? {
        match k.as_str() {
            "data_vendors" | "tool_vendors" => {
                let map = value.as_object().ok_or("malformed")?;
                for (k, v) in map {
                    text(&Value::String(k.clone()), SCALAR_BYTES, inventory)?;
                    text(v, SCALAR_BYTES, inventory)?;
                }
            }
            "analysts" => {
                let a = value.as_array().ok_or("malformed")?;
                for v in a {
                    text(v, SCALAR_BYTES, inventory)?;
                }
            }
            "temperature" => {
                if !(value.is_null() || value.is_string() || value.is_number()) {
                    return Err("malformed");
                }
            }
            "holding_period_days"
            | "max_debate_rounds"
            | "max_risk_discuss_rounds"
            | "max_tool_rounds"
            | "analyst_concurrency_limit"
            | "max_tokens" => integer(value, 0)?,
            _ => text(value, SCALAR_BYTES, inventory)?,
        }
    }
    Ok(())
}
fn manifest(v: &Value, inventory: &SecretInventory) -> SafeResult {
    const REQUIRED: &[&str] = &[
        "appVersion",
        "llmProvider",
        "quickThinkLlm",
        "deepThinkLlm",
        "coreStockApis",
        "technicalIndicators",
        "fundamentalData",
        "newsData",
        "maxDebateRounds",
        "maxRiskRounds",
        "benchmarkTicker",
    ];
    let mut allowed = REQUIRED.to_vec();
    allowed.extend([
        "coreVersion",
        "toolVendors",
        "runtimeRunSettings",
        "holdingPeriodDays",
    ]);
    shape(v, &allowed)?;
    let map = v.as_object().ok_or("malformed")?;
    if !REQUIRED.iter().all(|k| map.contains_key(*k)) {
        return Err("malformed");
    }
    for (k, value) in map {
        match k.as_str() {
            "toolVendors" => {
                let m = value.as_object().ok_or("malformed")?;
                for (k, v) in m {
                    text(&Value::String(k.clone()), SCALAR_BYTES, inventory)?;
                    text(v, SCALAR_BYTES, inventory)?;
                }
            }
            "runtimeRunSettings" => runtime_settings(value, inventory)?,
            "maxDebateRounds" | "maxRiskRounds" | "holdingPeriodDays" => integer(value, 0)?,
            _ => text(value, SCALAR_BYTES, inventory)?,
        }
    }
    Ok(())
}
pub fn validate_context_shape(context: &Value) -> Result<(), RecoveryError> {
    validate_context(context, &SecretInventory::default())
}
pub fn validate_context(context: &Value, inventory: &SecretInventory) -> Result<(), RecoveryError> {
    let result = (|| {
        parser::exact(
            context,
            &[
                "originalTaskSnapshot",
                "input",
                "requestedSettings",
                "originalRunContext",
            ],
        )
        .map_err(|_| "malformed")?;
        if serde_json::to_vec(context).map_err(|_| "malformed")?.len() > CONTEXT_BYTES {
            return Err("limit_exceeded");
        }
        input(&context["originalTaskSnapshot"], inventory, true)?;
        input(&context["input"], inventory, false)?;
        let settings = &context["requestedSettings"];
        parser::exact(settings, REQUESTED_SETTINGS).map_err(|_| "malformed")?;
        for k in REQUESTED_SETTINGS {
            match *k {
                "maxDebateRounds" | "maxRiskRounds" => integer(&settings[k], 0)?,
                "newsArticleLimit"
                | "globalNewsArticleLimit"
                | "globalNewsLookbackDays"
                | "analystConcurrencyLimit" => integer(&settings[k], 1)?,
                "checkpointEnabled" => {
                    if !settings[k].is_boolean() {
                        return Err("malformed");
                    }
                }
                "systemLanguage" => {
                    if ![Some("zh"), Some("en")].contains(&settings[k].as_str()) {
                        return Err("malformed");
                    }
                }
                _ => text(&settings[k], SCALAR_BYTES, inventory)?,
            }
        }
        let original = &context["originalRunContext"];
        parser::exact(original, &["runId", "manifest"]).map_err(|_| "malformed")?;
        text(&original["runId"], SCALAR_BYTES, inventory)?;
        if original["runId"].as_str().is_none_or(str::is_empty) {
            return Err("malformed");
        }
        manifest(&original["manifest"], inventory)
    })();
    result.map_err(|reason| {
        RecoveryError::fixed(if reason == "limit_exceeded" {
            "analysis_limit_exceeded"
        } else if reason == "unsafe_content" {
            "analysis_publication_unavailable"
        } else {
            "analysis_invalid_request"
        })
    })
}
pub fn input_matches_context(value: &Value, context: &Value) -> Result<(), RecoveryError> {
    parser::ensure(
        INPUT_KEYS
            .iter()
            .all(|k| value.get(*k) == context["input"].get(*k))
            && REQUESTED_SETTINGS
                .iter()
                .all(|k| value.get(*k) == context["requestedSettings"].get(*k)),
    )
}

fn report(v: &Value, inventory: &SecretInventory) -> SafeResult {
    let o = v.as_object().ok_or("malformed")?;
    for (k, v) in o {
        text(&Value::String(k.clone()), SCALAR_BYTES, inventory)?;
        if !v.is_null() {
            text(v, TEXT_BYTES, inventory)?;
        }
    }
    Ok(())
}
fn stats(v: &Value) -> SafeResult {
    parser::exact(
        v,
        &[
            "llmCalls",
            "toolCalls",
            "tokensIn",
            "tokensOut",
            "elapsedSeconds",
        ],
    )
    .map_err(|_| "malformed")?;
    if v.as_object().ok_or("malformed")?.values().all(|v| {
        v.as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= MAX_SAFE_NUMBER as f64)
    }) {
        Ok(())
    } else {
        Err("malformed")
    }
}
fn output_quality(v: &Value, inventory: &SecretInventory) -> SafeResult {
    shape(
        v,
        &[
            "research_manager",
            "trader",
            "portfolio_manager",
            "sentiment",
        ],
    )?;
    safe_tree(v, inventory, 0)?;
    for value in v.as_object().ok_or("malformed")?.values() {
        shape(value, &["status", "schema", "source", "reason"])?;
        text(&value["schema"], SCALAR_BYTES, inventory)?;
        match value["status"].as_str() {
            Some("validated_schema") => {
                if value["source"] != "structured" || value.get("reason").is_some() {
                    return Err("malformed");
                }
            }
            Some("unvalidated_text") => {
                if ![Some("raw_response"), Some("plain_generation")]
                    .contains(&value["source"].as_str())
                    || ![
                        Some("structured_unavailable"),
                        Some("no_tool_call"),
                        Some("schema_validation_failed"),
                        Some("unsupported_format"),
                    ]
                    .contains(&value["reason"].as_str())
                {
                    return Err("malformed");
                }
            }
            _ => return Err("malformed"),
        }
    }
    Ok(())
}
fn domain(v: &Value, inventory: &SecretInventory) -> SafeResult {
    if serde_json::to_vec(v).map_err(|_| "malformed")?.len() > crate::research_memory::MAX_BYTES {
        return Err("limit_exceeded");
    }
    safe_tree(v, inventory, 0)?;
    known_domain_tree(v, false)
}
fn known_domain_tree(v: &Value, dynamic: bool) -> SafeResult {
    match v {
        Value::Object(o) => {
            if !dynamic && o.keys().any(|k| !DOMAIN_KEYS.contains(&k.as_str())) {
                return Err("malformed");
            }
            for (k, v) in o {
                let map = [
                    "parameters",
                    "manifest",
                    "artifacts",
                    "citation_audit",
                    "effective_history_parameters",
                    "report_sections",
                ]
                .contains(&k.as_str());
                // These are explicit map-valued fields in frozen domain DTOs.
                if map {
                    if let Some(o) = v.as_object() {
                        for value in o.values() {
                            known_domain_tree(value, k == "parameters" || k == "manifest")?;
                        }
                    } else {
                        return Err("malformed");
                    }
                } else {
                    known_domain_tree(v, dynamic)?;
                }
            }
            Ok(())
        }
        Value::Array(a) => a.iter().try_for_each(|v| known_domain_tree(v, dynamic)),
        _ => Ok(()),
    }
}
fn field(key: &str, v: &Value, inventory: &SecretInventory) -> SafeResult {
    match key {
        "timestamp" => text(v, 256, inventory),
        "message" | "decision" | "final_rating" => text(v, TEXT_BYTES, inventory),
        "error" => {
            if v.as_str()
                .is_some_and(|s| s == RecoveryError::fixed("analysis_worker_failed").message)
            {
                Ok(())
            } else {
                Err("verification_unavailable")
            }
        }
        "messageType" | "agent" => text(v, SCALAR_BYTES, inventory),
        "agentStatuses" => {
            let o = v.as_object().ok_or("malformed")?;
            for (k, v) in o {
                text(&Value::String(k.clone()), SCALAR_BYTES, inventory)?;
                if ![
                    Some("pending"),
                    Some("in_progress"),
                    Some("completed"),
                    Some("error"),
                ]
                .contains(&v.as_str())
                {
                    return Err("malformed");
                }
            }
            Ok(())
        }
        "reportSections" => report(v, inventory),
        "stats" => stats(v),
        "runSettings" => runtime_settings(v, inventory),
        "outputQuality" | "output_quality" => output_quality(v, inventory),
        "evidenceBundle"
        | "memoryBundle"
        | "researchReadiness"
        | "reportTextSnapshot"
        | "effectiveRequestIdentity"
        | "evidence_bundle"
        | "memory_bundle"
        | "research_readiness"
        | "report_text_snapshot"
        | "effective_request_identity" => domain(v, inventory),
        _ => Err("malformed"),
    }
}
fn validate_event(v: &Value, inventory: &SecretInventory) -> SafeResult {
    shape(v, EVENT_KEYS)?;
    if !v
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|s| TYPES.contains(&s))
    {
        return Err("malformed");
    }
    for (k, v) in v.as_object().ok_or("malformed")? {
        if k == "type" {
            continue;
        }
        if k == "finalState" {
            shape(v, FINAL_KEYS)?;
            for (k, v) in v.as_object().ok_or("malformed")? {
                field(k, v, inventory)?;
            }
        } else {
            field(k, v, inventory)?;
        }
    }
    Ok(())
}
pub fn is_critical(channel: &str) -> bool {
    [
        "event",
        "reportSections",
        "decision",
        "stats",
        "finalState.final_rating",
    ]
    .contains(&channel)
}

pub struct PreparedPublication {
    pub kind: String,
    pub payload: Value,
    pub critical: bool,
}
pub fn prepare_event(raw: &Value, inventory: &SecretInventory) -> PreparedPublication {
    let typ = raw
        .get("type")
        .and_then(Value::as_str)
        .filter(|s| TYPES.contains(s));
    let Some(typ) = typ else {
        return unavailable(None, "event", "malformed");
    };
    let mut safe = serde_json::Map::new();
    safe.insert("type".into(), typ.into());
    let mut issues = BTreeMap::new();
    if let Some(o) = raw.as_object() {
        for (k, v) in o {
            if !EVENT_KEYS.contains(&k.as_str()) || k == "type" {
                continue;
            }
            if k == "finalState" {
                let mut state = serde_json::Map::new();
                if let Some(o) = v.as_object() {
                    for (k, v) in o {
                        if FINAL_KEYS.contains(&k.as_str()) {
                            match field(k, v, inventory) {
                                Ok(()) => {
                                    state.insert(k.clone(), v.clone());
                                }
                                Err(reason) => {
                                    issues.insert(format!("finalState.{k}"), reason);
                                }
                            }
                        }
                    }
                } else {
                    issues.insert("event".into(), "malformed");
                }
                if !state.is_empty() {
                    safe.insert("finalState".into(), Value::Object(state));
                }
            } else {
                match field(k, v, inventory) {
                    Ok(()) => {
                        safe.insert(k.clone(), v.clone());
                    }
                    Err(reason) => {
                        issues.insert(k.clone(), reason);
                        if k == "error" {
                            safe.insert(
                                k.clone(),
                                RecoveryError::fixed("analysis_worker_failed")
                                    .message
                                    .into(),
                            );
                        }
                    }
                }
            }
        }
    }
    if issues.is_empty() {
        PreparedPublication {
            kind: "analysis".into(),
            payload: json!({"event":safe}),
            critical: false,
        }
    } else {
        let critical = issues.keys().any(|k| is_critical(k));
        PreparedPublication {
            kind: "publication_unavailable".into(),
            payload: json!({"sourceType":typ,"channels":issues.iter().map(|(channel,reason)|json!({"channel":channel,"reason":reason})).collect::<Vec<_>>(),"outcome":if critical{"analysis_failed"}else{"optional_unavailable"},"code":"analysis_publication_unavailable","safeAnalysis":safe}),
            critical,
        }
    }
}
pub fn unavailable(source_type: Option<&str>, channel: &str, reason: &str) -> PreparedPublication {
    PreparedPublication {
        kind: "publication_unavailable".into(),
        payload: json!({"sourceType":source_type,"channels":[{"channel":channel,"reason":reason}],"outcome":"analysis_failed","code":"analysis_publication_unavailable","safeAnalysis":null}),
        critical: true,
    }
}
pub fn validate_payload(kind: &str, payload: &Value) -> Result<(), RecoveryError> {
    let inventory = SecretInventory::default();
    match kind {
        "accepted" => {
            parser::exact(payload, &["resetVersion"])?;
            parser::ensure(payload["resetVersion"] == 1)
        }
        "analysis" => {
            parser::exact(payload, &["event"])?;
            validate_event(&payload["event"], &inventory).map_err(|_| RecoveryError::invalid())
        }
        "publication_unavailable" => {
            parser::exact(
                payload,
                &["sourceType", "channels", "outcome", "code", "safeAnalysis"],
            )?;
            let p: UnavailablePayload =
                serde_json::from_value(payload.clone()).map_err(|_| RecoveryError::invalid())?;
            parser::ensure(
                p.code == "analysis_publication_unavailable"
                    && !p.channels.is_empty()
                    && p.source_type
                        .as_ref()
                        .is_none_or(|s| TYPES.contains(&s.as_str())),
            )?;
            let mut previous: Option<&str> = None;
            for issue in &p.channels {
                parser::ensure(
                    CHANNELS.contains(&issue.channel.as_str())
                        && [
                            "unsafe_content",
                            "verification_unavailable",
                            "malformed",
                            "limit_exceeded",
                        ]
                        .contains(&issue.reason.as_str())
                        && previous.is_none_or(|prev| prev < issue.channel.as_str()),
                )?;
                previous = Some(&issue.channel);
            }
            let critical = p.channels.iter().any(|i| is_critical(&i.channel));
            parser::ensure(
                p.outcome
                    == if critical {
                        "analysis_failed"
                    } else {
                        "optional_unavailable"
                    },
            )?;
            if let Some(event) = p.safe_analysis {
                validate_event(&event, &inventory).map_err(|_| RecoveryError::invalid())?;
                parser::ensure(event["type"].as_str() == p.source_type.as_deref())?;
            } else {
                parser::ensure(critical)?;
            }
            Ok(())
        }
        "reader_outcome" => {
            parser::exact(payload, &["stream", "outcome", "code"])?;
            let p: ReaderOutcomePayload =
                serde_json::from_value(payload.clone()).map_err(|_| RecoveryError::invalid())?;
            parser::ensure(
                ["stdout", "stderr"].contains(&p.stream.as_str())
                    && match p.outcome.as_str() {
                        "eof" => p.code.is_none(),
                        "read_failed" | "panicked" => {
                            p.code.as_deref() == Some("analysis_reader_failed")
                        }
                        _ => false,
                    },
            )
        }
        "worker_outcome" => {
            parser::exact(payload, &["outcome", "code"])?;
            let p: WorkerOutcomePayload =
                serde_json::from_value(payload.clone()).map_err(|_| RecoveryError::invalid())?;
            parser::ensure(match (p.outcome.as_str(), p.code.as_deref()) {
                ("succeeded", None | Some("analysis_missing_terminal"))
                | ("cancelled", None)
                | (
                    "not_started",
                    None | Some("analysis_start_failed") | Some("analysis_reservation_expired"),
                )
                | ("failed", Some("analysis_worker_failed") | Some("analysis_start_failed")) => {
                    true
                }
                _ => false,
            })
        }
        _ => Err(RecoveryError::invalid()),
    }
}
pub fn has_completion_seed(kind: &str, p: &Value) -> bool {
    (kind == "analysis" && p["event"]["type"] == "completed")
        || (kind == "publication_unavailable"
            && p["outcome"] == "optional_unavailable"
            && p["safeAnalysis"]["type"] == "completed")
}
pub fn expected_log_timestamp(
    kind: &str,
    p: &Value,
    observed: &str,
) -> Result<String, RecoveryError> {
    if kind == "publication_unavailable"
        && (p["sourceType"].is_null()
            || p["channels"]
                .as_array()
                .is_some_and(|a| a.iter().any(|i| i["channel"] == "timestamp")))
    {
        return Ok("[unavailable]".into());
    }
    let event = if kind == "analysis" {
        p.get("event")
    } else if kind == "publication_unavailable" {
        p.get("safeAnalysis")
    } else {
        None
    };
    if let Some(timestamp) = event.and_then(|e| e.get("timestamp")) {
        return timestamp
            .as_str()
            .map(str::to_owned)
            .ok_or_else(RecoveryError::invalid);
    }
    Ok(observed.into())
}
pub fn ecmascript_blank(text: &str) -> bool {
    text.chars().all(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;

// Known field vocabulary of frozen domain DTOs; explicit map fields are handled above.
const DOMAIN_KEYS: &[&str] = &[
    "adapter_code_sha256",
    "adapter_id",
    "adjustments",
    "alignment_policy",
    "analysis_calendar_date",
    "analysis_date",
    "analyst",
    "artifact_sha256s",
    "artifacts",
    "as_of_policy",
    "assessment_sha256",
    "asset_type",
    "attachment_sha256",
    "attempts",
    "availability_cutoff",
    "binding_sha256",
    "bundle_sha256",
    "calculation_sha256",
    "canonical_alignment",
    "canonical_reason",
    "canonical_rule",
    "canonical_selector_key",
    "captured_at",
    "checks",
    "citation_audit",
    "completion_policy",
    "conflict_count",
    "consistent_count",
    "content_scope",
    "context_artifact",
    "context_bindings",
    "context_results",
    "context_sha256",
    "contract",
    "contract_sha256",
    "created_at",
    "cross_ticker_limit",
    "data_sha256",
    "data_sha256s",
    "decision",
    "decision_id",
    "decision_sha256",
    "decision_snapshot",
    "decision_text_sha256",
    "decisions",
    "effectiveRequestIdentity",
    "effective_history_parameters",
    "elapsed_ms",
    "end",
    "end_byte",
    "entry_policy",
    "evaluationReviews",
    "evaluation_mode",
    "evaluator_code_sha256",
    "evaluator_version",
    "evidence_bundle_sha256",
    "evidence_id",
    "evidence_ids",
    "evidence_inputs",
    "exit_policy",
    "facts_sha256",
    "fetched_at",
    "field",
    "historical_availability",
    "holding_period_days",
    "holding_period_unit",
    "host_utc_offset",
    "id",
    "identityValidation",
    "input_sha256",
    "input_snapshot",
    "instrument",
    "key",
    "kind",
    "manifest",
    "manifest_sha256",
    "market_timezone",
    "max_complete_row_age_days",
    "max_tool_rounds",
    "memoryBundle",
    "memoryValidation",
    "missing_ids",
    "mode",
    "model_context_sha256",
    "not_applicable_count",
    "not_evaluable_reason",
    "numeric_span",
    "observed_at",
    "observed_window",
    "operand",
    "outcome",
    "outcome_sha256",
    "output_sha256",
    "parameters",
    "payload",
    "persistence_status",
    "places",
    "policy",
    "policy_artifact_sha256",
    "policy_sha256",
    "policy_version",
    "previous_review_sha256",
    "price_basis",
    "prompt_sha256",
    "provider",
    "provider_entity",
    "provider_request",
    "proxy_count",
    "publication_dates",
    "rating",
    "raw_number_lexeme",
    "raw_text_sha256",
    "readinessValidation",
    "reason",
    "reason_codes",
    "recommendation_allowed",
    "record_alignment",
    "record_count",
    "record_id",
    "record_reason",
    "recorded_at",
    "records",
    "referenced_ids",
    "reflected_at",
    "reflection",
    "reflection_sha256",
    "relation",
    "report_sections",
    "report_snapshot_sha256",
    "request_namespace",
    "request_symbol",
    "requested_ids",
    "requested_symbol",
    "required",
    "required_checks",
    "required_indicators",
    "researchReadiness",
    "research_as_of",
    "research_calendar_date",
    "research_cutoff",
    "research_started_at",
    "resolved_benchmark",
    "resolver_code_sha256",
    "response_sha256",
    "result",
    "return_policy",
    "review_id",
    "review_sha256",
    "reviewed_at",
    "reviews",
    "role",
    "rounded_decimal",
    "rounding",
    "row_date",
    "run_id",
    "same_ticker_limit",
    "schema_version",
    "scope",
    "section_key",
    "section_utf8_sha256",
    "selected_analysts",
    "selected_at",
    "selector",
    "selector_version",
    "session_policy",
    "sha256",
    "snapshot",
    "snapshot_sha256",
    "source_context",
    "source_count",
    "source_index",
    "sources",
    "start",
    "start_byte",
    "status",
    "summary",
    "table_path",
    "target",
    "target_binding",
    "targets",
    "task_id",
    "temporal_mode",
    "text",
    "timestamp",
    "tool",
    "transformations",
    "type",
    "unexpected_selector_keys",
    "units",
    "unknown_count",
    "unresolved_ids",
    "unreviewed_dimensions",
    "unsafe_record_ids",
    "url",
    "venue",
    "version_id",
];
