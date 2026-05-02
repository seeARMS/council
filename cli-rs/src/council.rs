use std::collections::HashMap;
use futures::future::join_all;
use serde::Serialize;

use crate::args::{ALL_ENGINES, AUTO_SUMMARIZER, DEFAULT_MAX_MEMBER_CHARS};
use crate::engines::{
    build_member_prompt, build_summary_prompt, run_engine, EngineResult, RunEngineOptions,
    DEFAULT_SUMMARIZER_ORDER,
};

#[derive(Debug, Clone, Serialize)]
pub struct CouncilResult {
    pub query: String,
    pub cwd: String,
    pub members_requested: Vec<String>,
    pub summarizer_requested: String,
    pub effort: Option<String>,
    pub members: Vec<EngineResult>,
    pub summary_attempts: Vec<EngineResult>,
    pub summary: Option<SummaryResult>,
    pub summary_context_limit: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SummaryResult {
    pub name: Option<String>,
    pub status: String,
    pub detail: String,
    pub output: String,
    pub duration_ms: u64,
}

pub struct CouncilOptions {
    pub query: String,
    pub cwd: String,
    pub members: Vec<String>,
    pub summarizer: String,
    pub timeout_ms: u64,
    pub max_member_chars: usize,
    pub env: HashMap<String, String>,
    pub effort: Option<String>,
    pub on_event: Box<dyn Fn(CouncilEvent) + Send + Sync>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CouncilEvent {
    RunStarted {
        at: String,
        cwd: String,
        members: Vec<String>,
        summarizer: String,
        effort: Option<String>,
    },
    MemberStarted {
        at: String,
        name: String,
    },
    MemberProgress {
        at: String,
        name: String,
        detail: String,
    },
    MemberHeartbeat {
        at: String,
        name: String,
        elapsed_ms: u64,
    },
    MemberCompleted {
        at: String,
        result: EngineResult,
    },
    SummaryStarted {
        at: String,
        name: String,
    },
    SummaryProgress {
        at: String,
        name: String,
        detail: String,
    },
    SummaryHeartbeat {
        at: String,
        name: String,
        elapsed_ms: u64,
    },
    SummaryCompleted {
        at: String,
        result: SummaryResult,
    },
    RunCompleted {
        at: String,
        success: bool,
        result: CouncilResult,
    },
}

pub fn is_council_success(result: &CouncilResult) -> bool {
    result.members.iter().any(|m| m.status == "ok")
        && result.summary.as_ref().map_or(false, |s| s.status == "ok")
}

pub async fn run_council(opts: CouncilOptions) -> CouncilResult {
    let now = chrono_now();
    (opts.on_event)(CouncilEvent::RunStarted {
        at: now,
        cwd: opts.cwd.clone(),
        members: opts.members.clone(),
        summarizer: opts.summarizer.clone(),
        effort: opts.effort.clone(),
    });

    let member_prompt = build_member_prompt(&opts.query);

    // Run all members in parallel
    let member_futures: Vec<_> = opts.members.iter().map(|name| {
        let name = name.clone();
        let prompt = member_prompt.clone();
        let cwd = opts.cwd.clone();
        let env = opts.env.clone();
        let effort = opts.effort.clone();
        let timeout_ms = opts.timeout_ms;
        let on_event = &opts.on_event;

        // We can't easily share on_event across async boundaries without Arc, so we emit
        // member_started before spawning and collect results after.
        let started_at_str = chrono_now();
        on_event(CouncilEvent::MemberStarted {
            at: started_at_str,
            name: name.clone(),
        });

        let on_event_ptr = on_event as *const dyn Fn(CouncilEvent) + Send + Sync;
        // SAFETY: on_event lives for the duration of run_council; futures are awaited below.
        let on_event_ref: &'static (dyn Fn(CouncilEvent) + Send + Sync) =
            unsafe { &*on_event_ptr };

        let name_for_progress = name.clone();
        let name_for_heartbeat = name.clone();

        async move {
            let result = run_with_heartbeat(
                "member",
                &name_for_heartbeat,
                timeout_ms,
                on_event_ref,
                |on_progress| {
                    run_engine(&name, RunEngineOptions {
                        prompt,
                        cwd,
                        timeout_ms,
                        env,
                        effort,
                        on_progress: Box::new(move |detail: &str| {
                            on_progress(detail);
                        }),
                    })
                },
            )
            .await;

            on_event_ref(CouncilEvent::MemberCompleted {
                at: chrono_now(),
                result: result.clone(),
            });

            result
        }
    }).collect();

    let member_runs: Vec<EngineResult> = join_all(member_futures).await;

    let successful_members: Vec<&EngineResult> = member_runs
        .iter()
        .filter(|r| r.status == "ok")
        .collect();

    let mut summary_attempts: Vec<EngineResult> = Vec::new();
    let summary: SummaryResult;

    if !successful_members.is_empty() {
        let summary_prompt = build_summary_prompt(&opts.query, &successful_members, opts.max_member_chars);
        let candidates = pick_summarizer_candidates(&opts.summarizer, &successful_members);
        let mut found_summary: Option<EngineResult> = None;

        for candidate in &candidates {
            let candidate = candidate.clone();
            let attempt = run_summary_attempt(
                &candidate,
                &summary_prompt,
                &opts.cwd,
                opts.timeout_ms,
                &opts.env,
                opts.effort.clone(),
                &*opts.on_event,
            )
            .await;

            let ok = attempt.status == "ok";
            summary_attempts.push(attempt.clone());

            if ok {
                found_summary = Some(attempt);
                break;
            }

            if opts.summarizer != AUTO_SUMMARIZER {
                found_summary = Some(attempt);
                break;
            }
        }

        let last_attempt = summary_attempts.last();
        let resolved = found_summary.or_else(|| last_attempt.cloned());
        summary = match resolved {
            Some(r) => engine_result_to_summary(r),
            None => SummaryResult {
                name: None,
                status: "error".to_string(),
                detail: "No summarizer could be started.".to_string(),
                output: String::new(),
                duration_ms: 0,
            },
        };
    } else {
        summary = SummaryResult {
            name: if opts.summarizer == AUTO_SUMMARIZER {
                None
            } else {
                Some(opts.summarizer.clone())
            },
            status: "error".to_string(),
            detail: summarize_no_response(&member_runs),
            output: String::new(),
            duration_ms: 0,
        };
    }

    let result = CouncilResult {
        query: opts.query.clone(),
        cwd: opts.cwd.clone(),
        members_requested: opts.members.clone(),
        summarizer_requested: opts.summarizer.clone(),
        effort: opts.effort.clone(),
        members: member_runs,
        summary_attempts,
        summary: Some(summary),
        summary_context_limit: opts.max_member_chars,
    };

    let success = is_council_success(&result);
    (opts.on_event)(CouncilEvent::RunCompleted {
        at: chrono_now(),
        success,
        result: result.clone(),
    });

    result
}

async fn run_summary_attempt(
    name: &str,
    prompt: &str,
    cwd: &str,
    timeout_ms: u64,
    env: &HashMap<String, String>,
    effort: Option<String>,
    on_event: &(dyn Fn(CouncilEvent) + Send + Sync),
) -> EngineResult {
    on_event(CouncilEvent::SummaryStarted {
        at: chrono_now(),
        name: name.to_string(),
    });

    let on_event_ptr = on_event as *const (dyn Fn(CouncilEvent) + Send + Sync);
    let on_event_ref: &'static (dyn Fn(CouncilEvent) + Send + Sync) =
        unsafe { &*on_event_ptr };

    let name_owned = name.to_string();
    let prompt_owned = prompt.to_string();
    let cwd_owned = cwd.to_string();
    let env_owned = env.clone();

    let result = run_with_heartbeat(
        "summary",
        name,
        timeout_ms,
        on_event_ref,
        |on_progress| {
            let name = name_owned.clone();
            let prompt = prompt_owned.clone();
            let cwd = cwd_owned.clone();
            let env = env_owned.clone();
            let effort = effort.clone();
            run_engine(&name, RunEngineOptions {
                prompt,
                cwd,
                timeout_ms,
                env,
                effort,
                on_progress: Box::new(move |detail: &str| {
                    on_progress(detail);
                }),
            })
        },
    )
    .await;

    on_event(CouncilEvent::SummaryCompleted {
        at: chrono_now(),
        result: engine_result_to_summary(result.clone()),
    });

    result
}

async fn run_with_heartbeat<F, Fut>(
    kind: &'static str,
    name: &str,
    timeout_ms: u64,
    on_event: &'static (dyn Fn(CouncilEvent) + Send + Sync),
    task_factory: F,
) -> EngineResult
where
    F: FnOnce(Box<dyn Fn(&str) + Send + Sync>) -> Fut,
    Fut: std::future::Future<Output = EngineResult>,
{
    let started_at = std::time::Instant::now();
    let name_owned = name.to_string();
    let interval_ms = 10_000u64;

    let on_progress_name = name_owned.clone();
    let on_progress: Box<dyn Fn(&str) + Send + Sync> = Box::new(move |detail: &str| {
        let detail = detail.to_string();
        let name = on_progress_name.clone();
        let event = if kind == "member" {
            CouncilEvent::MemberProgress {
                at: chrono_now(),
                name,
                detail,
            }
        } else {
            CouncilEvent::SummaryProgress {
                at: chrono_now(),
                name,
                detail,
            }
        };
        on_event(event);
    });

    let task = task_factory(on_progress);

    // Run task with periodic heartbeat emissions via select
    let heartbeat_name = name_owned.clone();
    let result = tokio::select! {
        r = task => r,
        _ = async {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
                let elapsed_ms = started_at.elapsed().as_millis() as u64;
                let event = if kind == "member" {
                    CouncilEvent::MemberHeartbeat {
                        at: chrono_now(),
                        name: heartbeat_name.clone(),
                        elapsed_ms,
                    }
                } else {
                    CouncilEvent::SummaryHeartbeat {
                        at: chrono_now(),
                        name: heartbeat_name.clone(),
                        elapsed_ms,
                    }
                };
                on_event(event);
            }
        } => unreachable!(),
    };

    result
}

fn pick_summarizer_candidates(requested: &str, successful_members: &[&EngineResult]) -> Vec<String> {
    if requested != AUTO_SUMMARIZER {
        return vec![requested.to_string()];
    }

    let successful_names: std::collections::HashSet<&str> =
        successful_members.iter().map(|m| m.name.as_str()).collect();

    DEFAULT_SUMMARIZER_ORDER
        .iter()
        .filter(|name| successful_names.contains(*name))
        .map(|s| s.to_string())
        .collect()
}

fn summarize_no_response(member_runs: &[EngineResult]) -> String {
    let actionable = member_runs
        .iter()
        .find(|m| m.status != "missing" && !m.detail.is_empty());

    if let Some(failure) = actionable {
        return failure.detail.clone();
    }

    if member_runs.len() == 1 && !member_runs[0].detail.is_empty() {
        return member_runs[0].detail.clone();
    }

    "No council member produced a response.".to_string()
}

fn engine_result_to_summary(result: EngineResult) -> SummaryResult {
    SummaryResult {
        name: Some(result.name),
        status: result.status,
        detail: result.detail,
        output: result.output,
        duration_ms: result.duration_ms,
    }
}

fn chrono_now() -> String {
    // RFC 3339 timestamp without chrono dependency — use SystemTime
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let nanos = now.subsec_nanos();

    // Format as ISO 8601 / RFC 3339 — simplified but correct for UTC
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;

    // Days since Unix epoch to calendar date
    let (year, month, day) = days_to_date(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        h,
        m,
        s,
        nanos / 1_000_000
    )
}

fn days_to_date(mut days: u64) -> (u64, u64, u64) {
    let mut year = 1970u64;
    loop {
        let leap = is_leap(year);
        let days_in_year = if leap { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let leap = is_leap(year);
    let month_days: [u64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u64;
    for md in &month_days {
        if days < *md {
            break;
        }
        days -= md;
        month += 1;
    }
    (year, month, days + 1)
}

fn is_leap(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
