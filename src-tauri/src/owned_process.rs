#[cfg(unix)]
use std::process::{ChildStdin, Stdio};
use std::{
    io,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};
#[cfg(windows)]
#[path = "owned_process/windows_job.rs"]
mod windows_job;

/// Cleanup confirms containment termination submission and known handle reaping.
pub struct OwnedProcess {
    pub child: Child,
    #[cfg(unix)]
    anchor: Option<Child>,
    #[cfg(unix)]
    anchor_input: Option<ChildStdin>,
    #[cfg(unix)]
    group_id: u32,
    #[cfg(windows)]
    job: windows_job::Job,
    termination_issued: bool,
    cleaned: bool,
    child_reaped: bool,
}

pub struct SpawnFailure {
    // Fixed-error workers retain this cause without publishing it; legacy
    // probes and test diagnostics still read the original I/O error.
    pub _error: io::Error,
    pub pending: Option<OwnedProcess>,
}

impl OwnedProcess {
    #[cfg(any(test, not(feature = "desktop-acceptance")))]
    pub fn spawn(command: Command, deadline: Instant) -> io::Result<Self> {
        Self::spawn_owned(command, deadline).map_err(|mut failure| {
            if let Some(tree) = failure.pending.as_mut() {
                let _ = tree.stop(deadline);
            }
            failure._error
        })
    }

    pub fn spawn_owned(mut command: Command, _deadline: Instant) -> Result<Self, SpawnFailure> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let mut anchor = Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .map_err(|error| SpawnFailure {
                    _error: error,
                    pending: None,
                })?;
            let group_id = anchor.id();
            let anchor_input = anchor.stdin.take();
            command.process_group(group_id as i32);
            match command.spawn() {
                Ok(child) => Ok(Self {
                    child,
                    anchor: Some(anchor),
                    anchor_input,
                    group_id,
                    termination_issued: false,
                    cleaned: false,
                    child_reaped: false,
                }),
                Err(error) => Err(SpawnFailure {
                    _error: error,
                    // The anchor itself is the only child at this boundary.
                    pending: Some(Self {
                        child: anchor,
                        anchor: None,
                        anchor_input,
                        group_id,
                        termination_issued: false,
                        cleaned: false,
                        child_reaped: false,
                    }),
                }),
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let job = windows_job::Job::new().map_err(|error| SpawnFailure {
                _error: error,
                pending: None,
            })?;
            command.creation_flags(0x08000000 | 0x00000004);
            let child = command.spawn().map_err(|error| SpawnFailure {
                _error: error,
                pending: None,
            })?;
            let tree = Self {
                child,
                job,
                termination_issued: false,
                cleaned: false,
                child_reaped: false,
            };
            if let Err(error) = tree.job.attach_and_resume(&tree.child, _deadline) {
                return Err(SpawnFailure {
                    _error: error,
                    pending: Some(tree),
                });
            }
            Ok(tree)
        }
    }

    pub fn stop(&mut self, deadline: Instant) -> io::Result<()> {
        self.stop_with_termination(deadline, Self::submit_termination)
    }

    pub(crate) fn stop_with_termination(
        &mut self,
        deadline: Instant,
        terminate: impl FnOnce(&mut Self) -> io::Result<()>,
    ) -> io::Result<()> {
        self.stop_with_reaping(deadline, terminate, reap_until)
    }

    pub(crate) fn stop_with_reaping(
        &mut self,
        deadline: Instant,
        terminate: impl FnOnce(&mut Self) -> io::Result<()>,
        mut reap: impl FnMut(&mut Child, Instant) -> bool,
    ) -> io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        if !self.termination_issued {
            terminate(self)?;
            self.termination_issued = true;
        }
        if !self.child_reaped {
            if self.child.try_wait()?.is_none() {
                // Only signal a direct child still owned and unreaped.
                let _ = self.child.kill();
            }
            if !reap(&mut self.child, deadline) {
                return Err(io::Error::other("owned child reaping incomplete"));
            }
            self.child_reaped = true;
        }
        #[cfg(unix)]
        {
            if let Some(anchor) = self.anchor.as_mut() {
                if !reap(anchor, deadline) {
                    return Err(io::Error::other("owned anchor reaping incomplete"));
                }
            }
            self.anchor = None;
            self.anchor_input = None;
        }
        #[cfg(windows)]
        self.job.close()?;
        self.cleaned = true;
        Ok(())
    }

    pub(crate) fn submit_termination(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            // The leader remains owned and unreaped until this submission.
            if unsafe { kill(-(self.group_id as i32), 9) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(windows)]
        self.job.terminate()?;
        Ok(())
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.stop(Instant::now() + Duration::from_millis(100));
        }
    }
}

fn reap_until(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) if Instant::now() < deadline => thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            ),
            Ok(None) => return false,
        }
    }
}
