mod analysis_execution;
mod analysis_recovery;
mod application_environment;
mod effective_request_identity;
mod effective_request_identity_storage;
mod evidence;
mod numeric_review;
mod numeric_review_storage;
mod output_quality;
mod owned_process;
mod research_memory;
mod research_memory_inventory;
mod research_memory_storage;
mod research_readiness;
mod research_readiness_storage;
mod runtime_probe;
mod secrets;
mod storage;

use application_environment::ApplicationEnvironment;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::{Map, Value};
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};
#[cfg(test)]
use std::{
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct AppState {
    runtime: Arc<RuntimeState>,
    recovery: Arc<analysis_recovery::runtime::Coordinator>,
}
impl Default for AppState {
    fn default() -> Self {
        let runtime = Arc::new(RuntimeState::default());
        Self {
            recovery: Arc::new(analysis_recovery::runtime::Coordinator::new(
                runtime.clone(),
            )),
            runtime,
        }
    }
}

type RuntimeState = analysis_execution::Registry;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    kind: &'static str,
    label: &'static str,
    repo_root: String,
    configured_project_root: Option<String>,
    python_path: String,
    runner_path: String,
    sidecar_path: Option<String>,
    runner_mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCheck {
    kind: &'static str,
    ok: bool,
    repo_root: String,
    configured_project_root: Option<String>,
    python_path: String,
    runner_path: String,
    sidecar_path: Option<String>,
    runner_mode: String,
    python_exists: bool,
    runner_exists: bool,
    python_version: Option<String>,
    can_import_trading_agents: bool,
    import_error: Option<String>,
    sidecar_real: bool,
    errors: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OhlcvBar {
    time: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextExportResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

#[tauri::command]
async fn load_desktop_data(
    app: AppHandle,
) -> Result<storage::DesktopSnapshot, storage::StorageError> {
    storage_blocking(move || storage::load_snapshot(&app)).await
}

#[tauri::command]
async fn save_desktop_settings(
    app: AppHandle,
    settings: storage::StoredSettings,
) -> Result<(), storage::StorageError> {
    storage_blocking(move || {
        storage::save_settings(&app, settings).map_err(storage::StorageError::unavailable)
    })
    .await
}

#[tauri::command]
fn set_provider_secret(app: AppHandle, provider: String, value: String) -> Result<(), String> {
    ApplicationEnvironment::selected(&app).set_provider_secret(&provider, &value)
}

#[tauri::command]
fn delete_provider_secret(app: AppHandle, provider: String) -> Result<(), String> {
    ApplicationEnvironment::selected(&app).delete_provider_secret(&provider)
}

#[tauri::command]
fn set_alpha_vantage_secret(app: AppHandle, provider: String, value: String) -> Result<(), String> {
    let _ = provider;
    ApplicationEnvironment::selected(&app).set_alpha_secret(&value)
}

#[tauri::command]
fn delete_alpha_vantage_secret(app: AppHandle, provider: String) -> Result<(), String> {
    let _ = provider;
    ApplicationEnvironment::selected(&app).delete_alpha_secret()
}

async fn storage_blocking<T, F>(work: F) -> Result<T, storage::StorageError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, storage::StorageError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            storage::StorageError::new(
                "storage_unknown_outcome",
                "Native task-store operation did not return a confirmed outcome.",
            )
        })?
}

#[tauri::command]
async fn save_desktop_task(
    app: AppHandle,
    request: Value,
) -> Result<storage::MutationReply, storage::StorageError> {
    storage_blocking(move || storage::save_task(&app, request)).await
}

fn guarded_task_removal(
    app: &AppHandle,
    runtime: &RuntimeState,
    recovery: &Arc<analysis_recovery::runtime::Coordinator>,
    request: Value,
    clear: bool,
) -> Result<storage::MutationReply, storage::StorageError> {
    let packet = storage::parse_request(request, if clear { &["clear"] } else { &["delete"] })?;
    // A historical reply never needs runtime admission, and this read probe releases SQL first.
    if let Some(reply) = storage::replay_task_mutation(app, &packet)? {
        return Ok(reply);
    }
    let task_id = if clear { None } else { packet.task_id() };
    let _permit = match recovery.removal_permit(task_id) {
        Ok(permit) => permit,
        Err(_) => {
            return storage::reject_owned_task_mutation(
                app,
                &packet,
                "Stop the active task before removing saved data.".into(),
            )
        }
    };
    guard_task_sql(
        runtime,
        if clear {
            None
        } else {
            Some(
                packet.task_id().ok_or_else(|| {
                    storage::StorageError::invalid("Missing deletion task identity.")
                })?,
            )
        },
        || {
            if clear {
                storage::clear_data(app, &packet)
            } else {
                storage::delete_task(app, &packet)
            }
        },
        |message| storage::reject_owned_task_mutation(app, &packet, message),
    )
}

fn guard_task_sql<T>(
    runtime: &RuntimeState,
    task_id: Option<&str>,
    effect: impl FnOnce() -> Result<T, storage::StorageError>,
    rejected: impl FnOnce(String) -> Result<T, storage::StorageError>,
) -> Result<T, storage::StorageError> {
    // Nest the typed storage result: only the Registry's admission refusal enters the binder.
    let admitted = if let Some(task_id) = task_id {
        runtime.delete_idle_task(task_id, || Ok(effect()))
    } else {
        runtime.clear_idle_data(|| Ok(effect()))
    };
    match admitted {
        Ok(result) => result,
        Err(message) => rejected(message),
    }
}

#[tauri::command]
async fn delete_desktop_task(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Value,
) -> Result<storage::MutationReply, storage::StorageError> {
    let runtime = state.runtime.clone();
    let recovery = state.recovery.clone();
    storage_blocking(move || guarded_task_removal(&app, &runtime, &recovery, request, false)).await
}

#[tauri::command]
async fn clear_desktop_data(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Value,
) -> Result<storage::MutationReply, storage::StorageError> {
    let runtime = state.runtime.clone();
    let recovery = state.recovery.clone();
    storage_blocking(move || guarded_task_removal(&app, &runtime, &recovery, request, true)).await
}

#[tauri::command]
async fn import_legacy_desktop_tasks(
    app: AppHandle,
    request: Value,
) -> Result<storage::MutationReply, storage::StorageError> {
    storage_blocking(move || storage::import_tasks(&app, request)).await
}

#[tauri::command]
async fn query_desktop_task_mutation(
    app: AppHandle,
    request: Value,
) -> Result<storage::QueryReply, storage::StorageError> {
    storage_blocking(move || storage::query_task_mutation(&app, request)).await
}

#[tauri::command]
async fn save_text_export(
    app: AppHandle,
    suggested_name: String,
    format: String,
    content: String,
) -> Result<TextExportResult, String> {
    ApplicationEnvironment::selected(&app).permit_native_dialog()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, filter_name) = match format.as_str() {
            "html" => ("html", "HTML"),
            "md" => ("md", "Markdown"),
            "json" => ("json", "Evidence JSON"),
            _ => return Err("Unsupported report export format".to_string()),
        };
        let file_name = safe_export_file_name(&suggested_name, extension);
        let selected = app
            .dialog()
            .file()
            .set_title("Export Evidence Loom Report")
            .set_file_name(file_name)
            .add_filter(filter_name, &[extension])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(TextExportResult {
                status: "cancelled",
                path: None,
            });
        };
        let mut path = selected.into_path().map_err(|error| error.to_string())?;
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case(extension))
        {
            path.set_extension(extension);
        }
        write_text_export_file(&path, &content)?;
        Ok(TextExportResult {
            status: "saved",
            path: Some(path.to_string_lossy().to_string()),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn safe_export_file_name(suggested_name: &str, extension: &str) -> String {
    let fallback = format!("EvidenceLoom_report.{extension}");
    let Some(file_name) = Path::new(suggested_name)
        .file_name()
        .and_then(|value| value.to_str())
    else {
        return fallback;
    };
    let cleaned: String = file_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let stem = Path::new(cleaned.trim())
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("EvidenceLoom_report")
        .trim_matches(&['.', ' '][..]);
    if stem.is_empty() {
        fallback
    } else {
        format!("{stem}.{extension}")
    }
}

fn write_text_export_file(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content.as_bytes()).map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_legacy_desktop_data(
    app: AppHandle,
    legacy: Value,
) -> Result<storage::DesktopSnapshot, storage::StorageError> {
    storage_blocking(move || storage::import_legacy(&app, legacy)).await
}

#[tauri::command]
fn runtime_info(app: AppHandle) -> RuntimeInfo {
    let dependencies = ApplicationEnvironment::selected(&app);
    let repo_root = dependencies.project_root(repo_root);
    let sidecar = sidecar_path(&dependencies, Some(&app));
    let packaged = runtime_probe::uses_sidecar(
        &runner_mode(&dependencies),
        sidecar.as_deref().map(is_real_sidecar).unwrap_or(false),
    );
    RuntimeInfo {
        kind: "tauri",
        label: if packaged {
            "Tauri Desktop / Packaged Sidecar"
        } else {
            "Tauri Desktop / Local Python"
        },
        configured_project_root: None,
        python_path: resolve_python_path(&dependencies, &repo_root, None)
            .to_string_lossy()
            .to_string(),
        runner_path: runner_path(&repo_root).to_string_lossy().to_string(),
        sidecar_path: sidecar.map(|path| path.to_string_lossy().to_string()),
        runner_mode: if packaged { "sidecar" } else { "python" }.to_string(),
        repo_root: repo_root.to_string_lossy().to_string(),
    }
}

#[tauri::command]
async fn load_ohlcv_chart_data(
    app: AppHandle,
    symbol: String,
    curr_date: String,
    payload_json: String,
) -> Result<Vec<OhlcvBar>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_ohlcv_chart_data_process(app, symbol, curr_date, payload_json)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn load_ohlcv_chart_data_process(
    app: AppHandle,
    symbol: String,
    curr_date: String,
    payload_json: String,
) -> Result<Vec<OhlcvBar>, String> {
    let dependencies = ApplicationEnvironment::selected(&app);
    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths(&dependencies) {
        payload
            .get("projectRoot")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    } else {
        None
    };
    let repo_root = effective_repo_root(&dependencies, configured_project_root.as_deref());
    let mut safe_payload = sanitize_payload(&payload);
    if let Value::Object(map) = &mut safe_payload {
        map.insert(
            "symbol".to_string(),
            Value::String(symbol.trim().to_string()),
        );
        map.insert(
            "currDate".to_string(),
            Value::String(curr_date.trim().to_string()),
        );
        map.insert(
            "__command".to_string(),
            Value::String("load_ohlcv_chart".to_string()),
        );
    }

    let sidecar = sidecar_path(&dependencies, Some(&app));
    if matches!(runner_mode(&dependencies).as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.as_ref().filter(|path| is_real_sidecar(path)) {
            let value = run_json_command(
                &dependencies,
                sidecar_path,
                &[],
                &safe_payload,
                &runtime_work_dir(&dependencies, Some(&app), &repo_root),
                child_env(&app, &repo_root, &payload)?,
                "OHLCV chart sidecar",
            )?;
            return serde_json::from_value::<Vec<OhlcvBar>>(value)
                .map_err(|error| format!("Failed to parse OHLCV chart data: {error}"));
        }
        if runner_mode(&dependencies) == "sidecar" {
            return Err(format!(
                "Packaged OHLCV chart loader not found: {}. Tried: {}",
                sidecar
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "--".to_string()),
                sidecar_debug_paths(&dependencies, Some(&app))
            ));
        }
    }

    let python_override = if allow_external_runner_paths(&dependencies) {
        payload.get("pythonPath").and_then(Value::as_str)
    } else {
        None
    };
    let python = resolve_python_path(&dependencies, &repo_root, python_override);
    let loader = ohlcv_loader_path(&repo_root);

    if !python.is_file() {
        return Err(format!(
            "Python executable not found: {}",
            python.to_string_lossy()
        ));
    }
    if !loader.is_file() {
        return Err(format!(
            "OHLCV loader not found: {}",
            loader.to_string_lossy()
        ));
    }

    let child_environment = child_env(&app, &repo_root, &payload)?;
    let mut command = Command::new(&python);
    command
        .arg(loader)
        .arg(symbol.trim())
        .arg(curr_date.trim())
        .current_dir(&repo_root);
    child_environment.apply(&mut command);
    dependencies.configure_command(&mut command)?;
    let output = command.output().map_err(|error| error.to_string())?;

    let stdout = redact_text(
        String::from_utf8_lossy(&output.stdout).trim(),
        &child_environment.secrets,
    );
    let stderr = redact_text(
        String::from_utf8_lossy(&output.stderr).trim(),
        &child_environment.secrets,
    );
    if !output.status.success() {
        return Err(readable_runner_error(&stdout, &stderr));
    }

    serde_json::from_str::<Vec<OhlcvBar>>(&stdout).map_err(|error| {
        format!(
            "Failed to parse OHLCV chart data: {error}. Output: {}",
            stdout.chars().take(500).collect::<String>()
        )
    })
}

#[tauri::command]
async fn resolve_instrument(
    app: AppHandle,
    query: String,
    payload_json: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_instrument_process(app, query, payload_json)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn resolve_instrument_process(
    app: AppHandle,
    query: String,
    payload_json: String,
) -> Result<Value, String> {
    let dependencies = ApplicationEnvironment::selected(&app);
    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths(&dependencies) {
        payload.get("projectRoot").and_then(Value::as_str)
    } else {
        None
    };
    let repo_root = effective_repo_root(&dependencies, configured_project_root);
    let mut safe_payload = sanitize_payload(&payload);
    if let Value::Object(map) = &mut safe_payload {
        map.insert("query".to_string(), Value::String(query));
        map.insert(
            "__command".to_string(),
            Value::String("resolve_instrument".to_string()),
        );
    }

    let sidecar = sidecar_path(&dependencies, Some(&app));
    if matches!(runner_mode(&dependencies).as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.as_ref().filter(|path| is_real_sidecar(path)) {
            return run_json_command(
                &dependencies,
                sidecar_path,
                &[],
                &safe_payload,
                &runtime_work_dir(&dependencies, Some(&app), &repo_root),
                child_env(&app, &repo_root, &payload)?,
                "instrument resolver sidecar",
            );
        }
        if runner_mode(&dependencies) == "sidecar" {
            return Err(format!(
                "Packaged instrument resolver not found: {}. Tried: {}",
                sidecar
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "--".to_string()),
                sidecar_debug_paths(&dependencies, Some(&app))
            ));
        }
    }

    let python = resolve_python_path(
        &dependencies,
        &repo_root,
        if allow_external_runner_paths(&dependencies) {
            payload.get("pythonPath").and_then(Value::as_str)
        } else {
            None
        },
    );
    let resolver = instrument_resolver_path(&repo_root);
    if !python.is_file() {
        return Err(format!(
            "Python executable not found: {}",
            python.to_string_lossy()
        ));
    }
    if !resolver.is_file() {
        return Err(format!(
            "Instrument resolver not found: {}",
            resolver.to_string_lossy()
        ));
    }

    let args = vec![resolver.to_string_lossy().to_string()];
    run_json_command(
        &dependencies,
        &python,
        &args,
        &safe_payload,
        &repo_root,
        child_env(&app, &repo_root, &payload)?,
        "instrument resolver",
    )
}

#[tauri::command]
async fn test_llm_connection(app: AppHandle, payload_json: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || test_llm_connection_process(app, payload_json))
        .await
        .map_err(|error| error.to_string())?
}

fn test_llm_connection_process(app: AppHandle, payload_json: String) -> Result<Value, String> {
    let dependencies = ApplicationEnvironment::selected(&app);
    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths(&dependencies) {
        payload.get("projectRoot").and_then(Value::as_str)
    } else {
        None
    };
    let repo_root = effective_repo_root(&dependencies, configured_project_root);
    let mut safe_payload = sanitize_payload(&payload);
    if let Value::Object(map) = &mut safe_payload {
        map.insert(
            "__command".to_string(),
            Value::String("test_llm".to_string()),
        );
    }

    let sidecar = sidecar_path(&dependencies, Some(&app));
    if matches!(runner_mode(&dependencies).as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.as_ref().filter(|path| is_real_sidecar(path)) {
            return run_json_command(
                &dependencies,
                sidecar_path,
                &[],
                &safe_payload,
                &runtime_work_dir(&dependencies, Some(&app), &repo_root),
                child_env(&app, &repo_root, &payload)?,
                "LLM test sidecar",
            );
        }
        if runner_mode(&dependencies) == "sidecar" {
            return Err(format!(
                "Packaged LLM test runner not found: {}. Tried: {}",
                sidecar
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "--".to_string()),
                sidecar_debug_paths(&dependencies, Some(&app))
            ));
        }
    }

    let python = resolve_python_path(
        &dependencies,
        &repo_root,
        if allow_external_runner_paths(&dependencies) {
            payload.get("pythonPath").and_then(Value::as_str)
        } else {
            None
        },
    );
    let runner = runner_path(&repo_root);
    if !python.is_file() {
        return Err(format!(
            "Python executable not found: {}",
            python.to_string_lossy()
        ));
    }
    if !runner.is_file() {
        return Err(format!(
            "Analysis runner not found: {}",
            runner.to_string_lossy()
        ));
    }

    let args = vec![runner.to_string_lossy().to_string()];
    run_json_command(
        &dependencies,
        &python,
        &args,
        &safe_payload,
        &runtime_work_dir(&dependencies, Some(&app), &repo_root),
        child_env(&app, &repo_root, &payload)?,
        "LLM test runner",
    )
}

fn run_json_command(
    dependencies: &ApplicationEnvironment,
    executable: &Path,
    args: &[String],
    payload: &Value,
    work_dir: &Path,
    child_environment: ChildEnvironment,
    label: &str,
) -> Result<Value, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    child_environment.apply(&mut command);
    dependencies.configure_command(&mut command)?;
    let mut child = command.spawn().map_err(|error| {
        format!(
            "failed to start {label} at {}: {error}",
            executable.to_string_lossy()
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = redact_text(
        String::from_utf8_lossy(&output.stdout).trim(),
        &child_environment.secrets,
    );
    let stderr = redact_text(
        String::from_utf8_lossy(&output.stderr).trim(),
        &child_environment.secrets,
    );
    if !output.status.success() {
        return Err(readable_runner_error(&stdout, &stderr));
    }
    serde_json::from_str::<Value>(&stdout).map_err(|error| {
        format!(
            "Failed to parse {label} output: {error}. Output: {}",
            stdout.chars().take(500).collect::<String>()
        )
    })
}

fn readable_runner_error(stdout: &str, stderr: &str) -> String {
    for text in [stderr.trim(), stdout.trim()] {
        if text.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            if let Some(message) = value.get("error").and_then(Value::as_str) {
                if !message.trim().is_empty() {
                    return message.trim().to_string();
                }
            }
            if let Some(message) = value.get("message").and_then(Value::as_str) {
                if !message.trim().is_empty() {
                    return message.trim().to_string();
                }
            }
        }
        return text.to_string();
    }
    "Runner exited without an error message.".to_string()
}

#[cfg(test)]
#[derive(Serialize)]
struct AnalysisCommandError {
    code: &'static str,
    message: String,
}

#[cfg(test)]
impl From<String> for AnalysisCommandError {
    fn from(message: String) -> Self {
        Self {
            code: if message == analysis_execution::CLEANUP_ERROR {
                "analysis_cleanup_incomplete"
            } else {
                "analysis_failed"
            },
            message,
        }
    }
}

#[cfg(test)]
fn analysis_worker_join_error(
    owner: &analysis_execution::OwnershipObservation,
) -> AnalysisCommandError {
    if owner.retained() {
        AnalysisCommandError::from(analysis_execution::CLEANUP_ERROR.to_string())
    } else {
        AnalysisCommandError::from("Analysis worker failed.".to_string())
    }
}

use analysis_recovery::{
    parser as recovery_parser, runtime as recovery_runtime, wire as recovery_wire,
};

async fn recovery_blocking<T: Send + recovery_wire::ReplyBoundary + 'static>(
    work: impl FnOnce() -> Result<T, recovery_wire::RecoveryError> + Send + 'static,
) -> Result<T, recovery_wire::RecoveryError> {
    tauri::async_runtime::spawn_blocking(move || recovery_wire::fit_reply(work()?))
        .await
        .map_err(|_| recovery_wire::RecoveryError::unavailable())?
}
fn recovery_wake(app: &AppHandle) -> recovery_runtime::WakeSink {
    let app = app.clone();
    Arc::new(move |notice| {
        let channel = format!(
            "analysis-journal:{}:{}",
            notice.origin.runtime_epoch, notice.origin.run_id
        );
        let _ = app.emit(&channel, notice);
    })
}
#[tauri::command]
async fn query_analysis_runtime(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::RuntimeObservation, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        recovery_parser::parse::<recovery_wire::ProtocolRequest>(&request_json)?;
        Ok(recovery.observe())
    })
    .await
}
#[tauri::command]
async fn load_analysis_recovery(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::RecoverySnapshot, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        recovery_parser::parse::<recovery_wire::ProtocolRequest>(&request_json)?;
        recovery.snapshot()
    })
    .await
}
#[tauri::command]
async fn attach_analysis_recovery(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::AttachReply, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let packet = recovery_parser::parse::<recovery_wire::AttachRequest>(&request_json)?;
        recovery.attachment(&packet, true)
    })
    .await
}
#[tauri::command]
async fn query_analysis_attachment(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::AttachReply, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let packet = recovery_parser::parse::<recovery_wire::AttachRequest>(&request_json)?;
        recovery.attachment(&packet, false)
    })
    .await
}
#[tauri::command]
async fn reserve_analysis(
    app: AppHandle,
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::AdmissionOutcomeReply, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    let wake = recovery_wake(&app);
    let dependencies = ApplicationEnvironment::selected(&app);
    recovery_blocking(move || {
        let packet = recovery_parser::parse::<recovery_wire::AdmissionRequest>(&request_json)?;
        recovery.reserve(
            packet,
            move |request| prepare_analysis_credentials(&dependencies, request),
            wake,
        )
    })
    .await
}
#[tauri::command]
async fn query_analysis_reservation(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::AdmissionOutcomeReply, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let packet = recovery_parser::parse::<recovery_wire::AdmissionRequest>(&request_json)?;
        recovery.query_reservation(&packet)
    })
    .await
}
#[tauri::command]
async fn start_analysis(
    app: AppHandle,
    state: State<'_, AppState>,
    request_json: String,
    execution_input_json: String,
) -> Result<recovery_wire::OutcomeReply<recovery_wire::StartReceipt>, recovery_wire::RecoveryError>
{
    let recovery = state.recovery.clone();
    let wake = recovery_wake(&app);
    recovery_blocking(move || {
        let packet = recovery_parser::parse::<recovery_wire::StartRequest>(&request_json)?;
        let input = recovery_parser::execution_input(&execution_input_json)?;
        recovery.start(packet, input, wake, move |execution, publisher, input| {
            let observation = execution.ownership();
            let supervising = publisher.clone();
            let worker = tauri::async_runtime::spawn_blocking(move || {
                run_recovery_process(app, execution, publisher, input)
            });
            tauri::async_runtime::spawn(async move {
                if worker.await.is_err() {
                    let _ = recovery_blocking(move || {
                        recovery_runtime::joined_worker_failed(supervising, observation);
                        Ok(())
                    })
                    .await;
                }
            });
            Ok(())
        })
    })
    .await
}
#[tauri::command]
async fn query_analysis_start(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::OutcomeReply<recovery_wire::StartReceipt>, recovery_wire::RecoveryError>
{
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let p = recovery_parser::parse::<recovery_wire::StartRequest>(&request_json)?;
        let result = recovery.backend()?.query_start(&p)?;
        Ok(recovery.outcome(result, "analysis_start", &p.request.journal_id))
    })
    .await
}
#[tauri::command]
async fn read_analysis_journal(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::ReadReply, recovery_wire::RecoveryError> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let p = recovery_parser::parse::<recovery_wire::ReadRequest>(&request_json)?;
        recovery.backend()?.read(&p.request)
    })
    .await
}
#[tauri::command]
async fn commit_analysis_projection(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<
    recovery_wire::OutcomeReply<recovery_wire::ProjectionReceipt>,
    recovery_wire::RecoveryError,
> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let p = recovery_parser::parse::<recovery_wire::ProjectionRequest>(&request_json)?;
        recovery.project(p)
    })
    .await
}
#[tauri::command]
async fn query_analysis_projection(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<
    recovery_wire::OutcomeReply<recovery_wire::ProjectionReceipt>,
    recovery_wire::RecoveryError,
> {
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let p = recovery_parser::parse::<recovery_wire::ProjectionRequest>(&request_json)?;
        let result = recovery.backend()?.query_projection(&p)?;
        let _ = recovery.refresh();
        Ok(recovery.outcome(result, "analysis_projection_sql", &p.request.journal_id))
    })
    .await
}
#[tauri::command]
async fn stop_analysis(
    app: AppHandle,
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::OutcomeReply<recovery_wire::ControlReceipt>, recovery_wire::RecoveryError>
{
    let p = recovery_parser::parse::<recovery_wire::StopRequest>(&request_json)?;
    let recovery = state.recovery.clone();
    // The blocking helper rejects known request-ID conflicts before marking
    // this exact owner, then marks before its bounded cleanup work.
    let wake = recovery_wake(&app);
    recovery_blocking(move || recovery.stop(p, wake)).await
}
#[tauri::command]
async fn query_analysis_control(
    state: State<'_, AppState>,
    request_json: String,
) -> Result<recovery_wire::OutcomeReply<recovery_wire::ControlReceipt>, recovery_wire::RecoveryError>
{
    let recovery = state.recovery.clone();
    recovery_blocking(move || {
        let p = recovery_parser::parse::<recovery_wire::StopRequest>(&request_json)?;
        let result = recovery.backend()?.query_control(&p)?;
        if let Some(receipt) = &result.receipt {
            recovery.reconcile_control(receipt);
        }
        let _ = recovery.refresh();
        Ok(recovery.outcome(result, "analysis_control", &p.request.journal_id))
    })
    .await
}

#[cfg(test)]
async fn reserve_analysis_owner(
    runtime: Arc<RuntimeState>,
    task_id: String,
) -> Result<String, AnalysisCommandError> {
    tauri::async_runtime::spawn_blocking(move || runtime.reserve(task_id))
        .await
        .map_err(|_| AnalysisCommandError::from("Analysis reservation failed.".to_string()))?
        .map_err(Into::into)
}

#[tauri::command]
async fn check_runtime(
    app: AppHandle,
    python_path_override: Option<String>,
    project_root: Option<String>,
) -> Result<RuntimeCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_runtime_process(app, python_path_override, project_root)
    })
    .await
    .map_err(|_| "Runtime diagnostics could not be completed.".to_string())
}

#[tauri::command]
async fn get_research_memory_inventory(
    app: AppHandle,
    decision_ids: Vec<String>,
    python_path: Option<String>,
    project_root: Option<String>,
) -> Result<Value, String> {
    research_memory::validate_requested_ids(&decision_ids)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dependencies = ApplicationEnvironment::selected(&app);
        let external = allow_external_runner_paths(&dependencies);
        if !external
            && (normalize_optional_path(project_root.as_deref()).is_some()
                || normalize_optional_path(python_path.as_deref()).is_some())
        {
            return Err("Custom research runtime paths are disabled in this desktop build.".into());
        }
        let configured_root = if external {
            normalize_optional_path(project_root.as_deref())
        } else {
            None
        };
        let repo_root = effective_repo_root(&dependencies, configured_root.as_deref());
        let sidecar = sidecar_path(&dependencies, Some(&app));
        let sidecar_real = sidecar.as_deref().is_some_and(is_real_sidecar);
        let mut command = if runtime_probe::uses_sidecar(&runner_mode(&dependencies), sidecar_real)
        {
            if !sidecar_real {
                return Err("Research memory inventory requires a built sidecar.".into());
            }
            let mut command = Command::new(
                sidecar
                    .as_deref()
                    .ok_or("Research memory runtime is unavailable.")?,
            );
            command.current_dir(runtime_work_dir(&dependencies, Some(&app), &repo_root));
            command
        } else {
            let python = resolve_python_path(
                &dependencies,
                &repo_root,
                if external {
                    python_path.as_deref()
                } else {
                    None
                },
            );
            let mut command = Command::new(python);
            command.arg(runner_path(&repo_root)).current_dir(&repo_root);
            command
        };
        command.env("PYTHONPATH", build_pythonpath(&dependencies, &repo_root));
        research_memory_inventory::read_in_environment(command, &decision_ids, &dependencies)
    })
    .await
    .map_err(|_| "Research memory inventory could not be read.".to_string())?
}

fn check_runtime_process(
    app: AppHandle,
    python_path_override: Option<String>,
    project_root: Option<String>,
) -> RuntimeCheck {
    let dependencies = ApplicationEnvironment::selected(&app);
    let external_runner_allowed = allow_external_runner_paths(&dependencies);
    let configured_project_root = if external_runner_allowed {
        normalize_optional_path(project_root.as_deref())
    } else {
        None
    };
    let repo_root = effective_repo_root(&dependencies, configured_project_root.as_deref());
    let python_override = if external_runner_allowed {
        python_path_override.as_deref()
    } else {
        None
    };
    let python = resolve_python_path(&dependencies, &repo_root, python_override);
    let runner = runner_path(&repo_root);
    let sidecar = sidecar_path(&dependencies, Some(&app));
    let mode = runner_mode(&dependencies);
    let sidecar_real = sidecar.as_deref().map(is_real_sidecar).unwrap_or(false);
    let mut errors = Vec::new();

    let (python_exists, runner_exists, python_version, can_import_trading_agents, import_error) =
        if runtime_probe::uses_sidecar(&mode, sidecar_real) {
            let result = if sidecar_real {
                runtime_probe::probe_sidecar_in_environment(
                    &dependencies,
                    sidecar.as_deref().expect("real sidecar has a path"),
                    &runtime_work_dir(&dependencies, Some(&app), &repo_root),
                )
                .map_err(|error| error.message().to_string())
            } else {
                Err(
                    "Sidecar binary not found or is a placeholder. Run scripts/build_tauri_sidecar.sh first."
                        .to_string(),
                )
            };
            match result {
                Ok(()) => (true, true, None, true, None),
                Err(error) => {
                    errors.push(error.clone());
                    (true, sidecar_real, None, false, Some(error))
                }
            }
        } else {
            if !external_runner_allowed
                && (normalize_optional_path(project_root.as_deref()).is_some()
                    || normalize_optional_path(python_path_override.as_deref()).is_some())
            {
                errors.push(
                    "Custom projectRoot/pythonPath are disabled in this desktop build. Set EVIDENCELOOM_ALLOW_EXTERNAL_RUNNER=1 for development only."
                        .to_string(),
                );
            }
            let python_exists = fs::metadata(&python)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
            let runner_exists = fs::metadata(&runner)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);

            if !python_exists {
                errors.push(format!(
                    "Python executable not found: {}",
                    python.to_string_lossy()
                ));
            }
            if !runner_exists {
                errors.push(format!("Runner not found: {}", runner.to_string_lossy()));
            }

            let python_version = if python_exists {
                command_output(&dependencies, &python, &["--version"], &repo_root, false)
                    .unwrap_or_else(|error| {
                        errors.push(format!("Failed to read Python version: {error}"));
                        String::new()
                    })
            } else {
                String::new()
            };

            let import_result = if python_exists {
                command_output(
                    &dependencies,
                    &python,
                    &["-c", "import tradingagents; print('ok')"],
                    &repo_root,
                    true,
                )
            } else {
                Err("Python executable is missing".to_string())
            };

            let (can_import, import_err) = match import_result {
                Ok(_) => (true, None),
                Err(error) => {
                    errors.push(format!("Cannot import tradingagents: {error}"));
                    (false, Some(error))
                }
            };

            (
                python_exists,
                runner_exists,
                if python_version.is_empty() {
                    None
                } else {
                    Some(python_version)
                },
                can_import,
                import_err,
            )
        };

    RuntimeCheck {
        kind: "tauri",
        ok: errors.is_empty(),
        repo_root: repo_root.to_string_lossy().to_string(),
        configured_project_root,
        python_path: python.to_string_lossy().to_string(),
        runner_path: runner.to_string_lossy().to_string(),
        sidecar_path: sidecar.map(|path| path.to_string_lossy().to_string()),
        runner_mode: if runtime_probe::uses_sidecar(&mode, sidecar_real) {
            "sidecar"
        } else {
            "python"
        }
        .to_string(),
        python_exists,
        runner_exists,
        python_version,
        can_import_trading_agents,
        import_error,
        sidecar_real,
        errors,
    }
}

fn prepare_analysis_credentials(
    dependencies: &ApplicationEnvironment,
    request: &recovery_wire::AdmissionRequest,
) -> Result<recovery_runtime::CredentialSnapshot, recovery_wire::RecoveryError> {
    let provider = request.context["requestedSettings"]["llmProvider"]
        .as_str()
        .ok_or_else(recovery_wire::RecoveryError::invalid)?
        .trim()
        .to_lowercase();
    let provider_secret = dependencies
        .provider_secret(&provider)
        .map_err(|_| recovery_wire::RecoveryError::fixed("analysis_identity_unavailable"))?;
    let alpha_secret = dependencies
        .alpha_secret()
        .map_err(|_| recovery_wire::RecoveryError::fixed("analysis_identity_unavailable"))?;
    let inherited = analysis_recovery::publication::CREDENTIAL_ENV
        .iter()
        .map(|name| {
            let value = match dependencies.var(name) {
                Ok(value) => Some(value),
                Err(env::VarError::NotPresent) => None,
                Err(env::VarError::NotUnicode(_)) => {
                    return Err(recovery_wire::RecoveryError::fixed(
                        "analysis_identity_unavailable",
                    ))
                }
            };
            Ok(((*name).to_owned(), value))
        })
        .collect::<Result<Vec<_>, recovery_wire::RecoveryError>>()?;
    // Build the inventory from this original acquisition only. The shared
    // collector never rereads Keychain/environment or changes child credentials.
    let inventory = analysis_recovery::publication::SecretInventory::acquire(
        |kind| match kind {
            "provider" => Ok(provider_secret.clone()),
            "alpha" => Ok(alpha_secret.clone()),
            _ => Err(recovery_wire::RecoveryError::invalid()),
        },
        |name| {
            Ok(inherited
                .iter()
                .find(|(key, _)| key == name)
                .and_then(|(_, value)| value.clone()))
        },
    )?;
    Ok(recovery_runtime::CredentialSnapshot {
        provider,
        provider_secret,
        alpha_secret,
        inherited,
        inventory: Arc::new(inventory),
    })
}
fn prepared_child_env(
    dependencies: &ApplicationEnvironment,
    root: &Path,
    snapshot: &recovery_runtime::CredentialSnapshot,
) -> ChildEnvironment {
    let mut environment = ChildEnvironment::default();
    environment.push_public("PYTHONPATH", build_pythonpath(dependencies, root));
    for name in analysis_recovery::publication::CREDENTIAL_ENV {
        environment.remove(name);
    }
    environment.push_public("EVIDENCELOOM_LLM_PROVIDER", snapshot.provider.clone());
    environment.push_public("TRADINGAGENTS_LLM_PROVIDER", snapshot.provider.clone());
    let inherited = |name: &str| {
        snapshot
            .inherited
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.clone())
    };
    let provider_secret = snapshot
        .provider_secret
        .clone()
        .or_else(|| provider_api_key_env(&snapshot.provider).and_then(inherited));
    inject_provider_secret(&mut environment, &snapshot.provider, provider_secret);
    if let Some(value) = snapshot
        .alpha_secret
        .clone()
        .or_else(|| inherited("ALPHA_VANTAGE_API_KEY"))
    {
        environment.push_secret("ALPHA_VANTAGE_API_KEY", value);
    }
    environment
}
fn run_recovery_process(
    app: AppHandle,
    execution: analysis_execution::RunGuard,
    publisher: recovery_runtime::Publisher,
    payload: Value,
) {
    let dependencies = ApplicationEnvironment::selected(&app);
    let configured_root = if allow_external_runner_paths(&dependencies) {
        payload.get("projectRoot").and_then(Value::as_str)
    } else {
        None
    };
    let root = effective_repo_root(&dependencies, configured_root);
    let python = resolve_python_path(
        &dependencies,
        &root,
        if allow_external_runner_paths(&dependencies) {
            payload.get("pythonPath").and_then(Value::as_str)
        } else {
            None
        },
    );
    let runner = resolve_runner_command(
        &dependencies,
        &python,
        &runner_path(&root),
        sidecar_path(&dependencies, Some(&app)).as_ref(),
    );
    let mut command = Command::new(&runner.executable);
    command
        .args(&runner.args)
        .current_dir(runtime_work_dir(&dependencies, Some(&app), &root));
    let snapshot = publisher
        .run
        .credentials
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(snapshot) = snapshot else {
        recovery_runtime::worker_failed_before_spawn(execution, publisher, "analysis_start_failed");
        return;
    };
    prepared_child_env(&dependencies, &root, &snapshot).apply(&mut command);
    if dependencies.configure_command(&mut command).is_err() {
        recovery_runtime::worker_failed_before_spawn(execution, publisher, "analysis_start_failed");
        return;
    }
    recovery_runtime::run_owned_worker(
        execution,
        publisher,
        command,
        sanitize_payload(&payload).to_string(),
    );
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should live under the repository root")
        .to_path_buf()
}

fn runtime_work_dir(
    dependencies: &ApplicationEnvironment,
    app: Option<&AppHandle>,
    repo_root: &Path,
) -> PathBuf {
    dependencies.work_dir(|| {
        if allow_external_runner_paths(dependencies) {
            return repo_root.to_path_buf();
        }

        if let Some(app) = app {
            if let Ok(path) = app.path().app_data_dir() {
                let _ = fs::create_dir_all(&path);
                return path;
            }
        }

        env::current_dir().unwrap_or_else(|_| repo_root.to_path_buf())
    })
}

struct RunnerCommand {
    executable: PathBuf,
    args: Vec<String>,
}

fn resolve_runner_command(
    dependencies: &ApplicationEnvironment,
    python: &Path,
    runner: &Path,
    sidecar: Option<&PathBuf>,
) -> RunnerCommand {
    let mode = runner_mode(dependencies);
    if matches!(mode.as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.filter(|path| is_real_sidecar(path)) {
            return RunnerCommand {
                executable: sidecar_path.clone(),
                args: Vec::new(),
            };
        }
        if mode == "sidecar" {
            return RunnerCommand {
                executable: sidecar.map_or_else(|| runner.to_path_buf(), Clone::clone),
                args: Vec::new(),
            };
        }
    }

    RunnerCommand {
        executable: python.to_path_buf(),
        args: vec![runner.to_string_lossy().to_string()],
    }
}

fn is_real_sidecar(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return true,
    };
    let mut header = [0_u8; 1024];
    match file.read(&mut header) {
        Ok(bytes_read) => !header[..bytes_read]
            .windows(b"EVIDENCELOOM_SIDECAR_PLACEHOLDER".len())
            .any(|window| window == b"EVIDENCELOOM_SIDECAR_PLACEHOLDER"),
        Err(_) => true,
    }
}

fn runner_mode(dependencies: &ApplicationEnvironment) -> String {
    dependencies.runner_mode(|| {
        let configured = dependencies
            .var("EVIDENCELOOM_RUNNER_MODE")
            .or_else(|_| dependencies.var("TRADINGAGENTS_RUNNER_MODE"))
            .unwrap_or_else(|_| "python".to_string())
            .trim()
            .to_lowercase();
        if allow_external_runner_paths(dependencies) {
            configured
        } else {
            "sidecar".to_string()
        }
    })
}

fn allow_external_runner_paths(dependencies: &ApplicationEnvironment) -> bool {
    dependencies.external_runner_allowed(|| {
        cfg!(debug_assertions)
            || dependencies
                .var("EVIDENCELOOM_ALLOW_EXTERNAL_RUNNER")
                .or_else(|_| dependencies.var("TRADINGAGENTS_ALLOW_EXTERNAL_RUNNER"))
                .map(|value| matches!(value.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
                .unwrap_or(false)
    })
}

fn sidecar_path(dependencies: &ApplicationEnvironment, app: Option<&AppHandle>) -> Option<PathBuf> {
    dependencies.sidecar(|| {
        if let Ok(path) = dependencies
            .var("EVIDENCELOOM_RUNNER_SIDECAR")
            .or_else(|_| dependencies.var("TRADINGAGENTS_RUNNER_SIDECAR"))
        {
            if !path.trim().is_empty() {
                return Some(PathBuf::from(path));
            }
        }

        let binary_name = if cfg!(windows) {
            "evidenceloom-runner.exe"
        } else {
            "evidenceloom-runner"
        };
        let target_triple = env!("TAURI_ENV_TARGET_TRIPLE");
        let mut dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("evidenceloom-runner-{target_triple}"));
        if cfg!(windows) {
            dev_path.set_extension("exe");
        }

        let mut candidates = Vec::new();

        if let Ok(exe_path) = env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                candidates.push(exe_dir.join(binary_name));
            }
        }

        if let Some(app) = app {
            if let Ok(path) = app
                .path()
                .resolve(binary_name, tauri::path::BaseDirectory::Resource)
            {
                candidates.push(path);
            }
        }

        candidates.push(dev_path);

        candidates
            .iter()
            .find(|path| is_real_sidecar(path))
            .cloned()
            .or_else(|| candidates.into_iter().next())
    })
}

fn sidecar_debug_paths(dependencies: &ApplicationEnvironment, app: Option<&AppHandle>) -> String {
    dependencies.sidecar_description(|| {
        let binary_name = if cfg!(windows) {
            "evidenceloom-runner.exe"
        } else {
            "evidenceloom-runner"
        };
        let mut paths = Vec::new();
        if let Ok(exe_path) = env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                paths.push(exe_dir.join(binary_name));
            }
        }
        if let Some(app) = app {
            if let Ok(path) = app
                .path()
                .resolve(binary_name, tauri::path::BaseDirectory::Resource)
            {
                paths.push(path);
            }
        }
        paths
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    })
}

fn effective_repo_root(
    dependencies: &ApplicationEnvironment,
    configured_path: Option<&str>,
) -> PathBuf {
    dependencies.project_root(|| {
        if let Some(path) = configured_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            return PathBuf::from(path);
        }
        repo_root()
    })
}

fn normalize_optional_path(path: Option<&str>) -> Option<String> {
    path.map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
}

fn runner_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join("frontend")
        .join("server")
        .join("run_analysis.py")
}

fn ohlcv_loader_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join("frontend")
        .join("server")
        .join("load_ohlcv_chart.py")
}

fn instrument_resolver_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join("frontend")
        .join("server")
        .join("resolve_instrument.py")
}

fn resolve_python_path(
    dependencies: &ApplicationEnvironment,
    repo_root: &Path,
    configured_path: Option<&str>,
) -> PathBuf {
    dependencies.python_path(|| {
        if let Some(path) = configured_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            return PathBuf::from(path);
        }

        if let Ok(path) = dependencies
            .var("EVIDENCELOOM_PYTHON")
            .or_else(|_| dependencies.var("TRADINGAGENTS_PYTHON"))
        {
            if !path.trim().is_empty() {
                return PathBuf::from(path);
            }
        }

        if cfg!(windows) {
            repo_root.join(".venv").join("Scripts").join("python.exe")
        } else {
            repo_root.join(".venv").join("bin").join("python")
        }
    })
}

fn command_output(
    dependencies: &ApplicationEnvironment,
    command_path: &Path,
    args: &[&str],
    repo_root: &Path,
    with_pythonpath: bool,
) -> Result<String, String> {
    let mut command = Command::new(command_path);
    command.args(args).current_dir(repo_root);
    if with_pythonpath {
        command.env("PYTHONPATH", build_pythonpath(dependencies, repo_root));
    }
    dependencies.configure_command(&mut command)?;
    let output = command.output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn build_pythonpath(dependencies: &ApplicationEnvironment, repo_root: &Path) -> String {
    match dependencies.var("PYTHONPATH") {
        Ok(existing) if !existing.is_empty() => format!(
            "{}{}{}",
            repo_root.to_string_lossy(),
            path_delimiter(),
            existing
        ),
        _ => repo_root.to_string_lossy().to_string(),
    }
}

#[derive(Default)]
struct ChildEnvironment {
    vars: Vec<(String, String)>,
    removed_vars: Vec<String>,
    secrets: Vec<String>,
}

impl ChildEnvironment {
    fn apply(&self, command: &mut Command) {
        for name in &self.removed_vars {
            command.env_remove(name);
        }
        for (name, value) in &self.vars {
            command.env(name, value);
        }
    }

    fn push_public(&mut self, name: &str, value: String) {
        self.vars.push((name.to_string(), value));
    }

    fn push_secret(&mut self, name: &str, value: String) {
        if !self.secrets.contains(&value) {
            self.secrets.push(value.clone());
            self.secrets
                .sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        }
        self.vars.push((name.to_string(), value));
    }

    fn remove(&mut self, name: &str) {
        if !self.removed_vars.iter().any(|item| item == name) {
            self.removed_vars.push(name.to_string());
        }
    }
}

fn child_env(
    app: &AppHandle,
    repo_root: &Path,
    payload: &Value,
) -> Result<ChildEnvironment, String> {
    child_env_in_environment(&ApplicationEnvironment::selected(app), repo_root, payload)
}

fn child_env_in_environment(
    dependencies: &ApplicationEnvironment,
    repo_root: &Path,
    payload: &Value,
) -> Result<ChildEnvironment, String> {
    let mut environment = ChildEnvironment::default();
    environment.push_public("PYTHONPATH", build_pythonpath(dependencies, repo_root));

    let configured_provider = dependencies
        .var("EVIDENCELOOM_LLM_PROVIDER")
        .ok()
        .or_else(|| dependencies.var("TRADINGAGENTS_LLM_PROVIDER").ok());
    let provider = payload
        .get("llmProvider")
        .and_then(Value::as_str)
        .or(configured_provider.as_deref())
        .unwrap_or("openai")
        .trim()
        .to_lowercase();

    isolate_provider_credentials(&mut environment, &provider);
    environment.push_public("EVIDENCELOOM_LLM_PROVIDER", provider.clone());
    environment.push_public("TRADINGAGENTS_LLM_PROVIDER", provider.clone());
    let provider_secret = dependencies.provider_secret(&provider)?;
    inject_provider_secret(&mut environment, &provider, provider_secret);

    if let Some(alpha_key) = dependencies.alpha_secret()? {
        environment.push_secret("ALPHA_VANTAGE_API_KEY", alpha_key);
    }

    Ok(environment)
}

fn inject_provider_secret(
    environment: &mut ChildEnvironment,
    provider: &str,
    api_key: Option<String>,
) {
    if let Some(api_key) = api_key {
        if let Some(env_name) = provider_api_key_env(provider) {
            environment.push_secret(env_name, api_key);
        }
    }
}

fn isolate_provider_credentials(environment: &mut ChildEnvironment, provider: &str) {
    let selected_env = provider_api_key_env(provider);
    for env_name in [
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
    ] {
        if Some(env_name) != selected_env {
            environment.remove(env_name);
        }
    }
}

fn redact_text(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_string(), |redacted, secret| {
        if secret.is_empty() {
            redacted
        } else {
            redacted.replace(secret, "[REDACTED]")
        }
    })
}

fn sanitize_payload(payload: &Value) -> Value {
    let mut safe = payload.as_object().cloned().unwrap_or_else(Map::new);
    safe.remove("apiKey");
    safe.remove("alphaVantageApiKey");
    Value::Object(safe)
}

fn provider_api_key_env(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "google" => Some("GOOGLE_API_KEY"),
        "azure" => Some("AZURE_OPENAI_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "qwen" => Some("DASHSCOPE_API_KEY"),
        "qwen-cn" => Some("DASHSCOPE_CN_API_KEY"),
        "glm" => Some("ZHIPU_API_KEY"),
        "glm-cn" => Some("ZHIPU_CN_API_KEY"),
        "minimax" => Some("MINIMAX_API_KEY"),
        "minimax-cn" => Some("MINIMAX_CN_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        _ => None,
    }
}

fn path_delimiter() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

fn main() {
    let environment = ApplicationEnvironment::system();
    tauri::Builder::default()
        .manage(environment)
        .setup(|app| {
            let coordinator = app.state::<AppState>().recovery.clone();
            let backend = Arc::new(storage::AppJournalBackend::new(app.handle().clone()));
            let initializing = coordinator.clone();
            let work = tauri::async_runtime::spawn_blocking(move || {
                let epoch = recovery_runtime::entropy_epoch()?;
                initializing.initialize(backend, epoch)
            });
            tauri::async_runtime::spawn(async move {
                match work.await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => coordinator.initialization_failed(&error.code),
                    Err(_) => coordinator.initialization_failed("analysis_identity_unavailable"),
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            check_runtime,
            get_research_memory_inventory,
            load_ohlcv_chart_data,
            resolve_instrument,
            test_llm_connection,
            query_analysis_runtime,
            load_analysis_recovery,
            attach_analysis_recovery,
            query_analysis_attachment,
            query_analysis_reservation,
            query_analysis_start,
            read_analysis_journal,
            commit_analysis_projection,
            query_analysis_projection,
            query_analysis_control,
            reserve_analysis,
            start_analysis,
            stop_analysis,
            load_desktop_data,
            save_desktop_settings,
            set_provider_secret,
            delete_provider_secret,
            set_alpha_vantage_secret,
            delete_alpha_vantage_secret,
            save_desktop_task,
            delete_desktop_task,
            clear_desktop_data,
            save_text_export,
            import_legacy_desktop_data,
            import_legacy_desktop_tasks,
            query_desktop_task_mutation
        ])
        .run(tauri::generate_context!())
        .expect("error while running Evidence Loom desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_mutation_storage_future_yields_while_native_coordinator_is_locked() {
        use std::{future::Future, sync::mpsc, task::Poll};
        let coordinator = storage::task_mutation::coordinator();
        let (witness, observed) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut future = std::pin::pin!(storage_blocking(|| {
                let _coordinator = storage::task_mutation::coordinator();
                Ok(())
            }));
            let mut first = true;
            tauri::async_runtime::block_on(std::future::poll_fn(|context| {
                let result = future.as_mut().poll(context);
                if first {
                    first = false;
                    let _ = witness.send(matches!(result, Poll::Pending));
                }
                result
            }))
        });
        // Release on every observed outcome before consuming the worker.
        let pending = observed.recv_timeout(Duration::from_secs(3));
        drop(coordinator);
        let joined = worker.join();
        assert!(pending.unwrap());
        assert!(joined.unwrap().is_ok());
    }

    #[test]
    fn analysis_execution_reservation_yields_while_clear_callback_holds_admission() {
        use std::{future::Future, sync::mpsc, task::Poll};
        let runtime = Arc::new(RuntimeState::default());
        let clearing = runtime.clone();
        let (entered, inside) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let clear_worker = thread::spawn(move || {
            clearing.clear_idle_data(|| {
                entered.send(()).map_err(|error| error.to_string())?;
                gate.recv_timeout(Duration::from_secs(10))
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
        });
        let entered_result = inside.recv_timeout(Duration::from_secs(3));
        let reserving = runtime.clone();
        let (witness, observed) = mpsc::channel();
        let reservation_worker = thread::spawn(move || {
            let mut future = std::pin::pin!(reserve_analysis_owner(reserving, "owned-task".into()));
            let mut first_poll = true;
            tauri::async_runtime::block_on(std::future::poll_fn(|context| {
                let result = future.as_mut().poll(context);
                if first_poll {
                    first_poll = false;
                    let pending = matches!(&result, Poll::Pending);
                    let _ = witness.send(pending);
                }
                result
            }))
            .map_err(|error| error.message)
        });
        // Observe this future's first poll while the clear gate is still held.
        // A direct synchronous lock in its body produces no timely witness.
        let pending_before_release = observed.recv_timeout(Duration::from_secs(3));
        let released = release.send(()).is_ok();
        let deadline = Instant::now() + Duration::from_secs(12);
        while (!clear_worker.is_finished() || !reservation_worker.is_finished())
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(2));
        }
        // Success requires both joined outcomes. An OS-stalled Rust thread
        // cannot be force-killed here; a missed deadline fails this test.
        let clear_result = clear_worker.is_finished().then(|| clear_worker.join());
        let reservation_result = reservation_worker
            .is_finished()
            .then(|| reservation_worker.join());
        let reserved = reservation_result.and_then(Result::ok);
        let cleanup = reserved.as_ref().and_then(|result| {
            result.as_ref().ok().map(|id| {
                runtime
                    .cancel("owned-task", id)
                    .ok_or_else(|| "owned reservation disappeared".to_string())
                    .and_then(|request| {
                        request.wait(Instant::now() + analysis_execution::CLEANUP_TIMEOUT)
                    })
            })
        });
        assert!(entered_result.is_ok() && released);
        clear_result
            .expect("owned clear worker did not join")
            .unwrap()
            .unwrap();
        reserved
            .expect("owned reservation worker did not join")
            .unwrap();
        cleanup
            .expect("owned reservation was not supervised")
            .unwrap();
        assert!(
            pending_before_release.expect("first poll did not yield while clear held admission")
        );
    }

    #[test]
    fn analysis_execution_cleanup_error_uses_machine_code() {
        assert_eq!(
            serde_json::to_value(AnalysisCommandError::from(
                analysis_execution::CLEANUP_ERROR.to_string()
            ))
            .unwrap(),
            json!({"code":"analysis_cleanup_incomplete","message":analysis_execution::CLEANUP_ERROR})
        );
        let ordinary = AnalysisCommandError::from(
            "Analysis cleanup incomplete: an unrelated message".to_string(),
        );
        assert_eq!(ordinary.code, "analysis_failed");
    }

    fn join_analysis_panic(worker: tauri::async_runtime::JoinHandle<()>) {
        let deadline = Instant::now() + Duration::from_secs(6);
        while !worker.inner().is_finished() {
            assert!(
                Instant::now() < deadline,
                "owned blocking worker did not finish"
            );
            thread::sleep(Duration::from_millis(2));
        }
        assert!(tauri::async_runtime::block_on(worker).is_err());
    }

    #[test]
    fn analysis_execution_join_error_preserves_failed_cleanup_code() {
        let runtime = Arc::new(RuntimeState::default());
        let run_id = runtime.reserve("task".into()).unwrap();
        let execution = runtime.start("task", &run_id).unwrap();
        let owner = execution.ownership();
        let (release, wait) = std::sync::mpsc::channel();
        execution.reader(thread::spawn(move || {
            wait.recv_timeout(Duration::from_secs(10)).unwrap()
        }));
        let worker = tauri::async_runtime::spawn_blocking(move || -> () {
            let _execution = execution;
            panic!("owned Tauri worker with unfinished output");
        });
        join_analysis_panic(worker);
        let error = analysis_worker_join_error(&owner);
        let retained = owner.retained();
        let refused = runtime.reserve("other".into()).is_err();
        release.send(()).unwrap();
        runtime
            .cancel("task", &run_id)
            .unwrap()
            .wait(Instant::now() + analysis_execution::CLEANUP_TIMEOUT)
            .unwrap();
        assert!(retained && refused);
        assert_eq!(
            serde_json::to_value(error).unwrap()["code"],
            "analysis_cleanup_incomplete"
        );
        assert!(!owner.retained());
    }

    #[test]
    fn analysis_execution_join_error_never_observes_replacement_owner() {
        let runtime = Arc::new(RuntimeState::default());
        let run_id = runtime.reserve("task".into()).unwrap();
        let execution = runtime.start("task", &run_id).unwrap();
        let owner = execution.ownership();
        join_analysis_panic(tauri::async_runtime::spawn_blocking(move || -> () {
            let _execution = execution;
            panic!("owned Tauri worker after successful cleanup");
        }));
        assert_eq!(analysis_worker_join_error(&owner).code, "analysis_failed");
        let replacement_id = runtime.reserve("task".into()).unwrap();
        let mut replacement = runtime.start("task", &replacement_id).unwrap();
        let error = analysis_worker_join_error(&owner);
        let unaffected = !replacement.cancelled();
        replacement
            .finish(Instant::now() + analysis_execution::CLEANUP_TIMEOUT)
            .unwrap();
        assert!(unaffected);
        assert_eq!(
            serde_json::to_value(error).unwrap()["code"],
            "analysis_failed"
        );
    }

    #[test]
    fn child_environment_injects_provider_secret_without_putting_it_in_payload() {
        let mut environment = ChildEnvironment::default();
        inject_provider_secret(
            &mut environment,
            "deepseek",
            Some("test-deepseek-secret".to_string()),
        );

        assert!(environment.vars.contains(&(
            "DEEPSEEK_API_KEY".to_string(),
            "test-deepseek-secret".to_string()
        )));
        assert!(!environment
            .vars
            .iter()
            .any(|(name, _)| name == "OPENAI_API_KEY"));
        assert_eq!(environment.secrets, vec!["test-deepseek-secret"]);
    }

    #[test]
    fn child_environment_isolates_credentials_for_the_selected_provider() {
        let mut environment = ChildEnvironment::default();
        isolate_provider_credentials(&mut environment, "deepseek");

        assert!(environment
            .removed_vars
            .contains(&"OPENAI_API_KEY".to_string()));
        assert!(!environment
            .removed_vars
            .contains(&"DEEPSEEK_API_KEY".to_string()));
    }

    #[test]
    fn runner_output_redaction_covers_plain_text_and_json() {
        let redacted = redact_text(
            r#"{"type":"error","error":"bad key test-api-secret"}"#,
            &["test-api-secret".to_string()],
        );
        assert!(!redacted.contains("test-api-secret"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn ipc_payload_sanitization_removes_all_legacy_secret_fields() {
        let payload = json!({
            "llmProvider": "openai",
            "apiKey": "legacy-provider-key",
            "alphaVantageApiKey": "legacy-alpha-key"
        });
        let safe = sanitize_payload(&payload);
        assert_eq!(
            safe.get("llmProvider"),
            Some(&Value::String("openai".to_string()))
        );
        assert!(safe.get("apiKey").is_none());
        assert!(safe.get("alphaVantageApiKey").is_none());
    }

    #[test]
    fn export_file_names_drop_paths_and_illegal_characters() {
        assert_eq!(
            safe_export_file_name("../unsafe:A*report.md", "html"),
            "unsafe_A_report.html"
        );
        assert_eq!(safe_export_file_name("   ", "md"), "EvidenceLoom_report.md");
    }

    #[test]
    fn text_export_writer_preserves_utf8() {
        let directory =
            std::env::temp_dir().join(format!("evidenceloom-export-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("report.md");

        write_text_export_file(&path, "虚构 report").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "虚构 report");
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
