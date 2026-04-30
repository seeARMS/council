import {
  ALL_ENGINES,
  AUTO_SUMMARIZER,
  DEFAULT_MAX_MEMBER_CHARS,
  DEFAULT_SUMMARIZER_ORDER,
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
  onEvent = () => {}
  } = options;
  emitEvent(onEvent, 'run_started', {
    cwd,
    members: [...members],
    summarizer
  });

  const memberPrompt = buildMemberPrompt(query, {
    conversation
  });
  const memberRuns = await Promise.all(
    members.map((name) => runMember(name, { prompt: memberPrompt, cwd, timeoutMs, env, onEvent }))
  );
  const successfulMembers = memberRuns.filter((result) => result.status === 'ok');
  const summaryAttempts = [];
  let summary = null;

  if (successfulMembers.length > 0) {
    const summaryPrompt = buildSummaryPrompt(query, successfulMembers, {
      maxMemberChars,
      conversation
    });
    const candidateSummarizers = pickSummarizerCandidates(summarizer, successfulMembers);

    for (const candidate of candidateSummarizers) {
      const attempt = await runSummaryAttempt(candidate, {
        prompt: summaryPrompt,
        cwd,
        timeoutMs,
        env,
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

function pickSummarizerCandidates(requestedSummarizer, successfulMembers) {
  if (requestedSummarizer !== AUTO_SUMMARIZER) {
    return [requestedSummarizer];
  }

  const successfulNames = new Set(successfulMembers.map((member) => member.name));
  return DEFAULT_SUMMARIZER_ORDER.filter((name) => successfulNames.has(name));
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

async function runMember(name, { prompt, cwd, timeoutMs, env, onEvent }) {
  emitEvent(onEvent, 'member_started', {
    name
  });

  const result = await runEngineTask({
    kind: 'member',
    name,
    prompt,
    cwd,
    timeoutMs,
    env,
    onEvent
  });

  emitEvent(onEvent, 'member_completed', {
    result
  });

  return result;
}

async function runSummaryAttempt(name, { prompt, cwd, timeoutMs, env, onEvent }) {
  emitEvent(onEvent, 'summary_started', {
    name
  });

  const result = await runEngineTask({
    kind: 'summary',
    name,
    prompt,
    cwd,
    timeoutMs,
    env,
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

async function runEngineTask({ kind, name, prompt, cwd, timeoutMs, env, onEvent }) {
  const startedAt = Date.now();

  try {
    return await runWithHeartbeat({
      kind,
      name,
      onEvent,
      task: (onProgress) =>
        runEngine(name, {
          prompt,
          cwd,
          timeoutMs,
          env,
          onProgress
        })
    });
  } catch (error) {
    return unexpectedEngineFailure(name, error, Date.now() - startedAt);
  }
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
    output: ''
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
