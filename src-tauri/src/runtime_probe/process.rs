use std::{
    io,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::process::Stdio;

#[cfg(windows)]
#[path = "process/windows_job.rs"]
mod windows_job;

pub struct ProbeProcess {
    pub child: Child,
    #[cfg(unix)]
    anchor: Child,
    #[cfg(windows)]
    job: windows_job::Job,
    stopped: bool,
}

impl ProbeProcess {
    pub fn spawn(mut command: Command, deadline: Instant) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // An unreaped group leader prevents PID reuse after the probe exits.
            let mut anchor = Command::new("/bin/sleep")
                .arg("120")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()?;
            command.process_group(anchor.id() as i32);
            match command.spawn() {
                Ok(child) => Ok(Self {
                    child,
                    anchor,
                    stopped: false,
                }),
                Err(error) => {
                    let _ = anchor.kill();
                    reap_until(&mut anchor, deadline);
                    Err(error)
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let job = windows_job::Job::new()?;
            command.creation_flags(0x08000000 | 0x00000004); // NO_WINDOW | SUSPENDED
            let mut child = command.spawn()?;
            if let Err(error) = job.attach_and_resume(&child, deadline) {
                let _ = child.kill();
                reap_until(&mut child, deadline);
                return Err(error);
            }
            Ok(Self {
                child,
                job,
                stopped: false,
            })
        }
    }

    pub fn stop(&mut self, deadline: Instant) -> io::Result<()> {
        if self.stopped {
            return Ok(());
        }
        #[cfg(unix)]
        let contained = {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            // Only this unreaped anchor's isolated process group is signalled.
            unsafe { kill(-(self.anchor.id() as i32), 9) == 0 }
        };
        #[cfg(windows)]
        let contained = self.job.terminate().is_ok();
        let _ = self.child.kill();
        let reaped = reap_until(&mut self.child, deadline);
        #[cfg(unix)]
        let contained = {
            let _ = self.anchor.kill();
            reap_until(&mut self.anchor, deadline) && contained
        };
        #[cfg(windows)]
        let contained = self.job.close().is_ok() && contained;
        self.stopped = true;
        if contained && reaped {
            Ok(())
        } else {
            Err(io::Error::other("probe process cleanup failed"))
        }
    }
}

impl Drop for ProbeProcess {
    fn drop(&mut self) {
        if !self.stopped {
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
