mod secrets;
mod storage;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    runtime: Arc<RuntimeState>,
}

#[derive(Default)]
struct RuntimeState {
    processes: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    stopped_tasks: Mutex<HashSet<String>>,
}

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

#[tauri::command]
fn load_desktop_data(app: AppHandle) -> Result<storage::DesktopSnapshot, String> {
    storage::load_snapshot(&app)
}

#[tauri::command]
fn save_desktop_settings(app: AppHandle, settings: storage::StoredSettings) -> Result<(), String> {
    storage::save_settings(&app, settings)
}

#[tauri::command]
fn set_provider_secret(provider: String, value: String) -> Result<(), String> {
    secrets::set_provider_secret(&provider, &value)
}

#[tauri::command]
fn delete_provider_secret(provider: String) -> Result<(), String> {
    secrets::delete_provider_secret(&provider)
}

#[tauri::command]
fn set_alpha_vantage_secret(provider: String, value: String) -> Result<(), String> {
    let _ = provider;
    secrets::set_alpha_vantage_secret(&value)
}

#[tauri::command]
fn delete_alpha_vantage_secret(provider: String) -> Result<(), String> {
    let _ = provider;
    secrets::delete_alpha_vantage_secret()
}

#[tauri::command]
fn save_desktop_task(app: AppHandle, task: storage::AnalysisTaskRecord) -> Result<(), String> {
    storage::save_task(&app, task)
}

#[tauri::command]
fn delete_desktop_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), String> {
    stop_process_if_running(&state.runtime, &task_id)?;
    storage::delete_task(&app, task_id)
}

#[tauri::command]
fn clear_desktop_data(app: AppHandle) -> Result<(), String> {
    storage::clear_data(&app)
}

#[tauri::command]
fn import_legacy_desktop_data(
    app: AppHandle,
    legacy: storage::LegacyDesktopData,
) -> Result<storage::DesktopSnapshot, String> {
    storage::import_legacy(&app, legacy)
}

#[tauri::command]
fn runtime_info(app: AppHandle) -> RuntimeInfo {
    let repo_root = repo_root();
    RuntimeInfo {
        kind: "tauri",
        label: if runner_mode() == "sidecar" {
            "Tauri Desktop / Packaged Sidecar"
        } else {
            "Tauri Desktop / Local Python"
        },
        configured_project_root: None,
        python_path: resolve_python_path(&repo_root, None)
            .to_string_lossy()
            .to_string(),
        runner_path: runner_path(&repo_root).to_string_lossy().to_string(),
        sidecar_path: sidecar_path(Some(&app)).map(|path| path.to_string_lossy().to_string()),
        runner_mode: runner_mode().to_string(),
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
    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths() {
        payload
            .get("projectRoot")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    } else {
        None
    };
    let repo_root = effective_repo_root(configured_project_root.as_deref());
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

    let sidecar = sidecar_path(Some(&app));
    if matches!(runner_mode().as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.as_ref().filter(|path| is_real_sidecar(path)) {
            let value = run_json_command(
                sidecar_path,
                &[],
                &safe_payload,
                &runtime_work_dir(Some(&app), &repo_root),
                child_env(&app, &repo_root, &payload)?,
                "OHLCV chart sidecar",
            )?;
            return serde_json::from_value::<Vec<OhlcvBar>>(value)
                .map_err(|error| format!("Failed to parse OHLCV chart data: {error}"));
        }
        if runner_mode() == "sidecar" {
            return Err(format!(
                "Packaged OHLCV chart loader not found: {}. Tried: {}",
                sidecar
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "--".to_string()),
                sidecar_debug_paths(Some(&app))
            ));
        }
    }

    let python_override = if allow_external_runner_paths() {
        payload.get("pythonPath").and_then(Value::as_str)
    } else {
        None
    };
    let python = resolve_python_path(&repo_root, python_override);
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
    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths() {
        payload.get("projectRoot").and_then(Value::as_str)
    } else {
        None
    };
    let repo_root = effective_repo_root(configured_project_root);
    let mut safe_payload = sanitize_payload(&payload);
    if let Value::Object(map) = &mut safe_payload {
        map.insert("query".to_string(), Value::String(query));
        map.insert(
            "__command".to_string(),
            Value::String("resolve_instrument".to_string()),
        );
    }

    let sidecar = sidecar_path(Some(&app));
    if matches!(runner_mode().as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.as_ref().filter(|path| is_real_sidecar(path)) {
            return run_json_command(
                sidecar_path,
                &[],
                &safe_payload,
                &runtime_work_dir(Some(&app), &repo_root),
                child_env(&app, &repo_root, &payload)?,
                "instrument resolver sidecar",
            );
        }
        if runner_mode() == "sidecar" {
            return Err(format!(
                "Packaged instrument resolver not found: {}. Tried: {}",
                sidecar
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "--".to_string()),
                sidecar_debug_paths(Some(&app))
            ));
        }
    }

    let python = resolve_python_path(
        &repo_root,
        if allow_external_runner_paths() {
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
    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths() {
        payload.get("projectRoot").and_then(Value::as_str)
    } else {
        None
    };
    let repo_root = effective_repo_root(configured_project_root);
    let mut safe_payload = sanitize_payload(&payload);
    if let Value::Object(map) = &mut safe_payload {
        map.insert(
            "__command".to_string(),
            Value::String("test_llm".to_string()),
        );
    }

    let sidecar = sidecar_path(Some(&app));
    if matches!(runner_mode().as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.as_ref().filter(|path| is_real_sidecar(path)) {
            return run_json_command(
                sidecar_path,
                &[],
                &safe_payload,
                &runtime_work_dir(Some(&app), &repo_root),
                child_env(&app, &repo_root, &payload)?,
                "LLM test sidecar",
            );
        }
        if runner_mode() == "sidecar" {
            return Err(format!(
                "Packaged LLM test runner not found: {}. Tried: {}",
                sidecar
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|| "--".to_string()),
                sidecar_debug_paths(Some(&app))
            ));
        }
    }

    let python = resolve_python_path(
        &repo_root,
        if allow_external_runner_paths() {
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
        &python,
        &args,
        &safe_payload,
        &runtime_work_dir(Some(&app), &repo_root),
        child_env(&app, &repo_root, &payload)?,
        "LLM test runner",
    )
}

fn run_json_command(
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

#[tauri::command]
async fn start_analysis(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    payload_json: String,
) -> Result<(), String> {
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_analysis_process(app, runtime, task_id, payload_json)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn check_runtime(
    app: AppHandle,
    python_path_override: Option<String>,
    project_root: Option<String>,
) -> RuntimeCheck {
    let external_runner_allowed = allow_external_runner_paths();
    let configured_project_root = if external_runner_allowed {
        normalize_optional_path(project_root.as_deref())
    } else {
        None
    };
    let repo_root = effective_repo_root(configured_project_root.as_deref());
    let python_override = if external_runner_allowed {
        python_path_override.as_deref()
    } else {
        None
    };
    let python = resolve_python_path(&repo_root, python_override);
    let runner = runner_path(&repo_root);
    let sidecar = sidecar_path(Some(&app));
    let mode = runner_mode();
    let sidecar_real = sidecar.as_deref().map(is_real_sidecar).unwrap_or(false);
    let mut errors = Vec::new();

    let (python_exists, runner_exists, python_version, can_import_trading_agents, import_error) =
        if mode == "sidecar" {
            if !sidecar_real {
                errors.push(
                    "Sidecar binary not found or is a placeholder. Run scripts/build_tauri_sidecar.sh first."
                        .to_string(),
                );
            }
            (true, true, None, true, None)
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
                command_output(&python, &["--version"], &repo_root, false).unwrap_or_else(|error| {
                    errors.push(format!("Failed to read Python version: {error}"));
                    String::new()
                })
            } else {
                String::new()
            };

            let import_result = if python_exists {
                command_output(
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
        runner_mode: mode,
        python_exists,
        runner_exists,
        python_version,
        can_import_trading_agents,
        import_error,
        sidecar_real,
        errors,
    }
}

#[tauri::command]
fn stop_analysis(state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    {
        let mut stopped = state
            .runtime
            .stopped_tasks
            .lock()
            .map_err(|_| "failed to lock stop state")?;
        stopped.insert(task_id.clone());
    }

    stop_process_if_running(&state.runtime, &task_id)
}

fn stop_process_if_running(runtime: &RuntimeState, task_id: &str) -> Result<(), String> {
    let process = {
        let mut processes = runtime
            .processes
            .lock()
            .map_err(|_| "failed to lock process state")?;
        processes.remove(task_id)
    };

    if let Some(process) = process {
        let mut child = process.lock().map_err(|_| "failed to lock child process")?;
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => {}
            None => child.kill().map_err(|error| error.to_string())?,
        }
    }

    Ok(())
}

fn run_analysis_process(
    app: AppHandle,
    runtime: Arc<RuntimeState>,
    task_id: String,
    payload_json: String,
) -> Result<(), String> {
    ensure_no_running_process(&runtime)?;

    {
        let mut stopped = runtime
            .stopped_tasks
            .lock()
            .map_err(|_| "failed to lock stop state")?;
        stopped.remove(&task_id);
    }

    let payload =
        serde_json::from_str::<Value>(&payload_json).map_err(|error| error.to_string())?;
    let configured_project_root = if allow_external_runner_paths() {
        payload.get("projectRoot").and_then(Value::as_str)
    } else {
        None
    };
    let repo_root = effective_repo_root(configured_project_root);
    let python = resolve_python_path(
        &repo_root,
        if allow_external_runner_paths() {
            payload.get("pythonPath").and_then(Value::as_str)
        } else {
            None
        },
    );
    let runner = runner_path(&repo_root);
    let sidecar = sidecar_path(Some(&app));
    let safe_payload = sanitize_payload(&payload);

    let runner_command = resolve_runner_command(&python, &runner, sidecar.as_ref());

    emit_event(
        &app,
        &task_id,
        json!({
            "type": "message",
            "messageType": "runtime",
            "message": runner_command.description
        }),
    );

    let work_dir = runtime_work_dir(Some(&app), &repo_root);
    let child_environment = child_env(&app, &repo_root, &payload)?;
    let mut command = Command::new(&runner_command.executable);
    command
        .args(&runner_command.args)
        .current_dir(&work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    child_environment.apply(&mut command);
    let redactions = Arc::new(child_environment.secrets);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "failed to start analysis runner at {}: {}",
            runner_command.executable.to_string_lossy(),
            error
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(safe_payload.to_string().as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let python_error_emitted = Arc::new(AtomicBool::new(false));

    {
        let mut processes = runtime
            .processes
            .lock()
            .map_err(|_| "failed to lock process state")?;
        processes.insert(task_id.clone(), child.clone());
    }

    if let Some(stdout) = stdout {
        spawn_stdout_forwarder(
            app.clone(),
            task_id.clone(),
            stdout,
            python_error_emitted.clone(),
            redactions.clone(),
        );
    }
    if let Some(stderr) = stderr {
        spawn_stderr_forwarder(
            app.clone(),
            task_id.clone(),
            stderr,
            stderr_lines.clone(),
            redactions,
        );
    }

    let exit_code = loop {
        let status = {
            let mut child = child.lock().map_err(|_| "failed to lock child process")?;
            child.try_wait().map_err(|error| error.to_string())?
        };

        if let Some(status) = status {
            break status.code();
        }

        thread::sleep(Duration::from_millis(250));
    };

    {
        let mut processes = runtime
            .processes
            .lock()
            .map_err(|_| "failed to lock process state")?;
        processes.remove(&task_id);
    }

    let was_stopped = {
        let mut stopped = runtime
            .stopped_tasks
            .lock()
            .map_err(|_| "failed to lock stop state")?;
        stopped.remove(&task_id)
    };

    if !was_stopped && exit_code.unwrap_or(1) != 0 && !python_error_emitted.load(Ordering::SeqCst) {
        let stderr_tail = stderr_lines
            .lock()
            .map(|lines| lines.join("\n"))
            .unwrap_or_default();
        let error = if stderr_tail.trim().is_empty() {
            format!("Python runner exited with code {:?}", exit_code)
        } else {
            format!(
                "Python runner exited with code {:?}: {}",
                exit_code,
                tail_text(&stderr_tail, 2000)
            )
        };
        emit_event(
            &app,
            &task_id,
            json!({
                "type": "error",
                "error": error
            }),
        );
    }

    Ok(())
}

fn ensure_no_running_process(runtime: &RuntimeState) -> Result<(), String> {
    let mut processes = runtime
        .processes
        .lock()
        .map_err(|_| "failed to lock process state")?;
    let mut finished_tasks = Vec::new();

    for (task_id, process) in processes.iter() {
        let mut child = process.lock().map_err(|_| "failed to lock child process")?;
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            finished_tasks.push(task_id.clone());
        }
    }

    for task_id in finished_tasks {
        processes.remove(&task_id);
    }

    if processes.is_empty() {
        Ok(())
    } else {
        Err("已有任务正在运行。第一版桌面端暂时只允许同时运行一个任务。".to_string())
    }
}

fn spawn_stdout_forwarder(
    app: AppHandle,
    task_id: String,
    stdout: impl std::io::Read + Send + 'static,
    python_error_emitted: Arc<AtomicBool>,
    redactions: Arc<Vec<String>>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for raw_line in reader.lines().map_while(Result::ok) {
            let line = redact_text(&raw_line, &redactions);
            if line.trim().is_empty() {
                continue;
            }
            let payload = serde_json::from_str::<Value>(&line).unwrap_or_else(
                |_| json!({ "type": "message", "messageType": "stdout", "message": line }),
            );
            if payload.get("type").and_then(Value::as_str) == Some("error") {
                python_error_emitted.store(true, Ordering::SeqCst);
            }
            emit_event(&app, &task_id, payload);
        }
    });
}

fn spawn_stderr_forwarder(
    app: AppHandle,
    task_id: String,
    stderr: impl std::io::Read + Send + 'static,
    stderr_lines: Arc<Mutex<Vec<String>>>,
    redactions: Arc<Vec<String>>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for raw_line in reader.lines().map_while(Result::ok) {
            let line = redact_text(&raw_line, &redactions);
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(mut lines) = stderr_lines.lock() {
                lines.push(line.clone());
                if lines.len() > 80 {
                    lines.remove(0);
                }
            }
            emit_event(
                &app,
                &task_id,
                json!({
                    "type": "message",
                    "messageType": "stderr",
                    "message": line
                }),
            );
        }
    });
}

fn tail_text(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    text.chars().skip(char_count - max_chars).collect()
}

fn emit_event(app: &AppHandle, task_id: &str, payload: Value) {
    let _ = app.emit(&format!("analysis-event:{task_id}"), payload);
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should live under the repository root")
        .to_path_buf()
}

fn runtime_work_dir(app: Option<&AppHandle>, repo_root: &Path) -> PathBuf {
    if allow_external_runner_paths() {
        return repo_root.to_path_buf();
    }

    if let Some(app) = app {
        if let Ok(path) = app.path().app_data_dir() {
            let _ = fs::create_dir_all(&path);
            return path;
        }
    }

    env::current_dir().unwrap_or_else(|_| repo_root.to_path_buf())
}

struct RunnerCommand {
    executable: PathBuf,
    args: Vec<String>,
    description: String,
}

fn resolve_runner_command(
    python: &Path,
    runner: &Path,
    sidecar: Option<&PathBuf>,
) -> RunnerCommand {
    let mode = runner_mode();
    if matches!(mode.as_str(), "sidecar" | "auto") {
        if let Some(sidecar_path) = sidecar.filter(|path| is_real_sidecar(path)) {
            return RunnerCommand {
                executable: sidecar_path.clone(),
                args: Vec::new(),
                description: format!(
                    "Starting packaged sidecar runner: {}",
                    sidecar_path.to_string_lossy()
                ),
            };
        }
        if mode == "sidecar" {
            return RunnerCommand {
                executable: sidecar.map_or_else(|| runner.to_path_buf(), Clone::clone),
                args: Vec::new(),
                description: "Starting sidecar runner, but only a placeholder or missing sidecar was found. Build the real PyInstaller sidecar or use EVIDENCELOOM_RUNNER_MODE=python.".to_string(),
            };
        }
    }

    RunnerCommand {
        executable: python.to_path_buf(),
        args: vec![runner.to_string_lossy().to_string()],
        description: format!("Starting local Python runner: {}", python.to_string_lossy()),
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

fn runner_mode() -> String {
    let configured = env::var("EVIDENCELOOM_RUNNER_MODE")
        .or_else(|_| env::var("TRADINGAGENTS_RUNNER_MODE"))
        .unwrap_or_else(|_| "python".to_string())
        .trim()
        .to_lowercase();
    if allow_external_runner_paths() {
        configured
    } else {
        "sidecar".to_string()
    }
}

fn allow_external_runner_paths() -> bool {
    cfg!(debug_assertions)
        || env::var("EVIDENCELOOM_ALLOW_EXTERNAL_RUNNER")
            .or_else(|_| env::var("TRADINGAGENTS_ALLOW_EXTERNAL_RUNNER"))
            .map(|value| matches!(value.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
}

fn sidecar_path(app: Option<&AppHandle>) -> Option<PathBuf> {
    if let Ok(path) = env::var("EVIDENCELOOM_RUNNER_SIDECAR")
        .or_else(|_| env::var("TRADINGAGENTS_RUNNER_SIDECAR"))
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
}

fn sidecar_debug_paths(app: Option<&AppHandle>) -> String {
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
}

fn effective_repo_root(configured_path: Option<&str>) -> PathBuf {
    if let Some(path) = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return PathBuf::from(path);
    }
    repo_root()
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

fn resolve_python_path(repo_root: &Path, configured_path: Option<&str>) -> PathBuf {
    if let Some(path) = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return PathBuf::from(path);
    }

    if let Ok(path) = env::var("EVIDENCELOOM_PYTHON").or_else(|_| env::var("TRADINGAGENTS_PYTHON"))
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
}

fn command_output(
    command_path: &Path,
    args: &[&str],
    repo_root: &Path,
    with_pythonpath: bool,
) -> Result<String, String> {
    let mut command = Command::new(command_path);
    command.args(args).current_dir(repo_root);
    if with_pythonpath {
        command.env("PYTHONPATH", build_pythonpath(repo_root));
    }
    let output = command.output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn build_pythonpath(repo_root: &Path) -> String {
    match env::var("PYTHONPATH") {
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
    _app: &AppHandle,
    repo_root: &Path,
    payload: &Value,
) -> Result<ChildEnvironment, String> {
    let mut environment = ChildEnvironment::default();
    environment.push_public("PYTHONPATH", build_pythonpath(repo_root));

    let configured_provider = env::var("EVIDENCELOOM_LLM_PROVIDER")
        .ok()
        .or_else(|| env::var("TRADINGAGENTS_LLM_PROVIDER").ok());
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
    let provider_secret = secrets::get_provider_secret(&provider)?;
    inject_provider_secret(&mut environment, &provider, provider_secret);

    if let Some(alpha_key) = secrets::get_alpha_vantage_secret()? {
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
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            check_runtime,
            load_ohlcv_chart_data,
            resolve_instrument,
            test_llm_connection,
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
            import_legacy_desktop_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running Evidence Loom desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
