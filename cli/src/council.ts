import {
  ALL_ENGINES,
  AUTO_SUMMARIZER,
  DEFAULT_ITERATIONS,
  DEFAULT_MAX_MEMBER_CHARS,
  DEFAULT_PROVIDER_AUTHS,
  DEFAULT_PROVIDER_PERMISSIONS,
  DEFAULT_TEAM_SIZE,
  DEFAULT_SUMMARIZER_ORDER,
  estimateTokens,
  buildMemberPrompt,
  buildSummaryPrompt,
  runEngine
} from './engines.js';

export async function runCouncil(options: any = {}) {
  const {
  query,
  cwd = process.cwd(),
  members = ALL_ENGINES,
  summarizer = AUTO_SUMMARIZER,
  timeoutMs,
  maxMemberChars = DEFAULT_MAX_MEMBER_CHARS,
  conversation = [],
  env = process.env,
  effort = null,
  models = {},
  efforts = {},
  permissions = {},
  auths = {},
  handoff = false,
  lead = null,
  planner = null,
  iterations = DEFAULT_ITERATIONS,
  teamWork = DEFAULT_TEAM_SIZE,
  teams = {},
  onEvent = () => {}
  } = options;
  const resolvedModels = resolveEngineSettings(models, null);
  const resolvedEfforts = resolveEngineSettings(efforts, effort);
  const resolvedPermissions = resolveEngineSettings(
    permissions,
    null,
    DEFAULT_PROVIDER_PERMISSIONS
  );
  const resolvedAuths = resolveEngineSettings(
    auths,
    null,
    DEFAULT_PROVIDER_AUTHS
  );
  const iterationCount = normalizeIterationCount(iterations);
  const teamWorkSize = normalizeTeamSize(teamWork);
  const resolvedTeams = resolveEngineSettings(
    teams,
    teamWorkSize
  ) as any;
  const workflow = {
    handoff: Boolean(handoff),
    lead,
    planner,
    iterations: iterationCount,
    teamWork: teamWorkSize,
    teams: resolvedTeams
  };
  validateWorkflowSelection({ members, workflow });

  emitEvent(onEvent, 'run_started', {
    cwd,
    members: [...members],
    summarizer,
    effort,
    models: resolvedModels,
    efforts: resolvedEfforts,
    permissions: resolvedPermissions,
    auths: resolvedAuths,
    workflow
  });

  const iterationResults = [];
  let memberRuns = [];
  let previousIterationMembers = [];

  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    emitEvent(onEvent, 'iteration_started', {
      iteration,
      totalIterations: iterationCount,
      workflow
    });

    memberRuns = await runCouncilIteration({
      query,
      cwd,
      members,
      timeoutMs,
      conversation,
      env,
      resolvedEfforts,
      resolvedModels,
      resolvedPermissions,
      resolvedAuths,
      workflow,
      iteration,
      previousIterationMembers,
      onEvent
    });

    previousIterationMembers = memberRuns;
    iterationResults.push({
      iteration,
      members: memberRuns
    });

    emitEvent(onEvent, 'iteration_completed', {
      iteration,
      totalIterations: iterationCount,
      members: memberRuns
    });
  }

  const successfulMembers = memberRuns.filter((result) => result.status === 'ok');
  const summaryAttempts = [];
  let summary = null;

  if (successfulMembers.length > 0) {
    const summaryPrompt = buildSummaryPrompt(query, successfulMembers, {
      maxMemberChars,
      conversation,
      lead: workflow.lead,
      planner: workflow.planner,
      iterations: workflow.iterations,
      handoff: workflow.handoff,
      teams: workflow.teams
    });
    const candidateSummarizers = pickSummarizerCandidates(
      summarizer,
      successfulMembers,
      workflow.lead
    );

    for (const candidate of candidateSummarizers) {
      const attempt = await runSummaryAttempt(candidate, {
        prompt: summaryPrompt,
        cwd,
        timeoutMs,
        env,
        effort: resolvedEfforts[candidate],
        model: resolvedModels[candidate],
        permission: resolvedPermissions[candidate],
        auth: resolvedAuths[candidate],
        role: roleForEngine(candidate, workflow),
        iteration: iterationCount,
        totalIterations: iterationCount,
        teamSize: resolvedTeams[candidate],
        onEvent
      });
      summaryAttempts.push(attempt);

      if (attempt.status === 'ok') {
        summary = attempt;
        break;
      }

      if (summarizer !== AUTO_SUMMARIZER) {
        summary = attempt;
        break;
      }
    }

    if (!summary) {
      summary = summaryAttempts.at(-1) ?? {
        name: null,
        status: 'error',
        detail: 'No summarizer could be started.'
      };
    }
  } else {
    summary = {
      name: summarizer === AUTO_SUMMARIZER ? null : summarizer,
      status: 'error',
      detail: summarizeNoResponse(memberRuns)
    };
  }

  const finalResult = {
    query,
    cwd,
    membersRequested: [...members],
    summarizerRequested: summarizer,
    effort,
    models: resolvedModels,
    efforts: resolvedEfforts,
    permissions: resolvedPermissions,
    auths: resolvedAuths,
    workflow,
    iterations: iterationCount,
    iterationResults,
    members: memberRuns,
    summaryAttempts,
    summary,
    summaryContextLimit: maxMemberChars
  };

  emitEvent(onEvent, 'run_completed', {
    success: isCouncilSuccess(finalResult),
    result: finalResult
  });

  return finalResult;
}

export function isCouncilSuccess(result) {
  return result.members.some((member) => member.status === 'ok') && result.summary?.status === 'ok';
}

function pickSummarizerCandidates(requestedSummarizer, successfulMembers, lead = null) {
  if (requestedSummarizer !== AUTO_SUMMARIZER) {
    return [requestedSummarizer];
  }

  const successfulNames = new Set(successfulMembers.map((member) => member.name));
  const preferred = lead && successfulNames.has(lead) ? [lead] : [];
  return [
    ...preferred,
    ...DEFAULT_SUMMARIZER_ORDER.filter(
      (name) => successfulNames.has(name) && !preferred.includes(name)
    )
  ];
}

function summarizeNoResponse(memberRuns) {
  const actionableFailure = memberRuns.find(
    (member) => member.status !== 'missing' && member.detail
  );

  if (actionableFailure) {
    return actionableFailure.detail;
  }

  if (memberRuns.length === 1 && memberRuns[0].detail) {
    return memberRuns[0].detail;
  }

  return 'No council member produced a response.';
}

async function runCouncilIteration({
  query,
  cwd,
  members,
  timeoutMs,
  conversation,
  env,
  resolvedEfforts,
  resolvedModels,
  resolvedPermissions,
  resolvedAuths,
  workflow,
  iteration,
  previousIterationMembers,
  onEvent
}) {
  const orderedMembers = executionOrderForMembers(members, workflow.planner);
  const previousResponses = previousIterationMembers.length > 0
    ? [...previousIterationMembers]
    : [];
  const planResult = [];

  if (workflow.handoff) {
    const results = [];

    for (const name of orderedMembers) {
      const role = roleForEngine(name, workflow);
      const prompt = buildMemberPrompt(query, {
        conversation,
        role,
        lead: workflow.lead,
        planner: workflow.planner,
        iteration,
        totalIterations: workflow.iterations,
        handoff: workflow.handoff,
        previousResponses: [...previousResponses, ...results],
        planOutput: planResult[0]?.output || '',
        teamSize: workflow.teams[name]
      });
      const result = await runMember(name, {
        prompt,
        cwd,
        timeoutMs,
        env,
        effort: resolvedEfforts[name],
        model: resolvedModels[name],
        permission: resolvedPermissions[name],
        auth: resolvedAuths[name],
        role,
        iteration,
        totalIterations: workflow.iterations,
        teamSize: workflow.teams[name],
        onEvent
      });
      results.push(result);

      if (name === workflow.planner) {
        planResult[0] = result;
      }
    }

    return results;
  }

  const plannerName = workflow.planner && orderedMembers.includes(workflow.planner)
    ? workflow.planner
    : null;
  const results = [];
  let plannerOutput = '';

  if (plannerName) {
    const role = roleForEngine(plannerName, workflow);
    const prompt = buildMemberPrompt(query, {
      conversation,
      role,
      lead: workflow.lead,
      planner: workflow.planner,
      iteration,
      totalIterations: workflow.iterations,
      handoff: workflow.handoff,
      previousResponses,
      teamSize: workflow.teams[plannerName]
    });
    const plannerRun = await runMember(plannerName, {
      prompt,
      cwd,
      timeoutMs,
      env,
      effort: resolvedEfforts[plannerName],
      model: resolvedModels[plannerName],
      permission: resolvedPermissions[plannerName],
      auth: resolvedAuths[plannerName],
      role,
      iteration,
      totalIterations: workflow.iterations,
      teamSize: workflow.teams[plannerName],
      onEvent
    });

    results.push(plannerRun);
    plannerOutput = plannerRun.status === 'ok' ? plannerRun.output : '';
  }

  const executorNames = orderedMembers.filter((name) => name !== plannerName);
  const executorRuns = await Promise.all(
    executorNames.map((name) => {
      const role = roleForEngine(name, workflow);
      const prompt = buildMemberPrompt(query, {
        conversation,
        role,
        lead: workflow.lead,
        planner: workflow.planner,
        iteration,
        totalIterations: workflow.iterations,
        handoff: workflow.handoff,
        previousResponses,
        planOutput: plannerOutput,
        teamSize: workflow.teams[name]
      });

      return runMember(name, {
        prompt,
        cwd,
        timeoutMs,
        env,
        effort: resolvedEfforts[name],
        model: resolvedModels[name],
        permission: resolvedPermissions[name],
        auth: resolvedAuths[name],
        role,
        iteration,
        totalIterations: workflow.iterations,
        teamSize: workflow.teams[name],
        onEvent
      });
    })
  );

  return [...results, ...executorRuns];
}

async function runMember(
  name,
  {
    prompt,
    cwd,
    timeoutMs,
    env,
    effort,
    model,
    permission,
    auth,
    role,
    iteration,
    totalIterations,
    teamSize,
    onEvent
  }
) {
  emitEvent(onEvent, 'member_started', {
    name,
    role,
    iteration,
    totalIterations,
    teamSize,
    auth,
    tokenUsage: {
      input: estimateTokens(prompt),
      output: 0,
      total: estimateTokens(prompt),
      estimated: true,
      source: 'prompt'
    }
  });

  const result = await runEngineTask({
    kind: 'member',
    name,
    prompt,
    cwd,
    timeoutMs,
    env,
    effort,
    model,
    permission,
    auth,
    role,
    iteration,
    totalIterations,
    teamSize,
    onEvent
  });

  emitEvent(onEvent, 'member_completed', {
    result
  });

  return result;
}

async function runSummaryAttempt(
  name,
  {
    prompt,
    cwd,
    timeoutMs,
    env,
    effort,
    model,
    permission,
    auth,
    role,
    iteration,
    totalIterations,
    teamSize,
    onEvent
  }
) {
  emitEvent(onEvent, 'summary_started', {
    name,
    role,
    iteration,
    totalIterations,
    teamSize,
    auth,
    tokenUsage: {
      input: estimateTokens(prompt),
      output: 0,
      total: estimateTokens(prompt),
      estimated: true,
      source: 'prompt'
    }
  });

  const result = await runEngineTask({
    kind: 'summary',
    name,
    prompt,
    cwd,
    timeoutMs,
    env,
    effort,
    model,
    permission,
    auth,
    role,
    iteration,
    totalIterations,
    teamSize,
    onEvent
  });

  emitEvent(onEvent, 'summary_completed', {
    result
  });

  return result;
}

function emitEvent(onEvent, type, payload) {
  onEvent({
    type,
    at: new Date().toISOString(),
    ...payload
  });
}

async function runWithHeartbeat({ kind, name, onEvent, task }) {
  const startedAt = Date.now();
  const intervalMs = 10_000;
  const timer = setInterval(() => {
    emitEvent(onEvent, `${kind}_heartbeat`, {
      name,
      elapsedMs: Date.now() - startedAt
    });
  }, intervalMs);

  timer.unref?.();

  try {
    return await task((progress) => {
      emitEvent(onEvent, `${kind}_progress`, {
        name,
        ...progress
      });
    });
  } finally {
    clearInterval(timer);
  }
}

async function runEngineTask({
  kind,
  name,
  prompt,
  cwd,
  timeoutMs,
  env,
  effort,
  model,
  permission,
  auth,
  role,
  iteration,
  totalIterations,
  teamSize,
  onEvent
}) {
  const startedAt = Date.now();

  try {
    const result = await runWithHeartbeat({
      kind,
      name,
      onEvent,
      task: (onProgress) =>
        runEngine(name, {
          prompt,
          cwd,
          timeoutMs,
          env,
          effort,
          model,
          permission,
          auth,
          onProgress
        })
    });
    return {
      ...result,
      role,
      iteration,
      totalIterations,
      teamSize,
      auth
    };
  } catch (error) {
    return {
      ...unexpectedEngineFailure(name, error, Date.now() - startedAt),
      role,
      iteration,
      totalIterations,
      teamSize,
      auth
    };
  }
}

function resolveEngineSettings(overrides, fallback, defaults = {}) {
  const resolved = {};

  for (const engine of ALL_ENGINES) {
    resolved[engine] = overrides?.[engine] ?? defaults?.[engine] ?? fallback ?? null;
  }

  return resolved;
}

function executionOrderForMembers(members, planner) {
  if (!planner || !members.includes(planner)) {
    return [...members];
  }

  return [
    planner,
    ...members.filter((name) => name !== planner)
  ];
}

function roleForEngine(name, workflow) {
  const isLead = workflow.lead === name;
  const isPlanner = workflow.planner === name;

  if (isLead && isPlanner) {
    return 'lead+planner';
  }

  if (isPlanner) {
    return 'planner';
  }

  if (isLead) {
    return 'lead';
  }

  return 'executor';
}

function validateWorkflowSelection({ members, workflow }) {
  for (const [role, name] of Object.entries({
    lead: workflow.lead,
    planner: workflow.planner
  })) {
    if (name && !members.includes(name)) {
      throw new Error(`--${role} must be one of the enabled members: ${members.join(', ')}`);
    }
  }
}

function normalizeIterationCount(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--iterations requires a positive integer.`);
  }

  return parsed;
}

function normalizeTeamSize(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Team work size must be a non-negative integer.`);
  }

  return parsed;
}

function unexpectedEngineFailure(name, error, durationMs) {
  return {
    name,
    bin: null,
    status: 'error',
    durationMs,
    detail: formatUnexpectedError(error),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    output: '',
    tokenUsage: {
      input: 0,
      output: 0,
      total: 0,
      estimated: true,
      source: 'error'
    },
    toolUsage: [],
    command: ''
  };
}

function formatUnexpectedError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return 'Unexpected runtime error.';
}
