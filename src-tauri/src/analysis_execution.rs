use crate::owned_process::OwnedProcess;
use std::{
    process::ExitStatus,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, TryLockError,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub const CLEANUP_TIMEOUT: Duration = Duration::from_secs(3);
const HANDOFF_LEASE: Duration = Duration::from_secs(30);
pub const CLEANUP_ERROR: &str =
    "Analysis cleanup incomplete. Retry stopping the task before starting another analysis.";

#[derive(Default)]
pub struct Registry {
    active: Mutex<Option<Arc<Run>>>,
    next_id: AtomicU64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Unstarted,
    Preparing,
    Cleaning,
    CleanupFailed,
    Finished,
}

struct Run {
    task_id: String,
    run_id: String,
    expires: Instant,
    cancelled: AtomicBool,
    claimed: AtomicBool,
    state: Mutex<RunState>,
    changed: Condvar,
}

struct RunState {
    phase: Phase,
    worker_active: bool,
    process: Option<OwnedProcess>,
    readers: Vec<JoinHandle<()>>,
    reader_panicked: bool,
}

impl Registry {
    pub fn reserve(&self, task_id: String) -> Result<String, String> {
        self.reserve_for(task_id, HANDOFF_LEASE)
    }

    fn reserve_for(&self, task_id: String, lease: Duration) -> Result<String, String> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        Self::expire_unstarted(&mut active);
        if active.is_some() {
            return Err("已有任务正在运行或等待停止。请先停止当前任务。".into());
        }
        let id = self
            .next_id
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map_err(|_| "analysis run identity exhausted")?;
        let run_id = format!("analysis-{id}");
        *active = Some(Arc::new(Run {
            task_id,
            run_id: run_id.clone(),
            expires: Instant::now() + lease,
            cancelled: AtomicBool::new(false),
            claimed: AtomicBool::new(false),
            state: Mutex::new(RunState {
                phase: Phase::Unstarted,
                worker_active: false,
                process: None,
                readers: Vec::new(),
                reader_panicked: false,
            }),
            changed: Condvar::new(),
        }));
        Ok(run_id)
    }

    fn expire_unstarted(active: &mut Option<Arc<Run>>) {
        let expired = active.as_ref().is_some_and(|run| {
            Instant::now() >= run.expires && !run.claimed.load(Ordering::SeqCst)
        });
        if expired {
            *active = None;
        }
    }

    pub fn start(self: &Arc<Self>, task_id: &str, run_id: &str) -> Result<RunGuard, String> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        Self::expire_unstarted(&mut active);
        let owner = active
            .as_ref()
            .filter(|run| run.task_id == task_id && run.run_id == run_id)
            .cloned()
            .ok_or("analysis reservation is unavailable")?;
        if owner.cancelled.load(Ordering::SeqCst) {
            return Err("analysis reservation is cancelled".into());
        }
        {
            let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.phase != Phase::Unstarted || owner.cancelled.load(Ordering::SeqCst) {
                return Err("analysis reservation is no longer startable".into());
            }
            state.phase = Phase::Preparing;
            state.worker_active = true;
            owner.claimed.store(true, Ordering::SeqCst);
        }
        Ok(RunGuard {
            registry: self.clone(),
            owner,
            worker_retired: false,
        })
    }

    /// Mark synchronously before dispatching the bounded cleanup worker.
    pub fn cancel(self: &Arc<Self>, task_id: &str, run_id: &str) -> Option<CleanupRequest> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        Self::expire_unstarted(&mut active);
        let owner = active
            .as_ref()
            .filter(|run| run.task_id == task_id && run.run_id == run_id)?
            .clone();
        owner.cancelled.store(true, Ordering::SeqCst);
        owner.changed.notify_all();
        Some(CleanupRequest {
            registry: self.clone(),
            owner,
        })
    }

    /// Serialize the check and synchronous deletion with admission. A task
    /// with any retained owner cannot be deleted; unrelated tasks can be.
    pub fn delete_idle_task<T>(
        &self,
        task_id: &str,
        delete: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        Self::expire_unstarted(&mut active);
        if active
            .as_ref()
            .is_some_and(|owner| owner.task_id == task_id)
        {
            return Err("Stop the task before deleting it.".into());
        }
        // This deliberate filesystem operation is dispatched off the UI thread
        // by the caller. Admission must not enter a check/delete gap.
        delete()
    }

    fn owns(&self, owner: &Arc<Run>) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, owner))
    }

    fn release(&self, owner: &Arc<Run>) {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, owner))
        {
            *active = None;
        }
    }

    fn cleanup(&self, owner: &Arc<Run>, deadline: Instant) -> Result<(), String> {
        loop {
            let mut state = match owner.state.try_lock() {
                Ok(state) => state,
                Err(TryLockError::Poisoned(error)) => error.into_inner(),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(CLEANUP_ERROR.into());
                    }
                    std::thread::sleep(
                        Duration::from_millis(5)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    );
                    continue;
                }
            };
            if state.phase == Phase::Finished {
                drop(state);
                self.release(owner);
                return Ok(());
            }
            state.phase = Phase::Cleaning;
            if let Some(process) = state.process.as_mut() {
                if process.stop(deadline).is_err() {
                    state.phase = Phase::CleanupFailed;
                    return Err(CLEANUP_ERROR.into());
                }
            }
            let mut index = 0;
            while index < state.readers.len() {
                if state.readers[index].is_finished() {
                    if state.readers.swap_remove(index).join().is_err() {
                        state.reader_panicked = true;
                    }
                } else {
                    index += 1;
                }
            }
            if !state.worker_active && state.readers.is_empty() {
                state.phase = Phase::Finished;
                drop(state);
                self.release(owner);
                return Ok(());
            }
            if Instant::now() >= deadline {
                state.phase = Phase::CleanupFailed;
                return Err(CLEANUP_ERROR.into());
            }
            let wait =
                Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now()));
            drop(
                owner
                    .changed
                    .wait_timeout(state, wait)
                    .unwrap_or_else(|e| e.into_inner()),
            );
        }
    }
}

pub struct CleanupRequest {
    registry: Arc<Registry>,
    owner: Arc<Run>,
}
impl CleanupRequest {
    pub fn wait(self, deadline: Instant) -> Result<(), String> {
        self.registry.cleanup(&self.owner, deadline)
    }
}

#[derive(Clone)]
pub struct EventGuard {
    registry: Arc<Registry>,
    owner: Arc<Run>,
}

/// A query-only witness for one exact accepted owner, including after a worker
/// panic. A newer run of the same task never satisfies this observation.
pub struct OwnershipObservation {
    registry: Arc<Registry>,
    owner: Arc<Run>,
}
impl OwnershipObservation {
    pub fn retained(&self) -> bool {
        self.registry.owns(&self.owner)
    }
}
impl EventGuard {
    pub fn allows_events(&self) -> bool {
        !self.owner.cancelled.load(Ordering::SeqCst) && self.registry.owns(&self.owner)
    }
}

pub struct RunGuard {
    registry: Arc<Registry>,
    owner: Arc<Run>,
    worker_retired: bool,
}
impl RunGuard {
    pub fn ownership(&self) -> OwnershipObservation {
        OwnershipObservation {
            registry: self.registry.clone(),
            owner: self.owner.clone(),
        }
    }
    pub fn cancelled(&self) -> bool {
        self.owner.cancelled.load(Ordering::SeqCst)
    }
    pub fn events(&self) -> EventGuard {
        EventGuard {
            registry: self.registry.clone(),
            owner: self.owner.clone(),
        }
    }
    pub fn attach(&self, process: OwnedProcess) -> Result<(), String> {
        let mut state = self.owner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.process.is_some() {
            return Err("analysis process already attached".into());
        }
        state.process = Some(process);
        self.owner.changed.notify_all();
        Ok(())
    }
    pub fn reader(&self, handle: JoinHandle<()>) {
        self.owner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .readers
            .push(handle);
    }
    pub fn try_wait(&self) -> Result<Option<ExitStatus>, String> {
        self.owner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process
            .as_mut()
            .ok_or("analysis process unavailable")?
            .child
            .try_wait()
            .map_err(|e| e.to_string())
    }
    pub fn finish(&mut self, deadline: Instant) -> Result<(), String> {
        if !self.worker_retired {
            self.worker_retired = true;
            self.owner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .worker_active = false;
            self.owner.changed.notify_all();
        }
        self.registry.cleanup(&self.owner, deadline)?;
        if self
            .owner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reader_panicked
        {
            return Err("Analysis output reader failed.".into());
        }
        Ok(())
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if !self.worker_retired {
            let _ = self.finish(Instant::now() + CLEANUP_TIMEOUT);
        }
    }
}

#[cfg(test)]
#[path = "analysis_execution/tests.rs"]
mod tests;
