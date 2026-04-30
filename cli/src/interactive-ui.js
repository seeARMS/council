function style(text, ansiCode, enabled) {
  return enabled ? `\u001b[${ansiCode}m${text}\u001b[0m` : text;
}

export function shouldUseInteractiveDashboard(ui, { stdinIsTTY = Boolean(process.stdin.isTTY) } = {}) {
  return ui.outputMode === 'text' && ui.showProgress && !ui.summaryOnly && !ui.plain && stdinIsTTY;
}

export function createInteractiveState(members) {
  return {
    members: [...members],
    items: members.map((name, index) => createMemberItem(name, index + 1)),
    summaryItem: null,
    completed: false,
    footerMode: 'running'
  };
}

export function applyInteractiveEvent(state, event) {
  switch (event.type) {
    case 'run_started':
      return;
    case 'member_started': {
      const item = getMemberItem(state, event.name);
      item.status = 'running';
      item.startedAt = timestamp(event.at);
      item.progressDetail = '';
      return;
    }
    case 'member_progress': {
      const item = getMemberItem(state, event.name);
      item.progressDetail = event.detail;
      return;
    }
    case 'member_completed': {
      const item = getMemberItem(state, event.result.name);
      item.status = event.result.status;
      item.startedAt ??= timestamp(event.at);
      item.completedAt = timestamp(event.at);
      item.result = event.result;
      item.progressDetail = '';
      return;
    }
    case 'summary_started': {
      state.summaryItem = state.summaryItem ?? createSummaryItem(state.members.length + 1);
      state.summaryItem.status = 'running';
      state.summaryItem.summarizerName = event.name;
      state.summaryItem.startedAt = timestamp(event.at);
      state.summaryItem.completedAt = null;
      state.summaryItem.result = null;
      state.summaryItem.progressDetail = '';
      return;
    }
    case 'summary_progress': {
      state.summaryItem = state.summaryItem ?? createSummaryItem(state.members.length + 1);
      state.summaryItem.progressDetail = event.detail;
      return;
    }
    case 'summary_completed': {
      state.summaryItem = state.summaryItem ?? createSummaryItem(state.members.length + 1);
      state.summaryItem.status = event.result.status;
      state.summaryItem.summarizerName = event.result.name;
      state.summaryItem.startedAt ??= timestamp(event.at);
      state.summaryItem.completedAt = timestamp(event.at);
      state.summaryItem.result = event.result;
      state.summaryItem.progressDetail = '';
      return;
    }
    case 'run_completed':
      state.completed = true;
      state.footerMode = 'completed';
      return;
    default:
      return;
  }
}

export function toggleInteractiveItem(state, hotkey) {
  const item = getExpandableItems(state).find((entry) => entry.hotkey === hotkey);
  if (!item) {
    return false;
  }

  item.expanded = !item.expanded;
  return true;
}

export function renderInteractiveSnapshot(state, { width = 100, colorEnabled = false } = {}) {
  const clampedWidth = Math.max(width, 60);
  const lines = [];

  lines.push(style(`Council is consulting: ${state.members.join(', ')}`, '36', colorEnabled));

  for (const item of state.items) {
    lines.push(...renderItem(item, { width: clampedWidth, colorEnabled }));
  }

  if (state.summaryItem) {
    lines.push(...renderItem(state.summaryItem, { width: clampedWidth, colorEnabled }));
  }

  lines.push('');
  lines.push(...renderFooter(state, { width: clampedWidth, colorEnabled }));

  return lines;
}

export function createInteractiveDashboard({
  stream = process.stderr,
  input = process.stdin,
  colorEnabled = false,
  members = []
} = {}) {
  const state = createInteractiveState(members);
  let blockHeight = 0;
  let timer = null;
  let disposed = false;

  return {
    start() {
      if (disposed) {
        return;
      }

      timer = setInterval(() => {
        render();
      }, 1_000);
      timer.unref?.();
      render();
    },
    handleEvent(event) {
      if (disposed) {
        return;
      }

      applyInteractiveEvent(state, event);
      render();

      if (state.completed && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async waitForAction() {
      if (disposed || !state.completed || !input.isTTY || !input.setRawMode) {
        return { type: 'quit', seed: '' };
      }

      render();

      const previousRawMode = input.isRaw;

      return await new Promise((resolve) => {
        const onData = (buffer) => {
          const key = buffer.toString('utf8');

          if (key === '\u0003') {
            cleanup();
            process.exitCode = 130;
            resolve({ type: 'quit', seed: '' });
            return;
          }

          if (key === 'q' || key === '\u001b') {
            cleanup();
            resolve({ type: 'quit', seed: '' });
            return;
          }

          if (key === 'f' || key === 'c' || key === '\r' || key === '\n') {
            cleanup();
            resolve({ type: 'continue', seed: '' });
            return;
          }

          if (toggleInteractiveItem(state, key)) {
            render();
            return;
          }

          if (isPrintableKey(key)) {
            cleanup();
            resolve({ type: 'continue', seed: key });
          }
        };

        const cleanup = () => {
          input.off('data', onData);
          input.setRawMode(previousRawMode);
          input.pause();
        };

        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
      });
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };

  function render() {
    const lines = renderInteractiveSnapshot(state, {
      width: stream.columns ?? 100,
      colorEnabled
    });
    const frame = lines.join('\n');

    if (blockHeight > 0) {
      stream.write(`\u001b[${blockHeight}F\u001b[J`);
    }

    stream.write(`${frame}\n`);
    blockHeight = lines.length;
  }
}

function createMemberItem(name, hotkeyNumber) {
  return {
    id: `member:${name}`,
    kind: 'member',
    hotkey: String(hotkeyNumber),
    name,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    result: null,
    progressDetail: '',
    expanded: false
  };
}

function createSummaryItem(hotkeyNumber) {
  return {
    id: 'summary',
    kind: 'summary',
    hotkey: String(hotkeyNumber),
    name: 'synthesis',
    summarizerName: null,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    result: null,
    progressDetail: '',
    expanded: false
  };
}

function getMemberItem(state, name) {
  const item = state.items.find((entry) => entry.name === name);

  if (!item) {
    throw new Error(`Unknown member item: ${name}`);
  }

  return item;
}

function getExpandableItems(state) {
  return [...state.items, state.summaryItem].filter(
    (item) => item && item.status !== 'pending' && getPrimaryText(item)
  );
}

function renderItem(item, { width, colorEnabled }) {
  if (item.status === 'pending') {
    return [];
  }

  if (item.expanded) {
    return renderExpandedItem(item, { width, colorEnabled });
  }

  return renderCollapsedItem(item, { width, colorEnabled });
}

function renderCollapsedItem(item, { width, colorEnabled }) {
  const text = getPrimaryText(item);
  const prefix = buildCollapsedPrefix(item, {
    includePreview: Boolean(text)
  });

  if (!text) {
    return [style(prefix.trimEnd(), colorForStatus(item.status), colorEnabled)];
  }

  const wrappedLines = wrapPreviewWithPrefix(prefix, `"${compactWhitespace(text)}"`, width, 2);
  return wrappedLines.map((line) => style(line, colorForStatus(item.status), colorEnabled));
}

function renderExpandedItem(item, { width, colorEnabled }) {
  const lines = [
    style(`${buildExpandedPrefix(item)} [expanded]`, colorForStatus(item.status), colorEnabled)
  ];
  const wrappedBody = wrapMultilineText(getPrimaryText(item), Math.max(width - 4, 20));

  for (const line of wrappedBody) {
    lines.push(style(`    ${line}`, colorForStatus(item.status), colorEnabled));
  }

  return lines;
}

function renderFooter(state, { colorEnabled }) {
  if (!state.completed) {
    return [style('Waiting for council members to finish...', '90', colorEnabled)];
  }

  const expandableItems = getExpandableItems(state);
  if (expandableItems.length === 0) {
    return [style('Type a follow-up, or press q or Esc to exit.', '90', colorEnabled)];
  }

  const mapping = expandableItems
    .map((item) => `${item.hotkey} ${describeFooterItem(item)}`)
    .join('  ');

  return [
    style(`Hotkeys: ${mapping}`, '90', colorEnabled),
    style('Press a number to expand or collapse a result. Type a follow-up, or press q or Esc to exit.', '90', colorEnabled)
  ];
}

function buildCollapsedPrefix(item, { includePreview }) {
  return includePreview
    ? `${item.hotkey}. ${statusToken(item)} ${itemLabel(item)} (${formatElapsed(item)}): `
    : `${item.hotkey}. ${statusToken(item)} ${itemLabel(item)} (${formatElapsed(item)})`;
}

function buildExpandedPrefix(item) {
  return `${item.hotkey}. ${statusToken(item)} ${itemLabel(item)} (${formatElapsed(item)})`;
}

function statusToken(item) {
  switch (item.status) {
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

function itemLabel(item) {
  if (item.kind === 'summary') {
    return item.summarizerName ? `synthesis via ${item.summarizerName}` : 'synthesis';
  }

  return item.name;
}

function describeFooterItem(item) {
  if (item.kind === 'summary') {
    return 'synthesis';
  }

  return item.name;
}

function colorForStatus(status) {
  switch (status) {
    case 'running':
      return '36';
    case 'ok':
      return '32';
    case 'missing':
      return '33';
    case 'timeout':
    case 'error':
      return '31';
    default:
      return '31';
  }
}

function getPrimaryText(item) {
  if (item.status === 'running' && item.progressDetail) {
    return item.progressDetail;
  }

  if (item.result?.output) {
    return item.result.output;
  }

  if (item.result?.detail) {
    return item.result.detail;
  }

  return '';
}

function formatElapsed(item) {
  if (!item.startedAt) {
    return '0.0s';
  }

  const end = item.completedAt ?? Date.now();
  return `${(Math.max(end - item.startedAt, 0) / 1_000).toFixed(1)}s`;
}

function compactWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function wrapPreviewWithPrefix(prefix, text, width, maxLines) {
  const safeWidth = Math.max(width, 40);
  const firstWidth = Math.max(safeWidth - prefix.length, 10);
  const continuationPrefix = ' '.repeat(prefix.length);
  const continuationWidth = Math.max(safeWidth - continuationPrefix.length, 10);

  const remaining = [...tokenize(text)];
  const lines = [];

  const firstLine = consumeWrappedLine(remaining, firstWidth);
  lines.push(`${prefix}${firstLine}`);

  for (let index = 1; index < maxLines; index += 1) {
    if (remaining.length === 0) {
      break;
    }

    const nextLine = consumeWrappedLine(remaining, continuationWidth);
    lines.push(`${continuationPrefix}${nextLine}`);
  }

  if (remaining.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = appendEllipsis(lines[lastIndex], safeWidth);
  }

  return lines;
}

function consumeWrappedLine(tokens, width) {
  if (tokens.length === 0) {
    return '';
  }

  let line = '';

  while (tokens.length > 0) {
    const token = tokens[0];
    const separator = line ? ' ' : '';
    const candidate = `${line}${separator}${token}`;

    if (candidate.length <= width) {
      line = candidate;
      tokens.shift();
      continue;
    }

    if (!line) {
      line = token.slice(0, Math.max(width - 1, 1));
      tokens[0] = token.slice(line.length);
    }

    break;
  }

  return line;
}

function appendEllipsis(line, width) {
  if (line.length >= width) {
    return `${line.slice(0, Math.max(width - 1, 1)).trimEnd()}...`;
  }

  return `${line.trimEnd()}...`;
}

function wrapMultilineText(text, width) {
  const paragraphs = String(text)
    .split('\n')
    .map((line) => line.trimEnd());
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }

    const tokens = [...tokenize(paragraph)];
    while (tokens.length > 0) {
      lines.push(consumeWrappedLine(tokens, width));
    }
  }

  return lines.length > 0 ? lines : [''];
}

function* tokenize(text) {
  for (const token of text.trim().split(/\s+/)) {
    if (token) {
      yield token;
    }
  }
}

function timestamp(value) {
  return value ? new Date(value).getTime() : Date.now();
}

function isPrintableKey(key) {
  return key >= ' ' && key !== '\u007f';
}
