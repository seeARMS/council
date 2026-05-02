import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  appendFile,
  cp,
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { runCouncil } from './council.js';
import { attachLinearMedia, fetchLinearIssues, fetchLinearViewer } from './linear.js';

const DEFAULT_DELIVERY_PHASES = ['plan', 'implement', 'verify', 'ship'];
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_CI_TIMEOUT_MS = 900_000;
const DEFAULT_CI_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BRANCH_PREFIX = 'council/linear/';
const DEFAULT_WORKFLOW_FILE = 'WORKFLOW.md';
const COMPLETION_GATES = ['delivered', 'human-review', 'ci-success', 'review-or-ci'];
const TERMINAL_ISSUE_STATUSES = ['delivered', 'review_ready', 'ci_passed'];

export async function runLinearDelivery(options: any = {}) {
  const {
    baseQuery = '',
    cwd = process.cwd(),
    delivery = {},
    env = process.env,
    fetchFn = fetch,
    runner = runCouncil,
    workspaceFactory = prepareIssueWorkspace,
    ciChecker = checkGithubCi,
    nowFn = () => Date.now(),
    sleepFn = sleep,
    onEvent = () => {},
    ...councilOptions
  } = options;
  const startedAt = nowFn();
  const paths = resolveDeliveryPaths(cwd, delivery);
  const authorization = resolveLinearAuthorization({ delivery, env });
  const phases = delivery.phases?.length > 0
    ? delivery.phases
    : DEFAULT_DELIVERY_PHASES;
  const state = await loadDeliveryState(paths.stateFile);
  const workflowPolicy = await readWorkflowPolicy(cwd, delivery.workflowFile);
  const completionGate = normalizeCompletionGate(delivery.completionGate);
  const context = {
    paths,
    onEvent,
    nowFn,
    sleepFn
  };
  const pollLimit = delivery.watch
    ? delivery.maxPolls || Number.POSITIVE_INFINITY
    : 1;
  let pollCount = 0;
  const pollResults = [];

  await ensureDeliveryDirs(paths);
  await emitDeliveryEvent(context, 'delivery_started', {
    provider: 'linear',
    phases,
    issueIds: delivery.issueIds || [],
    projects: delivery.projects || [],
    epics: delivery.epics || [],
    watch: Boolean(delivery.watch),
    untilComplete: Boolean(delivery.untilComplete),
    completionGate,
    pollIntervalMs: delivery.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    maxConcurrency: delivery.maxConcurrency || DEFAULT_MAX_CONCURRENCY,
    maxAttempts: effectiveMaxAttempts(delivery),
    stateFile: paths.stateFile,
    workspaceRoot: paths.workspaceRoot,
    observabilityLog: paths.eventsFile
  });

  while (pollCount < pollLimit) {
    pollCount += 1;
    const pollResult = await runLinearDeliveryPoll({
      baseQuery,
      cwd,
      delivery,
      authorization,
      phases,
      state,
      workflowPolicy,
      env,
      fetchFn,
      runner,
      workspaceFactory,
      ciChecker,
      councilOptions,
      context,
      poll: pollCount,
      completionGate
    });
    pollResults.push(pollResult);

    if (delivery.untilComplete && pollResult.complete) {
      await emitDeliveryEvent(context, 'delivery_target_completed', {
        poll: pollCount,
        completionGate
      });
      break;
    }

    if (!delivery.watch || pollCount >= pollLimit) {
      break;
    }

    await sleepFn(delivery.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  }

  const issueResults = pollResults.flatMap((poll) => poll.issues);
  const finalResult = {
    provider: 'linear',
    success: issueResults.every((issue) => issue.success !== false),
    durationMs: nowFn() - startedAt,
    issueCount: issueResults.length,
    phases,
    watch: Boolean(delivery.watch),
    pollCount,
    untilComplete: Boolean(delivery.untilComplete),
    completionGate,
    stateFile: paths.stateFile,
    workspaceRoot: paths.workspaceRoot,
    observabilityLog: paths.eventsFile,
    polls: pollResults,
    issues: issueResults
  };

  await writeDeliveryState(paths.stateFile, state, context);
  await emitDeliveryEvent(context, 'delivery_completed', {
    success: finalResult.success,
    result: finalResult
  });

  return finalResult;
}

async function runLinearDeliveryPoll({
  baseQuery,
  cwd,
  delivery,
  authorization,
  phases,
  state,
  workflowPolicy,
  env,
  fetchFn,
  runner,
  workspaceFactory,
  ciChecker,
  councilOptions,
  context,
  poll,
  completionGate
}) {
  await emitDeliveryEvent(context, 'delivery_poll_started', { poll });

  const issues = await fetchLinearIssues({
    issueIds: delivery.issueIds || [],
    query: delivery.query,
    team: delivery.team,
    state: delivery.state,
    assignee: delivery.assignee,
    projects: delivery.projects || [],
    epics: delivery.epics || [],
    limit: delivery.limit || 3,
    fetchAll: Boolean(delivery.untilComplete),
    endpoint: delivery.endpoint,
    authorization,
    fetchFn
  });

  await reconcileDeliveryState({
    state,
    issues,
    context,
    enabled: Boolean(delivery.watch)
  });

  const eligibleIssues = issues
    .filter((issue) =>
      shouldDispatchIssue({
        issue,
        state,
        maxAttempts: effectiveMaxAttempts(delivery),
        now: context.nowFn()
      })
    )
    .slice(0, delivery.limit || 3);
  const skippedIssues = issues.filter((issue) => !eligibleIssues.includes(issue));
  for (const issue of skippedIssues) {
    await emitDeliveryEvent(context, 'delivery_issue_skipped', {
      issue,
      reason: state.issues[issue.identifier]?.status || 'not eligible'
    });
  }

  const issueResults = await runWithConcurrency(
    eligibleIssues,
    delivery.maxConcurrency || DEFAULT_MAX_CONCURRENCY,
    (issue) => runLinearIssueDelivery({
      issue,
      baseQuery,
      cwd,
      delivery,
      phases,
      state,
      workflowPolicy,
      env,
      fetchFn,
      runner,
      workspaceFactory,
      ciChecker,
      councilOptions,
      context
    })
  );

  await writeDeliveryState(context.paths.stateFile, state, context);
  await emitDeliveryEvent(context, 'delivery_poll_completed', {
    poll,
    fetched: issues.length,
    dispatched: eligibleIssues.length,
    skipped: skippedIssues.length,
    complete: isDeliveryTargetComplete({ delivery, issues, state, completionGate })
  });

  return {
    poll,
    fetched: issues.length,
    dispatched: eligibleIssues.length,
    skipped: skippedIssues.length,
    complete: isDeliveryTargetComplete({ delivery, issues, state, completionGate }),
    issues: issueResults
  };
}

async function runLinearIssueDelivery({
  issue,
  baseQuery,
  cwd,
  delivery,
  phases,
  state,
  workflowPolicy,
  env,
  fetchFn,
  runner,
  workspaceFactory,
  ciChecker,
  councilOptions,
  context
}) {
  const issueState = ensureIssueState(state, issue);
  issueState.status = 'running';
  issueState.attempts += 1;
  issueState.lastAttemptAt = isoNow(context.nowFn);
  issueState.nextRetryAt = null;
  issueState.lastError = null;
  issueState.phases = [];
  await writeDeliveryState(context.paths.stateFile, state, context);

  await emitDeliveryEvent(context, 'delivery_issue_started', {
    issue,
    attempt: issueState.attempts,
    maxAttempts: effectiveMaxAttempts(delivery)
  });

  const workspace = await workspaceFactory({
    cwd,
    issue,
    delivery,
    paths: context.paths
  });
  issueState.workspace = workspace.cwd;
  issueState.workspaceStrategy = workspace.strategy;
  issueState.branch = workspace.branch || null;
  await writeDeliveryState(context.paths.stateFile, state, context);
  await emitDeliveryEvent(context, 'delivery_workspace_prepared', {
    issue,
    workspace
  });

  const phaseResults = [];
  const conversation = [];

  for (const phase of phases) {
    await emitDeliveryEvent(context, 'delivery_phase_started', {
      issue,
      phase
    });

    const phaseOptions = optionsForDeliveryPhase({
      phase,
      issue,
      baseQuery,
      conversation,
      workflowPolicy,
      delivery,
      councilOptions
    });
    const result = await runner({
      ...phaseOptions,
      cwd: workspace.cwd,
      env,
      onEvent: (event) => {
        context.onEvent(event);
        void appendObservabilityEvent(context.paths.eventsFile, event);
      }
    });
    const success = Boolean(result.summary?.status === 'ok');
    const phaseState = {
      phase,
      status: result.summary?.status || 'unknown',
      summarizer: result.summary?.name || null,
      completedAt: isoNow(context.nowFn)
    };

    phaseResults.push({
      phase,
      result
    });
    issueState.phases.push(phaseState);
    conversation.push({
      user: phaseOptions.query,
      assistant: result.summary?.output || result.summary?.detail || ''
    });
    await writeDeliveryState(context.paths.stateFile, state, context);

    await emitDeliveryEvent(context, 'delivery_phase_completed', {
      issue,
      phase,
      success,
      result
    });

    if (!success) {
      issueState.lastError = result.summary?.detail || `${phase} failed`;
      break;
    }
  }

  const issueSuccess = phaseResults.length === phases.length &&
    phaseResults.every((phase) => phase.result.summary?.status === 'ok');
  const mediaAttachments = [];
  let completion: any = {
    success: false,
    status: 'retry_wait',
    gate: normalizeCompletionGate(delivery.completionGate),
    detail: ''
  };

  if (issueSuccess) {
    if (delivery.attachMedia?.length > 0) {
      issueState.mediaAttachments = [];
      for (const media of delivery.attachMedia) {
        await emitDeliveryEvent(context, 'delivery_media_attach_started', {
          issue,
          media
        });
        try {
          const attachment = await attachLinearMedia({
            issue,
            media,
            cwd: workspace.cwd,
            endpoint: delivery.endpoint,
            authorization: resolveLinearAuthorization({ delivery, env }),
            fetchFn,
            titlePrefix: delivery.attachmentTitle
          });
          mediaAttachments.push(attachment);
          issueState.mediaAttachments.push({
            source: attachment.source,
            url: attachment.url,
            attachmentId: attachment.attachment.id,
            title: attachment.attachment.title,
            attachedAt: isoNow(context.nowFn)
          });
          await emitDeliveryEvent(context, 'delivery_media_attached', {
            issue,
            media,
            attachment: attachment.attachment,
            url: attachment.url
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          mediaAttachments.push({
            source: media,
            error: detail
          });
          await emitDeliveryEvent(context, 'delivery_media_attach_failed', {
            issue,
            media,
            detail
          });
        }
      }
    }
  }

  const mediaSuccess = mediaAttachments.every((attachment) => !attachment.error);

  if (issueSuccess && mediaSuccess) {
    completion = await evaluateCompletionGate({
      delivery,
      issue,
      issueState,
      workspace,
      phaseResults,
      context,
      ciChecker
    });
    if (completion.success) {
      issueState.status = completion.status;
      issueState.completedAt = isoNow(context.nowFn);
      if (completion.status === 'delivered') {
        issueState.deliveredAt = issueState.completedAt;
      }
      if (completion.status === 'review_ready') {
        issueState.reviewReadyAt = issueState.completedAt;
      }
      if (completion.status === 'ci_passed') {
        issueState.ciPassedAt = issueState.completedAt;
      }
      issueState.completionGate = completion.gate;
      issueState.completionDetail = completion.detail || null;
      issueState.prUrl = completion.prUrl || issueState.prUrl || null;
      await emitDeliveryEvent(context, 'delivery_completion_gate_passed', {
        issue,
        gate: completion.gate,
        status: completion.status,
        detail: completion.detail || '',
        prUrl: completion.prUrl || null
      });
    } else {
      issueState.lastError = completion.detail || `${completion.gate} gate not satisfied`;
    }
  } else if (issueSuccess && !mediaSuccess) {
    issueState.lastError = 'One or more Linear media attachments failed.';
  }

  if (!issueSuccess || !mediaSuccess || !completion.success) {
    scheduleRetry({
      issueState,
      maxAttempts: effectiveMaxAttempts(delivery),
      retryBaseMs: delivery.retryBaseMs || DEFAULT_RETRY_BASE_MS,
      now: context.nowFn()
    });
    await emitDeliveryEvent(context, 'delivery_completion_gate_failed', {
      issue,
      gate: completion.gate,
      detail: issueState.lastError || completion.detail || 'Delivery gate failed.',
      attempts: issueState.attempts,
      nextRetryAt: issueState.nextRetryAt || null
    });
    if (issueState.status === 'retry_wait') {
      await emitDeliveryEvent(context, 'delivery_retry_scheduled', {
        issue,
        attempts: issueState.attempts,
        nextRetryAt: issueState.nextRetryAt
      });
    }
  }

  const finalIssueSuccess = issueSuccess && mediaSuccess && completion.success;
  await writeDeliveryState(context.paths.stateFile, state, context);
  await emitDeliveryEvent(context, 'delivery_issue_completed', {
    issue,
    success: finalIssueSuccess,
    status: issueState.status,
    attempts: issueState.attempts,
    nextRetryAt: issueState.nextRetryAt || null
  });

  return {
    issue,
    success: finalIssueSuccess,
    status: issueState.status,
    workspace,
    attempts: issueState.attempts,
    nextRetryAt: issueState.nextRetryAt || null,
    completion,
    phases: phaseResults,
    mediaAttachments
  };
}

async function evaluateCompletionGate({
  delivery,
  issue,
  issueState,
  workspace,
  phaseResults,
  context,
  ciChecker
}) {
  const gate = normalizeCompletionGate(delivery.completionGate);
  const evidence = collectCompletionEvidence({ delivery, issue, issueState, workspace, phaseResults });

  if (gate === 'delivered') {
    return {
      success: true,
      status: 'delivered',
      gate,
      detail: 'All delivery phases completed.',
      prUrl: evidence.prUrl || null
    };
  }

  if (gate === 'human-review' || gate === 'review-or-ci') {
    const review = humanReviewReadiness({ delivery, issue, evidence });
    if (review.success) {
      return {
        ...review,
        status: 'review_ready',
        gate,
        prUrl: evidence.prUrl || null
      };
    }
  }

  const ciRequired = gate === 'ci-success';
  const ci = await ciChecker({
    cwd: workspace.cwd,
    selector: evidence.prUrl || workspace.branch || '',
    timeoutMs: ciRequired
      ? delivery.ciTimeoutMs || DEFAULT_CI_TIMEOUT_MS
      : 0,
    pollIntervalMs: delivery.ciPollIntervalMs || DEFAULT_CI_POLL_INTERVAL_MS,
    nowFn: context.nowFn,
    sleepFn: context.sleepFn
  });

  if (ci.success) {
    return {
      success: true,
      status: 'ci_passed',
      gate,
      detail: ci.detail,
      prUrl: evidence.prUrl || null,
      checks: ci.checks || []
    };
  }

  return {
    success: false,
    status: 'retry_wait',
    gate,
    detail: ci.detail || `Completion gate ${gate} was not satisfied.`,
    prUrl: evidence.prUrl || null,
    checks: ci.checks || []
  };
}

function collectCompletionEvidence({ delivery, issue, issueState, workspace, phaseResults }) {
  const text = [
    issue.url,
    issueState.prUrl,
    workspace.branch,
    ...phaseResults.flatMap((phase) => [
      phase.result?.summary?.output,
      phase.result?.summary?.detail,
      ...(phase.result?.members || []).map((member) => member.output || member.detail || '')
    ])
  ].filter(Boolean).join('\n');
  const prUrl = extractGithubPrUrl(text);
  return {
    prUrl,
    branch: workspace.branch || null,
    reviewState: delivery.reviewState || null
  };
}

function humanReviewReadiness({ delivery, issue, evidence }) {
  const reviewState = String(delivery.reviewState || '').trim();
  if (reviewState && sameText(issue.state, reviewState)) {
    return {
      success: true,
      detail: `Linear state is ${reviewState}.`
    };
  }

  if (evidence.prUrl) {
    return {
      success: true,
      detail: `GitHub PR is ready for review: ${evidence.prUrl}.`
    };
  }

  if (evidence.branch) {
    return {
      success: true,
      detail: `Branch is ready for review: ${evidence.branch}.`
    };
  }

  return {
    success: false,
    detail: reviewState
      ? `No GitHub PR/branch evidence found and Linear state is not ${reviewState}.`
      : 'No GitHub PR or branch evidence found for human review.'
  };
}

async function checkGithubCi({
  cwd,
  selector = '',
  timeoutMs = DEFAULT_CI_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_CI_POLL_INTERVAL_MS,
  nowFn = () => Date.now(),
  sleepFn = sleep
}: any = {}) {
  const target = String(selector || '').trim();
  if (!target) {
    return {
      success: false,
      detail: 'No GitHub PR URL or branch was found for CI checks.',
      checks: []
    };
  }

  const startedAt = nowFn();
  let last: any = {
    success: false,
    detail: '',
    checks: []
  };

  while (true) {
    const result = await runProcessCapture(
      'gh',
      [
        'pr',
        'checks',
        target,
        '--json',
        'name,bucket,state,workflow,completedAt,link'
      ],
      cwd
    );
    last = interpretGithubChecks(result, target);
    if (last.success || last.terminal || timeoutMs <= 0 || nowFn() - startedAt >= timeoutMs) {
      return last;
    }
    await sleepFn(Math.max(1_000, pollIntervalMs));
  }
}

function interpretGithubChecks(result, target) {
  if (result.error?.code === 'ENOENT') {
    return {
      success: false,
      terminal: true,
      detail: 'GitHub CLI (`gh`) is not installed or not on PATH.',
      checks: []
    };
  }

  let checks: any[] = [];
  try {
    checks = JSON.parse(result.stdout || '[]');
  } catch {
    checks = [];
  }

  if (checks.length === 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return {
      success: false,
      terminal: result.code !== 8,
      detail: detail || `No GitHub checks were reported for ${target}.`,
      checks
    };
  }

  const buckets = new Set(checks.map((check) => check.bucket).filter(Boolean));
  const failed = checks.filter((check) => ['fail', 'cancel'].includes(check.bucket));
  const pending = checks.filter((check) => check.bucket === 'pending');
  const passed = checks.every((check) => ['pass', 'skipping'].includes(check.bucket));

  if (passed) {
    return {
      success: true,
      terminal: true,
      detail: `GitHub checks passed for ${target}.`,
      checks
    };
  }

  if (failed.length > 0) {
    return {
      success: false,
      terminal: true,
      detail: `GitHub checks failed: ${failed.map((check) => check.name).join(', ')}.`,
      checks
    };
  }

  return {
    success: false,
    terminal: false,
    detail: pending.length > 0
      ? `GitHub checks still pending: ${pending.map((check) => check.name).join(', ')}.`
      : `GitHub checks are not complete (${[...buckets].join(', ') || 'unknown'}).`,
    checks
  };
}

function extractGithubPrUrl(text) {
  const match = String(text || '').match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/);
  return match ? match[0] : '';
}

export async function getLinearDeliveryStatus(options: any = {}) {
  const {
    cwd = process.cwd(),
    delivery = {},
    env = process.env,
    fetchFn = fetch
  } = options;
  const paths = resolveDeliveryPaths(cwd, delivery);
  const authorization = resolveLinearAuthorization({ delivery, env, allowMissing: true });
  const state = await loadDeliveryState(paths.stateFile);
  let viewer = null;
  let authError = null;

  if (authorization) {
    try {
      viewer = await fetchLinearViewer({
        endpoint: delivery.endpoint,
        authorization,
        fetchFn
      });
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    provider: 'linear',
    configured: Boolean(authorization),
    authMethod: delivery.authMethod || 'api-key',
    endpoint: delivery.endpoint || 'https://api.linear.app/graphql',
    apiKeyEnv: delivery.apiKeyEnv || 'LINEAR_API_KEY',
    oauthTokenEnv: delivery.oauthTokenEnv || 'LINEAR_OAUTH_TOKEN',
    viewer,
    authError,
    stateFile: paths.stateFile,
    workspaceRoot: paths.workspaceRoot,
    observabilityLog: paths.eventsFile,
    state,
    counts: summarizeDeliveryState(state)
  };
}

export function renderLinearDeliveryStatus(status) {
  const lines = [
    'Linear integration status',
    `Auth: ${status.configured ? `configured (${status.authMethod})` : 'missing'}`,
    `Endpoint: ${status.endpoint}`,
    `State file: ${status.stateFile}`,
    `Workspace root: ${status.workspaceRoot}`,
    `Observability log: ${status.observabilityLog}`
  ];

  if (status.viewer) {
    lines.push(`Viewer: ${status.viewer.name || status.viewer.email || status.viewer.id}`);
  } else if (status.authError) {
    lines.push(`Viewer: unavailable (${status.authError})`);
  }

  lines.push('');
  lines.push('Setup');
  lines.push(`- API key auth: set ${status.apiKeyEnv} and use --linear-auth api-key.`);
  lines.push(`- OAuth auth: set ${status.oauthTokenEnv} and use --linear-auth oauth.`);
  lines.push('- Long-running mode: add --linear-watch with --linear-team/--linear-state filters.');
  lines.push('- Completion loop: add --linear-until-complete with --linear-project/--linear-epic and a completion gate.');
  lines.push('- Isolated workspaces are stored under the workspace root and state is persisted for reconciliation/retry.');
  lines.push('');
  lines.push('Local state');
  lines.push(`- total: ${status.counts.total}`);
  lines.push(`- delivered: ${status.counts.delivered}`);
  lines.push(`- review_ready: ${status.counts.review_ready}`);
  lines.push(`- ci_passed: ${status.counts.ci_passed}`);
  lines.push(`- running: ${status.counts.running}`);
  lines.push(`- retry_wait: ${status.counts.retry_wait}`);
  lines.push(`- failed: ${status.counts.failed}`);
  lines.push(`- ineligible: ${status.counts.ineligible}`);

  return lines.join('\n');
}

export function renderDeliveryResult(result) {
  const lines = [
    `Linear delivery: ${result.success ? 'completed' : 'failed'} (${result.issueCount} task${result.issueCount === 1 ? '' : 's'}, ${result.pollCount || 1} poll${(result.pollCount || 1) === 1 ? '' : 's'})`
  ];

  lines.push(`State: ${result.stateFile}`);
  lines.push(`Workspaces: ${result.workspaceRoot}`);
  lines.push(`Observability: ${result.observabilityLog}`);
  if (result.completionGate) {
    lines.push(`Completion gate: ${result.completionGate}`);
  }

  for (const issue of result.issues) {
    lines.push('');
    lines.push(`=== ${issue.issue.identifier}: ${issue.issue.title} ===`);
    lines.push(`Status: ${issue.success ? 'delivered' : issue.status || 'needs attention'}`);
    if (issue.issue.url) {
      lines.push(`Linear: ${issue.issue.url}`);
    }
    if (issue.workspace?.cwd) {
      lines.push(`Workspace: ${issue.workspace.cwd}`);
    }
    if (issue.nextRetryAt) {
      lines.push(`Next retry: ${issue.nextRetryAt}`);
    }
    if (issue.completion?.detail) {
      lines.push(`Completion: ${issue.completion.detail}`);
    }

    for (const phase of issue.phases) {
      const summary = phase.result.summary;
      lines.push(`- ${phase.phase}: ${summary?.status || 'unknown'} via ${summary?.name || 'none'}`);
    }

    for (const media of issue.mediaAttachments || []) {
      if (media.error) {
        lines.push(`- media: failed ${media.source} (${media.error})`);
      } else {
        lines.push(`- media: attached ${media.attachment?.title || media.source} -> ${media.url}`);
      }
    }
  }

  return lines.join('\n');
}

export function renderDeliveryProgressEvent(event) {
  switch (event.type) {
    case 'delivery_started':
      return `[delivery] linear started (${event.phases.join(' -> ')})${event.watch ? ' watch:on' : ''}`;
    case 'delivery_poll_started':
      return `[delivery] poll ${event.poll} started`;
    case 'delivery_poll_completed':
      return `[delivery] poll ${event.poll} completed fetched:${event.fetched} dispatched:${event.dispatched} skipped:${event.skipped}${event.complete ? ' complete' : ''}`;
    case 'delivery_issue_started':
      return `[delivery] ${event.issue.identifier}: ${event.issue.title}`;
    case 'delivery_issue_skipped':
      return `[delivery] ${event.issue.identifier}: skipped (${event.reason})`;
    case 'delivery_workspace_prepared':
      return `[delivery] ${event.issue.identifier}: workspace ${event.workspace.strategy} ${event.workspace.cwd}`;
    case 'delivery_phase_started':
      return `[delivery] ${event.issue.identifier}: ${event.phase} started`;
    case 'delivery_phase_completed':
      return `[delivery] ${event.issue.identifier}: ${event.phase} ${event.success ? 'ok' : 'failed'}`;
    case 'delivery_media_attach_started':
      return `[delivery] ${event.issue.identifier}: attaching media ${event.media}`;
    case 'delivery_media_attached':
      return `[delivery] ${event.issue.identifier}: attached media ${event.attachment.title}`;
    case 'delivery_media_attach_failed':
      return `[delivery] ${event.issue.identifier}: media attach failed (${event.detail})`;
    case 'delivery_retry_scheduled':
      return `[delivery] ${event.issue.identifier}: retry scheduled ${event.nextRetryAt}`;
    case 'delivery_completion_gate_passed':
      return `[delivery] ${event.issue.identifier}: ${event.gate} gate passed (${event.status})`;
    case 'delivery_completion_gate_failed':
      return `[delivery] ${event.issue.identifier}: ${event.gate} gate pending (${event.detail})`;
    case 'delivery_target_completed':
      return `[delivery] target completed via ${event.completionGate}`;
    case 'delivery_reconciled':
      return `[delivery] ${event.identifier}: reconciled as ${event.status}`;
    case 'delivery_issue_completed':
      return `[delivery] ${event.issue.identifier}: ${event.success ? 'delivered' : event.status || 'needs attention'}`;
    case 'delivery_completed':
      return `[delivery] linear ${event.success ? 'completed' : 'failed'}`;
    default:
      return '';
  }
}

function optionsForDeliveryPhase({ phase, issue, baseQuery, conversation, workflowPolicy, delivery = {} as any, councilOptions }) {
  const members = councilOptions.members || ['codex', 'claude', 'gemini'];
  const planner = pickPhasePlanner(phase, members, councilOptions.planner);
  const lead = pickPhaseLead(phase, members, councilOptions.lead);

  return {
    ...councilOptions,
    query: buildDeliveryPhasePrompt({
      phase,
      issue,
      baseQuery,
      members,
      planner,
      lead,
      workflowPolicy,
      completionGate: normalizeCompletionGate(delivery.completionGate),
      reviewState: delivery.reviewState || null
    }),
    members,
    planner,
    lead,
    handoff: phase !== 'plan' ? true : councilOptions.handoff,
    conversation
  };
}

export function buildDeliveryPhasePrompt({
  phase,
  issue,
  baseQuery = '',
  members = [],
  planner = null,
  lead = null,
  workflowPolicy = '',
  completionGate = 'delivered',
  reviewState = null
}) {
  const shared = [
    `Linear task: ${issue.identifier} - ${issue.title}`,
    issue.url ? `Linear URL: ${issue.url}` : null,
    issue.branchName ? `Suggested branch: ${issue.branchName}` : null,
    issue.project?.name ? `Linear project: ${issue.project.name}` : null,
    issue.epic?.identifier || issue.epic?.title
      ? `Linear epic: ${[issue.epic.identifier, issue.epic.title].filter(Boolean).join(' - ')}`
      : null,
    issue.state ? `Current state: ${issue.state}` : null,
    issue.labels?.length ? `Labels: ${issue.labels.join(', ')}` : null,
    issue.assignee ? `Assignee: ${issue.assignee}` : null,
    '',
    'Task description:',
    issue.description || '(no description provided)',
    workflowPolicy ? ['', 'Repository workflow policy:', workflowPolicy] : null,
    '',
    baseQuery ? `Operator guidance: ${baseQuery}` : null,
    `Council phase: ${phase}.`,
    `Completion gate: ${completionGate}.`,
    reviewState ? `Human-review Linear state: ${reviewState}.` : null,
    planner ? `Phase planner: ${planner}.` : null,
    lead ? `Phase lead: ${lead}.` : null,
    `Available providers: ${members.join(', ')}.`
  ].flat().filter(Boolean);

  if (phase === 'plan') {
    return [
      ...shared,
      '',
      'Create a concrete delivery plan. Identify files to inspect, likely implementation steps, tests to run, GitHub/PR requirements, and risks. Do not make code changes in this phase unless absolutely necessary.'
    ].join('\n');
  }

  if (phase === 'implement') {
    return [
      ...shared,
      '',
      'Implement the task in this isolated issue workspace. Use the prior plan and handoff context. Keep the change scoped to the Linear issue. Preserve user changes. Prepare the work so it can pass review.'
    ].join('\n');
  }

  if (phase === 'verify') {
    return [
      ...shared,
      '',
      'Verify the implementation in the isolated issue workspace. Run the relevant tests, typechecks, builds, linters, or targeted commands. Capture exact command outcomes. If something fails, fix what is in scope and rerun the relevant checks.'
    ].join('\n');
  }

  return [
    ...shared,
    '',
    'Ship the work from the isolated issue workspace. Inspect git status and diff, scan for secrets, commit with the issue context, push a branch, open or update the GitHub PR, and leave Linear/GitHub-ready proof of work including tests run and any residual risks.',
    completionGate === 'ci-success'
      ? 'This delivery is not complete until GitHub CI/CD checks pass. Include the PR URL and exact check status.'
      : completionGate === 'human-review'
        ? 'This delivery is complete when it is ready for human review. Include the PR URL or branch, and update or report the review state when available.'
        : completionGate === 'review-or-ci'
          ? 'This delivery is complete when it is ready for human review or GitHub CI/CD checks pass. Include the PR URL or branch and exact check status when available.'
          : 'If authenticated tooling for GitHub or Linear is unavailable, report the exact blocker and leave the local branch ready.'
  ].join('\n');
}

async function prepareIssueWorkspace({ cwd, issue, delivery, paths }) {
  const strategy = delivery.workspaceStrategy || (delivery.watch ? 'worktree' : 'none');
  if (strategy === 'none') {
    return {
      cwd,
      strategy: 'none',
      branch: null
    };
  }

  const workspaceName = safeWorkspaceName(issue.identifier || issue.id);
  const workspacePath = path.join(paths.workspaceRoot, workspaceName);
  const branch = `${delivery.branchPrefix || DEFAULT_BRANCH_PREFIX}${workspaceName}`;
  await mkdir(paths.workspaceRoot, { recursive: true });

  if (await pathExists(workspacePath)) {
    return {
      cwd: workspacePath,
      strategy,
      branch
    };
  }

  if (strategy === 'worktree') {
    try {
      await runProcess('git', ['worktree', 'add', '-B', branch, workspacePath, 'HEAD'], cwd);
      return {
        cwd: workspacePath,
        strategy: 'worktree',
        branch
      };
    } catch {
      await copyWorkspace(cwd, workspacePath);
      return {
        cwd: workspacePath,
        strategy: 'copy',
        branch: null
      };
    }
  }

  await copyWorkspace(cwd, workspacePath);
  return {
    cwd: workspacePath,
    strategy: 'copy',
    branch: null
  };
}

async function copyWorkspace(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return !['.git', '.council', 'node_modules', 'dist'].includes(name);
    }
  });
}

function shouldDispatchIssue({ issue, state, maxAttempts, now }) {
  const issueState = state.issues[issue.identifier];
  if (!issueState) {
    return true;
  }

  if (isTerminalDeliveryStatus(issueState.status) || issueState.status === 'running') {
    return false;
  }

  if (issueState.attempts >= maxAttempts && issueState.status === 'failed') {
    return false;
  }

  if (issueState.nextRetryAt && Date.parse(issueState.nextRetryAt) > now) {
    return false;
  }

  return true;
}

function isDeliveryTargetComplete({ delivery, issues, state, completionGate }) {
  if (!delivery.untilComplete) {
    return false;
  }

  if (issues.length === 0) {
    return hasScopedLinearTarget(delivery);
  }

  return issues.every((issue) =>
    isTerminalDeliveryStatus(state.issues[issue.identifier]?.status, completionGate)
  );
}

function hasScopedLinearTarget(delivery: any = {}) {
  return Boolean(
    delivery.issueIds?.length ||
    delivery.projects?.length ||
    delivery.epics?.length ||
    delivery.query ||
    delivery.team ||
    delivery.state ||
    delivery.assignee
  );
}

function isTerminalDeliveryStatus(status, completionGate = 'delivered') {
  if (!TERMINAL_ISSUE_STATUSES.includes(status)) {
    return false;
  }

  if (completionGate === 'ci-success') {
    return status === 'ci_passed';
  }

  if (completionGate === 'human-review') {
    return status === 'review_ready' || status === 'ci_passed';
  }

  if (completionGate === 'review-or-ci') {
    return status === 'review_ready' || status === 'ci_passed';
  }

  return true;
}

async function reconcileDeliveryState({ state, issues, context, enabled }) {
  if (!enabled) {
    return;
  }

  const active = new Set(issues.map((issue) => issue.identifier));
  for (const [identifier, issueState] of Object.entries(state.issues) as any) {
    if (
      !active.has(identifier) &&
      ['queued', 'running', 'retry_wait'].includes(issueState.status)
    ) {
      issueState.status = 'ineligible';
      issueState.ineligibleAt = isoNow(context.nowFn);
      await emitDeliveryEvent(context, 'delivery_reconciled', {
        identifier,
        status: 'ineligible'
      });
    }
  }
}

function scheduleRetry({ issueState, maxAttempts, retryBaseMs, now }) {
  if (issueState.attempts >= maxAttempts) {
    issueState.status = 'failed';
    issueState.nextRetryAt = null;
    return;
  }

  const delay = retryBaseMs * Math.max(1, 2 ** Math.max(0, issueState.attempts - 1));
  issueState.status = 'retry_wait';
  issueState.nextRetryAt = new Date(now + delay).toISOString();
}

function effectiveMaxAttempts(delivery: any = {}) {
  return delivery.maxAttempts === null ||
    (delivery.untilComplete && delivery.maxAttempts === undefined)
    ? Number.POSITIVE_INFINITY
    : delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS;
}

function normalizeCompletionGate(value) {
  return COMPLETION_GATES.includes(value) ? value : 'delivered';
}

function sameText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function ensureIssueState(state, issue) {
  const existing = state.issues[issue.identifier];
  if (existing) {
    existing.issueId = issue.id;
    existing.title = issue.title;
    existing.url = issue.url || null;
    existing.project = issue.project || null;
    existing.epic = issue.epic || null;
    existing.updatedAt = issue.updatedAt || null;
    return existing;
  }

  const next = {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url || null,
    project: issue.project || null,
    epic: issue.epic || null,
    status: 'queued',
    attempts: 0,
    workspace: null,
    workspaceStrategy: null,
    branch: null,
    phases: [],
    lastAttemptAt: null,
    nextRetryAt: null,
    lastError: null,
    deliveredAt: null,
    updatedAt: issue.updatedAt || null
  };
  state.issues[issue.identifier] = next;
  return next;
}

function summarizeDeliveryState(state) {
  const counts = {
    total: 0,
    delivered: 0,
    review_ready: 0,
    ci_passed: 0,
    running: 0,
    retry_wait: 0,
    failed: 0,
    ineligible: 0
  };

  for (const issue of Object.values(state.issues) as any) {
    counts.total += 1;
    if (counts[issue.status] !== undefined) {
      counts[issue.status] += 1;
    }
  }

  return counts;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      results.push(await worker(item));
    }
  }));

  return results;
}

function resolveDeliveryPaths(cwd, delivery: any = {}) {
  const councilDir = path.resolve(cwd, '.council');
  const stateFile = resolvePath(cwd, delivery.stateFile) ||
    path.join(councilDir, 'linear-delivery-state.json');
  const workspaceRoot = resolvePath(cwd, delivery.workspaceRoot) ||
    path.join(councilDir, 'linear-workspaces');
  const observabilityDir = resolvePath(cwd, delivery.observabilityDir) ||
    path.join(councilDir, 'linear-observability');

  return {
    stateFile,
    workspaceRoot,
    observabilityDir,
    eventsFile: path.join(observabilityDir, 'events.jsonl')
  };
}

function resolvePath(cwd, value) {
  if (!value) {
    return null;
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function resolveLinearAuthorization({ delivery = {}, env = process.env, allowMissing = false }: any) {
  const method = delivery.authMethod || 'api-key';
  const envName = method === 'oauth'
    ? delivery.oauthTokenEnv || 'LINEAR_OAUTH_TOKEN'
    : delivery.apiKeyEnv || 'LINEAR_API_KEY';
  const value = readEnvValue(env, envName);

  if (value) {
    return method === 'oauth' && !value.startsWith('Bearer ')
      ? `Bearer ${value}`
      : value;
  }

  if (allowMissing) {
    return '';
  }

  throw new Error(
    method === 'oauth'
      ? `Linear delivery requires an OAuth token. Set ${envName} or pass --linear-oauth-token-env.`
      : `Linear delivery requires an API key. Set ${envName} or pass --linear-api-key-env.`
  );
}

async function loadDeliveryState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    return {
      version: 1,
      createdAt: parsed.createdAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || null,
      issues: parsed.issues || {}
    };
  } catch {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      issues: {}
    };
  }
}

async function writeDeliveryState(stateFile, state, context) {
  state.updatedAt = isoNow(context.nowFn);
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function ensureDeliveryDirs(paths) {
  await mkdir(path.dirname(paths.stateFile), { recursive: true });
  await mkdir(paths.workspaceRoot, { recursive: true });
  await mkdir(paths.observabilityDir, { recursive: true });
}

async function emitDeliveryEvent(context, type, payload) {
  const event = {
    type,
    at: isoNow(context.nowFn),
    ...payload
  };
  context.onEvent(event);
  await appendObservabilityEvent(context.paths.eventsFile, event);
}

async function appendObservabilityEvent(eventsFile, event) {
  await mkdir(path.dirname(eventsFile), { recursive: true });
  await appendFile(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
}

async function readWorkflowPolicy(cwd, workflowFile) {
  const file = resolvePath(cwd, workflowFile || DEFAULT_WORKFLOW_FILE);
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function runProcess(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, 'close');
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

async function runProcessCapture(command, args, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        command,
        args,
        code: null,
        signal: null,
        stdout,
        stderr,
        error
      });
    });
    child.on('close', (code, signal) => {
      resolve({
        command,
        args,
        code,
        signal,
        stdout,
        stderr,
        error: null
      });
    });
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pickPhasePlanner(phase, members, requestedPlanner) {
  if (requestedPlanner && members.includes(requestedPlanner)) {
    return requestedPlanner;
  }

  if (phase === 'plan') {
    return members[0] || null;
  }

  return members.includes('codex') ? 'codex' : members[0] || null;
}

function pickPhaseLead(phase, members, requestedLead) {
  if (requestedLead && members.includes(requestedLead)) {
    return requestedLead;
  }

  if (phase === 'verify' && members.includes('gemini')) {
    return 'gemini';
  }

  return members.includes('codex') ? 'codex' : members[0] || null;
}

function safeWorkspaceName(value) {
  return String(value || 'issue')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'issue';
}

function isoNow(nowFn) {
  return new Date(nowFn()).toISOString();
}

function readEnvValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
