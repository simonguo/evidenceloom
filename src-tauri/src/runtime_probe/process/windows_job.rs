use std::{
    ffi::c_void, io, mem::size_of, os::windows::io::AsRawHandle, process::Child, ptr, time::Instant,
};

type Handle = *mut c_void;

struct OwnedHandle(Handle);

impl OwnedHandle {
    fn new(handle: Handle) -> io::Result<Self> {
        if handle.is_null() || handle as isize == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

pub struct Job(OwnedHandle);

impl Job {
    pub fn new() -> io::Result<Self> {
        let handle = OwnedHandle::new(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
        let mut limits = ExtendedLimits::default();
        limits.basic.limit_flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if unsafe {
            SetInformationJobObject(
                handle.0,
                9,
                (&limits as *const ExtendedLimits).cast(),
                size_of::<ExtendedLimits>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }

    pub fn attach_and_resume(&self, child: &Child, deadline: Instant) -> io::Result<()> {
        // Assign before running any sidecar/bootloader code; children inherit the job.
        if unsafe { AssignProcessToJobObject(self.0 .0, child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let snapshot = OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(0x00000004, 0) })?;
        let mut entry = ThreadEntry {
            size: size_of::<ThreadEntry>() as u32,
            ..ThreadEntry::default()
        };
        let mut found = unsafe { Thread32First(snapshot.0, &mut entry) };
        let mut thread_id = None;
        while found != 0 {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "probe thread discovery timed out",
                ));
            }
            if entry.size >= 16 && entry.owner_process_id == child.id() {
                if thread_id.replace(entry.thread_id).is_some() {
                    return Err(io::Error::other("suspended probe thread was not unique"));
                }
            }
            entry.size = size_of::<ThreadEntry>() as u32;
            found = unsafe { Thread32Next(snapshot.0, &mut entry) };
        }
        if unsafe { GetLastError() } != 18 {
            // ERROR_NO_MORE_FILES
            return Err(io::Error::last_os_error());
        }
        let thread_id =
            thread_id.ok_or_else(|| io::Error::other("suspended probe thread was not found"))?;
        let thread = OwnedHandle::new(unsafe { OpenThread(0x00000002, 0, thread_id) })?;
        if unsafe { ResumeThread(thread.0) } == 1 {
            Ok(())
        } else {
            Err(io::Error::other("probe thread could not be resumed"))
        }
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0 .0, 1) } != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn close(&mut self) -> io::Result<()> {
        if unsafe { CloseHandle(self.0 .0) } != 0 {
            self.0 .0 = ptr::null_mut();
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time_limit: i64,
    job_time_limit: i64,
    limit_flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[repr(C)]
#[derive(Default)]
struct ThreadEntry {
    size: u32,
    count_usage: u32,
    thread_id: u32,
    owner_process_id: u32,
    base_priority: i32,
    delta_priority: i32,
    flags: u32,
}

// Stable Win32 layouts/APIs: Microsoft Job Objects and Tool Help thread walking.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
// https://learn.microsoft.com/en-us/windows/win32/toolhelp/thread-walking
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
    fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
    fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> Handle;
    fn ResumeThread(thread: Handle) -> u32;
    fn GetLastError() -> u32;
}
