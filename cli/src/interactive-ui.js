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
    summaryItem: createSummaryItem(members.length + 1),
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
      item.progressDetail = 'thinking...';
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
      state.summaryItem.status = 'running';
      state.summaryItem.summarizerName = event.name;
      state.summaryItem.startedAt = timestamp(event.at);
      state.summaryItem.completedAt = null;
      state.summaryItem.result = null;
      state.summaryItem.progressDetail = 'synthesizing...';
      return;
    }
    case 'summary_progress': {
      state.summaryItem.progressDetail = event.detail;
      return;
    }
    case 'summary_completed': {
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

export function renderInteractiveSnapshot(state, { width = 100, rows, colorEnabled = false } = {}) {
  const clampedWidth = Math.max(width, 60);
  const lines = [];

  lines.push(style(`Council is consulting: ${state.members.join(', ')}`, '36', colorEnabled));

  for (const item of state.items) {
    lines.push(...renderItem(item, { width: clampedWidth, colorEnabled }));
  }

  if (state.summaryItem) {
    lines.push('');
    lines.push(style('----------- synthesis -----------', summaryDividerColor(state.summaryItem), colorEnabled));
    lines.push(...renderItem(state.summaryItem, { width: clampedWidth, colorEnabled }));
  }

  lines.push('');
  lines.push(...renderFooter(state, { width: clampedWidth, colorEnabled }));

  return fitToHeight(lines, rows, colorEnabled);
}

function fitToHeight(lines, rows, colorEnabled) {
  if (!Number.isFinite(rows) || rows <= 0 || lines.length <= rows) {
    return lines;
  }

  if (rows < 3) {
    return lines.slice(-rows);
  }

  const ellipsis = style('...', '90', colorEnabled);
  const tailCount = rows - 2;
  return [lines[0], ellipsis, ...lines.slice(-tailCount)];
}

export function createInteractiveDashboard({
  stream = process.stderr,
  input = process.stdin,
  colorEnabled = false,
  members = []
} = {}) {
  const state = createInteractiveState(members);
  let blockHeight = 0;
  let lastFrame = null;
  let timer = null;
  let disposed = false;
  let actionResolver = null;
  let pendingAction = null;
  let inputListener = null;
  let previousRawMode = input.isRaw;

  return {
    start() {
      if (disposed) {
        return;
      }

      timer = setInterval(() => {
        render();
      }, 1_000);
      timer.unref?.();
      attachInput();
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
      if (pendingAction) {
        const action = pendingAction;
        pendingAction = null;
        detachInput();
        return action;
      }

      return await new Promise((resolve) => {
        actionResolver = resolve;
      });
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (actionResolver) {
        actionResolver({ type: 'quit', seed: '' });
        actionResolver = null;
      }
      detachInput();
    }
  };

  function render() {
    const lines = renderInteractiveSnapshot(state, {
      width: stream.columns ?? 100,
      rows: stream.rows,
      colorEnabled
    });
    const frame = lines.join('\n');

    if (frame === lastFrame) {
      return;
    }

    if (blockHeight > 0) {
      if (blockHeight > 1) {
        stream.write(`\u001b[${blockHeight - 1}F\u001b[J`);
      } else {
        stream.write('\r\u001b[J');
      }
    }

    stream.write(frame);
    blockHeight = lines.length;
    lastFrame = frame;
  }

  function attachInput() {
    if (inputListener || !input.isTTY || !input.setRawMode) {
      return;
    }

    previousRawMode = input.isRaw;
    inputListener = (buffer) => {
      const key = buffer.toString('utf8');

      if (toggleInteractiveItem(state, key)) {
        render();
        return;
      }

      if (!state.completed) {
        return;
      }

      if (key === '\u0003') {
        process.exitCode = 130;
        settleAction({ type: 'quit', seed: '' });
        return;
      }

      if (key === 'q' || key === '\u001b') {
        settleAction({ type: 'quit', seed: '' });
        return;
      }

      if (key === 'f' || key === 'c' || key === '\r' || key === '\n') {
        settleAction({ type: 'continue', seed: '' });
        return;
      }

      if (isPrintableKey(key)) {
        settleAction({ type: 'continue', seed: key });
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', inputListener);
  }

  function detachInput() {
    if (!inputListener || !input.setRawMode) {
      return;
    }

    input.off('data', inputListener);
    input.setRawMode(previousRawMode);
    input.pause();
    inputListener = null;
  }

  function settleAction(action) {
    if (actionResolver) {
      const resolve = actionResolver;
      actionResolver = null;
      detachInput();
      resolve(action);
      return;
    }

    pendingAction = action;
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
    expanded: true
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
  if (item.status === 'pending' && item.kind !== 'summary') {
    return [];
  }

  if (item.status === 'pending') {
    return renderPendingItem(item, { colorEnabled });
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
    return [style(prefix.trimEnd(), colorForItem(item), colorEnabled)];
  }

  const wrappedLines = wrapPreviewWithPrefix(prefix, `"${compactWhitespace(text)}"`, width, 2);
  return wrappedLines.map((line) => style(line, colorForItem(item), colorEnabled));
}

function renderExpandedItem(item, { width, colorEnabled }) {
  const lines = [
    style(`${buildExpandedPrefix(item)} [expanded]`, colorForItem(item), colorEnabled)
  ];
  const wrappedBody = wrapMultilineText(getPrimaryText(item), Math.max(width - 4, 20));

  for (const line of wrappedBody) {
    lines.push(style(`    ${line}`, colorForItem(item), colorEnabled));
  }

  return lines;
}

function renderPendingItem(item, { colorEnabled }) {
  return [style(`${item.hotkey}. ${statusToken(item)} ${itemLabel(item)}`, colorForItem(item), colorEnabled)];
}

function renderFooter(state, { width, colorEnabled }) {
  const expandableItems = getExpandableItems(state);
  const styledLines = (text) =>
    wrapMultilineText(text, width).map((line) => style(line, '90', colorEnabled));

  if (!state.completed) {
    if (expandableItems.length === 0) {
      return styledLines('Waiting for council members to finish...');
    }

    const mapping = expandableItems
      .map((item) => `${item.hotkey} ${describeFooterItem(item)}`)
      .join('  ');

    return [
      ...styledLines(`Hotkeys: ${mapping}`),
      ...styledLines('Waiting for council members to finish. Press a number to expand or collapse available results.')
    ];
  }

  if (expandableItems.length === 0) {
    return styledLines('Type a follow-up, or press q or Esc to exit.');
  }

  const mapping = expandableItems
    .map((item) => `${item.hotkey} ${describeFooterItem(item)}`)
    .join('  ');

  return [
    ...styledLines(`Hotkeys: ${mapping}`),
    ...styledLines('Press a number to expand or collapse a result. Type a follow-up, or press q or Esc to exit.')
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
  if (item.kind === 'summary' && item.status === 'pending') {
    return '[sum]';
  }

  if (item.kind === 'summary' && item.status === 'running') {
    return '[sum]';
  }

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

function colorForItem(item) {
  if (item.kind === 'summary') {
    if (item.status === 'timeout' || item.status === 'error') {
      return '31';
    }

    return '33';
  }

  return colorForStatus(item.status);
}

function summaryDividerColor(item) {
  return item.status === 'timeout' || item.status === 'error' ? '31' : '90';
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
  const trimmed = line.trimEnd();
  if (trimmed.length + 3 <= width) {
    return `${trimmed}...`;
  }

  const room = Math.max(width - 3, 1);
  return `${trimmed.slice(0, room).trimEnd()}...`;
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
