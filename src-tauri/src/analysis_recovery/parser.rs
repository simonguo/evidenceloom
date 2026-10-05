use super::wire::*;
use serde::{
    de::{self, DeserializeOwned, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Deserializer,
};
use serde_json::{Map, Number, Value};
use std::fmt;

struct StrictSeed {
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for StrictSeed {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > MAX_DEPTH {
            return Err(de::Error::custom("recovery depth"));
        }
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for StrictSeed {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("strict recovery JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        if v.unsigned_abs() > MAX_SAFE_NUMBER {
            return Err(E::custom("recovery number"));
        }
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        if v > MAX_SAFE_NUMBER {
            return Err(E::custom("recovery number"));
        }
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        if !v.is_finite() || v.abs() > MAX_SAFE_NUMBER as f64 {
            return Err(E::custom("recovery number"));
        }
        Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("recovery number"))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(v) = a.next_element_seed(StrictSeed {
            depth: self.depth + 1,
        })? {
            values.push(v);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("recovery duplicate key"));
            }
            values.insert(
                key,
                a.next_value_seed(StrictSeed {
                    depth: self.depth + 1,
                })?,
            );
        }
        Ok(Value::Object(values))
    }
}

pub fn raw_json(raw: &str, limit: usize) -> Result<Value, RecoveryError> {
    if raw.len() > limit {
        return Err(RecoveryError::fixed("analysis_limit_exceeded"));
    }
    let mut d = serde_json::Deserializer::from_str(raw);
    let value = StrictSeed { depth: 0 }
        .deserialize(&mut d)
        .map_err(|_| RecoveryError::invalid())?;
    d.end().map_err(|_| RecoveryError::invalid())?;
    Ok(value)
}
pub fn exact(value: &Value, keys: &[&str]) -> Result<(), RecoveryError> {
    let obj = value.as_object().ok_or_else(RecoveryError::invalid)?;
    ensure(obj.len() == keys.len() && keys.iter().all(|k| obj.contains_key(*k)))
}
pub fn ensure(value: bool) -> Result<(), RecoveryError> {
    if value {
        Ok(())
    } else {
        Err(RecoveryError::invalid())
    }
}
pub fn counter(value: &str) -> Result<u64, RecoveryError> {
    ensure(
        !value.is_empty()
            && value.len() <= 19
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
    )?;
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= MAX_COUNTER)
        .ok_or_else(RecoveryError::invalid)
}
pub fn next_counter(value: &str) -> Result<String, RecoveryError> {
    counter(value)?
        .checked_add(1)
        .filter(|n| *n <= MAX_COUNTER)
        .map(|n| n.to_string())
        .ok_or_else(|| RecoveryError::fixed("analysis_counter_exhausted"))
}
pub fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
}
pub fn identity(value: &RunIdentity) -> Result<(), RecoveryError> {
    ensure(hex(&value.runtime_epoch) && !value.task_id.is_empty() && value.task_id.len() <= 1024)?;
    let id = value
        .run_id
        .strip_prefix("analysis-")
        .ok_or_else(RecoveryError::invalid)?;
    ensure(
        !id.is_empty()
            && id.bytes().all(|b| b.is_ascii_digit())
            && (id == "0" || !id.starts_with('0'))
            && id.parse::<u64>().is_ok(),
    )
}
pub fn collection(
    value: &crate::storage::task_mutation::CollectionToken,
) -> Result<(), RecoveryError> {
    ensure(!value.collection_id.is_empty() && value.collection_id.len() <= 128)?;
    counter(&value.epoch)?;
    Ok(())
}
pub fn binding(value: &RunBinding, origin: &RunIdentity) -> Result<(), RecoveryError> {
    identity(origin)?;
    collection(&value.collection)?;
    ensure(value.task_id == origin.task_id && counter(&value.generation)? > 0)
}
pub fn head(
    value: &crate::storage::task_mutation::TaskHead,
    live: bool,
) -> Result<(), RecoveryError> {
    ensure(!value.task_id.is_empty() && value.task_id.len() <= 1024)?;
    let g = counter(&value.generation)?;
    let r = counter(&value.revision)?;
    ensure(if live {
        value.state == "live" && g > 0 && r > 0
    } else {
        ["live", "tombstone", "never_seen"].contains(&value.state.as_str())
            && ((value.state == "never_seen" && g == 0 && r == 0)
                || (value.state != "never_seen" && g > 0 && r > 0))
    })
}
pub fn utc(value: &str) -> Result<(), RecoveryError> {
    ensure(value.len() == 24 && value.ends_with('Z'))?;
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| RecoveryError::invalid())?;
    ensure(
        value.as_bytes().get(19) == Some(&b'.')
            && value.as_bytes()[20..23].iter().all(u8::is_ascii_digit),
    )
}
pub fn digest(value: &Value) -> Result<String, RecoveryError> {
    crate::research_memory::hash_value(value).map_err(|_| RecoveryError::invalid())
}

pub trait Request: DeserializeOwned {
    const LIMIT: usize;
    fn validate(&self, original: &Value) -> Result<(), RecoveryError>;
}
pub fn parse<T: Request>(raw: &str) -> Result<ParsedRecoveryRequest<T>, RecoveryError> {
    let original = raw_json(raw, T::LIMIT)?;
    let request: T =
        serde_json::from_value(original.clone()).map_err(|_| RecoveryError::invalid())?;
    request.validate(&original)?;
    let digest = digest(&original)?;
    Ok(ParsedRecoveryRequest {
        original,
        digest,
        request,
    })
}
fn common(version: u8, id: &str) -> Result<(), RecoveryError> {
    ensure(version == PROTOCOL_VERSION && request_id(id))
}
impl Request for ProtocolRequest {
    const LIMIT: usize = CONTROL_BYTES;
    fn validate(&self, v: &Value) -> Result<(), RecoveryError> {
        exact(v, &["recoveryProtocolVersion"])?;
        ensure(self.recovery_protocol_version == PROTOCOL_VERSION)
    }
}
impl Request for AdmissionRequest {
    const LIMIT: usize = CONTROL_BYTES;
    fn validate(&self, v: &Value) -> Result<(), RecoveryError> {
        exact(
            v,
            &[
                "recoveryProtocolVersion",
                "requestId",
                "runtimeEpoch",
                "collection",
                "expectedHead",
                "context",
            ],
        )?;
        common(self.recovery_protocol_version, &self.request_id)?;
        ensure(hex(&self.runtime_epoch))?;
        collection(&self.collection)?;
        head(&self.expected_head, true)?;
        super::publication::validate_context_shape(&self.context)
    }
}
impl Request for StartRequest {
    const LIMIT: usize = CONTROL_BYTES;
    fn validate(&self, v: &Value) -> Result<(), RecoveryError> {
        exact(
            v,
            &[
                "recoveryProtocolVersion",
                "requestId",
                "origin",
                "journalId",
                "binding",
                "headerDigest",
            ],
        )?;
        common(self.recovery_protocol_version, &self.request_id)?;
        binding(&self.binding, &self.origin)?;
        ensure(hex(&self.journal_id) && hex(&self.header_digest))
    }
}
impl Request for StopRequest {
    const LIMIT: usize = CONTROL_BYTES;
    fn validate(&self, v: &Value) -> Result<(), RecoveryError> {
        exact(
            v,
            &[
                "recoveryProtocolVersion",
                "requestId",
                "origin",
                "journalId",
                "mode",
                "expectedControlRevision",
            ],
        )?;
        common(self.recovery_protocol_version, &self.request_id)?;
        identity(&self.origin)?;
        ensure(hex(&self.journal_id))?;
        match (self.mode.as_str(), &self.expected_control_revision) {
            ("stop", None) => Ok(()),
            ("retry_cleanup", Some(r)) => counter(r).map(|_| ()),
            _ => Err(RecoveryError::invalid()),
        }
    }
}
impl Request for ReadRequest {
    const LIMIT: usize = CONTROL_BYTES;
    fn validate(&self, v: &Value) -> Result<(), RecoveryError> {
        exact(
            v,
            &[
                "recoveryProtocolVersion",
                "journalId",
                "origin",
                "binding",
                "afterSeq",
                "throughSeq",
                "limit",
            ],
        )?;
        ensure(
            self.recovery_protocol_version == PROTOCOL_VERSION
                && hex(&self.journal_id)
                && (1..=64).contains(&self.limit),
        )?;
        binding(&self.binding, &self.origin)?;
        let a = counter(&self.after_seq)?;
        if let Some(t) = &self.through_seq {
            ensure(counter(t)? >= a)?;
        }
        Ok(())
    }
}
impl Request for ProjectionRequest {
    const LIMIT: usize = PACKET_BYTES;
    fn validate(&self, v: &Value) -> Result<(), RecoveryError> {
        exact(
            v,
            &[
                "recoveryProtocolVersion",
                "requestId",
                "journalId",
                "origin",
                "binding",
                "expectedHead",
                "expectedAppliedSeq",
                "throughSeq",
                "rangeDigest",
                "projection",
            ],
        )?;
        common(self.recovery_protocol_version, &self.request_id)?;
        binding(&self.binding, &self.origin)?;
        head(&self.expected_head, true)?;
        ensure(
            hex(&self.journal_id)
                && hex(&self.range_digest)
                && self.expected_head.task_id == self.binding.task_id
                && self.expected_head.generation == self.binding.generation
                && counter(&self.through_seq)? > counter(&self.expected_applied_seq)?,
        )?;
        exact(&v["projection"], &["task"])?;
        ensure(
            self.projection.task.as_object().is_some()
                && self.projection.task.get("id").and_then(Value::as_str)
                    == Some(self.binding.task_id.as_str()),
        )
    }
}

pub fn execution_input(raw: &str) -> Result<Value, RecoveryError> {
    let value = raw_json(raw, INPUT_BYTES)?;
    let object = value.as_object().ok_or_else(RecoveryError::invalid)?;
    let allowed = [
        "ticker",
        "analysisDate",
        "assetType",
        "researchDepth",
        "analysts",
        "outputLanguage",
        "llmProvider",
        "backendUrl",
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
        "pythonPath",
        "projectRoot",
        "systemLanguage",
        "providerConfigured",
        "alphaVantageConfigured",
    ];
    ensure(object.keys().all(|k| allowed.contains(&k.as_str())))?;
    Ok(value)
}
pub fn validate_envelope(e: &JournalEnvelope) -> Result<(), RecoveryError> {
    ensure(
        e.recovery_protocol_version == PROTOCOL_VERSION
            && hex(&e.journal_id)
            && hex(&e.payload_digest),
    )?;
    binding(&e.binding, &e.origin)?;
    let seq = counter(&e.seq)?;
    ensure(seq > 0)?;
    utc(&e.observed_at)?;
    utc(&e.seed.updated_at)?;
    ensure(e.kind != "accepted" || seq == 1)?;
    ensure(
        e.seed.updated_at == e.observed_at
            && e.seed.log_id == format!("log:{}:{}", e.journal_id, e.seq)
            && e.seed.log_timestamp.len() <= 256,
    )?;
    super::publication::validate_payload(&e.kind, &e.payload)?;
    ensure(
        e.seed.log_timestamp
            == super::publication::expected_log_timestamp(&e.kind, &e.payload, &e.observed_at)?,
    )?;
    let completed = super::publication::has_completion_seed(&e.kind, &e.payload);
    if completed {
        ensure(
            e.seed.completion_version_id.as_deref()
                == Some(format!("report:{}:{}", e.journal_id, e.seq).as_str())
                && e.seed.completion_created_at.as_deref() == Some(e.observed_at.as_str()),
        )?;
    } else {
        ensure(e.seed.completion_version_id.is_none() && e.seed.completion_created_at.is_none())?;
    }
    let body = serde_json::json!({"kind":e.kind,"observedAt":e.observed_at,"payload":e.payload,"seed":e.seed});
    ensure(digest(&body)? == e.payload_digest)
}

pub fn validate_seed_value(seed: &Value) -> Result<(), RecoveryError> {
    exact(
        seed,
        &[
            "updatedAt",
            "logId",
            "logTimestamp",
            "completionVersionId",
            "completionCreatedAt",
        ],
    )
}

pub fn validate_envelope_value(value: &Value) -> Result<JournalEnvelope, RecoveryError> {
    exact(
        value,
        &[
            "recoveryProtocolVersion",
            "journalId",
            "origin",
            "binding",
            "seq",
            "kind",
            "observedAt",
            "payload",
            "seed",
            "payloadDigest",
        ],
    )?;
    validate_seed_value(&value["seed"])?;
    let envelope = serde_json::from_value(value.clone()).map_err(|_| RecoveryError::invalid())?;
    validate_envelope(&envelope)?;
    Ok(envelope)
}

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;
