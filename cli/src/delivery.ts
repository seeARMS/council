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
const DEFAULT_BRANCH_PREFIX = 'council/linear/';
const DEFAULT_WORKFLOW_FILE = 'WORKFLOW.md';

export async function runLinearDelivery(options: any = {}) {
  const {
    baseQuery = '',
    cwd = process.cwd(),
    delivery = {},
    env = process.env,
    fetchFn = fetch,
    runner = runCouncil,
    workspaceFactory = prepareIssueWorkspace,
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
  const context = {
    paths,
    onEvent,
    nowFn
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
    watch: Boolean(delivery.watch),
    pollIntervalMs: delivery.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
    maxConcurrency: delivery.maxConcurrency || DEFAULT_MAX_CONCURRENCY,
    maxAttempts: delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS,
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
      councilOptions,
      context,
      poll: pollCount
    });
    pollResults.push(pollResult);

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
  councilOptions,
  context,
  poll
}) {
  await emitDeliveryEvent(context, 'delivery_poll_started', { poll });

  const issues = await fetchLinearIssues({
    issueIds: delivery.issueIds || [],
    query: delivery.query,
    team: delivery.team,
    state: delivery.state,
    assignee: delivery.assignee,
    limit: delivery.limit || 3,
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

  const eligibleIssues = issues.filter((issue) =>
    shouldDispatchIssue({
      issue,
      state,
      maxAttempts: delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      now: context.nowFn()
    })
  );
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
      councilOptions,
      context
    })
  );

  await writeDeliveryState(context.paths.stateFile, state, context);
  await emitDeliveryEvent(context, 'delivery_poll_completed', {
    poll,
    fetched: issues.length,
    dispatched: eligibleIssues.length,
    skipped: skippedIssues.length
  });

  return {
    poll,
    fetched: issues.length,
    dispatched: eligibleIssues.length,
    skipped: skippedIssues.length,
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
    maxAttempts: delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS
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

  if (issueSuccess) {
    issueState.status = 'delivered';
    issueState.deliveredAt = isoNow(context.nowFn);
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
  } else {
    scheduleRetry({
      issueState,
      maxAttempts: delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      retryBaseMs: delivery.retryBaseMs || DEFAULT_RETRY_BASE_MS,
      now: context.nowFn()
    });
    if (issueState.status === 'retry_wait') {
      await emitDeliveryEvent(context, 'delivery_retry_scheduled', {
        issue,
        attempts: issueState.attempts,
        nextRetryAt: issueState.nextRetryAt
      });
    }
  }

  const finalIssueSuccess = issueSuccess &&
    mediaAttachments.every((attachment) => !attachment.error);
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
    phases: phaseResults,
    mediaAttachments
  };
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
  lines.push('- Isolated workspaces are stored under the workspace root and state is persisted for reconciliation/retry.');
  lines.push('');
  lines.push('Local state');
  lines.push(`- total: ${status.counts.total}`);
  lines.push(`- delivered: ${status.counts.delivered}`);
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
      return `[delivery] poll ${event.poll} completed fetched:${event.fetched} dispatched:${event.dispatched} skipped:${event.skipped}`;
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

function optionsForDeliveryPhase({ phase, issue, baseQuery, conversation, workflowPolicy, councilOptions }) {
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
      workflowPolicy
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
  workflowPolicy = ''
}) {
  const shared = [
    `Linear task: ${issue.identifier} - ${issue.title}`,
    issue.url ? `Linear URL: ${issue.url}` : null,
    issue.branchName ? `Suggested branch: ${issue.branchName}` : null,
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
    'Ship the work from the isolated issue workspace. Inspect git status and diff, scan for secrets, commit with the issue context, push a branch, open or update the GitHub PR, and leave Linear/GitHub-ready proof of work including tests run and any residual risks. If authenticated tooling for GitHub or Linear is unavailable, report the exact blocker and leave the local branch ready.'
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

  if (issueState.status === 'delivered' || issueState.status === 'running') {
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

function ensureIssueState(state, issue) {
  const existing = state.issues[issue.identifier];
  if (existing) {
    existing.issueId = issue.id;
    existing.title = issue.title;
    existing.url = issue.url || null;
    existing.updatedAt = issue.updatedAt || null;
    return existing;
  }

  const next = {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url || null,
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
