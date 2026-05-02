use clap::{ArgAction, Parser};

pub const ALL_ENGINES: &[&str] = &["codex", "claude", "gemini"];
pub const AUTO_SUMMARIZER: &str = "auto";
pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high"];
pub const DEFAULT_TIMEOUT_MS: u64 = 600_000;
pub const DEFAULT_MAX_MEMBER_CHARS: usize = 12_000;

#[derive(Parser, Debug)]
#[command(
    name = "council",
    about = "Ask multiple AI CLIs the same question, then synthesize their answers.",
    long_about = None,
    disable_version_flag = true,
)]
pub struct RawArgs {
    /// Per-CLI timeout in seconds (default: 600 / 10 minutes)
    #[arg(long)]
    pub timeout: Option<String>,

    /// Cap each member response before summarization (default: 12000)
    #[arg(long = "max-member-chars")]
    pub max_member_chars: Option<String>,

    /// Working directory for all upstream CLIs
    #[arg(long)]
    pub cwd: Option<String>,

    /// Print structured JSON result at end
    #[arg(long, action = ArgAction::SetTrue)]
    pub json: bool,

    /// Stream JSONL lifecycle events as they happen
    #[arg(long = "json-stream", action = ArgAction::SetTrue)]
    pub json_stream: bool,

    /// Alias for --json-stream
    #[arg(long, action = ArgAction::SetTrue)]
    pub ndjson: bool,

    /// Automation mode: no banner, no progress, summary-only text by default
    #[arg(long, action = ArgAction::SetTrue)]
    pub headless: bool,

    /// Disable decorative UI and color
    #[arg(long, action = ArgAction::SetTrue)]
    pub plain: bool,

    /// Suppress the startup banner
    #[arg(long = "no-banner", action = ArgAction::SetTrue)]
    pub no_banner: bool,

    /// Print only the final synthesis
    #[arg(long = "summary-only", action = ArgAction::SetTrue)]
    pub summary_only: bool,

    /// Alias for --summary-only
    #[arg(short = 'q', long, action = ArgAction::SetTrue)]
    pub quiet: bool,

    /// Show all member responses, even if they fail
    #[arg(short = 'd', long, action = ArgAction::SetTrue)]
    pub verbose: bool,

    /// Re-enable all members
    #[arg(long, action = ArgAction::SetTrue)]
    pub all: bool,

    /// Enable codex (default: true)
    #[arg(long, action = ArgAction::SetTrue, default_value_t = true)]
    pub codex: bool,

    /// Disable codex
    #[arg(long = "no-codex", action = ArgAction::SetTrue)]
    pub no_codex: bool,

    /// Enable claude (default: true)
    #[arg(long, action = ArgAction::SetTrue, default_value_t = true)]
    pub claude: bool,

    /// Disable claude
    #[arg(long = "no-claude", action = ArgAction::SetTrue)]
    pub no_claude: bool,

    /// Enable gemini (default: true)
    #[arg(long, action = ArgAction::SetTrue, default_value_t = true)]
    pub gemini: bool,

    /// Disable gemini
    #[arg(long = "no-gemini", action = ArgAction::SetTrue)]
    pub no_gemini: bool,

    /// Ordered subset of codex,claude,gemini
    #[arg(long)]
    pub members: Option<String>,

    /// auto, codex, claude, or gemini
    #[arg(long)]
    pub summarizer: Option<String>,

    /// Reasoning effort: low, medium, or high
    #[arg(long)]
    pub effort: Option<String>,

    /// Color mode: auto, always, or never
    #[arg(long)]
    pub color: Option<String>,

    /// Disable color output
    #[arg(long = "no-color", action = ArgAction::SetTrue)]
    pub no_color: bool,

    /// Show version
    #[arg(short = 'v', long, action = ArgAction::SetTrue)]
    pub version: bool,

    /// Show help
    #[arg(short = 'h', long, action = ArgAction::SetTrue)]
    pub help_flag: bool,

    /// Query positional arguments
    #[arg(trailing_var_arg = true)]
    pub query_parts: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum OutputMode {
    Text,
    Json,
    JsonStream,
}

#[derive(Debug, Clone)]
pub enum ColorMode {
    Auto,
    Always,
    Never,
}

#[derive(Debug, Clone)]
pub struct ParsedArgs {
    pub help: bool,
    pub version: bool,
    pub json: bool,
    pub json_stream: bool,
    pub headless: bool,
    pub plain: bool,
    pub no_banner: bool,
    pub summary_only: bool,
    pub quiet: bool,
    pub verbose: bool,
    pub color: ColorMode,
    pub summarizer: String,
    pub effort: Option<String>,
    pub timeout_ms: u64,
    pub max_member_chars: usize,
    pub cwd: String,
    pub members: Vec<String>,
    pub prompt_parts: Vec<String>,
}

pub fn parse_args(raw: RawArgs) -> Result<ParsedArgs, String> {
    if raw.help_flag {
        return Ok(ParsedArgs {
            help: true,
            version: false,
            members: ALL_ENGINES.iter().map(|s| s.to_string()).collect(),
            ..default_parsed()
        });
    }

    if raw.version {
        return Ok(ParsedArgs {
            help: false,
            version: true,
            members: ALL_ENGINES.iter().map(|s| s.to_string()).collect(),
            ..default_parsed()
        });
    }

    let color = if raw.no_color {
        ColorMode::Never
    } else {
        parse_color(raw.color.as_deref().unwrap_or("auto"))?
    };

    let summarizer = parse_summarizer(raw.summarizer.as_deref().unwrap_or(AUTO_SUMMARIZER))?;
    let effort = parse_effort(raw.effort.as_deref())?;

    let timeout_ms = match &raw.timeout {
        Some(v) => parse_timeout_ms(v)?,
        None => DEFAULT_TIMEOUT_MS,
    };

    let max_member_chars = match &raw.max_member_chars {
        Some(v) => parse_positive_integer(v, "--max-member-chars")?,
        None => DEFAULT_MAX_MEMBER_CHARS,
    };

    let cwd = raw.cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    let members = resolve_members(&raw)?;

    Ok(ParsedArgs {
        help: false,
        version: false,
        json: raw.json,
        json_stream: raw.json_stream || raw.ndjson,
        headless: raw.headless,
        plain: raw.plain,
        no_banner: raw.no_banner,
        summary_only: raw.summary_only,
        quiet: raw.quiet,
        verbose: raw.verbose,
        color,
        summarizer,
        effort,
        timeout_ms,
        max_member_chars,
        cwd,
        members,
        prompt_parts: raw.query_parts,
    })
}

fn resolve_members(raw: &RawArgs) -> Result<Vec<String>, String> {
    // --members wins over individual flags
    if let Some(members_str) = &raw.members {
        let members = parse_engine_list(members_str, "--members")?;
        if members.is_empty() {
            return Err("--members requires at least one engine.".to_string());
        }
        return Ok(members);
    }

    let mut enabled = std::collections::HashMap::new();
    for e in ALL_ENGINES {
        enabled.insert(*e, true);
    }

    if raw.all {
        for e in ALL_ENGINES {
            enabled.insert(*e, true);
        }
    }

    if raw.no_codex {
        enabled.insert("codex", false);
    }
    if raw.no_claude {
        enabled.insert("claude", false);
    }
    if raw.no_gemini {
        enabled.insert("gemini", false);
    }

    let members: Vec<String> = ALL_ENGINES
        .iter()
        .filter(|e| *enabled.get(*e).unwrap_or(&true))
        .map(|e| e.to_string())
        .collect();

    if members.is_empty() {
        return Err("At least one engine must be enabled.".to_string());
    }

    Ok(members)
}

fn parse_engine_list(value: &str, flag_name: &str) -> Result<Vec<String>, String> {
    let members: Vec<String> = value
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if members.is_empty() {
        return Err(format!("{flag_name} requires at least one engine."));
    }

    let invalid: Vec<&str> = members
        .iter()
        .filter(|m| !ALL_ENGINES.contains(&m.as_str()))
        .map(|m| m.as_str())
        .collect();

    if !invalid.is_empty() {
        return Err(format!(
            "Unsupported engine in {flag_name}: {}",
            invalid.join(", ")
        ));
    }

    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    Ok(members.into_iter().filter(|m| seen.insert(m.clone())).collect())
}

fn parse_summarizer(value: &str) -> Result<String, String> {
    if value == AUTO_SUMMARIZER || ALL_ENGINES.contains(&value) {
        return Ok(value.to_string());
    }
    Err(format!("Unsupported summarizer: {value}"))
}

fn parse_effort(value: Option<&str>) -> Result<Option<String>, String> {
    match value {
        None | Some("") => Ok(None),
        Some(v) => {
            if EFFORT_LEVELS.contains(&v) {
                Ok(Some(v.to_string()))
            } else {
                Err(format!(
                    "Unsupported --effort value: {v} (expected {})",
                    EFFORT_LEVELS.join(", ")
                ))
            }
        }
    }
}

fn parse_timeout_ms(value: &str) -> Result<u64, String> {
    let seconds: f64 = value
        .parse()
        .map_err(|_| format!("Invalid timeout value: {value}"))?;

    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(format!("Invalid timeout value: {value}"));
    }

    Ok((seconds * 1000.0).round() as u64)
}

fn parse_positive_integer(value: &str, flag_name: &str) -> Result<usize, String> {
    let parsed: usize = value
        .parse()
        .map_err(|_| format!("{flag_name} requires a positive integer."))?;

    if parsed == 0 {
        return Err(format!("{flag_name} requires a positive integer."));
    }

    Ok(parsed)
}

fn parse_color(value: &str) -> Result<ColorMode, String> {
    match value {
        "auto" => Ok(ColorMode::Auto),
        "always" => Ok(ColorMode::Always),
        "never" => Ok(ColorMode::Never),
        _ => Err(format!("Unsupported color mode: {value}")),
    }
}

fn default_parsed() -> ParsedArgs {
    ParsedArgs {
        help: false,
        version: false,
        json: false,
        json_stream: false,
        headless: false,
        plain: false,
        no_banner: false,
        summary_only: false,
        quiet: false,
        verbose: false,
        color: ColorMode::Auto,
        summarizer: AUTO_SUMMARIZER.to_string(),
        effort: None,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        max_member_chars: DEFAULT_MAX_MEMBER_CHARS,
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        members: ALL_ENGINES.iter().map(|s| s.to_string()).collect(),
        prompt_parts: vec![],
    }
}

pub fn usage_text(version: &str) -> String {
    let default_timeout_seconds = DEFAULT_TIMEOUT_MS / 1_000;
    format!(
        r#"council v{version}

Ask multiple AI CLIs the same question, then synthesize their answers.

Usage:
  council [options] <query>
  echo "query" | council [options]
  council help

Examples:
  council "How should I structure this migration?"
  council --no-gemini --summarizer claude "Review this plan"
  council --headless --json "Summarize the implementation options"
  council --json-stream --codex --claude "Compare these designs"
  council --effort high "Analyze the tradeoffs for this architecture"

Selection:
  --members <list>          Ordered subset of codex,claude,gemini
  --codex / --no-codex      Enable or disable Codex
  --claude / --no-claude    Enable or disable Claude
  --gemini / --no-gemini    Enable or disable Gemini
  --all                     Re-enable all members
  --summarizer <name>       auto, codex, claude, or gemini

Output:
  --summary-only            Print only the final synthesis
  -q, --quiet               Alias for --summary-only
  -d, --verbose             Show all member responses, even if they fail
  --json                    Print structured JSON
  --json-stream             Stream JSONL lifecycle events
  --headless                Automation mode: no banner, no progress, summary-only text by default
  --plain                   Disable decorative UI and color
  --no-banner               Suppress the startup banner
  --color <auto|always|never>

Execution:
  --timeout <seconds>       Per-CLI timeout in seconds (default: {default_timeout_seconds} / 10 minutes)
  --max-member-chars <n>    Cap each member response before summarization (default: {DEFAULT_MAX_MEMBER_CHARS})
  --cwd <path>              Working directory for all upstream CLIs
  --effort <level>          Reasoning effort applied to every member: {effort_levels}

Other:
  -h, --help                Show help
  -v, --version             Show version

Environment:
  COUNCIL_CODEX_BIN         Override the codex executable path
  COUNCIL_CLAUDE_BIN        Override the claude executable path
  COUNCIL_GEMINI_BIN        Override the gemini executable path"#,
        version = version,
        default_timeout_seconds = default_timeout_seconds,
        effort_levels = EFFORT_LEVELS.join(", "),
    )
}
