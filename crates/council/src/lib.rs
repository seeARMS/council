use clap::{ArgAction, CommandFactory, Parser, ValueEnum};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod linear_delivery;
mod studio;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_MAX_MEMBER_CHARS: usize = 12_000;
const DEFAULT_ITERATIONS: usize = 1;
const DEFAULT_TEAM_SIZE: usize = 0;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN: usize = 4;

const ENGINES: [&str; 3] = ["codex", "claude", "gemini"];
const DEFAULT_SUMMARIZER_ORDER: [&str; 3] = ["codex", "claude", "gemini"];
const DEFAULT_AUTH_MODE: &str = "auto";
const CAPABILITY_INHERIT: &str = "inherit";
const CAPABILITY_OVERRIDE: &str = "override";

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
enum Engine {
    Codex,
    Claude,
    Gemini,
}

impl Engine {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Gemini => "gemini",
        }
    }

    fn binary_env_var(self) -> &'static str {
        match self {
            Self::Codex => "COUNCIL_CODEX_BIN",
            Self::Claude => "COUNCIL_CLAUDE_BIN",
            Self::Gemini => "COUNCIL_GEMINI_BIN",
        }
    }

    fn allowed_efforts(self) -> &'static [&'static str] {
        match self {
            Self::Codex => &["low", "medium", "high", "xhigh", ""],
            Self::Claude => &["low", "medium", "high", "xhigh", "max"],
            Self::Gemini => &["low", "medium", "high", ""],
        }
    }
}

#[derive(Parser, Debug, Clone)]
#[command(
    name = "council",
    version,
    about = "Ask multiple AI CLIs the same question, then synthesize their answers.",
    trailing_var_arg = true,
    disable_version_flag = true
)]
pub struct CliArgs {
    #[arg(short = 'v', long = "version", action = ArgAction::SetTrue)]
    version: bool,

    #[arg(long, action = ArgAction::SetTrue)]
    json: bool,

    #[arg(long = "json-stream", alias = "ndjson", action = ArgAction::SetTrue)]
    json_stream: bool,

    #[arg(long, action = ArgAction::SetTrue)]
    headless: bool,

    #[arg(long, action = ArgAction::SetTrue)]
    studio: bool,

    #[arg(long, action = ArgAction::SetTrue)]
    plain: bool,

    #[arg(long = "no-banner", action = ArgAction::SetTrue)]
    no_banner: bool,

    #[arg(short = 'q', long = "quiet", alias = "summary-only", action = ArgAction::SetTrue)]
    summary_only: bool,

    #[arg(short = 'd', long, action = ArgAction::SetTrue)]
    verbose: bool,

    #[arg(long, action = ArgAction::SetTrue)]
    all: bool,

    #[arg(long, action = ArgAction::SetTrue)]
    codex: bool,
    #[arg(long = "no-codex", action = ArgAction::SetTrue)]
    no_codex: bool,
    #[arg(long, action = ArgAction::SetTrue)]
    claude: bool,
    #[arg(long = "no-claude", action = ArgAction::SetTrue)]
    no_claude: bool,
    #[arg(long, action = ArgAction::SetTrue)]
    gemini: bool,
    #[arg(long = "no-gemini", action = ArgAction::SetTrue)]
    no_gemini: bool,

    #[arg(long, value_delimiter = ',')]
    members: Vec<String>,

    #[arg(long, default_value = "auto")]
    summarizer: String,

    #[arg(long, value_enum)]
    effort: Option<Effort>,

    #[arg(long = "codex-model")]
    codex_model: Option<String>,
    #[arg(long = "claude-model")]
    claude_model: Option<String>,
    #[arg(long = "gemini-model")]
    gemini_model: Option<String>,

    #[arg(long = "codex-effort")]
    codex_effort: Option<String>,
    #[arg(long = "claude-effort")]
    claude_effort: Option<String>,
    #[arg(long = "gemini-effort")]
    gemini_effort: Option<String>,

    #[arg(long = "codex-sandbox", default_value = "read-only")]
    codex_sandbox: String,
    #[arg(long = "claude-permission-mode", default_value = "plan")]
    claude_permission_mode: String,

    #[arg(long = "codex-auth", default_value = "auto")]
    codex_auth: String,
    #[arg(long = "claude-auth", default_value = "auto")]
    claude_auth: String,
    #[arg(long = "gemini-auth", default_value = "auto")]
    gemini_auth: String,

    #[arg(long = "codex-capabilities", default_value = "inherit")]
    codex_capabilities: String,
    #[arg(long = "claude-capabilities", default_value = "inherit")]
    claude_capabilities: String,
    #[arg(long = "gemini-capabilities", default_value = "inherit")]
    gemini_capabilities: String,

    #[arg(long = "codex-config", action = ArgAction::Append)]
    codex_config: Vec<String>,
    #[arg(long = "codex-mcp-profile")]
    codex_mcp_profile: Option<String>,
    #[arg(long = "claude-mcp-config", action = ArgAction::Append)]
    claude_mcp_config: Vec<String>,
    #[arg(long = "claude-allowed-tools", value_delimiter = ',', action = ArgAction::Append)]
    claude_allowed_tools: Vec<String>,
    #[arg(long = "claude-disallowed-tools", value_delimiter = ',', action = ArgAction::Append)]
    claude_disallowed_tools: Vec<String>,
    #[arg(long = "claude-tools", value_delimiter = ',', action = ArgAction::Append)]
    claude_tools: Vec<String>,
    #[arg(long = "claude-agent")]
    claude_agent: Option<String>,
    #[arg(long = "claude-agents-json")]
    claude_agents_json: Option<String>,
    #[arg(long = "claude-plugin-dir", action = ArgAction::Append)]
    claude_plugin_dir: Vec<String>,
    #[arg(long = "claude-strict-mcp-config", action = ArgAction::SetTrue)]
    claude_strict_mcp_config: bool,
    #[arg(long = "claude-disable-slash-commands", action = ArgAction::SetTrue)]
    claude_disable_slash_commands: bool,
    #[arg(long = "gemini-settings")]
    gemini_settings: Option<String>,
    #[arg(long = "gemini-tools-profile", value_delimiter = ',', action = ArgAction::Append)]
    gemini_tools_profile: Vec<String>,
    #[arg(long = "gemini-allowed-mcp-servers", value_delimiter = ',', action = ArgAction::Append)]
    gemini_allowed_mcp_servers: Vec<String>,
    #[arg(long = "gemini-policy", value_delimiter = ',', action = ArgAction::Append)]
    gemini_policy: Vec<String>,
    #[arg(long = "gemini-admin-policy", value_delimiter = ',', action = ArgAction::Append)]
    gemini_admin_policy: Vec<String>,
    #[arg(long = "capabilities-status", action = ArgAction::SetTrue)]
    capabilities_status: bool,

    #[arg(long = "auth-login", action = ArgAction::SetTrue)]
    auth_login: bool,
    #[arg(long = "auth-status", action = ArgAction::SetTrue)]
    auth_status: bool,
    #[arg(long = "auth-login-providers", value_delimiter = ',')]
    auth_login_providers: Vec<String>,
    #[arg(long = "auth-device-code", action = ArgAction::SetTrue)]
    auth_device_code: bool,
    #[arg(long = "no-auth-open-browser", action = ArgAction::SetTrue)]
    no_auth_open_browser: bool,
    #[arg(long = "auth-timeout", default_value_t = 300)]
    auth_timeout: u64,
    #[arg(long = "claude-login-mode", default_value = "claudeai")]
    claude_login_mode: String,
    #[arg(long = "claude-login-email")]
    claude_login_email: Option<String>,

    #[arg(long = "file", alias = "tag-file", action = ArgAction::Append)]
    files: Vec<PathBuf>,
    #[arg(long = "cmd", alias = "prompt-command", action = ArgAction::Append)]
    commands: Vec<String>,

    #[arg(long, action = ArgAction::SetTrue)]
    handoff: bool,
    #[arg(long)]
    lead: Option<String>,
    #[arg(long)]
    planner: Option<String>,
    #[arg(long, default_value_t = DEFAULT_ITERATIONS)]
    iterations: usize,
    #[arg(long = "team-work", alias = "teamwork", alias = "sub-agents", default_value_t = DEFAULT_TEAM_SIZE)]
    team_work: usize,
    #[arg(long = "codex-sub-agents")]
    codex_sub_agents: Option<usize>,
    #[arg(long = "claude-sub-agents")]
    claude_sub_agents: Option<usize>,
    #[arg(long = "gemini-sub-agents")]
    gemini_sub_agents: Option<usize>,

    #[arg(long = "deliver-linear", alias = "linear", action = ArgAction::SetTrue)]
    deliver_linear: bool,
    #[arg(long = "linear-setup", action = ArgAction::SetTrue)]
    linear_setup: bool,
    #[arg(long = "linear-status", action = ArgAction::SetTrue)]
    linear_status: bool,
    #[arg(long = "linear-watch", action = ArgAction::SetTrue)]
    linear_watch: bool,
    #[arg(long = "linear-until-complete", action = ArgAction::SetTrue)]
    linear_until_complete: bool,
    #[arg(long = "linear-issue", value_delimiter = ',', action = ArgAction::Append)]
    linear_issue: Vec<String>,
    #[arg(long = "linear-query")]
    linear_query: Option<String>,
    #[arg(long = "linear-project", value_delimiter = ',', action = ArgAction::Append)]
    linear_project: Vec<String>,
    #[arg(long = "linear-epic", value_delimiter = ',', action = ArgAction::Append)]
    linear_epic: Vec<String>,
    #[arg(long = "linear-team")]
    linear_team: Option<String>,
    #[arg(long = "linear-state")]
    linear_state: Option<String>,
    #[arg(long = "linear-assignee")]
    linear_assignee: Option<String>,
    #[arg(long = "linear-limit", default_value_t = 3)]
    linear_limit: usize,
    #[arg(long = "linear-auth", default_value = "api-key")]
    linear_auth: String,
    #[arg(long = "linear-api-key-env", default_value = "LINEAR_API_KEY")]
    linear_api_key_env: String,
    #[arg(long = "linear-oauth-token-env", default_value = "LINEAR_OAUTH_TOKEN")]
    linear_oauth_token_env: String,
    #[arg(long = "linear-completion-gate", default_value = "delivered")]
    linear_completion_gate: String,
    #[arg(long = "linear-review-state")]
    linear_review_state: Option<String>,
    #[arg(long = "linear-ci-timeout", default_value_t = 900)]
    linear_ci_timeout: u64,
    #[arg(long = "linear-ci-poll-interval", default_value_t = 30)]
    linear_ci_poll_interval: u64,
    #[arg(long = "linear-poll-interval", default_value_t = 60)]
    linear_poll_interval: u64,
    #[arg(long = "linear-max-attempts", default_value_t = 3)]
    linear_max_attempts: usize,
    #[arg(long = "linear-retry-base", default_value_t = 60)]
    linear_retry_base: u64,
    #[arg(long = "linear-workspace-strategy", default_value = "worktree")]
    linear_workspace_strategy: String,
    #[arg(long = "linear-state-file")]
    linear_state_file: Option<PathBuf>,
    #[arg(long = "linear-workspace-root")]
    linear_workspace_root: Option<PathBuf>,
    #[arg(long = "linear-observability-dir")]
    linear_observability_dir: Option<PathBuf>,
    #[arg(long = "linear-attach-media", value_delimiter = ',', action = ArgAction::Append)]
    linear_attach_media: Vec<String>,
    #[arg(long = "linear-attachment-title")]
    linear_attachment_title: Option<String>,
    #[arg(long = "no-linear-comments", action = ArgAction::SetTrue)]
    no_linear_comments: bool,
    #[arg(long = "linear-update-review-state", action = ArgAction::SetTrue)]
    linear_update_review_state: bool,
    #[arg(long = "delivery-phases", value_delimiter = ',')]
    delivery_phases: Vec<String>,

    #[arg(long, default_value_t = DEFAULT_TIMEOUT_MS / 1000)]
    timeout: u64,
    #[arg(long = "max-member-chars", default_value_t = DEFAULT_MAX_MEMBER_CHARS)]
    max_member_chars: usize,
    #[arg(long, default_value = ".")]
    cwd: PathBuf,
    #[arg(long, default_value = "auto")]
    color: String,
    #[arg(long = "no-color", action = ArgAction::SetTrue)]
    no_color: bool,

    #[arg(value_name = "QUERY")]
    prompt: Vec<String>,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedArgs {
    raw: CliArgs,
    members: Vec<String>,
    prompt: String,
    cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct CouncilResult {
    query: String,
    cwd: String,
    members_requested: Vec<String>,
    summarizer_requested: String,
    workflow: Workflow,
    prompt_commands: Vec<CommandTelemetry>,
    members: Vec<EngineResult>,
    summary: EngineResult,
}

#[derive(Debug, Clone, Serialize)]
struct Workflow {
    handoff: bool,
    lead: Option<String>,
    planner: Option<String>,
    iterations: usize,
    team_work: usize,
    teams: HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineResult {
    name: String,
    bin: Option<String>,
    status: String,
    duration_ms: u128,
    detail: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    output: String,
    command: String,
    token_usage: TokenUsage,
    tool_calls: Vec<ToolUsage>,
    sub_agents: Vec<EngineResult>,
    role: String,
    iteration: usize,
    total_iterations: usize,
    team_size: usize,
}

#[derive(Debug, Clone, Serialize)]
struct TokenUsage {
    input: usize,
    output: usize,
    total: usize,
    estimated: bool,
    source: String,
}

#[derive(Debug, Clone, Serialize)]
struct ToolUsage {
    name: String,
    kind: String,
    status: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
struct CommandTelemetry {
    command: String,
    status: String,
    detail: String,
    exit_code: Option<i32>,
    duration_ms: u128,
    stdout_chars: usize,
    stderr_chars: usize,
    timed_out: bool,
}

#[derive(Debug)]
struct PromptContext {
    prompt: String,
    commands: Vec<CommandTelemetry>,
}

#[derive(Debug)]
struct CommandResult {
    command: String,
    args: Vec<String>,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    error: Option<String>,
    timeout_ms: u64,
    duration_ms: u128,
}

#[derive(Debug, Clone)]
struct EngineRunOptions {
    prompt: String,
    cwd: PathBuf,
    timeout_ms: u64,
    effort: Option<String>,
    model: Option<String>,
    permission: Option<String>,
    auth: String,
    capability: ProviderCapability,
    role: String,
    iteration: usize,
    total_iterations: usize,
    team_size: usize,
    is_sub_agent: bool,
}

#[derive(Debug, Clone)]
struct ProviderCapability {
    mode: String,
    config: Vec<String>,
    mcp_profile: Option<String>,
    mcp_config: Vec<String>,
    allowed_tools: Vec<String>,
    disallowed_tools: Vec<String>,
    tools: Vec<String>,
    agent: Option<String>,
    agents_json: Option<String>,
    plugin_dirs: Vec<String>,
    strict_mcp_config: bool,
    disable_slash_commands: bool,
    settings: Option<String>,
    tools_profile: Vec<String>,
    allowed_mcp_servers: Vec<String>,
    policy: Vec<String>,
    admin_policy: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ProviderAuthStatus {
    provider: String,
    configured: bool,
    status: String,
    source: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProviderCapabilityStatus {
    provider: String,
    mcp: CommandTelemetry,
    skills: Option<CommandTelemetry>,
    tools: Option<CommandTelemetry>,
    detail: String,
}

struct TempSettings {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

pub fn run_from_env() -> i32 {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    run_with_args(args)
}

pub fn run_with_args<I, T>(args: I) -> i32
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let raw_args: Vec<OsString> = args.into_iter().map(Into::into).collect();
    if raw_args.first().and_then(|value| value.to_str()) == Some("help") {
        let mut command = CliArgs::command();
        let _ = command.print_long_help();
        println!();
        return 0;
    }

    let mut parse_args = vec![OsString::from("council")];
    parse_args.extend(raw_args);
    let parsed = match CliArgs::try_parse_from(parse_args) {
        Ok(parsed) => parsed,
        Err(error) => {
            let _ = error.print();
            return 64;
        }
    };

    if parsed.version {
        println!("{VERSION}");
        return 0;
    }

    let resolved = match resolve_args(parsed) {
        Ok(resolved) => resolved,
        Err(error) => {
            eprintln!("{error}");
            return 64;
        }
    };

    if resolved.raw.studio {
        return studio::run_studio(&resolved);
    }

    if resolved.raw.auth_status {
        println!(
            "{}",
            render_auth_statuses(&collect_auth_statuses(&resolved))
        );
        if resolved.prompt.trim().is_empty()
            && !resolved.raw.auth_login
            && !resolved.raw.deliver_linear
            && !resolved.raw.capabilities_status
        {
            return 0;
        }
    }

    if resolved.raw.capabilities_status {
        println!(
            "{}",
            render_provider_capability_statuses(&collect_provider_capability_statuses(&resolved))
        );
        if resolved.prompt.trim().is_empty()
            && !resolved.raw.auth_login
            && !resolved.raw.deliver_linear
        {
            return 0;
        }
    }

    if resolved.raw.auth_login {
        if let Err(error) = run_social_login(&resolved) {
            eprintln!("{error}");
            return 1;
        }
        if resolved.prompt.trim().is_empty() && !resolved.raw.deliver_linear {
            return 0;
        }
    }

    if resolved.raw.linear_setup || resolved.raw.linear_status {
        match linear_delivery::get_linear_status(&resolved) {
            Ok(status) => {
                println!("{}", linear_delivery::render_linear_status(&status));
                return 0;
            }
            Err(error) => {
                eprintln!("{error}");
                return 1;
            }
        }
    }

    if resolved.raw.deliver_linear
        || resolved.raw.linear_until_complete
        || resolved.raw.linear_watch
    {
        match linear_delivery::run_linear_delivery(&resolved) {
            Ok(result) => {
                println!(
                    "{}",
                    linear_delivery::render_linear_delivery_result(&result)
                );
                return if result.success { 0 } else { 1 };
            }
            Err(error) => {
                eprintln!("{error}");
                return 1;
            }
        }
    }

    if resolved.prompt.trim().is_empty() {
        eprintln!(
            "No query provided.\n\n{}",
            CliArgs::command().render_long_help()
        );
        return 64;
    }

    let prompt_context = match build_prompt_context(&resolved) {
        Ok(context) => context,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };

    if should_show_banner(&resolved.raw) {
        eprintln!("{}", render_banner());
    }

    let result = run_council(&resolved, prompt_context.prompt, prompt_context.commands);
    if resolved.raw.json || resolved.raw.json_stream {
        let serialized = if resolved.raw.json_stream {
            serde_json::to_string(&result)
        } else {
            serde_json::to_string_pretty(&result)
        };
        println!("{}", serialized.unwrap_or_else(|_| "{}".to_string()));
    } else {
        println!("{}", render_human_result(&result, resolved.raw.verbose));
    }

    if is_success(&result) {
        0
    } else {
        1
    }
}

fn resolve_args(raw: CliArgs) -> Result<ResolvedArgs, String> {
    let members = resolve_members(&raw)?;
    validate_engine_name(&raw.summarizer, true, "--summarizer")?;
    if let Some(lead) = &raw.lead {
        validate_engine_name(lead, false, "--lead")?;
        if !members.contains(lead) {
            return Err(format!(
                "--lead must be one of the enabled members: {}",
                members.join(", ")
            ));
        }
    }
    if let Some(planner) = &raw.planner {
        validate_engine_name(planner, false, "--planner")?;
        if !members.contains(planner) {
            return Err(format!(
                "--planner must be one of the enabled members: {}",
                members.join(", ")
            ));
        }
    }
    validate_provider_effort("codex", raw.codex_effort.as_deref())?;
    validate_provider_effort("claude", raw.claude_effort.as_deref())?;
    validate_provider_effort("gemini", raw.gemini_effort.as_deref())?;
    validate_choice(
        "--claude-login-mode",
        &raw.claude_login_mode,
        &["claudeai", "console", "sso"],
    )?;
    validate_choice(
        "--codex-capabilities",
        &raw.codex_capabilities,
        &[CAPABILITY_INHERIT, CAPABILITY_OVERRIDE],
    )?;
    validate_choice(
        "--claude-capabilities",
        &raw.claude_capabilities,
        &[CAPABILITY_INHERIT, CAPABILITY_OVERRIDE],
    )?;
    validate_choice(
        "--gemini-capabilities",
        &raw.gemini_capabilities,
        &[CAPABILITY_INHERIT, CAPABILITY_OVERRIDE],
    )?;

    let mut prompt = raw.prompt.join(" ");
    if prompt.trim().is_empty() && !io::stdin().is_terminal() {
        let mut stdin = String::new();
        io::stdin()
            .read_to_string(&mut stdin)
            .map_err(|error| format!("Failed to read stdin: {error}"))?;
        prompt = stdin;
    }
    let cwd = raw.cwd.canonicalize().unwrap_or_else(|_| raw.cwd.clone());

    Ok(ResolvedArgs {
        raw,
        members,
        prompt,
        cwd,
    })
}

fn resolve_members(raw: &CliArgs) -> Result<Vec<String>, String> {
    let mut members = if raw.members.is_empty() {
        ENGINES
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>()
    } else {
        raw.members
            .iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>()
    };

    if raw.all {
        members = ENGINES.iter().map(|name| (*name).to_string()).collect();
    }
    if raw.no_codex {
        members.retain(|name| name != "codex");
    }
    if raw.no_claude {
        members.retain(|name| name != "claude");
    }
    if raw.no_gemini {
        members.retain(|name| name != "gemini");
    }
    for enabled in [
        (raw.codex, "codex"),
        (raw.claude, "claude"),
        (raw.gemini, "gemini"),
    ] {
        if enabled.0 && !members.iter().any(|name| name == enabled.1) {
            members.push(enabled.1.to_string());
        }
    }

    members.dedup();
    for member in &members {
        validate_engine_name(member, false, "--members")?;
    }
    if members.is_empty() {
        return Err("At least one member must be enabled.".to_string());
    }
    Ok(members)
}

fn validate_engine_name(name: &str, allow_auto: bool, flag: &str) -> Result<(), String> {
    if allow_auto && name == "auto" {
        return Ok(());
    }
    if Engine::parse(name).is_some() {
        Ok(())
    } else {
        Err(format!(
            "{flag} must be one of: {}",
            if allow_auto {
                "auto, codex, claude, gemini"
            } else {
                "codex, claude, gemini"
            }
        ))
    }
}

fn validate_provider_effort(provider: &str, value: Option<&str>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let engine = Engine::parse(provider).expect("provider effort validation uses known engines");
    if engine.allowed_efforts().contains(&value) {
        Ok(())
    } else {
        Err(format!("Unsupported --{provider}-effort value: {value}"))
    }
}

fn validate_choice(flag: &str, value: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("{flag} must be one of: {}", allowed.join(", ")))
    }
}

fn collect_auth_statuses(resolved: &ResolvedArgs) -> Vec<ProviderAuthStatus> {
    resolved
        .members
        .iter()
        .map(|provider| provider_auth_status(provider, resolved))
        .collect()
}

fn provider_auth_status(provider: &str, resolved: &ResolvedArgs) -> ProviderAuthStatus {
    let auth = provider_auth(resolved, provider);
    match provider {
        "codex" => {
            let bin = resolve_binary("codex");
            let args = vec!["login".to_string(), "status".to_string()];
            status_from_command(provider, &auth, &bin, &args, &resolved.cwd)
        }
        "claude" => {
            let bin = resolve_binary("claude");
            let args = vec![
                "auth".to_string(),
                "status".to_string(),
                "--text".to_string(),
            ];
            status_from_command(provider, &auth, &bin, &args, &resolved.cwd)
        }
        "gemini" => {
            let has_api_key = std::env::var("GEMINI_API_KEY")
                .ok()
                .is_some_and(|value| !value.trim().is_empty());
            let home = std::env::var("HOME").unwrap_or_default();
            let has_oauth_file = !home.is_empty()
                && [
                    ".gemini/oauth_creds.json",
                    ".gemini/oauth_tokens.json",
                    ".gemini/settings.json",
                ]
                .iter()
                .any(|path| Path::new(&home).join(path).exists());
            let configured = has_api_key || has_oauth_file;
            ProviderAuthStatus {
                provider: provider.to_string(),
                configured,
                status: if configured { "configured" } else { "unknown" }.to_string(),
                source: auth,
                detail: if has_api_key {
                    "GEMINI_API_KEY is present.".to_string()
                } else if has_oauth_file {
                    "Gemini local auth/config files are present.".to_string()
                } else {
                    "Gemini CLI does not currently expose a stable headless auth status command; use Social login from Studio or run gemini interactively.".to_string()
                },
            }
        }
        _ => ProviderAuthStatus {
            provider: provider.to_string(),
            configured: false,
            status: "unknown".to_string(),
            source: auth,
            detail: "Unknown provider.".to_string(),
        },
    }
}

fn status_from_command(
    provider: &str,
    auth: &str,
    bin: &str,
    args: &[String],
    cwd: &Path,
) -> ProviderAuthStatus {
    let result = run_command(bin, args, cwd, None, 15_000, HashMap::new());
    let configured = result.code == Some(0);
    ProviderAuthStatus {
        provider: provider.to_string(),
        configured,
        status: if configured {
            "configured"
        } else if result.error.is_some() {
            "missing-cli"
        } else {
            "not-configured"
        }
        .to_string(),
        source: auth.to_string(),
        detail: sanitize_status_detail(&compact_failure(&result)),
    }
}

fn sanitize_status_detail(detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        return "No status detail returned.".to_string();
    }
    let detail = detail
        .lines()
        .take(6)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(redact_possible_secret)
        .collect::<Vec<_>>()
        .join(" ");
    redact_local_paths(&detail)
}

fn redact_possible_secret(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            if looks_sensitive_token(token) {
                "[redacted]"
            } else if looks_like_email(token) {
                "[email]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_sensitive_token(token: &str) -> bool {
    let trimmed =
        token.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_');
    trimmed.len() >= 28
        && (trimmed.starts_with("sk-")
            || trimmed.starts_with("sk_")
            || trimmed.starts_with("gho_")
            || trimmed.starts_with("ghp_")
            || trimmed.starts_with("ghs_")
            || trimmed.starts_with("ghu_")
            || trimmed.starts_with("AIza")
            || trimmed.starts_with("AQ."))
}

fn looks_like_email(token: &str) -> bool {
    let trimmed = token.trim_matches(|ch: char| {
        !ch.is_ascii_alphanumeric() && !matches!(ch, '@' | '.' | '_' | '-' | '+')
    });
    trimmed.contains('@') && trimmed.rsplit_once('.').is_some()
}

fn redact_local_paths(value: &str) -> String {
    let mut redacted = value.to_string();
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            redacted = redacted.replace(&home, "~");
        }
    }
    redacted
}

fn render_auth_statuses(statuses: &[ProviderAuthStatus]) -> String {
    let mut lines = vec!["Provider auth status".to_string()];
    for status in statuses {
        lines.push(format!(
            "- {}: {} via {} ({})",
            status.provider, status.status, status.source, status.detail
        ));
    }
    lines.join("\n")
}

fn collect_provider_capability_statuses(resolved: &ResolvedArgs) -> Vec<ProviderCapabilityStatus> {
    resolved
        .members
        .iter()
        .map(|provider| provider_capability_status(provider, resolved))
        .collect()
}

fn provider_capability_status(provider: &str, resolved: &ResolvedArgs) -> ProviderCapabilityStatus {
    match provider {
        "codex" => {
            let bin = resolve_binary("codex");
            let mcp = run_capability_probe(&bin, &["mcp", "list"], &resolved.cwd);
            ProviderCapabilityStatus {
                provider: provider.to_string(),
                mcp,
                skills: None,
                tools: Some(run_capability_probe(
                    &bin,
                    &["plugin", "marketplace", "--help"],
                    &resolved.cwd,
                )),
                detail:
                    "Codex inherits ~/.codex config unless --codex-capabilities override is set."
                        .to_string(),
            }
        }
        "claude" => {
            let bin = resolve_binary("claude");
            ProviderCapabilityStatus {
                provider: provider.to_string(),
                mcp: run_capability_probe(&bin, &["mcp", "list"], &resolved.cwd),
                skills: Some(run_capability_probe(&bin, &["plugin", "list"], &resolved.cwd)),
                tools: Some(run_capability_probe(&bin, &["agents"], &resolved.cwd)),
                detail: "Claude override can manage MCP config, tools, agents, plugin dirs, and slash-command skills.".to_string(),
            }
        }
        "gemini" => {
            let bin = resolve_binary("gemini");
            ProviderCapabilityStatus {
                provider: provider.to_string(),
                mcp: run_capability_probe(&bin, &["mcp", "list"], &resolved.cwd),
                skills: Some(run_capability_probe(&bin, &["skills", "list"], &resolved.cwd)),
                tools: Some(run_capability_probe(&bin, &["extensions", "list"], &resolved.cwd)),
                detail: "Gemini override can manage settings, extensions, MCP server allowlists, and policy files.".to_string(),
            }
        }
        _ => ProviderCapabilityStatus {
            provider: provider.to_string(),
            mcp: CommandTelemetry {
                command: provider.to_string(),
                status: "unknown".to_string(),
                detail: "Unknown provider.".to_string(),
                exit_code: None,
                duration_ms: 0,
                stdout_chars: 0,
                stderr_chars: 0,
                timed_out: false,
            },
            skills: None,
            tools: None,
            detail: "Unknown provider.".to_string(),
        },
    }
}

fn run_capability_probe(bin: &str, args: &[&str], cwd: &Path) -> CommandTelemetry {
    let args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    command_telemetry(&run_command(bin, &args, cwd, None, 20_000, HashMap::new()))
}

fn render_provider_capability_statuses(statuses: &[ProviderCapabilityStatus]) -> String {
    let mut lines = vec!["Provider capabilities".to_string()];
    for status in statuses {
        lines.push(format!(
            "- {} MCP: {} ({})",
            status.provider, status.mcp.status, status.mcp.command
        ));
        if !status.mcp.detail.trim().is_empty() {
            lines.push(format!("  {}", status.mcp.detail));
        }
        if let Some(skills) = &status.skills {
            lines.push(format!(
                "  skills/plugins: {} ({})",
                skills.status, skills.command
            ));
            if !skills.detail.trim().is_empty() {
                lines.push(format!("  {}", skills.detail));
            }
        }
        if let Some(tools) = &status.tools {
            lines.push(format!(
                "  tools/extensions: {} ({})",
                tools.status, tools.command
            ));
            if !tools.detail.trim().is_empty() {
                lines.push(format!("  {}", tools.detail));
            }
        }
        lines.push(format!("  {}", status.detail));
    }
    lines.join("\n")
}

fn run_social_login(resolved: &ResolvedArgs) -> Result<(), String> {
    let providers = if resolved.raw.auth_login_providers.is_empty() {
        resolved.members.clone()
    } else {
        resolved.raw.auth_login_providers.clone()
    };

    for provider in providers {
        validate_engine_name(&provider, false, "--auth-login-providers")?;
        let (bin, args, instruction): (String, Vec<String>, &str) =
            match provider.as_str() {
                "codex" => {
                    let mut args = vec!["login".to_string()];
                    if resolved.raw.auth_device_code {
                        args.push("--device-auth".to_string());
                    }
                    (
                        resolve_binary("codex"),
                        args,
                        "Complete the Codex browser login. Deeplinks and pasted codes are supported by the provider CLI when prompted.",
                    )
                }
                "claude" => {
                    let mut args = vec!["auth".to_string(), "login".to_string()];
                    match resolved.raw.claude_login_mode.as_str() {
                        "console" => args.push("--console".to_string()),
                        "sso" => args.push("--sso".to_string()),
                        _ => args.push("--claudeai".to_string()),
                    }
                    if let Some(email) = &resolved.raw.claude_login_email {
                        push_arg(&mut args, "--email", email.clone());
                    }
                    (
                        resolve_binary("claude"),
                        args,
                        "Complete the Claude browser login. Paste any shown login code into this terminal when prompted; deeplinks are opened when the CLI emits them.",
                    )
                }
                "gemini" => (
                    resolve_binary("gemini"),
                    vec![],
                    "Use the Gemini CLI auth selector, choose browser/social login, and complete local callback or code paste when prompted.",
                ),
                _ => unreachable!(),
            };
        eprintln!(
            "[auth] launching {provider}: {}",
            format_command(&bin, &args)
        );
        eprintln!("[auth] {provider}: {instruction}");
        let result = run_interactive_auth_command(
            &bin,
            &args,
            &resolved.cwd,
            resolved.raw.auth_timeout * 1000,
            !resolved.raw.no_auth_open_browser,
            &provider,
        );
        if result.code.unwrap_or(1) != 0 {
            return Err(format!(
                "{provider} social login failed: {}",
                compact_failure(&result)
            ));
        }
        let status = provider_auth_status(&provider, resolved);
        eprintln!("[auth] {provider}: {} ({})", status.status, status.detail);
    }
    Ok(())
}

fn run_interactive_auth_command(
    command: &str,
    args: &[String],
    cwd: &Path,
    timeout_ms: u64,
    open_browser: bool,
    provider: &str,
) -> CommandResult {
    let started = Instant::now();
    let mut child = match Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CommandResult {
                command: command.to_string(),
                args: args.to_vec(),
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                error: Some(error.to_string()),
                timeout_ms,
                duration_ms: started.elapsed().as_millis(),
            }
        }
    };

    let seen_urls = Arc::new(Mutex::new(HashSet::new()));
    let stdout = child.stdout.take().map(|pipe| {
        read_auth_pipe(
            pipe,
            true,
            provider.to_string(),
            open_browser,
            Arc::clone(&seen_urls),
        )
    });
    let stderr = child.stderr.take().map(|pipe| {
        read_auth_pipe(
            pipe,
            false,
            provider.to_string(),
            open_browser,
            Arc::clone(&seen_urls),
        )
    });
    let timeout = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let code;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code();
                break;
            }
            Ok(None) => {
                if timeout_ms > 0 && started.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    let status = child.wait().ok();
                    code = status.and_then(|status| status.code());
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return CommandResult {
                    command: command.to_string(),
                    args: args.to_vec(),
                    code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out,
                    error: Some(error.to_string()),
                    timeout_ms,
                    duration_ms: started.elapsed().as_millis(),
                }
            }
        }
    }

    CommandResult {
        command: command.to_string(),
        args: args.to_vec(),
        code,
        stdout: stdout
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
        stderr: stderr
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
        timed_out,
        error: None,
        timeout_ms,
        duration_ms: started.elapsed().as_millis(),
    }
}

fn read_auth_pipe<R>(
    mut pipe: R,
    stdout: bool,
    provider: String,
    open_browser: bool,
    seen_urls: Arc<Mutex<HashSet<String>>>,
) -> thread::JoinHandle<String>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut text = String::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(_) => break,
            };
            let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
            text.push_str(&chunk);
            if stdout {
                print!("{chunk}");
                let _ = io::stdout().flush();
            } else {
                eprint!("{chunk}");
                let _ = io::stderr().flush();
            }
            if open_browser {
                for url in extract_auth_urls(&chunk) {
                    let mut seen = seen_urls.lock().ok();
                    if seen.as_mut().is_some_and(|seen| !seen.insert(url.clone())) {
                        continue;
                    }
                    eprintln!("[auth] {provider}: opening {url}");
                    if let Err(error) = open_browser_url(&url) {
                        eprintln!("[auth] {provider}: failed to open {url}: {error}");
                    }
                }
            }
        }
        text
    })
}

fn extract_auth_urls(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|token| {
            token.trim_matches(|ch: char| {
                matches!(ch, '<' | '>' | '"' | '\'' | ')' | '(' | ',' | ';')
            })
        })
        .map(|token| token.trim_end_matches(['.', ':', ',', ';']))
        .filter(|token| {
            token.starts_with("http://")
                || token.starts_with("https://")
                || token.starts_with("codex://")
                || token.starts_with("openai://")
                || token.starts_with("claude://")
                || token.starts_with("anthropic://")
                || token.starts_with("gemini://")
                || token.starts_with("google://")
        })
        .map(ToString::to_string)
        .collect()
}

fn open_browser_url(url: &str) -> Result<(), String> {
    let (command, args): (&str, Vec<String>) = if cfg!(target_os = "macos") {
        ("open", vec![url.to_string()])
    } else if cfg!(target_os = "windows") {
        (
            "cmd",
            vec![
                "/c".to_string(),
                "start".to_string(),
                "".to_string(),
                url.to_string(),
            ],
        )
    } else {
        ("xdg-open", vec![url.to_string()])
    };
    Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| {
            let _ = child.try_wait();
        })
        .map_err(|error| error.to_string())
}

fn build_prompt_context(resolved: &ResolvedArgs) -> Result<PromptContext, String> {
    let mut prompt = resolved.prompt.trim().to_string();
    let mut sections = Vec::new();
    let mut commands = Vec::new();

    for file in &resolved.raw.files {
        let path = if file.is_absolute() {
            file.clone()
        } else {
            resolved.cwd.join(file)
        };
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read tagged file {}: {error}", path.display()))?;
        sections.push(format!("--- file: {} ---\n{}", file.display(), content));
    }

    for command in &resolved.raw.commands {
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        let args = if cfg!(windows) {
            vec!["/C".to_string(), command.clone()]
        } else {
            vec!["-lc".to_string(), command.clone()]
        };
        let result = run_command(
            shell,
            &args,
            &resolved.cwd,
            None,
            resolved.raw.timeout * 1000,
            HashMap::new(),
        );
        commands.push(command_telemetry(&result));
        sections.push(format!(
            "--- command: {} (exit {}) ---\nstdout:\n{}\nstderr:\n{}",
            command,
            result
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            result.stdout.trim(),
            result.stderr.trim()
        ));
    }

    if !sections.is_empty() {
        prompt.push_str("\n\nPrompt context:\n");
        prompt.push_str(&sections.join("\n\n"));
    }
    Ok(PromptContext { prompt, commands })
}

fn run_council(
    resolved: &ResolvedArgs,
    query: String,
    prompt_commands: Vec<CommandTelemetry>,
) -> CouncilResult {
    let workflow = build_workflow(resolved);
    let mut previous_iteration = Vec::new();
    let mut final_members = Vec::new();

    for iteration in 1..=workflow.iterations {
        final_members = run_iteration(resolved, &query, &workflow, iteration, &previous_iteration);
        previous_iteration = final_members.clone();
    }

    let successes = final_members
        .iter()
        .filter(|result| result.status == "ok")
        .cloned()
        .collect::<Vec<_>>();
    let summary = if successes.is_empty() {
        EngineResult {
            name: resolved.raw.summarizer.clone(),
            bin: None,
            status: "error".to_string(),
            duration_ms: 0,
            detail: "No council member produced a response.".to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            output: String::new(),
            command: String::new(),
            token_usage: token_usage("", ""),
            tool_calls: vec![],
            sub_agents: vec![],
            role: "summary".to_string(),
            iteration: workflow.iterations,
            total_iterations: workflow.iterations,
            team_size: 0,
        }
    } else {
        let summary_prompt =
            build_summary_prompt(&query, &successes, &workflow, resolved.raw.max_member_chars);
        let summarizer = pick_summarizer(resolved, &successes);
        let mut options = engine_options(
            resolved,
            &summarizer,
            summary_prompt,
            "summary",
            workflow.iterations,
            &workflow,
        );
        options.role = "summary".to_string();
        options.team_size = 0;
        run_engine(&summarizer, options)
    };

    CouncilResult {
        query,
        cwd: resolved.cwd.display().to_string(),
        members_requested: resolved.members.clone(),
        summarizer_requested: resolved.raw.summarizer.clone(),
        workflow,
        prompt_commands,
        members: final_members,
        summary,
    }
}

fn build_workflow(resolved: &ResolvedArgs) -> Workflow {
    let mut teams = HashMap::new();
    for member in ENGINES {
        teams.insert(member.to_string(), resolved.raw.team_work);
    }
    if let Some(value) = resolved.raw.codex_sub_agents {
        teams.insert("codex".to_string(), value);
    }
    if let Some(value) = resolved.raw.claude_sub_agents {
        teams.insert("claude".to_string(), value);
    }
    if let Some(value) = resolved.raw.gemini_sub_agents {
        teams.insert("gemini".to_string(), value);
    }
    Workflow {
        handoff: resolved.raw.handoff,
        lead: resolved.raw.lead.clone(),
        planner: resolved.raw.planner.clone(),
        iterations: resolved.raw.iterations.max(1),
        team_work: resolved.raw.team_work,
        teams,
    }
}

fn run_iteration(
    resolved: &ResolvedArgs,
    query: &str,
    workflow: &Workflow,
    iteration: usize,
    previous_iteration: &[EngineResult],
) -> Vec<EngineResult> {
    let ordered = execution_order(&resolved.members, workflow.planner.as_deref());
    if workflow.handoff {
        let mut results = Vec::new();
        for member in ordered {
            let role = role_for(&member, workflow);
            let prompt = build_member_prompt(
                query,
                &role,
                workflow,
                iteration,
                previous_iteration,
                &results,
                "",
            );
            let options = engine_options(resolved, &member, prompt, &role, iteration, workflow);
            results.push(run_engine(&member, options));
        }
        return results;
    }

    let planner = workflow
        .planner
        .as_ref()
        .filter(|planner| ordered.contains(planner))
        .cloned();
    let mut results = Vec::new();
    let mut plan_output = String::new();
    if let Some(planner_name) = planner.as_ref() {
        let role = role_for(planner_name, workflow);
        let prompt = build_member_prompt(
            query,
            &role,
            workflow,
            iteration,
            previous_iteration,
            &[],
            "",
        );
        let options = engine_options(resolved, planner_name, prompt, &role, iteration, workflow);
        let result = run_engine(planner_name, options);
        if result.status == "ok" {
            plan_output = result.output.clone();
        }
        results.push(result);
    }

    let (tx, rx) = mpsc::channel();
    let executors = ordered
        .into_iter()
        .filter(|member| Some(member) != planner.as_ref())
        .collect::<Vec<_>>();
    let resolved = Arc::new(resolved.clone());
    let workflow = Arc::new(workflow.clone());
    let previous_iteration = Arc::new(previous_iteration.to_vec());
    let plan_output = Arc::new(plan_output);
    for member in executors.clone() {
        let tx = tx.clone();
        let resolved = Arc::clone(&resolved);
        let workflow = Arc::clone(&workflow);
        let query = query.to_string();
        let previous_iteration = Arc::clone(&previous_iteration);
        let plan_output = Arc::clone(&plan_output);
        thread::spawn(move || {
            let role = role_for(&member, &workflow);
            let prompt = build_member_prompt(
                &query,
                &role,
                &workflow,
                iteration,
                previous_iteration.as_slice(),
                &[],
                &plan_output,
            );
            let options = engine_options(&resolved, &member, prompt, &role, iteration, &workflow);
            let _ = tx.send(run_engine(&member, options));
        });
    }
    drop(tx);
    let mut executor_results = rx.into_iter().collect::<Vec<_>>();
    executor_results.sort_by_key(|result| {
        executors
            .iter()
            .position(|member| member == &result.name)
            .unwrap_or(usize::MAX)
    });
    results.extend(executor_results);
    results
}

fn engine_options(
    resolved: &ResolvedArgs,
    member: &str,
    prompt: String,
    role: &str,
    iteration: usize,
    workflow: &Workflow,
) -> EngineRunOptions {
    EngineRunOptions {
        prompt,
        cwd: resolved.cwd.clone(),
        timeout_ms: resolved.raw.timeout * 1000,
        effort: provider_effort(resolved, member),
        model: provider_model(resolved, member),
        permission: provider_permission(resolved, member),
        auth: provider_auth(resolved, member),
        capability: provider_capability(resolved, member),
        role: role.to_string(),
        iteration,
        total_iterations: workflow.iterations,
        team_size: *workflow.teams.get(member).unwrap_or(&DEFAULT_TEAM_SIZE),
        is_sub_agent: false,
    }
}

fn provider_effort(resolved: &ResolvedArgs, member: &str) -> Option<String> {
    provider_option(
        member,
        &resolved.raw.codex_effort,
        &resolved.raw.claude_effort,
        &resolved.raw.gemini_effort,
    )
    .or_else(|| {
        resolved
            .raw
            .effort
            .map(|effort| effort.as_str().to_string())
    })
}

fn provider_model(resolved: &ResolvedArgs, member: &str) -> Option<String> {
    provider_option(
        member,
        &resolved.raw.codex_model,
        &resolved.raw.claude_model,
        &resolved.raw.gemini_model,
    )
}

fn provider_permission(resolved: &ResolvedArgs, member: &str) -> Option<String> {
    match Engine::parse(member) {
        Some(Engine::Codex) => Some(resolved.raw.codex_sandbox.clone()),
        Some(Engine::Claude) => Some(resolved.raw.claude_permission_mode.clone()),
        Some(Engine::Gemini) | None => None,
    }
}

fn provider_auth(resolved: &ResolvedArgs, member: &str) -> String {
    match Engine::parse(member) {
        Some(Engine::Codex) => resolved.raw.codex_auth.clone(),
        Some(Engine::Claude) => resolved.raw.claude_auth.clone(),
        Some(Engine::Gemini) => resolved.raw.gemini_auth.clone(),
        None => DEFAULT_AUTH_MODE.to_string(),
    }
}

fn provider_capability(resolved: &ResolvedArgs, member: &str) -> ProviderCapability {
    match Engine::parse(member).expect("provider capabilities use validated engines") {
        Engine::Codex => ProviderCapability {
            mode: inferred_capability_mode(
                &resolved.raw.codex_capabilities,
                !resolved.raw.codex_config.is_empty() || resolved.raw.codex_mcp_profile.is_some(),
            ),
            config: resolved.raw.codex_config.clone(),
            mcp_profile: resolved.raw.codex_mcp_profile.clone(),
            mcp_config: vec![],
            allowed_tools: vec![],
            disallowed_tools: vec![],
            tools: vec![],
            agent: None,
            agents_json: None,
            plugin_dirs: vec![],
            strict_mcp_config: false,
            disable_slash_commands: false,
            settings: None,
            tools_profile: vec![],
            allowed_mcp_servers: vec![],
            policy: vec![],
            admin_policy: vec![],
        },
        Engine::Claude => ProviderCapability {
            mode: inferred_capability_mode(
                &resolved.raw.claude_capabilities,
                !resolved.raw.claude_mcp_config.is_empty()
                    || !resolved.raw.claude_allowed_tools.is_empty()
                    || !resolved.raw.claude_disallowed_tools.is_empty()
                    || !resolved.raw.claude_tools.is_empty()
                    || resolved.raw.claude_agent.is_some()
                    || resolved.raw.claude_agents_json.is_some()
                    || !resolved.raw.claude_plugin_dir.is_empty()
                    || resolved.raw.claude_strict_mcp_config
                    || resolved.raw.claude_disable_slash_commands,
            ),
            config: vec![],
            mcp_profile: None,
            mcp_config: resolved.raw.claude_mcp_config.clone(),
            allowed_tools: resolved.raw.claude_allowed_tools.clone(),
            disallowed_tools: resolved.raw.claude_disallowed_tools.clone(),
            tools: resolved.raw.claude_tools.clone(),
            agent: resolved.raw.claude_agent.clone(),
            agents_json: resolved.raw.claude_agents_json.clone(),
            plugin_dirs: resolved.raw.claude_plugin_dir.clone(),
            strict_mcp_config: resolved.raw.claude_strict_mcp_config,
            disable_slash_commands: resolved.raw.claude_disable_slash_commands,
            settings: None,
            tools_profile: vec![],
            allowed_mcp_servers: vec![],
            policy: vec![],
            admin_policy: vec![],
        },
        Engine::Gemini => ProviderCapability {
            mode: inferred_capability_mode(
                &resolved.raw.gemini_capabilities,
                resolved.raw.gemini_settings.is_some()
                    || !resolved.raw.gemini_tools_profile.is_empty()
                    || !resolved.raw.gemini_allowed_mcp_servers.is_empty()
                    || !resolved.raw.gemini_policy.is_empty()
                    || !resolved.raw.gemini_admin_policy.is_empty(),
            ),
            config: vec![],
            mcp_profile: None,
            mcp_config: vec![],
            allowed_tools: vec![],
            disallowed_tools: vec![],
            tools: vec![],
            agent: None,
            agents_json: None,
            plugin_dirs: vec![],
            strict_mcp_config: false,
            disable_slash_commands: false,
            settings: resolved.raw.gemini_settings.clone(),
            tools_profile: resolved.raw.gemini_tools_profile.clone(),
            allowed_mcp_servers: resolved.raw.gemini_allowed_mcp_servers.clone(),
            policy: resolved.raw.gemini_policy.clone(),
            admin_policy: resolved.raw.gemini_admin_policy.clone(),
        },
    }
}

fn inferred_capability_mode(configured: &str, has_override_flags: bool) -> String {
    if configured == CAPABILITY_INHERIT && has_override_flags {
        CAPABILITY_OVERRIDE.to_string()
    } else {
        configured.to_string()
    }
}

fn provider_option(
    member: &str,
    codex: &Option<String>,
    claude: &Option<String>,
    gemini: &Option<String>,
) -> Option<String> {
    match Engine::parse(member) {
        Some(Engine::Codex) => codex.clone(),
        Some(Engine::Claude) => claude.clone(),
        Some(Engine::Gemini) => gemini.clone(),
        None => None,
    }
}

fn build_sub_agent_prompt(original: &str, role: &str, index: usize, total: usize) -> String {
    format!(
        "You are sub-agent {index} of {total} for a Council provider assigned role `{role}`.\n\
         Work independently on a useful slice of the task. Inspect, reason, or verify as needed, \
         then return concise findings, risks, and concrete recommendations for the provider lead.\n\n\
         Original provider prompt:\n{original}"
    )
}

fn build_team_lead_prompt(original: &str, sub_agents: &[EngineResult]) -> String {
    let handoff = sub_agents
        .iter()
        .map(|agent| {
            format!(
                "### {} [{}]\n{}",
                agent.role,
                agent.status,
                if agent.output.trim().is_empty() {
                    agent.detail.trim()
                } else {
                    agent.output.trim()
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "You are the provider lead. Use the sub-agent handoffs below, resolve disagreements, \
         and produce the final provider response for the original Council role.\n\n\
         Sub-agent handoffs:\n{handoff}\n\nOriginal provider prompt:\n{original}"
    )
}

fn run_engine(name: &str, options: EngineRunOptions) -> EngineResult {
    if options.team_size > 0 && options.role != "summary" && !options.is_sub_agent {
        return run_engine_team(name, options);
    }
    run_engine_single(name, options, vec![])
}

fn run_engine_team(name: &str, options: EngineRunOptions) -> EngineResult {
    let team_size = options.team_size;
    let (tx, rx) = mpsc::channel();
    for index in 1..=team_size {
        let tx = tx.clone();
        let name = name.to_string();
        let mut sub_options = options.clone();
        sub_options.team_size = 0;
        sub_options.is_sub_agent = true;
        sub_options.role = format!("{}:sub-agent-{index}", options.role);
        sub_options.prompt =
            build_sub_agent_prompt(&options.prompt, &options.role, index, team_size);
        thread::spawn(move || {
            let _ = tx.send((index, run_engine_single(&name, sub_options, vec![])));
        });
    }
    drop(tx);

    let mut indexed = rx.into_iter().collect::<Vec<_>>();
    indexed.sort_by_key(|(index, _)| *index);
    let sub_agents = indexed
        .into_iter()
        .map(|(_, result)| result)
        .collect::<Vec<_>>();
    let mut lead_options = options.clone();
    lead_options.prompt = build_team_lead_prompt(&options.prompt, &sub_agents);
    lead_options.is_sub_agent = true;
    run_engine_single(name, lead_options, sub_agents)
}

fn run_engine_single(
    name: &str,
    options: EngineRunOptions,
    sub_agents: Vec<EngineResult>,
) -> EngineResult {
    let started = Instant::now();
    let bin = resolve_binary(name);
    let result = match Engine::parse(name) {
        Some(Engine::Codex) => run_codex(&bin, &options),
        Some(Engine::Claude) => run_claude(&bin, &options),
        Some(Engine::Gemini) => run_gemini(&bin, &options),
        None => CommandResult {
            command: name.to_string(),
            args: vec![],
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            error: Some(format!("Unknown engine: {name}")),
            timeout_ms: options.timeout_ms,
            duration_ms: started.elapsed().as_millis(),
        },
    };
    finalize_engine(
        name,
        &bin,
        started.elapsed().as_millis(),
        result,
        options,
        sub_agents,
    )
}

fn push_arg(args: &mut Vec<String>, flag: &str, value: impl Into<String>) {
    args.push(flag.to_string());
    args.push(value.into());
}

fn push_optional_arg(args: &mut Vec<String>, flag: &str, value: &Option<String>) {
    if let Some(value) = value {
        push_arg(args, flag, value.clone());
    }
}

fn push_repeated_flag(args: &mut Vec<String>, flag: &str, values: &[String]) {
    if !values.is_empty() {
        args.push(flag.to_string());
        args.extend(values.iter().cloned());
    }
}

fn push_each_arg(args: &mut Vec<String>, flag: &str, values: &[String]) {
    for value in values {
        push_arg(args, flag, value.clone());
    }
}

fn run_codex(bin: &str, options: &EngineRunOptions) -> CommandResult {
    let temp = match tempfile::tempdir() {
        Ok(temp) => temp,
        Err(error) => {
            return CommandResult {
                command: bin.to_string(),
                args: vec![],
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                error: Some(error.to_string()),
                timeout_ms: options.timeout_ms,
                duration_ms: 0,
            }
        }
    };
    let output_path = temp.path().join("last-message.txt");
    let mut args = vec!["exec".to_string()];
    push_optional_arg(&mut args, "--model", &options.model);
    if let Some(effort) = &options.effort {
        push_arg(&mut args, "-c", format!("model_reasoning_effort={effort}"));
    }
    if options.capability.mode == CAPABILITY_OVERRIDE {
        for config in &options.capability.config {
            push_arg(&mut args, "-c", config.clone());
        }
        push_optional_arg(&mut args, "--profile", &options.capability.mcp_profile);
    }
    args.extend([
        "--skip-git-repo-check".to_string(),
        "--sandbox".to_string(),
        options
            .permission
            .clone()
            .unwrap_or_else(|| "read-only".to_string()),
        "--ephemeral".to_string(),
        "--json".to_string(),
        "-o".to_string(),
        output_path.display().to_string(),
        "-".to_string(),
    ]);
    let mut result = run_command(
        bin,
        &args,
        &options.cwd,
        Some(&options.prompt),
        options.timeout_ms,
        HashMap::new(),
    );
    if let Ok(output) = fs::read_to_string(output_path) {
        if !output.trim().is_empty() {
            result.stdout = output;
        }
    }
    result
}

fn run_claude(bin: &str, options: &EngineRunOptions) -> CommandResult {
    let mut args = Vec::new();
    if should_use_claude_bare_mode(&options.auth) {
        args.push("--bare".to_string());
    }
    args.extend([
        "-p".to_string(),
        "--permission-mode".to_string(),
        options
            .permission
            .clone()
            .unwrap_or_else(|| "plan".to_string()),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--no-session-persistence".to_string(),
    ]);
    push_optional_arg(&mut args, "--model", &options.model);
    if let Some(effort) = options
        .effort
        .clone()
        .or_else(|| std::env::var("CLAUDE_CODE_EFFORT_LEVEL").ok())
    {
        push_arg(&mut args, "--effort", effort);
    }
    if options.capability.mode == CAPABILITY_OVERRIDE {
        push_repeated_flag(&mut args, "--mcp-config", &options.capability.mcp_config);
        push_repeated_flag(
            &mut args,
            "--allowedTools",
            &options.capability.allowed_tools,
        );
        push_repeated_flag(
            &mut args,
            "--disallowedTools",
            &options.capability.disallowed_tools,
        );
        push_repeated_flag(&mut args, "--tools", &options.capability.tools);
        push_optional_arg(&mut args, "--agent", &options.capability.agent);
        push_optional_arg(&mut args, "--agents", &options.capability.agents_json);
        push_each_arg(&mut args, "--plugin-dir", &options.capability.plugin_dirs);
        if options.capability.strict_mcp_config {
            args.push("--strict-mcp-config".to_string());
        }
        if options.capability.disable_slash_commands {
            args.push("--disable-slash-commands".to_string());
        }
    }
    run_command(
        bin,
        &args,
        &options.cwd,
        Some(&options.prompt),
        options.timeout_ms,
        HashMap::new(),
    )
}

fn run_gemini(bin: &str, options: &EngineRunOptions) -> CommandResult {
    let mut args = Vec::new();
    push_optional_arg(&mut args, "--model", &options.model);
    if options.capability.mode == CAPABILITY_OVERRIDE {
        push_repeated_flag(&mut args, "--extensions", &options.capability.tools_profile);
        push_repeated_flag(
            &mut args,
            "--allowed-mcp-server-names",
            &options.capability.allowed_mcp_servers,
        );
        push_repeated_flag(&mut args, "--policy", &options.capability.policy);
        push_repeated_flag(
            &mut args,
            "--admin-policy",
            &options.capability.admin_policy,
        );
    }
    args.extend([
        "-p".to_string(),
        options.prompt.clone(),
        "--skip-trust".to_string(),
        "--approval-mode".to_string(),
        "plan".to_string(),
        "--output-format".to_string(),
        "json".to_string(),
    ]);
    let mut envs = HashMap::new();
    let effort_settings = prepare_gemini_settings(options);
    if let Some(path) = effort_settings.as_ref() {
        envs.insert(
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_string(),
            path.path.display().to_string(),
        );
    } else if options.capability.mode == CAPABILITY_OVERRIDE {
        if let Some(settings) = &options.capability.settings {
            envs.insert(
                "GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_string(),
                settings.clone(),
            );
        }
    }
    run_command(bin, &args, &options.cwd, None, options.timeout_ms, envs)
}

fn prepare_gemini_settings(options: &EngineRunOptions) -> Option<TempSettings> {
    let effort = options.effort.as_deref()?;
    let budget = match effort {
        "low" => 1024,
        "medium" => 8192,
        "high" => 24576,
        _ => return None,
    };
    let dir = tempfile::tempdir().ok()?;
    let path = dir.path().join("settings.json");
    let mut settings = if options.capability.mode == CAPABILITY_OVERRIDE {
        options
            .capability
            .settings
            .as_ref()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| Value::Object(Default::default()))
    } else {
        Value::Object(Default::default())
    };
    if let Value::Object(object) = &mut settings {
        object.insert("thinkingBudget".to_string(), Value::from(budget));
    }
    let _ = fs::write(&path, serde_json::to_vec(&settings).ok()?);
    Some(TempSettings { _dir: dir, path })
}

fn should_use_claude_bare_mode(auth: &str) -> bool {
    if auth == "api-key" {
        return true;
    }
    if matches!(auth, "social-login" | "oauth" | "keychain") {
        return false;
    }
    if std::env::var("CLAUDE_CODE_OAUTH_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .is_some()
    {
        return false;
    }
    std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .is_some()
}

fn run_command(
    command: &str,
    args: &[String],
    cwd: &Path,
    stdin_text: Option<&str>,
    timeout_ms: u64,
    envs: HashMap<String, String>,
) -> CommandResult {
    let started = Instant::now();
    let mut child = match Command::new(command)
        .args(args)
        .current_dir(cwd)
        .envs(envs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CommandResult {
                command: command.to_string(),
                args: args.to_vec(),
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                error: Some(error.to_string()),
                timeout_ms,
                duration_ms: started.elapsed().as_millis(),
            }
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Some(text) = stdin_text {
            let _ = stdin.write_all(text.as_bytes());
        }
    }

    let stdout = child.stdout.take().map(read_pipe);
    let stderr = child.stderr.take().map(read_pipe);
    let timeout = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let code;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code();
                break;
            }
            Ok(None) => {
                if timeout_ms > 0 && started.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    let status = child.wait().ok();
                    code = status.and_then(|status| status.code());
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return CommandResult {
                    command: command.to_string(),
                    args: args.to_vec(),
                    code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out,
                    error: Some(error.to_string()),
                    timeout_ms,
                    duration_ms: started.elapsed().as_millis(),
                }
            }
        }
    }

    CommandResult {
        command: command.to_string(),
        args: args.to_vec(),
        code,
        stdout: stdout
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
        stderr: stderr
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
        timed_out,
        error: None,
        timeout_ms,
        duration_ms: started.elapsed().as_millis(),
    }
}

fn read_pipe<R>(mut pipe: R) -> thread::JoinHandle<String>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut text = String::new();
        let _ = pipe.read_to_string(&mut text);
        text
    })
}

fn finalize_engine(
    name: &str,
    bin: &str,
    duration_ms: u128,
    command_result: CommandResult,
    options: EngineRunOptions,
    sub_agents: Vec<EngineResult>,
) -> EngineResult {
    let output = match Engine::parse(name) {
        Some(Engine::Claude) => parse_claude_output(&command_result.stdout),
        Some(Engine::Gemini) => parse_gemini_output(&command_result.stdout),
        Some(Engine::Codex) => parse_codex_output(&command_result.stdout),
        None => command_result.stdout.trim().to_string(),
    };
    let status = if command_result.error.is_some() {
        "missing"
    } else if command_result.timed_out {
        "timeout"
    } else if command_result.code != Some(0) || output.trim().is_empty() {
        "error"
    } else {
        "ok"
    };
    let detail = if status == "ok" {
        String::new()
    } else if command_result.timed_out {
        format!("Timed out after {}s.", command_result.timeout_ms / 1000)
    } else {
        compact_failure(&command_result)
    };
    let usage = aggregate_token_usage(
        extract_token_usage(&command_result.stdout, &options.prompt, &output)
            .unwrap_or_else(|| token_usage(&options.prompt, &output)),
        &sub_agents,
    );
    let tool_calls = extract_tool_usage(name, &command_result.stdout, &command_result.stderr);
    EngineResult {
        name: name.to_string(),
        bin: Some(bin.to_string()),
        status: status.to_string(),
        duration_ms,
        detail,
        exit_code: command_result.code,
        stdout: command_result.stdout,
        stderr: command_result.stderr,
        output,
        command: format_command(&command_result.command, &command_result.args),
        token_usage: usage,
        tool_calls,
        sub_agents,
        role: options.role,
        iteration: options.iteration,
        total_iterations: options.total_iterations,
        team_size: options.team_size,
    }
}

fn compact_failure(result: &CommandResult) -> String {
    if let Some(error) = &result.error {
        return error.clone();
    }
    if !result.stderr.trim().is_empty() {
        return result.stderr.trim().to_string();
    }
    if !result.stdout.trim().is_empty() {
        return result.stdout.trim().to_string();
    }
    result
        .code
        .map(|code| format!("Exited with code {code}."))
        .unwrap_or_else(|| "Command failed.".to_string())
}

fn command_telemetry(result: &CommandResult) -> CommandTelemetry {
    let status = if result.error.is_some() {
        "missing"
    } else if result.timed_out {
        "timeout"
    } else if result.code == Some(0) {
        "ok"
    } else {
        "error"
    };
    CommandTelemetry {
        command: format_command(&result.command, &result.args),
        status: status.to_string(),
        detail: truncate(&sanitize_status_detail(&compact_failure(result)), 600),
        exit_code: result.code,
        duration_ms: result.duration_ms,
        stdout_chars: result.stdout.len(),
        stderr_chars: result.stderr.len(),
        timed_out: result.timed_out,
    }
}

fn parse_codex_output(stdout: &str) -> String {
    stdout.trim().to_string()
}

fn parse_claude_output(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(value) = extract_json(trimmed) {
        if let Some(result) = value.get("result").and_then(Value::as_str) {
            return result.trim().to_string();
        }
    }
    let mut latest = String::new();
    for line in trimmed.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("result") {
            if let Some(result) = value.get("result").and_then(Value::as_str) {
                latest = result.trim().to_string();
            }
        }
        if value.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                let text = content
                    .iter()
                    .filter_map(|block| {
                        (block.get("type").and_then(Value::as_str) == Some("text"))
                            .then(|| block.get("text").and_then(Value::as_str))
                            .flatten()
                    })
                    .collect::<String>();
                if !text.trim().is_empty() {
                    latest = text.trim().to_string();
                }
            }
        }
    }
    if latest.is_empty() {
        trimmed.to_string()
    } else {
        latest
    }
}

fn parse_gemini_output(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(value) = extract_json(trimmed) {
        if let Some(response) = value.get("response").and_then(Value::as_str) {
            return response.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn extract_json(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        serde_json::from_str::<Value>(&text[start..=end]).ok()
    })
}

fn build_member_prompt(
    query: &str,
    role: &str,
    workflow: &Workflow,
    iteration: usize,
    previous_iteration: &[EngineResult],
    handoff_results: &[EngineResult],
    plan_output: &str,
) -> String {
    let mut sections = vec![
        "You are one member of a multi-model council.".to_string(),
        format!(
            "Council workflow: iteration {iteration} of {}.",
            workflow.iterations
        ),
        workflow
            .lead
            .as_ref()
            .map(|lead| format!("Lead model: {lead}."))
            .unwrap_or_else(|| "Lead model: auto.".to_string()),
        workflow
            .planner
            .as_ref()
            .map(|planner| format!("Planner model: {planner}."))
            .unwrap_or_else(|| "Planner model: none.".to_string()),
        format!("Your assigned role: {role}."),
        role_instruction(role).to_string(),
        "Answer the user query directly.".to_string(),
        "Do not introduce yourself.".to_string(),
        "Do not describe your tools, environment, or capabilities unless the user explicitly asks."
            .to_string(),
        "Be concise unless the user asks for depth.".to_string(),
    ];
    if workflow.team_work > 0 {
        sections.push(format!(
            "Team work: you may coordinate up to {} internal sub-agents or subtasks inside your own CLI if that helps.",
            workflow.team_work
        ));
    }
    if workflow.handoff {
        sections.push(
            "Handoff mode is enabled. Treat earlier council outputs as working context."
                .to_string(),
        );
    }
    if !plan_output.trim().is_empty() {
        sections.push(format!("Planner handoff:\n{}", plan_output.trim()));
    }
    let context = previous_iteration
        .iter()
        .chain(handoff_results.iter())
        .filter(|result| result.status == "ok" && !result.output.trim().is_empty())
        .map(|result| format!("### {}\n{}", result.name, result.output.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    if !context.is_empty() {
        sections.push(format!("Earlier council handoffs:\n{context}"));
    }
    sections.push(format!("Current user query:\n{}", query.trim()));
    sections.join("\n\n")
}

fn build_summary_prompt(
    query: &str,
    responses: &[EngineResult],
    workflow: &Workflow,
    max_member_chars: usize,
) -> String {
    let blocks = responses
        .iter()
        .map(|response| {
            let output = truncate(&response.output, max_member_chars);
            format!("### {}\n{}", response.name, output.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "You are synthesizing answers from multiple AI CLI tools.\n\nCouncil workflow: {} iteration{}, {}.\nLead model: {}.\nPlanner model: {}.\nProduce one final answer to the original user query.\nAnswer directly. Call out meaningful disagreement or uncertainty when it exists.\n\nCurrent user query:\n{}\n\nCouncil member responses:\n{}",
        workflow.iterations,
        if workflow.iterations == 1 { "" } else { "s" },
        if workflow.handoff { "handoff enabled" } else { "parallel consultation" },
        workflow.lead.as_deref().unwrap_or("auto"),
        workflow.planner.as_deref().unwrap_or("none"),
        query.trim(),
        blocks
    )
}

fn role_instruction(role: &str) -> &'static str {
    match role {
        "planner" => "Plan the work: identify the approach, risks, checkpoints, and useful handoffs for the executors.",
        "lead" => "Lead the work: make the strongest direct attempt while watching for conflicts you may need to resolve in synthesis.",
        "lead+planner" => "Plan and lead the work: produce a practical plan, then make the strongest direct attempt from that plan.",
        _ => "Execute the work: use any plan or handoff context, then produce your independent best answer.",
    }
}

fn execution_order(members: &[String], planner: Option<&str>) -> Vec<String> {
    let mut ordered = Vec::new();
    if let Some(planner) = planner {
        if members.iter().any(|member| member == planner) {
            ordered.push(planner.to_string());
        }
    }
    ordered.extend(
        members
            .iter()
            .filter(|member| Some(member.as_str()) != planner)
            .cloned(),
    );
    ordered
}

fn role_for(member: &str, workflow: &Workflow) -> String {
    let is_lead = workflow.lead.as_deref() == Some(member);
    let is_planner = workflow.planner.as_deref() == Some(member);
    match (is_lead, is_planner) {
        (true, true) => "lead+planner",
        (true, false) => "lead",
        (false, true) => "planner",
        (false, false) => "executor",
    }
    .to_string()
}

fn pick_summarizer(resolved: &ResolvedArgs, successes: &[EngineResult]) -> String {
    if resolved.raw.summarizer != "auto" {
        return resolved.raw.summarizer.clone();
    }
    if let Some(lead) = &resolved.raw.lead {
        if successes.iter().any(|result| &result.name == lead) {
            return lead.clone();
        }
    }
    DEFAULT_SUMMARIZER_ORDER
        .iter()
        .find(|name| successes.iter().any(|result| result.name == **name))
        .unwrap_or(&successes[0].name.as_str())
        .to_string()
}

fn resolve_binary(name: &str) -> String {
    let Some(engine) = Engine::parse(name) else {
        return name.to_string();
    };
    std::env::var(engine.binary_env_var())
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| engine.as_str().to_string())
}

fn token_usage(prompt: &str, output: &str) -> TokenUsage {
    let input = estimate_tokens(prompt);
    let output = estimate_tokens(output);
    TokenUsage {
        input,
        output,
        total: input + output,
        estimated: true,
        source: "estimate".to_string(),
    }
}

fn aggregate_token_usage(mut usage: TokenUsage, sub_agents: &[EngineResult]) -> TokenUsage {
    if sub_agents.is_empty() {
        return usage;
    }
    for agent in sub_agents {
        usage.input += agent.token_usage.input;
        usage.output += agent.token_usage.output;
        usage.total += agent.token_usage.total;
        usage.estimated |= agent.token_usage.estimated;
    }
    usage.source = format!("{}+sub-agents", usage.source);
    usage
}

fn extract_token_usage(stdout: &str, prompt: &str, output: &str) -> Option<TokenUsage> {
    let mut usage = TokenAccumulator::default();
    for value in json_values(stdout) {
        collect_token_counts(&value, &mut usage);
    }
    if usage.input.is_none() && usage.output.is_none() && usage.total.is_none() {
        return None;
    }
    let input = usage.input.unwrap_or_else(|| estimate_tokens(prompt));
    let output = usage.output.unwrap_or_else(|| estimate_tokens(output));
    let total = usage.total.unwrap_or(input + output);
    Some(TokenUsage {
        input,
        output,
        total,
        estimated: usage.input.is_none() || usage.output.is_none(),
        source: "provider".to_string(),
    })
}

#[derive(Default)]
struct TokenAccumulator {
    input: Option<usize>,
    output: Option<usize>,
    total: Option<usize>,
}

fn collect_token_counts(value: &Value, usage: &mut TokenAccumulator) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                let normalized = key.replace(['_', '-'], "").to_ascii_lowercase();
                if let Some(count) = value.as_u64().map(|value| value as usize) {
                    match normalized.as_str() {
                        "inputtokens" | "inputtokencount" | "prompttokens" | "prompttokencount" => {
                            usage.input = Some(count)
                        }
                        "outputtokens"
                        | "outputtokencount"
                        | "completiontokens"
                        | "candidatestokencount" => usage.output = Some(count),
                        "totaltokens" | "totaltokencount" => usage.total = Some(count),
                        _ => {}
                    }
                }
                collect_token_counts(value, usage);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_token_counts(value, usage);
            }
        }
        _ => {}
    }
}

fn extract_tool_usage(provider: &str, stdout: &str, stderr: &str) -> Vec<ToolUsage> {
    let mut tools = Vec::new();
    for value in json_values(stdout) {
        collect_tool_usage(&value, &mut tools);
    }
    for line in stdout.lines().chain(stderr.lines()) {
        if let Some(tool) = line_tool_usage(provider, line) {
            tools.push(tool);
        }
    }
    dedupe_tools(tools)
}

fn collect_tool_usage(value: &Value, tools: &mut Vec<ToolUsage>) {
    match value {
        Value::Object(map) => {
            let type_name = map.get("type").and_then(Value::as_str).unwrap_or_default();
            let name = map
                .get("name")
                .or_else(|| map.get("tool"))
                .or_else(|| map.get("tool_name"))
                .or_else(|| map.get("toolName"))
                .and_then(Value::as_str);
            if let Some(name) = name.filter(|_| {
                type_name.contains("tool")
                    || map.contains_key("input")
                    || map.contains_key("arguments")
                    || map.contains_key("toolCall")
            }) {
                tools.push(ToolUsage {
                    name: name.to_string(),
                    kind: if type_name.is_empty() {
                        "tool"
                    } else {
                        type_name
                    }
                    .to_string(),
                    status: "observed".to_string(),
                    detail: short_json_detail(value),
                });
            }
            for value in map.values() {
                collect_tool_usage(value, tools);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_tool_usage(value, tools);
            }
        }
        _ => {}
    }
}

fn line_tool_usage(provider: &str, line: &str) -> Option<ToolUsage> {
    let trimmed = line.trim();
    let lowered = trimmed.to_ascii_lowercase();
    let marker = ["running shell:", "tool:", "tool_use", "mcp:", "command:"]
        .iter()
        .find(|marker| lowered.contains(**marker))?;
    Some(ToolUsage {
        name: marker.trim_end_matches(':').to_string(),
        kind: provider.to_string(),
        status: "observed".to_string(),
        detail: truncate(trimmed, 240),
    })
}

fn short_json_detail(value: &Value) -> String {
    serde_json::to_string(value)
        .map(|text| truncate(&text, 240))
        .unwrap_or_default()
}

fn dedupe_tools(tools: Vec<ToolUsage>) -> Vec<ToolUsage> {
    let mut seen = HashSet::new();
    tools
        .into_iter()
        .filter(|tool| seen.insert(format!("{}:{}:{}", tool.kind, tool.name, tool.detail)))
        .collect()
}

fn json_values(text: &str) -> Vec<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let mut values = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        values.push(value);
        return values;
    }
    for line in trimmed.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            values.push(value);
        }
    }
    values
}

fn estimate_tokens(text: &str) -> usize {
    if text.trim().is_empty() {
        0
    } else {
        text.len().div_ceil(TOKEN_ESTIMATE_CHARS_PER_TOKEN)
    }
}

fn format_command(command: &str, args: &[String]) -> String {
    std::iter::once(command.to_string())
        .chain(args.iter().map(|arg| shell_quote(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_./:=@%+-".contains(ch))
    {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let mut truncated = text.chars().take(max_chars).collect::<String>();
        truncated.push_str("\n...[truncated]");
        truncated
    }
}

fn should_show_banner(raw: &CliArgs) -> bool {
    !raw.no_banner && !raw.headless && !raw.json && !raw.json_stream && !raw.plain
}

fn render_banner() -> &'static str {
    "  ____   ___  _   _ _   _  ____ ___ _     \n / ___| / _ \\| | | | \\ | |/ ___|_ _| |    \n| |    | | | | | | |  \\| | |    | || |    \n| |___ | |_| | |_| | |\\  | |___ | || |___ \n \\____| \\___/ \\___/|_| \\_|\\____|___|_____|"
}

fn render_human_result(result: &CouncilResult, verbose: bool) -> String {
    let mut lines = Vec::new();
    if verbose {
        lines.push(format!(
            "Council consulted: {}",
            result.members_requested.join(", ")
        ));
        for command in &result.prompt_commands {
            lines.push(format!(
                "cmd [{}] {} ({:.1}s)",
                command.status,
                command.command,
                command.duration_ms as f64 / 1000.0
            ));
        }
        for (index, member) in result.members.iter().enumerate() {
            lines.push(format!(
                "{}. [{}] {} ({:.1}s, tokens:{}, tools:{}, sub-agents:{}){}",
                index + 1,
                member.status,
                member.name,
                member.duration_ms as f64 / 1000.0,
                member.token_usage.total,
                member.tool_calls.len(),
                member.sub_agents.len(),
                if member.detail.is_empty() { "" } else { ": " }
            ));
            if !member.detail.is_empty() {
                lines.push(format!("   {}", member.detail));
            }
            for sub_agent in &member.sub_agents {
                lines.push(format!(
                    "   - {} [{}] tokens:{} tools:{}",
                    sub_agent.role,
                    sub_agent.status,
                    sub_agent.token_usage.total,
                    sub_agent.tool_calls.len()
                ));
            }
            if member.status == "ok" {
                lines.push(indent(&member.output, "   "));
            }
        }
        lines.push("----------- synthesis -----------".to_string());
    }
    if result.summary.status == "ok" {
        lines.push(result.summary.output.trim().to_string());
    } else {
        lines.push(format!("Synthesis failed: {}", result.summary.detail));
    }
    lines.join("\n")
}

fn indent(text: &str, prefix: &str) -> String {
    text.lines()
        .map(|line| format!("{prefix}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_success(result: &CouncilResult) -> bool {
    result.members.iter().any(|member| member.status == "ok") && result.summary.status == "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_members_and_provider_flags() {
        let args = CliArgs::try_parse_from([
            "council",
            "--members",
            "codex,claude",
            "--planner",
            "codex",
            "--lead",
            "claude",
            "--codex-effort",
            "xhigh",
            "--claude-capabilities",
            "override",
            "--claude-allowed-tools",
            "Read,Bash(git:*)",
            "--claude-tools",
            "Read,Edit",
            "--claude-agent",
            "reviewer",
            "--gemini-allowed-mcp-servers",
            "linear,github",
            "ship it",
        ])
        .unwrap();
        let resolved = resolve_args(args).unwrap();
        assert_eq!(resolved.members, vec!["codex", "claude"]);
        assert_eq!(resolved.raw.codex_effort.as_deref(), Some("xhigh"));
        assert_eq!(
            resolved.raw.claude_allowed_tools,
            vec!["Read", "Bash(git:*)"]
        );
        assert_eq!(resolved.raw.claude_tools, vec!["Read", "Edit"]);
        assert_eq!(resolved.raw.claude_agent.as_deref(), Some("reviewer"));
        assert_eq!(
            resolved.raw.gemini_allowed_mcp_servers,
            vec!["linear", "github"]
        );
    }

    #[test]
    fn builds_member_prompt_with_roles_and_handoff() {
        let workflow = Workflow {
            handoff: true,
            lead: Some("claude".to_string()),
            planner: Some("codex".to_string()),
            iterations: 2,
            team_work: 1,
            teams: HashMap::new(),
        };
        let prompt = build_member_prompt("Fix the bug", "planner", &workflow, 1, &[], &[], "");
        assert!(prompt.contains("Council workflow: iteration 1 of 2."));
        assert!(prompt.contains("Lead model: claude."));
        assert!(prompt.contains("Planner model: codex."));
        assert!(prompt.contains("Your assigned role: planner."));
        assert!(prompt.contains("Current user query:"));
    }

    #[test]
    fn parses_claude_stream_json_result() {
        let text = r#"{"type":"system","subtype":"status","status":"requesting"}
{"type":"result","result":"done"}"#;
        assert_eq!(parse_claude_output(text), "done");
    }

    #[test]
    fn parses_gemini_json_response() {
        assert_eq!(parse_gemini_output(r#"{"response":"hello"}"#), "hello");
    }

    #[test]
    fn estimates_tokens_with_ceiling_chunks() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn extracts_social_login_urls() {
        assert_eq!(
            extract_auth_urls("Open https://example.com/callback?code=123, then continue"),
            vec!["https://example.com/callback?code=123"]
        );
        assert_eq!(
            extract_auth_urls("deeplink: claude://login/complete."),
            vec!["claude://login/complete"]
        );
    }

    #[test]
    fn parses_provider_token_usage() {
        let stdout = r#"{"usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}"#;
        let usage = extract_token_usage(stdout, "hello", "world").unwrap();
        assert_eq!(usage.input, 12);
        assert_eq!(usage.output, 8);
        assert_eq!(usage.total, 20);
        assert!(!usage.estimated);
    }

    #[test]
    fn extracts_tool_usage_from_provider_streams() {
        let stdout = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}"#;
        let tools = extract_tool_usage("claude", stdout, "");
        assert!(tools.iter().any(|tool| tool.name == "Bash"));
    }

    #[test]
    fn builds_real_sub_agent_handoff_prompt() {
        let agent = EngineResult {
            name: "codex".to_string(),
            bin: Some("codex".to_string()),
            status: "ok".to_string(),
            duration_ms: 1,
            detail: String::new(),
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            output: "inspect parser".to_string(),
            command: "codex exec".to_string(),
            token_usage: token_usage("a", "b"),
            tool_calls: vec![],
            sub_agents: vec![],
            role: "executor:sub-agent-1".to_string(),
            iteration: 1,
            total_iterations: 1,
            team_size: 0,
        };
        let prompt = build_team_lead_prompt("ship it", &[agent]);
        assert!(prompt.contains("Sub-agent handoffs"));
        assert!(prompt.contains("inspect parser"));
        assert!(prompt.contains("Original provider prompt"));
    }

    #[test]
    fn system_time_is_available_for_test_environment() {
        assert!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .is_ok());
    }
}
