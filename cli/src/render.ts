import {
  formatDuration,
  formatWorkflowSummary,
  renderSummaryFailure
} from './presentation.js';

export function renderHumanResult(result, { summaryOnly = false, verbose = false } = {}) {
  if (summaryOnly) {
    if (result.summary?.status === 'ok') {
      return result.summary.output;
    }

    return renderSummaryFailure(result.summary);
  }

  const lines = [];
  const successfulMembers = result.members.filter((member) => member.status === 'ok');
  const nonSuccessfulMembers = result.members.filter(
    (member) => member.status !== 'ok'
  );

  lines.push(
    `Members: ${successfulMembers.map((member) => member.name).join(', ') || 'none'}`
  );

  if (result.workflow) {
    lines.push(`Workflow: ${formatWorkflowSummary(result.workflow)}`);
  }

  if (nonSuccessfulMembers.length > 0) {
    const skippedLine = `Skipped: ${nonSuccessfulMembers
      .map((member) => `${member.name} (${member.detail})`)
      .join(', ')}`;

    if (verbose) {
      lines.push(
        `Skipped: ${nonSuccessfulMembers.map((member) => member.name).join(', ')}`
      );
    } else {
      lines.push(skippedLine);
    }
  }

  if (result.summary?.name) {
    lines.push(`Summarizer: ${result.summary.name}`);
  }

  for (const member of successfulMembers) {
    lines.push('');
    lines.push(
      `=== ${member.name}${formatRoleSuffix(member)} (${formatDuration(member.durationMs)}) ===`
    );
    lines.push(member.output);
    lines.push(...formatTelemetryLines(member));
  }

  if (verbose) {
    for (const member of nonSuccessfulMembers) {
      lines.push('');
      lines.push(
        `=== ${member.name}${formatRoleSuffix(member)} (${member.status}: ${member.detail}) ===`
      );
      lines.push(member.output || '(no output)');
      lines.push(...formatTelemetryLines(member));
    }
  }

  lines.push('');
  lines.push(
    result.summary?.name
      ? `=== synthesis via ${result.summary.name}${formatRoleSuffix(result.summary)} (${formatDuration(result.summary.durationMs)}) ===`
      : '=== synthesis ==='
  );
  lines.push(result.summary?.status === 'ok' ? result.summary.output : renderSummaryFailure(result.summary));
  lines.push(...formatTelemetryLines(result.summary));

  return lines.join('\n');
}

function formatTelemetryLines(result: any = {}) {
  const lines = [];
  const usage = result.tokenUsage;
  const tools = result.toolUsage || [];

  if (usage) {
    lines.push(
      `Usage: input ${usage.input || 0}, output ${usage.output || 0}, total ${usage.estimated ? '~' : ''}${usage.total || 0} tokens`
    );
  }

  if (tools.length > 0) {
    lines.push(
      `Tools: ${tools
        .slice(0, 6)
        .map((tool) => tool.command || tool.name)
        .join('; ')}${tools.length > 6 ? `; ... ${tools.length - 6} more` : ''}`
    );
  }

  return lines;
}

function formatRoleSuffix(result) {
  const parts = [];

  if (result.role && result.role !== 'executor') {
    parts.push(result.role);
  }

  if (result.teamSize > 0) {
    parts.push(`team:${result.teamSize}`);
  }

  return parts.length > 0 ? ` [${parts.join(',')}]` : '';
}
