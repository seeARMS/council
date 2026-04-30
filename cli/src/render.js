export function renderHumanResult(result, { summaryOnly = false } = {}) {
  if (summaryOnly) {
    if (result.summary?.status === 'ok') {
      return result.summary.output;
    }

    return renderSummaryFailure(result.summary);
  }

  const lines = [];
  const successfulMembers = result.members.filter((member) => member.status === 'ok');
  const nonSuccessfulMembers = result.members.filter((member) => member.status !== 'ok');

  lines.push(`Members: ${successfulMembers.map((member) => member.name).join(', ') || 'none'}`);

  if (nonSuccessfulMembers.length > 0) {
    lines.push(
      `Skipped: ${nonSuccessfulMembers.map((member) => `${member.name} (${member.detail})`).join(', ')}`
    );
  }

  if (result.summary?.name) {
    lines.push(`Summarizer: ${result.summary.name}`);
  }

  for (const member of successfulMembers) {
    lines.push('');
    lines.push(`=== ${member.name} (${formatDuration(member.durationMs)}) ===`);
    lines.push(member.output);
  }

  lines.push('');
  lines.push(
    result.summary?.name
      ? `=== synthesis via ${result.summary.name} (${formatDuration(result.summary.durationMs)}) ===`
      : '=== synthesis ==='
  );
  lines.push(result.summary?.status === 'ok' ? result.summary.output : renderSummaryFailure(result.summary));

  return lines.join('\n');
}

function renderSummaryFailure(summary) {
  if (!summary) {
    return 'Summary failed.';
  }

  if (summary.name) {
    return `Summary failed via ${summary.name}: ${summary.detail || 'Unknown error.'}`;
  }

  return `Summary failed: ${summary.detail || 'Unknown error.'}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return 'n/a';
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}
