import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './process.js';

export const DEFAULT_MAX_TAGGED_FILE_CHARS = 20_000;
export const DEFAULT_MAX_COMMAND_OUTPUT_CHARS = 20_000;
export const DEFAULT_PROMPT_COMMAND_TIMEOUT_MS = 30_000;

export async function loadTaggedFile({
  filePath,
  cwd = process.cwd(),
  maxChars = DEFAULT_MAX_TAGGED_FILE_CHARS
}: any) {
  const resolvedPath = resolveContextPath(cwd, filePath);
  const displayPath = relativeDisplayPath(cwd, resolvedPath);

  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      return {
        path: resolvedPath,
        displayPath,
        size: fileStat.size,
        status: 'error',
        detail: 'Tagged path is not a file.',
        content: '',
        truncated: false
      };
    }

    const buffer = await readFile(resolvedPath);
    const text = decodeTaggedFile(buffer);

    if (text === null) {
      return {
        path: resolvedPath,
        displayPath,
        size: fileStat.size,
        status: 'binary',
        detail: 'Binary file tagged as metadata only.',
        content: '',
        truncated: false
      };
    }

    const content = text.length > maxChars
      ? text.slice(0, maxChars).trimEnd()
      : text;

    return {
      path: resolvedPath,
      displayPath,
      size: fileStat.size,
      status: 'ok',
      detail: '',
      content,
      truncated: text.length > maxChars
    };
  } catch (error) {
    return {
      path: resolvedPath,
      displayPath,
      size: 0,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      content: '',
      truncated: false
    };
  }
}

export async function runPromptCommand({
  command,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_PROMPT_COMMAND_TIMEOUT_MS,
  maxChars = DEFAULT_MAX_COMMAND_OUTPUT_CHARS,
  onProgress = () => {}
}: any) {
  const startedAt = Date.now();
  const shell = env.SHELL || process.env.SHELL || '/bin/sh';
  onProgress({
    type: 'prompt_command_started',
    command
  });

  const result = await runCommand({
    command: shell,
    args: ['-lc', command],
    cwd,
    env,
    timeoutMs
  });

  const stdout = truncateText(result.stdout || '', maxChars);
  const stderr = truncateText(result.stderr || '', maxChars);
  const output = [stdout.text, stderr.text ? `stderr:\n${stderr.text}` : '']
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const status = result.timedOut
    ? 'timeout'
    : result.code === 0
      ? 'ok'
      : 'error';

  return {
    command,
    shell,
    status,
    exitCode: result.code,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    stdout: stdout.text,
    stderr: stderr.text,
    output,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    detail: result.timedOut
      ? `Timed out after ${Math.round(timeoutMs / 1_000)}s.`
      : result.code === 0
        ? ''
        : `Exited with code ${result.code}.`
  };
}

export async function buildPromptContext({
  cwd = process.cwd(),
  files = [],
  commands = [],
  env = process.env,
  onEvent = () => {}
}: any = {}) {
  const taggedFiles = [];
  const promptCommands = [];

  for (const filePath of files) {
    const file = await loadTaggedFile({ filePath, cwd });
    taggedFiles.push(file);
    onEvent({
      type: 'prompt_file_loaded',
      file: {
        path: file.path,
        displayPath: file.displayPath,
        status: file.status,
        size: file.size,
        truncated: file.truncated,
        detail: file.detail
      }
    });
  }

  for (const command of commands) {
    onEvent({
      type: 'prompt_command_started',
      command
    });
    const commandResult = await runPromptCommand({
      command,
      cwd,
      env
    });
    promptCommands.push(commandResult);
    onEvent({
      type: 'prompt_command_completed',
      command,
      status: commandResult.status,
      exitCode: commandResult.exitCode,
      durationMs: commandResult.durationMs,
      detail: commandResult.detail
    });
  }

  return {
    files: taggedFiles,
    commands: promptCommands
  };
}

export function buildPromptWithContext(query, context: any = {}) {
  const sections = [String(query || '').trim()];
  const fileSection = formatTaggedFilesForPrompt(context.files || []);
  const commandSection = formatPromptCommandsForPrompt(context.commands || []);

  if (fileSection) {
    sections.push(fileSection);
  }

  if (commandSection) {
    sections.push(commandSection);
  }

  return sections.filter(Boolean).join('\n\n');
}

export function summarizePromptContext(context: any = {}) {
  const files = context.files || [];
  const commands = context.commands || [];
  const okFiles = files.filter((file) => file.status === 'ok').length;
  const binaryFiles = files.filter((file) => file.status === 'binary').length;
  const failedFiles = files.filter((file) => file.status === 'error').length;
  const okCommands = commands.filter((command) => command.status === 'ok').length;
  const failedCommands = commands.filter((command) => command.status !== 'ok').length;

  return {
    fileCount: files.length,
    okFiles,
    binaryFiles,
    failedFiles,
    commandCount: commands.length,
    okCommands,
    failedCommands
  };
}

export function formatPromptContextStatus(context: any = {}) {
  const summary = summarizePromptContext(context);
  const parts = [];

  if (summary.fileCount > 0) {
    parts.push(`files:${summary.okFiles}/${summary.fileCount}`);
  }

  if (summary.commandCount > 0) {
    parts.push(`cmds:${summary.okCommands}/${summary.commandCount}`);
  }

  return parts.join(' ');
}

function formatTaggedFilesForPrompt(files) {
  const blocks = files.map((file) => {
    if (file.status === 'ok') {
      const suffix = file.truncated
        ? `\n[truncated by council after ${DEFAULT_MAX_TAGGED_FILE_CHARS} characters]`
        : '';
      return [
        `### ${file.displayPath}`,
        '```',
        `${file.content}${suffix}`,
        '```'
      ].join('\n');
    }

    return [
      `### ${file.displayPath}`,
      `[${file.status}] ${file.detail || 'No text content included.'}`
    ].join('\n');
  });

  return blocks.length > 0
    ? ['Tagged local files:', ...blocks].join('\n\n')
    : '';
}

function formatPromptCommandsForPrompt(commands) {
  const blocks = commands.map((command) => [
    `### ${command.command}`,
    `status: ${command.status}${command.exitCode === null || command.exitCode === undefined ? '' : `, exit: ${command.exitCode}`}`,
    command.output
      ? ['```', command.output, '```'].join('\n')
      : command.detail || '(no output)'
  ].join('\n'));

  return blocks.length > 0
    ? ['Command outputs captured before the prompt:', ...blocks].join('\n\n')
    : '';
}

function resolveContextPath(cwd, value) {
  const filePath = String(value || '').trim();
  if (!filePath) {
    throw new Error('File path is required.');
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function relativeDisplayPath(cwd, filePath) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function decodeTaggedFile(buffer) {
  if (buffer.includes(0)) {
    return null;
  }

  return buffer.toString('utf8');
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false
    };
  }

  return {
    text: `${value.slice(0, maxChars).trimEnd()}\n[truncated by council after ${maxChars} characters]`,
    truncated: true
  };
}
