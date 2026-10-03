#[path = "runtime_probe/process.rs"]
mod process;

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
        assert_tree_cleanup("exit 0", Err(ProbeFailure::Timeout), false);
        assert_tree_cleanup("exit 1", Err(ProbeFailure::RuntimeUnavailable), false);
    }

    #[test]
    #[cfg(unix)]
    fn successful_probe_stops_descendants_even_after_the_parent_exits() {
        assert_tree_cleanup(
            r#"printf '%s\n' '{"type":"runtime_ready"}'; exit 0"#,
            Ok(()),
            true,
        );
    }

    #[cfg(unix)]
    fn assert_tree_cleanup(tail: &str, expected: Result<(), ProbeFailure>, detached: bool) {
        let path = std::env::temp_dir().join(format!(
            "evidenceloom-probe-pids-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let output = if detached { ">/dev/null 2>&1" } else { "" };
        let script = format!(
            r#"cat >/dev/null; sleep 30 {output} & printf '%s\n%s\n' "$$" "$!" > "$1"; {tail}"#
        );
        let mut command = shell(&script);
        command.arg("probe-fixture").arg(&path);
        let started = Instant::now();
        let budget = if expected.is_ok() {
            Duration::from_secs(5)
        } else {
            Duration::from_secs(1)
        };
        let result = probe_command(command, budget);
        assert_eq!(result, expected);
        assert!(started.elapsed() < budget + Duration::from_secs(1));
        let pids = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(pids.lines().count(), 2);
        for pid in pids.lines() {
            let deadline = Instant::now() + Duration::from_secs(2);
            while process_is_running(pid) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                !process_is_running(pid),
                "probe fixture process {pid} survived timeout"
            );
        }
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
