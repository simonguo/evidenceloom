use std::{
    env, fs,
    io::{self, Read, Write},
    path::PathBuf,
    process::{self, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn main() {
    let args: Vec<_> = env::args_os().collect();
    let mode = args[1].to_str().unwrap();
    let directory = PathBuf::from(&args[2]);
    let deadline = Instant::now() + Duration::from_secs(15);
    if mode == "child" {
        let mut counter = 0;
        let mut heartbeat = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("heartbeat"))
            .unwrap();
        while Instant::now() < deadline {
            writeln!(heartbeat, "{counter}").unwrap();
            counter += 1;
            thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    if mode == "closed" {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn close(fd: i32) -> i32;
            }
            unsafe {
                close(0);
            }
        }
        #[cfg(windows)]
        {
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
                fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
            }
            unsafe {
                CloseHandle(GetStdHandle((-10i32) as u32));
            }
        }
    }
    let _child = Command::new(env::current_exe().unwrap())
        .arg("child")
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(if mode == "exit-held" {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    fs::write(directory.join("ready"), process::id().to_string()).unwrap();
    if mode == "exit-held" {
        return;
    }
    if mode == "final" {
        let mut input = Vec::new();
        io::stdin().read_to_end(&mut input).unwrap();
        fs::write(directory.join("payload"), input).unwrap();
        println!("final-report");
        io::stdout().flush().unwrap();
        return;
    }
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
}
