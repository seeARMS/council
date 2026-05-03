use super::*;
use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    self, disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen,
    LeaveAlternateScreen,
};

const MENU: [&str; 12] = [
    "Run / re-run",
    "Edit prompt",
    "Social login",
    "Linear status",
    "Deliver Linear",
    "Tag local file",
    "Run command",
    "Settings",
    "Agents",
    "Capabilities",
    "Linear",
    "Help",
];

const PANES: [Pane; 6] = [
    Pane::Menu,
    Pane::Settings,
    Pane::Agents,
    Pane::Capabilities,
    Pane::Linear,
    Pane::Results,
];

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
enum Pane {
    Menu,
    Settings,
    Agents,
    Capabilities,
    Linear,
    Results,
}

#[derive(Debug, Clone)]
enum InputMode {
    Prompt,
    File,
    Command,
    LinearIssue,
    LinearQuery,
    LinearProject,
    LinearEpic,
    LinearTeam,
    LinearState,
    LinearMedia,
    CodexConfig,
    CodexProfile,
    ClaudeMcpConfig,
    ClaudeAllowedTools,
    ClaudeDisallowedTools,
    GeminiSettings,
    GeminiToolsProfile,
}

#[derive(Debug, Clone)]
struct StudioState {
    resolved: ResolvedArgs,
    prompt: String,
    menu_index: usize,
    focus: Pane,
    pane_order: Vec<Pane>,
    setting_index: usize,
    capability_index: usize,
    linear_index: usize,
    result_index: usize,
    last_result: Option<CouncilResult>,
    last_linear_result: Option<String>,
    status: String,
    input_mode: Option<InputMode>,
    input_buffer: String,
    show_help: bool,
    exit_armed_until: Option<Instant>,
}

enum StudioAction {
    None,
    RunCouncil,
    SocialLogin,
    LinearStatus,
    LinearDeliver,
    Quit,
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self, String> {
        enable_raw_mode().map_err(|error| format!("Failed to enable raw mode: {error}"))?;
        execute!(
            io::stderr(),
            EnterAlternateScreen,
            Hide,
            Clear(ClearType::All)
        )
        .map_err(|error| format!("Failed to enter Studio screen: {error}"))?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            io::stderr(),
            Show,
            LeaveAlternateScreen,
            Clear(ClearType::All)
        );
        let _ = disable_raw_mode();
    }
}

pub(super) fn run_studio(resolved: &ResolvedArgs) -> i32 {
    if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        println!("{}", render_noninteractive_studio_snapshot(resolved));
        return 0;
    }

    let mut state = StudioState {
        resolved: resolved.clone(),
        prompt: resolved.prompt.trim().to_string(),
        menu_index: 0,
        focus: Pane::Menu,
        pane_order: PANES.to_vec(),
        setting_index: 0,
        capability_index: 0,
        linear_index: 0,
        result_index: 0,
        last_result: None,
        last_linear_result: None,
        status: "Ready".to_string(),
        input_mode: None,
        input_buffer: String::new(),
        show_help: false,
        exit_armed_until: None,
    };

    let mut guard = match TerminalGuard::enter() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };

    loop {
        if let Err(error) = draw(&state) {
            drop(guard);
            eprintln!("{error}");
            return 1;
        }
        let event = match event::read() {
            Ok(event) => event,
            Err(error) => {
                drop(guard);
                eprintln!("Failed to read Studio input: {error}");
                return 1;
            }
        };
        let action = match handle_event(&mut state, event) {
            Ok(action) => action,
            Err(error) => {
                state.status = error;
                StudioAction::None
            }
        };
        match action {
            StudioAction::None => {}
            StudioAction::Quit => return 130,
            StudioAction::RunCouncil => {
                run_external_action(&mut guard, || run_council_from_studio(&mut state));
            }
            StudioAction::SocialLogin => {
                run_external_action(&mut guard, || match run_social_login(&state.resolved) {
                    Ok(()) => state.status = "Social login completed".to_string(),
                    Err(error) => state.status = format!("Social login failed: {error}"),
                });
            }
            StudioAction::LinearStatus => {
                run_external_action(&mut guard, || {
                    match linear_delivery::get_linear_status(&state.resolved) {
                        Ok(status) => {
                            state.last_linear_result =
                                Some(linear_delivery::render_linear_status(&status));
                            state.status = "Linear status refreshed".to_string();
                            state.focus = Pane::Linear;
                        }
                        Err(error) => state.status = format!("Linear status failed: {error}"),
                    }
                });
            }
            StudioAction::LinearDeliver => {
                run_external_action(&mut guard, || {
                    state.resolved.raw.deliver_linear = true;
                    match linear_delivery::run_linear_delivery(&state.resolved) {
                        Ok(result) => {
                            state.last_linear_result =
                                Some(linear_delivery::render_linear_delivery_result(&result));
                            state.status = if result.success {
                                "Linear delivery completed".to_string()
                            } else {
                                "Linear delivery needs attention".to_string()
                            };
                            state.focus = Pane::Linear;
                        }
                        Err(error) => state.status = format!("Linear delivery failed: {error}"),
                    }
                });
            }
        }
    }
}

fn run_external_action(guard: &mut TerminalGuard, action: impl FnOnce()) {
    let _ = execute!(io::stderr(), Show, LeaveAlternateScreen);
    let _ = disable_raw_mode();
    action();
    let _ = enable_raw_mode();
    let _ = execute!(
        io::stderr(),
        EnterAlternateScreen,
        Hide,
        Clear(ClearType::All)
    );
    let _ = guard;
}

fn run_council_from_studio(state: &mut StudioState) {
    state.status = "Running council...".to_string();
    let mut resolved = state.resolved.clone();
    resolved.prompt = state.prompt.clone();
    let prompt = match build_prompt_with_context(&resolved) {
        Ok(prompt) => prompt,
        Err(error) => {
            state.status = format!("Prompt context failed: {error}");
            return;
        }
    };
    let result = run_council(&resolved, prompt);
    state.status = if is_success(&result) {
        "Council run completed".to_string()
    } else {
        "Council run needs attention".to_string()
    };
    state.last_result = Some(result);
    state.focus = Pane::Results;
}

fn handle_event(state: &mut StudioState, event: Event) -> Result<StudioAction, String> {
    let Event::Key(key) = event else {
        return Ok(StudioAction::None);
    };
    if let Some(mode) = state.input_mode.clone() {
        return handle_input_event(state, key, mode);
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        let now = Instant::now();
        if state.exit_armed_until.is_some_and(|until| now <= until) {
            return Ok(StudioAction::Quit);
        }
        state.exit_armed_until = Some(now + Duration::from_secs(5));
        state.status = "Press Ctrl+C again within 5s to quit".to_string();
        return Ok(StudioAction::None);
    }
    match key.code {
        KeyCode::Char('q') => {
            state.status = "Press Ctrl+C twice to quit, or Enter on Quit from the menu".to_string();
        }
        KeyCode::Char('?') => state.show_help = !state.show_help,
        KeyCode::Char('r') => return Ok(StudioAction::RunCouncil),
        KeyCode::Tab => cycle_focus(state, 1),
        KeyCode::BackTab => cycle_focus(state, -1),
        KeyCode::Char('[') => move_focused_pane(state, -1),
        KeyCode::Char(']') => move_focused_pane(state, 1),
        KeyCode::Up => move_selection(state, -1),
        KeyCode::Down => move_selection(state, 1),
        KeyCode::Left => adjust_selection(state, -1)?,
        KeyCode::Right => adjust_selection(state, 1)?,
        KeyCode::Enter => return activate_selection(state),
        KeyCode::Esc => state.show_help = false,
        _ => {}
    }
    Ok(StudioAction::None)
}

fn handle_input_event(
    state: &mut StudioState,
    key: KeyEvent,
    mode: InputMode,
) -> Result<StudioAction, String> {
    match key.code {
        KeyCode::Esc => {
            state.input_mode = None;
            state.input_buffer.clear();
            state.status = "Input cancelled".to_string();
        }
        KeyCode::Enter => {
            let value = state.input_buffer.trim().to_string();
            apply_input(state, mode, value);
            state.input_mode = None;
            state.input_buffer.clear();
        }
        KeyCode::Backspace => {
            state.input_buffer.pop();
        }
        KeyCode::Char(ch) => {
            if !key.modifiers.contains(KeyModifiers::CONTROL) {
                state.input_buffer.push(ch);
            }
        }
        _ => {}
    }
    Ok(StudioAction::None)
}

fn apply_input(state: &mut StudioState, mode: InputMode, value: String) {
    match mode {
        InputMode::Prompt => {
            state.prompt = value;
            state.status = "Prompt updated".to_string();
        }
        InputMode::File => {
            if !value.is_empty() {
                state.resolved.raw.files.push(PathBuf::from(value));
                state.status = "Tagged file added".to_string();
            }
        }
        InputMode::Command => {
            if !value.is_empty() {
                state.resolved.raw.commands.push(value);
                state.status = "Prompt command added".to_string();
            }
        }
        InputMode::LinearIssue => set_csv(
            &mut state.resolved.raw.linear_issue,
            value,
            "Linear issue",
            &mut state.status,
        ),
        InputMode::LinearQuery => {
            state.resolved.raw.linear_query = empty_to_none(value);
            state.status = "Linear query updated".to_string();
        }
        InputMode::LinearProject => set_csv(
            &mut state.resolved.raw.linear_project,
            value,
            "Linear project",
            &mut state.status,
        ),
        InputMode::LinearEpic => set_csv(
            &mut state.resolved.raw.linear_epic,
            value,
            "Linear epic",
            &mut state.status,
        ),
        InputMode::LinearTeam => {
            state.resolved.raw.linear_team = empty_to_none(value);
            state.status = "Linear team updated".to_string();
        }
        InputMode::LinearState => {
            state.resolved.raw.linear_state = empty_to_none(value);
            state.status = "Linear state updated".to_string();
        }
        InputMode::LinearMedia => set_csv(
            &mut state.resolved.raw.linear_attach_media,
            value,
            "Linear media",
            &mut state.status,
        ),
        InputMode::CodexConfig => set_csv(
            &mut state.resolved.raw.codex_config,
            value,
            "Codex config",
            &mut state.status,
        ),
        InputMode::CodexProfile => {
            state.resolved.raw.codex_mcp_profile = empty_to_none(value);
            state.status = "Codex MCP profile updated".to_string();
        }
        InputMode::ClaudeMcpConfig => set_csv(
            &mut state.resolved.raw.claude_mcp_config,
            value,
            "Claude MCP config",
            &mut state.status,
        ),
        InputMode::ClaudeAllowedTools => set_csv(
            &mut state.resolved.raw.claude_allowed_tools,
            value,
            "Claude allowed tools",
            &mut state.status,
        ),
        InputMode::ClaudeDisallowedTools => set_csv(
            &mut state.resolved.raw.claude_disallowed_tools,
            value,
            "Claude disallowed tools",
            &mut state.status,
        ),
        InputMode::GeminiSettings => {
            state.resolved.raw.gemini_settings = empty_to_none(value);
            state.status = "Gemini settings updated".to_string();
        }
        InputMode::GeminiToolsProfile => set_csv(
            &mut state.resolved.raw.gemini_tools_profile,
            value,
            "Gemini tools profile",
            &mut state.status,
        ),
    }
}

fn set_csv(target: &mut Vec<String>, value: String, label: &str, status: &mut String) {
    *target = value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect();
    *status = format!("{label} updated");
}

fn empty_to_none(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn cycle_focus(state: &mut StudioState, delta: isize) {
    let current = state
        .pane_order
        .iter()
        .position(|pane| *pane == state.focus)
        .unwrap_or(0);
    let next = wrap_index(current, state.pane_order.len(), delta);
    state.focus = state.pane_order[next];
}

fn move_focused_pane(state: &mut StudioState, delta: isize) {
    let Some(index) = state
        .pane_order
        .iter()
        .position(|pane| *pane == state.focus)
    else {
        return;
    };
    let next = wrap_index(index, state.pane_order.len(), delta);
    state.pane_order.swap(index, next);
    state.status = "Pane order changed".to_string();
}

fn move_selection(state: &mut StudioState, delta: isize) {
    match state.focus {
        Pane::Menu => state.menu_index = wrap_index(state.menu_index, MENU.len(), delta),
        Pane::Settings => {
            state.setting_index = wrap_index(state.setting_index, settings_len(), delta)
        }
        Pane::Capabilities => {
            state.capability_index = wrap_index(state.capability_index, capabilities_len(), delta)
        }
        Pane::Linear => state.linear_index = wrap_index(state.linear_index, linear_len(), delta),
        Pane::Results => {
            state.result_index = wrap_index(state.result_index, result_len(state), delta)
        }
        Pane::Agents => {}
    }
}

fn adjust_selection(state: &mut StudioState, delta: isize) -> Result<(), String> {
    match state.focus {
        Pane::Settings => adjust_setting(state, delta),
        Pane::Capabilities => adjust_capability(state, delta),
        Pane::Linear => adjust_linear(state, delta),
        Pane::Menu | Pane::Agents | Pane::Results => Ok(()),
    }
}

fn activate_selection(state: &mut StudioState) -> Result<StudioAction, String> {
    match state.focus {
        Pane::Menu => activate_menu(state),
        Pane::Settings => {
            adjust_setting(state, 1)?;
            Ok(StudioAction::None)
        }
        Pane::Capabilities => activate_capability(state),
        Pane::Linear => activate_linear(state),
        Pane::Agents | Pane::Results => Ok(StudioAction::None),
    }
}

fn activate_menu(state: &mut StudioState) -> Result<StudioAction, String> {
    match MENU[state.menu_index] {
        "Run / re-run" => Ok(StudioAction::RunCouncil),
        "Edit prompt" => start_input(state, InputMode::Prompt, state.prompt.clone()),
        "Social login" => Ok(StudioAction::SocialLogin),
        "Linear status" => Ok(StudioAction::LinearStatus),
        "Deliver Linear" => Ok(StudioAction::LinearDeliver),
        "Tag local file" => start_input(state, InputMode::File, String::new()),
        "Run command" => start_input(state, InputMode::Command, String::new()),
        "Settings" => {
            state.focus = Pane::Settings;
            Ok(StudioAction::None)
        }
        "Agents" => {
            state.focus = Pane::Agents;
            Ok(StudioAction::None)
        }
        "Capabilities" => {
            state.focus = Pane::Capabilities;
            Ok(StudioAction::None)
        }
        "Linear" => {
            state.focus = Pane::Linear;
            Ok(StudioAction::None)
        }
        "Help" => {
            state.show_help = !state.show_help;
            Ok(StudioAction::None)
        }
        _ => Ok(StudioAction::None),
    }
}

fn activate_capability(state: &mut StudioState) -> Result<StudioAction, String> {
    match state.capability_index {
        1 => start_input(
            state,
            InputMode::CodexConfig,
            state.resolved.raw.codex_config.join(","),
        ),
        2 => start_input(
            state,
            InputMode::CodexProfile,
            state
                .resolved
                .raw
                .codex_mcp_profile
                .clone()
                .unwrap_or_default(),
        ),
        4 => start_input(
            state,
            InputMode::ClaudeMcpConfig,
            state.resolved.raw.claude_mcp_config.join(","),
        ),
        5 => start_input(
            state,
            InputMode::ClaudeAllowedTools,
            state.resolved.raw.claude_allowed_tools.join(","),
        ),
        6 => start_input(
            state,
            InputMode::ClaudeDisallowedTools,
            state.resolved.raw.claude_disallowed_tools.join(","),
        ),
        8 => start_input(
            state,
            InputMode::GeminiSettings,
            state
                .resolved
                .raw
                .gemini_settings
                .clone()
                .unwrap_or_default(),
        ),
        9 => start_input(
            state,
            InputMode::GeminiToolsProfile,
            state.resolved.raw.gemini_tools_profile.join(","),
        ),
        _ => {
            adjust_capability(state, 1)?;
            Ok(StudioAction::None)
        }
    }
}

fn activate_linear(state: &mut StudioState) -> Result<StudioAction, String> {
    match state.linear_index {
        2 => start_input(
            state,
            InputMode::LinearIssue,
            state.resolved.raw.linear_issue.join(","),
        ),
        3 => start_input(
            state,
            InputMode::LinearQuery,
            state.resolved.raw.linear_query.clone().unwrap_or_default(),
        ),
        4 => start_input(
            state,
            InputMode::LinearProject,
            state.resolved.raw.linear_project.join(","),
        ),
        5 => start_input(
            state,
            InputMode::LinearEpic,
            state.resolved.raw.linear_epic.join(","),
        ),
        6 => start_input(
            state,
            InputMode::LinearTeam,
            state.resolved.raw.linear_team.clone().unwrap_or_default(),
        ),
        7 => start_input(
            state,
            InputMode::LinearState,
            state.resolved.raw.linear_state.clone().unwrap_or_default(),
        ),
        10 => start_input(
            state,
            InputMode::LinearMedia,
            state.resolved.raw.linear_attach_media.join(","),
        ),
        11 => Ok(StudioAction::LinearStatus),
        12 => Ok(StudioAction::LinearDeliver),
        _ => {
            adjust_linear(state, 1)?;
            Ok(StudioAction::None)
        }
    }
}

fn start_input(
    state: &mut StudioState,
    mode: InputMode,
    initial: String,
) -> Result<StudioAction, String> {
    state.input_mode = Some(mode);
    state.input_buffer = initial;
    state.status = "Editing value; Enter saves, Esc cancels".to_string();
    Ok(StudioAction::None)
}

fn adjust_setting(state: &mut StudioState, delta: isize) -> Result<(), String> {
    match state.setting_index {
        0 => state.resolved.raw.handoff = !state.resolved.raw.handoff,
        1 => {
            state.resolved.raw.lead = cycle_optional_engine(
                state.resolved.raw.lead.as_deref(),
                &state.resolved.members,
                delta,
            )
        }
        2 => {
            state.resolved.raw.planner = cycle_optional_engine(
                state.resolved.raw.planner.as_deref(),
                &state.resolved.members,
                delta,
            )
        }
        3 => {
            state.resolved.raw.summarizer = cycle_summarizer(&state.resolved.raw.summarizer, delta)
        }
        4 => {
            state.resolved.raw.iterations =
                adjust_number(state.resolved.raw.iterations, delta, 1, 99)
        }
        5 => {
            state.resolved.raw.team_work = adjust_number(state.resolved.raw.team_work, delta, 0, 64)
        }
        6 => {
            state.resolved.raw.codex_sandbox = cycle_value(
                &state.resolved.raw.codex_sandbox,
                &["read-only", "workspace-write", "danger-full-access"],
                delta,
            )
        }
        7 => {
            state.resolved.raw.claude_permission_mode = cycle_value(
                &state.resolved.raw.claude_permission_mode,
                &[
                    "plan",
                    "default",
                    "acceptEdits",
                    "auto",
                    "dontAsk",
                    "bypassPermissions",
                ],
                delta,
            )
        }
        8 => {
            state.resolved.raw.codex_auth = cycle_value(
                &state.resolved.raw.codex_auth,
                &["auto", "social-login", "login", "api-key"],
                delta,
            )
        }
        9 => {
            state.resolved.raw.claude_auth = cycle_value(
                &state.resolved.raw.claude_auth,
                &["auto", "social-login", "oauth", "api-key", "keychain"],
                delta,
            )
        }
        10 => {
            state.resolved.raw.gemini_auth = cycle_value(
                &state.resolved.raw.gemini_auth,
                &["auto", "social-login", "login", "api-key"],
                delta,
            )
        }
        11 => {
            state.resolved.raw.codex_effort = cycle_optional(
                &state.resolved.raw.codex_effort,
                &["low", "medium", "high", "xhigh"],
                delta,
            )
        }
        12 => {
            state.resolved.raw.claude_effort = cycle_optional(
                &state.resolved.raw.claude_effort,
                &["low", "medium", "high", "xhigh", "max"],
                delta,
            )
        }
        13 => {
            state.resolved.raw.gemini_effort = cycle_optional(
                &state.resolved.raw.gemini_effort,
                &["low", "medium", "high"],
                delta,
            )
        }
        _ => {}
    }
    state.status = "Setting updated".to_string();
    Ok(())
}

fn adjust_capability(state: &mut StudioState, delta: isize) -> Result<(), String> {
    match state.capability_index {
        0 => {
            state.resolved.raw.codex_capabilities = cycle_value(
                &state.resolved.raw.codex_capabilities,
                &["inherit", "override"],
                delta,
            )
        }
        3 => {
            state.resolved.raw.claude_capabilities = cycle_value(
                &state.resolved.raw.claude_capabilities,
                &["inherit", "override"],
                delta,
            )
        }
        7 => {
            state.resolved.raw.gemini_capabilities = cycle_value(
                &state.resolved.raw.gemini_capabilities,
                &["inherit", "override"],
                delta,
            )
        }
        _ => {}
    }
    state.status = "Capability setting updated".to_string();
    Ok(())
}

fn adjust_linear(state: &mut StudioState, delta: isize) -> Result<(), String> {
    match state.linear_index {
        0 => {
            let current = if state.resolved.raw.linear_watch {
                "watch"
            } else if state.resolved.raw.deliver_linear {
                "deliver"
            } else {
                "off"
            };
            match cycle_value(current, &["off", "deliver", "watch"], delta).as_str() {
                "watch" => {
                    state.resolved.raw.deliver_linear = true;
                    state.resolved.raw.linear_watch = true;
                }
                "deliver" => {
                    state.resolved.raw.deliver_linear = true;
                    state.resolved.raw.linear_watch = false;
                }
                _ => {
                    state.resolved.raw.deliver_linear = false;
                    state.resolved.raw.linear_watch = false;
                }
            }
        }
        1 => {
            state.resolved.raw.linear_auth = cycle_value(
                &state.resolved.raw.linear_auth,
                &["api-key", "oauth"],
                delta,
            )
        }
        8 => {
            state.resolved.raw.linear_completion_gate = cycle_value(
                &state.resolved.raw.linear_completion_gate,
                &["delivered", "human-review", "ci-success", "review-or-ci"],
                delta,
            )
        }
        9 => {
            state.resolved.raw.linear_workspace_strategy = cycle_value(
                &state.resolved.raw.linear_workspace_strategy,
                &["worktree", "copy", "none"],
                delta,
            )
        }
        _ => {}
    }
    state.status = "Linear setting updated".to_string();
    Ok(())
}

fn draw(state: &StudioState) -> Result<(), String> {
    let (width, height) = terminal::size().unwrap_or((140, 40));
    let width = width.max(100) as usize;
    let height = height.max(28) as usize;
    let mut out = io::stderr();
    execute!(out, MoveTo(0, 0), Clear(ClearType::All))
        .map_err(|error| format!("Failed to draw Studio: {error}"))?;

    let header = format!(
        "Council Studio | members {} | lead {} | planner {} | handoff {} | {}x",
        state.resolved.members.join(","),
        state.resolved.raw.lead.as_deref().unwrap_or("auto"),
        state.resolved.raw.planner.as_deref().unwrap_or("none"),
        if state.resolved.raw.handoff {
            "on"
        } else {
            "off"
        },
        state.resolved.raw.iterations
    );
    writeln!(out, "{header}").map_err(|error| error.to_string())?;
    writeln!(out, "{}", state.status).map_err(|error| error.to_string())?;
    writeln!(out).map_err(|error| error.to_string())?;

    let col_width = (width - 4) / 3;
    let top_height = (height.saturating_sub(9)) / 2;
    let bottom_height = height.saturating_sub(top_height + 8).max(8);
    let panes = state.pane_order.clone();
    let top = panes.iter().take(3).copied().collect::<Vec<_>>();
    let bottom = panes.iter().skip(3).take(3).copied().collect::<Vec<_>>();
    write_row(&mut out, state, &top, col_width, top_height)?;
    write_row(&mut out, state, &bottom, col_width, bottom_height)?;
    write_prompt(&mut out, state, width)?;
    if state.show_help {
        write_help(&mut out)?;
    }
    out.flush().map_err(|error| error.to_string())
}

fn write_row(
    out: &mut impl Write,
    state: &StudioState,
    panes: &[Pane],
    width: usize,
    height: usize,
) -> Result<(), String> {
    let rendered = panes
        .iter()
        .map(|pane| render_pane(state, *pane, width, height))
        .collect::<Vec<_>>();
    for line in 0..height {
        for pane in &rendered {
            write!(out, "{} ", pane.get(line).cloned().unwrap_or_default())
                .map_err(|error| error.to_string())?;
        }
        writeln!(out).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn render_pane(state: &StudioState, pane: Pane, width: usize, height: usize) -> Vec<String> {
    let (title, lines) = match pane {
        Pane::Menu => ("Command Palette", menu_lines(state)),
        Pane::Settings => ("Settings", settings_lines(state)),
        Pane::Agents => ("Agents", agent_lines(state)),
        Pane::Capabilities => ("Capabilities", capability_lines(state)),
        Pane::Linear => ("Linear", linear_lines(state)),
        Pane::Results => ("Results", result_lines(state)),
    };
    boxed_lines(
        &format!("{}{}", if state.focus == pane { "* " } else { "" }, title),
        &lines,
        width,
        height,
    )
}

fn menu_lines(state: &StudioState) -> Vec<String> {
    MENU.iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "{} {}",
                if state.focus == Pane::Menu && index == state.menu_index {
                    ">"
                } else {
                    " "
                },
                item
            )
        })
        .collect()
}

fn settings_lines(state: &StudioState) -> Vec<String> {
    select_lines(
        state.focus == Pane::Settings,
        state.setting_index,
        vec![
            format!("Handoff: {}", on_off(state.resolved.raw.handoff)),
            format!(
                "Lead: {}",
                state.resolved.raw.lead.as_deref().unwrap_or("auto")
            ),
            format!(
                "Planner: {}",
                state.resolved.raw.planner.as_deref().unwrap_or("none")
            ),
            format!("Summarizer: {}", state.resolved.raw.summarizer),
            format!("Iterations: {}", state.resolved.raw.iterations),
            format!("Team default: {}", state.resolved.raw.team_work),
            format!("Codex sandbox: {}", state.resolved.raw.codex_sandbox),
            format!(
                "Claude permission: {}",
                state.resolved.raw.claude_permission_mode
            ),
            format!("Codex auth: {}", state.resolved.raw.codex_auth),
            format!("Claude auth: {}", state.resolved.raw.claude_auth),
            format!("Gemini auth: {}", state.resolved.raw.gemini_auth),
            format!("Codex effort: {}", opt(&state.resolved.raw.codex_effort)),
            format!("Claude effort: {}", opt(&state.resolved.raw.claude_effort)),
            format!("Gemini effort: {}", opt(&state.resolved.raw.gemini_effort)),
        ],
    )
}

fn agent_lines(state: &StudioState) -> Vec<String> {
    let mut lines = Vec::new();
    let workflow = build_workflow(&state.resolved);
    for member in &state.resolved.members {
        let usage = state.last_result.as_ref().and_then(|result| {
            result
                .members
                .iter()
                .find(|candidate| &candidate.name == member)
                .map(|candidate| {
                    format!(
                        " tokens:{} cmd:{}",
                        candidate.token_usage.total,
                        truncate(&candidate.command, 42).replace('\n', " ")
                    )
                })
        });
        lines.push(format!(
            "[x] {} role:{} team:{} auth:{}{}",
            member,
            state
                .last_result
                .as_ref()
                .and_then(|result| result
                    .members
                    .iter()
                    .find(|candidate| &candidate.name == member))
                .map(|candidate| candidate.role.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| role_for(member, &workflow)),
            workflow.teams.get(member).copied().unwrap_or_default(),
            provider_auth(&state.resolved, member),
            usage.unwrap_or_default()
        ));
    }
    if let Some(result) = &state.last_result {
        lines.push(format!(
            "Summary: {} tokens:{}",
            result.summary.status, result.summary.token_usage.total
        ));
    }
    lines
}

fn capability_lines(state: &StudioState) -> Vec<String> {
    select_lines(
        state.focus == Pane::Capabilities,
        state.capability_index,
        vec![
            format!("Codex mode: {}", state.resolved.raw.codex_capabilities),
            format!("Codex config: {}", list(&state.resolved.raw.codex_config)),
            format!(
                "Codex MCP profile: {}",
                state
                    .resolved
                    .raw
                    .codex_mcp_profile
                    .as_deref()
                    .unwrap_or("none")
            ),
            format!("Claude mode: {}", state.resolved.raw.claude_capabilities),
            format!(
                "Claude MCP: {}",
                list(&state.resolved.raw.claude_mcp_config)
            ),
            format!(
                "Claude allowed: {}",
                list(&state.resolved.raw.claude_allowed_tools)
            ),
            format!(
                "Claude disallowed: {}",
                list(&state.resolved.raw.claude_disallowed_tools)
            ),
            format!("Gemini mode: {}", state.resolved.raw.gemini_capabilities),
            format!(
                "Gemini settings: {}",
                state
                    .resolved
                    .raw
                    .gemini_settings
                    .as_deref()
                    .unwrap_or("none")
            ),
            format!(
                "Gemini tools: {}",
                list(&state.resolved.raw.gemini_tools_profile)
            ),
        ],
    )
}

fn linear_lines(state: &StudioState) -> Vec<String> {
    let mode = if state.resolved.raw.linear_watch {
        "watch"
    } else if state.resolved.raw.deliver_linear {
        "deliver"
    } else {
        "off"
    };
    let mut lines = select_lines(
        state.focus == Pane::Linear,
        state.linear_index,
        vec![
            format!("Mode: {mode}"),
            format!("Auth: {}", state.resolved.raw.linear_auth),
            format!("Issues: {}", list(&state.resolved.raw.linear_issue)),
            format!(
                "Query: {}",
                state.resolved.raw.linear_query.as_deref().unwrap_or("none")
            ),
            format!("Projects: {}", list(&state.resolved.raw.linear_project)),
            format!("Epics: {}", list(&state.resolved.raw.linear_epic)),
            format!(
                "Team: {}",
                state.resolved.raw.linear_team.as_deref().unwrap_or("any")
            ),
            format!(
                "State: {}",
                state.resolved.raw.linear_state.as_deref().unwrap_or("any")
            ),
            format!("Gate: {}", state.resolved.raw.linear_completion_gate),
            format!(
                "Workspace: {}",
                state.resolved.raw.linear_workspace_strategy
            ),
            format!(
                "Attach media: {}",
                list(&state.resolved.raw.linear_attach_media)
            ),
            "Refresh status".to_string(),
            "Deliver now".to_string(),
        ],
    );
    if let Some(result) = &state.last_linear_result {
        lines.extend(result.lines().take(6).map(ToString::to_string));
    }
    lines
}

fn result_lines(state: &StudioState) -> Vec<String> {
    let Some(result) = &state.last_result else {
        return vec!["No run yet".to_string()];
    };
    let mut lines = result
        .members
        .iter()
        .map(|member| {
            format!(
                "{} [{}] role:{} tokens:{}",
                member.name, member.status, member.role, member.token_usage.total
            )
        })
        .collect::<Vec<_>>();
    lines.push(format!(
        "Synthesis [{}] via {} tokens:{}",
        result.summary.status, result.summary.name, result.summary.token_usage.total
    ));
    if !result.summary.output.trim().is_empty() {
        lines.push(String::new());
        lines.extend(
            result
                .summary
                .output
                .lines()
                .take(10)
                .map(ToString::to_string),
        );
    } else if !result.summary.detail.trim().is_empty() {
        lines.push(result.summary.detail.clone());
    }
    lines
}

fn boxed_lines(title: &str, lines: &[String], width: usize, height: usize) -> Vec<String> {
    let inner = width.saturating_sub(4).max(10);
    let mut out = Vec::new();
    out.push(format!("+-- {:<inner$}+", truncate(title, inner)));
    for line in lines.iter().take(height.saturating_sub(2)) {
        out.push(format!("| {:<inner$} |", truncate(line, inner)));
    }
    while out.len() < height.saturating_sub(1) {
        out.push(format!("| {:<inner$} |", ""));
    }
    out.push(format!("+{}+", "-".repeat(inner + 2)));
    out
}

fn write_prompt(out: &mut impl Write, state: &StudioState, width: usize) -> Result<(), String> {
    let prompt = if state.prompt.trim().is_empty() {
        "(empty prompt)"
    } else {
        state.prompt.trim()
    };
    let context = format!(
        "files:{} commands:{}",
        state.resolved.raw.files.len(),
        state.resolved.raw.commands.len()
    );
    writeln!(out, "{}", "-".repeat(width)).map_err(|error| error.to_string())?;
    writeln!(out, "Prompt | {context}").map_err(|error| error.to_string())?;
    writeln!(out, "{}", truncate(prompt, width.saturating_sub(1)))
        .map_err(|error| error.to_string())?;
    if let Some(mode) = &state.input_mode {
        writeln!(
            out,
            "Editing {:?}: {}_",
            mode,
            truncate(&state.input_buffer, width.saturating_sub(20))
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_help(out: &mut impl Write) -> Result<(), String> {
    let lines = [
        "",
        "Help: Tab focus | Up/Down select | Left/Right modify | Enter activate/edit",
        "r run | ? help | [ and ] move focused pane | Ctrl+C twice quits",
        "Menu actions support prompt editing, file tagging, command context, auth, Linear status, and Linear delivery.",
    ];
    for line in lines {
        writeln!(out, "{line}").map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn render_noninteractive_studio_snapshot(resolved: &ResolvedArgs) -> String {
    [
        "Council Studio requires an interactive TTY.",
        "Native Studio is available from a terminal with --studio.",
        "",
        "Current setup:",
        &format!("- members: {}", resolved.members.join(",")),
        &format!("- lead: {}", resolved.raw.lead.as_deref().unwrap_or("auto")),
        &format!(
            "- planner: {}",
            resolved.raw.planner.as_deref().unwrap_or("none")
        ),
        &format!("- iterations: {}", resolved.raw.iterations),
        &format!("- handoff: {}", on_off(resolved.raw.handoff)),
    ]
    .join("\n")
}

fn select_lines(focused: bool, selected: usize, lines: Vec<String>) -> Vec<String> {
    lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            format!(
                "{} {}",
                if focused && index == selected {
                    ">"
                } else {
                    " "
                },
                line
            )
        })
        .collect()
}

fn wrap_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let len = len as isize;
    (current as isize + delta).rem_euclid(len) as usize
}

fn adjust_number(value: usize, delta: isize, min: usize, max: usize) -> usize {
    (value as isize + delta).clamp(min as isize, max as isize) as usize
}

fn cycle_value(current: &str, values: &[&str], delta: isize) -> String {
    let index = values
        .iter()
        .position(|value| *value == current)
        .unwrap_or(0);
    values[wrap_index(index, values.len(), delta)].to_string()
}

fn cycle_optional(current: &Option<String>, values: &[&str], delta: isize) -> Option<String> {
    let mut all = vec!["none"];
    all.extend(values.iter().copied());
    let current = current.as_deref().unwrap_or("none");
    let next = cycle_value(current, &all, delta);
    (next != "none").then_some(next)
}

fn cycle_optional_engine(
    current: Option<&str>,
    members: &[String],
    delta: isize,
) -> Option<String> {
    let mut values = vec!["none".to_string()];
    values.extend(members.iter().cloned());
    let index = values
        .iter()
        .position(|value| current == Some(value.as_str()))
        .unwrap_or(0);
    let next = values[wrap_index(index, values.len(), delta)].clone();
    (next != "none").then_some(next)
}

fn cycle_summarizer(current: &str, delta: isize) -> String {
    cycle_value(current, &["auto", "codex", "claude", "gemini"], delta)
}

fn settings_len() -> usize {
    14
}

fn capabilities_len() -> usize {
    10
}

fn linear_len() -> usize {
    13
}

fn result_len(state: &StudioState) -> usize {
    state
        .last_result
        .as_ref()
        .map(|result| result.members.len() + 2)
        .unwrap_or(1)
}

fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

fn opt(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("none")
}

fn list(values: &[String]) -> String {
    if values.is_empty() {
        "none".to_string()
    } else {
        values.join(",")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycles_values_wrapping() {
        assert_eq!(cycle_value("auto", &["auto", "oauth"], 1), "oauth");
        assert_eq!(cycle_value("auto", &["auto", "oauth"], -1), "oauth");
    }

    #[test]
    fn renders_noninteractive_snapshot() {
        let args = CliArgs::try_parse_from(["council", "--studio", "hello"]).unwrap();
        let resolved = resolve_args(args).unwrap();
        let snapshot = render_noninteractive_studio_snapshot(&resolved);
        assert!(snapshot.contains("Native Studio is available"));
        assert!(snapshot.contains("members: codex,claude,gemini"));
    }
}
