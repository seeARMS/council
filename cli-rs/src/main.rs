mod args;
mod council;
mod engines;
mod process;
mod render;

use std::collections::HashMap;
use clap::Parser;

use args::{parse_args, ColorMode, RawArgs};
use council::{run_council, CouncilOptions, CouncilEvent, is_council_success};
use render::{render_banner, render_human_result, render_progress_event_text, should_use_color};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    let raw = RawArgs::parse();
    let parsed = match parse_args(raw) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}\n");
            eprintln!("{}", args::usage_text(VERSION));
            std::process::exit(2);
        }
    };

    if parsed.help {
        println!("{}", args::usage_text(VERSION));
        return;
    }

    if parsed.version {
        println!("{VERSION}");
        return;
    }

    let query = read_query(&parsed.prompt_parts).await;

    let stdout_is_tty = is_tty(1);
    let stderr_is_tty = is_tty(2);
    let auto_headless = !stdout_is_tty && !stderr_is_tty;
    let headless = parsed.headless || auto_headless;
    let plain = parsed.plain || headless;
    let summary_only = (parsed.summary_only || parsed.quiet || headless) && !parsed.verbose;

    let output_mode = if parsed.json_stream {
        "json-stream"
    } else if parsed.json {
        "json"
    } else {
        "text"
    };

    let stderr_color = should_use_color(&parsed.color, stderr_is_tty, plain);
    let show_banner = output_mode == "text" && stderr_is_tty && !headless && !parsed.no_banner && !plain;
    let show_progress = output_mode == "text" && stderr_is_tty && (!headless || parsed.verbose) && !parsed.quiet;

    if query.is_empty() {
        eprintln!("No query provided.\n");
        eprintln!("{}", args::usage_text(VERSION));
        std::process::exit(2);
    }

    if show_banner {
        eprintln!("{}\n", render_banner(stderr_color));
    }

    let resolved_cwd = std::fs::canonicalize(&parsed.cwd)
        .unwrap_or_else(|_| std::path::PathBuf::from(&parsed.cwd))
        .to_string_lossy()
        .to_string();

    let env: HashMap<String, String> = std::env::vars().collect();
    let json_stream = output_mode == "json-stream";

    let on_event = move |event: CouncilEvent| {
        if json_stream {
            if let Ok(s) = serde_json::to_string(&event) {
                println!("{s}");
            }
            return;
        }

        if show_progress {
            if let Some(line) = render_progress_event_text(&event, stderr_color) {
                eprintln!("{line}");
            }
        }
    };

    let result = run_council(CouncilOptions {
        query: query.clone(),
        cwd: resolved_cwd,
        members: parsed.members.clone(),
        summarizer: parsed.summarizer.clone(),
        timeout_ms: parsed.timeout_ms,
        max_member_chars: parsed.max_member_chars,
        env,
        effort: parsed.effort.clone(),
        on_event: Box::new(on_event),
    })
    .await;

    let exit_code = exit_code_for_result(&result);

    if output_mode == "json" {
        match serde_json::to_string_pretty(&result) {
            Ok(s) => println!("{s}"),
            Err(e) => eprintln!("Failed to serialize result: {e}"),
        }
    } else if output_mode == "text" {
        println!("{}", render_human_result(&result, summary_only, parsed.verbose));
    }

    std::process::exit(exit_code);
}

async fn read_query(prompt_parts: &[String]) -> String {
    if !prompt_parts.is_empty() {
        return prompt_parts.join(" ");
    }

    // Read from stdin if it's not a TTY
    if !is_tty(0) {
        use tokio::io::AsyncReadExt;
        let mut stdin_content = String::new();
        let _ = tokio::io::stdin().read_to_string(&mut stdin_content).await;
        let trimmed = stdin_content.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    String::new()
}

fn exit_code_for_result(result: &council::CouncilResult) -> i32 {
    let has_member_response = result.members.iter().any(|m| m.status == "ok");

    if has_member_response && result.summary.as_ref().map_or(false, |s| s.status == "ok") {
        return 0;
    }

    if !has_member_response {
        return 3; // NO_MEMBER_RESPONSES
    }

    4 // SUMMARY_FAILED
}

#[cfg(unix)]
fn is_tty(fd: i32) -> bool {
    unsafe { libc::isatty(fd) != 0 }
}

#[cfg(not(unix))]
fn is_tty(_fd: i32) -> bool {
    false
}
