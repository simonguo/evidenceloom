use std::{
    io::{Read, Write},
    time::{Duration, Instant},
};
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "safe".into());
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    if mode == "waiting" {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    let mut output = std::io::stdout().lock();
    match mode.as_str(){
        "safe_float"=>{writeln!(output,"{{\"type\":\"completed\",\"stats\":{{\"llmCalls\":0.0,\"toolCalls\":-0.0,\"tokensIn\":0.0,\"tokensOut\":0.0,\"elapsedSeconds\":1.0}},\"reportSections\":{{\"market_report\":\"Fictional owned float research.\"}}}}").unwrap();writeln!(output,"{{\"type\":\"message\",\"message\":\"Later fictional page inherits original stats.\"}}")},
        "safe"=>writeln!(output,"{{\"type\":\"completed\",\"reportSections\":{{\"market_report\":\"Fictional owned research.\"}}}}"),
        "empty"=>writeln!(output,"{{\"type\":\"completed\",\"reportSections\":{{}}}}"),
        "critical_then_safe"=>{writeln!(output,"{{\"type\":\"completed\",\"reportSections\":null}}").unwrap();writeln!(output,"{{\"type\":\"completed\",\"reportSections\":{{\"market_report\":\"Later fictional safe report.\"}}}}")},
        "no_terminal"=>writeln!(output,"{{\"type\":\"message\",\"message\":\"Fictional message only.\"}}"),
        "malformed"=>writeln!(output,"owned non-JSON line"),
        _=>panic!("unsupported fictional fixture mode"),
    }.unwrap();
}
