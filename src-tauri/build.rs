use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const LIMIT: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stamp {
    schema_version: u8,
    mode: String,
    stage: String,
    build_id: String,
    base_commit: String,
    source_inventory_sha256: String,
    target: String,
    enabled_features: Vec<String>,
    signing_policy: String,
    permitted_owned_parent: String,
    effective_config_sha256: String,
    acl_inventory_sha256: String,
    frontend_input_inventory_sha256: String,
    frontend_inventory_sha256: String,
    cargo_lock_sha256: String,
    frontend_lock_sha256: String,
    fixture: Option<Fixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    protocol_version: u8,
    logical_resource: String,
    sha256: String,
    bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    bytes: u64,
    sha256: String,
}

fn check(condition: bool) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err("desktop_proof_invalid".into())
    }
}

fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn canonical(value: &Value) -> Result<Vec<u8>, String> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|key| (key.clone(), sorted(&object[key])))
                        .collect(),
                )
            }
            Value::Array(array) => Value::Array(array.iter().map(sorted).collect()),
            value => value.clone(),
        }
    }
    let mut bytes = serde_json::to_vec(&sorted(value)).map_err(|_| "desktop_proof_invalid")?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn read_json(path: &Path) -> Result<Vec<u8>, String> {
    check(
        fs::symlink_metadata(path)
            .map_err(|_| "desktop_proof_invalid")?
            .file_type()
            .is_file(),
    )?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "desktop_proof_invalid")?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "desktop_proof_invalid")?;
    check(bytes.len() as u64 <= LIMIT)?;
    println!("cargo:rerun-if-changed={}", path.display());
    Ok(bytes)
}

fn file_hash(path: &Path) -> Result<(u64, String), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "desktop_proof_invalid")?;
    check(metadata.file_type().is_file() && metadata.len() <= 4 * 1024_u64.pow(3))?;
    let mut file = fs::File::open(path).map_err(|_| "desktop_proof_invalid")?;
    let mut sha = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "desktop_proof_invalid")?;
        if count == 0 {
            break;
        }
        sha.update(&buffer[..count]);
    }
    println!("cargo:rerun-if-changed={}", path.display());
    Ok((metadata.len(), format!("{:x}", sha.finalize())))
}

fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn merge(base: &mut Value, patch: Value) {
    if let Value::Object(patch) = patch {
        if !base.is_object() {
            *base = json!({});
        }
        let object = base.as_object_mut().expect("object was initialized");
        for (key, value) in patch {
            if value.is_null() {
                object.remove(&key);
            } else {
                merge(object.entry(key).or_insert(Value::Null), value);
            }
        }
    } else {
        *base = patch;
    }
}

fn inventory(
    root: &Path,
    path: &Path,
    expected: &str,
    verify_files: bool,
) -> Result<Vec<Entry>, String> {
    let bytes = read_json(path)?;
    let entries: Vec<Entry> =
        serde_json::from_slice(&bytes).map_err(|_| "desktop_proof_invalid")?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "desktop_proof_invalid")?;
    check(hash(&canonical(&value)?) == expected && !entries.is_empty() && entries.len() <= 1024)?;
    let mut names = BTreeSet::new();
    let mut previous = "";
    for entry in &entries {
        check(
            !entry.path.is_empty()
                && entry.path.len() <= 512
                && !entry.path.contains(['\\', ':'])
                && !entry.path.starts_with('/')
                && entry.path.split('/').all(|p| !matches!(p, "" | "." | ".."))
                && entry.path.as_str() > previous
                && names.insert(entry.path.to_lowercase())
                && hex(&entry.sha256, 64)
                && entry.bytes <= 4 * 1024_u64.pow(3),
        )?;
        previous = &entry.path;
        if verify_files {
            let mut current = root.to_path_buf();
            for component in entry.path.split('/') {
                current.push(component);
                check(
                    !fs::symlink_metadata(&current)
                        .map_err(|_| "desktop_proof_invalid")?
                        .file_type()
                        .is_symlink(),
                )?;
            }
            check(
                current
                    .canonicalize()
                    .map_err(|_| "desktop_proof_invalid")?
                    .starts_with(root),
            )?;
            check(file_hash(&current)? == (entry.bytes, entry.sha256.clone()))?;
        }
    }
    Ok(entries)
}

fn names(
    root: &Path,
    directory: &Path,
    source: bool,
    result: &mut BTreeSet<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|_| "desktop_proof_invalid")? {
        let entry = entry.map_err(|_| "desktop_proof_invalid")?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = entry.file_type().map_err(|_| "desktop_proof_invalid")?;
        if source
            && kind.is_dir()
            && matches!(
                name.as_str(),
                "target"
                    | "node_modules"
                    | "out"
                    | ".next"
                    | "__pycache__"
                    | "binaries"
                    | "gen"
                    | ".venv"
            )
        {
            continue;
        }
        if source
            && (matches!(name.as_str(), "next-env.d.ts" | ".eslintcache")
                || name.ends_with(".pyc")
                || name.ends_with(".DS_Store")
                || name.ends_with(".tsbuildinfo"))
        {
            continue;
        }
        check(!kind.is_symlink())?;
        if kind.is_dir() {
            names(root, &path, source, result)?;
        } else {
            check(kind.is_file())?;
            result.insert(
                path.strip_prefix(root)
                    .map_err(|_| "desktop_proof_invalid")?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            check(result.len() <= 1024)?;
        }
    }
    Ok(())
}

fn shared_frontend_directory(path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("desktop_proof_invalid".into()),
    };
    check(metadata.is_dir() && !metadata.file_type().is_symlink())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        check(metadata.file_attributes() & 0x400 == 0)?;
    }
    Ok(true)
}

fn source_names(repo: &Path) -> Result<BTreeSet<String>, String> {
    let mut result = BTreeSet::new();
    for prefix in [
        "src-tauri",
        "frontend",
        "scripts",
        "tradingagents",
        ".github/workflows",
    ] {
        let directory = repo.join(prefix);
        if directory.exists() {
            names(repo, &directory, true, &mut result)?;
        }
    }
    for prefix in ["docs/contracts", "tests/fixtures"] {
        let directory = repo.join(prefix);
        let parent = directory.parent().ok_or("desktop_proof_invalid")?;
        if !shared_frontend_directory(parent)? || !shared_frontend_directory(&directory)? {
            continue;
        }
        names(repo, &directory, false, &mut result)?;
    }
    for name in [
        "pyproject.toml",
        "uv.lock",
        "LICENSE",
        "NOTICE",
        "THIRD_PARTY_NOTICES.md",
    ] {
        if repo.join(name).exists() {
            result.insert(name.into());
        }
    }
    Ok(result)
}

fn run() -> Result<(), String> {
    let feature = cfg!(feature = "desktop-acceptance");
    check(feature == std::env::var_os("CARGO_FEATURE_DESKTOP_ACCEPTANCE").is_some())?;
    let target = std::env::var("TARGET").map_err(|_| "desktop_proof_invalid")?;
    let manifest =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").ok_or("desktop_proof_invalid")?)
            .canonicalize()
            .map_err(|_| "desktop_proof_invalid")?;
    let repo = manifest.parent().ok_or("desktop_proof_invalid")?;
    let out = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("desktop_proof_invalid")?);
    for variable in [
        "EVIDENCELOOM_DESKTOP_BUILD_STAMP",
        "TAURI_CONFIG",
        "CARGO_FEATURE_DESKTOP_ACCEPTANCE",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    println!("cargo:rustc-env=EVIDENCELOOM_DESKTOP_TARGET={target}");
    let (mut config, paths) = tauri_utils::config::parse::read_from(
        tauri_utils::platform::Target::from_triple(&target),
        &manifest,
    )
    .map_err(|_| "desktop_proof_invalid")?;
    for path in paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    if let Ok(overlay) = std::env::var("TAURI_CONFIG") {
        merge(
            &mut config,
            serde_json::from_str(&overlay).map_err(|_| "desktop_proof_invalid")?,
        );
    }
    let typed: tauri_utils::config::Config =
        serde_json::from_value(config.clone()).map_err(|_| "desktop_proof_invalid")?;
    let typed_value = serde_json::to_value(typed).map_err(|_| "desktop_proof_invalid")?;
    fs::write(
        out.join("desktop-effective-config.json"),
        canonical(&typed_value)?,
    )
    .map_err(|_| "desktop_proof_invalid")?;
    let input = std::env::var_os("EVIDENCELOOM_DESKTOP_BUILD_STAMP");
    let bytes = if let Some(input) = input {
        let path = PathBuf::from(input);
        let bytes = read_json(&path)?;
        let stamp: Stamp = serde_json::from_slice(&bytes).map_err(|_| "desktop_proof_invalid")?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "desktop_proof_invalid")?;
        check(canonical(&value)? == bytes)?;
        check(
            stamp.schema_version == 1
                && stamp.target == target
                && hex(&stamp.base_commit, 40)
                && stamp.mode == if feature { "acceptance" } else { "shipping" }
                && stamp.enabled_features
                    == if feature {
                        vec!["desktop-acceptance"]
                    } else {
                        vec![]
                    }
                && matches!(stamp.stage.as_str(), "fixture-only" | "app")
                && stamp.signing_policy == if feature { "unsigned" } else { "platform" },
        )?;
        check(feature || stamp.stage == "app")?;
        for digest in [
            &stamp.build_id,
            &stamp.source_inventory_sha256,
            &stamp.effective_config_sha256,
            &stamp.acl_inventory_sha256,
            &stamp.frontend_input_inventory_sha256,
            &stamp.frontend_inventory_sha256,
            &stamp.cargo_lock_sha256,
            &stamp.frontend_lock_sha256,
        ] {
            check(hex(digest, 64))?;
        }
        let mut identity = value.clone();
        identity
            .as_object_mut()
            .ok_or("desktop_proof_invalid")?
            .remove("buildId");
        identity
            .as_object_mut()
            .ok_or("desktop_proof_invalid")?
            .remove("frontendInventorySha256");
        check(
            hash(&canonical(&identity)?) == stamp.build_id
                && hash(&canonical(&typed_value)?) == stamp.effective_config_sha256,
        )?;
        check(
            file_hash(&manifest.join("Cargo.lock"))?.1 == stamp.cargo_lock_sha256
                && file_hash(&repo.join("frontend/package-lock.json"))?.1
                    == stamp.frontend_lock_sha256,
        )?;
        let parent = path.parent().ok_or("desktop_proof_invalid")?;
        let source = inventory(
            repo,
            &parent.join("source-inventory.json"),
            &stamp.source_inventory_sha256,
            true,
        )?;
        check(
            source
                .iter()
                .map(|e| e.path.clone())
                .collect::<BTreeSet<_>>()
                == source_names(repo)?,
        )?;
        let acl = inventory(
            repo,
            &parent.join("acl-inventory.json"),
            &stamp.acl_inventory_sha256,
            true,
        )?;
        let acceptance_app = feature && stamp.stage == "app";
        let expected_acl = if acceptance_app {
            BTreeSet::from([
                "src-tauri/acceptance/capability.json".to_string(),
                "src-tauri/acceptance/permissions/default.toml".to_string(),
            ])
        } else {
            let mut result = BTreeSet::new();
            names(repo, &manifest.join("capabilities"), false, &mut result)?;
            if manifest.join("permissions").exists() {
                names(repo, &manifest.join("permissions"), false, &mut result)?;
            }
            result
        };
        check(acl.iter().map(|e| e.path.clone()).collect::<BTreeSet<_>>() == expected_acl)?;
        if acceptance_app {
            let fixture = stamp.fixture.as_ref().ok_or("desktop_proof_invalid")?;
            check(
                fixture.protocol_version == 1
                    && fixture.logical_resource == "evidenceloom-desktop-fixture"
                    && fixture.bytes > 0
                    && fixture.bytes <= 256 * 1024_u64.pow(2)
                    && hex(&fixture.sha256, 64),
            )?;
            let suffix = if target.contains("windows") {
                ".exe"
            } else {
                ""
            };
            check(
                file_hash(&parent.join(format!("evidenceloom-desktop-fixture{suffix}")))?
                    == (fixture.bytes, fixture.sha256.clone()),
            )?;
            let permitted = PathBuf::from(&stamp.permitted_owned_parent);
            check(
                permitted.is_absolute()
                    && permitted
                        .canonicalize()
                        .map_err(|_| "desktop_proof_invalid")?
                        == permitted,
            )?;
            check(
                config["identifier"] == "io.github.simonguo.evidenceloom.acceptance"
                    && config["productName"] == "Evidence Loom Acceptance"
                    && config["build"].get("devUrl").is_none()
                    && [
                        "beforeDevCommand",
                        "beforeBuildCommand",
                        "beforeBundleCommand",
                    ]
                    .iter()
                    .all(|key| config["build"].get(key).is_none())
                    && config["bundle"].get("externalBin").is_none()
                    && config["bundle"].get("resources").is_none()
                    && config["bundle"]["active"] == false
                    && config["app"]["security"]["capabilities"] == json!(["desktop-acceptance"]),
            )?;
            let windows = config["app"]["windows"]
                .as_array()
                .ok_or("desktop_proof_invalid")?;
            check(
                windows.len() == 1
                    && windows[0]["label"] == "main"
                    && windows[0]["create"] == false,
            )?;
            check(config["bundle"].get("macOS").is_none() && config.get("plugins").is_none())?;
        } else {
            check(stamp.fixture.is_none())?;
        }
        if stamp.stage == "app" {
            let frontend_path = PathBuf::from(
                config["build"]["frontendDist"]
                    .as_str()
                    .ok_or("desktop_proof_invalid")?,
            );
            let frontend = if frontend_path.is_absolute() {
                frontend_path
            } else {
                manifest.join(frontend_path)
            }
            .canonicalize()
            .map_err(|_| "desktop_proof_invalid")?;
            let entries = inventory(
                &frontend,
                &parent.join("frontend-inventory.json"),
                &stamp.frontend_inventory_sha256,
                true,
            )?;
            let mut actual_names = BTreeSet::new();
            names(&frontend, &frontend, false, &mut actual_names)?;
            check(
                entries
                    .iter()
                    .map(|e| e.path.clone())
                    .collect::<BTreeSet<_>>()
                    == actual_names,
            )?;
            inventory(
                &frontend,
                &parent.join("frontend-input-inventory.json"),
                &stamp.frontend_input_inventory_sha256,
                !acceptance_app,
            )?;
            if acceptance_app {
                let asset = read_json(&frontend.join("desktop-acceptance-build.json"))?;
                let asset: Value =
                    serde_json::from_slice(&asset).map_err(|_| "desktop_proof_invalid")?;
                check(asset == json!({"schemaVersion": 1, "buildId": stamp.build_id}))?;
            } else {
                check(
                    config["identifier"] == "io.github.simonguo.evidenceloom"
                        && config["bundle"]["externalBin"]
                            == json!(["binaries/evidenceloom-runner"])
                        && config["build"]["frontendDist"] == "../frontend/out"
                        && !canonical(&config)?
                            .windows(b"desktop-acceptance".len())
                            .any(|w| w == b"desktop-acceptance")
                        && entries.iter().all(|e| {
                            !e.path.contains("desktop-acceptance")
                                && !e.path.contains("evidenceloom-desktop-fixture")
                        }),
                )?;
                let input = read_json(&parent.join("sidecar-input.json"))?;
                let input: Value =
                    serde_json::from_slice(&input).map_err(|_| "desktop_proof_invalid")?;
                check(
                    input["mode"] == "shipping"
                        && input["stage"] == "sidecar-input"
                        && input["producer"] == "normal-sidecar-build-v1"
                        && input["target"] == target
                        && input["sourceInventorySha256"] == stamp.source_inventory_sha256
                        && input["completion"]["buildExitCode"] == 0
                        && input["completion"]["probeExitCode"] == 0
                        && input["completion"]["sourceBeforeSha256"]
                            == stamp.source_inventory_sha256
                        && input["completion"]["sourceAfterSha256"]
                            == stamp.source_inventory_sha256,
                )?;
                let suffix = if target.contains("windows") {
                    ".exe"
                } else {
                    ""
                };
                let runner = file_hash(
                    &manifest.join(format!("binaries/evidenceloom-runner-{target}{suffix}")),
                )?;
                check(
                    input["sidecar"]["logicalResource"] == "evidenceloom-runner"
                        && input["sidecar"]["bytes"].as_u64() == Some(runner.0)
                        && input["sidecar"]["sha256"] == runner.1,
                )?;
            }
        }
        bytes
    } else {
        canonical(
            &json!({"schemaVersion": 1, "mode": if feature { "acceptance" } else { "shipping" },
            "stage": "compile-only", "buildId": "0".repeat(64), "baseCommit": "0".repeat(40),
            "sourceInventorySha256": "0".repeat(64), "target": target,
            "enabledFeatures": if feature { vec!["desktop-acceptance"] } else { vec![] }, "signingPolicy": "unsigned",
            "permittedOwnedParent": "", "effectiveConfigSha256": "0".repeat(64), "aclInventorySha256": "0".repeat(64),
            "frontendInputInventorySha256": "0".repeat(64), "frontendInventorySha256": "0".repeat(64),
            "cargoLockSha256": "0".repeat(64), "frontendLockSha256": "0".repeat(64), "fixture": null}),
        )?
    };
    fs::File::create(out.join("desktop-build-stamp.json"))
        .map_err(|_| "desktop_proof_invalid")?
        .write_all(&bytes)
        .map_err(|_| "desktop_proof_invalid")?;
    let stamp: Stamp = serde_json::from_slice(&bytes).map_err(|_| "desktop_proof_invalid")?;
    let attributes = if feature && stamp.stage == "app" {
        tauri_build::Attributes::new()
            .capabilities_path_pattern("acceptance/capability.json")
            .plugin(
                "desktop-acceptance",
                tauri_build::InlinedPlugin::new()
                    .commands(&["checkpoint", "release_worker"])
                    .permissions_path_pattern("acceptance/permissions/*.toml"),
            )
    } else {
        tauri_build::Attributes::new()
    };
    println!("cargo:rerun-if-changed=acceptance");
    tauri_build::try_build(attributes).map_err(|_| "desktop_proof_invalid".into())
}

fn main() {
    if run().is_err() {
        panic!("desktop_proof_invalid");
    }
}
