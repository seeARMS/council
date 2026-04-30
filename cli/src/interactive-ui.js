import {
  createElement as h,
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState
} from 'react';
import { Box, render, Static, Text, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import { runCouncil } from './council.js';

export function shouldUseInteractiveDashboard(
  ui,
  { stdinIsTTY = Boolean(process.stdin.isTTY) } = {}
) {
  return (
    ui.outputMode === 'text' &&
    ui.showProgress &&
    !ui.summaryOnly &&
    !ui.plain &&
    stdinIsTTY
  );
}

export async function runInteractiveSession({
  initialPrompt = '',
  members,
  summarizer,
  timeoutMs,
  maxMemberChars,
  cwd,
  conversation = [],
  onEvent
}) {
  let prompt = initialPrompt.trim();
  let lastResult = null;

  if (!prompt) {
    prompt = await runInitialPromptPhase();
    if (!prompt) {
      return null;
    }
  }

  while (prompt) {
    const result = await runLivePhase({
      prompt,
      members,
      summarizer,
      timeoutMs,
      maxMemberChars,
      cwd,
      conversation,
      onEvent
    });

    if (!result) {
      return lastResult;
    }

    lastResult = result;
    conversation.push({
      user: prompt,
      assistant: summaryTextForConversation(result)
    });

    const action = await runStaticPhase({ result, members });

    if (action.type !== 'continue' || !action.followUp) {
      return lastResult;
    }

    prompt = action.followUp;
  }

  return lastResult;
}

function summaryTextForConversation(result) {
  if (result.summary?.status === 'ok') {
    return result.summary.output;
  }
  if (result.summary?.name) {
    return `Summary failed via ${result.summary.name}: ${result.summary.detail || 'Unknown error.'}`;
  }
  return `Summary failed: ${result.summary?.detail || 'Unknown error.'}`;
}

function runInitialPromptPhase() {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      app.unmount();
      resolve(value);
    };

    const app = render(
      h(InitialPrompt, { onSubmit: finish }),
      {
        stdout: process.stderr,
        exitOnCtrlC: false,
        patchConsole: false
      }
    );
  });
}

function InitialPrompt({ onSubmit }) {
  const [value, setValue] = useState('');
  const { isRawModeSupported } = useStdin();

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        process.exitCode = 130;
        onSubmit('');
        return;
      }
      if (key.escape) {
        onSubmit('');
      }
    },
    { isActive: isRawModeSupported }
  );

  if (!isRawModeSupported) {
    return h(Text, { color: 'red' }, 'Interactive prompt requires a TTY.');
  }

  return h(
    Box,
    null,
    h(Text, { color: 'cyan' }, 'you> '),
    h(TextInput, {
      value,
      onChange: setValue,
      onSubmit: (text) => onSubmit(text.trim())
    })
  );
}

function runLivePhase({
  prompt,
  members,
  summarizer,
  timeoutMs,
  maxMemberChars,
  cwd,
  conversation,
  onEvent
}) {
  return new Promise((resolve) => {
    let result = null;
    let resolved = false;
    let app;

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      result = value ?? result;
      try {
        app?.clear();
        app?.unmount();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    app = render(
      h(LivePhase, {
        prompt,
        members,
        summarizer,
        timeoutMs,
        maxMemberChars,
        cwd,
        conversation,
        onEvent,
        onComplete: (value) => {
          result = value;
        },
        onUnmount: () => finish(result)
      }),
      {
        stdout: process.stderr,
        exitOnCtrlC: false,
        patchConsole: false
      }
    );

    app.waitUntilExit().then(() => finish(result));
  });
}

function LivePhase({
  prompt,
  members,
  summarizer,
  timeoutMs,
  maxMemberChars,
  cwd,
  conversation,
  onEvent,
  onComplete,
  onUnmount
}) {
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    () => createInitialState(members)
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;

    runCouncil({
      query: prompt,
      members,
      summarizer,
      timeoutMs,
      maxMemberChars,
      cwd,
      conversation,
      onEvent: (event) => {
        if (cancelled) return;
        onEvent?.(event);
        dispatch({ type: 'event', event });
      }
    })
      .then((value) => {
        if (cancelled) return;
        onComplete(value);
        onUnmount();
      })
      .catch((error) => {
        if (cancelled) return;
        const fallback = {
          query: prompt,
          cwd,
          membersRequested: [...members],
          summarizerRequested: summarizer,
          members: [],
          summaryAttempts: [],
          summary: {
            name: null,
            status: 'error',
            detail: error instanceof Error ? error.message : String(error)
          },
          summaryContextLimit: maxMemberChars
        };
        onComplete(fallback);
        onUnmount();
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        process.exitCode = 130;
        onUnmount();
      }
    },
    { isActive: isRawModeSupported }
  );

  return h(LiveDashboard, { state, members });
}

function LiveDashboard({ state, members }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { color: 'cyan' },
      `Council is consulting: ${members.join(', ')}`
    ),
    ...state.items.map((item, index) =>
      h(EngineRow, {
        key: item.name,
        item,
        hotkey: index + 1
      })
    ),
    h(Text, { color: 'gray' }, ''),
    h(
      Text,
      { color: summaryDividerColor(state.summaryItem) },
      '----------- synthesis -----------'
    ),
    h(SummaryRow, {
      item: state.summaryItem,
      hotkey: members.length + 1
    })
  );
}

function EngineRow({ item, hotkey }) {
  const elapsed = formatElapsed(item);
  const status = statusToken(item);
  const preview = compactWhitespace(getPrimaryText(item));
  const color = colorForStatus(item.status);
  const headerText = `${hotkey}. ${status} ${item.name} (${elapsed})`;

  if (!preview || item.status === 'pending') {
    return h(Text, { color }, headerText);
  }

  return h(
    Text,
    { color, wrap: 'truncate-end' },
    `${headerText}: "${preview}"`
  );
}

function SummaryRow({ item, hotkey }) {
  const elapsed = formatElapsed(item);
  const status = statusToken(item);
  const color = colorForSummary(item);
  const label = item.summarizerName
    ? `synthesis via ${item.summarizerName}`
    : 'synthesis';
  const headerText = `${hotkey}. ${status} ${label} (${elapsed})`;

  if (item.status === 'pending') {
    return h(Text, { color }, headerText);
  }

  if (item.status === 'running') {
    const detail = compactWhitespace(item.progressDetail);
    return h(
      Text,
      { color, wrap: 'truncate-end' },
      detail ? `${headerText}: "${detail}"` : headerText
    );
  }

  const text = item.result?.output ?? item.result?.detail ?? '';
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color }, headerText),
    text
      ? h(
          Box,
          { paddingLeft: 4, flexDirection: 'column' },
          h(Text, { color }, text)
        )
      : null
  );
}

function runStaticPhase({ result, members }) {
  return new Promise((resolve) => {
    let resolved = false;
    let app;

    const finish = (action) => {
      if (resolved) return;
      resolved = true;
      try {
        app?.unmount();
      } catch {
        /* ignore */
      }
      resolve(action);
    };

    app = render(
      h(StaticPhase, {
        result,
        members,
        onAction: finish
      }),
      {
        stdout: process.stderr,
        exitOnCtrlC: false,
        patchConsole: false
      }
    );
  });
}

function StaticPhase({ result, members, onAction }) {
  const initialBlocks = useRef(buildInitialStaticBlocks(result, members));
  const [extraBlocks, setExtraBlocks] = useState([]);
  const expandedRef = useRef(new Set());
  const [followUpSeed, setFollowUpSeed] = useState(null);
  const [followUpValue, setFollowUpValue] = useState('');
  const { isRawModeSupported } = useStdin();

  const allBlocks = [...initialBlocks.current, ...extraBlocks];

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        process.exitCode = 130;
        onAction({ type: 'quit' });
        return;
      }

      if (input === 'q' || key.escape) {
        onAction({ type: 'quit' });
        return;
      }

      if (key.return) {
        return;
      }

      if (/^[1-9]$/.test(input)) {
        const idx = parseInt(input, 10);
        if (idx >= 1 && idx <= members.length) {
          const member = result.members[idx - 1];
          if (member && !expandedRef.current.has(`member:${member.name}`)) {
            expandedRef.current.add(`member:${member.name}`);
            setExtraBlocks((blocks) => [
              ...blocks,
              { id: `member:${member.name}`, kind: 'member', member }
            ]);
          }
          return;
        }
        if (idx === members.length + 1) {
          if (!expandedRef.current.has('summary')) {
            expandedRef.current.add('summary');
            setExtraBlocks((blocks) => [
              ...blocks,
              { id: 'summary', kind: 'summary', summary: result.summary }
            ]);
          }
          return;
        }
      }

      if (input && input.length === 1 && input >= ' ') {
        setFollowUpSeed(input);
        setFollowUpValue(input);
      }
    },
    { isActive: isRawModeSupported && followUpSeed === null }
  );

  // When TTY isn't available, just print the static blocks and exit.
  useEffect(() => {
    if (!isRawModeSupported) {
      onAction({ type: 'quit' });
    }
  }, [isRawModeSupported]);

  return h(
    Fragment,
    null,
    h(
      Static,
      { items: allBlocks },
      (block) =>
        h(StaticBlock, {
          key: block.id,
          block
        })
    ),
    isRawModeSupported
      ? followUpSeed === null
        ? h(StaticFooter, {
            members,
            summary: result.summary,
            expanded: expandedRef.current
          })
        : h(FollowUpPrompt, {
            value: followUpValue,
            onChange: setFollowUpValue,
            onSubmit: (text) => {
              const trimmed = text.trim();
              if (!trimmed) {
                setFollowUpSeed(null);
                setFollowUpValue('');
                return;
              }
              onAction({ type: 'continue', followUp: trimmed });
            },
            onCancel: () => {
              setFollowUpSeed(null);
              setFollowUpValue('');
            }
          })
      : null
  );
}

function StaticBlock({ block }) {
  if (block.kind === 'header') {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'cyan' }, block.text)
    );
  }

  if (block.kind === 'summary-row') {
    return h(Text, { color: block.color }, block.text);
  }

  if (block.kind === 'synthesis') {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, ''),
      h(Text, { color: 'gray' }, '----------- synthesis -----------'),
      h(Text, { color: block.color }, block.headerText),
      block.body
        ? h(
            Box,
            { paddingLeft: 4, flexDirection: 'column' },
            h(Text, { color: block.color }, block.body)
          )
        : null
    );
  }

  if (block.kind === 'member') {
    const member = block.member;
    const color = colorForStatus(member.status);
    const text = member.output || member.detail || '';
    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(
        Text,
        { color },
        `=== ${member.name} (${formatDuration(member.durationMs)}) ===`
      ),
      text ? h(Text, null, text) : null
    );
  }

  if (block.kind === 'summary') {
    const summary = block.summary;
    const color = colorForSummaryStatus(summary?.status);
    const label = summary?.name ? `synthesis via ${summary.name}` : 'synthesis';
    const text = summary?.output || summary?.detail || '';
    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(Text, { color }, `=== ${label} ===`),
      text ? h(Text, null, text) : null
    );
  }

  return null;
}

function StaticFooter({ members, summary, expanded }) {
  const parts = members.map((name, idx) => {
    const used = expanded.has(`member:${name}`);
    return `${idx + 1} ${name}${used ? ' (shown)' : ''}`;
  });
  const summaryHotkey = members.length + 1;
  const summaryUsed = expanded.has('summary');
  parts.push(
    `${summaryHotkey} synthesis${summaryUsed ? ' (shown)' : ''}`
  );

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { color: 'gray' }, `Hotkeys: ${parts.join('  ')}`),
    h(
      Text,
      { color: 'gray' },
      'Press a number to print full output. Type to start a follow-up. q or Esc to exit.'
    )
  );
}

function FollowUpPrompt({ value, onChange, onSubmit, onCancel }) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.ctrl && input === 'c') {
      process.exitCode = 130;
      onSubmit('');
    }
  });

  return h(
    Box,
    { marginTop: 1 },
    h(Text, { color: 'cyan' }, 'you> '),
    h(TextInput, { value, onChange, onSubmit })
  );
}

function buildInitialStaticBlocks(result, members) {
  const blocks = [];

  blocks.push({
    id: 'header',
    kind: 'header',
    text: `Council consulted: ${members.join(', ')}`
  });

  for (let i = 0; i < members.length; i += 1) {
    const member = result.members[i];
    if (!member) continue;
    blocks.push({
      id: `row:${member.name}`,
      kind: 'summary-row',
      color: colorForStatus(member.status),
      text: formatMemberRowLine(member, i + 1)
    });
  }

  blocks.push({
    id: 'synthesis',
    kind: 'synthesis',
    color: colorForSummaryStatus(result.summary?.status),
    headerText: formatSummaryRowLine(result.summary, members.length + 1),
    body: result.summary?.output || result.summary?.detail || ''
  });

  return blocks;
}

function formatMemberRowLine(member, hotkey) {
  const status = statusFromString(member.status);
  const elapsed = formatDuration(member.durationMs);
  const preview = compactWhitespace(member.output || member.detail || '');
  const head = `${hotkey}. ${status} ${member.name} (${elapsed})`;

  if (!preview) {
    return head;
  }

  const truncated =
    preview.length > 120 ? `${preview.slice(0, 120).trimEnd()}...` : preview;
  return `${head}: "${truncated}"`;
}

function formatSummaryRowLine(summary, hotkey) {
  const status = statusFromString(summary?.status);
  const elapsed = formatDuration(summary?.durationMs);
  const label = summary?.name ? `synthesis via ${summary.name}` : 'synthesis';
  return `${hotkey}. ${status} ${label} (${elapsed})`;
}

function statusFromString(status) {
  switch (status) {
    case 'ok':
      return '[ok] ';
    case 'missing':
      return '[skip]';
    case 'timeout':
      return '[time]';
    case 'running':
      return '[run]';
    case 'pending':
      return '[...]';
    default:
      return '[err]';
  }
}

function reducer(state, action) {
  if (action.type !== 'event') return state;

  const event = action.event;
  const next = {
    ...state,
    items: state.items.map((item) => ({ ...item })),
    summaryItem: { ...state.summaryItem }
  };

  switch (event.type) {
    case 'member_started': {
      const item = next.items.find((entry) => entry.name === event.name);
      if (item) {
        item.status = 'running';
        item.startedAt = timestamp(event.at);
        item.progressDetail = 'thinking...';
      }
      return next;
    }
    case 'member_progress': {
      const item = next.items.find((entry) => entry.name === event.name);
      if (item) {
        item.progressDetail = event.detail;
      }
      return next;
    }
    case 'member_completed': {
      const item = next.items.find(
        (entry) => entry.name === event.result.name
      );
      if (item) {
        item.status = event.result.status;
        item.startedAt ??= timestamp(event.at);
        item.completedAt = timestamp(event.at);
        item.result = event.result;
        item.progressDetail = '';
      }
      return next;
    }
    case 'summary_started': {
      next.summaryItem.status = 'running';
      next.summaryItem.summarizerName = event.name;
      next.summaryItem.startedAt = timestamp(event.at);
      next.summaryItem.completedAt = null;
      next.summaryItem.result = null;
      next.summaryItem.progressDetail = 'synthesizing...';
      return next;
    }
    case 'summary_progress': {
      next.summaryItem.progressDetail = event.detail;
      return next;
    }
    case 'summary_completed': {
      next.summaryItem.status = event.result.status;
      next.summaryItem.summarizerName = event.result.name;
      next.summaryItem.startedAt ??= timestamp(event.at);
      next.summaryItem.completedAt = timestamp(event.at);
      next.summaryItem.result = event.result;
      next.summaryItem.progressDetail = '';
      return next;
    }
    default:
      return next;
  }
}

function createInitialState(members) {
  return {
    items: members.map((name) => ({
      name,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      result: null,
      progressDetail: ''
    })),
    summaryItem: {
      name: 'synthesis',
      summarizerName: null,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      result: null,
      progressDetail: ''
    }
  };
}

function statusToken(item) {
  switch (item.status) {
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

function colorForStatus(status) {
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

function colorForSummary(item) {
  if (item.status === 'timeout' || item.status === 'error') return 'red';
  if (item.status === 'ok') return 'green';
  return 'yellow';
}

function colorForSummaryStatus(status) {
  if (status === 'timeout' || status === 'error') return 'red';
  if (status === 'ok') return 'green';
  return 'yellow';
}

function summaryDividerColor(item) {
  return item.status === 'timeout' || item.status === 'error'
    ? 'red'
    : 'gray';
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

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function formatElapsed(item) {
  if (!item.startedAt) {
    return '0.0s';
  }
  const end = item.completedAt ?? Date.now();
  return `${(Math.max(end - item.startedAt, 0) / 1_000).toFixed(1)}s`;
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

function timestamp(value) {
  return value ? new Date(value).getTime() : Date.now();
}
