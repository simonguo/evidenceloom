//! Complete fictional stdin/stdout runner. Compiled only by the non-default
//! feature. No Python, network, provider, credential API, or user storage.
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};
const INPUT_LIMIT: usize = 8 * 1024 * 1024;
const CONTROL_LIMIT: usize = 4096;
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Unique;
        impl<'de> Visitor<'de> for Unique {
            type Value = Strict;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("bounded JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Strict(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut out = Vec::new();
                while let Some(Strict(v)) = a.next_element()? {
                    out.push(v);
                }
                Ok(Strict(out.into()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut out = serde_json::Map::new();
                let mut keys = BTreeSet::new();
                while let Some(k) = a.next_key::<String>()? {
                    if !keys.insert(k.clone()) {
                        return Err(de::Error::custom("duplicate field"));
                    }
                    let Strict(v) = a.next_value()?;
                    out.insert(k, v);
                }
                Ok(Strict(out.into()))
            }
        }
        deserializer.deserialize_any(Unique)
    }
}
fn parse(raw: &[u8], limit: usize) -> Result<Value, ()> {
    if raw.len() > limit {
        return Err(());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(raw);
    let Strict(value) = Strict::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())?;
    if !value.is_object() {
        return Err(());
    }
    Ok(value)
}
fn response(request: &Value) -> Result<Option<Value>, ()> {
    match request.get("__command").and_then(Value::as_str) {
        Some("smoke_test") if request["memoryInventory"] == true => {
            let ids = request["decisionIds"].as_array().ok_or(())?;
            if ids.len() > 128
                || !ids
                    .iter()
                    .all(|id| id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256))
            {
                return Err(());
            }
            Ok(Some(
                json!({"type":"memory_inventory","schema_version":1,"requested_ids":ids,"reviews":[],"missing_ids":ids,"timestamp":"2000-01-01T00:00:00.000Z"}),
            ))
        }
        Some("smoke_test") => Ok(Some(
            json!({"type":if request["verifyRuntime"]==true {"runtime_ready"}else{"ready"}}),
        )),
        Some("resolve_instrument") => Ok(Some(
            json!({"query":"Fictional instrument","ticker":"FICTION","displayName":"Fictional instrument","assetType":"stock","quoteType":"EQUITY","exchange":"FICTION","market":"FICTION","confidence":1.0,"reason":"Owned fictional fixture; no market lookup.","alternatives":[]}),
        )),
        Some("load_ohlcv_chart") => Ok(Some(
            json!([{ "time":"2000-01-01","open":10.0,"high":12.0,"low":9.0,"close":11.0,"volume":100.0 }]),
        )),
        Some("test_llm") => Ok(Some(
            json!({"ok":true,"provider":"fictional","model":"owned-fixture","latencyMs":0,"message":"Fictional runner; no provider call."}),
        )),
        Some("evidence_manifest") => Ok(Some(
            json!({"type":"error","message":"Fictional fixture has no production research manifest."}),
        )),
        Some(_) => Err(()),
        None if request.get("__command").is_some() => Err(()),
        None => Ok(None),
    }
}
fn hex(raw: &str, len: usize) -> bool {
    raw.len() == len
        && raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn control_path(root: &Path, name: &str) -> Result<std::path::PathBuf, ()> {
    let meta = fs::symlink_metadata(root).map_err(|_| ())?;
    if !root.is_absolute() || !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(());
    }
    Ok(root.join(name))
}
struct StartedTemporary(Option<std::path::PathBuf>);
impl Drop for StartedTemporary {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}
fn publish_started(root: &Path, session: &str, nonce: &str) -> Result<(), ()> {
    if !hex(session, 32) || !hex(nonce, 64) {
        return Err(());
    }
    let marker = control_path(root, &format!("{nonce}.started.json"))?;
    let expected = json!({"schemaVersion":1,"sessionId":session,"releaseNonce":nonce,"status":"worker_started"});
    let verify_existing = || {
        let meta = fs::symlink_metadata(&marker).map_err(|_| ())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > CONTROL_LIMIT as u64 {
            return Err(());
        }
        let mut bytes = Vec::new();
        fs::File::open(&marker)
            .map_err(|_| ())?
            .take(CONTROL_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if parse(&bytes, CONTROL_LIMIT)? == expected {
            Ok(())
        } else {
            Err(())
        }
    };
    match fs::symlink_metadata(&marker) {
        Ok(_) => return verify_existing(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(()),
    }
    let path = control_path(root, &format!("{nonce}.started.pending"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| ())?;
    let mut temporary = StartedTemporary(Some(path.clone()));
    let bytes = serde_json::to_vec(&expected).map_err(|_| ())?;
    file.write_all(&bytes).map_err(|_| ())?;
    drop(file);
    match fs::hard_link(&path, &marker) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => verify_existing()?,
        Err(_) => return Err(()),
    }
    fs::remove_file(&path).map_err(|_| ())?;
    temporary.0 = None;
    Ok(())
}
fn wait_release(root: &Path, session: &str, nonce: &str, timeout: Duration) -> Result<(), ()> {
    publish_started(root, session, nonce)?;
    let gate = control_path(root, &format!("{nonce}.release.json"))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match fs::symlink_metadata(&gate) {
            Ok(meta) => {
                if !meta.is_file()
                    || meta.file_type().is_symlink()
                    || meta.len() > CONTROL_LIMIT as u64
                {
                    return Err(());
                }
                let mut bytes = Vec::new();
                fs::File::open(&gate)
                    .map_err(|_| ())?
                    .take(CONTROL_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| ())?;
                return if parse(&bytes, CONTROL_LIMIT)?
                    == json!({"schemaVersion":1,"sessionId":session,"releaseNonce":nonce,"status":"worker_released"})
                {
                    Ok(())
                } else {
                    Err(())
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return Err(()),
        }
    }
    Err(())
}
fn run() -> Result<(), ()> {
    if std::env::args_os().len() != 1 {
        return Err(());
    }
    let mut raw = Vec::new();
    std::io::stdin()
        .take(INPUT_LIMIT as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| ())?;
    let request = parse(&raw, INPUT_LIMIT)?;
    let mut stdout = std::io::stdout().lock();
    if let Some(value) = response(&request)? {
        writeln!(stdout, "{value}").map_err(|_| ())?;
        return Ok(());
    }
    let root = std::env::var_os("EVIDENCELOOM_ACCEPTANCE_CONTROL_ROOT").ok_or(())?;
    let session = std::env::var("EVIDENCELOOM_ACCEPTANCE_SESSION_ID").map_err(|_| ())?;
    let nonce = std::env::var("EVIDENCELOOM_ACCEPTANCE_RELEASE_NONCE").map_err(|_| ())?;
    writeln!(stdout,"{}",json!({"type":"progress","message":"Owned fictional worker is waiting for an exact release.","timestamp":"2000-01-01T00:00:00.000Z"})).map_err(|_|())?;
    stdout.flush().map_err(|_| ())?;
    wait_release(Path::new(&root), &session, &nonce, Duration::from_secs(120))?;
    writeln!(stdout,"{}",json!({"type":"completed","timestamp":"2000-01-01T00:00:01.000Z","reportSections":{"market_report":"Fictional saved research for isolated WebView acceptance."},"stats":{"llmCalls":0,"toolCalls":0,"tokensIn":0,"tokensOut":0,"elapsedSeconds":1.0}})).map_err(|_|())?;
    Ok(())
}
fn main() {
    if run().is_err() {
        let _ = writeln!(
            std::io::stdout(),
            "{}",
            json!({"type":"error","message":"Owned fixture protocol is unavailable."})
        );
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_acceptance_fixture_protocol_has_real_auxiliary_responses_and_rejects_unknown() {
        assert_eq!(
            response(&json!({"__command":"smoke_test","verifyRuntime":true})).unwrap(),
            Some(json!({"type":"runtime_ready"}))
        );
        for command in [
            "test_llm",
            "resolve_instrument",
            "load_ohlcv_chart",
            "evidence_manifest",
        ] {
            assert!(response(&json!({"__command":command})).unwrap().is_some());
        }
        assert!(response(&json!({"__command":"arbitrary"})).is_err());
        assert!(response(&json!({"__command":null})).is_err());
        assert!(response(&json!({"ticker":"FICTION"})).unwrap().is_none());
    }
    #[test]
    fn desktop_acceptance_fixture_rejects_duplicate_trailing_and_oversized_input() {
        for raw in [b"{\"a\":1,\"a\":2}".as_slice(), b"{}{}", b"[]"] {
            assert!(parse(raw, 1024).is_err());
        }
        assert!(parse(b"{}", 1).is_err());
        assert!(parse(b"{\"a\":{\"x\":0,\"x\":1}}", 1024).is_err());
    }
    #[test]
    fn desktop_acceptance_fixture_inventory_is_explicitly_missing_not_invented() {
        let value = response(
            &json!({"__command":"smoke_test","memoryInventory":true,"decisionIds":["fictional"]}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["reviews"], json!([]));
        assert_eq!(value["missing_ids"], json!(["fictional"]));
    }
    #[test]
    fn desktop_acceptance_fixture_waits_for_owned_exact_release_and_rejects_other_session() {
        let base = std::env::var_os("EVIDENCELOOM_DESKTOP_ACCEPTANCE_FIXTURE_ROOT")
            .expect("Explicit owned fixture root is required.");
        fs::create_dir_all(&base).unwrap();
        let root = std::path::PathBuf::from(base)
            .canonicalize()
            .unwrap()
            .join(format!("fixture-control-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let session = "a".repeat(32);
        let nonce = "b".repeat(64);
        // Precreate only the fixed release file. The real production wait helper
        // creates its started receipt and verifies the release identity.
        let gate = root.join(format!("{nonce}.release.json"));
        fs::write(&gate,json!({"schemaVersion":1,"sessionId":"c".repeat(32),"releaseNonce":nonce,"status":"worker_released"}).to_string()).unwrap();
        let first = wait_release(&root, &session, &nonce, Duration::from_secs(1));
        let started = root.join(format!("{nonce}.started.json"));
        let original = fs::read(&started);
        let _ = fs::remove_file(&started);
        fs::write(&gate,json!({"schemaVersion":1,"sessionId":session,"releaseNonce":nonce,"status":"worker_released"}).to_string()).unwrap();
        let second = wait_release(&root, &session, &nonce, Duration::from_secs(1));
        let _ = fs::remove_dir_all(root);
        assert!(first.is_err());
        assert!(original.is_ok());
        assert!(second.is_ok());
    }
    #[test]
    fn desktop_acceptance_fixture_started_marker_is_complete_and_never_overwrites_wrong_identity() {
        let base = std::env::var_os("EVIDENCELOOM_DESKTOP_ACCEPTANCE_FIXTURE_ROOT")
            .expect("Explicit owned fixture root is required.");
        fs::create_dir_all(&base).unwrap();
        let root = std::path::PathBuf::from(base)
            .canonicalize()
            .unwrap()
            .join(format!("fixture-marker-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let session = "a".repeat(32);
        let nonce = "b".repeat(64);
        let marker = root.join(format!("{nonce}.started.json"));
        let pending = root.join(format!("{nonce}.started.pending"));
        let published = publish_started(&root, &session, &nonce);
        let complete = fs::read(&marker).and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(std::io::Error::other)
        });
        let cleaned = !pending.exists();
        let wrong = json!({"schemaVersion":1,"sessionId":"c".repeat(32),"releaseNonce":nonce,"status":"worker_started"}).to_string();
        fs::write(&marker, &wrong).unwrap();
        let rejected = publish_started(&root, &session, &nonce);
        let unchanged = fs::read_to_string(&marker).map(|bytes| bytes == wrong);
        let no_leftover = !pending.exists();
        let _ = fs::remove_dir_all(root);
        assert!(published.is_ok());
        assert_eq!(
            complete.unwrap(),
            json!({"schemaVersion":1,"sessionId":session,"releaseNonce":nonce,"status":"worker_started"})
        );
        assert!(cleaned && no_leftover);
        assert!(rejected.is_err());
        assert!(unchanged.unwrap());
    }
}
