import {
  createElement as h,
  Fragment,
  useCallback,
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
  useStdin,
  useStdout
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

const STUDIO_PANES = ['menu', 'settings', 'agents', 'results'];
const STUDIO_FOCUS_ORDER = ['menu', 'settings', 'agents', 'results', 'prompt'];
const STUDIO_ENGINES = ['codex', 'claude', 'gemini'];
const STUDIO_MENU = [
  { id: 'run', label: 'Run / re-run' },
  { id: 'prompt', label: 'Edit prompt' },
  { id: 'settings', label: 'Settings' },
  { id: 'agents', label: 'Agents' },
  { id: 'results', label: 'Results' },
  { id: 'help', label: 'Help' },
  { id: 'quit', label: 'Quit' }
];
const STUDIO_CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const STUDIO_CLAUDE_PERMISSIONS = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];
const STUDIO_AUTHS = {
  codex: ['auto', 'social-login', 'login', 'api-key'],
  claude: ['auto', 'social-login', 'oauth', 'api-key', 'keychain'],
  gemini: ['auto', 'social-login', 'login', 'api-key']
};
const STUDIO_EFFORTS = {
  codex: [null, 'low', 'medium', 'high', 'xhigh'],
  claude: [null, 'low', 'medium', 'high', 'xhigh', 'max'],
  gemini: [null, 'low', 'medium', 'high']
};

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
  const app = render(h(options.studio ? StudioApp : SessionApp, options), {
    stdout: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true
  });

  return app.waitUntilExit();
}

function useDoubleCtrlCExit(exit, lastResult) {
  const [exitArmedUntil, setExitArmedUntil] = useState(0);
  const exitArmedUntilRef = useRef(0);
  const lastResultRef = useRef(lastResult);

  useEffect(() => {
    lastResultRef.current = lastResult;
  }, [lastResult]);

  const requestExit = useCallback(() => {
    const now = Date.now();
    if (now < exitArmedUntilRef.current) {
      process.exitCode = 130;
      exit(lastResultRef.current);
      setImmediate(() => {
        process.exit(130);
      });
      return;
    }

    const nextExitArmedUntil = now + 5_000;
    exitArmedUntilRef.current = nextExitArmedUntil;
    setExitArmedUntil(nextExitArmedUntil);
  }, [exit]);

  useEffect(() => {
    process.on('SIGINT', requestExit);
    return () => {
      process.off('SIGINT', requestExit);
    };
  }, [requestExit]);

  return { exitArmedUntil, requestExit };
}

function StudioApp(props) {
  const {
    initialPrompt = '',
    timeoutMs,
    maxMemberChars,
    cwd,
    effort = null,
    conversation = [],
    onEvent
  } = props;
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [config, setConfig] = useState(() => createStudioConfig(props));
  const configRef = useRef(config);
  const [phase, setPhase] = useState('setup');
  const [promptValue, setPromptValue] = useState(initialPrompt.trim());
  const [cursorOffset, setCursorOffset] = useState(initialPrompt.trim().length);
  const [editingPrompt, setEditingPrompt] = useState(!initialPrompt.trim());
  const [showHelp, setShowHelp] = useState(false);
  const [focusPane, setFocusPane] = useState('menu');
  const [paneOrder, setPaneOrder] = useState([...STUDIO_PANES]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [settingIndex, setSettingIndex] = useState(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [resultIndex, setResultIndex] = useState(0);
  const [expanded, setExpanded] = useState(createInitialExpanded);
  const [conversationState, setConversationState] = useState(() => [
    ...conversation
  ]);
  const conversationRef = useRef([...conversation]);
  const [sessionState, setSessionState] = useState(() =>
    createSessionState(enabledStudioMembers(config))
  );
  const [lastResult, setLastResult] = useState(null);
  const { exitArmedUntil, requestExit } = useDoubleCtrlCExit(exit, lastResult);
  const [, setRunSequence] = useState(0);
  const [activeRun, setActiveRun] = useState(null);
  const [, setTick] = useState(0);
  const columns = stdout?.columns || 140;

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    conversationRef.current = conversationState;
  }, [conversationState]);

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
    const runConfig = activeRun.config;
    const runMembers = enabledStudioMembers(runConfig);

    runCouncil({
      query: prompt,
      members: runMembers,
      summarizer: runConfig.summarizer,
      timeoutMs,
      maxMemberChars,
      cwd,
      effort,
      models: runConfig.models,
      efforts: runConfig.efforts,
      permissions: runConfig.permissions,
      auths: runConfig.auths,
      handoff: runConfig.handoff,
      lead: runConfig.lead,
      planner: runConfig.planner,
      iterations: runConfig.iterations,
      teamWork: runConfig.teamWork,
      teams: runConfig.teams,
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
        setSessionState(hydrateSessionStateFromResult(result, runMembers));
        setExpanded(
          createInitialExpanded(result.summary?.output || result.summary?.detail)
        );
        setResultIndex(runMembers.length);
        setPhase('review');
      })
      .catch((error) => {
        if (cancelled) return;

        const fallback = createCouncilRuntimeFailureResult({
          query: prompt,
          cwd,
          members: runMembers,
          summarizer: runConfig.summarizer,
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
        setSessionState(hydrateSessionStateFromResult(fallback, runMembers));
        setExpanded(
          createInitialExpanded(
            fallback.summary?.output || fallback.summary?.detail
          )
        );
        setPhase('review');
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeRun,
    cwd,
    effort,
    maxMemberChars,
    onEvent,
    phase,
    timeoutMs
  ]);

  const setPromptText = (nextValue, nextCursorOffset = nextValue.length) => {
    setPromptValue(nextValue);
    setCursorOffset(Math.max(0, Math.min(nextValue.length, nextCursorOffset)));
  };

  const startStudioRun = () => {
    const prompt = promptValue.trim();
    if (!prompt || phase === 'running') {
      return;
    }

    const nextConfig = sanitizeStudioConfig(configRef.current);
    const members = enabledStudioMembers(nextConfig);
    setConfig(nextConfig);
    setSessionState(createSessionState(members));
    setExpanded(createInitialExpanded());
    setEditingPrompt(false);
    setFocusPane('results');
    setPhase('running');
    setRunSequence((current) => {
      const next = current + 1;
      setActiveRun({ id: next, prompt, config: nextConfig });
      return next;
    });
  };

  const executeMenuAction = (actionId) => {
    if (actionId === 'run') {
      startStudioRun();
      return;
    }

    if (actionId === 'prompt') {
      setFocusPane('prompt');
      setEditingPrompt(true);
      return;
    }

    if (actionId === 'quit') {
      exit(lastResult);
      return;
    }

    if (actionId === 'help') {
      setShowHelp((current) => !current);
      return;
    }

    if (STUDIO_FOCUS_ORDER.includes(actionId)) {
      setFocusPane(actionId);
    }
  };

  const moveFocus = (direction) => {
    setFocusPane((current) => {
      const idx = STUDIO_FOCUS_ORDER.indexOf(current);
      const nextIdx = wrapIndex(idx + direction, STUDIO_FOCUS_ORDER.length);
      return STUDIO_FOCUS_ORDER[nextIdx];
    });
  };

  const moveFocusedPane = (direction) => {
    if (!STUDIO_PANES.includes(focusPane)) {
      return;
    }

    setPaneOrder((current) => moveStudioPane(current, focusPane, direction));
  };

  const updatePromptFromInput = (input, key) => {
    if (key.escape) {
      setEditingPrompt(false);
      return;
    }

    if (key.return) {
      startStudioRun();
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset((current) => Math.min(promptValue.length, current + 1));
      return;
    }

    if (key.backspace) {
      if (cursorOffset === 0) {
        return;
      }

      const nextCursorOffset = cursorOffset - 1;
      setPromptText(
        promptValue.slice(0, nextCursorOffset) + promptValue.slice(cursorOffset),
        nextCursorOffset
      );
      return;
    }

    if (key.delete) {
      if (cursorOffset >= promptValue.length) {
        return;
      }

      setPromptText(
        promptValue.slice(0, cursorOffset) + promptValue.slice(cursorOffset + 1),
        cursorOffset
      );
      return;
    }

    if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === 'c')) {
      return;
    }

    const chunk = sanitizeImmediateFollowUpChunk(input);
    if (chunk) {
      setPromptText(
        promptValue.slice(0, cursorOffset) + chunk + promptValue.slice(cursorOffset),
        cursorOffset + chunk.length
      );
    }
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        requestExit();
        return;
      }

      if (editingPrompt) {
        updatePromptFromInput(input, key);
        return;
      }

      if (showHelp && (key.escape || key.return || input === '?')) {
        setShowHelp(false);
        return;
      }

      if (input === 'q' || key.escape) {
        exit(lastResult);
        return;
      }

      if (input === '?') {
        setShowHelp((current) => !current);
        return;
      }

      if (key.tab) {
        moveFocus(key.shift ? -1 : 1);
        return;
      }

      if (input === '[') {
        moveFocusedPane(-1);
        return;
      }

      if (input === ']') {
        moveFocusedPane(1);
        return;
      }

      if (input === 'r') {
        startStudioRun();
        return;
      }

      if (input === 'e') {
        setFocusPane('prompt');
        setEditingPrompt(true);
        return;
      }

      if (/^[1-9]$/.test(input)) {
        toggleExpandedForHotkey(input, enabledStudioMembers(config), setExpanded);
        setFocusPane('results');
        return;
      }

      if (key.leftArrow) {
        if (focusPane === 'settings') {
          const setting = buildStudioSettings(config)[settingIndex];
          if (setting) setConfig((current) => applyStudioSetting(current, setting.id, -1));
        } else {
          moveFocus(-1);
        }
        return;
      }

      if (key.rightArrow) {
        if (focusPane === 'settings') {
          const setting = buildStudioSettings(config)[settingIndex];
          if (setting) setConfig((current) => applyStudioSetting(current, setting.id, 1));
        } else {
          moveFocus(1);
        }
        return;
      }

      if (key.upArrow) {
        if (focusPane === 'menu') setMenuIndex((current) => wrapIndex(current - 1, STUDIO_MENU.length));
        if (focusPane === 'settings') setSettingIndex((current) => wrapIndex(current - 1, buildStudioSettings(config).length));
        if (focusPane === 'agents') setAgentIndex((current) => wrapIndex(current - 1, STUDIO_ENGINES.length));
        if (focusPane === 'results') setResultIndex((current) => wrapIndex(current - 1, enabledStudioMembers(config).length + 1));
        return;
      }

      if (key.downArrow) {
        if (focusPane === 'menu') setMenuIndex((current) => wrapIndex(current + 1, STUDIO_MENU.length));
        if (focusPane === 'settings') setSettingIndex((current) => wrapIndex(current + 1, buildStudioSettings(config).length));
        if (focusPane === 'agents') setAgentIndex((current) => wrapIndex(current + 1, STUDIO_ENGINES.length));
        if (focusPane === 'results') setResultIndex((current) => wrapIndex(current + 1, enabledStudioMembers(config).length + 1));
        return;
      }

      if (key.return) {
        if (focusPane === 'menu') {
          executeMenuAction(STUDIO_MENU[menuIndex].id);
        } else if (focusPane === 'settings') {
          const setting = buildStudioSettings(config)[settingIndex];
          if (setting) setConfig((current) => applyStudioSetting(current, setting.id, 1));
        } else if (focusPane === 'agents') {
          setConfig((current) => toggleStudioMember(current, STUDIO_ENGINES[agentIndex]));
        } else if (focusPane === 'results') {
          toggleStudioResult(resultIndex, enabledStudioMembers(config), setExpanded);
        } else if (focusPane === 'prompt') {
          setEditingPrompt(true);
        }
        return;
      }

      if (focusPane === 'agents') {
        const engine = STUDIO_ENGINES[agentIndex];
        if (input === 'l') setConfig((current) => setStudioLead(current, engine));
        if (input === 'p') setConfig((current) => setStudioPlanner(current, engine));
        if (input === '+' || input === '=') setConfig((current) => adjustStudioTeam(current, engine, 1));
        if (input === '-') setConfig((current) => adjustStudioTeam(current, engine, -1));
      }
    },
    { isActive: isRawModeSupported }
  );

  usePaste(
    (text) => {
      if (!editingPrompt) {
        return;
      }

      const sanitized = sanitizeImmediateFollowUpChunk(text);
      if (!sanitized) {
        return;
      }

      setPromptText(
        promptValue.slice(0, cursorOffset) + sanitized + promptValue.slice(cursorOffset),
        cursorOffset + sanitized.length
      );
    },
    { isActive: editingPrompt }
  );

  const settings = buildStudioSettings(config);
  const members = enabledStudioMembers(config);
  const compactLayout = columns < 120;
  const panelWidths = calculateStudioPanelWidths(columns, compactLayout);
  const paneRows = compactLayout
    ? [paneOrder.slice(0, 2), paneOrder.slice(2)]
    : [paneOrder];

  return h(
    Box,
    { flexDirection: 'column' },
    h(StudioHeader, {
      phase,
      config,
      members,
      activeRun,
      lastResult
    }),
    ...paneRows.map((row, rowIndex) =>
      h(
        Box,
        { key: row.join(':'), flexDirection: 'row', marginTop: rowIndex === 0 ? 0 : 1 },
        row.map((pane, index) =>
          h(StudioPane, {
            key: pane,
            pane,
            width: panelWidths[pane],
            marginRight: index < row.length - 1 ? 1 : 0,
            focused: focusPane === pane,
            config,
            members,
            settings,
            menuIndex,
            settingIndex,
            agentIndex,
            resultIndex,
            sessionState,
            expanded,
            phase
          })
        )
      )
    ),
    h(StudioPromptPanel, {
      focused: focusPane === 'prompt',
      editing: editingPrompt,
      promptValue,
      cursorOffset
    }),
    showHelp ? h(StudioHelpPanel) : null,
    h(StudioFooter, { phase, focusPane, editingPrompt, exitArmedUntil })
  );
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
  auths = {},
  handoff = false,
  lead = null,
  planner = null,
  iterations = 1,
  teamWork = 0,
  teams = {},
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
  const { exitArmedUntil, requestExit } = useDoubleCtrlCExit(exit, lastResult);
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
      auths,
      handoff,
      lead,
      planner,
      iterations,
      teamWork,
      teams,
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
    auths,
    handoff,
    lead,
    planner,
    iterations,
    teamWork,
    teams,
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
        requestExit();
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
              : 'Press a number to toggle full output inline. Type to start a follow-up. q or Esc to exit.',
          exitArmedUntil
        })
  );
}

function StudioHeader({ phase, config, members, activeRun, lastResult }) {
  const status = activeRun
    ? `running #${activeRun.id}`
    : lastResult
      ? `last: ${lastResult.summary?.status || 'done'}`
      : phase;
  const workflow = [
    `members ${members.join(',') || 'none'}`,
    `lead ${config.lead || 'auto'}`,
    `planner ${config.planner || 'none'}`,
    config.handoff ? 'handoff on' : 'parallel',
    `${config.iterations}x`
  ].join('  ');

  return h(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    h(Text, { color: 'cyan', bold: true }, 'Council Studio'),
    h(Text, { color: 'gray' }, `${status} | ${workflow}`)
  );
}

function StudioPane({
  pane,
  width,
  marginRight = 0,
  focused,
  config,
  members,
  settings,
  menuIndex,
  settingIndex,
  agentIndex,
  resultIndex,
  sessionState,
  expanded,
  phase
}) {
  const title = {
    menu: 'Command Palette',
    settings: 'Settings',
    agents: 'Agents',
    results: 'Canvas'
  }[pane];

  return h(
    Box,
    {
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      width,
      marginRight,
      minHeight: 17,
      paddingX: 1,
      flexDirection: 'column'
    },
    h(Text, { color: focused ? 'cyan' : 'gray', bold: focused }, title),
    pane === 'menu'
      ? h(StudioMenuPane, { selectedIndex: menuIndex, focused })
      : null,
    pane === 'settings'
      ? h(StudioSettingsPane, { settings, selectedIndex: settingIndex, focused })
      : null,
    pane === 'agents'
      ? h(StudioAgentsPane, { config, selectedIndex: agentIndex, focused })
      : null,
    pane === 'results'
      ? h(StudioResultsPane, {
          members,
          sessionState,
          expanded,
          selectedIndex: resultIndex,
          focused,
          phase
        })
      : null
  );
}

function StudioMenuPane({ selectedIndex, focused }) {
  return h(
    Box,
    { flexDirection: 'column' },
    STUDIO_MENU.map((item, index) =>
      h(
        Text,
        {
          key: item.id,
          color: focused && index === selectedIndex ? 'black' : undefined,
          backgroundColor: focused && index === selectedIndex ? 'cyan' : undefined
        },
        `${focused && index === selectedIndex ? '>' : ' '} ${item.label}`
      )
    )
  );
}

function StudioSettingsPane({ settings, selectedIndex, focused }) {
  return h(
    Box,
    { flexDirection: 'column' },
    settings.map((setting, index) =>
      h(
        Text,
        {
          key: setting.id,
          color: focused && index === selectedIndex ? 'black' : undefined,
          backgroundColor: focused && index === selectedIndex ? 'yellow' : undefined
        },
        `${focused && index === selectedIndex ? '>' : ' '} ${setting.label}: ${setting.value}`
      )
    )
  );
}

function StudioAgentsPane({ config, selectedIndex, focused }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...STUDIO_ENGINES.map((engine, index) => {
      const enabled = config.members.includes(engine);
      const role = studioRoleForEngine(config, engine);
      const selected = focused && index === selectedIndex;
      const detail = `${role}  team:${config.teams[engine] ?? config.teamWork}  auth:${config.auths[engine]}`;

      return h(
        Fragment,
        { key: engine },
        h(
          Text,
          {
            color: selected ? 'black' : enabled ? 'green' : 'gray',
            backgroundColor: selected ? 'green' : undefined
          },
          `${selected ? '>' : ' '} [${enabled ? 'x' : ' '}] ${engine}`
        ),
        h(Text, { color: enabled ? 'gray' : 'gray' }, `    ${detail}`)
      );
    })
  );
}

function StudioResultsPane({
  members,
  sessionState,
  expanded,
  selectedIndex,
  focused,
  phase
}) {
  const blocks = buildInteractiveBlocks({
    phase,
    state: sessionState,
    members,
    expanded
  }).filter((block) => block.kind === 'result-row');

  return h(
    Box,
    { flexDirection: 'column' },
    blocks.map((block, index) => {
      const selected = focused && index === selectedIndex;
      const text = block.previewText
        ? `${block.headerText}: ${block.previewText}`
        : block.headerText;

      return h(
        Text,
        {
          key: block.id,
          color: selected ? 'black' : block.color,
          backgroundColor: selected ? 'magenta' : undefined
        },
        `${selected ? '>' : ' '} ${text}`
      );
    }),
    blocks.length === 0
      ? h(Text, { color: 'gray' }, '  Run the council to populate the canvas.')
      : null
  );
}

function StudioPromptPanel({ focused, editing, promptValue, cursorOffset }) {
  const renderedPrompt = editing
    ? renderPromptWithCursor(promptValue, cursorOffset)
    : promptValue || '(empty)';

  return h(
    Box,
    {
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      marginTop: 1,
      paddingX: 1,
      flexDirection: 'column'
    },
    h(Text, { color: focused ? 'cyan' : 'gray', bold: focused }, 'Prompt'),
    h(Text, null, renderedPrompt)
  );
}

function StudioHelpPanel() {
  const lines = [
    'Tab / Shift-Tab: move focus between panes',
    'Arrow keys: move selection; left/right changes selected setting',
    'Enter: activate selected menu item, toggle provider, expand selected result, or start prompt editing',
    'Agents pane: l lead, p planner, +/- provider team size',
    'Settings pane: choose handoff, lead/planner, synthesis, auth methods, permissions, efforts, iterations',
    '[ and ]: move the focused pane left/right',
    'r: run or re-run without restarting node',
    'e: edit prompt',
    '1-4: expand provider/synthesis results',
    '?: toggle this help panel',
    'Ctrl-C once arms exit; Ctrl-C again closes'
  ];

  return h(
    Box,
    {
      borderStyle: 'single',
      borderColor: 'yellow',
      marginTop: 1,
      paddingX: 1,
      flexDirection: 'column'
    },
    h(Text, { color: 'yellow', bold: true }, 'Help'),
    ...lines.map((line) => h(Text, { key: line }, line))
  );
}

function StudioFooter({ phase, focusPane, editingPrompt, exitArmedUntil = 0 }) {
  const detail = editingPrompt
    ? 'typing prompt | Enter run | Esc keep'
    : 'Tab focus | arrows select/change | Enter action | [ ] move pane | r run | e edit | ? help | q quit';
  const exitHint = Date.now() < exitArmedUntil
    ? 'Ctrl-C again to close'
    : 'Ctrl-C twice to close';

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { color: 'gray' }, `${phase} | focus:${focusPane}`),
    h(Text, { color: 'gray' }, `${detail} | ${exitHint}`)
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
    const iterationText = block.iteration?.total > 1
      ? `iteration ${block.iteration.current}/${block.iteration.total}`
      : null;

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'cyan' }, block.text),
      h(
        Text,
        { color: 'gray' },
        [iterationText, block.subtitle].filter(Boolean).join(' | ')
      )
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

function HotkeyFooter({ members, expanded, detailText, exitArmedUntil = 0 }) {
  const exitHint = Date.now() < exitArmedUntil
    ? 'Ctrl-C again to close.'
    : 'Ctrl-C twice to close.';

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(
      Text,
      { color: 'gray' },
      `Hotkeys: ${buildHotkeyParts(members, expanded).join('  ')}`
    ),
    h(Text, { color: 'gray' }, `${detailText} ${exitHint}`)
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
        ? `Council Studio: consulting ${members.join(', ')}`
        : `Council Studio: consulted ${members.join(', ')}`,
    state,
    members,
    expanded,
    now
  });
}

export function createStudioConfig(options = {}) {
  const members = Array.isArray((options as any).members) && (options as any).members.length > 0
    ? [...(options as any).members]
    : [...STUDIO_ENGINES];
  const teamWork = Math.max(0, Number((options as any).teamWork ?? 0) || 0);

  return sanitizeStudioConfig({
    members,
    summarizer: (options as any).summarizer || 'auto',
    handoff: Boolean((options as any).handoff),
    lead: (options as any).lead || null,
    planner: (options as any).planner || null,
    iterations: Math.max(1, Number((options as any).iterations ?? 1) || 1),
    teamWork,
    teams: {
      codex: normalizeOptionalTeam((options as any).teams?.codex, teamWork),
      claude: normalizeOptionalTeam((options as any).teams?.claude, teamWork),
      gemini: normalizeOptionalTeam((options as any).teams?.gemini, teamWork)
    },
    models: {
      codex: (options as any).models?.codex ?? null,
      claude: (options as any).models?.claude ?? null,
      gemini: (options as any).models?.gemini ?? null
    },
    efforts: {
      codex: (options as any).efforts?.codex ?? (options as any).effort ?? null,
      claude: (options as any).efforts?.claude ?? (options as any).effort ?? null,
      gemini: (options as any).efforts?.gemini ?? (options as any).effort ?? null
    },
    permissions: {
      codex: (options as any).permissions?.codex ?? 'read-only',
      claude: (options as any).permissions?.claude ?? 'plan',
      gemini: null
    },
    auths: {
      codex: (options as any).auths?.codex ?? 'auto',
      claude: (options as any).auths?.claude ?? 'auto',
      gemini: (options as any).auths?.gemini ?? 'auto'
    }
  });
}

export function buildStudioSettings(config) {
  return [
    { id: 'handoff', label: 'Handoff', value: config.handoff ? 'on' : 'off' },
    { id: 'lead', label: 'Lead', value: config.lead || 'auto' },
    { id: 'planner', label: 'Planner', value: config.planner || 'none' },
    { id: 'summarizer', label: 'Synthesis', value: config.summarizer || 'auto' },
    { id: 'iterations', label: 'Iterations', value: String(config.iterations) },
    { id: 'teamWork', label: 'Team default', value: String(config.teamWork) },
    { id: 'codexAuth', label: 'Codex auth', value: config.auths.codex },
    { id: 'claudeAuth', label: 'Claude auth', value: config.auths.claude },
    { id: 'geminiAuth', label: 'Gemini auth', value: config.auths.gemini },
    { id: 'codexSandbox', label: 'Codex sandbox', value: config.permissions.codex },
    { id: 'claudePermission', label: 'Claude permission', value: config.permissions.claude },
    { id: 'codexEffort', label: 'Codex effort', value: config.efforts.codex || 'default' },
    { id: 'claudeEffort', label: 'Claude effort', value: config.efforts.claude || 'default' },
    { id: 'geminiEffort', label: 'Gemini effort', value: config.efforts.gemini || 'default' }
  ];
}

export function applyStudioSetting(config, settingId, direction = 1) {
  const next = cloneStudioConfig(config);
  const enabled = enabledStudioMembers(next);

  if (settingId === 'handoff') {
    next.handoff = !next.handoff;
  } else if (settingId === 'lead') {
    next.lead = cycleNullableValue(next.lead, [null, ...enabled], direction);
  } else if (settingId === 'planner') {
    next.planner = cycleNullableValue(next.planner, [null, ...enabled], direction);
  } else if (settingId === 'summarizer') {
    next.summarizer = cycleNullableValue(next.summarizer === 'auto' ? null : next.summarizer, [null, ...enabled], direction) || 'auto';
  } else if (settingId === 'iterations') {
    next.iterations = Math.max(1, next.iterations + direction);
  } else if (settingId === 'teamWork') {
    next.teamWork = Math.max(0, next.teamWork + direction);
    for (const engine of STUDIO_ENGINES) {
      if (next.teams[engine] === config.teamWork) {
        next.teams[engine] = next.teamWork;
      }
    }
  } else if (settingId === 'codexSandbox') {
    next.permissions.codex = cycleValue(next.permissions.codex, STUDIO_CODEX_SANDBOXES, direction);
  } else if (settingId === 'claudePermission') {
    next.permissions.claude = cycleValue(next.permissions.claude, STUDIO_CLAUDE_PERMISSIONS, direction);
  } else if (settingId === 'codexAuth') {
    next.auths.codex = cycleValue(next.auths.codex, STUDIO_AUTHS.codex, direction);
  } else if (settingId === 'claudeAuth') {
    next.auths.claude = cycleValue(next.auths.claude, STUDIO_AUTHS.claude, direction);
  } else if (settingId === 'geminiAuth') {
    next.auths.gemini = cycleValue(next.auths.gemini, STUDIO_AUTHS.gemini, direction);
  } else if (settingId === 'codexEffort') {
    next.efforts.codex = cycleNullableValue(next.efforts.codex, STUDIO_EFFORTS.codex, direction);
  } else if (settingId === 'claudeEffort') {
    next.efforts.claude = cycleNullableValue(next.efforts.claude, STUDIO_EFFORTS.claude, direction);
  } else if (settingId === 'geminiEffort') {
    next.efforts.gemini = cycleNullableValue(next.efforts.gemini, STUDIO_EFFORTS.gemini, direction);
  }

  return sanitizeStudioConfig(next);
}

export function moveStudioPane(order, pane, direction) {
  const next = [...order];
  const from = next.indexOf(pane);
  if (from === -1) {
    return next;
  }

  const to = wrapIndex(from + direction, next.length);
  next.splice(from, 1);
  next.splice(to, 0, pane);
  return next;
}

function enabledStudioMembers(config) {
  return STUDIO_ENGINES.filter((engine) => config.members.includes(engine));
}

function sanitizeStudioConfig(config) {
  const next = cloneStudioConfig(config);
  next.members = STUDIO_ENGINES.filter((engine) => next.members.includes(engine));

  if (next.members.length === 0) {
    next.members = ['codex'];
  }

  if (next.lead && !next.members.includes(next.lead)) {
    next.lead = null;
  }

  if (next.planner && !next.members.includes(next.planner)) {
    next.planner = null;
  }

  if (next.summarizer !== 'auto' && !next.members.includes(next.summarizer)) {
    next.summarizer = 'auto';
  }

  next.iterations = Math.max(1, Number(next.iterations) || 1);
  next.teamWork = Math.max(0, Number(next.teamWork) || 0);

  for (const engine of STUDIO_ENGINES) {
    next.teams[engine] = Math.max(0, Number(next.teams[engine] ?? next.teamWork) || 0);
    if (!STUDIO_AUTHS[engine].includes(next.auths[engine])) {
      next.auths[engine] = 'auto';
    }
  }

  return next;
}

function cloneStudioConfig(config) {
  return {
    ...config,
    members: [...(config.members || [])],
    teams: { ...(config.teams || {}) },
    models: { ...(config.models || {}) },
    efforts: { ...(config.efforts || {}) },
    permissions: { ...(config.permissions || {}) },
    auths: { ...(config.auths || {}) }
  };
}

function toggleStudioMember(config, engine) {
  const next = cloneStudioConfig(config);
  if (next.members.includes(engine)) {
    if (next.members.length > 1) {
      next.members = next.members.filter((member) => member !== engine);
    }
  } else {
    next.members = STUDIO_ENGINES.filter(
      (member) => next.members.includes(member) || member === engine
    );
  }

  return sanitizeStudioConfig(next);
}

function setStudioLead(config, engine) {
  const next = cloneStudioConfig(config);
  if (!next.members.includes(engine)) {
    next.members.push(engine);
  }
  next.lead = next.lead === engine ? null : engine;
  return sanitizeStudioConfig(next);
}

function setStudioPlanner(config, engine) {
  const next = cloneStudioConfig(config);
  if (!next.members.includes(engine)) {
    next.members.push(engine);
  }
  next.planner = next.planner === engine ? null : engine;
  return sanitizeStudioConfig(next);
}

function adjustStudioTeam(config, engine, direction) {
  const next = cloneStudioConfig(config);
  next.teams[engine] = Math.max(0, (next.teams[engine] ?? next.teamWork) + direction);
  return sanitizeStudioConfig(next);
}

function studioRoleForEngine(config, engine) {
  if (config.lead === engine && config.planner === engine) {
    return 'lead+planner';
  }

  if (config.lead === engine) {
    return 'lead';
  }

  if (config.planner === engine) {
    return 'planner';
  }

  return 'executor';
}

function toggleStudioResult(index, members, setExpanded) {
  if (index < members.length) {
    setExpanded((current) => toggleExpanded(current, `member:${members[index]}`));
    return;
  }

  setExpanded((current) => toggleExpanded(current, 'summary'));
}

function cycleValue(current, values, direction) {
  const idx = values.indexOf(current);
  return values[wrapIndex(idx + direction, values.length)];
}

function cycleNullableValue(current, values, direction) {
  const idx = values.indexOf(current ?? null);
  return values[wrapIndex(idx + direction, values.length)] ?? null;
}

function normalizeOptionalTeam(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return Math.max(0, Number(value) || 0);
}

function wrapIndex(index, length) {
  if (length <= 0) {
    return 0;
  }

  return ((index % length) + length) % length;
}

function calculateStudioPanelWidths(columns, compact = false) {
  if (compact) {
    const width = Math.max(34, Math.floor((Math.max(72, columns) - 3) / 2));
    return {
      menu: width,
      settings: width,
      agents: width,
      results: width
    };
  }

  const available = Math.max(90, columns - 3);
  const menu = Math.max(18, Math.min(24, Math.floor(available * 0.18)));
  const settings = Math.max(28, Math.min(36, Math.floor(available * 0.26)));
  const agents = Math.max(26, Math.min(34, Math.floor(available * 0.23)));
  const results = Math.max(28, available - menu - settings - agents);
  return { menu, settings, agents, results };
}

function renderPromptWithCursor(value, cursorOffset) {
  const cursor = '|';
  if (!value) {
    return cursor;
  }

  return `${value.slice(0, cursorOffset)}${cursor}${value.slice(cursorOffset)}`;
}
