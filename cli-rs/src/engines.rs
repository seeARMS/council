use std::collections::HashMap;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::fs;

use crate::process::{extract_json_object, run_command, ChunkContext, CommandResult, Interruption, RunOptions};

pub const DEFAULT_SUMMARIZER_ORDER: &[&str] = &["codex", "claude", "gemini"];

const GEMINI_THINKING_BUDGETS: &[(&str, u64)] = &[("low", 1024), ("medium", 8192), ("high", 24576)];
const GEMINI_LOGIN_DETAIL: &str =
    "Gemini CLI requires login. Run `gemini` in a normal terminal, complete authentication in your browser, then retry council.";

#[derive(Debug, Clone, serde::Serialize)]
pub struct EngineResult {
    pub name: String,
    pub bin: String,
    pub status: String,
    pub duration_ms: u64,
    pub detail: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output: String,
}

pub struct RunEngineOptions {
    pub prompt: String,
    pub cwd: String,
    pub timeout_ms: u64,
    pub env: HashMap<String, String>,
    pub effort: Option<String>,
    pub on_progress: Box<dyn Fn(&str) + Send + Sync>,
}

pub async fn run_engine(name: &str, opts: RunEngineOptions) -> EngineResult {
    match name {
        "codex" => run_codex(opts).await,
        "claude" => run_claude(opts).await,
        "gemini" => run_gemini(opts).await,
        _ => panic!("Unknown engine: {name}"),
    }
}

pub fn build_member_prompt(query: &str) -> String {
    [
        "You are one member of a multi-model council.",
        "Answer the user query directly.",
        "Do not introduce yourself.",
        "Do not describe your tools, environment, or capabilities unless the user explicitly asks.",
        "If the query is a quick test, acknowledge it briefly and answer in one sentence.",
        "Be concise unless the user asks for depth.",
        "",
        "Current user query:",
        query.trim(),
    ]
    .join("\n")
}

pub fn build_summary_prompt(query: &str, responses: &[&EngineResult], max_member_chars: usize) -> String {
    let response_blocks: Vec<String> = responses
        .iter()
        .map(|r| {
            format!(
                "### {}\n{}",
                r.name,
                truncate_for_summary(r.output.trim(), max_member_chars)
            )
        })
        .collect();

    let sections: Vec<&str> = vec![
        "You are synthesizing answers from multiple AI CLI tools.",
        "Produce one final answer to the original user query.",
        "Answer the query directly. Do not introduce yourself or describe your environment.",
        "Use the strongest points from the responses below.",
        "Call out meaningful disagreement or uncertainty when it exists.",
        "Stay grounded in the provided responses. Do not invent consensus.",
        "If only one response is available, lightly polish it rather than pretending there was agreement.",
    ];

    let mut parts = sections.join("\n");
    parts.push_str("\n\nCurrent user query:\n");
    parts.push_str(query.trim());
    parts.push_str("\n\nCouncil member responses:\n");
    parts.push_str(&response_blocks.join("\n\n"));
    parts
}

pub fn parse_claude_output(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(parsed) = extract_json_object(trimmed) {
        if let Some(result) = parsed.get("result").and_then(|v| v.as_str()) {
            return result.trim().to_string();
        }
    }

    // Scan JSONL lines backwards for result or assistant events
    let events: Vec<serde_json::Value> = trimmed
        .lines()
        .filter_map(|line| {
            let l = line.trim();
            if l.is_empty() {
                return None;
            }
            serde_json::from_str(l).ok()
        })
        .collect();

    for event in events.iter().rev() {
        if event.get("type").and_then(|v| v.as_str()) == Some("result") {
            if let Some(result) = event.get("result").and_then(|v| v.as_str()) {
                return result.trim().to_string();
            }
        }

        if event.get("type").and_then(|v| v.as_str()) == Some("assistant") {
            if let Some(content) = event
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                let text: String = content
                    .iter()
                    .filter(|block| {
                        block.get("type").and_then(|t| t.as_str()) == Some("text")
                    })
                    .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<&str>>()
                    .join("");

                if !text.trim().is_empty() {
                    return text.trim().to_string();
                }
            }
        }
    }

    trimmed.to_string()
}

pub fn parse_gemini_output(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(parsed) = extract_json_object(trimmed) {
        if let Some(response) = parsed.get("response").and_then(|v| v.as_str()) {
            return response.trim().to_string();
        }
    }

    trimmed.to_string()
}

fn resolve_binary(name: &str, env: &HashMap<String, String>) -> String {
    let env_var = match name {
        "codex" => "COUNCIL_CODEX_BIN",
        "claude" => "COUNCIL_CLAUDE_BIN",
        "gemini" => "COUNCIL_GEMINI_BIN",
        _ => unreachable!(),
    };

    env.get(env_var)
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| name.to_string())
}

async fn run_codex(opts: RunEngineOptions) -> EngineResult {
    let bin = resolve_binary("codex", &opts.env);
    let started_at = std::time::Instant::now();

    let temp_dir = match TempDir::with_prefix("council-codex-") {
        Ok(d) => d,
        Err(e) => {
            return error_result("codex", &bin, started_at.elapsed().as_millis() as u64, e.to_string());
        }
    };
    let output_path = temp_dir.path().join("last-message.txt");

    let effort_args: Vec<String> = opts
        .effort
        .as_deref()
        .map(|e| vec!["-c".to_string(), format!("model_reasoning_effort={e}")])
        .unwrap_or_default();

    let mut args = vec!["exec".to_string()];
    args.extend(effort_args);
    args.extend([
        "--skip-git-repo-check".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "--ephemeral".to_string(),
        "--json".to_string(),
        "-o".to_string(),
        output_path.to_string_lossy().to_string(),
        "-".to_string(),
    ]);

    let on_progress = opts.on_progress;
    let mut jsonl_buf = String::new();
    let mut last_detail = String::new();

    let command_result = run_command(RunOptions {
        command: bin.clone(),
        args,
        cwd: opts.cwd,
        env: opts.env,
        stdin_text: opts.prompt,
        timeout_ms: opts.timeout_ms,
        interrupt_when: None,
        on_chunk: Some(Box::new(move |ctx: ChunkContext| {
            if ctx.source == "stdout" {
                if let Some(detail) = parse_codex_progress(&mut jsonl_buf, &ctx.chunk) {
                    if detail != last_detail {
                        last_detail = detail.clone();
                        on_progress(&detail);
                    }
                }
            }
        })),
    })
    .await;

    let output = fs::read_to_string(&output_path)
        .await
        .unwrap_or_default()
        .trim()
        .to_string();

    finalize_result("codex", &bin, started_at.elapsed().as_millis() as u64, command_result, output, String::new())
}

async fn run_claude(opts: RunEngineOptions) -> EngineResult {
    let bin = resolve_binary("claude", &opts.env);
    let started_at = std::time::Instant::now();

    let effort_args: Vec<String> = opts
        .effort
        .as_deref()
        .map(|e| vec!["--effort".to_string(), e.to_string()])
        .unwrap_or_default();

    let mut args = vec![
        "--bare".to_string(),
        "-p".to_string(),
        "--permission-mode".to_string(),
        "plan".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--no-session-persistence".to_string(),
    ];
    args.extend(effort_args);

    let on_progress = opts.on_progress;
    let mut jsonl_buf = String::new();
    let mut claude_state = ClaudeProgressState::default();
    let mut last_detail = String::new();

    let command_result = run_command(RunOptions {
        command: bin.clone(),
        args,
        cwd: opts.cwd,
        env: opts.env,
        stdin_text: opts.prompt,
        timeout_ms: opts.timeout_ms,
        interrupt_when: None,
        on_chunk: Some(Box::new(move |ctx: ChunkContext| {
            if ctx.source == "stdout" {
                if let Some(detail) = parse_claude_progress(&mut jsonl_buf, &mut claude_state, &ctx.chunk) {
                    if detail != last_detail {
                        last_detail = detail.clone();
                        on_progress(&detail);
                    }
                }
            }
        })),
    })
    .await;

    let output = parse_claude_output(&command_result.stdout);
    finalize_result("claude", &bin, started_at.elapsed().as_millis() as u64, command_result, output, String::new())
}

async fn run_gemini(opts: RunEngineOptions) -> EngineResult {
    let bin = resolve_binary("gemini", &opts.env);
    let started_at = std::time::Instant::now();

    let effort_context = prepare_gemini_effort_settings(opts.effort.as_deref(), &opts.env).await;
    let run_env = if let Some(ref ctx) = effort_context {
        let mut env = opts.env.clone();
        env.insert(
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_string(),
            ctx.settings_path.to_string_lossy().to_string(),
        );
        env
    } else {
        opts.env.clone()
    };

    let on_progress = opts.on_progress;
    let mut last_detail = String::new();

    let command_result = run_command(RunOptions {
        command: bin.clone(),
        args: vec![
            "-p".to_string(),
            opts.prompt.clone(),
            "--skip-trust".to_string(),
            "--approval-mode".to_string(),
            "plan".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
        ],
        cwd: opts.cwd,
        env: run_env,
        stdin_text: String::new(),
        timeout_ms: opts.timeout_ms,
        interrupt_when: Some(Box::new(|stdout, stderr| {
            detect_gemini_login_required(stdout, stderr)
        })),
        on_chunk: Some(Box::new(move |ctx: ChunkContext| {
            if ctx.source == "stderr" {
                if let Some(detail) = detect_gemini_retry_progress(&ctx.chunk, &ctx.stderr) {
                    if detail != last_detail {
                        last_detail = detail.clone();
                        on_progress(&detail);
                    }
                }
            }
        })),
    })
    .await;

    let auth_required = is_gemini_login_required(&command_result.stdout, &command_result.stderr);
    let output = if auth_required {
        String::new()
    } else {
        parse_gemini_output(&command_result.stdout)
    };
    let detail_override = if auth_required {
        GEMINI_LOGIN_DETAIL.to_string()
    } else {
        String::new()
    };

    finalize_result("gemini", &bin, started_at.elapsed().as_millis() as u64, command_result, output, detail_override)
}

struct GeminiEffortContext {
    _temp_dir: TempDir,
    settings_path: PathBuf,
}

async fn prepare_gemini_effort_settings(
    effort: Option<&str>,
    env: &HashMap<String, String>,
) -> Option<GeminiEffortContext> {
    let effort = effort?;
    let budget = GEMINI_THINKING_BUDGETS
        .iter()
        .find(|(k, _)| *k == effort)
        .map(|(_, v)| *v)?;

    let temp_dir = TempDir::with_prefix("council-gemini-effort-").ok()?;
    let settings_path = temp_dir.path().join("settings.json");

    let settings = merge_gemini_settings(env.get("GEMINI_CLI_SYSTEM_SETTINGS_PATH").map(|s| s.as_str()), budget).await;
    fs::write(&settings_path, serde_json::to_string(&settings).unwrap_or_default())
        .await
        .ok()?;

    Some(GeminiEffortContext { _temp_dir: temp_dir, settings_path })
}

async fn merge_gemini_settings(existing_path: Option<&str>, thinking_budget: u64) -> serde_json::Value {
    let mut base = serde_json::json!({ "thinkingBudget": thinking_budget });

    if let Some(path) = existing_path {
        if let Ok(content) = fs::read_to_string(path).await {
            if let Ok(existing) = serde_json::from_str::<serde_json::Value>(&content) {
                if existing.is_object() && !existing.is_array() {
                    if let Some(obj) = existing.as_object() {
                        let mut merged = obj.clone();
                        merged.insert("thinkingBudget".to_string(), serde_json::json!(thinking_budget));
                        base = serde_json::Value::Object(merged);
                    }
                }
            }
        }
    }

    base
}

fn detect_gemini_login_required(stdout: &str, stderr: &str) -> Option<Interruption> {
    if is_gemini_login_required(stdout, stderr) {
        Some(Interruption {
            kind: "auth_required".to_string(),
            status: "error".to_string(),
            detail: GEMINI_LOGIN_DETAIL.to_string(),
        })
    } else {
        None
    }
}

fn is_gemini_login_required(stdout: &str, stderr: &str) -> bool {
    let combined = format!("{stdout}\n{stderr}");
    combined.contains("Opening authentication page in your browser.")
        || combined.contains("Error authenticating:")
        || combined.contains("Authentication cancelled by user")
}

fn detect_gemini_retry_progress(chunk: &str, full_stderr: &str) -> Option<String> {
    let re = regex_lite::Regex::new(r"Attempt (\d+) failed with status (\d+)\. Retrying with backoff\.\.\.").ok()?;
    let captures: Vec<_> = re.captures_iter(full_stderr).collect();
    let latest = captures.last()?;
    let attempt = &latest[1];
    let status = &latest[2];
    let capacity_exhausted = full_stderr.contains("MODEL_CAPACITY_EXHAUSTED")
        || full_stderr.contains("No capacity available for model");
    let _ = chunk;

    Some(if capacity_exhausted {
        format!("Attempt {attempt} failed: model capacity exhausted ({status}). Retrying with backoff...")
    } else {
        format!("Attempt {attempt} failed with status {status}. Retrying with backoff...")
    })
}

fn finalize_result(
    name: &str,
    bin: &str,
    duration_ms: u64,
    command_result: CommandResult,
    output: String,
    detail_override: String,
) -> EngineResult {
    // Binary not found
    if let Some(ref err) = command_result.spawn_error {
        if err.starts_with("ENOENT") {
            return EngineResult {
                name: name.to_string(),
                bin: bin.to_string(),
                status: "missing".to_string(),
                duration_ms,
                detail: format!("{bin} is not installed or not on PATH."),
                exit_code: None,
                signal: None,
                stdout: command_result.stdout,
                stderr: command_result.stderr,
                output: String::new(),
            };
        }
    }

    let detail = if !detail_override.is_empty() {
        detail_override
    } else {
        summarize_failure(&command_result, &output)
    };

    if let Some(ref intr) = command_result.interruption {
        return EngineResult {
            name: name.to_string(),
            bin: bin.to_string(),
            status: intr.status.clone(),
            duration_ms,
            detail: if !detail.is_empty() { detail } else { intr.detail.clone() },
            exit_code: command_result.exit_code,
            signal: command_result.signal,
            stdout: command_result.stdout,
            stderr: command_result.stderr,
            output: String::new(),
        };
    }

    if command_result.timed_out {
        return EngineResult {
            name: name.to_string(),
            bin: bin.to_string(),
            status: "timeout".to_string(),
            duration_ms,
            detail: format!(
                "Timed out after {}s.",
                (command_result.timeout_ms as f64 / 1000.0).round() as u64
            ),
            exit_code: command_result.exit_code,
            signal: command_result.signal,
            stdout: command_result.stdout,
            stderr: command_result.stderr,
            output,
        };
    }

    if command_result.spawn_error.is_some() {
        return EngineResult {
            name: name.to_string(),
            bin: bin.to_string(),
            status: "error".to_string(),
            duration_ms,
            detail,
            exit_code: None,
            signal: None,
            stdout: command_result.stdout,
            stderr: command_result.stderr,
            output,
        };
    }

    if command_result.exit_code != Some(0) {
        return EngineResult {
            name: name.to_string(),
            bin: bin.to_string(),
            status: "error".to_string(),
            duration_ms,
            detail,
            exit_code: command_result.exit_code,
            signal: command_result.signal,
            stdout: command_result.stdout,
            stderr: command_result.stderr,
            output,
        };
    }

    if output.is_empty() {
        return EngineResult {
            name: name.to_string(),
            bin: bin.to_string(),
            status: "error".to_string(),
            duration_ms,
            detail: if detail.is_empty() {
                "The CLI exited successfully but returned no output.".to_string()
            } else {
                detail
            },
            exit_code: command_result.exit_code,
            signal: command_result.signal,
            stdout: command_result.stdout,
            stderr: command_result.stderr,
            output: String::new(),
        };
    }

    EngineResult {
        name: name.to_string(),
        bin: bin.to_string(),
        status: "ok".to_string(),
        duration_ms,
        detail: String::new(),
        exit_code: command_result.exit_code,
        signal: command_result.signal,
        stdout: command_result.stdout,
        stderr: command_result.stderr,
        output,
    }
}

fn summarize_failure(result: &CommandResult, output: &str) -> String {
    if let Some(ref err) = result.spawn_error {
        if !err.starts_with("ENOENT") {
            return err.clone();
        }
    }

    let stderr = result.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }

    let stdout = result.stdout.trim();
    if !stdout.is_empty() && stdout != output.trim() {
        return stdout.to_string();
    }

    if result.exit_code != Some(0) {
        if let Some(code) = result.exit_code {
            return format!("Exited with code {code}.");
        }
    }

    String::new()
}

fn error_result(name: &str, bin: &str, duration_ms: u64, detail: String) -> EngineResult {
    EngineResult {
        name: name.to_string(),
        bin: bin.to_string(),
        status: "error".to_string(),
        duration_ms,
        detail,
        exit_code: None,
        signal: None,
        stdout: String::new(),
        stderr: String::new(),
        output: String::new(),
    }
}

// --- Progress tracking ---

fn consume_jsonl(buf: &mut String, chunk: &str) -> Vec<serde_json::Value> {
    buf.push_str(chunk);
    let mut events = Vec::new();
    while let Some(idx) = buf.find('\n') {
        let line = buf[..idx].trim().to_string();
        *buf = buf[idx + 1..].to_string();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str(&line) {
            events.push(v);
        }
    }
    events
}

fn parse_codex_progress(buf: &mut String, chunk: &str) -> Option<String> {
    let events = consume_jsonl(buf, chunk);
    let mut result = None;
    for event in events {
        if event.get("type").and_then(|v| v.as_str()) == Some("item.started") {
            if let Some(item) = event.get("item") {
                if item.get("type").and_then(|v| v.as_str()) == Some("command_execution") {
                    if let Some(cmd) = item.get("command").and_then(|v| v.as_str()) {
                        result = Some(format!("running shell: {}", truncate_detail(&compact_whitespace(cmd))));
                    }
                }
            }
        }
    }
    result
}

#[derive(Default)]
struct ClaudeProgressState {
    thinking: String,
    tool_input: String,
    current_tool_name: String,
    draft_text: String,
}

fn parse_claude_progress(buf: &mut String, state: &mut ClaudeProgressState, chunk: &str) -> Option<String> {
    let events = consume_jsonl(buf, chunk);
    let mut result = None;
    for event in events {
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if event_type == "system" {
            if event.get("subtype").and_then(|v| v.as_str()) == Some("status")
                && event.get("status").and_then(|v| v.as_str()) == Some("requesting")
            {
                result = Some("thinking...".to_string());
            }
            continue;
        }

        if event_type == "stream_event" {
            if let Some(stream_event) = event.get("event") {
                let se_type = stream_event.get("type").and_then(|v| v.as_str()).unwrap_or("");

                if se_type == "content_block_delta" {
                    if let Some(delta) = stream_event.get("delta") {
                        let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");

                        if delta_type == "thinking_delta" {
                            if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                                state.thinking.push_str(t);
                                result = Some(format!(
                                    "thinking: {}",
                                    truncate_detail(&compact_whitespace(&state.thinking))
                                ));
                            }
                        } else if delta_type == "input_json_delta" {
                            if let Some(json) = delta.get("partial_json").and_then(|v| v.as_str()) {
                                state.tool_input.push_str(json);
                                if let Some(detail) = describe_claude_tool(&state.current_tool_name, &state.tool_input) {
                                    result = Some(detail);
                                }
                            }
                        } else if delta_type == "text_delta" {
                            if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                                state.draft_text.push_str(t);
                                result = Some(format!(
                                    "drafting answer: {}",
                                    truncate_detail(&compact_whitespace(&state.draft_text))
                                ));
                            }
                        }
                    }
                } else if se_type == "content_block_start" {
                    if let Some(cb) = stream_event.get("content_block") {
                        let cb_type = cb.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if cb_type == "thinking" {
                            state.thinking.clear();
                            state.draft_text.clear();
                        } else if cb_type == "tool_use" {
                            state.current_tool_name = cb
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            state.tool_input.clear();
                            result = Some(format!("{}: preparing tool input...", state.current_tool_name));
                        }
                    }
                }
            }
            continue;
        }

        if event_type == "assistant" {
            if let Some(content) = event
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                if let Some(tool_block) = content.iter().find(|b| {
                    b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                }) {
                    let tool_name = tool_block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(state.current_tool_name.as_str())
                        .to_string();
                    state.current_tool_name = tool_name.clone();
                    let input_json = tool_block
                        .get("input")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_default();
                    if let Some(detail) = describe_claude_tool(&tool_name, &input_json) {
                        result = Some(detail);
                    }
                }
            }
        }
    }
    result
}

fn describe_claude_tool(tool_name: &str, partial_json: &str) -> Option<String> {
    if tool_name.is_empty() {
        return None;
    }

    let parsed = extract_json_object(partial_json);
    let description = parsed
        .as_ref()
        .and_then(|p| p.get("description"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| compact_whitespace(s));
    let command = parsed
        .as_ref()
        .and_then(|p| p.get("command"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| compact_whitespace(s));

    match (description, command) {
        (Some(d), Some(c)) => Some(format!("{tool_name}: {}", truncate_detail(&format!("{d} ({c})")))),
        (Some(d), None) => Some(format!("{tool_name}: {}", truncate_detail(&d))),
        (None, Some(c)) => Some(format!("{tool_name}: {}", truncate_detail(&c))),
        (None, None) => Some(format!("{tool_name}: preparing tool input...")),
    }
}

fn compact_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_detail(text: &str) -> String {
    const MAX: usize = 120;
    if text.len() <= MAX {
        return text.to_string();
    }
    let mut s = text[..MAX.saturating_sub(3)].trim_end().to_string();
    s.push_str("...");
    s
}

fn truncate_for_summary(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let truncated = text[..max_chars].trim_end();
    format!("{truncated}\n\n[truncated by council after {max_chars} characters]")
}
