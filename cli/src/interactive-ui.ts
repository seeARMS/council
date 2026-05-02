import {
  createElement as h,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  Box,
  render,
  Text,
  useApp,
  useInput,
  usePaste,
  useStdin
} from 'ink';
import { runCouncil } from './council.js';
import {
  buildHotkeyParts,
  buildSessionBlocks
} from './presentation.js';
import {
  createCouncilRuntimeFailureResult,
  createSessionState,
  hydrateSessionStateFromResult,
  reduceSessionEvent,
  summaryTextForConversation
} from './session-core.js';

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

export async function runInteractiveSession(options) {
  const app = render(h(SessionApp, options), {
    stdout: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true
  });

  return app.waitUntilExit();
}

function SessionApp({
  initialPrompt = '',
  members,
  summarizer,
  timeoutMs,
  maxMemberChars,
  cwd,
  effort = null,
  models = {},
  efforts = {},
  permissions = {},
  conversation = [],
  onEvent
}) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const initialQuery = initialPrompt.trim();

  const [phase, setPhase] = useState(initialQuery ? 'running' : 'prompt');
  const [conversationState, setConversationState] = useState(() => [
    ...conversation
  ]);
  const conversationRef = useRef([...conversation]);
  const [promptValue, setPromptValue] = useState('');
  const [followUpValue, setFollowUpValue] = useState('');
  const [isEditingFollowUp, setIsEditingFollowUp] = useState(false);
  const isEditingFollowUpRef = useRef(false);
  const [expanded, setExpanded] = useState(createInitialExpanded);
  const [sessionState, setSessionState] = useState(() =>
    createSessionState(members)
  );
  const [lastResult, setLastResult] = useState(null);
  const [, setRunSequence] = useState(initialQuery ? 1 : 0);
  const [activeRun, setActiveRun] = useState(
    initialQuery ? { id: 1, prompt: initialQuery } : null
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    conversationRef.current = conversationState;
  }, [conversationState]);

  const updateFollowUpValue = (nextValue) => {
    setFollowUpValue((current) =>
      typeof nextValue === 'function' ? nextValue(current) : nextValue
    );
  };

  const updateIsEditingFollowUp = (nextValue) => {
    isEditingFollowUpRef.current = nextValue;
    setIsEditingFollowUp(nextValue);
  };

  useEffect(() => {
    if (!isRawModeSupported) {
      exit(lastResult);
    }
  }, [exit, isRawModeSupported, lastResult]);

  useEffect(() => {
    if (phase !== 'running') {
      return;
    }

    const id = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (!activeRun || phase !== 'running') {
      return;
    }

    let cancelled = false;
    const prompt = activeRun.prompt;

    runCouncil({
      query: prompt,
      members,
      summarizer,
      timeoutMs,
      maxMemberChars,
      cwd,
      effort,
      models,
      efforts,
      permissions,
      conversation: conversationRef.current,
      onEvent: (event) => {
        if (cancelled) return;
        onEvent?.(event);
        setSessionState((current) => reduceSessionEvent(current, event));
      }
    })
      .then((result) => {
        if (cancelled) return;

        setActiveRun(null);
        setLastResult(result);
        setConversationState((current) => [
          ...current,
          {
            user: prompt,
            assistant: summaryTextForConversation(result)
          }
        ]);
        setSessionState(hydrateSessionStateFromResult(result, members));
        setExpanded(
          createInitialExpanded(result.summary?.output || result.summary?.detail)
        );
        updateIsEditingFollowUp(false);
        updateFollowUpValue('');
        setPhase('review');
      })
      .catch((error) => {
        if (cancelled) return;

        const fallback = createCouncilRuntimeFailureResult({
          query: prompt,
          cwd,
          members,
          summarizer,
          maxMemberChars,
          error
        });

        setActiveRun(null);
        setLastResult(fallback);
        setConversationState((current) => [
          ...current,
          {
            user: prompt,
            assistant: summaryTextForConversation(fallback)
          }
        ]);
        setSessionState(hydrateSessionStateFromResult(fallback, members));
        setExpanded(
          createInitialExpanded(
            fallback.summary?.output || fallback.summary?.detail
          )
        );
        updateIsEditingFollowUp(false);
        updateFollowUpValue('');
        setPhase('review');
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeRun,
    cwd,
    effort,
    models,
    efforts,
    permissions,
    maxMemberChars,
    members,
    onEvent,
    phase,
    summarizer,
    timeoutMs
  ]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        process.exitCode = 130;
        exit(lastResult);
        return;
      }

      if (phase === 'prompt') {
        if (key.escape) {
          exit(null);
        }
        return;
      }

      if (phase === 'running') {
        if (/^[1-9]$/.test(input)) {
          toggleExpandedForHotkey(input, members, setExpanded);
        }
        return;
      }

      if (isEditingFollowUp) {
        return;
      }

      if (isEditingFollowUpRef.current) {
        const chunk = sanitizeImmediateFollowUpChunk(input);
        if (chunk) {
          updateFollowUpValue((current) => `${current}${chunk}`);
        }
        return;
      }

      if (input === 'q' || key.escape) {
        exit(lastResult);
        return;
      }

      if (/^[1-9]$/.test(input)) {
        toggleExpandedForHotkey(input, members, setExpanded);
        return;
      }

      const chunk = sanitizeImmediateFollowUpChunk(input);
      if (chunk) {
        updateIsEditingFollowUp(true);
        updateFollowUpValue((current) => `${current}${chunk}`);
      }
    },
    { isActive: isRawModeSupported }
  );

  const startRun = (rawPrompt) => {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      if (phase === 'prompt') {
        exit(null);
      } else {
        updateIsEditingFollowUp(false);
        updateFollowUpValue('');
      }
      return;
    }

    setSessionState(createSessionState(members));
    setExpanded(createInitialExpanded());
    updateIsEditingFollowUp(false);
    updateFollowUpValue('');
    setPhase('running');
    setRunSequence((current) => {
      const next = current + 1;
      setActiveRun({ id: next, prompt });
      return next;
    });
  };

  if (phase === 'prompt') {
    return h(PromptComposer, {
      defaultValue: promptValue,
      onChange: setPromptValue,
      onSubmit: startRun
    });
  }

  const blocks = buildInteractiveBlocks({
    phase,
    state: sessionState,
    members,
    expanded
  });

  return h(
    Fragment,
    null,
    h(
      Box,
      { flexDirection: 'column' },
      blocks.map((block) =>
        h(SessionBlock, {
          key: block.id,
          block
        })
      )
    ),
    phase === 'review' && isEditingFollowUp
      ? h(PromptComposer, {
          defaultValue: followUpValue,
          onChange: updateFollowUpValue,
          onSubmit: startRun,
          onCancel: () => {
            updateIsEditingFollowUp(false);
            updateFollowUpValue('');
          }
        })
      : h(HotkeyFooter, {
          members,
          expanded,
          detailText:
            phase === 'running'
              ? 'Press a number to toggle any completed output inline. Ctrl-C to exit.'
              : 'Press a number to toggle full output inline. Type to start a follow-up. q or Esc to exit.'
        })
  );
}

function PromptComposer({
  defaultValue = '',
  onChange,
  onSubmit,
  onCancel = null
}) {
  const [value, setValue] = useState(defaultValue);
  const [cursorOffset, setCursorOffset] = useState(defaultValue.length);

  const updateValue = (nextValue, nextCursorOffset = nextValue.length) => {
    setValue(nextValue);
    setCursorOffset(nextCursorOffset);
    onChange?.(nextValue);
  };

  const insertText = (text) => {
    const sanitized = sanitizeImmediateFollowUpChunk(text);
    if (!sanitized) {
      return;
    }

    const nextValue =
      value.slice(0, cursorOffset) + sanitized + value.slice(cursorOffset);
    updateValue(nextValue, cursorOffset + sanitized.length);
  };

  useInput(
    (input, key) => {
      if (key.escape && onCancel) {
        onCancel();
        return;
      }

      if (key.return) {
        onSubmit(value);
        return;
      }

      if (key.leftArrow) {
        setCursorOffset((current) => Math.max(0, current - 1));
        return;
      }

      if (key.rightArrow) {
        setCursorOffset((current) => Math.min(value.length, current + 1));
        return;
      }

      if (key.backspace) {
        if (cursorOffset === 0) {
          return;
        }

        const nextCursorOffset = cursorOffset - 1;
        const nextValue =
          value.slice(0, nextCursorOffset) + value.slice(cursorOffset);
        updateValue(nextValue, nextCursorOffset);
        return;
      }

      if (key.delete) {
        if (cursorOffset >= value.length) {
          return;
        }

        const nextValue =
          value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
        updateValue(nextValue, cursorOffset);
        return;
      }

      if (
        key.upArrow ||
        key.downArrow ||
        key.tab ||
        (key.shift && key.tab) ||
        (key.ctrl && input === 'c')
      ) {
        return;
      }

      insertText(input);
    },
    { isActive: true }
  );

  usePaste(
    (text) => {
      insertText(text);
    },
    { isActive: true }
  );

  const renderedValue = useMemo(() => {
    const cursor = '|';

    if (value.length === 0) {
      return cursor;
    }

    return `${value.slice(0, cursorOffset)}${cursor}${value.slice(cursorOffset)}`;
  }, [cursorOffset, value]);

  return h(
    Box,
    { marginTop: 1 },
    h(Text, { color: 'cyan' }, 'you> '),
    h(Text, null, renderedValue)
  );
}

function SessionBlock({ block }) {
  if (block.kind === 'header') {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'cyan' }, block.text)
    );
  }

  if (block.kind === 'divider') {
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'gray' }, ''),
      h(Text, { color: block.color }, block.text)
    );
  }

  if (block.kind === 'result-row') {
    const line = block.expanded
      ? block.headerText
      : block.previewText
        ? `${block.headerText}: "${block.previewText}"`
        : block.headerText;

    if (!block.expanded || !block.body) {
      return h(Text, { color: block.color }, line);
    }

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: block.color }, line),
      h(
        Box,
        { paddingLeft: 4, flexDirection: 'column' },
        h(Text, null, block.body)
      )
    );
  }

  return null;
}

function HotkeyFooter({ members, expanded, detailText }) {
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(
      Text,
      { color: 'gray' },
      `Hotkeys: ${buildHotkeyParts(members, expanded).join('  ')}`
    ),
    h(Text, { color: 'gray' }, detailText)
  );
}

export function sanitizeImmediateFollowUpChunk(input) {
  return Array.from(input || '')
    .filter((char) => char === '\n' || char === '\r' || char === '\t' || char >= ' ')
    .filter((char) => char !== '\u007f' && char !== '\u001b')
    .join('');
}

function toggleExpandedForHotkey(input, members, setExpanded) {
  const idx = parseInt(input, 10);
  if (idx >= 1 && idx <= members.length) {
    setExpanded((current) =>
      toggleExpanded(current, `member:${members[idx - 1]}`)
    );
    return;
  }

  if (idx === members.length + 1) {
    setExpanded((current) => toggleExpanded(current, 'summary'));
  }
}

export function createInitialExpanded(summaryText = '') {
  const expanded = new Set();

  if (summaryText) {
    expanded.add('summary');
  }

  return expanded;
}

export function toggleExpanded(expanded, id) {
  const next = new Set(expanded);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function buildInteractiveBlocks({
  phase,
  state,
  members,
  expanded,
  now = Date.now()
}) {
  return buildSessionBlocks({
    headerText:
      phase === 'running'
        ? `Council is consulting: ${members.join(', ')}`
        : `Council consulted: ${members.join(', ')}`,
    state,
    members,
    expanded,
    now
  });
}
