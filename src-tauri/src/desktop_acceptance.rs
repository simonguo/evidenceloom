//! Non-default acceptance boundary. Preparation precedes every Builder/plugin.
//! It proves selected research/credential paths, not whole-OS isolation.
use crate::analysis_recovery::parser;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::Runtime;

pub(crate) mod control;
pub(crate) mod driver;
pub(crate) mod lifecycle;
pub(crate) mod tasks;
const STAMP: &str = include_str!(concat!(env!("OUT_DIR"), "/desktop-build-stamp.json"));
const EFFECTIVE_CONFIG: &str =
    include_str!(concat!(env!("OUT_DIR"), "/desktop-effective-config.json"));
const COMPILED_TARGET: &str = env!("EVIDENCELOOM_DESKTOP_TARGET");
const MANIFEST_LIMIT: usize = 64 * 1024;
const STAMP_LIMIT: usize = 1024 * 1024;
const FIXTURE_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcceptanceError {
    pub code: &'static str,
    pub message: &'static str,
}
impl AcceptanceError {
    pub(crate) fn fixed(code: &'static str) -> Self {
        let message = match code {
            "acceptance_manifest_invalid" => "Acceptance manifest is invalid.",
            "acceptance_stage_invalid" => "Acceptance build stage is unavailable.",
            "acceptance_build_mismatch" => "Acceptance build identity does not match.",
            "acceptance_config_invalid" => "Acceptance application configuration is invalid.",
            "acceptance_path_invalid" => "Acceptance owned paths are invalid.",
            "acceptance_environment_invalid" => "Acceptance environment is unavailable.",
            "acceptance_runner_invalid" => "Acceptance fixture runner is invalid.",
            "acceptance_control_invalid" => "Acceptance control request is invalid.",
            "acceptance_finish_pending" => "Acceptance finish request is pending.",
            "acceptance_finish_failed" => "Acceptance finish request could not be recorded.",
            _ => "Desktop build proof is invalid.",
        };
        Self { code, message }
    }
}
impl std::fmt::Display for AcceptanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for AcceptanceError {}
fn error(code: &'static str) -> AcceptanceError {
    AcceptanceError::fixed(code)
}
fn ensure(ok: bool, code: &'static str) -> Result<(), AcceptanceError> {
    if ok {
        Ok(())
    } else {
        Err(error(code))
    }
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn strict<T: serde::de::DeserializeOwned>(
    raw: &str,
    limit: usize,
    code: &'static str,
) -> Result<T, AcceptanceError> {
    let value = parser::raw_json(raw, limit).map_err(|_| error(code))?;
    serde_json::from_value(value).map_err(|_| error(code))
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureStamp {
    protocol_version: u8,
    logical_resource: String,
    sha256: String,
    bytes: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuildStamp {
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
    fixture: Option<FixtureStamp>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchManifest {
    schema_version: u8,
    mode: String,
    session_id: String,
    owned_root: String,
    build_id: String,
    compiled_stamp_sha256: String,
    target: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerMarker {
    schema_version: u8,
    session_id: String,
    build_id: String,
}

/// No primitive-path constructor or deserialization. Only validated preparation
/// can create this capability and activate the feature environment.
pub(crate) struct PreparedAcceptance {
    root: PathBuf,
    runner: PathBuf,
    session_id: String,
    compiled_stamp_sha256: String,
    stamp: BuildStamp,
    controls: Arc<control::ControlState>,
}
impl PreparedAcceptance {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn lifecycle_identity(&self) -> (String, String) {
        (self.session_id.clone(), self.stamp.build_id.clone())
    }
    pub(crate) fn runner(&self) -> &Path {
        &self.runner
    }
    pub(crate) fn controls(&self) -> Arc<control::ControlState> {
        self.controls.clone()
    }
    pub(crate) fn recheck(&self) -> Result<(), AcceptanceError> {
        checked_directory(&self.root)?;
        for name in ["data", "work", "temp", "webview-profile", "control"] {
            checked_directory(&self.root.join(name))?;
        }
        let marker: OwnerMarker = strict(
            &read_regular(
                &self.root.join(".desktop-acceptance-owner.json"),
                MANIFEST_LIMIT,
            )?,
            MANIFEST_LIMIT,
            "acceptance_path_invalid",
        )?;
        ensure(
            marker.schema_version == 1
                && marker.session_id == self.session_id
                && marker.build_id == self.stamp.build_id,
            "acceptance_path_invalid",
        )?;
        verify_runner(
            &self.runner,
            self.stamp
                .fixture
                .as_ref()
                .ok_or_else(|| error("acceptance_runner_invalid"))?,
        )
    }
    fn bootstrap_script(&self) -> Result<String, AcceptanceError> {
        driver::initialization_script(
            &self.session_id,
            &self.stamp.build_id,
            &self.compiled_stamp_sha256,
            &self.stamp.target,
        )
    }
    pub(crate) fn create_window<R: Runtime>(
        &self,
        app: &tauri::App<R>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.recheck()?;
        let config = app
            .config()
            .app
            .windows
            .first()
            .ok_or_else(|| error("acceptance_config_invalid"))?;
        let window = tauri::WebviewWindowBuilder::from_config(app, config)?
            .initialization_script(self.bootstrap_script()?);
        #[cfg(target_os = "macos")]
        let window = window.incognito(true);
        #[cfg(not(target_os = "macos"))]
        let window = window
            .data_directory(self.root.join("webview-profile"))
            .incognito(true);
        window.build()?;
        Ok(())
    }
}
fn checked_directory(path: &Path) -> Result<(), AcceptanceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error("acceptance_path_invalid"))?;
    ensure(
        !metadata.file_type().is_symlink() && metadata.is_dir() && path.is_absolute(),
        "acceptance_path_invalid",
    )
}
fn checked_inside(path: &Path, parent: &Path, directory: bool) -> Result<PathBuf, AcceptanceError> {
    ensure(path.is_absolute(), "acceptance_path_invalid")?;
    let actual = path
        .canonicalize()
        .map_err(|_| error("acceptance_path_invalid"))?;
    ensure(
        actual != parent && actual.starts_with(parent),
        "acceptance_path_invalid",
    )?;
    // Check caller components below the permitted physical parent, allowing OS
    // canonical representation changes (e.g. Windows extended path prefixes).
    let mut current = path;
    loop {
        if current
            .canonicalize()
            .map_err(|_| error("acceptance_path_invalid"))?
            == parent
        {
            break;
        }
        let meta = fs::symlink_metadata(current).map_err(|_| error("acceptance_path_invalid"))?;
        ensure(!meta.file_type().is_symlink(), "acceptance_path_invalid")?;
        current = current
            .parent()
            .ok_or_else(|| error("acceptance_path_invalid"))?;
    }
    let meta = fs::symlink_metadata(&actual).map_err(|_| error("acceptance_path_invalid"))?;
    ensure(
        if directory {
            meta.is_dir()
        } else {
            meta.is_file()
        },
        "acceptance_path_invalid",
    )?;
    Ok(actual)
}
fn read_regular(path: &Path, limit: usize) -> Result<String, AcceptanceError> {
    let meta = fs::symlink_metadata(path).map_err(|_| error("acceptance_path_invalid"))?;
    ensure(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= limit as u64,
        "acceptance_path_invalid",
    )?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| error("acceptance_path_invalid"))?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("acceptance_path_invalid"))?;
    ensure(bytes.len() <= limit, "acceptance_path_invalid")?;
    String::from_utf8(bytes).map_err(|_| error("acceptance_manifest_invalid"))
}
fn validate_stamp(raw: &str, target: &str) -> Result<BuildStamp, AcceptanceError> {
    let value =
        parser::raw_json(raw, STAMP_LIMIT).map_err(|_| error("acceptance_build_mismatch"))?;
    parser::exact(
        &value,
        &[
            "schemaVersion",
            "mode",
            "stage",
            "buildId",
            "baseCommit",
            "sourceInventorySha256",
            "target",
            "enabledFeatures",
            "signingPolicy",
            "permittedOwnedParent",
            "effectiveConfigSha256",
            "aclInventorySha256",
            "frontendInputInventorySha256",
            "frontendInventorySha256",
            "cargoLockSha256",
            "frontendLockSha256",
            "fixture",
        ],
    )
    .map_err(|_| error("acceptance_build_mismatch"))?;
    let stamp: BuildStamp =
        serde_json::from_value(value.clone()).map_err(|_| error("acceptance_build_mismatch"))?;
    ensure(
        stamp.schema_version == 1 && stamp.mode == "acceptance" && stamp.stage == "app",
        "acceptance_stage_invalid",
    )?;
    ensure(
        stamp.target == target
            && matches!(
                target,
                "aarch64-apple-darwin" | "x86_64-apple-darwin" | "x86_64-pc-windows-msvc"
            )
            && stamp.enabled_features == ["desktop-acceptance"]
            && stamp.signing_policy == "unsigned",
        "acceptance_build_mismatch",
    )?;
    ensure(
        hex(&stamp.base_commit, 40)
            && [
                &stamp.build_id,
                &stamp.source_inventory_sha256,
                &stamp.effective_config_sha256,
                &stamp.acl_inventory_sha256,
                &stamp.frontend_input_inventory_sha256,
                &stamp.frontend_inventory_sha256,
                &stamp.cargo_lock_sha256,
                &stamp.frontend_lock_sha256,
            ]
            .iter()
            .all(|v| hex(v, 64)),
        "acceptance_build_mismatch",
    )?;
    let fixture = stamp
        .fixture
        .as_ref()
        .ok_or_else(|| error("acceptance_runner_invalid"))?;
    ensure(
        fixture.protocol_version == 1
            && fixture.logical_resource == "evidenceloom-desktop-fixture"
            && hex(&fixture.sha256, 64)
            && fixture.bytes > 0
            && fixture.bytes <= FIXTURE_LIMIT,
        "acceptance_runner_invalid",
    )?;
    let mut identity = value;
    identity
        .as_object_mut()
        .ok_or_else(|| error("acceptance_build_mismatch"))?
        .remove("buildId");
    identity
        .as_object_mut()
        .ok_or_else(|| error("acceptance_build_mismatch"))?
        .remove("frontendInventorySha256");
    let canonical = crate::research_memory::canonical_json(&identity)
        .map_err(|_| error("acceptance_build_mismatch"))?;
    ensure(
        sha256(format!("{canonical}\n").as_bytes()) == stamp.build_id,
        "acceptance_build_mismatch",
    )?;
    Ok(stamp)
}
fn verify_runner(path: &Path, fixture: &FixtureStamp) -> Result<(), AcceptanceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error("acceptance_runner_invalid"))?;
    ensure(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() == fixture.bytes
            && metadata.len() <= FIXTURE_LIMIT,
        "acceptance_runner_invalid",
    )?;
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(path).map_err(|_| error("acceptance_runner_invalid"))?;
    let mut buffer = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| error("acceptance_runner_invalid"))?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .ok_or_else(|| error("acceptance_runner_invalid"))?;
        ensure(total <= FIXTURE_LIMIT, "acceptance_runner_invalid")?;
        hasher.update(&buffer[..n]);
    }
    ensure(
        total == fixture.bytes && format!("{:x}", hasher.finalize()) == fixture.sha256,
        "acceptance_runner_invalid",
    )
}
fn validate_config(config: &tauri::Config) -> Result<(), AcceptanceError> {
    let json = serde_json::to_value(config).map_err(|_| error("acceptance_config_invalid"))?;
    ensure(
        config.identifier == "io.github.simonguo.evidenceloom.acceptance"
            && config.product_name.as_deref() == Some("Evidence Loom Acceptance")
            && config.build.dev_url.is_none()
            && config.build.before_dev_command.is_none()
            && config.build.before_build_command.is_none()
            && config.build.before_bundle_command.is_none()
            && !config.bundle.active
            && config
                .bundle
                .external_bin
                .as_ref()
                .is_none_or(Vec::is_empty)
            && json.pointer("/bundle/resources").is_none_or(|v| {
                v.is_null()
                    || v.as_object().is_some_and(|m| m.is_empty())
                    || v.as_array().is_some_and(Vec::is_empty)
            })
            && config.app.windows.len() == 1
            && config.app.windows[0].label == "main"
            && !config.app.windows[0].create
            && matches!(&config.app.windows[0].url, tauri::WebviewUrl::App(path) if path == Path::new("index.html")),
        "acceptance_config_invalid",
    )?;
    ensure(
        json.pointer("/app/security/capabilities")
            == Some(&serde_json::json!(["desktop-acceptance"])),
        "acceptance_config_invalid",
    )
}
fn prepare_paths(
    stamp: BuildStamp,
    stamp_hash: &str,
    manifest_path: &Path,
    runner: PathBuf,
) -> Result<PreparedAcceptance, AcceptanceError> {
    let parent_input = PathBuf::from(&stamp.permitted_owned_parent);
    checked_directory(&parent_input)?;
    let parent = parent_input
        .canonicalize()
        .map_err(|_| error("acceptance_path_invalid"))?;
    ensure(
        stamp.permitted_owned_parent.len() <= 4096,
        "acceptance_path_invalid",
    )?;
    let manifest_path = checked_inside(manifest_path, &parent, false)?;
    let manifest: LaunchManifest = strict(
        &read_regular(&manifest_path, MANIFEST_LIMIT)?,
        MANIFEST_LIMIT,
        "acceptance_manifest_invalid",
    )?;
    ensure(
        manifest.schema_version == 1
            && manifest.mode == "acceptance"
            && hex(&manifest.session_id, 32)
            && manifest.owned_root.len() <= 4096
            && manifest.target.is_ascii()
            && manifest.target.len() <= 128,
        "acceptance_manifest_invalid",
    )?;
    ensure(
        manifest.build_id == stamp.build_id
            && manifest.compiled_stamp_sha256 == stamp_hash
            && manifest.target == stamp.target,
        "acceptance_build_mismatch",
    )?;
    let root = checked_inside(Path::new(&manifest.owned_root), &parent, true)?;
    let marker: OwnerMarker = strict(
        &read_regular(&root.join(".desktop-acceptance-owner.json"), MANIFEST_LIMIT)?,
        MANIFEST_LIMIT,
        "acceptance_path_invalid",
    )?;
    ensure(
        marker.schema_version == 1
            && marker.session_id == manifest.session_id
            && marker.build_id == stamp.build_id,
        "acceptance_path_invalid",
    )?;
    verify_runner(
        &runner,
        stamp
            .fixture
            .as_ref()
            .ok_or_else(|| error("acceptance_runner_invalid"))?,
    )?;
    // Reject pre-existing application state, even an empty directory. Never scan
    // legacy candidates or repair an existing user/profile path.
    for name in ["data", "work", "temp", "webview-profile", "control"] {
        fs::create_dir(root.join(name)).map_err(|_| error("acceptance_path_invalid"))?;
        checked_directory(&root.join(name))?;
    }
    let controls = Arc::new(control::ControlState::new(
        root.join("control"),
        manifest.session_id.clone(),
        stamp.build_id.clone(),
    ));
    Ok(PreparedAcceptance {
        root,
        runner,
        session_id: manifest.session_id,
        compiled_stamp_sha256: stamp_hash.into(),
        stamp,
        controls,
    })
}
fn expected_runtime_config() -> tauri::Config {
    // Generated from the same full typed configuration as EFFECTIVE_CONFIG,
    // using the locked SDK's ToTokens implementation rather than field copies.
    include!(concat!(env!("OUT_DIR"), "/desktop-runtime-config.rs"))
}
fn verify_config_identity(
    actual: &tauri::Config,
    expected_runtime: &tauri::Config,
    full_typed_raw: &str,
    full_typed_sha256: &str,
) -> Result<(), AcceptanceError> {
    ensure(
        full_typed_raw.len() <= STAMP_LIMIT
            && sha256(full_typed_raw.as_bytes()) == full_typed_sha256,
        "acceptance_config_invalid",
    )?;
    let actual = serde_json::to_value(actual).map_err(|_| error("acceptance_config_invalid"))?;
    let expected =
        serde_json::to_value(expected_runtime).map_err(|_| error("acceptance_config_invalid"))?;
    let actual = crate::research_memory::canonical_json(&actual)
        .map_err(|_| error("acceptance_config_invalid"))?;
    let expected = crate::research_memory::canonical_json(&expected)
        .map_err(|_| error("acceptance_config_invalid"))?;
    ensure(actual == expected, "acceptance_config_invalid")
}
pub(crate) fn prepare<R: Runtime>(
    context: &mut tauri::Context<R>,
) -> Result<PreparedAcceptance, AcceptanceError> {
    let stamp = validate_stamp(STAMP, COMPILED_TARGET)?;
    validate_config(context.config())?;
    verify_config_identity(
        context.config(),
        &expected_runtime_config(),
        EFFECTIVE_CONFIG,
        &stamp.effective_config_sha256,
    )?;
    let asset = context
        .assets()
        .get(&"desktop-acceptance-build.json".into())
        .ok_or_else(|| error("acceptance_build_mismatch"))?;
    let asset: Value = strict(
        std::str::from_utf8(&asset).map_err(|_| error("acceptance_build_mismatch"))?,
        MANIFEST_LIMIT,
        "acceptance_build_mismatch",
    )?;
    ensure(
        asset == serde_json::json!({"schemaVersion":1,"buildId":stamp.build_id}),
        "acceptance_build_mismatch",
    )?;
    let remote = tauri::ipc::Origin::Remote {
        url: tauri::Url::parse("https://acceptance-invalid.example")
            .map_err(|_| error("acceptance_config_invalid"))?,
    };
    for command in driver::PRIVATE_COMMANDS {
        let key = format!("plugin:desktop-acceptance|{command}");
        let authority = context.runtime_authority_mut();
        ensure(
            authority
                .resolve_access(&key, "main", "main", &tauri::ipc::Origin::Local)
                .is_some()
                && authority
                    .resolve_access(&key, "other", "other", &tauri::ipc::Origin::Local)
                    .is_none()
                && authority
                    .resolve_access(&key, "main", "main", &remote)
                    .is_none(),
            "acceptance_config_invalid",
        )?;
    }
    let manifest = std::env::var_os("EVIDENCELOOM_DESKTOP_ACCEPTANCE_MANIFEST")
        .ok_or_else(|| error("acceptance_manifest_invalid"))?;
    let executable = std::env::current_exe().map_err(|_| error("acceptance_runner_invalid"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| error("acceptance_runner_invalid"))?;
    #[cfg(target_os = "macos")]
    let resources = directory
        .parent()
        .ok_or_else(|| error("acceptance_runner_invalid"))?
        .join("Resources");
    #[cfg(not(target_os = "macos"))]
    let resources = directory.join("resources");
    checked_directory(&resources)?;
    let resources = resources
        .canonicalize()
        .map_err(|_| error("acceptance_runner_invalid"))?;
    let filename = if cfg!(windows) {
        "evidenceloom-desktop-fixture.exe"
    } else {
        "evidenceloom-desktop-fixture"
    };
    prepare_paths(
        stamp,
        &sha256(STAMP.as_bytes()),
        Path::new(&manifest),
        resources.join(filename),
    )
}
pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    control::plugin()
}

#[cfg(test)]
#[path = "desktop_acceptance/tests.rs"]
mod tests;
