import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractJsonObject, runCommand } from './process.js';

export const ALL_ENGINES = ['codex', 'claude', 'gemini'];
export const AUTO_SUMMARIZER = 'auto';
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_MEMBER_CHARS = 12_000;
export const DEFAULT_ITERATIONS = 1;
export const DEFAULT_TEAM_SIZE = 0;
export const DEFAULT_SUMMARIZER_ORDER = ['codex', 'claude', 'gemini'];
export const EFFORT_LEVELS = ['low', 'medium', 'high'];
export const PROVIDER_EFFORT_LEVELS = {
  codex: ['low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  gemini: ['low', 'medium', 'high']
};
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
export const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
export const DEFAULT_PROVIDER_PERMISSIONS = {
  codex: 'read-only',
  claude: 'plan',
  gemini: null
};
export const DEFAULT_PROVIDER_TEAM_SIZES = {
  codex: DEFAULT_TEAM_SIZE,
  claude: DEFAULT_TEAM_SIZE,
  gemini: DEFAULT_TEAM_SIZE
};

const GEMINI_THINKING_BUDGETS = {
  low: 1024,
  medium: 8192,
  high: 24576
};
const GEMINI_LOGIN_DETAIL =
  'Gemini CLI requires login. Run `gemini` in a normal terminal, complete authentication in your browser, then retry council.';

const ENGINE_BINS = {
  codex: {
    envVar: 'COUNCIL_CODEX_BIN',
    defaultBin: 'codex'
  },
  claude: {
    envVar: 'COUNCIL_CLAUDE_BIN',
    defaultBin: 'claude'
  },
  gemini: {
    envVar: 'COUNCIL_GEMINI_BIN',
    defaultBin: 'gemini'
  }
};

export async function runEngine(
  name,
  {
    prompt,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    effort = null,
    model = null,
    permission = null,
    onProgress = () => {}
  }
) {
  if (!ALL_ENGINES.includes(name)) {
    throw new Error(`Unknown engine: ${name}`);
  }

  if (name === 'codex') {
    return runCodex({ prompt, cwd, timeoutMs, env, effort, model, permission, onProgress });
  }

  if (name === 'claude') {
    return runClaude({ prompt, cwd, timeoutMs, env, effort, model, permission, onProgress });
  }

  return runGemini({ prompt, cwd, timeoutMs, env, effort, model, permission, onProgress });
}

export function buildMemberPrompt(
  query,
  {
    conversation = [],
    role = 'executor',
    lead = null,
    planner = null,
    iteration = 1,
    totalIterations = DEFAULT_ITERATIONS,
    handoff = false,
    previousResponses = [],
    planOutput = '',
    teamSize = DEFAULT_TEAM_SIZE
  } = {}
) {
  const sections = [
    'You are one member of a multi-model council.',
    `Council workflow: iteration ${iteration} of ${totalIterations}.`,
    lead ? `Lead model: ${lead}.` : 'Lead model: auto.',
    planner ? `Planner model: ${planner}.` : 'Planner model: none.',
    `Your assigned role: ${role}.`,
    roleInstruction(role),
    'Answer the user query directly.',
    'Do not introduce yourself.',
    'Do not describe your tools, environment, or capabilities unless the user explicitly asks.',
    'If the query is a quick test, acknowledge it briefly and answer in one sentence.',
    'Be concise unless the user asks for depth.'
  ];

  if (teamSize > 0) {
    sections.push(
      '',
      `Team work: you may coordinate up to ${teamSize} internal sub-agent${teamSize === 1 ? '' : 's'} or subtasks inside your own CLI if that helps. Fold their findings into one answer.`
    );
  }

  if (handoff) {
    sections.push(
      '',
      'Handoff mode is enabled. Treat earlier council outputs as working context, then hand your own best result forward.'
    );
  }

  const plan = compactOptionalText(planOutput);
  if (plan) {
    sections.push('', 'Planner handoff:', plan);
  }

  const handoffContext = formatHandoffContext(previousResponses);
  if (handoffContext) {
    sections.push('', 'Earlier council handoffs:', handoffContext);
  }

  const history = formatConversationHistory(conversation);
  if (history) {
    sections.push('', 'Conversation so far:', history);
  }

  sections.push('', 'Current user query:', query.trim());
  return sections.join('\n');
}

export function buildSummaryPrompt(
  query,
  responses,
  {
    maxMemberChars = DEFAULT_MAX_MEMBER_CHARS,
    conversation = [],
    lead = null,
    planner = null,
    iterations = DEFAULT_ITERATIONS,
    handoff = false,
    teams = DEFAULT_PROVIDER_TEAM_SIZES
  } = {}
) {
  const responseBlocks = responses
    .map(
      (response) => [
        `### ${response.name}`,
        truncateForSummary(response.output.trim(), maxMemberChars)
      ].join('\n')
    )
    .join('\n\n');

  const sections = [
    'You are synthesizing answers from multiple AI CLI tools.',
    `Council workflow: ${iterations} iteration${iterations === 1 ? '' : 's'}, ${handoff ? 'handoff enabled' : 'parallel consultation'}.`,
    lead ? `Lead model: ${lead}.` : 'Lead model: auto.',
    planner ? `Planner model: ${planner}.` : 'Planner model: none.',
    `Team sizes: ${formatTeamSizes(teams)}.`,
    'Produce one final answer to the original user query.',
    'Answer the query directly. Do not introduce yourself or describe your environment.',
    'Use the strongest points from the responses below.',
    'Call out meaningful disagreement or uncertainty when it exists.',
    'Stay grounded in the provided responses. Do not invent consensus.',
    'If only one response is available, lightly polish it rather than pretending there was agreement.'
  ];

  const history = formatConversationHistory(conversation);
  if (history) {
    sections.push('', 'Conversation so far:', history);
  }

  sections.push('', 'Current user query:', query.trim(), '', 'Council member responses:', responseBlocks);
  return sections.join('\n');
}

function roleInstruction(role) {
  if (role === 'planner') {
    return 'Plan the work: identify the approach, risks, checkpoints, and useful handoffs for the executors.';
  }

  if (role === 'lead') {
    return 'Lead the work: make the strongest direct attempt while watching for conflicts you may need to resolve in synthesis.';
  }

  if (role === 'lead+planner') {
    return 'Plan and lead the work: produce a practical plan, then make the strongest direct attempt from that plan.';
  }

  return 'Execute the work: use any plan or handoff context, then produce your independent best answer.';
}

function compactOptionalText(text) {
  return String(text || '').trim();
}

function formatHandoffContext(responses) {
  return responses
    .filter((response) => response?.status === 'ok' && compactOptionalText(response.output))
    .map((response) =>
      [
        `### ${response.name}${response.role ? ` (${response.role})` : ''}`,
        compactOptionalText(response.output)
      ].join('\n')
    )
    .join('\n\n');
}

function formatTeamSizes(teams) {
  return ALL_ENGINES.map((engine) => `${engine}:${teams?.[engine] ?? DEFAULT_TEAM_SIZE}`).join(', ');
}

export function parseClaudeOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return '';
  }

  const parsed = extractJsonObject(trimmed);
  if (parsed && typeof parsed.result === 'string') {
    return parsed.result.trim();
  }

  const events = parseJsonLines(trimmed);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type === 'result' && typeof event.result === 'string') {
      return event.result.trim();
    }

    if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      const text = event.message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');

      if (text.trim()) {
        return text.trim();
      }
    }
  }

  return trimmed;
}

export function parseGeminiOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return '';
  }

  const parsed = extractJsonObject(trimmed);
  if (parsed && typeof parsed.response === 'string') {
    return parsed.response.trim();
  }

  return trimmed;
}

async function runCodex({ prompt, cwd, timeoutMs, env, effort, model, permission, onProgress }) {
  const bin = resolveBinary('codex', env);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-codex-'));
  const outputPath = path.join(tempDir, 'last-message.txt');
  const startedAt = Date.now();
  let lastProgressDetail = '';
  const codexProgress = createCodexProgressTracker((progress) => {
    if (progress.detail === lastProgressDetail) {
      return;
    }

    lastProgressDetail = progress.detail;
    onProgress(progress);
  });

  const modelArgs = model ? ['--model', model] : [];
  const effortArgs = effort ? ['-c', `model_reasoning_effort=${effort}`] : [];
  const sandbox = permission || DEFAULT_PROVIDER_PERMISSIONS.codex;

  try {
    const commandResult = await runCommand({
      command: bin,
      args: [
        'exec',
        ...modelArgs,
        ...effortArgs,
        '--skip-git-repo-check',
        '--sandbox',
        sandbox,
        '--ephemeral',
        '--json',
        '-o',
        outputPath,
        '-'
      ],
      cwd,
      env,
      stdinText: prompt,
      timeoutMs,
      onChunk: (context) => {
        if (context.source === 'stdout') {
          codexProgress(context.chunk);
        }
      }
    });

    const output = (await safeReadFile(outputPath)).trim();
    return finalizeResult({
      name: 'codex',
      bin,
      startedAt,
      commandResult,
      output
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runClaude({ prompt, cwd, timeoutMs, env, effort, model, permission, onProgress }) {
  const bin = resolveBinary('claude', env);
  const startedAt = Date.now();
  let lastProgressDetail = '';
  const claudeProgress = createClaudeProgressTracker((progress) => {
    if (!progress?.detail || progress.detail === lastProgressDetail) {
      return;
    }

    lastProgressDetail = progress.detail;
    onProgress(progress);
  });
  const resolvedEffort = effort || readEnvValue(env, 'CLAUDE_CODE_EFFORT_LEVEL');
  const authArgs = shouldUseClaudeBareMode(env) ? ['--bare'] : [];
  const modelArgs = model ? ['--model', model] : [];
  const effortArgs = resolvedEffort ? ['--effort', resolvedEffort] : [];
  const permissionMode = permission || DEFAULT_PROVIDER_PERMISSIONS.claude;
  const commandResult = await runCommand({
    command: bin,
    args: [
      ...authArgs,
      '-p',
      '--permission-mode',
      permissionMode,
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      ...modelArgs,
      ...effortArgs
    ],
    cwd,
    env,
    stdinText: prompt,
    timeoutMs,
    onChunk: (context) => {
      if (context.source === 'stdout') {
        claudeProgress(context.chunk);
      }
    }
  });

  const output = parseClaudeOutput(commandResult.stdout);
  return finalizeResult({
    name: 'claude',
    bin,
    startedAt,
    commandResult,
    output
  });
}

async function runGemini({ prompt, cwd, timeoutMs, env, effort, model, permission, onProgress }) {
  const bin = resolveBinary('gemini', env);
  const startedAt = Date.now();
  let lastProgressDetail = '';
  const effortContext = await prepareGeminiEffortSettings(effort, env);
  const runEnv = effortContext
    ? { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: effortContext.settingsPath }
    : env;
  const modelArgs = model ? ['--model', model] : [];

  try {
    const commandResult = await runCommand({
      command: bin,
      args: [
        ...modelArgs,
        '-p',
        prompt,
        '--skip-trust',
        '--approval-mode',
        'plan',
        '--output-format',
        'json'
      ],
      cwd,
      env: runEnv,
      timeoutMs,
      interruptWhen: detectGeminiLoginRequired,
      onChunk: (context) => {
        const progress = detectGeminiRetryProgress(context);

        if (!progress || progress.detail === lastProgressDetail) {
          return;
        }

        lastProgressDetail = progress.detail;
        onProgress(progress);
      }
    });

    const authRequired = isGeminiLoginRequired(commandResult);
    const output = authRequired ? '' : parseGeminiOutput(commandResult.stdout);
    return finalizeResult({
      name: 'gemini',
      bin,
      startedAt,
      commandResult,
      output,
      detailOverride: authRequired ? GEMINI_LOGIN_DETAIL : ''
    });
  } finally {
    if (effortContext) {
      await rm(effortContext.dir, { recursive: true, force: true });
    }
  }
}

async function prepareGeminiEffortSettings(effort, env) {
  if (!effort || GEMINI_THINKING_BUDGETS[effort] === undefined) {
    return null;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'council-gemini-effort-'));
  const settingsPath = path.join(dir, 'settings.json');
  const settings = await mergeGeminiSettings({
    settingsPath: env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    thinkingBudget: GEMINI_THINKING_BUDGETS[effort]
  });
  await writeFile(settingsPath, JSON.stringify(settings), 'utf8');
  return { dir, settingsPath };
}

async function mergeGeminiSettings({ settingsPath, thinkingBudget }) {
  const nextSettings = { thinkingBudget };

  if (!settingsPath) {
    return nextSettings;
  }

  try {
    const existingSettings = JSON.parse(
      await readFile(settingsPath, 'utf8')
    );

    if (
      existingSettings &&
      typeof existingSettings === 'object' &&
      !Array.isArray(existingSettings)
    ) {
      return {
        ...existingSettings,
        thinkingBudget
      };
    }
  } catch {
    // Existing settings file is missing or unparseable; proceed with defaults.
  }

  return nextSettings;
}

function shouldUseClaudeBareMode(env) {
  if (readEnvValue(env, 'CLAUDE_CODE_OAUTH_TOKEN')) {
    return false;
  }

  return Boolean(readEnvValue(env, 'ANTHROPIC_API_KEY'));
}

function readEnvValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveBinary(name, env) {
  const config = ENGINE_BINS[name];
  const override = env[config.envVar];
  return override && override.trim() ? override.trim() : config.defaultBin;
}

function finalizeResult({ name, bin, startedAt, commandResult, output, detailOverride = '' }) {
  const durationMs = Date.now() - startedAt;
  const detail = detailOverride || summarizeFailure(commandResult, output);

  if (commandResult.error?.code === 'ENOENT') {
    return {
      name,
      bin,
      status: 'missing',
      durationMs,
      detail: `${bin} is not installed or not on PATH.`,
      exitCode: null,
      signal: null,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      output: ''
    };
  }

  if (commandResult.interruption) {
    return {
      name,
      bin,
      status: commandResult.interruption.status ?? 'error',
      durationMs,
      detail: detail || commandResult.interruption.detail || 'Command was interrupted.',
      exitCode: commandResult.code,
      signal: commandResult.signal,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      output: ''
    };
  }

  if (commandResult.timedOut) {
    return {
      name,
      bin,
      status: 'timeout',
      durationMs,
      detail: `Timed out after ${Math.round(commandResult.timeoutMs / 1_000)}s.`,
      exitCode: commandResult.code,
      signal: commandResult.signal,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      output: output ?? ''
    };
  }

  if (commandResult.code !== 0) {
    return {
      name,
      bin,
      status: 'error',
      durationMs,
      detail,
      exitCode: commandResult.code,
      signal: commandResult.signal,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      output: output ?? ''
    };
  }

  if (!output) {
    return {
      name,
      bin,
      status: 'error',
      durationMs,
      detail: detail || 'The CLI exited successfully but returned no output.',
      exitCode: commandResult.code,
      signal: commandResult.signal,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      output: ''
    };
  }

  return {
    name,
    bin,
    status: 'ok',
    durationMs,
    detail: '',
    exitCode: commandResult.code,
    signal: commandResult.signal,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    output
  };
}

function summarizeFailure(commandResult, output) {
  if (commandResult.error && commandResult.error.code !== 'ENOENT') {
    return commandResult.error.message;
  }

  const stderr = commandResult.stderr.trim();
  if (stderr) {
    return stderr;
  }

  const stdout = commandResult.stdout.trim();
  if (stdout && stdout !== output) {
    return stdout;
  }

  if (commandResult.code !== 0) {
    return `Exited with code ${commandResult.code}.`;
  }

  return '';
}

function detectGeminiLoginRequired({ stdout, stderr }) {
  return isGeminiLoginRequired({ stdout, stderr })
    ? {
        kind: 'auth_required',
        status: 'error',
        detail: GEMINI_LOGIN_DETAIL
      }
    : null;
}

function isGeminiLoginRequired(commandResult) {
  const combined = `${commandResult.stdout || ''}\n${commandResult.stderr || ''}`;
  return (
    combined.includes('Opening authentication page in your browser.') ||
    combined.includes('Error authenticating:') ||
    combined.includes('Authentication cancelled by user')
  );
}

function detectGeminiRetryProgress({ source, stderr }) {
  if (source !== 'stderr') {
    return null;
  }

  const attemptMatches = [...stderr.matchAll(/Attempt (\d+) failed with status (\d+)\. Retrying with backoff\.\.\./g)];
  const latestAttempt = attemptMatches.at(-1);

  if (!latestAttempt) {
    return null;
  }

  const [, attempt, status] = latestAttempt;
  const capacityExhausted =
    stderr.includes('MODEL_CAPACITY_EXHAUSTED') ||
    stderr.includes('No capacity available for model');

  return {
    detail: capacityExhausted
      ? `Attempt ${attempt} failed: model capacity exhausted (${status}). Retrying with backoff...`
      : `Attempt ${attempt} failed with status ${status}. Retrying with backoff...`
  };
}

function createCodexProgressTracker(onProgress) {
  return createJsonlStreamConsumer((event) => {
    if (event?.type !== 'item.started') {
      return;
    }

    if (event.item?.type === 'command_execution' && typeof event.item.command === 'string') {
      onProgress({
        detail: `running shell: ${summarizeCommand(event.item.command)}`
      });
    }
  });
}

function createClaudeProgressTracker(onProgress) {
  let thinking = '';
  let toolInput = '';
  let currentToolName = '';
  let draftText = '';

  return createJsonlStreamConsumer((event) => {
    if (event?.type === 'system' && event.subtype === 'status' && event.status === 'requesting') {
      onProgress({
        detail: 'thinking...'
      });
      return;
    }

    if (event?.type === 'stream_event') {
      const streamEvent = event.event;

      if (streamEvent?.type === 'content_block_delta') {
        if (streamEvent.delta?.type === 'thinking_delta' && typeof streamEvent.delta.thinking === 'string') {
          thinking += streamEvent.delta.thinking;
          onProgress({
            detail: `thinking: ${truncateProgressDetail(compactWhitespace(thinking))}`
          });
          return;
        }

        if (streamEvent.delta?.type === 'input_json_delta' && typeof streamEvent.delta.partial_json === 'string') {
          toolInput += streamEvent.delta.partial_json;
          const toolDetail = describeClaudeTool(currentToolName, toolInput);

          if (toolDetail) {
            onProgress({
              detail: toolDetail
            });
          }
          return;
        }

        if (streamEvent.delta?.type === 'text_delta' && typeof streamEvent.delta.text === 'string') {
          draftText += streamEvent.delta.text;
          onProgress({
            detail: `drafting answer: ${truncateProgressDetail(compactWhitespace(draftText))}`
          });
        }

        return;
      }

      if (streamEvent?.type === 'content_block_start') {
        if (streamEvent.content_block?.type === 'thinking') {
          thinking = '';
          draftText = '';
          return;
        }

        if (streamEvent.content_block?.type === 'tool_use') {
          currentToolName = streamEvent.content_block.name || 'tool';
          toolInput = '';
          onProgress({
            detail: `${currentToolName}: preparing tool input...`
          });
        }
      }

      return;
    }

    if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      const toolUseBlock = event.message.content.find((block) => block?.type === 'tool_use');

      if (toolUseBlock) {
        currentToolName = toolUseBlock.name || currentToolName;
        const toolDetail = describeClaudeTool(currentToolName, JSON.stringify(toolUseBlock.input || {}));
        if (toolDetail) {
          onProgress({
            detail: toolDetail
          });
        }
      }
    }
  });
}

function describeClaudeTool(toolName, partialJson) {
  if (!toolName) {
    return null;
  }

  const parsed = extractJsonObject(partialJson);
  const description =
    typeof parsed?.description === 'string' && parsed.description.trim()
      ? compactWhitespace(parsed.description)
      : '';
  const command =
    typeof parsed?.command === 'string' && parsed.command.trim()
      ? summarizeCommand(parsed.command)
      : '';

  if (description && command) {
    return `${toolName}: ${truncateProgressDetail(`${description} (${command})`)}`;
  }

  if (description) {
    return `${toolName}: ${truncateProgressDetail(description)}`;
  }

  if (command) {
    return `${toolName}: ${truncateProgressDetail(command)}`;
  }

  return `${toolName}: preparing tool input...`;
}

function createJsonlStreamConsumer(onEvent) {
  let buffer = '';

  return (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        onEvent(JSON.parse(line));
      } catch {
        // Ignore non-JSON lines in mixed stdout streams.
      }
    }
  };
}

function parseJsonLines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        // Skip non-JSON lines.
        return [];
      }
    });
}

function summarizeCommand(command) {
  const compact = compactWhitespace(String(command));
  return truncateProgressDetail(compact);
}

function compactWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function truncateProgressDetail(text, maxLength = 120) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(maxLength - 3, 1)).trimEnd()}...`;
}

async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function truncateForSummary(text, maxMemberChars) {
  if (text.length <= maxMemberChars) {
    return text;
  }

  return `${text.slice(0, maxMemberChars).trimEnd()}\n\n[truncated by council after ${maxMemberChars} characters]`;
}

function formatConversationHistory(conversation) {
  const recentTurns = conversation.slice(-6);

  if (recentTurns.length === 0) {
    return '';
  }

  return recentTurns
    .map((turn, index) =>
      [
        `Turn ${index + 1}:`,
        `User: ${String(turn.user).trim()}`,
        `Council: ${String(turn.assistant).trim()}`
      ].join('\n')
    )
    .join('\n\n');
}
