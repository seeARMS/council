import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractJsonObject, runCommand } from './process.js';

export const ALL_ENGINES = ['codex', 'claude', 'gemini'];
export const AUTO_SUMMARIZER = 'auto';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_MEMBER_CHARS = 12_000;
export const DEFAULT_SUMMARIZER_ORDER = ['codex', 'claude', 'gemini'];
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
  { prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, onProgress = () => {} }
) {
  if (!ALL_ENGINES.includes(name)) {
    throw new Error(`Unknown engine: ${name}`);
  }

  if (name === 'codex') {
    return runCodex({ prompt, cwd, timeoutMs, env });
  }

  if (name === 'claude') {
    return runClaude({ prompt, cwd, timeoutMs, env });
  }

  return runGemini({ prompt, cwd, timeoutMs, env, onProgress });
}

export function buildMemberPrompt(query, { conversation = [] } = {}) {
  const sections = [
    'You are one member of a multi-model council.',
    'Answer the user query directly.',
    'Do not introduce yourself.',
    'Do not describe your tools, environment, or capabilities unless the user explicitly asks.',
    'If the query is a quick test, acknowledge it briefly and answer in one sentence.',
    'Be concise unless the user asks for depth.'
  ];

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
  { maxMemberChars = DEFAULT_MAX_MEMBER_CHARS, conversation = [] } = {}
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

export function parseClaudeOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return '';
  }

  const parsed = extractJsonObject(trimmed);
  if (parsed && typeof parsed.result === 'string') {
    return parsed.result.trim();
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

async function runCodex({ prompt, cwd, timeoutMs, env }) {
  const bin = resolveBinary('codex', env);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-codex-'));
  const outputPath = path.join(tempDir, 'last-message.txt');
  const startedAt = Date.now();

  try {
    const commandResult = await runCommand({
      command: bin,
      args: [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '-o',
        outputPath,
        '-'
      ],
      cwd,
      env,
      stdinText: prompt,
      timeoutMs
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

async function runClaude({ prompt, cwd, timeoutMs, env }) {
  const bin = resolveBinary('claude', env);
  const startedAt = Date.now();
  const commandResult = await runCommand({
    command: bin,
    args: [
      '--bare',
      '-p',
      '--permission-mode',
      'plan',
      '--output-format',
      'json',
      '--no-session-persistence'
    ],
    cwd,
    env,
    stdinText: prompt,
    timeoutMs
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

async function runGemini({ prompt, cwd, timeoutMs, env, onProgress }) {
  const bin = resolveBinary('gemini', env);
  const startedAt = Date.now();
  let lastProgressDetail = '';
  const commandResult = await runCommand({
    command: bin,
    args: [
      '-p',
      prompt,
      '--skip-trust',
      '--approval-mode',
      'plan',
      '--output-format',
      'json'
    ],
    cwd,
    env,
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
