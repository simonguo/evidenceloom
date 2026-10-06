//! Bounded auxiliary transport, independent of the active research owner.
use crate::{
    analysis_execution::{OwnershipObservation, Registry, RunGuard, CLEANUP_TIMEOUT},
    owned_process::OwnedProcess,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    process::{Command, ExitStatus, Output, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_OWNERS: usize = 8;
const ACTIVE: u8 = 0;
const PENDING: u8 = 1;
const RETRYING: u8 = 2;

#[derive(Clone, Copy)]
pub(crate) enum CommandKind {
    Instrument,
    ConnectionTest,
    Chart,
    #[cfg(feature = "desktop-acceptance")]
    RuntimeProbe,
    #[cfg(feature = "desktop-acceptance")]
    MemoryInventory,
    #[cfg(feature = "desktop-acceptance")]
    PythonDiagnostic,
}
impl CommandKind {
    fn tag(self) -> &'static str {
        match self {
            Self::Instrument => "auxiliary-instrument",
            Self::ConnectionTest => "auxiliary-connection",
            Self::Chart => "auxiliary-chart",
            #[cfg(feature = "desktop-acceptance")]
            Self::RuntimeProbe => "acceptance-runtime-probe",
            #[cfg(feature = "desktop-acceptance")]
            Self::MemoryInventory => "acceptance-memory-inventory",
            #[cfg(feature = "desktop-acceptance")]
            Self::PythonDiagnostic => "acceptance-python-diagnostic",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cause {
    Start,
    Input,
    InputLimit,
    Read,
    StdoutLimit,
    StderrLimit,
    Wait,
    Worker,
    Timeout,
    Cancelled,
    Capacity,
    Identity,
    Cleanup,
}

#[derive(Debug)]
pub(crate) struct CommandFailure {
    cause: Cause,
    cleanup_pending: bool,
}
impl CommandFailure {
    fn complete(cause: Cause) -> Self {
        Self {
            cause,
            cleanup_pending: false,
        }
    }

    #[cfg(feature = "desktop-acceptance")]
    pub(crate) fn native_read_failure(&self) -> crate::runtime_probe::ProbeFailure {
        use crate::runtime_probe::ProbeFailure as Failure;
        if self.cleanup_pending {
            return Failure::Cleanup;
        }
        match self.cause {
            Cause::Start | Cause::Identity => Failure::Start,
            Cause::Input | Cause::InputLimit => Failure::Input,
            Cause::Read | Cause::Worker => Failure::Read,
            Cause::StdoutLimit | Cause::StderrLimit => Failure::OutputLimit,
            Cause::Wait => Failure::Wait,
            Cause::Timeout => Failure::Timeout,
            Cause::Cancelled | Cause::Capacity | Cause::Cleanup => Failure::Cleanup,
        }
    }
    pub(crate) fn message(&self) -> &'static str {
        if self.cleanup_pending {
            return "Auxiliary command cleanup incomplete. Try again to retry cleanup.";
        }
        match self.cause {
            Cause::Start => "Auxiliary command could not be started.",
            Cause::Input => "Auxiliary command input could not be sent.",
            Cause::InputLimit => "Auxiliary command input exceeded its size limit.",
            Cause::Read => "Auxiliary command output could not be read.",
            Cause::StdoutLimit => "Auxiliary command stdout exceeded its size limit.",
            Cause::StderrLimit => "Auxiliary command stderr exceeded its size limit.",
            Cause::Wait => "Auxiliary command exit could not be observed.",
            Cause::Worker => "Auxiliary command I/O worker failed.",
            Cause::Timeout => "Auxiliary command timed out.",
            Cause::Cancelled => "Auxiliary command was cancelled.",
            Cause::Capacity => {
                "Auxiliary command capacity is busy or waiting for cleanup. Try again."
            }
            Cause::Identity => "Auxiliary command ownership is unavailable.",
            Cause::Cleanup => "Auxiliary command cleanup could not be completed.",
        }
    }
}

#[derive(Clone, Copy)]
struct Policy {
    timeout: Duration,
    input_bytes: usize,
    stdout_bytes: usize,
    stderr_bytes: usize,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            // Cold startup plus a provider connection test needs headroom.
            timeout: Duration::from_secs(120),
            input_bytes: 1024 * 1024,
            stdout_bytes: 1024 * 1024,
            stderr_bytes: 256 * 1024,
        }
    }
}

#[derive(Default)]
pub(crate) struct Supervisor {
    pool: Mutex<Pool>,
}
#[derive(Default)]
struct Pool {
    next_id: u64,
    owners: BTreeMap<u64, Arc<Owner>>,
    #[cfg(any(test, feature = "desktop-acceptance"))]
    closed: bool,
}
struct Owner {
    id: u64,
    tag: &'static str,
    run_id: String,
    registry: Arc<Registry>,
    observation: OwnershipObservation,
    phase: AtomicU8,
    failure: Mutex<Option<Cause>>,
}

struct Lease<'a> {
    supervisor: &'a Supervisor,
    owner: Arc<Owner>,
    guard: Option<RunGuard>,
    cleanup_deadline: Instant,
}
impl Lease<'_> {
    fn guard(&self) -> &RunGuard {
        self.guard.as_ref().expect("auxiliary lease is active")
    }

    fn finish(&mut self, cause: Option<Cause>, deadline: Instant) -> Result<(), CommandFailure> {
        let result = self
            .guard
            .as_mut()
            .expect("auxiliary lease is active")
            .finish(deadline);
        let cancelled_after_result = cause.is_none() && self.guard().cancelled();
        let cause = cause.or_else(|| cancelled_after_result.then_some(Cause::Cancelled));
        // A joined worker panic can return Err after resource cleanup released
        // the owner. The exact observation distinguishes that from pending I/O.
        let retained = self.owner.observation.retained();
        drop(self.guard.take());
        if retained {
            *self.owner.failure.lock().unwrap_or_else(|e| e.into_inner()) = cause;
            self.owner.phase.store(PENDING, Ordering::Release);
            return Err(CommandFailure {
                cause: cause.unwrap_or(Cause::Cleanup),
                cleanup_pending: true,
            });
        }
        self.supervisor.remove(&self.owner);
        result.map_err(|_| CommandFailure::complete(cause.unwrap_or(Cause::Worker)))?;
        if cancelled_after_result {
            Err(CommandFailure::complete(Cause::Cancelled))
        } else {
            Ok(())
        }
    }
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if self.guard.is_some() {
            // Panic fallback keeps uncertain resources in the managed pool.
            let _ = self.finish(Some(Cause::Worker), self.cleanup_deadline);
        }
    }
}

impl Supervisor {
    pub(crate) fn execute(
        &self,
        kind: CommandKind,
        command: Command,
        input: Option<&Value>,
    ) -> Result<Output, CommandFailure> {
        self.execute_with_policy(kind, command, input, Policy::default())
    }

    /// Feature-only adapters use this same pool, Registry, OwnedProcess and
    /// registered I/O handles. Distinct purpose tags never supersede a run.
    #[cfg(feature = "desktop-acceptance")]
    pub(crate) fn execute_native_read(
        &self,
        kind: CommandKind,
        command: Command,
        input: Option<&Value>,
        timeout: Duration,
        stdout_bytes: usize,
    ) -> Result<Output, CommandFailure> {
        self.execute_with_policy(
            kind,
            command,
            input,
            Policy {
                timeout,
                input_bytes: 64 * 1024,
                stdout_bytes,
                stderr_bytes: 64 * 1024,
            },
        )
    }

    fn execute_with_policy(
        &self,
        kind: CommandKind,
        command: Command,
        input: Option<&Value>,
        policy: Policy,
    ) -> Result<Output, CommandFailure> {
        self.execute_with_setup(
            kind,
            command,
            input,
            policy,
            #[cfg(test)]
            WorkerSetup::default(),
        )
    }

    fn execute_with_setup(
        &self,
        kind: CommandKind,
        command: Command,
        input: Option<&Value>,
        policy: Policy,
        #[cfg(test)] mut setup: WorkerSetup,
    ) -> Result<Output, CommandFailure> {
        let started = Instant::now();
        #[cfg(test)]
        let trace = setup.trace.clone();
        #[cfg(test)]
        diagnostic_mark(&trace, "caller_entered");
        let deadline = started + policy.timeout;
        let reserve = CLEANUP_TIMEOUT.min(policy.timeout / 4);
        let work_deadline = deadline - reserve;
        let bytes = input
            .map(|value| encode_input(value, policy.input_bytes))
            .transpose()
            .map_err(CommandFailure::complete)?;
        #[cfg(test)]
        diagnostic_mark(&trace, "input_encoded");
        #[cfg(test)]
        diagnostic_mark(&trace, "pending_retry_begin");
        self.retry_pending((Instant::now() + reserve).min(work_deadline));
        #[cfg(test)]
        diagnostic_mark(&trace, "pending_retry_returned");
        if Instant::now() >= work_deadline {
            return Err(CommandFailure::complete(Cause::Timeout));
        }
        #[cfg(test)]
        diagnostic_mark(&trace, "admit_begin");
        let mut lease = self.admit(kind)?;
        #[cfg(test)]
        if let Some(trace) = &trace {
            trace.admitted(&lease.owner);
        }
        lease.cleanup_deadline = deadline;
        let mut received = Received::new(bytes.is_none());
        #[cfg(test)]
        let observed_exit = setup.observed_exit.take();
        let prepared = prepare(
            lease.guard(),
            command,
            bytes,
            policy,
            work_deadline,
            #[cfg(test)]
            setup,
        );
        #[cfg(test)]
        diagnostic_mark(&trace, "prepare_returned");
        let operation = match prepared.as_ref() {
            Ok(events) => monitor(lease.guard(), events, &mut received, work_deadline),
            Err(cause) => Err(*cause),
        };
        #[cfg(test)]
        diagnostic_mark(&trace, "monitor_or_prepare_result");
        #[cfg(test)]
        if let (Some(witness), Ok(status)) = (observed_exit, operation.as_ref()) {
            let _ = witness.send(*status);
        }
        #[cfg(test)]
        diagnostic_mark(&trace, "finish_begin");
        lease.finish(operation.as_ref().err().copied(), deadline)?;
        #[cfg(test)]
        diagnostic_mark(&trace, "finish_returned_ok");
        let status = operation.map_err(CommandFailure::complete)?;
        let events = prepared.map_err(CommandFailure::complete)?;
        // All workers have been joined. Their final bounded messages can now
        // be consumed without waiting, including EOF after descendant cleanup.
        received.drain(&events).map_err(CommandFailure::complete)?;
        if Instant::now() >= deadline {
            return Err(CommandFailure::complete(Cause::Timeout));
        }
        received.output(status).map_err(CommandFailure::complete)
    }

    fn admit(&self, kind: CommandKind) -> Result<Lease<'_>, CommandFailure> {
        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(any(test, feature = "desktop-acceptance"))]
        if pool.closed {
            return Err(CommandFailure::complete(Cause::Cancelled));
        }
        if pool.owners.len() >= MAX_OWNERS {
            return Err(CommandFailure::complete(Cause::Capacity));
        }
        let id = pool.next_id;
        pool.next_id = id
            .checked_add(1)
            .ok_or_else(|| CommandFailure::complete(Cause::Identity))?;
        let registry = Arc::new(Registry::default());
        let run_id = registry
            .reserve(kind.tag().into())
            .map_err(|_| CommandFailure::complete(Cause::Identity))?;
        let guard = registry
            .start(kind.tag(), &run_id)
            .map_err(|_| CommandFailure::complete(Cause::Identity))?;
        let owner = Arc::new(Owner {
            id,
            tag: kind.tag(),
            run_id,
            registry,
            observation: guard.ownership(),
            phase: AtomicU8::new(ACTIVE),
            failure: Mutex::new(None),
        });
        pool.owners.insert(id, owner.clone());
        Ok(Lease {
            supervisor: self,
            owner,
            guard: Some(guard),
            cleanup_deadline: Instant::now() + CLEANUP_TIMEOUT,
        })
    }

    fn remove(&self, owner: &Arc<Owner>) {
        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        if pool
            .owners
            .get(&owner.id)
            .is_some_and(|current| Arc::ptr_eq(current, owner))
        {
            pool.owners.remove(&owner.id);
        }
    }

    fn retry_pending(&self, deadline: Instant) {
        let owners: Vec<_> = self
            .pool
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .owners
            .values()
            .cloned()
            .collect();
        for owner in owners {
            if Instant::now() >= deadline {
                break;
            }
            if owner
                .phase
                .compare_exchange(PENDING, RETRYING, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                continue;
            }
            if let Some(cleanup) = owner.registry.cancel(owner.tag, &owner.run_id) {
                let _ = cleanup.wait(deadline);
            }
            if owner.observation.retained() {
                owner.phase.store(PENDING, Ordering::Release);
            } else {
                self.remove(&owner);
            }
        }
    }

    // Feature adapter shares this exact pool with production execute.
    #[cfg(any(test, feature = "desktop-acceptance"))]
    pub(crate) fn close_admission(&self) {
        self.pool.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }

    #[cfg(any(test, feature = "desktop-acceptance"))]
    pub(crate) fn cleanup_all(&self, deadline: Instant) -> Result<(), CommandFailure> {
        let owners: Vec<_> = {
            let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
            pool.closed = true;
            pool.owners.values().cloned().collect()
        };
        let mut pending = false;
        for owner in owners {
            if let Some(cleanup) = owner.registry.cancel(owner.tag, &owner.run_id) {
                let _ = cleanup.wait(deadline);
            }
            if owner.observation.retained() {
                pending = true;
            } else {
                self.remove(&owner);
            }
        }
        if pending {
            Err(CommandFailure {
                cause: Cause::Cleanup,
                cleanup_pending: true,
            })
        } else {
            Ok(())
        }
    }
}

struct CappedInput {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl Write for CappedInput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other("auxiliary input size limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode_input(value: &Value, limit: usize) -> Result<Vec<u8>, Cause> {
    let mut writer = CappedInput {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| {
        if writer.exceeded {
            Cause::InputLimit
        } else {
            Cause::Input
        }
    })?;
    Ok(writer.bytes)
}

enum Event {
    Input(Result<(), Cause>),
    Stdout(Result<Vec<u8>, Cause>),
    Stderr(Result<Vec<u8>, Cause>),
}
struct Received {
    input: bool,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
}
impl Received {
    fn new(input: bool) -> Self {
        Self {
            input,
            stdout: None,
            stderr: None,
        }
    }
    fn drain(&mut self, events: &Receiver<Event>) -> Result<(), Cause> {
        loop {
            match events.try_recv() {
                Ok(Event::Input(result)) => {
                    result?;
                    self.input = true;
                }
                Ok(Event::Stdout(result)) => self.stdout = Some(result?),
                Ok(Event::Stderr(result)) => self.stderr = Some(result?),
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => {
                    return if self.input && self.stdout.is_some() && self.stderr.is_some() {
                        Ok(())
                    } else {
                        Err(Cause::Worker)
                    };
                }
            }
        }
    }
    fn output(self, status: ExitStatus) -> Result<Output, Cause> {
        if !self.input {
            return Err(Cause::Worker);
        }
        Ok(Output {
            status,
            stdout: self.stdout.ok_or(Cause::Worker)?,
            stderr: self.stderr.ok_or(Cause::Worker)?,
        })
    }
}

fn prepare(
    guard: &RunGuard,
    mut command: Command,
    input: Option<Vec<u8>>,
    policy: Policy,
    deadline: Instant,
    #[cfg(test)] setup: WorkerSetup,
) -> Result<Receiver<Event>, Cause> {
    #[cfg(test)]
    let trace = setup.trace.clone();
    if guard.cancelled() {
        return Err(Cause::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(Cause::Timeout);
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(test)]
    diagnostic_mark(&trace, "owned_spawn_begin");
    let mut process = match OwnedProcess::spawn_owned(command, deadline) {
        Ok(process) => process,
        Err(failure) => {
            if let Some(pending) = failure.pending {
                // Every admitted request has a fresh, unpopulated Registry.
                guard.attach(pending).map_err(|_| Cause::Identity)?;
            }
            return Err(Cause::Start);
        }
    };
    #[cfg(test)]
    if let Some(trace) = &trace {
        trace.spawned(process.child.id());
    }
    let stdin = process.child.stdin.take();
    let stdout = process.child.stdout.take();
    let stderr = process.child.stderr.take();
    guard.attach(process).map_err(|_| Cause::Identity)?;
    #[cfg(test)]
    let WorkerSetup {
        stdout: stdout_fault,
        stderr: stderr_fault,
        input: input_fault,
        attached,
        observed_exit: _,
        trace: _,
    } = setup;
    #[cfg(test)]
    if let Some(witness) = attached {
        let _ = witness.send(guard.ownership());
    }
    #[cfg(test)]
    diagnostic_mark(&trace, "original_process_attached");
    if guard.cancelled() {
        return Err(Cause::Cancelled);
    }
    let stdout = stdout.ok_or(Cause::Read)?;
    let stderr = stderr.ok_or(Cause::Read)?;
    let (sender, events) = mpsc::channel();
    let output_sender = sender.clone();
    #[cfg(test)]
    diagnostic_mark(&trace, "stdout_register_begin");
    register_worker(
        guard,
        move || {
            let result = read_bounded(stdout, policy.stdout_bytes, Cause::StdoutLimit);
            let _ = output_sender.send(Event::Stdout(result));
        },
        #[cfg(test)]
        stdout_fault,
    )?;
    #[cfg(test)]
    diagnostic_mark(&trace, "stdout_registered");
    let error_sender = sender.clone();
    #[cfg(test)]
    diagnostic_mark(&trace, "stderr_register_begin");
    register_worker(
        guard,
        move || {
            let result = read_bounded(stderr, policy.stderr_bytes, Cause::StderrLimit);
            let _ = error_sender.send(Event::Stderr(result));
        },
        #[cfg(test)]
        stderr_fault,
    )?;
    #[cfg(test)]
    diagnostic_mark(&trace, "stderr_registered");
    if let Some(bytes) = input {
        let mut stdin = stdin.ok_or(Cause::Input)?;
        #[cfg(test)]
        let input_trace = trace.clone();
        #[cfg(test)]
        diagnostic_mark(&trace, "input_register_begin");
        register_worker(
            guard,
            move || {
                #[cfg(test)]
                diagnostic_mark(&input_trace, "input_worker_entered");
                #[cfg(test)]
                diagnostic_mark(&input_trace, "input_write_begin");
                let result = stdin.write_all(&bytes).map_err(|_| Cause::Input);
                #[cfg(test)]
                diagnostic_mark(
                    &input_trace,
                    if result.is_ok() {
                        "input_write_ok"
                    } else {
                        "input_write_failed"
                    },
                );
                drop(stdin);
                #[cfg(test)]
                diagnostic_mark(&input_trace, "original_stdin_closed");
                let _ = sender.send(Event::Input(result));
                #[cfg(test)]
                diagnostic_mark(&input_trace, "input_event_send_returned");
            },
            #[cfg(test)]
            input_fault,
        )?;
        #[cfg(test)]
        diagnostic_mark(&trace, "input_registered");
    }
    Ok(events)
}

#[cfg(test)]
#[derive(Default)]
struct WorkerSetup {
    stdout: WorkerFault,
    stderr: WorkerFault,
    input: WorkerFault,
    attached: Option<mpsc::Sender<OwnershipObservation>>,
    observed_exit: Option<mpsc::Sender<ExitStatus>>,
    trace: Option<Arc<WorkerTrace>>,
}

#[cfg(test)]
struct WorkerTrace {
    epoch: Instant,
    state: Mutex<WorkerTraceState>,
}
#[cfg(test)]
#[derive(Default)]
struct WorkerTraceState {
    owner_id: Option<u64>,
    tag: Option<&'static str>,
    run_id: Option<String>,
    original_pid: Option<u32>,
    stages: Vec<Value>,
    capped: bool,
}
#[cfg(test)]
impl WorkerTrace {
    fn new(epoch: Instant) -> Self {
        Self {
            epoch,
            state: Mutex::new(WorkerTraceState::default()),
        }
    }
    fn mark(&self, stage: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let elapsed = self.epoch.elapsed().as_nanos().to_string();
        if state.stages.len() < 32 {
            state
                .stages
                .push(serde_json::json!({"stage":stage,"elapsedNanos":elapsed}));
        } else {
            state.capped = true;
        }
    }
    fn admitted(&self, owner: &Owner) {
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.owner_id = Some(owner.id);
            state.tag = Some(owner.tag);
            state.run_id = Some(owner.run_id.clone());
        }
        self.mark("original_owner_admitted");
    }
    fn spawned(&self, original_pid: u32) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .original_pid = Some(original_pid);
        self.mark("owned_spawn_returned");
    }
    fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        serde_json::json!({
            "elapsedNanos":self.epoch.elapsed().as_nanos().to_string(),
            "originalOwnerId":state.owner_id,"originalTag":state.tag,"originalRunId":state.run_id,
            "originalChildPid":state.original_pid,"stages":state.stages,"capped":state.capped,
            "cleanupCertified":false
        })
    }
}
#[cfg(test)]
fn diagnostic_mark(trace: &Option<Arc<WorkerTrace>>, stage: &str) {
    if let Some(trace) = trace {
        trace.mark(stage);
    }
}

#[cfg(test)]
#[derive(Default)]
enum WorkerFault {
    #[default]
    Normal,
    CreationFailure,
    Panic,
    Disconnect,
    Hold {
        entered: mpsc::Sender<()>,
        release: Receiver<()>,
    },
}

fn register_worker(
    guard: &RunGuard,
    worker: impl FnOnce() + Send + 'static,
    #[cfg(test)] fault: WorkerFault,
) -> Result<(), Cause> {
    #[cfg(test)]
    if matches!(fault, WorkerFault::CreationFailure) {
        return Err(Cause::Worker);
    }
    let (start, gate) = mpsc::channel();
    let handle = thread::Builder::new()
        .spawn(move || {
            if gate.recv().is_ok() {
                #[cfg(test)]
                match fault {
                    WorkerFault::Panic => panic!("fictional registered I/O worker panic"),
                    WorkerFault::Disconnect => return,
                    WorkerFault::Hold { entered, release } => {
                        let _ = entered.send(());
                        let _ = release.recv();
                    }
                    WorkerFault::Normal | WorkerFault::CreationFailure => {}
                }
                worker();
            }
        })
        .map_err(|_| Cause::Worker)?;
    guard.reader(handle);
    start.send(()).map_err(|_| Cause::Worker)
}

fn read_bounded(mut stream: impl Read, limit: usize, overflow: Cause) -> Result<Vec<u8>, Cause> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Cause::Read),
        };
        if count == 0 {
            return Ok(bytes);
        }
        if count > limit.saturating_sub(bytes.len()) {
            return Err(overflow);
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn monitor(
    guard: &RunGuard,
    events: &Receiver<Event>,
    received: &mut Received,
    deadline: Instant,
) -> Result<ExitStatus, Cause> {
    loop {
        received.drain(events)?;
        if guard.cancelled() {
            return Err(Cause::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Cause::Timeout);
        }
        if let Some(status) = guard.try_wait().map_err(|_| Cause::Wait)? {
            return Ok(status);
        }
        thread::sleep(
            Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(test)]
#[path = "json_command/tests.rs"]
mod tests;
