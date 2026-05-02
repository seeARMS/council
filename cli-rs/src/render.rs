use crate::council::{CouncilResult, SummaryResult};
use crate::engines::EngineResult;

pub fn render_human_result(
    result: &CouncilResult,
    summary_only: bool,
    verbose: bool,
) -> String {
    if summary_only {
        if let Some(ref summary) = result.summary {
            if summary.status == "ok" {
                return summary.output.clone();
            }
        }
        return render_summary_failure(result.summary.as_ref());
    }

    let mut lines: Vec<String> = Vec::new();

    let successful: Vec<&EngineResult> = result.members.iter().filter(|m| m.status == "ok").collect();
    let non_successful: Vec<&EngineResult> = result.members.iter().filter(|m| m.status != "ok").collect();

    let member_names: Vec<&str> = successful.iter().map(|m| m.name.as_str()).collect();
    lines.push(format!(
        "Members: {}",
        if member_names.is_empty() {
            "none".to_string()
        } else {
            member_names.join(", ")
        }
    ));

    if !non_successful.is_empty() {
        if verbose {
            let skipped: Vec<&str> = non_successful.iter().map(|m| m.name.as_str()).collect();
            lines.push(format!("Skipped: {}", skipped.join(", ")));
        } else {
            let skipped: Vec<String> = non_successful
                .iter()
                .map(|m| format!("{} ({})", m.name, m.detail))
                .collect();
            lines.push(format!("Skipped: {}", skipped.join(", ")));
        }
    }

    if let Some(ref summary) = result.summary {
        if let Some(ref name) = summary.name {
            lines.push(format!("Summarizer: {name}"));
        }
    }

    for member in &successful {
        lines.push(String::new());
        lines.push(format!(
            "=== {} ({}) ===",
            member.name,
            format_duration(member.duration_ms)
        ));
        lines.push(member.output.clone());
    }

    if verbose {
        for member in &non_successful {
            lines.push(String::new());
            lines.push(format!(
                "=== {} ({}: {}) ===",
                member.name, member.status, member.detail
            ));
            lines.push(if member.output.is_empty() {
                "(no output)".to_string()
            } else {
                member.output.clone()
            });
        }
    }

    lines.push(String::new());
    let summary_header = match &result.summary {
        Some(s) if s.name.is_some() => format!(
            "=== synthesis via {} ({}) ===",
            s.name.as_deref().unwrap_or(""),
            format_duration(s.duration_ms)
        ),
        _ => "=== synthesis ===".to_string(),
    };
    lines.push(summary_header);

    match &result.summary {
        Some(s) if s.status == "ok" => lines.push(s.output.clone()),
        _ => lines.push(render_summary_failure(result.summary.as_ref())),
    }

    lines.join("\n")
}

pub fn render_summary_failure(summary: Option<&SummaryResult>) -> String {
    match summary {
        None => "Summary failed.".to_string(),
        Some(s) => match &s.name {
            Some(name) => format!(
                "Summary failed via {}: {}",
                name,
                if s.detail.is_empty() {
                    "Unknown error.".to_string()
                } else {
                    s.detail.clone()
                }
            ),
            None => format!(
                "Summary failed: {}",
                if s.detail.is_empty() {
                    "Unknown error.".to_string()
                } else {
                    s.detail.clone()
                }
            ),
        },
    }
}

pub fn format_duration(ms: u64) -> String {
    if ms < 1_000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

pub fn render_progress_event_text(event: &crate::council::CouncilEvent, color_enabled: bool) -> Option<String> {
    use crate::council::CouncilEvent::*;
    let line = match event {
        RunStarted { members, .. } => {
            style(&format!("Council is consulting: {}", members.join(", ")), "36", color_enabled)
        }
        MemberStarted { name, .. } => {
            style(&format!("[run] {name}: thinking..."), "36", color_enabled)
        }
        MemberCompleted { result, .. } => render_status_line(result, color_enabled),
        MemberProgress { name, detail, .. } => {
            style(&format!("[wait] {name}: {detail}"), "90", color_enabled)
        }
        MemberHeartbeat { name, elapsed_ms, .. } => {
            style(&format!("[wait] {name} still running ({})", format_duration(*elapsed_ms)), "90", color_enabled)
        }
        SummaryStarted { name, .. } => {
            style(&format!("[sum] {name}: synthesizing..."), "33", color_enabled)
        }
        SummaryProgress { name, detail, .. } => {
            style(&format!("[wait] synthesis via {name}: {detail}"), "90", color_enabled)
        }
        SummaryHeartbeat { name, elapsed_ms, .. } => {
            style(
                &format!("[wait] synthesis via {name} still running ({})", format_duration(*elapsed_ms)),
                "90",
                color_enabled,
            )
        }
        SummaryCompleted { result, .. } => render_summary_status_line(result, color_enabled),
        RunCompleted { success, .. } => style(
            if *success {
                "[done] council completed successfully"
            } else {
                "[done] council completed with failures"
            },
            if *success { "32" } else { "31" },
            color_enabled,
        ),
    };
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

fn render_status_line(result: &EngineResult, color_enabled: bool) -> String {
    match result.status.as_str() {
        "ok" => style(
            &format!("[ok]   {} ({})", result.name, format_duration(result.duration_ms)),
            "32",
            color_enabled,
        ),
        "missing" => style(&format!("[skip] {}: {}", result.name, result.detail), "33", color_enabled),
        "timeout" => style(&format!("[time] {}: {}", result.name, result.detail), "31", color_enabled),
        _ => style(&format!("[err]  {}: {}", result.name, result.detail), "31", color_enabled),
    }
}

fn render_summary_status_line(result: &SummaryResult, color_enabled: bool) -> String {
    if result.status == "ok" {
        style(
            &format!(
                "[ok]   synthesis via {} ({})",
                result.name.as_deref().unwrap_or(""),
                format_duration(result.duration_ms)
            ),
            "32",
            color_enabled,
        )
    } else {
        style(
            &format!(
                "[err]  synthesis via {}: {}",
                result.name.as_deref().unwrap_or("none"),
                result.detail
            ),
            "31",
            color_enabled,
        )
    }
}

fn style(text: &str, ansi_code: &str, enabled: bool) -> String {
    if enabled {
        format!("\x1b[{ansi_code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn render_banner(color_enabled: bool) -> String {
    let lines = [
        "  ____   ___  _   _ _   _  ____ ___ _     ",
        " / ___| / _ \\| | | | \\ | |/ ___|_ _| |    ",
        "| |    | | | | | | |  \\| | |    | || |    ",
        "| |___ | |_| | |_| | |\\  | |___ | || |___ ",
        " \\____| \\___/ \\___/|_| \\_|\\____|___|_____|",
        "",
        " consult codex + claude + gemini, then synthesize once",
    ];
    let palette = ["36", "36", "94", "94", "33", "90", "90"];
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| style(line, palette[i.min(palette.len() - 1)], color_enabled))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn should_use_color(preference: &crate::args::ColorMode, is_tty: bool, plain: bool) -> bool {
    use crate::args::ColorMode::*;
    if plain {
        return false;
    }
    match preference {
        Always => true,
        Never => false,
        Auto => {
            if !is_tty {
                return false;
            }
            if std::env::var("NO_COLOR").map_or(false, |v| !v.is_empty() && v != "0") {
                return false;
            }
            if std::env::var("TERM").map_or(false, |v| v == "dumb") {
                return false;
            }
            true
        }
    }
}
