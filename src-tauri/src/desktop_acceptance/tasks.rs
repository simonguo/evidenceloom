//! Feature-only ownership of the original Tauri runtime handles, not a scheduler.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    task::{Context, Poll, Wake, Waker},
    time::{Duration, Instant},
};
const MAX_PENDING: usize = 128;
static SHARED: OnceLock<Arc<NativeTasks>> = OnceLock::new();

pub(crate) fn install(tasks: Arc<NativeTasks>) -> Result<(), ()> {
    SHARED.set(tasks).map_err(|_| ())
}
/// These inherited unit tests call command helpers without constructing App.
/// They install the same open admission/real-handle manager explicitly. Native
/// lifecycle tests use separate local managers; production has no lazy fallback.
#[cfg(test)]
pub(crate) fn install_for_command_unit_tests() {
    SHARED.get_or_init(|| Arc::new(NativeTasks::default()));
}
fn rejected() -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(
        "Native operation admission is closed or unavailable.",
    ))
}
#[derive(Default)]
pub(crate) struct NativeTasks {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    closed: bool,
    next_id: u64,
    accepted: u64,
    joined: u64,
    panicked: bool,
    slots: BTreeMap<u64, Arc<dyn ErasedTask>>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskFacts {
    pub(crate) closed: bool,
    pub(crate) accepted: u64,
    pub(crate) joined: u64,
    pub(crate) pending: usize,
    pub(crate) panicked: bool,
}
trait ErasedTask: Send + Sync {
    fn join_if_finished(&self) -> Option<bool>;
}
struct Slot<T> {
    state: Mutex<SlotState<T>>,
}
struct SlotState<T> {
    handle: Option<tauri::async_runtime::JoinHandle<T>>,
    completion: Option<tauri::Result<T>>,
    joined: bool,
    failed: bool,
}
struct Noop;
impl Wake for Noop {
    fn wake(self: Arc<Self>) {}
}
impl<T: Send + 'static> ErasedTask for Slot<T> {
    fn join_if_finished(&self) -> Option<bool> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.joined {
            return Some(state.failed);
        }
        if !state.handle.as_ref()?.inner().is_finished() {
            return None;
        }
        // This is the actual JoinHandle future after the runtime finished it.
        // The caller's eventual response still consumes its retained result.
        let waker = Waker::from(Arc::new(Noop));
        let mut context = Context::from_waker(&waker);
        if let Poll::Ready(result) = Pin::new(state.handle.as_mut()?).poll(&mut context) {
            state.failed = result.is_err();
            state.joined = true;
            state.completion = Some(result);
            state.handle = None;
            Some(state.failed)
        } else {
            None
        }
    }
}
struct StdSlot {
    state: Mutex<StdState>,
}
struct StdState {
    handle: Option<std::thread::JoinHandle<()>>,
    joined: bool,
    failed: bool,
}
impl ErasedTask for StdSlot {
    fn join_if_finished(&self) -> Option<bool> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.joined {
            return Some(state.failed);
        }
        if !state.handle.as_ref()?.is_finished() {
            return None;
        }
        state.failed = state.handle.take()?.join().is_err();
        state.joined = true;
        Some(state.failed)
    }
}
pub(crate) struct NativeTask<T> {
    slot: Option<Arc<Slot<T>>>,
    tasks: Option<Arc<NativeTasks>>,
    id: u64,
    failure: Option<tauri::Error>,
}
impl<T> NativeTask<T> {
    pub(crate) fn admitted(&self) -> bool {
        self.slot.is_some()
    }
    fn failed() -> Self {
        Self {
            slot: None,
            tasks: None,
            id: 0,
            failure: Some(rejected()),
        }
    }
}
impl<T: Send + 'static> Future for NativeTask<T> {
    type Output = tauri::Result<T>;
    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if let Some(error) = this.failure.take() {
            return Poll::Ready(Err(error));
        }
        let Some(slot) = this.slot.as_ref() else {
            return Poll::Ready(Err(rejected()));
        };
        let mut state = slot.state.lock().unwrap_or_else(|e| e.into_inner());
        let ready = if let Some(result) = state.completion.take() {
            Poll::Ready(result)
        } else if let Some(handle) = state.handle.as_mut() {
            Pin::new(handle).poll(context)
        } else {
            Poll::Ready(Err(rejected()))
        };
        match ready {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                state.failed |= result.is_err();
                state.joined = true;
                state.handle = None;
                let failed = state.failed;
                drop(state);
                if let Some(tasks) = &this.tasks {
                    tasks.retire(this.id, failed);
                }
                Poll::Ready(result)
            }
        }
    }
}
impl NativeTasks {
    pub(crate) fn close(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }
    fn retire(&self, id: u64, failed: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.slots.remove(&id).is_some() {
            state.joined += 1;
            state.panicked |= failed;
        }
    }
    fn admit<T: Send + 'static>(
        self: &Arc<Self>,
        spawn: impl FnOnce() -> tauri::async_runtime::JoinHandle<T>,
    ) -> NativeTask<T> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed
            || state.slots.len() >= MAX_PENDING
            || state.next_id == u64::MAX
            || state.accepted == u64::MAX
        {
            drop(state); // Dropping rejected work/RunGuard must never run under admission mutex.
            drop(spawn);
            return NativeTask::failed();
        }
        let id = state.next_id;
        let slot = Arc::new(Slot {
            state: Mutex::new(SlotState {
                handle: Some(spawn()),
                completion: None,
                joined: false,
                failed: false,
            }),
        });
        state.next_id += 1;
        state.accepted += 1;
        state.slots.insert(id, slot.clone());
        NativeTask {
            slot: Some(slot),
            tasks: Some(self.clone()),
            id,
            failure: None,
        }
    }
    fn spawn_original_thread(
        self: &Arc<Self>,
        work: impl FnOnce() + Send + 'static,
    ) -> Result<(), ()> {
        let (start, gate) = std::sync::mpsc::channel();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed
            || state.slots.len() >= MAX_PENDING
            || state.next_id == u64::MAX
            || state.accepted == u64::MAX
        {
            drop(state);
            drop(work);
            return Err(());
        }
        let handle = std::thread::Builder::new()
            .name("acceptance-original-expiry".into())
            .spawn(move || {
                if gate.recv().is_ok() {
                    work();
                }
            });
        let handle = match handle {
            Ok(handle) => handle,
            Err(_) => {
                drop(state);
                return Err(());
            }
        };
        let id = state.next_id;
        state.next_id += 1;
        state.accepted += 1;
        state.slots.insert(
            id,
            Arc::new(StdSlot {
                state: Mutex::new(StdState {
                    handle: Some(handle),
                    joined: false,
                    failed: false,
                }),
            }),
        );
        drop(state);
        let _ = start.send(());
        Ok(())
    }
    pub(crate) fn drain(&self, deadline: Instant) -> TaskFacts {
        self.close();
        loop {
            let slots: Vec<_> = self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .slots
                .iter()
                .map(|(id, slot)| (*id, slot.clone()))
                .collect();
            for (id, slot) in slots {
                if let Some(failed) = slot.join_if_finished() {
                    self.retire(id, failed);
                }
            }
            let facts = self.facts();
            if facts.pending == 0 || Instant::now() >= deadline {
                return facts;
            }
            std::thread::park_timeout(
                Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    pub(crate) fn facts(&self) -> TaskFacts {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        TaskFacts {
            closed: state.closed,
            accepted: state.accepted,
            joined: state.joined,
            pending: state.slots.len(),
            panicked: state.panicked,
        }
    }
}
pub(crate) fn spawn_blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> NativeTask<T> {
    let Some(tasks) = SHARED.get() else {
        return NativeTask::failed();
    };
    // Root capture occurs before work starts, including SQL preparation/writes.
    let (start, gate) = std::sync::mpsc::channel();
    let task = tasks.admit(|| {
        tauri::async_runtime::spawn_blocking(move || {
            if gate.recv().is_err() {
                panic!("native operation start gate disconnected");
            }
            work()
        })
    });
    if task.admitted() {
        let _ = start.send(());
    }
    task
}
pub(crate) fn spawn<T: Send + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> NativeTask<T> {
    let Some(tasks) = SHARED.get() else {
        return NativeTask::failed();
    };
    // An async supervisor is registered before its first poll through an atomic
    // start flag; no blocked Tokio thread or replacement runtime is introduced.
    let (start, gate) = tauri::async_runtime::channel::<()>(1);
    let task = tasks.admit(|| {
        tauri::async_runtime::spawn(async move {
            let mut gate = gate;
            if gate.recv().await.is_none() {
                panic!("native supervisor start gate disconnected");
            }
            future.await
        })
    });
    if task.admitted() {
        let _ = start.try_send(());
    }
    task
}

/// Original reservation-expiry thread, captured before its first instruction.
/// No new scheduler or cancellation primitive is introduced.
pub(crate) fn spawn_original_thread(work: impl FnOnce() + Send + 'static) -> Result<(), ()> {
    SHARED.get().ok_or(())?.spawn_original_thread(work)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    fn cut() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }
    #[test]
    fn dropped_awaiter_keeps_actual_blocking_worker_pending_until_join() {
        let tasks = Arc::new(NativeTasks::default());
        let (release, gate) = mpsc::channel();
        let worker = tasks.admit(|| {
            tauri::async_runtime::spawn_blocking(move || {
                gate.recv().unwrap();
                41usize
            })
        });
        drop(worker);
        let pending = tasks.drain(Instant::now());
        assert!(pending.closed);
        assert_eq!(
            (pending.accepted, pending.joined, pending.pending),
            (1, 0, 1)
        );
        release.send(()).unwrap();
        let done = tasks.drain(cut());
        assert_eq!((done.accepted, done.joined, done.pending), (1, 1, 0));
        assert!(!done.panicked);
    }
    #[test]
    fn shutdown_join_preserves_original_callers_result() {
        let tasks = Arc::new(NativeTasks::default());
        let worker = tasks.admit(|| tauri::async_runtime::spawn_blocking(|| 57usize));
        assert_eq!(tasks.drain(cut()).joined, 1);
        assert_eq!(tauri::async_runtime::block_on(worker).unwrap(), 57);
        assert_eq!(tasks.facts().joined, 1); // original awaiter cannot count a second join.
    }
    #[test]
    fn closed_admission_drops_rejected_guard_outside_the_admission_mutex() {
        struct Guard {
            tasks: Arc<NativeTasks>,
            outside: Arc<AtomicBool>,
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                self.outside
                    .store(self.tasks.state.try_lock().is_ok(), Ordering::SeqCst);
            }
        }
        let tasks = Arc::new(NativeTasks::default());
        tasks.close();
        let outside = Arc::new(AtomicBool::new(false));
        let guard = Guard {
            tasks: tasks.clone(),
            outside: outside.clone(),
        };
        let worker: NativeTask<()> = tasks.admit(move || {
            drop(guard);
            panic!("closed admission must not spawn original worker")
        });
        assert!(!worker.admitted());
        assert!(outside.load(Ordering::SeqCst));
        assert_eq!(tasks.facts().accepted, 0);
    }
    #[test]
    fn actual_panicked_worker_join_is_preserved_as_failure() {
        let tasks = Arc::new(NativeTasks::default());
        let worker: NativeTask<()> =
            tasks.admit(|| tauri::async_runtime::spawn_blocking(|| panic!("owned worker fault")));
        drop(worker);
        let done = tasks.drain(cut());
        assert_eq!(done.pending, 0);
        assert_eq!(done.joined, 1);
        assert!(done.panicked);
    }
    #[test]
    fn original_expiry_std_handle_is_registered_before_work_and_retained_until_join() {
        let tasks = Arc::new(NativeTasks::default());
        let observed = tasks.clone();
        let (release, gate) = mpsc::channel();
        tasks
            .spawn_original_thread(move || {
                assert_eq!(observed.facts().accepted, 1);
                gate.recv().unwrap();
            })
            .unwrap();
        assert_eq!(tasks.drain(Instant::now()).pending, 1);
        release.send(()).unwrap();
        let done = tasks.drain(cut());
        assert_eq!((done.accepted, done.joined, done.pending), (1, 1, 0));
    }
}
