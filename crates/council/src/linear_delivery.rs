use super::*;
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map};

const DEFAULT_LINEAR_ENDPOINT: &str = "https://api.linear.app/graphql";
const DEFAULT_BRANCH_PREFIX: &str = "council/linear/";
const DEFAULT_WORKFLOW_FILE: &str = "WORKFLOW.md";
const DEFAULT_MAX_ATTEMPTS: usize = 3;
const DEFAULT_POLL_INTERVAL_MS: u64 = 60_000;
const DEFAULT_DELIVERY_PHASES: [&str; 4] = ["plan", "implement", "verify", "ship"];
const TERMINAL_STATUSES: [&str; 3] = ["delivered", "review_ready", "ci_passed"];

#[derive(Debug, Clone, Serialize)]
pub(super) struct LinearDeliveryResult {
    provider: String,
    pub(super) success: bool,
    duration_ms: u128,
    issue_count: usize,
    phases: Vec<String>,
    watch: bool,
    poll_count: usize,
    until_complete: bool,
    completion_gate: String,
    state_file: String,
    workspace_root: String,
    observability_log: String,
    polls: Vec<DeliveryPollResult>,
    issues: Vec<IssueDeliveryResult>,
}

#[derive(Debug, Clone, Serialize)]
struct DeliveryPollResult {
    poll: usize,
    fetched: usize,
    dispatched: usize,
    skipped: usize,
    complete: bool,
    issues: Vec<IssueDeliveryResult>,
}

#[derive(Debug, Clone, Serialize)]
struct IssueDeliveryResult {
    issue: LinearIssue,
    success: bool,
    status: String,
    workspace: IssueWorkspace,
    attempts: usize,
    next_retry_at: Option<String>,
    completion: CompletionResult,
    phases: Vec<PhaseDeliveryResult>,
    media_attachments: Vec<MediaAttachmentResult>,
    comments: Vec<LinearCommentResult>,
    state_update: Option<StateUpdateResult>,
}

#[derive(Debug, Clone, Serialize)]
struct PhaseDeliveryResult {
    phase: String,
    summary_status: String,
    summarizer: String,
    output: String,
}

#[derive(Debug, Clone, Serialize)]
struct CompletionResult {
    success: bool,
    status: String,
    gate: String,
    detail: String,
    pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct MediaAttachmentResult {
    source: String,
    url: Option<String>,
    attachment_id: Option<String>,
    title: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LinearCommentResult {
    id: Option<String>,
    url: Option<String>,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct StateUpdateResult {
    state: String,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DeliveryState {
    version: usize,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    issues: HashMap<String, IssueDeliveryState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct IssueDeliveryState {
    #[serde(rename = "issueId")]
    issue_id: String,
    identifier: String,
    title: String,
    url: Option<String>,
    project: Option<LinearEntity>,
    epic: Option<LinearEntity>,
    status: String,
    attempts: usize,
    workspace: Option<String>,
    #[serde(rename = "workspaceStrategy")]
    workspace_strategy: Option<String>,
    branch: Option<String>,
    phases: Vec<PhaseState>,
    #[serde(rename = "lastAttemptAt")]
    last_attempt_at: Option<String>,
    #[serde(rename = "nextRetryAt")]
    next_retry_at: Option<String>,
    #[serde(rename = "lastError")]
    last_error: Option<String>,
    #[serde(rename = "completedAt")]
    completed_at: Option<String>,
    #[serde(rename = "deliveredAt")]
    delivered_at: Option<String>,
    #[serde(rename = "reviewReadyAt")]
    review_ready_at: Option<String>,
    #[serde(rename = "ciPassedAt")]
    ci_passed_at: Option<String>,
    #[serde(rename = "completionGate")]
    completion_gate: Option<String>,
    #[serde(rename = "completionDetail")]
    completion_detail: Option<String>,
    #[serde(rename = "prUrl")]
    pr_url: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PhaseState {
    phase: String,
    status: String,
    summarizer: Option<String>,
    #[serde(rename = "completedAt")]
    completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct LinearStatus {
    configured: bool,
    auth_method: String,
    endpoint: String,
    api_key_env: String,
    oauth_token_env: String,
    viewer: Option<LinearViewer>,
    auth_error: Option<String>,
    state_file: String,
    workspace_root: String,
    observability_log: String,
    counts: DeliveryCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LinearViewer {
    id: Option<String>,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
struct DeliveryCounts {
    total: usize,
    delivered: usize,
    review_ready: usize,
    ci_passed: usize,
    running: usize,
    retry_wait: usize,
    failed: usize,
    ineligible: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LinearIssue {
    id: String,
    identifier: String,
    title: String,
    description: String,
    priority: Option<i64>,
    url: Option<String>,
    #[serde(rename = "branchName")]
    branch_name: Option<String>,
    project: Option<LinearEntity>,
    epic: Option<LinearEntity>,
    state: Option<String>,
    team: Option<String>,
    assignee: Option<String>,
    labels: Vec<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LinearEntity {
    id: Option<String>,
    name: Option<String>,
    slug: Option<String>,
    identifier: Option<String>,
    title: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct IssueWorkspace {
    cwd: String,
    strategy: String,
    branch: Option<String>,
}

#[derive(Debug, Clone)]
struct DeliveryPaths {
    state_file: PathBuf,
    workspace_root: PathBuf,
    observability_dir: PathBuf,
    events_file: PathBuf,
}

#[derive(Debug, Clone)]
struct DeliveryEventContext {
    paths: DeliveryPaths,
}

struct DeliveryRunContext<'a> {
    resolved: &'a ResolvedArgs,
    auth: &'a str,
    phases: &'a [String],
    workflow_policy: &'a str,
    events: &'a DeliveryEventContext,
    completion_gate: &'a str,
}

pub(super) fn get_linear_status(resolved: &ResolvedArgs) -> Result<LinearStatus, String> {
    let paths = resolve_delivery_paths(resolved);
    let auth = resolve_linear_authorization(resolved, true)?;
    let state = load_delivery_state(&paths.state_file);
    let mut viewer = None;
    let mut auth_error = None;

    if let Some(auth) = auth.as_ref() {
        match fetch_linear_viewer(auth) {
            Ok(value) => viewer = value,
            Err(error) => auth_error = Some(error),
        }
    }

    Ok(LinearStatus {
        configured: auth.is_some(),
        auth_method: resolved.raw.linear_auth.clone(),
        endpoint: linear_endpoint(),
        api_key_env: resolved.raw.linear_api_key_env.clone(),
        oauth_token_env: resolved.raw.linear_oauth_token_env.clone(),
        viewer,
        auth_error,
        state_file: paths.state_file.display().to_string(),
        workspace_root: paths.workspace_root.display().to_string(),
        observability_log: paths.events_file.display().to_string(),
        counts: summarize_delivery_state(&state),
    })
}

pub(super) fn render_linear_status(status: &LinearStatus) -> String {
    let mut lines = vec![
        "Linear integration status".to_string(),
        format!(
            "Auth: {}",
            if status.configured {
                format!("configured ({})", status.auth_method)
            } else {
                "missing".to_string()
            }
        ),
        format!("Endpoint: {}", status.endpoint),
        format!("State file: {}", status.state_file),
        format!("Workspace root: {}", status.workspace_root),
        format!("Observability log: {}", status.observability_log),
    ];

    if let Some(viewer) = &status.viewer {
        lines.push(format!(
            "Viewer: {}",
            viewer
                .name
                .as_deref()
                .or(viewer.email.as_deref())
                .or(viewer.id.as_deref())
                .unwrap_or("unknown")
        ));
    } else if let Some(error) = &status.auth_error {
        lines.push(format!("Viewer: unavailable ({error})"));
    }

    lines.extend([
        String::new(),
        "Setup".to_string(),
        format!(
            "- API key auth: set {} and use --linear-auth api-key.",
            status.api_key_env
        ),
        format!(
            "- OAuth auth: set {} and use --linear-auth oauth.",
            status.oauth_token_env
        ),
        "- Long-running mode: add --linear-watch with --linear-team/--linear-state filters.".to_string(),
        "- Completion loop: add --linear-until-complete with --linear-project/--linear-epic and a completion gate.".to_string(),
        "- Isolated workspaces are persisted under the workspace root; state and events are written for retry/reconciliation.".to_string(),
        "- Delivery comments are posted back to Linear by default; disable with --no-linear-comments.".to_string(),
        "- Review-state transitions are available with --linear-update-review-state plus --linear-review-state.".to_string(),
        String::new(),
        "Local state".to_string(),
        format!("- total: {}", status.counts.total),
        format!("- delivered: {}", status.counts.delivered),
        format!("- review_ready: {}", status.counts.review_ready),
        format!("- ci_passed: {}", status.counts.ci_passed),
        format!("- running: {}", status.counts.running),
        format!("- retry_wait: {}", status.counts.retry_wait),
        format!("- failed: {}", status.counts.failed),
        format!("- ineligible: {}", status.counts.ineligible),
    ]);

    lines.join("\n")
}

pub(super) fn run_linear_delivery(resolved: &ResolvedArgs) -> Result<LinearDeliveryResult, String> {
    let started = Instant::now();
    let paths = resolve_delivery_paths(resolved);
    let auth = resolve_linear_authorization(resolved, false)?
        .ok_or_else(|| "Linear delivery credentials are missing.".to_string())?;
    let phases = delivery_phases(resolved);
    let mut state = load_delivery_state(&paths.state_file);
    let workflow_policy = read_workflow_policy(resolved);
    let completion_gate = normalize_completion_gate(&resolved.raw.linear_completion_gate);
    let context = DeliveryEventContext {
        paths: paths.clone(),
    };
    let mut poll_results = Vec::new();
    let mut poll_count = 0usize;

    ensure_delivery_dirs(&paths)?;
    emit_event(
        &context,
        "delivery_started",
        json!({
            "provider": "linear",
            "phases": phases,
            "issueIds": resolved.raw.linear_issue,
            "projects": resolved.raw.linear_project,
            "epics": resolved.raw.linear_epic,
            "watch": resolved.raw.linear_watch,
            "untilComplete": resolved.raw.linear_until_complete,
            "completionGate": completion_gate,
            "stateFile": paths.state_file,
            "workspaceRoot": paths.workspace_root,
            "observabilityLog": paths.events_file
        }),
    )?;

    loop {
        poll_count += 1;
        let run_context = DeliveryRunContext {
            resolved,
            auth: &auth,
            phases: &phases,
            workflow_policy: &workflow_policy,
            events: &context,
            completion_gate: &completion_gate,
        };
        let poll = run_linear_delivery_poll(&run_context, &mut state, poll_count)?;
        let complete = poll.complete;
        poll_results.push(poll);

        if resolved.raw.linear_until_complete && complete {
            emit_event(
                &context,
                "delivery_target_completed",
                json!({ "poll": poll_count, "completionGate": completion_gate }),
            )?;
            break;
        }
        if !resolved.raw.linear_watch {
            break;
        }
        let poll_interval = if resolved.raw.linear_poll_interval == 0 {
            DEFAULT_POLL_INTERVAL_MS
        } else {
            resolved.raw.linear_poll_interval.saturating_mul(1000)
        };
        thread::sleep(Duration::from_millis(poll_interval.max(1000)));
    }

    let issues = poll_results
        .iter()
        .flat_map(|poll| poll.issues.iter().cloned())
        .collect::<Vec<_>>();
    let success = if issues.is_empty() {
        resolved.raw.linear_until_complete && poll_results.last().is_some_and(|poll| poll.complete)
    } else {
        issues.iter().all(|issue| issue.success)
    };
    let result = LinearDeliveryResult {
        provider: "linear".to_string(),
        success,
        duration_ms: started.elapsed().as_millis(),
        issue_count: issues.len(),
        phases,
        watch: resolved.raw.linear_watch,
        poll_count,
        until_complete: resolved.raw.linear_until_complete,
        completion_gate,
        state_file: paths.state_file.display().to_string(),
        workspace_root: paths.workspace_root.display().to_string(),
        observability_log: paths.events_file.display().to_string(),
        polls: poll_results,
        issues,
    };

    write_delivery_state(&paths.state_file, &mut state)?;
    emit_event(
        &context,
        "delivery_completed",
        json!({ "success": result.success, "issueCount": result.issue_count }),
    )?;
    Ok(result)
}

fn run_linear_delivery_poll(
    context: &DeliveryRunContext<'_>,
    state: &mut DeliveryState,
    poll: usize,
) -> Result<DeliveryPollResult, String> {
    emit_event(
        context.events,
        "delivery_poll_started",
        json!({ "poll": poll }),
    )?;
    let issues = fetch_linear_issues(context.resolved, context.auth)?;
    reconcile_delivery_state(
        state,
        &issues,
        context.events,
        context.resolved.raw.linear_watch,
    )?;

    let max_attempts = effective_max_attempts(context.resolved);
    let mut eligible = Vec::new();
    for issue in &issues {
        if should_dispatch_issue(issue, state, max_attempts) {
            eligible.push(issue.clone());
        }
        if eligible.len() >= context.resolved.raw.linear_limit.max(1) {
            break;
        }
    }
    let skipped = issues.len().saturating_sub(eligible.len());

    let mut issue_results = Vec::new();
    for issue in eligible {
        issue_results.push(run_linear_issue_delivery(
            context.resolved,
            context.auth,
            context.phases,
            state,
            context.workflow_policy,
            context.events,
            issue,
        )?);
    }
    write_delivery_state(&context.events.paths.state_file, state)?;

    let complete =
        is_delivery_target_complete(context.resolved, &issues, state, context.completion_gate);
    emit_event(
        context.events,
        "delivery_poll_completed",
        json!({
            "poll": poll,
            "fetched": issues.len(),
            "dispatched": issue_results.len(),
            "skipped": skipped,
            "complete": complete
        }),
    )?;
    Ok(DeliveryPollResult {
        poll,
        fetched: issues.len(),
        dispatched: issue_results.len(),
        skipped,
        complete,
        issues: issue_results,
    })
}

fn run_linear_issue_delivery(
    resolved: &ResolvedArgs,
    auth: &str,
    phases: &[String],
    state: &mut DeliveryState,
    workflow_policy: &str,
    context: &DeliveryEventContext,
    issue: LinearIssue,
) -> Result<IssueDeliveryResult, String> {
    {
        let issue_state = ensure_issue_state(state, &issue);
        issue_state.status = "running".to_string();
        issue_state.attempts += 1;
        issue_state.last_attempt_at = Some(now_iso());
        issue_state.next_retry_at = None;
        issue_state.last_error = None;
        issue_state.phases.clear();
    }
    write_delivery_state(&context.paths.state_file, state)?;
    emit_event(
        context,
        "delivery_issue_started",
        json!({ "issue": issue, "attempt": state.issues[&issue.identifier].attempts }),
    )?;

    let workspace = prepare_issue_workspace(resolved, &issue, &context.paths)?;
    {
        let issue_state = ensure_issue_state(state, &issue);
        issue_state.workspace = Some(workspace.cwd.clone());
        issue_state.workspace_strategy = Some(workspace.strategy.clone());
        issue_state.branch = workspace.branch.clone();
    }
    write_delivery_state(&context.paths.state_file, state)?;
    emit_event(
        context,
        "delivery_workspace_prepared",
        json!({ "issue": issue, "workspace": workspace }),
    )?;

    let mut phase_results = Vec::new();
    let mut conversation = Vec::<(String, String)>::new();
    let mut issue_success = true;
    for phase in phases {
        emit_event(
            context,
            "delivery_phase_started",
            json!({ "issue": issue, "phase": phase }),
        )?;
        let mut phase_resolved = resolved.clone();
        phase_resolved.cwd = PathBuf::from(&workspace.cwd);
        phase_resolved.raw.cwd = phase_resolved.cwd.clone();
        phase_resolved.raw.handoff = phase != "plan" || resolved.raw.handoff;
        phase_resolved.raw.planner =
            pick_phase_planner(phase, &resolved.members, resolved.raw.planner.as_deref());
        phase_resolved.raw.lead =
            pick_phase_lead(phase, &resolved.members, resolved.raw.lead.as_deref());
        phase_resolved.prompt =
            build_delivery_phase_prompt(phase, &issue, resolved, &conversation, workflow_policy);
        let prompt_context = build_prompt_context(&phase_resolved)?;
        let result = run_council(
            &phase_resolved,
            prompt_context.prompt,
            prompt_context.commands,
        );
        let summary = result.summary.clone();
        let success = summary.status == "ok";
        let phase_result = PhaseDeliveryResult {
            phase: phase.clone(),
            summary_status: summary.status.clone(),
            summarizer: summary.name.clone(),
            output: summary.output.clone(),
        };
        phase_results.push(phase_result);
        conversation.push((
            phase.clone(),
            if summary.output.trim().is_empty() {
                summary.detail.clone()
            } else {
                summary.output.clone()
            },
        ));
        {
            let issue_state = ensure_issue_state(state, &issue);
            issue_state.phases.push(PhaseState {
                phase: phase.clone(),
                status: summary.status.clone(),
                summarizer: Some(summary.name.clone()),
                completed_at: now_iso(),
            });
            if !success {
                issue_state.last_error = Some(if summary.detail.trim().is_empty() {
                    format!("{phase} failed")
                } else {
                    summary.detail.clone()
                });
            }
        }
        write_delivery_state(&context.paths.state_file, state)?;
        emit_event(
            context,
            "delivery_phase_completed",
            json!({
                "issue": issue,
                "phase": phase,
                "success": success,
                "summaryStatus": summary.status,
                "summarizer": summary.name
            }),
        )?;
        if !success {
            issue_success = false;
            break;
        }
    }

    let mut media_attachments = Vec::new();
    if issue_success {
        for media in &resolved.raw.linear_attach_media {
            match attach_linear_media(resolved, auth, &issue, &workspace, media) {
                Ok(media) => {
                    emit_event(
                        context,
                        "delivery_media_attached",
                        json!({ "issue": issue, "media": media }),
                    )?;
                    media_attachments.push(media);
                }
                Err(error) => {
                    emit_event(
                        context,
                        "delivery_media_attach_failed",
                        json!({ "issue": issue, "media": media, "detail": error }),
                    )?;
                    media_attachments.push(MediaAttachmentResult {
                        source: media.clone(),
                        url: None,
                        attachment_id: None,
                        title: None,
                        error: Some(error),
                    });
                }
            }
        }
    }
    let media_success = media_attachments
        .iter()
        .all(|attachment| attachment.error.is_none());
    let completion = if issue_success && media_success {
        evaluate_completion_gate(resolved, &issue, state, &workspace, &phase_results)
    } else {
        CompletionResult {
            success: false,
            status: "retry_wait".to_string(),
            gate: normalize_completion_gate(&resolved.raw.linear_completion_gate),
            detail: if issue_success {
                "One or more Linear media attachments failed.".to_string()
            } else {
                "One or more delivery phases failed.".to_string()
            },
            pr_url: None,
        }
    };
    let state_update = if completion.success && resolved.raw.linear_update_review_state {
        resolved.raw.linear_review_state.as_ref().map(
            |review_state| match update_linear_issue_state(auth, &issue, review_state) {
                Ok(()) => StateUpdateResult {
                    state: review_state.clone(),
                    status: "ok".to_string(),
                    error: None,
                },
                Err(error) => StateUpdateResult {
                    state: review_state.clone(),
                    status: "error".to_string(),
                    error: Some(error),
                },
            },
        )
    } else {
        None
    };
    if let Some(update) = &state_update {
        emit_event(
            context,
            "delivery_issue_state_update",
            json!({ "issue": issue, "state": update.state, "status": update.status, "error": update.error }),
        )?;
    }
    let mut comments = Vec::new();
    if !resolved.raw.no_linear_comments {
        let body = build_delivery_comment_body(
            &issue,
            &workspace,
            &completion,
            &phase_results,
            &media_attachments,
            state_update.as_ref(),
        );
        match create_linear_comment(auth, &issue.id, &body) {
            Ok(comment) => {
                emit_event(
                    context,
                    "delivery_comment_created",
                    json!({ "issue": issue, "comment": comment }),
                )?;
                comments.push(comment);
            }
            Err(error) => {
                emit_event(
                    context,
                    "delivery_comment_failed",
                    json!({ "issue": issue, "detail": error }),
                )?;
                comments.push(LinearCommentResult {
                    id: None,
                    url: None,
                    status: "error".to_string(),
                    error: Some(error),
                });
            }
        }
    }

    {
        let max_attempts = effective_max_attempts(resolved);
        let issue_state = ensure_issue_state(state, &issue);
        if completion.success {
            issue_state.status = completion.status.clone();
            issue_state.completed_at = Some(now_iso());
            issue_state.completion_gate = Some(completion.gate.clone());
            issue_state.completion_detail = Some(completion.detail.clone());
            issue_state.pr_url = completion
                .pr_url
                .clone()
                .or_else(|| issue_state.pr_url.clone());
            match issue_state.status.as_str() {
                "delivered" => issue_state.delivered_at = issue_state.completed_at.clone(),
                "review_ready" => issue_state.review_ready_at = issue_state.completed_at.clone(),
                "ci_passed" => issue_state.ci_passed_at = issue_state.completed_at.clone(),
                _ => {}
            }
        } else {
            issue_state.last_error = Some(completion.detail.clone());
            schedule_retry(
                issue_state,
                max_attempts,
                resolved
                    .raw
                    .linear_retry_base
                    .saturating_mul(1000)
                    .max(1000),
            );
        }
    }
    write_delivery_state(&context.paths.state_file, state)?;
    let issue_state = state.issues[&issue.identifier].clone();
    emit_event(
        context,
        "delivery_issue_completed",
        json!({
            "issue": issue,
            "success": completion.success,
            "status": issue_state.status,
            "attempts": issue_state.attempts,
            "nextRetryAt": issue_state.next_retry_at
        }),
    )?;

    Ok(IssueDeliveryResult {
        issue,
        success: completion.success,
        status: issue_state.status,
        workspace,
        attempts: issue_state.attempts,
        next_retry_at: issue_state.next_retry_at,
        completion,
        phases: phase_results,
        media_attachments,
        comments,
        state_update,
    })
}

pub(super) fn render_linear_delivery_result(result: &LinearDeliveryResult) -> String {
    let mut lines = vec![
        format!(
            "Linear delivery: {} ({} task{}, {} poll{})",
            if result.success {
                "completed"
            } else {
                "needs attention"
            },
            result.issue_count,
            if result.issue_count == 1 { "" } else { "s" },
            result.poll_count,
            if result.poll_count == 1 { "" } else { "s" }
        ),
        format!("State: {}", result.state_file),
        format!("Workspaces: {}", result.workspace_root),
        format!("Observability: {}", result.observability_log),
        format!("Completion gate: {}", result.completion_gate),
    ];

    for issue in &result.issues {
        lines.push(String::new());
        lines.push(format!(
            "=== {}: {} ===",
            issue.issue.identifier, issue.issue.title
        ));
        lines.push(format!(
            "Status: {}",
            if issue.success {
                issue.status.as_str()
            } else {
                "needs attention"
            }
        ));
        if let Some(url) = &issue.issue.url {
            lines.push(format!("Linear: {url}"));
        }
        lines.push(format!("Workspace: {}", issue.workspace.cwd));
        if let Some(next_retry) = &issue.next_retry_at {
            lines.push(format!("Next retry: {next_retry}"));
        }
        if !issue.completion.detail.trim().is_empty() {
            lines.push(format!("Completion: {}", issue.completion.detail));
        }
        for phase in &issue.phases {
            lines.push(format!(
                "- {}: {} via {}",
                phase.phase, phase.summary_status, phase.summarizer
            ));
        }
        for media in &issue.media_attachments {
            if let Some(error) = &media.error {
                lines.push(format!("- media: failed {} ({error})", media.source));
            } else {
                lines.push(format!(
                    "- media: attached {} -> {}",
                    media.title.as_deref().unwrap_or(&media.source),
                    media.url.as_deref().unwrap_or("unknown")
                ));
            }
        }
        for comment in &issue.comments {
            if let Some(error) = &comment.error {
                lines.push(format!("- linear comment: failed ({error})"));
            } else {
                lines.push(format!(
                    "- linear comment: {}",
                    comment.url.as_deref().unwrap_or("created")
                ));
            }
        }
        if let Some(update) = &issue.state_update {
            lines.push(format!(
                "- linear state: {} ({})",
                update.state, update.status
            ));
        }
    }
    lines.join("\n")
}

fn fetch_linear_viewer(auth: &str) -> Result<Option<LinearViewer>, String> {
    let data = linear_graphql(
        auth,
        "query CouncilLinearViewer { viewer { id name email } }",
        json!({}),
    )?;
    Ok(data
        .get("viewer")
        .and_then(|value| serde_json::from_value::<LinearViewer>(value.clone()).ok()))
}

fn fetch_linear_issues(resolved: &ResolvedArgs, auth: &str) -> Result<Vec<LinearIssue>, String> {
    if !resolved.raw.linear_issue.is_empty() {
        let mut issues = Vec::new();
        for id in &resolved.raw.linear_issue {
            let data = linear_graphql(
                auth,
                &format!(
                    "query CouncilLinearIssue($id: String!) {{ issue(id: $id) {{ {} }} }}",
                    issue_fields()
                ),
                json!({ "id": id }),
            )?;
            if let Some(issue) = data.get("issue").and_then(normalize_linear_issue) {
                issues.push(issue);
            }
        }
        return Ok(issues);
    }

    let mut all = Vec::new();
    let mut after = Value::Null;
    loop {
        let variables = json!({
            "first": resolved.raw.linear_limit.max(1),
            "after": after,
            "filter": build_issue_filter(resolved)
        });
        let data = linear_graphql(
            auth,
            &format!(
                "query CouncilLinearIssues($first: Int!, $after: String, $filter: IssueFilter) {{ issues(first: $first, after: $after, filter: $filter) {{ nodes {{ {} }} pageInfo {{ hasNextPage endCursor }} }} }}",
                issue_fields()
            ),
            variables,
        )?;
        let connection = data.get("issues").cloned().unwrap_or(Value::Null);
        if let Some(nodes) = connection.get("nodes").and_then(Value::as_array) {
            all.extend(nodes.iter().filter_map(normalize_linear_issue));
        }
        let has_next = resolved.raw.linear_until_complete
            && connection
                .pointer("/pageInfo/hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if has_next {
            after = connection
                .pointer("/pageInfo/endCursor")
                .cloned()
                .unwrap_or(Value::Null);
        } else {
            break;
        }
    }
    Ok(all)
}

fn linear_graphql(auth: &str, query: &str, variables: Value) -> Result<Value, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Failed to create Linear HTTP client: {error}"))?;
    let response = client
        .post(linear_endpoint())
        .header("authorization", auth)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .map_err(|error| format!("Linear API request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Linear API request failed with HTTP {status}."));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| format!("Linear API response was not valid JSON: {error}"))?;
    if let Some(errors) = payload.get("errors").and_then(Value::as_array) {
        if !errors.is_empty() {
            let message = errors
                .iter()
                .filter_map(|error| error.get("message").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!(
                "Linear API request failed: {}",
                if message.is_empty() {
                    "Unknown GraphQL error."
                } else {
                    &message
                }
            ));
        }
    }
    Ok(payload.get("data").cloned().unwrap_or(Value::Null))
}

fn issue_fields() -> &'static str {
    "id identifier title description priority url branchName createdAt updatedAt project { id name slug url } parent { id identifier title url } state { name } team { key name } assignee { name email } labels { nodes { name } }"
}

fn build_issue_filter(resolved: &ResolvedArgs) -> Value {
    let mut filter = Map::new();
    if let Some(query) = resolved
        .raw
        .linear_query
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        filter.insert(
            "or".to_string(),
            json!([
                { "identifier": { "eq": query } },
                { "title": { "containsIgnoreCase": query } },
                { "description": { "containsIgnoreCase": query } }
            ]),
        );
    }
    if let Some(team) = resolved
        .raw
        .linear_team
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        filter.insert("team".to_string(), json!({ "key": { "eq": team } }));
    }
    if let Some(state) = resolved
        .raw
        .linear_state
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        filter.insert("state".to_string(), json!({ "name": { "eq": state } }));
    }
    if let Some(assignee) = resolved
        .raw
        .linear_assignee
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        filter.insert(
            "assignee".to_string(),
            json!({ "or": [
                { "name": { "containsIgnoreCase": assignee } },
                { "email": { "containsIgnoreCase": assignee } }
            ] }),
        );
    }
    if let Some(project) = entity_filter(&resolved.raw.linear_project, &["id", "slug"], &["name"]) {
        filter.insert("project".to_string(), project);
    }
    if let Some(epic) = entity_filter(&resolved.raw.linear_epic, &["id", "identifier"], &["title"])
    {
        filter.insert("parent".to_string(), epic);
    }
    if filter.is_empty() {
        Value::Null
    } else {
        Value::Object(filter)
    }
}

fn entity_filter(values: &[String], exact: &[&str], text: &[&str]) -> Option<Value> {
    let mut parts = Vec::new();
    for value in normalize_values(values) {
        for field in exact {
            parts.push(json!({ field.to_string(): { "eq": value } }));
        }
        for field in text {
            parts.push(json!({ field.to_string(): { "containsIgnoreCase": value } }));
        }
    }
    match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(json!({ "or": parts })),
    }
}

fn normalize_linear_issue(value: &Value) -> Option<LinearIssue> {
    Some(LinearIssue {
        id: value.get("id")?.as_str()?.to_string(),
        identifier: value.get("identifier")?.as_str()?.to_string(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        priority: value.get("priority").and_then(Value::as_i64),
        url: string_at(value, "/url"),
        branch_name: string_at(value, "/branchName"),
        project: value.get("project").and_then(normalize_project),
        epic: value.get("parent").and_then(normalize_epic),
        state: string_at(value, "/state/name"),
        team: string_at(value, "/team/key").or_else(|| string_at(value, "/team/name")),
        assignee: string_at(value, "/assignee/name")
            .or_else(|| string_at(value, "/assignee/email")),
        labels: value
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|label| label.get("name").and_then(Value::as_str))
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        created_at: string_at(value, "/createdAt"),
        updated_at: string_at(value, "/updatedAt"),
    })
}

fn normalize_project(value: &Value) -> Option<LinearEntity> {
    Some(LinearEntity {
        id: string_at(value, "/id"),
        name: string_at(value, "/name"),
        slug: string_at(value, "/slug"),
        identifier: None,
        title: None,
        url: string_at(value, "/url"),
    })
}

fn normalize_epic(value: &Value) -> Option<LinearEntity> {
    Some(LinearEntity {
        id: string_at(value, "/id"),
        name: None,
        slug: None,
        identifier: string_at(value, "/identifier"),
        title: string_at(value, "/title"),
        url: string_at(value, "/url"),
    })
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn attach_linear_media(
    resolved: &ResolvedArgs,
    auth: &str,
    issue: &LinearIssue,
    workspace: &IssueWorkspace,
    media: &str,
) -> Result<MediaAttachmentResult, String> {
    let source = media.trim();
    if source.is_empty() {
        return Err("Linear media source is empty.".to_string());
    }
    let is_remote = source.starts_with("http://") || source.starts_with("https://");
    let (url, subtitle) = if is_remote {
        (source.to_string(), "Attached by Council".to_string())
    } else {
        let uploaded = upload_linear_file(auth, &workspace.cwd, source, issue)?;
        (
            uploaded.asset_url,
            format!("Uploaded {}", uploaded.filename),
        )
    };
    let title = resolved
        .raw
        .linear_attachment_title
        .as_ref()
        .map(|prefix| format!("{prefix}: {}", media_title(source)))
        .unwrap_or_else(|| media_title(source));
    let attachment = create_linear_attachment(auth, &issue.id, &title, &url, &subtitle)?;
    Ok(MediaAttachmentResult {
        source: source.to_string(),
        url: Some(url),
        attachment_id: attachment
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        title: attachment
            .get("title")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        error: None,
    })
}

struct UploadedFile {
    filename: String,
    asset_url: String,
}

fn upload_linear_file(
    auth: &str,
    cwd: &str,
    file_path: &str,
    issue: &LinearIssue,
) -> Result<UploadedFile, String> {
    let path = absolutize(Path::new(cwd), Path::new(file_path));
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Failed to read Linear media {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "Linear media path is not a file: {}",
            path.display()
        ));
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment")
        .to_string();
    let content_type = infer_content_type(&filename);
    let data = linear_graphql(
        auth,
        "mutation CouncilLinearFileUpload($contentType: String!, $filename: String!, $size: Int!, $makePublic: Boolean, $metaData: JSON) { fileUpload(contentType: $contentType, filename: $filename, size: $size, makePublic: $makePublic, metaData: $metaData) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
        json!({
            "contentType": content_type,
            "filename": filename,
            "size": metadata.len() as i64,
            "makePublic": false,
            "metaData": { "issueId": issue.id, "source": "council" }
        }),
    )?;
    let upload = data
        .get("fileUpload")
        .ok_or_else(|| "Linear fileUpload did not return a payload.".to_string())?;
    if !upload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Linear fileUpload did not succeed.".to_string());
    }
    let upload_file = upload
        .get("uploadFile")
        .ok_or_else(|| "Linear fileUpload did not return an uploadFile.".to_string())?;
    let upload_url = upload_file
        .get("uploadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear fileUpload did not return uploadUrl.".to_string())?;
    let asset_url = upload_file
        .get("assetUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear fileUpload did not return assetUrl.".to_string())?;
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read Linear media {}: {error}", path.display()))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Failed to create upload client: {error}"))?;
    let mut request = client
        .put(upload_url)
        .header("content-type", content_type)
        .header("cache-control", "public, max-age=31536000");
    if let Some(headers) = upload_file.get("headers").and_then(Value::as_array) {
        for header in headers {
            if let (Some(key), Some(value)) = (
                header.get("key").and_then(Value::as_str),
                header.get("value").and_then(Value::as_str),
            ) {
                request = request.header(key, value);
            }
        }
    }
    let response = request
        .body(bytes)
        .send()
        .map_err(|error| format!("Linear media upload failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Linear media upload failed with HTTP {}.",
            response.status()
        ));
    }
    Ok(UploadedFile {
        filename,
        asset_url: asset_url.to_string(),
    })
}

fn create_linear_attachment(
    auth: &str,
    issue_id: &str,
    title: &str,
    url: &str,
    subtitle: &str,
) -> Result<Value, String> {
    let data = linear_graphql(
        auth,
        "mutation CouncilLinearAttachmentCreate($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id title subtitle url } } }",
        json!({
            "input": {
                "issueId": issue_id,
                "title": title,
                "url": url,
                "subtitle": subtitle,
                "metadata": { "source": "council" }
            }
        }),
    )?;
    let payload = data
        .get("attachmentCreate")
        .ok_or_else(|| "Linear attachmentCreate did not return a payload.".to_string())?;
    if !payload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Linear attachmentCreate did not succeed.".to_string());
    }
    payload
        .get("attachment")
        .cloned()
        .ok_or_else(|| "Linear attachmentCreate did not return an attachment.".to_string())
}

fn create_linear_comment(
    auth: &str,
    issue_id: &str,
    body: &str,
) -> Result<LinearCommentResult, String> {
    let data = linear_graphql(
        auth,
        "mutation CouncilLinearCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
        json!({
            "input": {
                "issueId": issue_id,
                "body": body
            }
        }),
    )?;
    let payload = data
        .get("commentCreate")
        .ok_or_else(|| "Linear commentCreate did not return a payload.".to_string())?;
    if !payload
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Linear commentCreate did not succeed.".to_string());
    }
    let comment = payload.get("comment").cloned().unwrap_or(Value::Null);
    Ok(LinearCommentResult {
        id: comment
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        url: comment
            .get("url")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        status: "ok".to_string(),
        error: None,
    })
}

fn update_linear_issue_state(
    auth: &str,
    issue: &LinearIssue,
    review_state: &str,
) -> Result<(), String> {
    let mut filter = json!({ "name": { "eq": review_state } });
    if let Some(team) = &issue.team {
        filter = json!({
            "and": [
                { "name": { "eq": review_state } },
                { "team": { "key": { "eq": team } } }
            ]
        });
    }
    let data = linear_graphql(
        auth,
        "query CouncilLinearWorkflowState($filter: WorkflowStateFilter) { workflowStates(first: 10, filter: $filter) { nodes { id name } } }",
        json!({ "filter": filter }),
    )?;
    let state_id = data
        .pointer("/workflowStates/nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| nodes.first())
        .and_then(|node| node.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Could not find Linear workflow state `{review_state}`."))?;
    let updated = linear_graphql(
        auth,
        "mutation CouncilLinearIssueState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
        json!({
            "id": issue.id,
            "input": { "stateId": state_id }
        }),
    )?;
    let success = updated
        .pointer("/issueUpdate/success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if success {
        Ok(())
    } else {
        Err("Linear issueUpdate did not succeed.".to_string())
    }
}

fn build_delivery_comment_body(
    issue: &LinearIssue,
    workspace: &IssueWorkspace,
    completion: &CompletionResult,
    phases: &[PhaseDeliveryResult],
    media: &[MediaAttachmentResult],
    state_update: Option<&StateUpdateResult>,
) -> String {
    let mut lines = vec![
        format!("Council delivery update for {}", issue.identifier),
        String::new(),
        format!("Status: {}", completion.status),
        format!("Gate: {}", completion.gate),
        format!("Workspace strategy: {}", workspace.strategy),
    ];
    if let Some(branch) = &workspace.branch {
        lines.push(format!("Branch: {branch}"));
    }
    if let Some(pr_url) = &completion.pr_url {
        lines.push(format!("PR: {pr_url}"));
    }
    if !completion.detail.trim().is_empty() {
        lines.push(format!("Detail: {}", completion.detail));
    }
    lines.push(String::new());
    lines.push("Phases:".to_string());
    for phase in phases {
        lines.push(format!(
            "- {}: {} via {}",
            phase.phase, phase.summary_status, phase.summarizer
        ));
    }
    if !media.is_empty() {
        lines.push(String::new());
        lines.push("Media:".to_string());
        for item in media {
            lines.push(format!(
                "- {}: {}",
                item.source,
                item.error.as_deref().unwrap_or("attached")
            ));
        }
    }
    if let Some(update) = state_update {
        lines.push(String::new());
        lines.push(format!(
            "Review state update: {} ({})",
            update.state, update.status
        ));
    }
    truncate(&lines.join("\n"), 16_000)
}

fn evaluate_completion_gate(
    resolved: &ResolvedArgs,
    issue: &LinearIssue,
    state: &DeliveryState,
    workspace: &IssueWorkspace,
    phases: &[PhaseDeliveryResult],
) -> CompletionResult {
    let gate = normalize_completion_gate(&resolved.raw.linear_completion_gate);
    let pr_url = collect_pr_url(
        issue,
        state.issues.get(&issue.identifier),
        workspace,
        phases,
    );
    if gate == "delivered" {
        return CompletionResult {
            success: true,
            status: "delivered".to_string(),
            gate,
            detail: "All delivery phases completed.".to_string(),
            pr_url,
        };
    }
    if matches!(gate.as_str(), "human-review" | "review-or-ci") {
        if let Some(review_state) = &resolved.raw.linear_review_state {
            if issue
                .state
                .as_deref()
                .is_some_and(|state| same_text(state, review_state))
            {
                return CompletionResult {
                    success: true,
                    status: "review_ready".to_string(),
                    gate,
                    detail: format!("Linear state is {review_state}."),
                    pr_url,
                };
            }
        }
        if let Some(url) = pr_url.as_ref() {
            return CompletionResult {
                success: true,
                status: "review_ready".to_string(),
                gate,
                detail: format!("GitHub PR is ready for review: {url}."),
                pr_url,
            };
        }
        if let Some(branch) = workspace.branch.as_ref() {
            return CompletionResult {
                success: true,
                status: "review_ready".to_string(),
                gate,
                detail: format!("Branch is ready for review: {branch}."),
                pr_url,
            };
        }
    }
    check_github_ci(
        Path::new(&workspace.cwd),
        pr_url
            .clone()
            .or_else(|| workspace.branch.clone())
            .unwrap_or_default(),
        &gate,
        resolved.raw.linear_ci_timeout,
        resolved.raw.linear_ci_poll_interval,
    )
}

fn check_github_ci(
    cwd: &Path,
    selector: String,
    gate: &str,
    timeout_secs: u64,
    poll_secs: u64,
) -> CompletionResult {
    if selector.trim().is_empty() {
        return CompletionResult {
            success: false,
            status: "retry_wait".to_string(),
            gate: gate.to_string(),
            detail: "No GitHub PR URL or branch was found for CI checks.".to_string(),
            pr_url: None,
        };
    }
    let started = Instant::now();
    loop {
        let args = vec![
            "pr".to_string(),
            "checks".to_string(),
            selector.clone(),
            "--json".to_string(),
            "name,bucket,state,workflow,completedAt,link".to_string(),
        ];
        let result = run_command("gh", &args, cwd, None, 120_000, HashMap::new());
        let interpreted = interpret_github_checks(&result, &selector, gate);
        if interpreted.success
            || result.code != Some(8)
            || timeout_secs == 0
            || started.elapsed() >= Duration::from_secs(timeout_secs)
        {
            return interpreted;
        }
        thread::sleep(Duration::from_secs(poll_secs.max(1)));
    }
}

fn interpret_github_checks(result: &CommandResult, selector: &str, gate: &str) -> CompletionResult {
    if result.error.is_some() {
        return CompletionResult {
            success: false,
            status: "retry_wait".to_string(),
            gate: gate.to_string(),
            detail: "GitHub CLI (`gh`) is not installed or not on PATH.".to_string(),
            pr_url: extract_github_pr_url(selector),
        };
    }
    let checks = serde_json::from_str::<Vec<Value>>(&result.stdout).unwrap_or_default();
    if checks.is_empty() {
        return CompletionResult {
            success: false,
            status: "retry_wait".to_string(),
            gate: gate.to_string(),
            detail: compact_failure(result),
            pr_url: extract_github_pr_url(selector),
        };
    }
    let failed = checks
        .iter()
        .filter(|check| {
            check
                .get("bucket")
                .and_then(Value::as_str)
                .is_some_and(|bucket| matches!(bucket, "fail" | "cancel"))
        })
        .filter_map(|check| check.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if !failed.is_empty() {
        return CompletionResult {
            success: false,
            status: "retry_wait".to_string(),
            gate: gate.to_string(),
            detail: format!("GitHub checks failed: {}.", failed.join(", ")),
            pr_url: extract_github_pr_url(selector),
        };
    }
    let passed = checks.iter().all(|check| {
        check
            .get("bucket")
            .and_then(Value::as_str)
            .is_some_and(|bucket| matches!(bucket, "pass" | "skipping"))
    });
    if passed {
        CompletionResult {
            success: true,
            status: "ci_passed".to_string(),
            gate: gate.to_string(),
            detail: format!("GitHub checks passed for {selector}."),
            pr_url: extract_github_pr_url(selector),
        }
    } else {
        CompletionResult {
            success: false,
            status: "retry_wait".to_string(),
            gate: gate.to_string(),
            detail: format!("GitHub checks are not complete for {selector}."),
            pr_url: extract_github_pr_url(selector),
        }
    }
}

fn collect_pr_url(
    issue: &LinearIssue,
    issue_state: Option<&IssueDeliveryState>,
    workspace: &IssueWorkspace,
    phases: &[PhaseDeliveryResult],
) -> Option<String> {
    let mut text = String::new();
    if let Some(url) = &issue.url {
        text.push_str(url);
        text.push('\n');
    }
    if let Some(url) = issue_state.and_then(|state| state.pr_url.as_ref()) {
        text.push_str(url);
        text.push('\n');
    }
    if let Some(branch) = &workspace.branch {
        text.push_str(branch);
        text.push('\n');
    }
    for phase in phases {
        text.push_str(&phase.output);
        text.push('\n');
    }
    extract_github_pr_url(&text)
}

fn extract_github_pr_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|token| {
            token.trim_matches(|ch: char| matches!(ch, ',' | '.' | ')' | ']' | '"' | '\''))
        })
        .find(|token| {
            token.starts_with("https://github.com/") && token.split('/').any(|part| part == "pull")
        })
        .map(ToString::to_string)
}

fn prepare_issue_workspace(
    resolved: &ResolvedArgs,
    issue: &LinearIssue,
    paths: &DeliveryPaths,
) -> Result<IssueWorkspace, String> {
    let strategy = resolved.raw.linear_workspace_strategy.trim();
    if strategy == "none" {
        return Ok(IssueWorkspace {
            cwd: resolved.cwd.display().to_string(),
            strategy: "none".to_string(),
            branch: None,
        });
    }
    let workspace_name = safe_workspace_name(&issue.identifier);
    let workspace_path = paths.workspace_root.join(&workspace_name);
    let branch = format!("{DEFAULT_BRANCH_PREFIX}{workspace_name}");
    fs::create_dir_all(&paths.workspace_root).map_err(|error| {
        format!(
            "Failed to create workspace root {}: {error}",
            paths.workspace_root.display()
        )
    })?;
    if workspace_path.exists() {
        return Ok(IssueWorkspace {
            cwd: workspace_path.display().to_string(),
            strategy: strategy.to_string(),
            branch: Some(branch),
        });
    }
    if strategy == "worktree" {
        let args = vec![
            "worktree".to_string(),
            "add".to_string(),
            "-B".to_string(),
            branch.clone(),
            workspace_path.display().to_string(),
            "HEAD".to_string(),
        ];
        let result = run_command("git", &args, &resolved.cwd, None, 120_000, HashMap::new());
        if result.code == Some(0) {
            return Ok(IssueWorkspace {
                cwd: workspace_path.display().to_string(),
                strategy: "worktree".to_string(),
                branch: Some(branch),
            });
        }
    }
    copy_workspace(&resolved.cwd, &workspace_path)?;
    Ok(IssueWorkspace {
        cwd: workspace_path.display().to_string(),
        strategy: "copy".to_string(),
        branch: None,
    })
}

fn copy_workspace(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to)
        .map_err(|error| format!("Failed to create workspace {}: {error}", to.display()))?;
    for entry in fs::read_dir(from)
        .map_err(|error| format!("Failed to read workspace {}: {error}", from.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read workspace entry: {error}"))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if matches!(
            name_str.as_ref(),
            ".git" | ".council" | "node_modules" | "dist" | "target"
        ) {
            continue;
        }
        copy_path(&entry.path(), &to.join(name))?;
    }
    Ok(())
}

fn copy_path(from: &Path, to: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(from)
        .map_err(|error| format!("Failed to inspect {}: {error}", from.display()))?;
    if metadata.is_dir() {
        fs::create_dir_all(to)
            .map_err(|error| format!("Failed to create directory {}: {error}", to.display()))?;
        for entry in fs::read_dir(from)
            .map_err(|error| format!("Failed to read directory {}: {error}", from.display()))?
        {
            let entry =
                entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
            copy_path(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if metadata.file_type().is_symlink() {
        let target = fs::read_link(from)
            .map_err(|error| format!("Failed to read symlink {}: {error}", from.display()))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, to)
            .map_err(|error| format!("Failed to copy symlink {}: {error}", to.display()))?;
        #[cfg(not(unix))]
        fs::copy(from, to)
            .map_err(|error| format!("Failed to copy symlink {}: {error}", from.display()))?;
    } else {
        fs::copy(from, to).map_err(|error| {
            format!(
                "Failed to copy {} to {}: {error}",
                from.display(),
                to.display()
            )
        })?;
    }
    Ok(())
}

fn should_dispatch_issue(issue: &LinearIssue, state: &DeliveryState, max_attempts: usize) -> bool {
    let Some(issue_state) = state.issues.get(&issue.identifier) else {
        return true;
    };
    if is_terminal_status(&issue_state.status, "delivered") || issue_state.status == "running" {
        return false;
    }
    if issue_state.attempts >= max_attempts && issue_state.status == "failed" {
        return false;
    }
    if let Some(next_retry) = &issue_state.next_retry_at {
        if DateTime::parse_from_rfc3339(next_retry)
            .map(|date| date.with_timezone(&Utc) > Utc::now())
            .unwrap_or(false)
        {
            return false;
        }
    }
    true
}

fn is_delivery_target_complete(
    resolved: &ResolvedArgs,
    issues: &[LinearIssue],
    state: &DeliveryState,
    completion_gate: &str,
) -> bool {
    if !resolved.raw.linear_until_complete {
        return false;
    }
    if issues.is_empty() {
        return has_scoped_linear_target(resolved);
    }
    issues.iter().all(|issue| {
        state
            .issues
            .get(&issue.identifier)
            .is_some_and(|issue_state| is_terminal_status(&issue_state.status, completion_gate))
    })
}

fn reconcile_delivery_state(
    state: &mut DeliveryState,
    issues: &[LinearIssue],
    context: &DeliveryEventContext,
    enabled: bool,
) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    let active = issues
        .iter()
        .map(|issue| issue.identifier.as_str())
        .collect::<std::collections::HashSet<_>>();
    for issue_state in state.issues.values_mut() {
        if !active.contains(issue_state.identifier.as_str())
            && matches!(
                issue_state.status.as_str(),
                "queued" | "running" | "retry_wait"
            )
        {
            issue_state.status = "ineligible".to_string();
            emit_event(
                context,
                "delivery_reconciled",
                json!({ "identifier": issue_state.identifier, "status": "ineligible" }),
            )?;
        }
    }
    Ok(())
}

fn ensure_issue_state<'a>(
    state: &'a mut DeliveryState,
    issue: &LinearIssue,
) -> &'a mut IssueDeliveryState {
    state
        .issues
        .entry(issue.identifier.clone())
        .and_modify(|entry| {
            entry.issue_id = issue.id.clone();
            entry.title = issue.title.clone();
            entry.url = issue.url.clone();
            entry.project = issue.project.clone();
            entry.epic = issue.epic.clone();
            entry.updated_at = issue.updated_at.clone();
        })
        .or_insert_with(|| IssueDeliveryState {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            title: issue.title.clone(),
            url: issue.url.clone(),
            project: issue.project.clone(),
            epic: issue.epic.clone(),
            status: "queued".to_string(),
            attempts: 0,
            workspace: None,
            workspace_strategy: None,
            branch: None,
            phases: vec![],
            last_attempt_at: None,
            next_retry_at: None,
            last_error: None,
            completed_at: None,
            delivered_at: None,
            review_ready_at: None,
            ci_passed_at: None,
            completion_gate: None,
            completion_detail: None,
            pr_url: None,
            updated_at: issue.updated_at.clone(),
        })
}

fn schedule_retry(issue_state: &mut IssueDeliveryState, max_attempts: usize, retry_base_ms: u64) {
    if issue_state.attempts >= max_attempts {
        issue_state.status = "failed".to_string();
        issue_state.next_retry_at = None;
        return;
    }
    let multiplier = 2u64.saturating_pow(issue_state.attempts.saturating_sub(1) as u32);
    let next = Utc::now()
        + chrono::Duration::milliseconds((retry_base_ms.saturating_mul(multiplier)) as i64);
    issue_state.status = "retry_wait".to_string();
    issue_state.next_retry_at = Some(next.to_rfc3339_opts(SecondsFormat::Secs, true));
}

fn is_terminal_status(status: &str, completion_gate: &str) -> bool {
    if !TERMINAL_STATUSES.contains(&status) {
        return false;
    }
    match completion_gate {
        "ci-success" => status == "ci_passed",
        "human-review" | "review-or-ci" => matches!(status, "review_ready" | "ci_passed"),
        _ => true,
    }
}

fn has_scoped_linear_target(resolved: &ResolvedArgs) -> bool {
    !resolved.raw.linear_issue.is_empty()
        || !resolved.raw.linear_project.is_empty()
        || !resolved.raw.linear_epic.is_empty()
        || resolved.raw.linear_query.is_some()
        || resolved.raw.linear_team.is_some()
        || resolved.raw.linear_state.is_some()
        || resolved.raw.linear_assignee.is_some()
}

fn resolve_delivery_paths(resolved: &ResolvedArgs) -> DeliveryPaths {
    let council_dir = resolved.cwd.join(".council");
    let state_file = resolved
        .raw
        .linear_state_file
        .as_ref()
        .map(|path| absolutize(&resolved.cwd, path))
        .unwrap_or_else(|| council_dir.join("linear-delivery-state.json"));
    let workspace_root = resolved
        .raw
        .linear_workspace_root
        .as_ref()
        .map(|path| absolutize(&resolved.cwd, path))
        .unwrap_or_else(|| council_dir.join("linear-workspaces"));
    let observability_dir = resolved
        .raw
        .linear_observability_dir
        .as_ref()
        .map(|path| absolutize(&resolved.cwd, path))
        .unwrap_or_else(|| council_dir.join("linear-observability"));
    DeliveryPaths {
        state_file,
        workspace_root,
        events_file: observability_dir.join("events.jsonl"),
        observability_dir,
    }
}

fn resolve_linear_authorization(
    resolved: &ResolvedArgs,
    allow_missing: bool,
) -> Result<Option<String>, String> {
    let (env_name, oauth) = if resolved.raw.linear_auth == "oauth" {
        (&resolved.raw.linear_oauth_token_env, true)
    } else {
        (&resolved.raw.linear_api_key_env, false)
    };
    let Some(value) = std::env::var(env_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        if allow_missing {
            return Ok(None);
        }
        return Err(if oauth {
            format!("Linear delivery requires an OAuth token. Set {env_name} or pass --linear-oauth-token-env.")
        } else {
            format!(
                "Linear delivery requires an API key. Set {env_name} or pass --linear-api-key-env."
            )
        });
    };
    Ok(Some(if oauth && !value.starts_with("Bearer ") {
        format!("Bearer {value}")
    } else {
        value
    }))
}

fn load_delivery_state(path: &Path) -> DeliveryState {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<DeliveryState>(&text).ok())
        .unwrap_or_else(|| DeliveryState {
            version: 1,
            created_at: now_iso(),
            updated_at: None,
            issues: HashMap::new(),
        })
}

fn write_delivery_state(path: &Path, state: &mut DeliveryState) -> Result<(), String> {
    state.updated_at = Some(now_iso());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create state directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to serialize Linear state: {error}"))?;
    fs::write(path, format!("{text}\n"))
        .map_err(|error| format!("Failed to write Linear state {}: {error}", path.display()))
}

fn ensure_delivery_dirs(paths: &DeliveryPaths) -> Result<(), String> {
    if let Some(parent) = paths.state_file.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create state directory {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::create_dir_all(&paths.workspace_root).map_err(|error| {
        format!(
            "Failed to create workspace root {}: {error}",
            paths.workspace_root.display()
        )
    })?;
    fs::create_dir_all(&paths.observability_dir).map_err(|error| {
        format!(
            "Failed to create observability dir {}: {error}",
            paths.observability_dir.display()
        )
    })
}

fn emit_event(
    context: &DeliveryEventContext,
    event_type: &str,
    payload: Value,
) -> Result<(), String> {
    let event = json!({
        "type": event_type,
        "at": now_iso(),
        "payload": payload
    });
    eprintln!("{}", render_delivery_progress_event(event_type, &payload));
    if let Some(parent) = context.paths.events_file.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create observability dir {}: {error}",
                parent.display()
            )
        })?;
    }
    let line = serde_json::to_string(&event)
        .map_err(|error| format!("Failed to serialize delivery event: {error}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&context.paths.events_file)
        .map_err(|error| {
            format!(
                "Failed to open observability log {}: {error}",
                context.paths.events_file.display()
            )
        })?;
    writeln!(file, "{line}").map_err(|error| {
        format!(
            "Failed to write observability log {}: {error}",
            context.paths.events_file.display()
        )
    })
}

fn render_delivery_progress_event(event_type: &str, payload: &Value) -> String {
    match event_type {
        "delivery_started" => "[delivery] linear started".to_string(),
        "delivery_poll_started" => format!(
            "[delivery] poll {} started",
            payload.get("poll").and_then(Value::as_u64).unwrap_or(0)
        ),
        "delivery_poll_completed" => format!(
            "[delivery] poll {} completed fetched:{} dispatched:{} skipped:{}{}",
            payload.get("poll").and_then(Value::as_u64).unwrap_or(0),
            payload.get("fetched").and_then(Value::as_u64).unwrap_or(0),
            payload
                .get("dispatched")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            payload.get("skipped").and_then(Value::as_u64).unwrap_or(0),
            if payload
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                " complete"
            } else {
                ""
            }
        ),
        "delivery_issue_started" => "[delivery] issue started".to_string(),
        "delivery_workspace_prepared" => "[delivery] workspace prepared".to_string(),
        "delivery_phase_started" => format!(
            "[delivery] phase {} started",
            payload.get("phase").and_then(Value::as_str).unwrap_or("")
        ),
        "delivery_phase_completed" => format!(
            "[delivery] phase {} {}",
            payload.get("phase").and_then(Value::as_str).unwrap_or(""),
            if payload
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "ok"
            } else {
                "failed"
            }
        ),
        "delivery_issue_completed" => "[delivery] issue completed".to_string(),
        "delivery_target_completed" => "[delivery] target completed".to_string(),
        "delivery_completed" => "[delivery] linear completed".to_string(),
        _ => format!("[delivery] {event_type}"),
    }
}

fn read_workflow_policy(resolved: &ResolvedArgs) -> String {
    let path = resolved.cwd.join(DEFAULT_WORKFLOW_FILE);
    fs::read_to_string(path)
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

fn delivery_phases(resolved: &ResolvedArgs) -> Vec<String> {
    if resolved.raw.delivery_phases.is_empty() {
        DEFAULT_DELIVERY_PHASES
            .iter()
            .map(|phase| (*phase).to_string())
            .collect()
    } else {
        normalize_values(&resolved.raw.delivery_phases)
    }
}

fn build_delivery_phase_prompt(
    phase: &str,
    issue: &LinearIssue,
    resolved: &ResolvedArgs,
    conversation: &[(String, String)],
    workflow_policy: &str,
) -> String {
    let mut lines = vec![
        format!("Linear task: {} - {}", issue.identifier, issue.title),
        issue
            .url
            .as_ref()
            .map(|url| format!("Linear URL: {url}"))
            .unwrap_or_default(),
        issue
            .branch_name
            .as_ref()
            .map(|branch| format!("Suggested branch: {branch}"))
            .unwrap_or_default(),
        issue
            .project
            .as_ref()
            .and_then(|project| project.name.as_ref())
            .map(|name| format!("Linear project: {name}"))
            .unwrap_or_default(),
        issue
            .epic
            .as_ref()
            .map(|epic| {
                [epic.identifier.as_deref(), epic.title.as_deref()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" - ")
            })
            .filter(|value| !value.is_empty())
            .map(|value| format!("Linear epic: {value}"))
            .unwrap_or_default(),
        issue
            .state
            .as_ref()
            .map(|state| format!("Current state: {state}"))
            .unwrap_or_default(),
        if issue.labels.is_empty() {
            String::new()
        } else {
            format!("Labels: {}", issue.labels.join(", "))
        },
        issue
            .assignee
            .as_ref()
            .map(|assignee| format!("Assignee: {assignee}"))
            .unwrap_or_default(),
        String::new(),
        "Task description:".to_string(),
        if issue.description.trim().is_empty() {
            "(no description provided)".to_string()
        } else {
            issue.description.clone()
        },
    ];
    if !workflow_policy.trim().is_empty() {
        lines.extend([
            String::new(),
            "Repository workflow policy:".to_string(),
            workflow_policy.to_string(),
        ]);
    }
    if !resolved.prompt.trim().is_empty() {
        lines.extend([
            String::new(),
            format!("Operator guidance: {}", resolved.prompt.trim()),
        ]);
    }
    if !conversation.is_empty() {
        lines.push(String::new());
        lines.push("Previous delivery phase handoff:".to_string());
        for (name, output) in conversation {
            lines.push(format!("### {name}"));
            lines.push(output.trim().to_string());
        }
    }
    lines.extend([
        String::new(),
        format!("Council phase: {phase}."),
        format!(
            "Completion gate: {}.",
            normalize_completion_gate(&resolved.raw.linear_completion_gate)
        ),
    ]);
    if let Some(review_state) = &resolved.raw.linear_review_state {
        lines.push(format!("Human-review Linear state: {review_state}."));
    }
    let instruction = match phase {
        "plan" => "Create a concrete delivery plan. Identify files to inspect, implementation steps, tests, GitHub/PR requirements, and risks. Do not make code changes unless absolutely necessary.",
        "implement" => "Implement the task in this isolated issue workspace. Use the prior plan and handoff context. Keep the change scoped to the Linear issue. Preserve user changes.",
        "verify" => "Verify the implementation in this isolated issue workspace. Run relevant tests, builds, linters, or targeted commands. Fix in-scope failures and rerun the relevant checks.",
        _ => "Ship the work from this isolated issue workspace. Inspect git status and diff, scan for secrets, commit with the issue context, push a branch, open or update the GitHub PR, and include tests run and residual risks.",
    };
    lines.extend([String::new(), instruction.to_string()]);
    lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn pick_phase_planner(phase: &str, members: &[String], requested: Option<&str>) -> Option<String> {
    if let Some(requested) = requested.filter(|value| members.iter().any(|member| member == value))
    {
        return Some(requested.to_string());
    }
    if phase == "plan" {
        return members.first().cloned();
    }
    if members.iter().any(|member| member == "codex") {
        Some("codex".to_string())
    } else {
        members.first().cloned()
    }
}

fn pick_phase_lead(phase: &str, members: &[String], requested: Option<&str>) -> Option<String> {
    if let Some(requested) = requested.filter(|value| members.iter().any(|member| member == value))
    {
        return Some(requested.to_string());
    }
    if phase == "verify" && members.iter().any(|member| member == "gemini") {
        Some("gemini".to_string())
    } else if members.iter().any(|member| member == "codex") {
        Some("codex".to_string())
    } else {
        members.first().cloned()
    }
}

fn effective_max_attempts(resolved: &ResolvedArgs) -> usize {
    if resolved.raw.linear_until_complete {
        usize::MAX
    } else if resolved.raw.linear_max_attempts == 0 {
        DEFAULT_MAX_ATTEMPTS
    } else {
        resolved.raw.linear_max_attempts
    }
}

fn normalize_completion_gate(value: &str) -> String {
    match value {
        "delivered" | "human-review" | "ci-success" | "review-or-ci" => value.to_string(),
        _ => "delivered".to_string(),
    }
}

fn summarize_delivery_state(state: &DeliveryState) -> DeliveryCounts {
    let mut counts = DeliveryCounts::default();
    for issue in state.issues.values() {
        counts.total += 1;
        match issue.status.as_str() {
            "delivered" => counts.delivered += 1,
            "review_ready" => counts.review_ready += 1,
            "ci_passed" => counts.ci_passed += 1,
            "running" => counts.running += 1,
            "retry_wait" => counts.retry_wait += 1,
            "failed" => counts.failed += 1,
            "ineligible" => counts.ineligible += 1,
            _ => {}
        }
    }
    counts
}

fn normalize_values(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn absolutize(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn safe_workspace_name(value: &str) -> String {
    let mut name = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if name.is_empty() {
        name = "issue".to_string();
    }
    name
}

fn linear_endpoint() -> String {
    std::env::var("LINEAR_GRAPHQL_ENDPOINT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_LINEAR_ENDPOINT.to_string())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn same_text(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn media_title(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(value)
            .to_string()
    } else {
        Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(value)
            .to_string()
    }
}

fn infer_content_type(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "jpeg" | "jpg" => "image/jpeg",
        "mov" => "video/quicktime",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "webm" => "video/webm",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_workspace_names() {
        assert_eq!(
            safe_workspace_name("ENG-123 Add OAuth!"),
            "eng-123-add-oauth"
        );
        assert_eq!(safe_workspace_name("!!!"), "issue");
    }

    #[test]
    fn extracts_github_pr_urls() {
        assert_eq!(
            extract_github_pr_url("Ready: https://github.com/seeARMS/council/pull/7."),
            Some("https://github.com/seeARMS/council/pull/7".to_string())
        );
    }

    #[test]
    fn infers_common_media_content_types() {
        assert_eq!(infer_content_type("screen.png"), "image/png");
        assert_eq!(infer_content_type("notes.txt"), "text/plain");
        assert_eq!(
            infer_content_type("archive.bin"),
            "application/octet-stream"
        );
    }
}
