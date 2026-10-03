//! Read-only, legacy-safe inventory with the same process containment as startup.
use crate::research_memory as memory;
use crate::runtime_probe::process::ProbeProcess;
use serde_json::Value;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(90);
const FAILURE: &str = "Research memory inventory could not be read.";
const OUTDATED: &str =
    "The research runtime does not support memory inventory. Rebuild or update the sidecar.";
const TIMED_OUT: &str = "Research memory inventory timed out.";
const TOO_LARGE: &str = "Research memory inventory exceeded its size limit.";

pub fn read(command: Command, ids: &[String]) -> Result<Value, String> {
    read_with_timeout(command, ids, TIMEOUT)
}

fn configure(command: &mut Command) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PYTHON_DOTENV_DISABLED", "1")
        .env("LANGSMITH_TRACING", "false")
        .env("LANGCHAIN_TRACING_V2", "false");
    for name in [
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
    ] {
        command.env_remove(name);
    }
    // Do not read the desktop secret store or pass provider credentials. Keep
    // HOME and the configured memory log path for the authoritative read only.
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.contains("API_KEY")
            || upper.contains("ACCESS_TOKEN")
            || upper.ends_with("_TOKEN")
            || upper.ends_with("_SECRET")
            || [
                "GOOGLE_APPLICATION_CREDENTIALS",
                "AWS_SESSION_TOKEN",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
            ]
            .contains(&upper.as_str())
        {
            command.env_remove(name);
        }
    }
}

fn read_with_timeout(
    mut command: Command,
    ids: &[String],
    timeout: Duration,
) -> Result<Value, String> {
    memory::validate_requested_ids(ids)?;
    let deadline = Instant::now() + timeout;
    let work_deadline = deadline - Duration::from_secs(2).min(timeout / 4);
    let mut request = serde_json::to_vec(&serde_json::json!({
        "__command":"smoke_test", "memoryInventory":true, "decisionIds":ids
    }))
    .map_err(|_| FAILURE)?;
    request.push(b'\n');
    configure(&mut command);
    let mut process = ProbeProcess::spawn(command, deadline).map_err(|_| FAILURE)?;
    let sent = process
        .child
        .stdin
        .take()
        .ok_or(FAILURE)
        .and_then(|mut stdin| stdin.write_all(&request).map_err(|_| FAILURE));
    if let Err(error) = sent {
        let _ = process.stop(deadline);
        return Err(error.into());
    }
    let Some(stdout) = process.child.stdout.take() else {
        let _ = process.stop(deadline);
        return Err(FAILURE.into());
    };
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let _ = sender.send(read_stdout(stdout));
    });
    let mut output = None;
    let mut exit = None;
    let result: Result<Vec<u8>, String> = loop {
        if Instant::now() >= work_deadline {
            break Err(TIMED_OUT.into());
        }
        if exit.is_none() {
            match process.child.try_wait() {
                Ok(status) => exit = status,
                Err(_) => break Err(FAILURE.into()),
            }
        }
        if output.is_none() {
            match receiver.try_recv() {
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(error)) => break Err(error.into()),
                Err(mpsc::TryRecvError::Disconnected) => break Err(FAILURE.into()),
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(status) = exit {
            if !status.success() {
                break Err(FAILURE.into());
            }
            if let Some(bytes) = output.take() {
                break Ok(bytes);
            }
        }
        thread::sleep(
            Duration::from_millis(10).min(work_deadline.saturating_duration_since(Instant::now())),
        );
    };
    let cleaned = process.stop(deadline).is_ok();
    if reader.is_finished() {
        let _ = reader.join();
    }
    let bytes = result?;
    if !cleaned {
        return Err(FAILURE.into());
    }
    validate_bounded(bytes, ids.to_vec(), deadline, validate_response)
}

fn validate_bounded(
    bytes: Vec<u8>,
    ids: Vec<String>,
    deadline: Instant,
    validate: impl FnOnce(&[u8], &[String]) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    if Instant::now() >= deadline {
        return Err(TIMED_OUT.into());
    }
    // CPU validation runs only after child-tree cleanup. A bounded payload can
    // finish in its worker after a timeout; callers never receive late success.
    let (sender, receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let _ = sender.send(validate(&bytes, &ids));
    });
    let result = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| {
            if matches!(error, mpsc::RecvTimeoutError::Timeout) {
                TIMED_OUT.to_owned()
            } else {
                FAILURE.to_owned()
            }
        });
    if worker.is_finished() {
        let _ = worker.join();
    }
    if Instant::now() >= deadline {
        Err(TIMED_OUT.into())
    } else {
        result?
    }
}

fn read_stdout(mut stdout: impl Read) -> Result<Vec<u8>, &'static str> {
    let mut output = Vec::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = stdout.read(&mut buffer).map_err(|_| FAILURE)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len() + count > memory::MAX_BYTES {
            return Err(TOO_LARGE);
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

fn validate_response(bytes: &[u8], ids: &[String]) -> Result<Value, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| FAILURE)?;
    let raw = raw.strip_suffix('\n').ok_or(FAILURE)?;
    let raw = raw.strip_suffix('\r').unwrap_or(raw);
    if raw.is_empty() || raw.contains(['\n', '\r']) {
        return Err(FAILURE.into());
    }
    let value = memory::parse_json(raw).map_err(|_| FAILURE)?;
    if value["type"] == "ready" || value["type"] == "runtime_ready" {
        return Err(OUTDATED.into());
    }
    memory::validate_inventory(&value, ids).map_err(|_| FAILURE)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires explicitly built sidecar and fixture memory store"]
    fn packaged_artifact_reads_saved_memory_inventory() {
        let sidecar = std::env::var_os("EVIDENCELOOM_VALIDATION_SIDECAR")
            .map(std::path::PathBuf::from)
            .expect("An explicitly built packaged sidecar must be provided.");
        let store = std::env::var_os("EVIDENCELOOM_VALIDATION_MEMORY_STORE")
            .map(std::path::PathBuf::from)
            .expect("An explicitly prepared fixture memory store must be provided.");
        assert!(
            sidecar.is_absolute() && sidecar.is_file(),
            "The packaged sidecar must be an absolute binary file."
        );
        assert!(
            store.is_absolute()
                && store
                    .parent()
                    .is_some_and(|parent| parent.is_dir() && parent.join("decisions-v1").is_dir()),
            "The fixture memory store must be an absolute path with prepared decision storage."
        );
        let bundle = memory::test_support::bundle();
        let snapshots = [
            &bundle["decision_snapshot"],
            &bundle["input_snapshot"]["decisions"][0],
        ];
        let ids: Vec<String> = snapshots
            .iter()
            .map(|snapshot| {
                snapshot["run_id"]
                    .as_str()
                    .expect("The saved fixture must contain a decision ID.")
                    .to_owned()
            })
            .collect();
        let dir = std::env::temp_dir().join(format!(
            "evidenceloom-memory-inventory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("The fixture clock must be available.")
                .as_nanos()
        ));
        std::fs::create_dir(&dir).expect("The fixture working directory must be created.");
        let mut command = Command::new(sidecar);
        command
            .current_dir(&dir)
            .env("TRADINGAGENTS_MEMORY_LOG_PATH", store);
        let result = read(command, &ids);
        std::fs::remove_dir_all(&dir).expect("The fixture working directory must be removed.");
        assert!(
            result.is_ok(),
            "The packaged sidecar must return a validated saved memory inventory."
        );
        let value = result.expect("The packaged memory inventory must be available.");
        assert!(
            value["missing_ids"].as_array().is_some_and(Vec::is_empty),
            "Both fixture decisions must be returned."
        );
        for snapshot in snapshots {
            let saved = value["reviews"]
                .as_array()
                .expect("The packaged inventory must contain reviews.")
                .iter()
                .find(|review| review["decision_id"] == snapshot["run_id"])
                .expect("Each saved fixture decision must be returned.");
            assert!(saved["snapshot"]==*snapshot,"The packaged inventory must preserve exact saved snapshots and full precision artifacts.");
        }
    }
    fn ids() -> Vec<String> {
        vec!["11111111-1111-4111-8111-111111111111".into()]
    }
    fn event() -> Value {
        serde_json::json!({"type":"memory_inventory","schema_version":1,"requested_ids":ids(),"reviews":[],"missing_ids":ids(),"timestamp":"12:00:00"})
    }
    #[test]
    fn inventory_requires_exact_cover_and_strict_single_jsonl() {
        let raw = format!("{}\n", event());
        assert_eq!(validate_response(raw.as_bytes(), &ids()), Ok(event()));
        for raw in ["{\"type\":\"ready\"}\n", "{\"type\":\"runtime_ready\"}\n"] {
            assert_eq!(
                validate_response(raw.as_bytes(), &ids()),
                Err(OUTDATED.into())
            );
        }
        for raw in [
            "{\"type\":\"error\",\"error\":\"private failure\"}\n",
            "{\"type\":\"ready\",\"type\":\"memory_inventory\"}\n",
            "{}",
            "{}\n\n",
            "{\n}\n",
        ] {
            assert_eq!(
                validate_response(raw.as_bytes(), &ids()),
                Err(FAILURE.into())
            );
        }
        for key in ["missing_ids", "requested_ids"] {
            let mut value = event();
            value[key] = serde_json::json!([]);
            assert!(validate_response(format!("{value}\n").as_bytes(), &ids()).is_err());
        }
        let mut value = event();
        value["raw_response"] = "forbidden".into();
        assert!(validate_response(format!("{value}\n").as_bytes(), &ids()).is_err());
        assert!(read_stdout(std::io::repeat(b'x').take(memory::MAX_BYTES as u64 + 1)).is_err());
    }
    #[test]
    fn slow_validation_cannot_return_a_success_after_the_total_deadline() {
        let start = Instant::now();
        let result = validate_bounded(
            Vec::new(),
            ids(),
            start + Duration::from_millis(30),
            |_, _| {
                thread::sleep(Duration::from_millis(100));
                Ok(serde_json::json!({}))
            },
        );
        assert_eq!(result, Err(TIMED_OUT.into()));
        assert!(start.elapsed() < Duration::from_millis(90));
    }
    #[cfg(unix)]
    #[test]
    fn inventory_known_smoke_has_bounded_wait_and_contained_descendants() {
        fn command(script: &str) -> Command {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", script]);
            cmd
        }
        let mut success = command("read -r request; [ \"$PYTHON_DOTENV_DISABLED\" = 1 ] && [ \"$LANGSMITH_TRACING\" = false ] || exit 1; printf '%s\\n' \"$1\"");
        success.arg("inventory-fixture").arg(event().to_string());
        assert_eq!(
            read_with_timeout(success, &ids(), Duration::from_secs(2)),
            Ok(event())
        );
        let start = Instant::now();
        assert_eq!(
            read_with_timeout(
                command("read -r request; sleep 30 & exit 0"),
                &ids(),
                Duration::from_millis(300)
            ),
            Err(TIMED_OUT.into())
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(
            read_with_timeout(
                command("read -r request; echo '{\"type\":\"error\"}'; exit 1"),
                &ids(),
                Duration::from_secs(1)
            ),
            Err(FAILURE.into())
        );
    }
}
