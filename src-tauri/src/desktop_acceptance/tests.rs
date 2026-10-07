//! Owned-only unit checks: no App/Builder, dialogs, System credentials or process.
use super::*;
use crate::analysis_recovery::wire::{NativeOwner, RunBinding, RunIdentity, RuntimeObservation};
use std::sync::atomic::{AtomicUsize, Ordering};
static COUNTER: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    parent: PathBuf,
    root: PathBuf,
    runner: PathBuf,
    manifest: PathBuf,
    stamp: BuildStamp,
    raw: String,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::var_os("EVIDENCELOOM_DESKTOP_ACCEPTANCE_FIXTURE_ROOT")
            .expect("Explicit owned acceptance unit root is required.");
        fs::create_dir_all(&base).unwrap();
        let parent = PathBuf::from(base).canonicalize().unwrap().join(format!(
            "acceptance-unit-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&parent).unwrap();
        let parent = parent.canonicalize().unwrap();
        let root = parent.join("session");
        fs::create_dir(&root).unwrap();
        let runner = parent.join("fictional-nonlaunchable-unit-file");
        let runner_bytes = b"nonlaunchable unit bytes";
        fs::write(&runner, runner_bytes).unwrap();
        let value = serde_json::json!({"schemaVersion":1,"mode":"acceptance","stage":"app","buildId":"0".repeat(64),"baseCommit":"a".repeat(40),
            "sourceInventorySha256":"b".repeat(64),"target":"x86_64-apple-darwin","enabledFeatures":["desktop-acceptance"],"signingPolicy":"unsigned",
            "permittedOwnedParent":parent,"effectiveConfigSha256":"c".repeat(64),"aclInventorySha256":"d".repeat(64),"frontendInputInventorySha256":"e".repeat(64),
            "frontendInventorySha256":"f".repeat(64),"cargoLockSha256":"1".repeat(64),"frontendLockSha256":"2".repeat(64),
            "fixture":{"protocolVersion":1,"logicalResource":"evidenceloom-desktop-fixture","sha256":sha256(runner_bytes),"bytes":runner_bytes.len()}});
        let raw = stamp_raw(value);
        let stamp = validate_stamp(&raw, "x86_64-apple-darwin").unwrap();
        fs::write(root.join(".desktop-acceptance-owner.json"),serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"buildId":stamp.build_id})).unwrap()).unwrap();
        let manifest = parent.join("launch.json");
        fs::write(&manifest,serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"mode":"acceptance","sessionId":"3".repeat(32),"ownedRoot":root,"buildId":stamp.build_id,"compiledStampSha256":sha256(raw.as_bytes()),"target":stamp.target})).unwrap()).unwrap();
        Self {
            parent,
            root,
            runner,
            manifest,
            stamp,
            raw,
        }
    }
    fn prepare(&self) -> Result<PreparedAcceptance, AcceptanceError> {
        prepare_paths(
            self.stamp.clone(),
            &sha256(self.raw.as_bytes()),
            &self.manifest,
            self.runner.clone(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}
fn stamp_raw(mut value: Value) -> String {
    let mut input = value.clone();
    input.as_object_mut().unwrap().remove("buildId");
    input
        .as_object_mut()
        .unwrap()
        .remove("frontendInventorySha256");
    value["buildId"] = sha256(
        format!(
            "{}\n",
            crate::research_memory::canonical_json(&input).unwrap()
        )
        .as_bytes(),
    )
    .into();
    format!(
        "{}\n",
        crate::research_memory::canonical_json(&value).unwrap()
    )
}
fn observation() -> RuntimeObservation {
    RuntimeObservation {
        recovery_protocol_version: 1,
        initialization: "ready".into(),
        runtime_epoch: Some("a".repeat(64)),
        observation_revision: "1".into(),
        owner: Some(NativeOwner {
            origin: RunIdentity {
                runtime_epoch: "a".repeat(64),
                task_id: "fiction".into(),
                run_id: "analysis-1".into(),
            },
            admission_request_id: "admit-1".into(),
            admission_digest: "b".repeat(64),
            journal_id: "journal-1".into(),
            binding: RunBinding {
                collection: crate::storage::task_mutation::CollectionToken {
                    collection_id: "collection".into(),
                    epoch: "0".into(),
                },
                task_id: "fiction".into(),
                generation: "1".into(),
            },
            phase: "running".into(),
            control_revision: "0".into(),
            cleanup_state: "pending".into(),
        }),
        runtime_gate: "occupied".into(),
        journal_gate: "blocked".into(),
        blockers: vec![],
    }
}
#[test]
fn desktop_acceptance_preparation_uses_fresh_owned_directories_and_ephemeral_metadata() {
    let f = Fixture::new();
    let token = f.prepare().unwrap();
    token.recheck().unwrap();
    let environment =
        crate::application_environment::ApplicationEnvironment::from_prepared_acceptance(&token);
    assert_eq!(
        environment
            .app_data_dir(|| panic!("System path must not run"))
            .unwrap(),
        f.root.join("data")
    );
    assert!(environment
        .database_candidates(&f.root, |_| panic!("Legacy scan must not run"))
        .is_empty());
    assert!(environment
        .legacy_key_candidates(&f.root, |_| panic!("Legacy key scan must not run"))
        .is_empty());
    assert_eq!(
        environment.sidecar(|| panic!("System runner must not run")),
        Some(f.runner.clone())
    );
    assert!(!environment.credential_metadata("openai"));
    environment
        .credential_store()
        .set("fictional", "ephemeral value")
        .unwrap();
    assert!(environment.credential_metadata("fictional"));
    environment.credential_store().delete("fictional").unwrap();
    assert!(!environment.credential_metadata("fictional"));
    assert!(environment.permit_native_dialog().is_err());
    assert!(f.prepare().is_err()); // cannot reuse app DB/profile even if empty
}
#[test]
fn desktop_acceptance_compile_only_fixture_shipping_and_tampered_stamp_cannot_prepare() {
    let f = Fixture::new();
    let value: Value = serde_json::from_str(&f.raw).unwrap();
    for (key, bad) in [
        ("stage", Value::from("compile-only")),
        ("stage", Value::from("fixture-only")),
        ("mode", Value::from("shipping")),
        ("enabledFeatures", serde_json::json!([])),
        ("fixture", Value::Null),
        ("target", Value::from("other")),
    ] {
        let mut changed = value.clone();
        changed[key] = bad;
        assert!(validate_stamp(&stamp_raw(changed), "x86_64-apple-darwin").is_err());
    }
    let mut changed = value;
    changed["baseCommit"] = "c".repeat(40).into();
    assert!(validate_stamp(&changed.to_string(), "x86_64-apple-darwin").is_err());
}
#[test]
fn desktop_acceptance_manifest_duplicate_unknown_wrong_session_and_build_fail_before_directories() {
    for raw in [
        "{\"mode\":\"acceptance\",\"mode\":\"shipping\"}".into(),
        format!("{{\"unknown\":\"{}\"}}", "private-unit-marker"),
    ] {
        let f = Fixture::new();
        fs::write(&f.manifest, raw).unwrap();
        let error = f.prepare().err().unwrap();
        assert!(!error.to_string().contains("private-unit-marker"));
        assert!(!f.root.join("data").exists());
    }
    for key in ["sessionId", "buildId", "compiledStampSha256", "target"] {
        let f = Fixture::new();
        let mut manifest: Value = serde_json::from_slice(&fs::read(&f.manifest).unwrap()).unwrap();
        manifest[key] = "wrong".into();
        fs::write(&f.manifest, manifest.to_string()).unwrap();
        assert!(f.prepare().is_err());
        assert!(!f.root.join("data").exists());
    }
}
#[test]
fn desktop_acceptance_changed_runner_and_preexisting_data_fail_closed() {
    let f = Fixture::new();
    fs::write(&f.runner, b"changed fixture bytes").unwrap();
    assert!(f.prepare().is_err());
    assert!(!f.root.join("data").exists());
    let f = Fixture::new();
    fs::create_dir(f.root.join("data")).unwrap();
    fs::write(f.root.join("data/research-marker"), b"owned fiction").unwrap();
    assert!(f.prepare().is_err());
    assert_eq!(
        fs::read(f.root.join("data/research-marker")).unwrap(),
        b"owned fiction"
    );
}
#[test]
fn desktop_acceptance_manifest_outside_permitted_parent_is_not_read() {
    let f = Fixture::new();
    let other = Fixture::new();
    assert_eq!(
        prepare_paths(
            f.stamp.clone(),
            &sha256(f.raw.as_bytes()),
            &other.manifest,
            f.runner.clone()
        )
        .err()
        .unwrap()
        .code,
        "acceptance_path_invalid"
    );
}
#[cfg(unix)]
#[test]
fn desktop_acceptance_forbids_selected_symlinks_but_accepts_physical_parent_alias_spelling() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let alias = f.parent.join("alias.json");
    symlink(&f.manifest, &alias).unwrap();
    assert!(prepare_paths(
        f.stamp.clone(),
        &sha256(f.raw.as_bytes()),
        &alias,
        f.runner.clone()
    )
    .is_err());
    let alias_root = f.parent.join("alias-root");
    symlink(&f.root, &alias_root).unwrap();
    assert!(checked_inside(&alias_root, &f.parent, true).is_err());
    // An alias ABOVE the compiled permitted parent is canonicalized as an OS
    // path representation; no selected application directory traverses a link.
    let alias_above = f.parent.with_extension("representation-alias");
    symlink(f.parent.parent().unwrap(), &alias_above).unwrap();
    let aliased_parent = alias_above.join(f.parent.file_name().unwrap());
    let result = prepare_paths(
        f.stamp.clone(),
        &sha256(f.raw.as_bytes()),
        &aliased_parent.join("launch.json"),
        aliased_parent.join(f.runner.file_name().unwrap()),
    );
    let _ = fs::remove_file(alias_above);
    assert!(result.is_ok());
}
#[test]
fn desktop_acceptance_effective_context_requires_manual_single_main_and_no_runner_or_hooks() {
    let mut value: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    value["identifier"] = "io.github.simonguo.evidenceloom.acceptance".into();
    value["productName"] = "Evidence Loom Acceptance".into();
    value["build"]["devUrl"] = Value::Null;
    value["build"]["beforeDevCommand"] = Value::Null;
    value["build"]["beforeBuildCommand"] = Value::Null;
    value["bundle"]["active"] = false.into();
    value["bundle"]["externalBin"] = serde_json::json!([]);
    value["bundle"]["resources"] = serde_json::json!({});
    value["app"]["windows"][0]["label"] = "main".into();
    value["app"]["windows"][0]["create"] = false.into();
    value["app"]["security"]["capabilities"] = serde_json::json!(["desktop-acceptance"]);
    let config: tauri::Config = serde_json::from_value(value.clone()).unwrap();
    validate_config(&config).unwrap();
    for pointer in ["/app/windows/0/create", "/bundle/active"] {
        let mut bad = value.clone();
        *bad.pointer_mut(pointer).unwrap() = true.into();
        assert!(validate_config(&serde_json::from_value(bad).unwrap()).is_err());
    }
    let mut bad = value;
    bad["bundle"]["externalBin"] = serde_json::json!(["binaries/evidenceloom-runner"]);
    assert!(validate_config(&serde_json::from_value(bad).unwrap()).is_err());
}
#[test]
fn desktop_acceptance_generated_context_matches_exact_sdk_runtime_config() {
    // Creates only the real generated Context: no App, Builder, WebView or paths.
    let context: tauri::Context<tauri::Wry> = crate::generated_desktop_context();
    let expected = expected_runtime_config();
    let full_hash = sha256(EFFECTIVE_CONFIG.as_bytes());
    verify_config_identity(context.config(), &expected, EFFECTIVE_CONFIG, &full_hash).unwrap();
    let full: Value = serde_json::from_str(EFFECTIVE_CONFIG).unwrap();
    let runtime = serde_json::to_value(context.config()).unwrap();
    // The locked SDK intentionally removes this build-time-only field.
    assert!(full.get("$schema").is_some());
    assert!(runtime.get("$schema").is_none());
    let runtime = crate::research_memory::canonical_json(&runtime).unwrap();
    assert_ne!(sha256(format!("{runtime}\n").as_bytes()), full_hash);
}
#[test]
fn desktop_acceptance_expected_runtime_config_field_tampering_rejects() {
    let context: tauri::Context<tauri::Wry> = crate::generated_desktop_context();
    let full_hash = sha256(EFFECTIVE_CONFIG.as_bytes());
    for field in 0..4 {
        let mut expected = expected_runtime_config();
        match field {
            0 => expected.identifier.push_str(".tampered"),
            1 => expected.app.windows[0].title.push_str(" tampered"),
            2 => expected.app.security.freeze_prototype = !expected.app.security.freeze_prototype,
            _ => expected.bundle.active = !expected.bundle.active,
        }
        assert_eq!(
            verify_config_identity(context.config(), &expected, EFFECTIVE_CONFIG, &full_hash)
                .unwrap_err()
                .code,
            "acceptance_config_invalid"
        );
    }
}
#[test]
fn desktop_acceptance_full_embedded_typed_config_identity_tampering_rejects() {
    let context: tauri::Context<tauri::Wry> = crate::generated_desktop_context();
    let expected = expected_runtime_config();
    let full_hash = sha256(EFFECTIVE_CONFIG.as_bytes());
    let mut value: Value = serde_json::from_str(EFFECTIVE_CONFIG).unwrap();
    // Even a field that codegen discards retains its original full-config bind.
    value["$schema"] = "https://invalid.example/tampered-schema".into();
    let changed = format!(
        "{}\n",
        crate::research_memory::canonical_json(&value).unwrap()
    );
    for (raw, digest) in [
        (changed.as_str(), full_hash.as_str()),
        (
            EFFECTIVE_CONFIG,
            "0000000000000000000000000000000000000000000000000000000000000000",
        ),
    ] {
        assert_eq!(
            verify_config_identity(context.config(), &expected, raw, digest)
                .unwrap_err()
                .code,
            "acceptance_config_invalid"
        );
    }
}
#[test]
fn desktop_acceptance_actual_generated_context_config_tampering_rejects() {
    let full_hash = sha256(EFFECTIVE_CONFIG.as_bytes());
    for field in 0..4 {
        let mut context: tauri::Context<tauri::Wry> = crate::generated_desktop_context();
        let actual = context.config_mut();
        match field {
            0 => actual.identifier.push_str(".tampered"),
            1 => actual.app.windows[0].create = !actual.app.windows[0].create,
            2 => actual.app.security.freeze_prototype = !actual.app.security.freeze_prototype,
            _ => actual.bundle.active = !actual.bundle.active,
        }
        assert_eq!(
            verify_config_identity(
                context.config(),
                &expected_runtime_config(),
                EFFECTIVE_CONFIG,
                &full_hash,
            )
            .unwrap_err()
            .code,
            "acceptance_config_invalid"
        );
    }
}
#[test]
fn desktop_acceptance_controls_exact_release_reject_replacement_and_preserve_fixed_sinks() {
    let f = Fixture::new();
    let token = f.prepare().unwrap();
    let controls = token.controls();
    let observed = observation();
    let owner = observed.owner.as_ref().unwrap();
    let worker = controls
        .register_identity(
            &observed,
            owner.origin.clone(),
            owner.journal_id.clone(),
            owner.binding.clone(),
            "c".repeat(64),
        )
        .unwrap();
    let started = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"releaseNonce":worker.release_nonce,"status":"worker_started"});
    fs::write(
        f.root
            .join("control")
            .join(format!("{}.started.json", worker.release_nonce)),
        started.to_string(),
    )
    .unwrap();
    let request = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"requestId":"release-1","origin":worker.origin,"journalId":worker.journal_id,"binding":worker.binding,"headerDigest":worker.header_digest,"releaseNonce":worker.release_nonce});
    for key in ["sessionId", "journalId", "headerDigest", "releaseNonce"] {
        let mut bad = request.clone();
        bad[key] = "mismatch".into();
        assert!(controls.release(&observed, &bad.to_string()).is_err());
    }
    assert!(!f
        .root
        .join("control")
        .join(format!("{}.release.json", worker.release_nonce))
        .exists());
    assert_eq!(
        serde_json::to_value(controls.release(&observed, &request.to_string()).unwrap()).unwrap()
            ["status"],
        "worker_released"
    );
    assert!(controls.release(&observed, &request.to_string()).is_ok());
    let gate = f
        .root
        .join("control")
        .join(format!("{}.release.json", worker.release_nonce));
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&gate).unwrap()).unwrap(),
        serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"releaseNonce":worker.release_nonce,"status":"worker_released"})
    );
    assert!(!f
        .root
        .join("control")
        .join(format!("{}.release.pending", worker.release_nonce))
        .exists());
    let mut replacement = observed.clone();
    replacement.owner.as_mut().unwrap().origin.run_id = "analysis-2".into();
    assert!(controls
        .release(&replacement, &request.to_string())
        .is_err());
    let lines = fs::read_to_string(f.root.join("control/checkpoints.jsonl")).unwrap();
    assert_eq!(lines.lines().count(), 1);
    assert!(lines.len() <= 4096);
    assert!(!lines.contains("ephemeral value"));
}
fn registered_release(
    f: &Fixture,
    controls: &control::ControlState,
    observed: &RuntimeObservation,
) -> (control::WorkerWitness, Value) {
    let owner = observed.owner.as_ref().unwrap();
    let worker = controls
        .register_identity(
            observed,
            owner.origin.clone(),
            owner.journal_id.clone(),
            owner.binding.clone(),
            "c".repeat(64),
        )
        .unwrap();
    fs::write(f.root.join("control").join(format!("{}.started.json", worker.release_nonce)),
        serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"releaseNonce":worker.release_nonce,"status":"worker_started"})).unwrap()).unwrap();
    let request = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"requestId":"release-unit","origin":worker.origin,"journalId":worker.journal_id,"binding":worker.binding,"headerDigest":worker.header_digest,"releaseNonce":worker.release_nonce});
    (worker, request)
}
#[test]
fn desktop_acceptance_release_rejects_predictable_bad_sink_before_publishing_gate() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let observed = observation();
    let (worker, request) = registered_release(&f, &controls, &observed);
    let sink = f.root.join("control/checkpoints.jsonl");
    fs::create_dir(&sink).unwrap();
    assert!(controls.release(&observed, &request.to_string()).is_err());
    assert!(!f
        .root
        .join("control")
        .join(format!("{}.release.json", worker.release_nonce))
        .exists());
    assert!(!f
        .root
        .join("control")
        .join(format!("{}.release.pending", worker.release_nonce))
        .exists());
    // Predictable pre-effect rejection retains no success outcome: exact retry
    // works when only the owned invalid sink is repaired.
    fs::remove_dir(&sink).unwrap();
    assert!(controls.release(&observed, &request.to_string()).is_ok());
    assert_eq!(fs::read_to_string(&sink).unwrap().lines().count(), 1);
}
#[test]
fn desktop_acceptance_release_rejects_wrong_existing_gate_without_overwrite() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let observed = observation();
    let (worker, request) = registered_release(&f, &controls, &observed);
    let gate = f
        .root
        .join("control")
        .join(format!("{}.release.json", worker.release_nonce));
    let wrong = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"sessionId":"4".repeat(32),"releaseNonce":worker.release_nonce,"status":"worker_released"})).unwrap();
    fs::write(&gate, &wrong).unwrap();
    assert!(controls.release(&observed, &request.to_string()).is_err());
    assert_eq!(fs::read(&gate).unwrap(), wrong);
    assert!(!f
        .root
        .join("control")
        .join(format!("{}.release.pending", worker.release_nonce))
        .exists());
    assert!(fs::read(f.root.join("control/checkpoints.jsonl"))
        .unwrap()
        .is_empty());
}
#[test]
fn desktop_acceptance_controls_reject_duplicates_request_rebinding_capacity_and_false_ready_claim()
{
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let observed = observation();
    assert!(controls
        .checkpoint(&observed, "{\"schemaVersion\":1,\"schemaVersion\":1}")
        .is_err());
    let raw=serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"requestId":"one","checkpoint":"renderer_ready"}).to_string();
    controls.checkpoint(&observed, &raw).unwrap();
    let mut changed: Value = serde_json::from_str(&raw).unwrap();
    changed["checkpoint"] = "runtime_ready".into();
    assert!(controls
        .checkpoint(&observed, &changed.to_string())
        .is_err());
    changed["requestId"] = "false-ready".into();
    changed["checkpoint"] = "run_complete".into();
    assert!(controls
        .checkpoint(&observed, &changed.to_string())
        .is_err());
    for index in 1..127 {
        let request = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),"requestId":format!("r-{index}"),"checkpoint":"renderer_ready"});
        controls
            .checkpoint(&observed, &request.to_string())
            .unwrap();
    }
    assert!(controls.checkpoint(&observed, &raw).is_ok());
    changed["requestId"] = "overflow".into();
    changed["checkpoint"] = "renderer_ready".into();
    assert!(controls
        .checkpoint(&observed, &changed.to_string())
        .is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("control/checkpoints.jsonl"))
            .unwrap()
            .lines()
            .count(),
        127
    );
}

fn driver_report_value(f: &Fixture, request: &str) -> Value {
    serde_json::json!({"schemaVersion":1,"planVersion":1,"sessionId":"3".repeat(32),
        "buildId":f.stamp.build_id,"requestId":request,"realmNonce":"4".repeat(32),
        "driverMarker":driver::DRIVER_MARKER,"step":"renderer_ready","verdict":"pass",
        "errorCode":null,"route":"tasks","tasks":[],"renderedReport":false,
        "stopControlVisible":false,"watchControlVisible":false})
}
fn finish_value(f: &Fixture, request: &str, reason: &str) -> Value {
    serde_json::json!({"schemaVersion":1,"planVersion":1,"sessionId":"3".repeat(32),
        "buildId":f.stamp.build_id,"requestId":request,"realmNonce":"4".repeat(32),
        "driverMarker":driver::DRIVER_MARKER,"reason":reason})
}
fn complete_report(f: &Fixture, request: &str) -> Value {
    let mut r = driver_report_value(f, request);
    r["step"] = "complete".into();
    r["tasks"] = serde_json::json!([
        {"slot":"a","taskId":"00000000-0000-4000-8000-00000000000a","status":"stopped","reportVersionId":null,"runId":"analysis-1"},
        {"slot":"b","taskId":"00000000-0000-4000-8000-00000000000b","status":"succeeded","reportVersionId":format!("report:{}:2", "b".repeat(64)),"runId":"analysis-2"},
        {"slot":"c","taskId":"00000000-0000-4000-8000-00000000000c","status":"stopped","reportVersionId":null,"runId":"analysis-3"},
        {"slot":"d","taskId":"00000000-0000-4000-8000-00000000000d","status":"succeeded","reportVersionId":format!("report:{}:4", "d".repeat(64)),"runId":"analysis-4"}]);
    r
}
#[test]
fn desktop_acceptance_bootstrap_is_exact_metadata_before_window_and_contains_no_owned_paths() {
    let f = Fixture::new();
    let p = f.prepare().unwrap();
    let script = p.bootstrap_script().unwrap();
    let encoded = script
        .split("Object.freeze(")
        .nth(1)
        .unwrap()
        .split("), writable:")
        .next()
        .unwrap();
    let value: Value = serde_json::from_str(encoded).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"schemaVersion":1,"planVersion":1,
        "sessionId":"3".repeat(32),"buildId":f.stamp.build_id,
        "compiledStampSha256":sha256(f.raw.as_bytes()),"target":"x86_64-apple-darwin",
        "driverMarker":driver::DRIVER_MARKER})
    );
    assert!(!script.contains(f.parent.to_str().unwrap()));
    assert!(!script.contains(f.root.to_str().unwrap()));
    assert!(!script.contains("provider") && !script.contains("ownedRoot"));
    assert!(script.contains("window.top === window") && script.contains("tauri.localhost"));
    assert!(driver::initialization_script(
        "bad-session",
        &f.stamp.build_id,
        &sha256(f.raw.as_bytes()),
        "x86_64-apple-darwin"
    )
    .is_err());
    assert!(driver::initialization_script(
        &"3".repeat(32),
        &f.stamp.build_id,
        &sha256(f.raw.as_bytes()),
        "';window.injected=true;//"
    )
    .is_err());
}
#[test]
fn desktop_acceptance_driver_metadata_rejects_unbounded_bodies_duplicates_and_missing_nulls() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let valid = driver_report_value(&f, "report-valid");
    let mut invalid = Vec::new();
    for (key, value) in [
        ("domBody", serde_json::json!("fictional body")),
        ("ownedRoot", serde_json::json!("/fictional/path")),
        ("apiKey", serde_json::json!("fictional secret")),
        ("step", serde_json::json!("arbitrary_step")),
        ("realmNonce", serde_json::json!("4".repeat(33))),
        ("buildId", serde_json::json!("0".repeat(64))),
        ("driverMarker", serde_json::json!("other-marker")),
        ("errorCode", serde_json::json!("unexpected_state")),
    ] {
        let mut r = valid.clone();
        r[key] = value;
        invalid.push(r.to_string());
    }
    let mut r = valid.clone();
    r.as_object_mut().unwrap().remove("errorCode");
    invalid.push(r.to_string());
    let mut r = valid.clone();
    r["verdict"] = "fail".into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-duplicate-slot");
    r["tasks"][1]["slot"] = "a".into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-duplicate-task");
    r["tasks"][1]["taskId"] = "00000000-0000-4000-8000-00000000000a".into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-missing-null");
    r["tasks"][0]
        .as_object_mut()
        .unwrap()
        .remove("reportVersionId");
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-body-field");
    r["tasks"][0]["reportBody"] = "body".into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-large-id");
    r["tasks"][0]["taskId"] = "x".repeat(97).into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-path-id");
    r["tasks"][0]["taskId"] = "../fiction".into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-invalid-run");
    r["tasks"][0]["runId"] = "analysis-01".into();
    invalid.push(r.to_string());
    let mut r = complete_report(&f, "report-fifth-task");
    let fifth = r["tasks"][0].clone();
    r["tasks"].as_array_mut().unwrap().push(fifth);
    invalid.push(r.to_string());
    invalid.push(valid.to_string().replace(
        "\"schemaVersion\":1",
        "\"schemaVersion\":1,\"schemaVersion\":1",
    ));
    invalid.push(format!("{}{}", " ".repeat(8192), valid));
    invalid.push(format!("{} trailing", valid));
    for raw in invalid {
        assert!(controls.report(&raw).is_err(), "invalid metadata accepted");
    }
    assert!(!f.root.join("control/checkpoints.jsonl").exists());
    assert!(
        controls
            .report(&valid.to_string())
            .unwrap()
            .attestation_only
    );
}
#[test]
fn desktop_acceptance_driver_replay_is_global_non_evicting_and_realm_task_bindings_are_bounded() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let mut r = complete_report(&f, "report-one");
    controls.report(&r.to_string()).unwrap();
    controls.report(&r.to_string()).unwrap();
    let checkpoint = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),
        "requestId":"report-one","checkpoint":"renderer_ready"});
    assert!(controls
        .checkpoint(&observation(), &checkpoint.to_string())
        .is_err());
    r["requestId"] = "report-task-rebind".into();
    r["tasks"][0]["taskId"] = "00000000-0000-4000-8000-00000000000e".into();
    assert!(controls.report(&r.to_string()).is_err());
    r = complete_report(&f, "report-realm-two");
    r["realmNonce"] = "5".repeat(32).into();
    controls.report(&r.to_string()).unwrap();
    r["requestId"] = "report-realm-three".into();
    r["realmNonce"] = "6".repeat(32).into();
    assert!(controls.report(&r.to_string()).is_err());
    let lines = fs::read_to_string(f.root.join("control/checkpoints.jsonl")).unwrap();
    assert_eq!(lines.lines().count(), 2);
    for line in lines.lines() {
        let value: Value = serde_json::from_str(line).unwrap();
        assert_eq!(value["recordKind"], "driver_attestation");
        assert!(line.len() < 4096);
    }
}
#[test]
fn desktop_acceptance_finish_is_metadata_only_once_and_closes_private_effects() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let observed = observation();
    let (worker, release) = registered_release(&f, &controls, &observed);
    controls
        .report(&complete_report(&f, "complete-ui-attestation").to_string())
        .unwrap();
    let request = finish_value(&f, "finish-one", "complete").to_string();
    let reply = controls.finish(&request, None).unwrap();
    let value = serde_json::to_value(reply).unwrap();
    assert_eq!(value["status"], "finish_requested");
    assert_eq!(value["privateControlsClosed"], true);
    assert_eq!(value["admissionState"], "unverified");
    assert_eq!(value["cleanupState"], "unverified");
    assert_eq!(value["nativeLifecycleHookAttached"], false);
    assert_eq!(value["nativeExitAuthorized"], false);
    assert_eq!(
        serde_json::to_value(controls.finish(&request, None).unwrap()).unwrap(),
        value
    );
    assert!(controls
        .report(&driver_report_value(&f, "late-report").to_string())
        .is_err());
    assert!(controls.release(&observed, &release.to_string()).is_err());
    assert!(!f
        .root
        .join("control")
        .join(format!("{}.release.json", worker.release_nonce))
        .exists());
    let late_checkpoint = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),
        "requestId":"late-checkpoint","checkpoint":"renderer_ready"});
    assert!(controls
        .checkpoint(&observation(), &late_checkpoint.to_string())
        .is_err());
    let observed = observation();
    let owner = observed.owner.unwrap();
    assert!(controls
        .register_identity(
            &observation(),
            owner.origin,
            owner.journal_id,
            owner.binding,
            "b".repeat(64)
        )
        .is_err());
    assert!(controls
        .finish(&finish_value(&f, "finish-two", "failed").to_string(), None)
        .is_err());
    let lines = fs::read_to_string(f.root.join("control/checkpoints.jsonl")).unwrap();
    assert_eq!(lines.lines().count(), 2);
    let terminal: Value = serde_json::from_str(lines.lines().last().unwrap()).unwrap();
    assert_eq!(terminal["nativeHookState"], "unintegrated");
    assert_eq!(terminal["cleanupState"], "unverified");
}
#[test]
fn desktop_acceptance_finish_capacity_is_reserved_after_diagnostic_exhaustion() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    for index in 0..127 {
        let r = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),
            "requestId":format!("ordinary-{index}"),"checkpoint":"renderer_ready"});
        controls.checkpoint(&observation(), &r.to_string()).unwrap();
    }
    assert!(controls
        .report(&driver_report_value(&f, "overflow").to_string())
        .is_err());
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let hook: Arc<driver::FinishHook> = Arc::new(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let raw = finish_value(&f, "reserved-finish", "failed").to_string();
    controls.finish(&raw, Some(hook.clone())).unwrap();
    controls.finish(&raw, Some(hook)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let lines = fs::read_to_string(f.root.join("control/checkpoints.jsonl")).unwrap();
    assert_eq!(lines.lines().count(), 128);
    assert!(lines.len() <= 256 * 1024);
}
#[test]
fn desktop_acceptance_finish_sink_failure_never_reopens_or_repeats_native_hook() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    // A real unusable sink; failure happens after the closure latch/native request.
    fs::create_dir(f.root.join("control/checkpoints.jsonl")).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let controls_in_hook = controls.clone();
    let hook: Arc<driver::FinishHook> = Arc::new(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        // Reentrant control inspection must not deadlock: no sink mutex is held.
        let raw = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),
            "requestId":"inside-hook","checkpoint":"renderer_ready"})
        .to_string();
        assert!(controls_in_hook.checkpoint(&observation(), &raw).is_err());
        Ok(())
    });
    let raw = finish_value(&f, "failed-sink-finish", "failed").to_string();
    assert!(controls.finish(&raw, Some(hook.clone())).is_err());
    fs::remove_dir(f.root.join("control/checkpoints.jsonl")).unwrap();
    assert!(controls.finish(&raw, Some(hook)).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(controls
        .report(&driver_report_value(&f, "after-failure").to_string())
        .is_err());
    assert!(!f.root.join("control/checkpoints.jsonl").exists());
}
#[test]
fn desktop_acceptance_driver_failure_cannot_be_cleared_by_a_later_complete_attestation() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let mut failed = driver_report_value(&f, "first-failure");
    failed["verdict"] = "fail".into();
    failed["errorCode"] = "deadline_exceeded".into();
    controls.report(&failed.to_string()).unwrap();
    controls
        .report(&complete_report(&f, "later-complete").to_string())
        .unwrap();
    assert!(controls
        .finish(
            &finish_value(&f, "invalid-complete", "complete").to_string(),
            None
        )
        .is_err());
    controls
        .finish(
            &finish_value(&f, "valid-failed", "failed").to_string(),
            None,
        )
        .unwrap();
}
#[test]
fn desktop_acceptance_checkpoint_sink_retains_native_started_reply() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let observed = observation();
    let (_, _) = registered_release(&f, &controls, &observed);
    let raw = serde_json::json!({"schemaVersion":1,"sessionId":"3".repeat(32),
        "requestId":"fresh-start-marker","checkpoint":"owner_observed"})
    .to_string();
    let reply = serde_json::to_value(controls.checkpoint(&observed, &raw).unwrap()).unwrap();
    assert_eq!(reply["workerStarted"], true);
    let lines = fs::read_to_string(f.root.join("control/checkpoints.jsonl")).unwrap();
    let saved: Value = serde_json::from_str(lines.lines().last().unwrap()).unwrap();
    assert_eq!(saved["workerStarted"], true);
}

#[test]
fn desktop_acceptance_report_failed_write_retains_domain_digest_and_first_failure() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let mut failed = driver_report_value(&f, "write-failure-report");
    failed["verdict"] = "fail".into();
    failed["errorCode"] = "deadline_exceeded".into();
    controls.readonly_next_report_sink_for_test();
    let original = failed.to_string();
    assert!(controls.report(&original).is_err());
    assert!(controls.report(&original).is_err());
    failed["verdict"] = "pass".into();
    failed["errorCode"] = Value::Null;
    assert!(controls.report(&failed.to_string()).is_err());
    controls
        .report(&complete_report(&f, "after-write-failure").to_string())
        .unwrap();
    assert!(controls
        .finish(
            &finish_value(&f, "cannot-clear-write-failure", "complete").to_string(),
            None
        )
        .is_err());
    controls
        .finish(
            &finish_value(&f, "finish-after-write-failure", "failed").to_string(),
            None,
        )
        .unwrap();
    let lines = fs::read_to_string(f.root.join("control/checkpoints.jsonl")).unwrap();
    assert_eq!(lines.lines().count(), 2); // no retry silently invented a report.
}
#[test]
fn desktop_acceptance_finish_invalid_metadata_and_third_realm_have_no_closure_effect() {
    let f = Fixture::new();
    let controls = f.prepare().unwrap().controls();
    let valid = finish_value(&f, "finish-validation", "failed");
    for (key, value) in [
        ("reason", serde_json::json!("exit_now")),
        ("path", serde_json::json!("/fictional/path")),
        ("pid", serde_json::json!(123)),
        ("buildId", serde_json::json!("0".repeat(64))),
        ("realmNonce", serde_json::json!("bad")),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value;
        assert!(controls.finish(&invalid.to_string(), None).is_err());
    }
    let duplicate = valid.to_string().replace(
        "\"schemaVersion\":1",
        "\"schemaVersion\":1,\"schemaVersion\":1",
    );
    assert!(controls.finish(&duplicate, None).is_err());
    controls
        .report(&driver_report_value(&f, "first-realm").to_string())
        .unwrap();
    let mut second = driver_report_value(&f, "second-realm");
    second["realmNonce"] = "5".repeat(32).into();
    controls.report(&second.to_string()).unwrap();
    let mut third = valid.clone();
    third["realmNonce"] = "6".repeat(32).into();
    assert!(controls.finish(&third.to_string(), None).is_err());
    controls
        .report(&driver_report_value(&f, "still-open").to_string())
        .unwrap();
    controls.finish(&valid.to_string(), None).unwrap();
}
