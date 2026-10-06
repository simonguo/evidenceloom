use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        if Instant::now() >= deadline {
            process::exit(9);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn descendant(directory: &Path, stream: &str) {
    let _child = Command::new(env::current_exe().unwrap())
        .arg("leaf")
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(if stream == "stdout" {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(if stream == "stderr" {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .spawn()
        .unwrap();
    until(|| fs::metadata(directory.join("heartbeat")).is_ok_and(|metadata| metadata.len() > 0));
}

fn close_stdin() {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn close(fd: i32) -> i32;
        }
        unsafe { close(0) };
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe { CloseHandle(GetStdHandle((-10i32) as u32)) };
    }
}

fn main() {
    let args: Vec<_> = env::args_os().collect();
    let mode = args[1].to_str().unwrap();
    let directory = PathBuf::from(&args[2]);
    if mode == "leaf" {
        let mut heartbeat = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("heartbeat"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut counter = 0;
        while Instant::now() < deadline {
            writeln!(heartbeat, "{counter}").unwrap();
            counter += 1;
            thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    if mode == "closed-zero" {
        close_stdin();
        fs::write(directory.join("ready"), b"closed stdin before zero exit").unwrap();
        return;
    }
    if mode == "closed" || mode == "never-read" {
        descendant(&directory, "none");
        fs::write(directory.join("ready"), b"acknowledged before input").unwrap();
        if mode == "closed" {
            close_stdin();
        }
        until(|| directory.join("release").exists());
        return;
    }
    if mode == "fill-both" {
        let output = thread::spawn(|| {
            io::stdout().write_all(&vec![b'o'; 192 * 1024]).unwrap();
        });
        io::stderr().write_all(&vec![b'e'; 96 * 1024]).unwrap();
        output.join().unwrap();
    }
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).unwrap();
    fs::write(directory.join("input"), &input).unwrap();
    match mode {
        "echo" => io::stdout().write_all(&input).unwrap(),
        "chart" => {
            assert!(input.is_empty());
            println!("[{{\"time\":\"2026-01-02\",\"open\":1,\"high\":2,\"low\":1,\"close\":2,\"volume\":3}}]");
        }
        "pretty" => println!(" \n{{\n  \"ok\": true,\n  \"message\": \"fictional-secret\"\n}} \n"),
        "invalid" => println!("{}", "x".repeat(700)),
        "lossy" => io::stdout().write_all(b"{\"message\":\"\xff\"}").unwrap(),
        "error" => {
            println!("{{\"error\":\"stdout fallback\"}}");
            eprintln!("{{\"error\":\"fictional-secret concrete failure\"}}");
            process::exit(1);
        }
        "escaped-error" => {
            println!("{}", r#"{"error":"stdout fallback"}"#);
            eprintln!(
                "{}",
                r#"{"error":"\u0066ictional-secret concrete failure"}"#
            );
            process::exit(1);
        }
        "escaped-message" => {
            println!(
                "{}",
                r#"{"message":"\u0066ictional-secret stdout failure"}"#
            );
            process::exit(1);
        }
        "escaped-success" => println!(
            "{}",
            r#"{"ok":true,"message":"\u0066ictional-secret","nested":{"values":["ordinary","\u0066ictional-secret",{"message":"prefix-\u0066ictional-secret-suffix"}],"[REDACTED]":"ordinary marker key"},"count":3,"empty":null,"flag":false}"#
        ),
        "escaped-key" => println!(
            "{}",
            r#"{"\u0066ictional-secret":"private value","[REDACTED]":"ordinary marker key","ordinary":7}"#
        ),
        "escaped-chart-time" => {
            assert!(input.is_empty());
            println!(
                "{}",
                r#"[{"time":"prefix-\u0066ictional-secret-suffix","open":1.25,"high":2,"low":0.5,"close":1.75,"volume":3},{"time":"2026-01-02","open":10,"high":12,"low":9,"close":11,"volume":99}]"#
            );
        }
        "escaped-chart-number-error" => {
            assert!(input.is_empty());
            println!(
                r#"[{{"time":"2026-01-02","open":"\u0066ictional-secret","high":2,"low":1,"close":2,"volume":3,"trailer":"{}"}}]"#,
                "x".repeat(600)
            );
        }
        "stdout-limit" => io::stdout()
            .write_all(&vec![b'x'; 1024 * 1024 + 1])
            .unwrap(),
        "stderr-limit" => io::stderr().write_all(&vec![b'x'; 256 * 1024 + 1]).unwrap(),
        "fill-both" => {}
        "held-stdout" | "held-stderr" => {
            descendant(&directory, mode.strip_prefix("held-").unwrap());
            fs::write(directory.join("ready"), b"acknowledged inherited pipe").unwrap();
            println!("{{\"ok\":true}}");
        }
        "wait" => {
            descendant(&directory, "none");
            fs::write(directory.join("ready"), b"acknowledged timeout").unwrap();
            until(|| directory.join("release").exists());
        }
        "gate" => {
            fs::write(directory.join("ready"), b"acknowledged gate").unwrap();
            until(|| directory.join("release").exists());
            println!("{{\"ok\":true}}");
        }
        "inspect" => {
            assert_eq!(
                env::var("EVIDENCELOOM_LLM_PROVIDER").unwrap(),
                "fictional-public"
            );
            assert_eq!(
                env::current_dir().unwrap().canonicalize().unwrap(),
                PathBuf::from(&args[4])
            );
            assert_eq!(args[3], "literal-$()-argument");
            println!("{{\"ok\":true}}");
        }
        _ => process::exit(8),
    }
}
