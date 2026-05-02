export function summaryTextForConversation(result) {
  if (result.summary?.status === 'ok') {
    return result.summary.output;
  }

  if (result.summary?.name) {
    return `Summary failed via ${result.summary.name}: ${result.summary.detail || 'Unknown error.'}`;
  }

  return `Summary failed: ${result.summary?.detail || 'Unknown error.'}`;
}

export function createCouncilRuntimeFailureResult({
  query,
  cwd,
  members,
  summarizer,
  maxMemberChars,
  error
}) {
  return {
    query,
    cwd,
    membersRequested: [...members],
    summarizerRequested: summarizer,
    workflow: {
      handoff: false,
      lead: null,
      planner: null,
      iterations: 1,
      teamWork: 0,
      teams: {
        codex: 0,
        claude: 0,
        gemini: 0
      }
    },
    iterations: 1,
    iterationResults: [],
    members: [],
    summaryAttempts: [],
    summary: {
      name: null,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      output: ''
    },
    summaryContextLimit: maxMemberChars
  };
}

export function createSessionState(members) {
  return {
    workflow: {
      handoff: false,
      lead: null,
      planner: null,
      iterations: 1,
      teamWork: 0,
      teams: {}
    },
    iteration: {
      current: 1,
      total: 1
    },
    items: members.map((name) => ({
      name,
      role: 'executor',
      teamSize: 0,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      result: null,
      progressDetail: ''
    })),
    summaryItem: {
      name: 'synthesis',
      summarizerName: null,
      role: null,
      teamSize: 0,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      result: null,
      progressDetail: ''
    }
  };
}

export function hydrateSessionStateFromResult(result, members, now = Date.now()) {
  const state = createSessionState(members);

  if (result.workflow) {
    state.workflow = {
      ...result.workflow,
      teams: { ...(result.workflow.teams || {}) }
    };
    state.iteration = {
      current: result.iterations || result.workflow.iterations || 1,
      total: result.iterations || result.workflow.iterations || 1
    };
  }

  for (const memberResult of result.members) {
    const item = state.items.find((entry) => entry.name === memberResult.name);
    if (!item) continue;

    const completedAt = now;
    const durationMs = Number.isFinite(memberResult.durationMs)
      ? memberResult.durationMs
      : 0;

    item.status = memberResult.status;
    item.role = memberResult.role || item.role;
    item.teamSize = memberResult.teamSize ?? item.teamSize;
    item.startedAt = completedAt - durationMs;
    item.completedAt = completedAt;
    item.result = memberResult;
    item.progressDetail = '';
  }

  const summaryResult = result.summary;
  if (summaryResult) {
    const completedAt = now;
    const durationMs = Number.isFinite(summaryResult.durationMs)
      ? summaryResult.durationMs
      : 0;

    state.summaryItem.status = summaryResult.status;
    state.summaryItem.summarizerName = summaryResult.name;
    state.summaryItem.role = summaryResult.role;
    state.summaryItem.teamSize = summaryResult.teamSize;
    state.summaryItem.startedAt = completedAt - durationMs;
    state.summaryItem.completedAt = completedAt;
    state.summaryItem.result = summaryResult;
    state.summaryItem.progressDetail = '';
  }

  return state;
}

export function reduceSessionEvent(state, event) {
  const next = {
    ...state,
    workflow: { ...state.workflow, teams: { ...state.workflow.teams } },
    iteration: { ...state.iteration },
    items: state.items.map((item) => ({ ...item })),
    summaryItem: { ...state.summaryItem }
  };

  switch (event.type) {
    case 'run_started': {
      if (event.workflow) {
        next.workflow = {
          ...event.workflow,
          teams: { ...(event.workflow.teams || {}) }
        };
        next.iteration.total = event.workflow.iterations || 1;
      }
      return next;
    }
    case 'iteration_started': {
      next.iteration = {
        current: event.iteration,
        total: event.totalIterations
      };
      next.items = next.items.map((item) => ({
        ...item,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        result: null,
        progressDetail: ''
      }));
      next.summaryItem.status = 'pending';
      next.summaryItem.role = null;
      next.summaryItem.teamSize = 0;
      next.summaryItem.startedAt = null;
      next.summaryItem.completedAt = null;
      next.summaryItem.result = null;
      next.summaryItem.progressDetail = '';
      return next;
    }
    case 'member_started': {
      const item = next.items.find((entry) => entry.name === event.name);
      if (item) {
        item.status = 'running';
        item.role = event.role || item.role;
        item.teamSize = event.teamSize ?? item.teamSize;
        item.startedAt = timestamp(event.at);
        item.progressDetail = 'thinking...';
      }
      return next;
    }
    case 'member_progress': {
      const item = next.items.find((entry) => entry.name === event.name);
      if (item && event.detail) {
        item.progressDetail = event.detail;
      }
      return next;
    }
    case 'member_heartbeat': {
      return next;
    }
    case 'member_completed': {
      const item = next.items.find(
        (entry) => entry.name === event.result.name
      );
      if (item) {
        item.status = event.result.status;
        item.role = event.result.role || item.role;
        item.teamSize = event.result.teamSize ?? item.teamSize;
        item.startedAt ??= timestamp(event.at);
        item.completedAt = timestamp(event.at);
        item.result = event.result;
        item.progressDetail = '';
      }
      return next;
    }
    case 'summary_started': {
      next.summaryItem.status = 'running';
      next.summaryItem.summarizerName = event.name;
      next.summaryItem.role = event.role;
      next.summaryItem.teamSize = event.teamSize;
      next.summaryItem.startedAt = timestamp(event.at);
      next.summaryItem.completedAt = null;
      next.summaryItem.result = null;
      next.summaryItem.progressDetail = 'synthesizing...';
      return next;
    }
    case 'summary_progress': {
      if (event.detail) {
        next.summaryItem.progressDetail = event.detail;
      }
      return next;
    }
    case 'summary_heartbeat': {
      return next;
    }
    case 'summary_completed': {
      next.summaryItem.status = event.result.status;
      next.summaryItem.summarizerName = event.result.name;
      next.summaryItem.role = event.result.role;
      next.summaryItem.teamSize = event.result.teamSize;
      next.summaryItem.startedAt ??= timestamp(event.at);
      next.summaryItem.completedAt = timestamp(event.at);
      next.summaryItem.result = event.result;
      next.summaryItem.progressDetail = '';
      return next;
    }
    default:
      return next;
  }
}

function timestamp(value) {
  return value ? new Date(value).getTime() : Date.now();
}
