import {
  colorForSummaryStatus,
  colorForStatus,
  formatDuration,
  formatTelemetrySuffix,
  formatWorkflowSummary
} from './presentation.js';

function style(text, ansiCode, enabled) {
  return enabled ? `\u001b[${ansiCode}m${text}\u001b[0m` : text;
}

export function resolveUiOptions(
  parsed,
  { stdoutIsTTY = Boolean(process.stdout.isTTY), stderrIsTTY = Boolean(process.stderr.isTTY), env = process.env } = {}
) {
  const outputMode = parsed.jsonStream ? 'json-stream' : parsed.json ? 'json' : 'text';
  const autoHeadless = !stdoutIsTTY && !stderrIsTTY;
  const headless = parsed.headless || autoHeadless;
  const plain = parsed.plain || headless;
  const summaryOnly =
    (parsed.summaryOnly || parsed.quiet || headless) && !parsed.verbose;
  const stdoutColor = shouldUseColor(parsed.color, stdoutIsTTY, env, plain);
  const stderrColor = shouldUseColor(parsed.color, stderrIsTTY, env, plain);
  return {
    outputMode,
    headless,
    studio: Boolean(parsed.studio),
    plain,
    summaryOnly,
    stdoutColor,
    stderrColor,
    showBanner:
      outputMode === 'text' &&
      stderrIsTTY &&
      !headless &&
      !parsed.studio &&
      !parsed.noBanner &&
      !plain,
    showProgress:
      outputMode === 'text' &&
      stderrIsTTY &&
      (!headless || parsed.verbose) &&
      !parsed.quiet,
    verbose: parsed.verbose
  };
}

export function renderBanner({ colorEnabled = false } = {}) {
  const lines = [
    '+-- Council Studio --------------------------------------+',
    '| consult codex + claude + gemini, then synthesize once |',
    '| plan -> execute -> handoff -> synthesize              |',
    '+--------------------------------------------------------+'
  ];

  const palette = ['36', '36', '94', '94', '33', '90'];
  return lines
    .map((line, index) => style(line, palette[Math.min(index, palette.length - 1)], colorEnabled))
    .join('\n');
}

export function renderProgressEvent(event, { colorEnabled = false } = {}) {
  switch (event.type) {
    case 'auth_login_started':
      return style(
        `[auth] ${event.provider}: opening social login (${event.command || formatEventCommand(event)})`,
        '36',
        colorEnabled
      );
    case 'auth_login_url_opened':
      return style(`[auth] ${event.provider}: opened browser tab ${event.url}`, '36', colorEnabled);
    case 'auth_login_url_open_failed':
      return style(`[auth] ${event.provider}: browser open failed (${event.detail})`, '31', colorEnabled);
    case 'auth_login_completed':
      return style(
        `[auth] ${event.provider}: ${event.status}${event.detail ? ` (${event.detail})` : ''}`,
        event.status === 'ok' ? '32' : '31',
        colorEnabled
      );
    case 'prompt_file_loaded':
      return style(
        `[ctx] file ${event.file.displayPath}: ${event.file.status}${event.file.truncated ? ' truncated' : ''}`,
        event.file.status === 'error' ? '31' : '36',
        colorEnabled
      );
    case 'prompt_command_started':
      return style(`[ctx] running command: ${event.command}`, '36', colorEnabled);
    case 'prompt_command_completed':
      return style(
        `[ctx] command ${event.status}: ${event.command} (${formatDuration(event.durationMs)})`,
        event.status === 'ok' ? '32' : '31',
        colorEnabled
      );
    case 'run_started':
      return style(
        `Council Studio: ${event.members.join(', ')} | ${formatWorkflowSummary(event.workflow)}`,
        '36',
        colorEnabled
      );
    case 'iteration_started':
      return style(
        `[iter] ${event.iteration}/${event.totalIterations} ${event.workflow?.handoff ? 'handoff' : 'parallel'} pass`,
        '36',
        colorEnabled
      );
    case 'member_started':
      return style(`[run] ${event.name}${formatEventRole(event)}: thinking...`, '36', colorEnabled);
    case 'member_completed':
      return renderStatusLine(event.result, colorEnabled);
    case 'member_progress':
      return style(`[wait] ${event.name}: ${event.detail}`, '90', colorEnabled);
    case 'member_heartbeat':
      return style(`[wait] ${event.name} still running (${formatDuration(event.elapsedMs)})`, '90', colorEnabled);
    case 'summary_started':
      return style(`[sum] ${event.name}${formatEventRole(event)}: synthesizing...`, '33', colorEnabled);
    case 'summary_progress':
      return style(`[wait] synthesis via ${event.name}: ${event.detail}`, '90', colorEnabled);
    case 'summary_heartbeat':
      return style(`[wait] synthesis via ${event.name} still running (${formatDuration(event.elapsedMs)})`, '90', colorEnabled);
    case 'summary_completed':
      return renderSummaryLine(event.result, colorEnabled);
    case 'run_completed':
      return style(
        event.success ? '[done] council completed successfully' : '[done] council completed with failures',
        event.success ? '32' : '31',
        colorEnabled
      );
    default:
      return '';
  }
}

function formatEventRole(event) {
  const parts = [];

  if (event.role && event.role !== 'executor') {
    parts.push(event.role);
  }

  if (event.teamSize > 0) {
    parts.push(`team:${event.teamSize}`);
  }

  return parts.length > 0 ? ` [${parts.join(',')}]` : '';
}

function formatEventCommand(event) {
  return [event.bin, ...(event.args || [])].filter(Boolean).join(' ');
}

function renderStatusLine(result, colorEnabled) {
  const color = ansiCodeForInkColor(colorForStatus(result.status));

  if (result.status === 'ok') {
    return style(
      `[ok]   ${result.name}${formatTelemetrySuffix({ result })} (${formatDuration(result.durationMs)})`,
      color,
      colorEnabled
    );
  }

  if (result.status === 'missing') {
    return style(`[skip] ${result.name}: ${result.detail}`, color, colorEnabled);
  }

  if (result.status === 'timeout') {
    return style(`[time] ${result.name}: ${result.detail}`, color, colorEnabled);
  }

  return style(`[err]  ${result.name}: ${result.detail}`, color, colorEnabled);
}

function renderSummaryLine(result, colorEnabled) {
  const color = ansiCodeForInkColor(colorForSummaryStatus(result.status));

  if (result.status === 'ok') {
    return style(
      `[ok]   synthesis via ${result.name}${formatTelemetrySuffix({ result })} (${formatDuration(result.durationMs)})`,
      color,
      colorEnabled
    );
  }

  return style(
    `[err]  synthesis via ${result.name ?? 'none'}: ${result.detail}`,
    color,
    colorEnabled
  );
}

function shouldUseColor(preference, isTTY, env, plain) {
  if (plain) {
    return false;
  }

  if (preference === 'always') {
    return true;
  }

  if (preference === 'never') {
    return false;
  }

  if (!isTTY) {
    return false;
  }

  if (env.NO_COLOR && env.NO_COLOR !== '0') {
    return false;
  }

  if (env.TERM === 'dumb') {
    return false;
  }

  return true;
}

function ansiCodeForInkColor(color) {
  switch (color) {
    case 'green':
      return '32';
    case 'yellow':
      return '33';
    case 'red':
      return '31';
    case 'cyan':
      return '36';
    default:
      return '90';
  }
}
