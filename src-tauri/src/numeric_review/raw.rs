//! Parse a normalized JSON string while preserving its number tokens verbatim.
use super::{ensure, Result, ERROR};
use serde::{de, Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

#[derive(Debug)]
pub(super) enum Raw {
    Other,
    String(String),
    Number(String),
    Array(Vec<Raw>),
    Object(BTreeMap<String, Raw>),
}

impl Raw {
    pub(super) fn parse(value: &str) -> Result<Self> {
        Self::parse_at(value, 0)
    }
    fn parse_at(value: &str, depth: usize) -> Result<Self> {
        ensure(depth <= 64)?;
        let raw: Box<RawValue> = serde_json::from_str(value).map_err(|_| ERROR)?;
        let text = raw.get();
        match text.as_bytes().first() {
            Some(b'{') => {
                let values: StrictObject = serde_json::from_str(text).map_err(|_| ERROR)?;
                Ok(Self::Object(
                    values
                        .0
                        .into_iter()
                        .map(|(key, value)| Ok((key, Self::parse_at(value.get(), depth + 1)?)))
                        .collect::<Result<_>>()?,
                ))
            }
            Some(b'[') => {
                let values: Vec<Box<RawValue>> = serde_json::from_str(text).map_err(|_| ERROR)?;
                Ok(Self::Array(
                    values
                        .into_iter()
                        .map(|value| Self::parse_at(value.get(), depth + 1))
                        .collect::<Result<_>>()?,
                ))
            }
            Some(b'"') => Ok(Self::String(serde_json::from_str(text).map_err(|_| ERROR)?)),
            Some(b'-' | b'0'..=b'9') => Ok(Self::Number(text.into())),
            _ => Ok(Self::Other),
        }
    }
    pub(super) fn object(&self) -> Option<&BTreeMap<String, Raw>> {
        if let Self::Object(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub(super) fn array(&self) -> Option<&Vec<Raw>> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub(super) fn text(&self) -> Option<&str> {
        if let Self::String(value) = self {
            Some(value)
        } else {
            None
        }
    }
}

struct StrictObject(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for StrictObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = StrictObject;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("unique object keys")
            }
            fn visit_map<A: de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if values.insert(key, value).is_some() {
                        return Err(de::Error::custom(ERROR));
                    }
                }
                Ok(StrictObject(values))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_numbers_are_not_parsed_or_reserialized_through_float() {
        assert!(Raw::parse(" \n\t{\"n\":1}\r\n ")
            .unwrap()
            .object()
            .is_some());
        let value = Raw::parse(
            r#"{"n":123.45678901234567,"i":1.0,"e":1e-07,"huge":9007199254740993,"zero":-0.0}"#,
        )
        .unwrap();
        for (key, expected) in [
            ("n", "123.45678901234567"),
            ("i", "1.0"),
            ("e", "1e-07"),
            ("huge", "9007199254740993"),
            ("zero", "-0.0"),
        ] {
            assert!(matches!(&value.object().unwrap()[key], Raw::Number(raw) if raw == expected));
        }
        assert!(Raw::parse(r#"{"n":1,"n":2}"#).is_err());
        assert!(Raw::parse(r#"{"nested":{"n":1,"n":2}}"#).is_err());
    }
}
