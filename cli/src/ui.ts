import {
  colorForSummaryStatus,
  colorForStatus,
  formatDuration
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
    plain,
    summaryOnly,
    stdoutColor,
    stderrColor,
    showBanner:
      outputMode === 'text' &&
      stderrIsTTY &&
      !headless &&
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
    '  ____   ___  _   _ _   _  ____ ___ _     ',
    ' / ___| / _ \\| | | | \\ | |/ ___|_ _| |    ',
    '| |    | | | | | | |  \\| | |    | || |    ',
    '| |___ | |_| | |_| | |\\  | |___ | || |___ ',
    ' \\____| \\___/ \\___/|_| \\_|\\____|___|_____|',
    '',
    ' consult codex + claude + gemini, then synthesize once'
  ];

  const palette = ['36', '36', '94', '94', '33', '90'];
  return lines
    .map((line, index) => style(line, palette[Math.min(index, palette.length - 1)], colorEnabled))
    .join('\n');
}

export function renderProgressEvent(event, { colorEnabled = false } = {}) {
  switch (event.type) {
    case 'run_started':
      return style(`Council is consulting: ${event.members.join(', ')}`, '36', colorEnabled);
    case 'member_started':
      return style(`[run] ${event.name}: thinking...`, '36', colorEnabled);
    case 'member_completed':
      return renderStatusLine(event.result, colorEnabled);
    case 'member_progress':
      return style(`[wait] ${event.name}: ${event.detail}`, '90', colorEnabled);
    case 'member_heartbeat':
      return style(`[wait] ${event.name} still running (${formatDuration(event.elapsedMs)})`, '90', colorEnabled);
    case 'summary_started':
      return style(`[sum] ${event.name}: synthesizing...`, '33', colorEnabled);
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

function renderStatusLine(result, colorEnabled) {
  const color = ansiCodeForInkColor(colorForStatus(result.status));

  if (result.status === 'ok') {
    return style(
      `[ok]   ${result.name} (${formatDuration(result.durationMs)})`,
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
      `[ok]   synthesis via ${result.name} (${formatDuration(result.durationMs)})`,
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
