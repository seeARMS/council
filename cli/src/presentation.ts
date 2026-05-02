export function renderSummaryFailure(summary) {
  if (!summary) {
    return 'Summary failed.';
  }

  if (summary.name) {
    return `Summary failed via ${summary.name}: ${summary.detail || 'Unknown error.'}`;
  }

  return `Summary failed: ${summary.detail || 'Unknown error.'}`;
}

export function statusToken(status) {
  switch (status) {
    case 'pending':
      return '[...]';
    case 'running':
      return '[run]';
    case 'ok':
      return '[ok] ';
    case 'missing':
      return '[skip]';
    case 'timeout':
      return '[time]';
    default:
      return '[err]';
  }
}

export function colorForStatus(status) {
  switch (status) {
    case 'running':
      return 'cyan';
    case 'ok':
      return 'green';
    case 'missing':
      return 'yellow';
    case 'timeout':
    case 'error':
      return 'red';
    default:
      return undefined;
  }
}

export function colorForSummaryStatus(status) {
  if (status === 'timeout' || status === 'error') return 'red';
  if (status === 'ok') return 'green';
  return 'yellow';
}

export function summaryDividerColor(status) {
  return status === 'timeout' || status === 'error' ? 'red' : 'gray';
}

export function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function formatPreviewText(text) {
  const preview = compactWhitespace(text);
  if (!preview) {
    return null;
  }

  return preview.length > 120
    ? `${preview.slice(0, 120).trimEnd()}...`
    : preview;
}

export function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return 'n/a';
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function formatElapsedWindow(startedAt, completedAt = null, now = Date.now()) {
  if (!startedAt) {
    return '0.0s';
  }

  const end = completedAt ?? now;
  return `${(Math.max(end - startedAt, 0) / 1_000).toFixed(1)}s`;
}

export function buildHotkeyParts(members, expanded = null) {
  const parts = members.map((name, idx) => {
    const used = expanded?.has(`member:${name}`);
    return `${idx + 1} ${name}${used ? ' (shown)' : ''}`;
  });
  const summaryHotkey = members.length + 1;
  const summaryUsed = expanded?.has('summary');
  parts.push(
    `${summaryHotkey} synthesis${summaryUsed ? ' (shown)' : ''}`
  );
  return parts;
}

export function formatWorkflowSummary(workflow: any = {}) {
  const parts = [
    `lead:${workflow.lead || 'auto'}`,
    `planner:${workflow.planner || 'none'}`,
    workflow.handoff ? 'handoff:on' : 'handoff:off',
    `iterations:${workflow.iterations || 1}`,
    `team:${formatTeamSummary(workflow.teams)}`
  ];

  return parts.join(' | ');
}

export function buildSessionBlocks({
  headerText,
  state,
  members,
  expanded = new Set(),
  now = Date.now()
}) {
  const blocks: any[] = [
    {
      id: 'header',
      kind: 'header',
      text: headerText,
      subtitle: formatWorkflowSummary(state.workflow),
      iteration: state.iteration
    }
  ];

  for (let i = 0; i < members.length; i += 1) {
    const item = state.items[i];
    if (!item) continue;

    blocks.push(buildMemberBlock(item, i + 1, expanded, now));
  }

  blocks.push({
    id: 'divider:summary',
    kind: 'divider',
    color: summaryDividerColor(state.summaryItem.status),
    text: '----------- synthesis -----------'
  });

  blocks.push(buildSummaryBlock(state.summaryItem, members.length + 1, expanded, now));

  return blocks;
}

function buildMemberBlock(item, hotkey, expanded, now) {
  const body = item.result?.output || item.result?.detail || '';
  const previewText =
    item.status === 'running'
      ? formatPreviewText(item.progressDetail)
      : formatPreviewText(body);

  return {
    id: `row:${item.name}`,
    kind: 'result-row',
    color: colorForStatus(item.status),
    headerText: `${hotkey}. ${statusToken(item.status)} ${item.name}${formatRoleSuffix(item)} (${formatElapsedWindow(item.startedAt, item.completedAt, now)})`,
    previewText,
    expanded: expanded.has(`member:${item.name}`) && Boolean(body),
    body
  };
}

function buildSummaryBlock(item, hotkey, expanded, now) {
  const label = item.summarizerName
    ? `synthesis via ${item.summarizerName}`
    : 'synthesis';
  const body = item.result?.output || item.result?.detail || '';
  const previewText =
    item.status === 'running'
      ? formatPreviewText(item.progressDetail)
      : null;

  return {
    id: 'row:summary',
    kind: 'result-row',
    color: colorForSummaryStatus(item.status),
    headerText: `${hotkey}. ${statusToken(item.status)} ${label}${formatRoleSuffix(item)} (${formatElapsedWindow(item.startedAt, item.completedAt, now)})`,
    previewText,
    expanded: expanded.has('summary') && Boolean(body),
    body
  };
}

function formatRoleSuffix(item) {
  const parts = [];

  if (item.role) {
    parts.push(item.role);
  }

  if (item.teamSize > 0) {
    parts.push(`team:${item.teamSize}`);
  }

  return parts.length > 0 ? ` [${parts.join(',')}]` : '';
}

function formatTeamSummary(teams = {}) {
  const entries = Object.entries(teams).filter(([, size]) => Number(size) > 0);
  if (entries.length === 0) {
    return '0';
  }

  return entries.map(([name, size]) => `${name}:${size}`).join(',');
}
