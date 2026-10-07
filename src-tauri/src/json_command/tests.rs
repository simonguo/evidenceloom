use super::*;
use crate::{ApplicationEnvironment, ChildEnvironment, JsonCommandContext};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, OnceLock},
    thread::JoinHandle,
};

static BINARY: OnceLock<PathBuf> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    std::env::var_os("EVIDENCELOOM_JSON_COMMAND_FIXTURE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/json-command-fixtures")
        })
}

fn binary() -> &'static PathBuf {
    BINARY.get_or_init(|| {
        let directory = root().join(format!("compiled-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("fixture.rs");
        let binary = directory.join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        fs::write(&source, include_str!("fixture.rs")).unwrap();
        let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let output = Command::new(compiler)
            .args(["--edition=2021"])
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        fs::write(directory.join("compile.stdout"), &output.stdout).unwrap();
        fs::write(directory.join("compile.stderr"), &output.stderr).unwrap();
        assert!(output.status.success(), "owned JSON fixture compile failed");
        binary.canonicalize().unwrap()
    })
}

struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let _ = binary();
        let directory = root().join(format!(
            "case-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        Self {
            directory: directory.canonicalize().unwrap(),
        }
    }

    fn command(&self, mode: &str) -> Command {
        let mut command = Command::new(binary());
        command
            .arg(mode)
            .arg(&self.directory)
            .current_dir(&self.directory)
            .env_clear();
        command
    }

    fn release(&self) {
        fs::write(self.directory.join("release"), b"owned test release").unwrap();
    }

    fn await_ready(&self) {
        until(|| self.directory.join("ready").exists());
    }

    fn await_ready_with_running(&self, running: &mut Running) -> Result<(), ReadyFailure> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let failure = match running.peek_result() {
                Ok(Some(_)) => Some(ReadyFailure::Completed),
                Err(_) => Some(ReadyFailure::Disconnected),
                Ok(None) => None,
            };
            if let Some(failure) = failure {
                self.record_ready_failure(failure, running)?;
                return Err(failure);
            }
            if self.directory.join("ready").exists() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                self.record_ready_failure(ReadyFailure::Timeout, running)?;
                return Err(ReadyFailure::Timeout);
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn record_ready_failure(
        &self,
        failure: ReadyFailure,
        running: &Running,
    ) -> Result<(), ReadyFailure> {
        let value = json!({
            "failure":format!("{failure:?}"),
            "readyObserved":self.directory.join("ready").exists(),
            "inputObserved":self.directory.join("input").exists(),
            "originalResultCached":running.cached_result.as_ref().map(running_result_summary),
            "callerHandleFinished":running.handle.as_ref().is_some_and(|handle| handle.is_finished()),
            "actualCallerJoinObserved":false,
            "cleanupCertified":false
        });
        fs::write(
            self.directory.join("ready-observation.json"),
            value.to_string(),
        )
        .map_err(|_| ReadyFailure::EvidenceWrite)
    }

    fn counter(&self) -> u64 {
        fs::read_to_string(self.directory.join("heartbeat"))
            .unwrap()
            .lines()
            .filter_map(|line| line.parse().ok())
            .next_back()
            .unwrap()
    }

    fn assert_descendant_stopped(&self) {
        // The fixture acknowledges a heartbeat before closing stdin/exiting.
        // Compare gated post-cleanup behavior as well as the exact owner state.
        let first = self.counter();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(first, self.counter(), "owned descendant still writing");
    }

    fn raw(&self, supervisor: &Supervisor, mode: &str) -> Output {
        supervisor
            .execute_with_policy(CommandKind::Chart, self.command(mode), None, policy())
            .unwrap()
    }

    fn json(&self, supervisor: &Supervisor, mode: &str) -> Result<Value, String> {
        let environment = ApplicationEnvironment::owned(&root(), binary()).unwrap();
        let context = JsonCommandContext {
            dependencies: &environment,
            supervisor,
            kind: CommandKind::Instrument,
        };
        let args = vec![
            mode.into(),
            self.directory.to_string_lossy().into_owned(),
            "literal-$()-argument".into(),
            root()
                .canonicalize()
                .unwrap()
                .join("work")
                .to_string_lossy()
                .into_owned(),
        ];
        crate::run_json_command(
            &context,
            binary(),
            &args,
            &json!({"query": "fictional instrument"}),
            &self.directory,
            ChildEnvironment {
                vars: vec![(
                    "EVIDENCELOOM_LLM_PROVIDER".into(),
                    "fictional-public".into(),
                )],
                removed_vars: Vec::new(),
                secrets: vec!["fictional-secret".into()],
            },
            "Owned fixture",
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // A failing assertion must also release only this owned fixture's gate.
        let _ = fs::write(self.directory.join("release"), b"owned fallback release");
        // Preserve fictional fixture evidence under the supplied test root.
    }
}

fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "owned fixture acknowledgement timed out"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn policy() -> Policy {
    Policy {
        timeout: Duration::from_secs(10),
        ..Policy::default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadyFailure {
    Completed,
    Disconnected,
    Timeout,
    EvidenceWrite,
}

fn running_result_summary(result: &Result<Output, CommandFailure>) -> Value {
    match result {
        Ok(output) => json!({
            "kind":"output",
            "exitSuccess":output.status.success(),
            "exitCode":output.status.code(),
            "exitStatus":format!("{:?}", output.status),
            "stdoutBytes":output.stdout.len(),
            "stderrBytes":output.stderr.len()
        }),
        Err(error) => json!({
            "kind":"failure",
            "cause":format!("{:?}", error.cause),
            "cleanupPending":error.cleanup_pending,
            "message":error.message(),
            "returnedRawStreamsAvailable":false
        }),
    }
}

fn record_running_result(directory: &Path, result: &Result<Output, CommandFailure>) {
    let write = || -> io::Result<()> {
        if let Ok(output) = result {
            fs::write(directory.join("running.stdout.raw"), &output.stdout)?;
            fs::write(directory.join("running.stderr.raw"), &output.stderr)?;
        }
        fs::write(
            directory.join("running-result.json"),
            json!({
                "actualOriginalCallerResultObserved":true,
                "result":running_result_summary(result),
                "actualCallerJoinObserved":false,
                "cleanupCertified":false
            })
            .to_string(),
        )
    };
    if let Err(error) = write() {
        eprintln!(
            "owned running result evidence write failed: {:?}",
            error.kind()
        );
    }
}

fn record_running_join(directory: &Path, panicked: bool, cached: bool) -> io::Result<()> {
    fs::write(
        directory.join("running-join.json"),
        json!({
            "actualOriginalCallerJoinObserved":true,
            "callerPanicked":panicked,
            "cachedOriginalResultObserved":cached,
            "cleanupCertified":false
        })
        .to_string(),
    )
}

struct DiagnosticCapture {
    trace: Arc<WorkerTrace>,
    attached: Receiver<OwnershipObservation>,
    observation: Option<OwnershipObservation>,
    attached_state: &'static str,
    observed_exit: Receiver<ExitStatus>,
    exit: Option<ExitStatus>,
    exit_state: &'static str,
}
impl DiagnosticCapture {
    fn snapshot(&mut self) -> Value {
        if self.observation.is_none() {
            match self.attached.try_recv() {
                Ok(exact) => {
                    self.observation = Some(exact);
                    self.attached_state = "received";
                }
                Err(TryRecvError::Empty) => self.attached_state = "empty",
                Err(TryRecvError::Disconnected) => self.attached_state = "disconnected",
            }
        }
        if self.exit.is_none() {
            match self.observed_exit.try_recv() {
                Ok(status) => {
                    self.exit = Some(status);
                    self.exit_state = "received";
                }
                Err(TryRecvError::Empty) => self.exit_state = "empty",
                Err(TryRecvError::Disconnected) => self.exit_state = "disconnected",
            }
        }
        json!({
            "trace":self.trace.snapshot(),
            "attachedWitnessState":self.attached_state,
            "exactAttachedOwnerRetained":self.observation.as_ref().map(OwnershipObservation::retained),
            "observedExitWitnessState":self.exit_state,
            "originalChildExit":self.exit.as_ref().map(|status| json!({
                "status":format!("{status:?}"),"code":status.code(),"success":status.success()
            })),
            "cleanupCertified":false
        })
    }
}

struct Running {
    result: Receiver<Result<Output, CommandFailure>>,
    cached_result: Option<Result<Output, CommandFailure>>,
    handle: Option<JoinHandle<()>>,
    directory: PathBuf,
    diagnostic: Option<DiagnosticCapture>,
}
impl Running {
    fn record_diagnostic(&mut self, cut: &str, joined: bool, panicked: bool) {
        if let Some(diagnostic) = &mut self.diagnostic {
            let value = json!({
                "fixtureDirectory":self.directory,
                "cut":cut,
                "diagnostic":diagnostic.snapshot(),
                "readyObserved":self.directory.join("ready").exists(),
                "inputObserved":self.directory.join("input").exists(),
                "originalResultCached":self.cached_result.as_ref().map(running_result_summary),
                "callerHandleFinished":self.handle.as_ref().map(JoinHandle::is_finished),
                "actualOriginalCallerJoinObserved":joined,
                "callerPanicked":panicked,
                "cleanupCertified":false
            });
            let bytes = value.to_string();
            if bytes.len() > 8192 {
                eprintln!("owned worker diagnostic byte limit exceeded");
                return;
            }
            if let Err(error) = fs::write(
                self.directory.join(format!("worker-diagnostic-{cut}.json")),
                bytes,
            ) {
                eprintln!(
                    "owned worker diagnostic evidence write failed: {:?}",
                    error.kind()
                );
            }
        }
    }

    fn peek_result(&mut self) -> Result<Option<&Result<Output, CommandFailure>>, TryRecvError> {
        if self.cached_result.is_none() {
            match self.result.try_recv() {
                Ok(result) => self.cached_result = Some(result),
                Err(TryRecvError::Empty) => return Ok(None),
                Err(error) => return Err(error),
            }
        }
        Ok(self.cached_result.as_ref())
    }

    fn finish(mut self) -> Result<Output, CommandFailure> {
        let cached = self.cached_result.is_some();
        let result = self
            .cached_result
            .take()
            .unwrap_or_else(|| self.result.recv_timeout(Duration::from_secs(12)).unwrap());
        let joined = self.handle.take().unwrap().join();
        record_running_join(&self.directory, joined.is_err(), cached).unwrap();
        self.record_diagnostic("caller-join", true, joined.is_err());
        joined.unwrap();
        result
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let joined = handle.join();
            if let Err(error) = record_running_join(
                &self.directory,
                joined.is_err(),
                self.cached_result.is_some(),
            ) {
                eprintln!(
                    "owned running join evidence write failed: {:?}",
                    error.kind()
                );
            }
            self.record_diagnostic("caller-join", true, joined.is_err());
        }
    }
}

fn launch(
    supervisor: &Arc<Supervisor>,
    fixture: &Fixture,
    mode: &str,
    input: Option<Value>,
    policy: Policy,
) -> Running {
    launch_command(supervisor, fixture, fixture.command(mode), input, policy)
}

fn launch_command(
    supervisor: &Arc<Supervisor>,
    fixture: &Fixture,
    command: Command,
    input: Option<Value>,
    policy: Policy,
) -> Running {
    let supervisor = supervisor.clone();
    let directory = fixture.directory.clone();
    let result_directory = directory.clone();
    let (send, result) = mpsc::channel();
    let handle = thread::spawn(move || {
        let outcome =
            supervisor.execute_with_policy(CommandKind::Chart, command, input.as_ref(), policy);
        record_running_result(&result_directory, &outcome);
        let _ = send.send(outcome);
    });
    Running {
        result,
        cached_result: None,
        handle: Some(handle),
        directory,
        diagnostic: None,
    }
}

fn launch_with_setup(
    supervisor: &Arc<Supervisor>,
    fixture: &Fixture,
    mode: &str,
    input: Option<Value>,
    policy: Policy,
    setup: WorkerSetup,
) -> Running {
    let supervisor = supervisor.clone();
    let trace = setup.trace.clone();
    let command = fixture.command(mode);
    let directory = fixture.directory.clone();
    let result_directory = directory.clone();
    let (send, result) = mpsc::channel();
    let handle = thread::spawn(move || {
        let outcome = supervisor.execute_with_setup(
            CommandKind::Chart,
            command,
            input.as_ref(),
            policy,
            setup,
        );
        diagnostic_mark(&trace, "caller_result_returned");
        record_running_result(&result_directory, &outcome);
        let _ = send.send(outcome);
    });
    Running {
        result,
        cached_result: None,
        handle: Some(handle),
        directory,
        diagnostic: None,
    }
}

struct HeldWorker {
    release: Option<mpsc::Sender<()>>,
    entered: Receiver<()>,
}
impl HeldWorker {
    fn new() -> (Self, WorkerFault) {
        let (release, gate) = mpsc::channel();
        let (entered, acknowledgement) = mpsc::channel();
        (
            Self {
                release: Some(release),
                entered: acknowledgement,
            },
            WorkerFault::Hold {
                entered,
                release: gate,
            },
        )
    }

    fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}
impl Drop for HeldWorker {
    fn drop(&mut self) {
        // Sender drop also releases recv on every assertion/early-error path.
        drop(self.release.take());
    }
}

fn creation_failure_setup(
    worker: usize,
    preceding: WorkerFault,
    attached: mpsc::Sender<OwnershipObservation>,
) -> WorkerSetup {
    match worker {
        2 => WorkerSetup {
            stdout: preceding,
            stderr: WorkerFault::CreationFailure,
            attached: Some(attached),
            ..WorkerSetup::default()
        },
        3 => WorkerSetup {
            stderr: preceding,
            input: WorkerFault::CreationFailure,
            attached: Some(attached),
            ..WorkerSetup::default()
        },
        _ => panic!("only owned second/third worker failures are requested"),
    }
}

fn short_policy() -> Policy {
    Policy {
        timeout: Duration::from_secs(2),
        ..policy()
    }
}

fn owner_count(supervisor: &Supervisor) -> usize {
    supervisor
        .pool
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .owners
        .len()
}

#[test]
fn input_encoding_bounds_serialized_bytes_and_preserves_compact_json() {
    let value = json!({"message": "quote \" and 中文"});
    let expected = value.to_string().into_bytes();
    assert_eq!(encode_input(&value, expected.len()).unwrap(), expected);
    assert_eq!(
        encode_input(&value, expected.len() - 1),
        Err(Cause::InputLimit)
    );
}

#[test]
fn both_output_streams_have_exact_caps_and_fixed_read_failures() {
    for overflow in [Cause::StdoutLimit, Cause::StderrLimit] {
        assert_eq!(read_bounded(&b"1234"[..], 4, overflow).unwrap(), b"1234");
        assert_eq!(read_bounded(&b"12345"[..], 4, overflow), Err(overflow));
    }
    struct FailedRead;
    impl Read for FailedRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fictional-secret read failure"))
        }
    }
    assert_eq!(
        read_bounded(FailedRead, 4, Cause::StdoutLimit),
        Err(Cause::Read)
    );
    assert!(!CommandFailure::complete(Cause::Read)
        .message()
        .contains("fictional-secret"));
}

#[test]
fn json_callers_preserve_result_redaction_utf8_errors_and_parse_excerpt() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    assert_eq!(
        fixture.json(&supervisor, "pretty").unwrap(),
        json!({"ok":true,"message":"[REDACTED]"})
    );
    assert_eq!(
        fixture.json(&supervisor, "lossy").unwrap(),
        json!({"message":"\u{fffd}"})
    );
    assert_eq!(
        fixture.json(&supervisor, "error").unwrap_err(),
        "[REDACTED] concrete failure"
    );
    let error = fixture.json(&supervisor, "invalid").unwrap_err();
    assert!(error.starts_with("Failed to parse Owned fixture output:"));
    assert_eq!(error.rsplit_once("Output: ").unwrap().1, "x".repeat(500));
    assert_eq!(
        crate::readable_runner_error("{\"error\":\"stdout\"}", "{\"message\":\"stderr\"}"),
        "stderr"
    );
    assert_eq!(
        crate::readable_runner_error("", ""),
        "Runner exited without an error message."
    );
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn decoded_json_error_redacts_escaped_credential_after_stderr_selection() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    assert_eq!(
        fixture.json(&supervisor, "escaped-error").unwrap_err(),
        "[REDACTED] concrete failure"
    );
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn decoded_json_message_redacts_escaped_credential_after_stdout_fallback() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    assert_eq!(
        fixture.json(&supervisor, "escaped-message").unwrap_err(),
        "[REDACTED] stdout failure"
    );
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn decoded_json_success_redacts_nested_strings_and_preserves_ordinary_shape() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    assert_eq!(
        fixture.json(&supervisor, "escaped-success").unwrap(),
        json!({
            "ok":true,
            "message":"[REDACTED]",
            "nested":{
                "values":["ordinary","[REDACTED]",{"message":"prefix-[REDACTED]-suffix"}],
                "[REDACTED]":"ordinary marker key"
            },
            "count":3,
            "empty":null,
            "flag":false
        })
    );
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn decoded_json_secret_key_rejects_response_without_renaming_or_collapsing_fields() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    assert_eq!(
        fixture.json(&supervisor, "escaped-key").unwrap_err(),
        "Runner output contains a credential in a field name."
    );
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn decoded_json_python_ohlcv_time_redacts_escaped_credential_and_preserves_typed_shape() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let output = fixture.raw(&supervisor, "escaped-chart-time");
    assert!(output.status.success());
    assert_eq!(owner_count(&supervisor), 0);
    assert!(fs::read(fixture.directory.join("input"))
        .unwrap()
        .is_empty());
    let secrets = vec![String::new(), "fictional-secret".into()];
    let stdout = crate::redact_text(String::from_utf8_lossy(&output.stdout).trim(), &secrets);
    assert!(!stdout.contains("fictional-secret"));
    assert!(stdout.contains(r"\u0066ictional-secret"));
    let bars = crate::parse_ohlcv_stdout(&stdout, &secrets).unwrap();
    assert_eq!(bars.len(), 2);
    assert_eq!(bars[0].time, "prefix-[REDACTED]-suffix");
    assert_eq!(
        serde_json::to_value(&bars).unwrap(),
        json!([
            {
                "time":"prefix-[REDACTED]-suffix",
                "open":1.25,"high":2.0,"low":0.5,"close":1.75,"volume":3.0
            },
            {
                "time":"2026-01-02",
                "open":10.0,"high":12.0,"low":9.0,"close":11.0,"volume":99.0
            }
        ])
    );
}

#[test]
fn decoded_json_python_ohlcv_type_error_redacts_decoded_credential_and_preserves_excerpt() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let output = fixture.raw(&supervisor, "escaped-chart-number-error");
    assert!(output.status.success());
    assert_eq!(owner_count(&supervisor), 0);
    let secrets = vec!["fictional-secret".into()];
    let stdout = crate::redact_text(String::from_utf8_lossy(&output.stdout).trim(), &secrets);
    assert!(!stdout.contains("fictional-secret"));
    assert!(stdout.contains(r"\u0066ictional-secret"));
    assert!(stdout.chars().count() > 500);
    let error = crate::parse_ohlcv_stdout(&stdout, &secrets)
        .err()
        .expect("an escaped string must not parse as an OHLCV number");
    assert!(error.starts_with("Failed to parse OHLCV chart data: invalid type: string "));
    assert!(!error.contains("fictional-secret"), "{error}");
    assert!(error.contains("[REDACTED]"), "{error}");
    assert_eq!(
        error.rsplit_once("Output: ").unwrap().1,
        stdout.chars().take(500).collect::<String>()
    );
}

#[test]
fn owned_effective_executable_arguments_directory_and_public_environment_are_preserved() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    assert_eq!(
        fixture.json(&supervisor, "inspect").unwrap(),
        json!({"ok":true})
    );
    assert_eq!(
        fs::read(fixture.directory.join("input")).unwrap(),
        json!({"query":"fictional instrument"})
            .to_string()
            .as_bytes()
    );
}

#[test]
fn no_input_chart_gets_eof_and_remains_a_chart_array() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let output = supervisor
        .execute_with_policy(CommandKind::Chart, fixture.command("chart"), None, policy())
        .unwrap();
    let bars: Vec<crate::OhlcvBar> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(bars.len(), 1);
    assert_eq!(bars[0].close, 2.0);
    assert!(fs::read(fixture.directory.join("input"))
        .unwrap()
        .is_empty());
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn input_and_two_pipe_drains_progress_concurrently() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let input = json!("i".repeat(512 * 1024));
    let output = supervisor
        .execute_with_policy(
            CommandKind::ConnectionTest,
            fixture.command("fill-both"),
            Some(&input),
            policy(),
        )
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, vec![b'o'; 192 * 1024]);
    assert_eq!(output.stderr, vec![b'e'; 96 * 1024]);
    assert_eq!(
        fs::read(fixture.directory.join("input")).unwrap(),
        input.to_string().as_bytes()
    );
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn never_read_stdin_and_never_exit_are_bounded_and_clean_up_descendants() {
    for mode in ["never-read", "wait"] {
        let fixture = Fixture::new();
        let supervisor = Supervisor::default();
        let input = json!("i".repeat(512 * 1024));
        let started = Instant::now();
        let result = supervisor.execute_with_policy(
            CommandKind::Instrument,
            fixture.command(mode),
            Some(&input),
            Policy {
                timeout: Duration::from_secs(2),
                ..policy()
            },
        );
        let elapsed = started.elapsed();
        let error = result.unwrap_err();
        assert_eq!(error.cause, Cause::Timeout);
        assert!(!error.cleanup_pending);
        assert!(
            elapsed < Duration::from_secs(4),
            "deadline scheduling allowance exceeded"
        );
        assert!(
            fixture.directory.join("ready").exists(),
            "fixture never acknowledged descendant startup"
        );
        assert_eq!(owner_count(&supervisor), 0);
        fixture.assert_descendant_stopped();
    }
}

#[test]
fn early_stdin_write_failure_explicitly_cleans_the_acknowledged_descendant() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let result = supervisor.execute_with_policy(
        CommandKind::Instrument,
        fixture.command("closed"),
        Some(&json!("i".repeat(512 * 1024))),
        policy(),
    );
    let error = result.unwrap_err();
    assert_eq!(error.cause, Cause::Input);
    assert!(!error.cleanup_pending);
    assert!(fixture.directory.join("ready").exists());
    assert_eq!(owner_count(&supervisor), 0);
    fixture.assert_descendant_stopped();
}

#[test]
fn child_exit_starts_cleanup_before_descendant_pipe_eof() {
    for mode in ["held-stdout", "held-stderr"] {
        let fixture = Fixture::new();
        let supervisor = Supervisor::default();
        let output = supervisor
            .execute_with_policy(
                CommandKind::Chart,
                fixture.command(mode),
                Some(&json!({})),
                policy(),
            )
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({"ok":true})
        );
        assert!(fixture.directory.join("ready").exists());
        assert_eq!(owner_count(&supervisor), 0);
        fixture.assert_descendant_stopped();
    }
}

#[test]
fn output_overflow_and_missing_executable_do_not_leave_an_owner() {
    for (mode, cause) in [
        ("stdout-limit", Cause::StdoutLimit),
        ("stderr-limit", Cause::StderrLimit),
    ] {
        let fixture = Fixture::new();
        let supervisor = Supervisor::default();
        let error = supervisor
            .execute_with_policy(
                CommandKind::Chart,
                fixture.command(mode),
                Some(&json!({})),
                policy(),
            )
            .unwrap_err();
        assert_eq!(error.cause, cause);
        assert!(!error.cleanup_pending);
        assert!(!error.message().contains("xxxx"));
        assert_eq!(owner_count(&supervisor), 0);
    }
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let error = supervisor
        .execute_with_policy(
            CommandKind::Instrument,
            Command::new(fixture.directory.join("missing-owned-executable")),
            Some(&json!({})),
            policy(),
        )
        .unwrap_err();
    assert_eq!(error.cause, Cause::Start);
    assert!(!error.cleanup_pending);
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn rejected_input_never_admits_or_starts_a_process() {
    let fixture = Fixture::new();
    let supervisor = Supervisor::default();
    let error = supervisor
        .execute_with_policy(
            CommandKind::Chart,
            fixture.command("echo"),
            Some(&json!("input")),
            Policy {
                input_bytes: 3,
                ..policy()
            },
        )
        .unwrap_err();
    assert_eq!(error.cause, Cause::InputLimit);
    assert_eq!(owner_count(&supervisor), 0);
    assert!(!fixture.directory.join("input").exists());
}

#[test]
fn healthy_same_purpose_chart_requests_overlap_without_superseding() {
    let supervisor = Arc::new(Supervisor::default());
    let first = Fixture::new();
    let second = Fixture::new();
    let a = launch(&supervisor, &first, "gate", Some(json!({})), policy());
    let b = launch(&supervisor, &second, "gate", Some(json!({})), policy());
    first.await_ready();
    second.await_ready();
    let retained = owner_count(&supervisor);
    let neither_completed = matches!(a.result.try_recv(), Err(TryRecvError::Empty))
        && matches!(b.result.try_recv(), Err(TryRecvError::Empty));
    first.release();
    second.release();
    let a = a.finish().unwrap();
    let b = b.finish().unwrap();
    assert_eq!(retained, 2);
    assert!(neither_completed);
    assert!(a.status.success() && b.status.success());
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn full_pool_rejects_a_ninth_request_without_cancelling_the_eight() {
    let supervisor = Arc::new(Supervisor::default());
    let fixtures: Vec<_> = (0..MAX_OWNERS).map(|_| Fixture::new()).collect();
    let diagnostic_epoch = Instant::now();
    let mut running: Vec<_> = fixtures
        .iter()
        .map(|fixture| {
            let trace = Arc::new(WorkerTrace::new(diagnostic_epoch));
            trace.mark("test_launch");
            let (attached, observation) = mpsc::channel();
            let (exited, status) = mpsc::channel();
            let mut running = launch_with_setup(
                &supervisor,
                fixture,
                "gate",
                Some(json!({})),
                policy(),
                WorkerSetup {
                    attached: Some(attached),
                    observed_exit: Some(exited),
                    trace: Some(trace.clone()),
                    ..WorkerSetup::default()
                },
            );
            running.diagnostic = Some(DiagnosticCapture {
                trace,
                attached: observation,
                observation: None,
                attached_state: "not-polled",
                observed_exit: status,
                exit: None,
                exit_state: "not-polled",
            });
            running
        })
        .collect();
    for (index, fixture) in fixtures.iter().enumerate() {
        let ready = fixture.await_ready_with_running(&mut running[index]);
        if ready.is_err() {
            for operation in &mut running {
                operation.record_diagnostic("ready-failure-cut", false, false);
            }
        }
        ready.unwrap();
    }
    let ninth = Fixture::new();
    let started = Instant::now();
    let error = supervisor
        .execute_with_policy(
            CommandKind::Instrument,
            ninth.command("echo"),
            Some(&json!({})),
            policy(),
        )
        .unwrap_err();
    let elapsed = started.elapsed();
    let count = owner_count(&supervisor);
    for fixture in &fixtures {
        fixture.release();
    }
    let results: Vec<_> = running.into_iter().map(Running::finish).collect();
    assert_eq!(error.cause, Cause::Capacity);
    assert!(elapsed < Duration::from_secs(1));
    assert_eq!(count, MAX_OWNERS);
    assert!(!ninth.directory.join("input").exists());
    for result in results {
        assert!(result.unwrap().status.success());
    }
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn missing_executable_preserves_the_original_start_failure_through_ready_observation_and_join() {
    let fixture = Fixture::new();
    let supervisor = Arc::new(Supervisor::default());
    let missing = fixture.directory.join("owned-nonexistent-executable");
    assert!(!missing.exists());
    let mut command = Command::new(&missing);
    command.current_dir(&fixture.directory).env_clear();
    let mut running = launch_command(&supervisor, &fixture, command, Some(json!({})), policy());
    assert_eq!(
        fixture.await_ready_with_running(&mut running),
        Err(ReadyFailure::Completed)
    );
    let original = running
        .peek_result()
        .unwrap()
        .unwrap()
        .as_ref()
        .unwrap_err();
    assert_eq!(original.cause, Cause::Start);
    assert!(!original.cleanup_pending);
    assert_eq!(owner_count(&supervisor), 0);
    assert!(!fixture.directory.join("ready").exists());
    assert!(!fixture.directory.join("input").exists());
    let result_record: Value =
        serde_json::from_slice(&fs::read(fixture.directory.join("running-result.json")).unwrap())
            .unwrap();
    assert_eq!(result_record["result"]["cause"], "Start");
    assert_eq!(result_record["result"]["cleanupPending"], false);
    assert_eq!(result_record["actualCallerJoinObserved"], false);
    let original_cause = original.cause;
    let finished = running.finish().unwrap_err();
    assert_eq!(finished.cause, original_cause);
    assert!(!finished.cleanup_pending);
    let joined: Value =
        serde_json::from_slice(&fs::read(fixture.directory.join("running-join.json")).unwrap())
            .unwrap();
    assert_eq!(joined["actualOriginalCallerJoinObserved"], true);
    assert_eq!(joined["callerPanicked"], false);
    assert_eq!(joined["cachedOriginalResultObserved"], true);
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn pending_reader_is_retained_exactly_and_does_not_block_free_capacity() {
    let supervisor = Supervisor::default();
    let mut lease = supervisor.admit(CommandKind::Instrument).unwrap();
    let owner = lease.owner.clone();
    let (release, gate) = mpsc::channel();
    lease.guard().reader(thread::spawn(move || {
        let _ = gate.recv();
    }));
    let error = lease
        .finish(Some(Cause::Input), Instant::now())
        .unwrap_err();
    assert!(error.cleanup_pending && owner.observation.retained());
    assert_eq!(*owner.failure.lock().unwrap(), Some(Cause::Input));
    let fixture = Fixture::new();
    let output = supervisor
        .execute_with_policy(
            CommandKind::Chart,
            fixture.command("echo"),
            Some(&json!({"ok":true})),
            Policy {
                timeout: Duration::from_secs(2),
                ..policy()
            },
        )
        .unwrap();
    assert!(output.status.success());
    assert!(owner.observation.retained());
    assert_eq!(owner_count(&supervisor), 1);
    release.send(()).unwrap();
    supervisor.retry_pending(Instant::now() + Duration::from_secs(2));
    assert!(!owner.observation.retained());
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn concurrent_preflight_retries_only_the_original_pending_owner() {
    let fixture = Fixture::new();
    let supervisor = Arc::new(Supervisor::default());
    let mut lease = supervisor.admit(CommandKind::Instrument).unwrap();
    let owner = lease.owner.clone();
    let (release, gate) = mpsc::channel();
    lease.guard().reader(thread::spawn(move || {
        let _ = gate.recv();
    }));
    assert!(lease.finish(Some(Cause::Read), Instant::now()).is_err());
    let retrying = supervisor.clone();
    let retry = thread::spawn(move || {
        retrying.retry_pending(Instant::now() + Duration::from_secs(5));
    });
    until(|| owner.phase.load(Ordering::Acquire) == RETRYING);
    let result = supervisor.execute_with_policy(
        CommandKind::Chart,
        fixture.command("echo"),
        Some(&json!({"ok":true})),
        policy(),
    );
    release.send(()).unwrap();
    retry.join().unwrap();
    assert!(result.unwrap().status.success());
    assert!(!owner.observation.retained());
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn joined_worker_panic_is_a_failure_with_completed_cleanup() {
    let supervisor = Supervisor::default();
    let mut lease = supervisor.admit(CommandKind::Chart).unwrap();
    let handle = thread::spawn(|| panic!("fictional owned I/O worker panic"));
    until(|| handle.is_finished());
    lease.guard().reader(handle);
    let error = lease
        .finish(None, Instant::now() + Duration::from_secs(1))
        .unwrap_err();
    assert_eq!(error.cause, Cause::Worker);
    assert!(!error.cleanup_pending);
    assert!(!lease.owner.observation.retained());
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn registered_second_and_third_worker_creation_failures_release_the_exact_process() {
    for worker in [2, 3] {
        let fixture = Fixture::new();
        let supervisor = Supervisor::default();
        let (attached, observation) = mpsc::channel();
        let started = Instant::now();
        let error = supervisor
            .execute_with_setup(
                CommandKind::Chart,
                fixture.command("closed-zero"),
                Some(&json!({})),
                short_policy(),
                creation_failure_setup(worker, WorkerFault::Normal, attached),
            )
            .unwrap_err();
        let exact = observation.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(error.cause, Cause::Worker);
        assert!(!error.cleanup_pending);
        assert!(!exact.retained());
        assert_eq!(owner_count(&supervisor), 0);
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}

#[test]
fn registered_worker_creation_failure_retains_the_original_held_reader_until_exact_retry() {
    for worker in [2, 3] {
        let fixture = Fixture::new();
        let supervisor = Supervisor::default();
        let (mut held, fault) = HeldWorker::new();
        let (attached, observation) = mpsc::channel();
        let started = Instant::now();
        let error = supervisor
            .execute_with_setup(
                CommandKind::Chart,
                fixture.command("closed-zero"),
                Some(&json!({})),
                short_policy(),
                creation_failure_setup(worker, fault, attached),
            )
            .unwrap_err();
        let elapsed = started.elapsed();
        let entered = held.entered.recv_timeout(Duration::from_secs(1));
        let exact = observation.recv_timeout(Duration::from_secs(1)).unwrap();
        let owner = supervisor
            .pool
            .lock()
            .unwrap()
            .owners
            .values()
            .next()
            .unwrap()
            .clone();
        let retained_before_retry = exact.retained();
        let charged_before_retry = owner_count(&supervisor);
        let cause = *owner.failure.lock().unwrap();
        let phase = owner.phase.load(Ordering::Acquire);
        held.release();
        supervisor.retry_pending(Instant::now() + Duration::from_secs(2));
        assert!(
            entered.is_ok(),
            "registered reader never passed its start gate"
        );
        assert_eq!(error.cause, Cause::Worker);
        assert!(error.cleanup_pending && retained_before_retry);
        assert_eq!(charged_before_retry, 1);
        assert_eq!(cause, Some(Cause::Worker));
        assert_eq!(phase, PENDING);
        assert!(elapsed < Duration::from_secs(4));
        assert!(!exact.retained() && !owner.observation.retained());
        assert_eq!(owner_count(&supervisor), 0);
    }
}

#[test]
fn registered_panic_and_missing_event_never_succeed_with_released_or_held_readers() {
    for panic in [true, false] {
        for hold in [false, true] {
            let fixture = Fixture::new();
            let supervisor = Supervisor::default();
            let (mut held, blocked) = HeldWorker::new();
            let (attached, observation) = mpsc::channel();
            let (exited, status) = mpsc::channel();
            let started = Instant::now();
            let error = supervisor
                .execute_with_setup(
                    CommandKind::Chart,
                    fixture.command("closed-zero"),
                    None,
                    short_policy(),
                    WorkerSetup {
                        stdout: if panic {
                            WorkerFault::Panic
                        } else {
                            WorkerFault::Disconnect
                        },
                        stderr: if hold { blocked } else { WorkerFault::Normal },
                        attached: Some(attached),
                        observed_exit: Some(exited),
                        ..WorkerSetup::default()
                    },
                )
                .unwrap_err();
            let elapsed = started.elapsed();
            let exact = observation.recv_timeout(Duration::from_secs(1)).unwrap();
            let retained = exact.retained();
            let charged = owner_count(&supervisor);
            let entered = if hold {
                held.entered.recv_timeout(Duration::from_secs(1)).is_ok()
            } else {
                true
            };
            let observed_successful_exit = status.try_recv().is_ok_and(|status| status.success());
            held.release();
            supervisor.retry_pending(Instant::now() + Duration::from_secs(2));
            assert!(entered);
            assert_eq!(error.cleanup_pending, hold);
            assert_eq!(retained, hold);
            assert_eq!(charged, usize::from(hold));
            if hold {
                assert_eq!(error.cause, Cause::Cleanup);
                assert!(observed_successful_exit);
            } else {
                assert_eq!(error.cause, Cause::Worker);
            }
            assert!(elapsed < Duration::from_secs(4));
            assert!(!exact.retained());
            assert_eq!(owner_count(&supervisor), 0);
        }
    }
}

#[test]
fn zero_child_exit_cannot_turn_a_pending_large_input_write_failure_into_success() {
    let fixture = Fixture::new();
    let supervisor = Arc::new(Supervisor::default());
    let (mut held, fault) = HeldWorker::new();
    let (attached, observation) = mpsc::channel();
    let (exited, status) = mpsc::channel();
    let started = Instant::now();
    let running = launch_with_setup(
        &supervisor,
        &fixture,
        "closed-zero",
        Some(json!("i".repeat(768 * 1024))),
        short_policy(),
        WorkerSetup {
            input: fault,
            attached: Some(attached),
            observed_exit: Some(exited),
            ..WorkerSetup::default()
        },
    );
    let entered = held.entered.recv_timeout(Duration::from_secs(1));
    let observed_status = status.recv_timeout(Duration::from_secs(1));
    let exact = observation.recv_timeout(Duration::from_secs(1));
    let retained_before_release = exact.as_ref().is_ok_and(|owner| owner.retained());
    held.release();
    let error = running.finish().unwrap_err();
    assert!(entered.is_ok());
    assert!(
        observed_status.unwrap().success(),
        "direct child did not exit zero"
    );
    assert!(retained_before_release);
    assert_eq!(error.cause, Cause::Input);
    assert!(!error.cleanup_pending);
    assert!(!exact.unwrap().retained());
    assert_eq!(owner_count(&supervisor), 0);
    assert!(fixture.directory.join("ready").exists());
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[test]
fn caller_panic_and_closing_preserve_pending_spawn_ownership() {
    let supervisor = Supervisor::default();
    let (release, gate) = mpsc::channel();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let lease = supervisor.admit(CommandKind::Chart).unwrap();
        lease.guard().reader(thread::spawn(move || {
            let _ = gate.recv();
        }));
        panic!("fictional owned caller panic");
    }));
    assert!(outcome.is_err());
    assert_eq!(owner_count(&supervisor), 1);
    supervisor.close_admission();
    assert!(matches!(
        supervisor.admit(CommandKind::Instrument),
        Err(CommandFailure {
            cause: Cause::Cancelled,
            ..
        })
    ));
    let pending = supervisor.cleanup_all(Instant::now()).unwrap_err();
    assert!(pending.cleanup_pending);
    release.send(()).unwrap();
    supervisor
        .cleanup_all(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert_eq!(owner_count(&supervisor), 0);
}

#[test]
fn auxiliary_owners_are_independent_of_active_research() {
    let research = Arc::new(Registry::default());
    let id = research.reserve("fictional-research".into()).unwrap();
    let mut research_guard = research.start("fictional-research", &id).unwrap();
    let observation = research_guard.ownership();
    let fixture = Fixture::new();
    let auxiliary = Supervisor::default();
    let result = auxiliary.execute_with_policy(
        CommandKind::ConnectionTest,
        fixture.command("echo"),
        Some(&json!({})),
        policy(),
    );
    let still_retained = observation.retained();
    research_guard
        .finish(Instant::now() + Duration::from_secs(1))
        .unwrap();
    assert!(result.unwrap().status.success() && still_retained);
    assert!(!observation.retained());
}

#[test]
fn cancellation_before_spawn_does_not_forget_the_admitted_owner() {
    let supervisor = Supervisor::default();
    let mut lease = supervisor.admit(CommandKind::Chart).unwrap();
    supervisor.close_admission();
    assert!(supervisor.cleanup_all(Instant::now()).is_err());
    assert!(lease.owner.observation.retained());
    let fixture = Fixture::new();
    let result = prepare(
        lease.guard(),
        fixture.command("echo"),
        Some(b"{}".to_vec()),
        policy(),
        Instant::now() + Duration::from_secs(1),
        WorkerSetup::default(),
    );
    assert!(matches!(result, Err(Cause::Cancelled)));
    lease
        .finish(
            Some(Cause::Cancelled),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    supervisor
        .cleanup_all(Instant::now() + Duration::from_secs(1))
        .unwrap();
    assert_eq!(owner_count(&supervisor), 0);
    assert!(!fixture.directory.join("input").exists());

    let supervisor = Supervisor::default();
    let mut lease = supervisor.admit(CommandKind::Chart).unwrap();
    let request = lease
        .owner
        .registry
        .cancel(lease.owner.tag, &lease.owner.run_id)
        .unwrap();
    let result = lease.finish(None, Instant::now() + Duration::from_secs(1));
    request
        .wait(Instant::now() + Duration::from_secs(1))
        .unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.cause, Cause::Cancelled);
    assert!(!error.cleanup_pending);
    assert_eq!(owner_count(&supervisor), 0);
}

// UNEXECUTED: no new command purpose or replacement Registry is introduced.
#[test]
fn closed_auxiliary_pool_rejects_new_admission_after_empty_cleanup() {
    let supervisor = Supervisor::default();
    supervisor.close_admission();
    assert!(supervisor.admit(CommandKind::Instrument).is_err());
    supervisor
        .cleanup_all(Instant::now() + CLEANUP_TIMEOUT)
        .unwrap();
    assert!(supervisor.admit(CommandKind::Chart).is_err());
    assert!(supervisor.admit(CommandKind::ConnectionTest).is_err());
}
