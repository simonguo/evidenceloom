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
    let deadline = Instant::now() + Duration::from_secs(10);
    if mode == "leaf" {
        let mut heartbeat = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&args[2])
            .unwrap();
        let mut counter = 0;
        while Instant::now() < deadline {
            writeln!(heartbeat, "{counter}").unwrap();
            counter += 1;
            thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    if input != "{\"__command\":\"smoke_test\",\"verifyRuntime\":true}\n" {
        process::exit(2);
    }
    let child = Command::new(env::current_exe().unwrap())
        .arg("leaf")
        .arg(&args[3])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(if mode == "ready" {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .spawn()
        .unwrap();
    fs::write(&args[2], format!("{}\n{}\n", process::id(), child.id())).unwrap();
    let gate = PathBuf::from(&args[4]);
    while !gate.exists() {
        if Instant::now() >= deadline {
            process::exit(3);
        }
        thread::sleep(Duration::from_millis(5));
    }
    match mode {
        "wait" => {
            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
        }
        "exit0" => {}
        "exit1" => process::exit(1),
        "ready" => {
            println!("{{\"type\":\"runtime_ready\"}}");
            io::stdout().flush().unwrap();
        }
        _ => process::exit(4),
    }
}
