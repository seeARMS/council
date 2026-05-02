import { runCouncil } from './council.js';
import { fetchLinearIssues } from './linear.js';

const DEFAULT_DELIVERY_PHASES = ['plan', 'implement', 'verify', 'ship'];

export async function runLinearDelivery(options: any = {}) {
  const {
    baseQuery = '',
    cwd = process.cwd(),
    delivery = {},
    env = process.env,
    fetchFn = fetch,
    runner = runCouncil,
    onEvent = () => {},
    ...councilOptions
  } = options;
  const startedAt = Date.now();
  const apiKey = readEnvValue(env, delivery.apiKeyEnv || 'LINEAR_API_KEY');
  const phases = delivery.phases?.length > 0
    ? delivery.phases
    : DEFAULT_DELIVERY_PHASES;

  emitDeliveryEvent(onEvent, 'delivery_started', {
    provider: 'linear',
    phases,
    issueIds: delivery.issueIds || []
  });

  const issues = await fetchLinearIssues({
    issueIds: delivery.issueIds || [],
    query: delivery.query,
    team: delivery.team,
    state: delivery.state,
    assignee: delivery.assignee,
    limit: delivery.limit || 3,
    endpoint: delivery.endpoint,
    apiKey,
    fetchFn
  });
  const issueResults = [];

  for (const issue of issues) {
    emitDeliveryEvent(onEvent, 'delivery_issue_started', {
      issue
    });

    const phaseResults = [];
    const conversation = [];

    for (const phase of phases) {
      emitDeliveryEvent(onEvent, 'delivery_phase_started', {
        issue,
        phase
      });

      const phaseOptions = optionsForDeliveryPhase({
        phase,
        issue,
        baseQuery,
        conversation,
        councilOptions
      });
      const result = await runner({
        ...phaseOptions,
        cwd,
        env,
        onEvent
      });

      const success = Boolean(result.summary?.status === 'ok');

      phaseResults.push({
        phase,
        result
      });
      conversation.push({
        user: phaseOptions.query,
        assistant: result.summary?.output || result.summary?.detail || ''
      });

      emitDeliveryEvent(onEvent, 'delivery_phase_completed', {
        issue,
        phase,
        success,
        result
      });

      if (!success) {
        break;
      }
    }

    const issueSuccess = phaseResults.every((phase) => phase.result.summary?.status === 'ok');
    issueResults.push({
      issue,
      success: issueSuccess,
      phases: phaseResults
    });

    emitDeliveryEvent(onEvent, 'delivery_issue_completed', {
      issue,
      success: issueSuccess
    });
  }

  const finalResult = {
    provider: 'linear',
    success: issueResults.length > 0 && issueResults.every((issue) => issue.success),
    durationMs: Date.now() - startedAt,
    issueCount: issueResults.length,
    phases,
    issues: issueResults
  };

  emitDeliveryEvent(onEvent, 'delivery_completed', {
    success: finalResult.success,
    result: finalResult
  });

  return finalResult;
}

export function renderDeliveryResult(result) {
  const lines = [
    `Linear delivery: ${result.success ? 'completed' : 'failed'} (${result.issueCount} task${result.issueCount === 1 ? '' : 's'})`
  ];

  for (const issue of result.issues) {
    lines.push('');
    lines.push(`=== ${issue.issue.identifier}: ${issue.issue.title} ===`);
    lines.push(`Status: ${issue.success ? 'delivered' : 'needs attention'}`);
    if (issue.issue.url) {
      lines.push(`Linear: ${issue.issue.url}`);
    }

    for (const phase of issue.phases) {
      const summary = phase.result.summary;
      lines.push(`- ${phase.phase}: ${summary?.status || 'unknown'} via ${summary?.name || 'none'}`);
    }
  }

  return lines.join('\n');
}

export function renderDeliveryProgressEvent(event) {
  switch (event.type) {
    case 'delivery_started':
      return `[delivery] linear started (${event.phases.join(' -> ')})`;
    case 'delivery_issue_started':
      return `[delivery] ${event.issue.identifier}: ${event.issue.title}`;
    case 'delivery_phase_started':
      return `[delivery] ${event.issue.identifier}: ${event.phase} started`;
    case 'delivery_phase_completed':
      return `[delivery] ${event.issue.identifier}: ${event.phase} ${event.success ? 'ok' : 'failed'}`;
    case 'delivery_issue_completed':
      return `[delivery] ${event.issue.identifier}: ${event.success ? 'delivered' : 'needs attention'}`;
    case 'delivery_completed':
      return `[delivery] linear ${event.success ? 'completed' : 'failed'}`;
    default:
      return '';
  }
}

function optionsForDeliveryPhase({ phase, issue, baseQuery, conversation, councilOptions }) {
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
      lead
    }),
    members,
    planner,
    lead,
    handoff: phase !== 'plan' ? true : councilOptions.handoff,
    conversation
  };
}

export function buildDeliveryPhasePrompt({ phase, issue, baseQuery = '', members = [], planner = null, lead = null }) {
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
    '',
    baseQuery ? `Operator guidance: ${baseQuery}` : null,
    `Council phase: ${phase}.`,
    planner ? `Phase planner: ${planner}.` : null,
    lead ? `Phase lead: ${lead}.` : null,
    `Available providers: ${members.join(', ')}.`
  ].filter(Boolean);

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
      'Implement the task in this repository. Use the prior plan and handoff context. Keep the change scoped to the Linear issue. Preserve user changes. Prepare the work so it can pass review.'
    ].join('\n');
  }

  if (phase === 'verify') {
    return [
      ...shared,
      '',
      'Verify the implementation. Run the relevant tests, typechecks, builds, linters, or targeted commands. Capture exact command outcomes. If something fails, fix what is in scope and rerun the relevant checks.'
    ].join('\n');
  }

  return [
    ...shared,
    '',
    'Ship the work. Inspect git status and diff, scan for secrets, commit with the issue context, push a branch, open or update the GitHub PR, and leave Linear/GitHub-ready proof of work including tests run and any residual risks. If authenticated tooling for GitHub or Linear is unavailable, report the exact blocker and leave the local branch ready.'
  ].join('\n');
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

function emitDeliveryEvent(onEvent, type, payload) {
  onEvent({
    type,
    at: new Date().toISOString(),
    ...payload
  });
}

function readEnvValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
