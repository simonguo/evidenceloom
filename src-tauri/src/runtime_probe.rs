#[path = "runtime_probe/process.rs"]
pub(crate) mod process;

use process::ProbeProcess;
use serde::Deserialize;
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_STDOUT_BYTES: usize = 64 * 1024;
const PROBE_REQUEST: &[u8] = b"{\"__command\":\"smoke_test\",\"verifyRuntime\":true}\n";

#[derive(Debug, PartialEq, Eq)]
pub enum ProbeFailure {
    Start,
    Input,
    Read,
    Wait,
    Timeout,
    OutputLimit,
    InvalidResponse,
    Outdated,
    RuntimeUnavailable,
    Cleanup,
}

impl ProbeFailure {
    pub fn message(&self) -> &'static str {
        match self {
            Self::Start => "Packaged runtime could not be started. Rebuild or reinstall the sidecar.",
            Self::Input => "Packaged runtime startup verification could not be sent.",
            Self::Read | Self::Wait => "Packaged runtime startup verification could not be completed.",
            Self::Timeout => "Packaged runtime startup verification timed out.",
            Self::OutputLimit => "Packaged runtime startup response exceeded its size limit.",
            Self::InvalidResponse => "Packaged runtime returned an invalid startup response. Rebuild or reinstall the sidecar.",
            Self::Outdated => "Packaged sidecar is outdated: runtime verification is not supported. Rebuild the sidecar.",
            Self::RuntimeUnavailable => "Packaged research runtime could not be initialized. Rebuild or reinstall the sidecar.",
            Self::Cleanup => "Packaged runtime startup cleanup could not be completed.",
        }
    }
}

pub fn uses_sidecar(mode: &str, sidecar_real: bool) -> bool {
    mode == "sidecar" || (mode == "auto" && sidecar_real)
}

pub fn probe_sidecar(path: &Path, work_dir: &Path) -> Result<(), ProbeFailure> {
    let mut command = Command::new(path);
    command.current_dir(work_dir);
    probe_command(command, PROBE_TIMEOUT)
}

fn probe_command(command: Command, timeout: Duration) -> Result<(), ProbeFailure> {
    probe_command_with_cleanup(command, timeout, ProbeProcess::stop)
}

fn probe_command_with_cleanup(
    mut command: Command,
    timeout: Duration,
    cleanup: impl FnOnce(&mut ProbeProcess, Instant) -> std::io::Result<()>,
) -> Result<(), ProbeFailure> {
    let deadline = Instant::now() + timeout;
    let work_deadline = deadline - Duration::from_secs(2).min(timeout / 4);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PYTHON_DOTENV_DISABLED", "1")
        .env("LANGSMITH_TRACING", "false")
        .env("LANGCHAIN_TRACING_V2", "false");
    let mut process = ProbeProcess::spawn(command, deadline).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            ProbeFailure::Timeout
        } else {
            ProbeFailure::Start
        }
    })?;
    let request = process
        .child
        .stdin
        .take()
        .ok_or(ProbeFailure::Input)
        .and_then(|mut stdin| {
            stdin
                .write_all(PROBE_REQUEST)
                .map_err(|_| ProbeFailure::Input)
        });
    if let Err(error) = request {
        let _ = cleanup(&mut process, deadline);
        return Err(error);
    }
    let Some(stdout) = process.child.stdout.take() else {
        let _ = cleanup(&mut process, deadline);
        return Err(ProbeFailure::Read);
    };
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        let _ = sender.send(read_stdout(stdout));
    });
    let mut output = None;
    let mut exit = None;
    let result = loop {
        if Instant::now() >= work_deadline {
            break Err(ProbeFailure::Timeout);
        }
        if exit.is_none() {
            match process.child.try_wait() {
                Ok(status) => exit = status,
                Err(_) => break Err(ProbeFailure::Wait),
            }
        }
        if output.is_none() {
            match receiver.try_recv() {
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(error)) => break Err(error),
                Err(mpsc::TryRecvError::Disconnected) => break Err(ProbeFailure::Read),
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(status) = exit {
            if !status.success() {
                break Err(ProbeFailure::RuntimeUnavailable);
            }
            if let Some(bytes) = output.as_ref() {
                break validate_response(bytes);
            }
        }
        thread::sleep(
            Duration::from_millis(10).min(work_deadline.saturating_duration_since(Instant::now())),
        );
    };
    let cleaned = cleanup(&mut process, deadline).is_ok();
    if reader.is_finished() {
        let _ = reader.join();
    }
    if result.is_ok() && !cleaned {
        Err(ProbeFailure::Cleanup)
    } else {
        result
    }
}

fn read_stdout(mut stdout: impl Read) -> Result<Vec<u8>, ProbeFailure> {
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stdout.read(&mut buffer).map_err(|_| ProbeFailure::Read)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len() + count > MAX_STDOUT_BYTES {
            return Err(ProbeFailure::OutputLimit);
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

fn validate_response(bytes: &[u8]) -> Result<(), ProbeFailure> {
    let text = std::str::from_utf8(bytes).map_err(|_| ProbeFailure::InvalidResponse)?;
    let line = text
        .strip_suffix('\n')
        .ok_or(ProbeFailure::InvalidResponse)?;
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.contains(['\n', '\r']) || line.is_empty() {
        return Err(ProbeFailure::InvalidResponse);
    }
    let response: ProbeEvent =
        serde_json::from_str(line).map_err(|_| ProbeFailure::InvalidResponse)?;
    match response {
        ProbeEvent::RuntimeReady { .. } => Ok(()),
        ProbeEvent::Ready { .. } => Err(ProbeFailure::Outdated),
        ProbeEvent::Error { .. } => Err(ProbeFailure::RuntimeUnavailable),
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum ProbeEvent {
    #[serde(rename = "runtime_ready")]
    RuntimeReady {
        #[serde(default, rename = "timestamp", deserialize_with = "read_timestamp")]
        _timestamp: Option<String>,
    },
    #[serde(rename = "ready")]
    Ready {
        #[serde(default, rename = "timestamp", deserialize_with = "read_timestamp")]
        _timestamp: Option<String>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default, rename = "timestamp", deserialize_with = "read_timestamp")]
        _timestamp: Option<String>,
        #[serde(rename = "error")]
        _error: Option<String>,
        #[serde(rename = "message")]
        _message: Option<String>,
        #[serde(rename = "messageType")]
        _message_type: Option<String>,
    },
}

fn read_timestamp<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = String::deserialize(deserializer)?;
    if valid_timestamp(&value) {
        Ok(Some(value))
    } else {
        Err(serde::de::Error::custom("invalid timestamp"))
    }
}

fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 8
        && bytes[2] == b':'
        && bytes[5] == b':'
        && [0, 1, 3, 4, 6, 7]
            .iter()
            .all(|index| bytes[*index].is_ascii_digit())
        && &value[..2] <= "23"
        && &value[3..5] <= "59"
        && &value[6..] <= "59"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires explicitly built sidecar"]
    fn packaged_artifact_verifies_actual_runtime() {
        let path = std::env::var_os("EVIDENCELOOM_VALIDATION_SIDECAR")
            .map(std::path::PathBuf::from)
            .expect("An explicitly built packaged sidecar must be provided.");
        assert!(
            path.is_absolute(),
            "The packaged sidecar path must be absolute."
        );
        let metadata = std::fs::metadata(&path)
            .unwrap_or_else(|_| panic!("The packaged sidecar must be an accessible binary file."));
        assert!(
            metadata.is_file(),
            "The packaged sidecar must be a binary file."
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(
                metadata.permissions().mode() & 0o111 != 0,
                "The packaged sidecar must be executable."
            );
        }
        let mut header = [0; 4];
        let header_read =
            std::fs::File::open(&path).and_then(|mut file| file.read_exact(&mut header));
        assert!(
            header_read.is_ok(),
            "The packaged sidecar binary header could not be read."
        );
        assert!(
            &header[..2] == b"MZ"
                || matches!(
                    header,
                    [0x7f, b'E', b'L', b'F']
                        | [0xfe, 0xed, 0xfa, 0xce]
                        | [0xce, 0xfa, 0xed, 0xfe]
                        | [0xfe, 0xed, 0xfa, 0xcf]
                        | [0xcf, 0xfa, 0xed, 0xfe]
                        | [0xca, 0xfe, 0xba, 0xbe]
                        | [0xbe, 0xba, 0xfe, 0xca]
                        | [0xca, 0xfe, 0xba, 0xbf]
                        | [0xbf, 0xba, 0xfe, 0xca]
                ),
            "An actual native packaged binary is required.",
        );
        struct ProbeDirectory(std::path::PathBuf);
        impl Drop for ProbeDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let directory_path = std::env::temp_dir().join(format!(
            "evidenceloom-packaged-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_else(|_| panic!("The validation clock must be available."))
                .as_nanos(),
        ));
        assert!(
            std::fs::create_dir(&directory_path).is_ok(),
            "The probe working directory could not be created."
        );
        let directory = ProbeDirectory(directory_path);
        let result = probe_sidecar(&path, &directory.0);
        let cleaned = std::fs::remove_dir_all(&directory.0).is_ok();
        assert!(
            cleaned,
            "The probe working directory could not be cleaned up."
        );
        assert!(
            result.is_ok(),
            "The packaged sidecar did not verify its research runtime."
        );
    }

    #[test]
    fn only_verified_runtime_ready_is_accepted() {
        assert_eq!(
            validate_response(b"{\"type\":\"runtime_ready\",\"timestamp\":\"12:34:56\"}\n"),
            Ok(())
        );
        assert_eq!(
            validate_response(b"{\"type\":\"runtime_ready\"}\r\n"),
            Ok(())
        );
        assert_eq!(
            validate_response(b"{\"type\":\"ready\"}\n"),
            Err(ProbeFailure::Outdated)
        );
        assert_eq!(
            validate_response(b"{\"type\":\"error\",\"error\":\"secret /private/file\"}\n"),
            Err(ProbeFailure::RuntimeUnavailable)
        );
        for output in [
            b"".as_slice(),
            b"not json\n",
            b"{\"type\":\"runtime_re",
            b"[]\n",
            b"{\"type\":\"runtime_ready\"}\n{\"type\":\"runtime_ready\"}\n",
            b"{\"type\":\"runtime_ready\",\"timestamp\":\"/private/path\"}\n",
            b"{\"type\":\"runtime_ready\",\"error\":\"secret\"}\n",
            b"{\"type\":\"runtime_ready\",\"error\":null}\n",
            b"{\"type\":\"runtime_ready\",\"timestamp\":null}\n",
            b"{\"type\":\"error\",\"type\":\"runtime_ready\"}\n",
            b"{\"type\":\"runtime_ready\",\"type\":\"error\"}\n",
            b"{\"type\":\"runtime_ready\",\"timestamp\":\"12:00:00\",\"timestamp\":\"12:00:00\"}\n",
            b"{\"type\":\"runtime_ready\"}",
            b"{\"type\":\"runtime_ready\"}\n\n",
        ] {
            assert_eq!(
                validate_response(output),
                Err(ProbeFailure::InvalidResponse)
            );
        }
    }

    #[test]
    fn stdout_is_bounded_and_errors_are_fixed() {
        assert_eq!(
            read_stdout(&vec![b'x'; MAX_STDOUT_BYTES + 1][..]),
            Err(ProbeFailure::OutputLimit)
        );
        for error in [
            ProbeFailure::Start,
            ProbeFailure::Input,
            ProbeFailure::Read,
            ProbeFailure::Wait,
            ProbeFailure::Timeout,
            ProbeFailure::OutputLimit,
            ProbeFailure::InvalidResponse,
            ProbeFailure::Outdated,
            ProbeFailure::RuntimeUnavailable,
            ProbeFailure::Cleanup,
        ] {
            assert!(!error.message().contains("secret"));
            assert!(!error.message().contains("/private"));
        }
    }

    #[test]
    fn diagnostics_match_the_selected_runner() {
        assert!(uses_sidecar("sidecar", false));
        assert!(uses_sidecar("sidecar", true));
        assert!(uses_sidecar("auto", true));
        assert!(!uses_sidecar("auto", false));
        assert!(!uses_sidecar("python", true));
    }

    #[test]
    #[cfg(windows)]
    fn windows_probe_stops_waiting_and_orphaned_descendants() {
        struct FixtureDirectory(std::path::PathBuf);
        impl Drop for FixtureDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        // Compile once for all three cases; no shell or real research runtime is used.
        let path = std::env::temp_dir().join(format!(
            "evidenceloom-windows-probe-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        assert!(
            std::fs::create_dir(&path).is_ok(),
            "The Windows probe fixture directory could not be created."
        );
        let directory = FixtureDirectory(path);
        let source = directory.0.join("fixture.rs");
        let binary = directory.0.join("fixture.exe");
        let source_text = r#"
use std::{env, fs, io::{self, Read, Write}, path::Path, process::{self, Command, Stdio}, thread, time::{Duration, Instant}};

fn main() {
    let args: Vec<_> = env::args_os().collect();
    let mode = args[1].to_str().unwrap();
    let started = Path::new(&args[2]);
    let released = Path::new(&args[3]);
    let completed = Path::new(&args[4]);
    if mode == "child" {
        fs::write(started, process::id().to_string()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !released.exists() {
            if Instant::now() >= deadline { process::exit(4); }
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_secs(1));
        fs::write(completed, b"descendant survived cleanup").unwrap();
        return;
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    if input != "{\"__command\":\"smoke_test\",\"verifyRuntime\":true}\n"
        || env::var("PYTHON_DOTENV_DISABLED").as_deref() != Ok("1")
        || env::var("LANGSMITH_TRACING").as_deref() != Ok("false")
        || env::var("LANGCHAIN_TRACING_V2").as_deref() != Ok("false") {
        process::exit(2);
    }
    let mut child = Command::new(env::current_exe().unwrap());
    child.arg("child").args(&args[2..]).stdin(Stdio::null()).stderr(Stdio::null());
    if mode == "detached" {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
        }
        // NUL stdio does not prevent inheritance of the parent's original pipe handle.
        if unsafe { SetHandleInformation(io::stdout().as_raw_handle(), 1, 0) } == 0 {
            process::exit(5);
        }
        child.stdout(Stdio::null());
    }
    let mut child = child.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !started.exists() {
        if Instant::now() >= deadline { process::exit(3); }
        thread::sleep(Duration::from_millis(5));
    }
    println!("{{\"type\":\"runtime_ready\"}}");
    io::stdout().flush().unwrap();
    if mode == "waiting" { let _ = child.wait(); }
}
"#;
        assert!(
            std::fs::write(&source, source_text).is_ok(),
            "The Windows probe fixture source could not be written."
        );
        let compiled = Command::new("rustc")
            .args(["--edition=2021", "--crate-name", "probe_fixture"])
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        assert!(compiled, "The Windows probe fixture could not be compiled.");

        for (mode, expected) in [
            ("waiting", Err(ProbeFailure::Timeout)),
            ("held_stdout", Err(ProbeFailure::Timeout)),
            ("detached", Ok(())),
        ] {
            let started_marker = directory.0.join(format!("{mode}-started"));
            let released_marker = directory.0.join(format!("{mode}-released"));
            let completed_marker = directory.0.join(format!("{mode}-completed"));
            let mut command = Command::new(&binary);
            command.args([
                std::ffi::OsStr::new(mode),
                started_marker.as_os_str(),
                released_marker.as_os_str(),
                completed_marker.as_os_str(),
            ]);
            let before = Instant::now();
            let result = probe_command(command, Duration::from_secs(3));
            let elapsed = before.elapsed();
            let child_started = std::fs::read_to_string(&started_marker)
                .ok()
                .is_some_and(|pid| pid.parse::<u32>().is_ok_and(|pid| pid > 0));
            // Any surviving descendant now has an opportunity to prove it is alive.
            // Release after the probe returns so even timeout cases cannot complete early.
            let released = std::fs::write(&released_marker, b"probe returned").is_ok();
            thread::sleep(Duration::from_millis(1500));
            assert!(released, "The Windows probe fixture could not be released.");
            assert!(
                child_started,
                "The Windows probe fixture descendant did not start."
            );
            assert!(
                !completed_marker.exists(),
                "A Windows probe fixture descendant survived cleanup."
            );
            assert_eq!(
                result, expected,
                "The Windows probe fixture result was invalid."
            );
            assert!(
                elapsed < Duration::from_secs(4),
                "The Windows probe fixture exceeded its total deadline."
            );
        }
        assert!(
            std::fs::remove_dir_all(&directory.0).is_ok(),
            "The Windows probe fixture directory could not be cleaned up."
        );
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    #[cfg(unix)]
    fn subprocess_requires_exit_success_and_legacy_safe_request() {
        let valid = r#"payload=$(cat); test "$payload" = '{"__command":"smoke_test","verifyRuntime":true}' || exit 5; test "$PYTHON_DOTENV_DISABLED/$LANGSMITH_TRACING/$LANGCHAIN_TRACING_V2" = '1/false/false' || exit 6; printf '%s\n' '{"type":"runtime_ready"}'; printf '%s\n' 'secret /private/file' >&2"#;
        assert_eq!(probe_command(shell(valid), Duration::from_secs(2)), Ok(()));
        assert_eq!(
            probe_command(
                shell("cat >/dev/null; echo '{\"type\":\"ready\"}'"),
                Duration::from_secs(2)
            ),
            Err(ProbeFailure::Outdated)
        );
        assert_eq!(
            probe_command(
                shell("cat >/dev/null; echo '{\"type\":\"runtime_ready\"}'; exit 1"),
                Duration::from_secs(2)
            ),
            Err(ProbeFailure::RuntimeUnavailable)
        );
        assert_eq!(probe_command(shell("cat >/dev/null; echo '{\"type\":\"error\",\"error\":\"secret /private/file\"}'"), Duration::from_secs(2)), Err(ProbeFailure::RuntimeUnavailable));
        assert_eq!(
            probe_command(
                shell("cat >/dev/null; printf '{\"type\":\"runtime_re'"),
                Duration::from_secs(2)
            ),
            Err(ProbeFailure::InvalidResponse)
        );
    }

    #[test]
    #[cfg(unix)]
    fn cleanup_failure_cannot_report_a_healthy_runtime_or_erase_the_original_failure() {
        for (event, expected) in [
            ("runtime_ready", ProbeFailure::Cleanup),
            ("ready", ProbeFailure::Outdated),
        ] {
            let script = format!("cat >/dev/null; echo '{{\"type\":\"{event}\"}}'");
            let result = probe_command_with_cleanup(
                shell(&script),
                Duration::from_secs(2),
                |process, deadline| {
                    process.stop(deadline)?;
                    Err(std::io::Error::other("private cleanup error /private/path"))
                },
            );
            assert_eq!(result, Err(expected));
        }
    }

    #[test]
    #[cfg(unix)]
    fn timeout_stops_the_probe_and_its_descendant() {
        assert_tree_cleanup("wait", Err(ProbeFailure::Timeout), false);
        assert_tree_cleanup("exit0", Err(ProbeFailure::Timeout), false);
        assert_tree_cleanup("exit1", Err(ProbeFailure::RuntimeUnavailable), false);
    }

    #[test]
    #[cfg(unix)]
    fn successful_probe_stops_descendants_even_after_the_parent_exits() {
        assert_tree_cleanup("ready", Ok(()), true);
    }

    #[cfg(unix)]
    fn cleanup_fixture_binary() -> &'static Path {
        static BINARY: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        BINARY
            .get_or_init(|| {
                let root =
                    cleanup_fixture_root().join(format!("probe-compiled-{}", std::process::id()));
                std::fs::create_dir_all(&root).unwrap();
                let source = root.join("fixture.rs");
                let binary = root.join("fixture");
                std::fs::write(&source, include_str!("runtime_probe/cleanup_fixture.rs")).unwrap();
                let compiled = Command::new("rustc")
                    .arg("--edition=2021")
                    .arg(&source)
                    .arg("-o")
                    .arg(&binary)
                    .output()
                    .unwrap();
                std::fs::write(root.join("compile.stdout"), &compiled.stdout).unwrap();
                std::fs::write(root.join("compile.stderr"), &compiled.stderr).unwrap();
                assert!(
                    compiled.status.success(),
                    "probe fixture compilation failed"
                );
                binary
            })
            .as_path()
    }

    #[cfg(unix)]
    fn cleanup_fixture_root() -> std::path::PathBuf {
        std::env::var_os("EVIDENCELOOM_LIFECYCLE_FIXTURE_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("target/lifecycle-fixtures")
            })
    }

    #[cfg(unix)]
    fn assert_tree_cleanup(mode: &str, expected: Result<(), ProbeFailure>, detached: bool) {
        let binary = cleanup_fixture_binary();
        let directory = cleanup_fixture_root().join(format!(
            "probe-case-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let marker = directory.join("pids");
        let heartbeat = directory.join("heartbeat");
        let gate = directory.join("gate");
        assert_eq!(marker.parent(), Some(directory.as_path()));
        assert_eq!(heartbeat.parent(), Some(directory.as_path()));
        assert_eq!(gate.parent(), Some(directory.as_path()));
        assert_eq!(mode == "ready", detached);
        let mut command = Command::new(binary);
        command.arg(mode).arg(&marker).arg(&heartbeat).arg(&gate);
        // This is a fixture budget, not a change to the production probe budget.
        // Two seconds for acknowledged startup leaves 1.75s work and 1.25s cleanup.
        let budget = Duration::from_secs(5);
        let started = Instant::now();
        let worker = thread::spawn(move || {
            let mut cleanup = None;
            let outcome = probe_command_with_cleanup(command, budget, |process, deadline| {
                let direct_pid = process.child.id();
                let began = Instant::now();
                let original = process.stop(deadline);
                let original_seconds = began.elapsed().as_secs_f64();
                let original_ok = original.is_ok();
                let original_error = original.as_ref().err().map(ToString::to_string);
                let reaped = matches!(process.child.try_wait(), Ok(Some(_)));
                let retry = if original_ok {
                    None
                } else {
                    let began = Instant::now();
                    Some((
                        process
                            .stop(Instant::now() + Duration::from_secs(2))
                            .is_ok(),
                        began.elapsed().as_secs_f64(),
                    ))
                };
                cleanup = Some((
                    direct_pid,
                    original_ok,
                    original_error,
                    original_seconds,
                    reaped,
                    retry,
                ));
                original
            });
            (outcome, cleanup)
        });
        let acknowledgement_deadline = started + Duration::from_secs(2);
        let mut acknowledged = None;
        let mut first_counter = None;
        while Instant::now() < acknowledgement_deadline && !worker.is_finished() {
            let pids = std::fs::read_to_string(&marker).ok().and_then(|raw| {
                let ids = raw
                    .lines()
                    .map(str::parse::<u32>)
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?;
                (ids.len() == 2 && ids.iter().all(|pid| *pid > 0)).then_some(ids)
            });
            let counter = std::fs::read_to_string(&heartbeat)
                .ok()
                .and_then(|raw| raw.lines().rev().find_map(|line| line.parse::<u64>().ok()));
            if let (Some(pids), Some(counter)) = (pids, counter) {
                if first_counter.is_some_and(|first| counter > first) {
                    acknowledged = Some(pids);
                    break;
                }
                first_counter.get_or_insert(counter);
            }
            thread::sleep(Duration::from_millis(5));
        }
        let acknowledgement_seconds = started.elapsed().as_secs_f64();
        // Finally always releases the gate and consumes the bounded worker result,
        // before any observation assertion can panic. Only owned handles are stopped.
        let gate_written = std::fs::write(&gate, b"release").is_ok();
        let join_deadline = started + budget + Duration::from_secs(3);
        while !worker.is_finished() && Instant::now() < join_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let joined = if worker.is_finished() {
            Some(worker.join())
        } else {
            None
        };
        let elapsed_seconds = started.elapsed().as_secs_f64();
        let observation = match &joined {
            Some(Ok((
                outcome,
                Some((pid, original_ok, original_error, seconds, reaped, retry)),
            ))) => {
                serde_json::json!({"outcome":format!("{outcome:?}"),"originalCleanupCalled":1,"directPid":pid,
                    "originalCleanupOk":original_ok,"originalCleanupError":original_error,"originalCleanupSeconds":seconds,
                    "directChildReaped":reaped,"supervisorRetry":retry})
            }
            Some(Ok((outcome, None))) => {
                serde_json::json!({"outcome":format!("{outcome:?}"),"originalCleanupCalled":0})
            }
            Some(Err(_)) => serde_json::json!({"workerPanicked":true}),
            None => serde_json::json!({"workerJoined":false}),
        };
        let _ = std::fs::write(directory.join("observations.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "mode":mode,"fixtureBudgetSeconds":5,"startupAcknowledgementSeconds":acknowledgement_seconds,
            "startupAcknowledgementBudgetSeconds":2,"knownOwnedPids":acknowledged,"heartbeatAdvanced":acknowledged.is_some(),
            "gateWritten":gate_written,"workerJoined":joined.is_some(),"elapsedSeconds":elapsed_seconds,"cleanup":observation,
            "scope":"Owned fixture activity and known handles; no all-descendants-exited or product/provider acceptance"
        })).unwrap_or_default());
        let (result, cleanup) = joined
            .expect("probe fixture worker did not finish within its supervisor deadline")
            .expect("probe fixture worker panicked");
        let pids = acknowledged
            .expect("probe fixture did not acknowledge an advancing descendant within2s");
        let (direct_pid, original_ok, original_error, _, reaped, _) =
            cleanup.expect("original cleanup callback was not called");
        assert!(gate_written);
        assert_eq!(
            pids[0], direct_pid,
            "PID marker did not identify the owned direct child"
        );
        assert!(original_ok, "original cleanup failed: {original_error:?}");
        assert!(
            reaped,
            "original cleanup did not reap the owned direct child"
        );
        assert_eq!(result, expected);
        assert!(elapsed_seconds < (budget + Duration::from_secs(1)).as_secs_f64());
        for pid in pids {
            let deadline = Instant::now() + Duration::from_secs(2);
            while process_is_running(&pid.to_string()) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                !process_is_running(&pid.to_string()),
                "owned probe fixture process survived cleanup"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn tight_probe_deadline_returns_timeout_without_claiming_descendant_start() {
        let command = shell("cat >/dev/null; sleep 5");
        let started = Instant::now();
        assert_eq!(
            probe_command(command, Duration::from_millis(150)),
            Err(ProbeFailure::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    fn process_is_running(pid: &str) -> bool {
        Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .ok()
            .is_some_and(|output| {
                let status = String::from_utf8_lossy(&output.stdout);
                let status = status.trim();
                !status.is_empty() && !status.starts_with('Z')
            })
    }
}
