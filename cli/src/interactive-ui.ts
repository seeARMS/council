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
  buildPromptWithContext,
  formatPromptContextStatus,
  loadTaggedFile,
  runPromptCommand
} from './prompt-context.js';
import {
  getLinearDeliveryStatus,
  runLinearDelivery
} from './delivery.js';
import {
  renderProviderSocialLoginResult,
  resolveSocialLoginProviders,
  runProviderSocialLogins
} from './provider-auth.js';
import {
  buildHotkeyParts,
  formatTelemetrySuffix,
  buildSessionBlocks
} from './presentation.js';
import {
  createCouncilRuntimeFailureResult,
  createSessionState,
  hydrateSessionStateFromResult,
  reduceSessionEvent,
  summaryTextForConversation
} from './session-core.js';

const STUDIO_PANES = ['menu', 'settings', 'agents', 'linear', 'results'];
const STUDIO_FOCUS_ORDER = ['menu', 'settings', 'agents', 'linear', 'results', 'prompt'];
const STUDIO_ENGINES = ['codex', 'claude', 'gemini'];
const STUDIO_MENU = [
  { id: 'run', label: 'Run / re-run' },
  { id: 'prompt', label: 'Edit prompt' },
  { id: 'socialLogin', label: 'Social login' },
  { id: 'linearStatus', label: 'Linear status' },
  { id: 'linearDeliver', label: 'Deliver Linear' },
  { id: 'linearIssue', label: 'Set Linear issue' },
  { id: 'linearQuery', label: 'Set Linear query' },
  { id: 'linearTeam', label: 'Set Linear team' },
  { id: 'linearState', label: 'Set Linear state' },
  { id: 'linearMedia', label: 'Attach Linear media' },
  { id: 'tagFile', label: 'Tag local file' },
  { id: 'runCommand', label: 'Run command' },
  { id: 'settings', label: 'Settings' },
  { id: 'agents', label: 'Agents' },
  { id: 'linear', label: 'Linear' },
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
const STUDIO_LINEAR_AUTH_METHODS = ['api-key', 'oauth'];
const STUDIO_LINEAR_MODES = ['off', 'deliver', 'watch'];
const STUDIO_LINEAR_WORKSPACE_STRATEGIES = ['worktree', 'copy', 'none'];
const DEFAULT_STUDIO_LINEAR_PHASES = ['plan', 'implement', 'verify', 'ship'];

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
  const [promptContext, setPromptContext] = useState(() => ({
    files: [...(props.promptContext?.files || [])],
    commands: [...(props.promptContext?.commands || [])]
  }));
  const promptContextRef = useRef(promptContext);
  const [promptAction, setPromptAction] = useState(null);
  const [actionStatus, setActionStatus] = useState('');
  const [authFlowActive, setAuthFlowActive] = useState(false);
  const [linearBusy, setLinearBusy] = useState(false);
  const [linearStatus, setLinearStatus] = useState(() =>
    createInitialStudioLinearStatus(config.linear, cwd, process.env)
  );
  const [linearResult, setLinearResult] = useState(null);
  const [linearEvents, setLinearEvents] = useState([]);
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
    promptContextRef.current = promptContext;
  }, [promptContext]);

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
    const displayPrompt = activeRun.displayPrompt || prompt;
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
            user: displayPrompt,
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
            user: displayPrompt,
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
    const query = buildPromptWithContext(prompt, promptContextRef.current);
    setConfig(nextConfig);
    setSessionState(createSessionState(members));
    setExpanded(createInitialExpanded());
    setEditingPrompt(false);
    setFocusPane('results');
    setPhase('running');
    setRunSequence((current) => {
      const next = current + 1;
      setActiveRun({ id: next, prompt: query, displayPrompt: prompt, config: nextConfig });
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

    if (actionId === 'socialLogin') {
      startStudioSocialLogin();
      return;
    }

    if (actionId === 'linearStatus') {
      startStudioLinearStatus();
      return;
    }

    if (actionId === 'linearDeliver') {
      startStudioLinearDelivery();
      return;
    }

    if (actionId === 'linearIssue') {
      startLinearFieldAction('issueIds', 'Set Linear issue IDs or keys');
      return;
    }

    if (actionId === 'linearQuery') {
      startLinearFieldAction('query', 'Set Linear query text');
      return;
    }

    if (actionId === 'linearTeam') {
      startLinearFieldAction('team', 'Set Linear team key');
      return;
    }

    if (actionId === 'linearState') {
      startLinearFieldAction('state', 'Set Linear state name');
      return;
    }

    if (actionId === 'linearMedia') {
      startLinearFieldAction('attachMedia', 'Attach Linear media paths or URLs');
      return;
    }

    if (actionId === 'tagFile') {
      startPromptAction('file');
      return;
    }

    if (actionId === 'runCommand') {
      startPromptAction('command');
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

  const startPromptAction = (kind) => {
    setPromptAction({
      kind,
      value: '',
      cursorOffset: 0
    });
    setActionStatus(kind === 'file' ? 'Enter a local file path to tag.' : 'Enter a shell command to run before the prompt.');
    setEditingPrompt(false);
    setFocusPane('prompt');
  };

  const startStudioSocialLogin = () => {
    if (phase === 'running' || authFlowActive || linearBusy) {
      return;
    }

    const nextConfig = sanitizeStudioConfig(configRef.current);
    const providers = resolveSocialLoginProviders({
      members: enabledStudioMembers(nextConfig),
      auths: nextConfig.auths
    });
    setConfig(nextConfig);
    setActionStatus(`Opening social login for ${providers.join(', ')}. Complete browser deeplinks or paste returned codes in this terminal.`);
    setAuthFlowActive(true);
    void runProviderSocialLogins({
      providers,
      cwd,
      env: process.env,
      input: process.stdin,
      output: process.stderr,
      openBrowser: true,
      onEvent: (event) => {
        onEvent?.(event);
        if (event.type === 'auth_login_started') {
          setActionStatus(`Social login running: ${event.provider}. Browser deeplink and terminal code paste are supported.`);
        }
        if (event.type === 'auth_login_url_opened') {
          setActionStatus(`Opened browser tab for ${event.provider}. Finish in the browser or paste the code here.`);
        }
      }
    })
      .then((result) => {
        setActionStatus(renderProviderSocialLoginResult(result).replace(/\n/g, ' | '));
      })
      .catch((error) => {
        setActionStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setAuthFlowActive(false);
      });
  };

  const startLinearFieldAction = (field, label) => {
    const current = configRef.current.linear?.[field];
    const value = Array.isArray(current) ? current.join(',') : String(current || '');
    setPromptAction({
      kind: 'linearField',
      field,
      label,
      value,
      cursorOffset: value.length
    });
    setActionStatus(`${label}. Press Enter to save.`);
    setEditingPrompt(false);
    setFocusPane('prompt');
  };

  const startStudioLinearStatus = () => {
    if (linearBusy) {
      return;
    }

    const nextConfig = sanitizeStudioConfig(configRef.current);
    const delivery = buildStudioLinearDelivery(nextConfig);
    setConfig(nextConfig);
    setFocusPane('linear');
    setLinearBusy(true);
    setActionStatus('Checking Linear setup, auth, state, workspace, and observability...');
    void getLinearDeliveryStatus({
      cwd,
      delivery,
      env: process.env
    })
      .then((status) => {
        setLinearStatus(status);
        setActionStatus(status.configured
          ? 'Linear auth is configured. Viewer/status loaded in the Linear pane.'
          : `Linear auth missing. Set ${status.apiKeyEnv} or switch Linear auth to oauth and set ${status.oauthTokenEnv}.`);
      })
      .catch((error) => {
        setActionStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setLinearBusy(false);
      });
  };

  const startStudioLinearDelivery = () => {
    if (phase === 'running' || linearBusy) {
      return;
    }

    const prompt = promptValue.trim();
    const nextConfig = sanitizeStudioConfig({
      ...configRef.current,
      linear: {
        ...configRef.current.linear,
        enabled: true
      }
    });
    const members = enabledStudioMembers(nextConfig);
    const delivery = buildStudioLinearDelivery(nextConfig, { enabled: true });
    const baseQuery = buildPromptWithContext(prompt, promptContextRef.current);
    setConfig(nextConfig);
    setFocusPane('linear');
    setLinearBusy(true);
    setLinearResult(null);
    setLinearEvents([]);
    setActionStatus(`Delivering Linear work with ${members.join(', ')} through ${delivery.phases.join(' -> ')}.`);
    void runLinearDelivery({
      baseQuery,
      cwd,
      delivery,
      members,
      summarizer: nextConfig.summarizer,
      timeoutMs,
      maxMemberChars,
      effort,
      models: nextConfig.models,
      efforts: nextConfig.efforts,
      permissions: nextConfig.permissions,
      auths: nextConfig.auths,
      handoff: nextConfig.handoff,
      lead: nextConfig.lead,
      planner: nextConfig.planner,
      iterations: nextConfig.iterations,
      teamWork: nextConfig.teamWork,
      teams: nextConfig.teams,
      env: process.env,
      onEvent: (event) => {
        onEvent?.(event);
        setLinearEvents((current) => [
          formatStudioLinearEvent(event),
          ...current
        ].filter(Boolean).slice(0, 8));
      }
    })
      .then((result) => {
        setLinearResult(result);
        setActionStatus(result.success
          ? `Linear delivery completed: ${result.issueCount} issue(s).`
          : `Linear delivery needs attention: ${result.issueCount} issue(s).`);
        setLinearStatus((current) => current
          ? {
              ...current,
              stateFile: result.stateFile || current.stateFile,
              workspaceRoot: result.workspaceRoot || current.workspaceRoot,
              observabilityLog: result.observabilityLog || current.observabilityLog
            }
          : current);
      })
      .catch((error) => {
        setActionStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setLinearBusy(false);
      });
  };

  const setPromptActionValue = (nextValue, nextCursorOffset = nextValue.length) => {
    setPromptAction((current) => current
      ? {
          ...current,
          value: nextValue,
          cursorOffset: Math.max(0, Math.min(nextValue.length, nextCursorOffset))
        }
      : current);
  };

  const completePromptAction = async () => {
    if (!promptAction) {
      return;
    }

    const value = promptAction.value.trim();
    if (!value) {
      setPromptAction(null);
      setActionStatus('');
      return;
    }

    const kind = promptAction.kind;
    setActionStatus(kind === 'file' ? `Tagging ${value}...` : `Running ${value}...`);
    setPromptAction(null);

    if (kind === 'linearField') {
      setConfig((current) => setStudioLinearField(current, promptAction.field, value));
      setFocusPane('linear');
      setActionStatus(`${promptAction.label || 'Linear field'} saved.`);
      return;
    }

    if (kind === 'file') {
      const file = await loadTaggedFile({ filePath: value, cwd });
      setPromptContext((current) => ({
        ...current,
        files: [...current.files, file]
      }));
      setActionStatus(file.status === 'error'
        ? `File failed: ${file.displayPath} (${file.detail})`
        : `Tagged file: ${file.displayPath}`);
      return;
    }

    const command = await runPromptCommand({ command: value, cwd, env: process.env });
    setPromptContext((current) => ({
      ...current,
      commands: [...current.commands, command]
    }));
    setActionStatus(command.status === 'ok'
      ? `Command captured: ${value}`
      : `Command ${command.status}: ${value}`);
  };

  const updatePromptActionFromInput = (input, key) => {
    if (!promptAction) {
      return;
    }

    if (key.escape) {
      setPromptAction(null);
      setActionStatus('');
      return;
    }

    if (key.return) {
      void completePromptAction();
      return;
    }

    if (key.leftArrow) {
      setPromptAction((current) => current
        ? { ...current, cursorOffset: Math.max(0, current.cursorOffset - 1) }
        : current);
      return;
    }

    if (key.rightArrow) {
      setPromptAction((current) => current
        ? { ...current, cursorOffset: Math.min(current.value.length, current.cursorOffset + 1) }
        : current);
      return;
    }

    if (key.backspace) {
      if (promptAction.cursorOffset === 0) {
        return;
      }
      const nextCursorOffset = promptAction.cursorOffset - 1;
      setPromptActionValue(
        promptAction.value.slice(0, nextCursorOffset) + promptAction.value.slice(promptAction.cursorOffset),
        nextCursorOffset
      );
      return;
    }

    if (key.delete) {
      if (promptAction.cursorOffset >= promptAction.value.length) {
        return;
      }
      setPromptActionValue(
        promptAction.value.slice(0, promptAction.cursorOffset) + promptAction.value.slice(promptAction.cursorOffset + 1),
        promptAction.cursorOffset
      );
      return;
    }

    if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === 'c')) {
      return;
    }

    const chunk = sanitizeImmediateFollowUpChunk(input);
    if (chunk) {
      setPromptActionValue(
        promptAction.value.slice(0, promptAction.cursorOffset) + chunk + promptAction.value.slice(promptAction.cursorOffset),
        promptAction.cursorOffset + chunk.length
      );
    }
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        requestExit();
        return;
      }

      if (authFlowActive) {
        return;
      }

      if (promptAction) {
        updatePromptActionFromInput(input, key);
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
        } else if (focusPane === 'linear') {
          startStudioLinearStatus();
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
      if (promptAction) {
        const sanitized = sanitizeImmediateFollowUpChunk(text);
        if (!sanitized) {
          return;
        }
        setPromptActionValue(
          promptAction.value.slice(0, promptAction.cursorOffset) + sanitized + promptAction.value.slice(promptAction.cursorOffset),
          promptAction.cursorOffset + sanitized.length
        );
        return;
      }

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
    { isActive: editingPrompt || Boolean(promptAction) }
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
            linearStatus,
            linearResult,
            linearEvents,
            linearBusy,
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
      cursorOffset,
      promptContext,
      actionStatus
    }),
    promptAction
      ? h(StudioActionInputPanel, { promptAction })
      : null,
    showHelp ? h(StudioHelpPanel) : null,
    h(StudioFooter, { phase, focusPane, editingPrompt, exitArmedUntil, linearBusy })
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
  promptContext = { files: [], commands: [] },
  conversation = [],
  onEvent
}) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const initialQuery = initialPrompt.trim();
  const initialRunPrompt = initialQuery
    ? buildPromptWithContext(initialQuery, promptContext)
    : '';

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
    initialQuery ? { id: 1, prompt: initialRunPrompt, displayPrompt: initialQuery } : null
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
    const displayPrompt = activeRun.displayPrompt || prompt;

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
            user: displayPrompt,
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
            user: displayPrompt,
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
      setActiveRun({
        id: next,
        prompt: buildPromptWithContext(prompt, promptContext),
        displayPrompt: prompt
      });
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
  linearStatus,
  linearResult,
  linearEvents,
  linearBusy,
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
    linear: 'Linear',
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
      ? h(StudioAgentsPane, { config, sessionState, selectedIndex: agentIndex, focused })
      : null,
    pane === 'linear'
      ? h(StudioLinearPane, {
          config,
          status: linearStatus,
          result: linearResult,
          events: linearEvents,
          busy: linearBusy,
          focused
        })
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

function StudioAgentsPane({ config, sessionState, selectedIndex, focused }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...STUDIO_ENGINES.map((engine, index) => {
      const enabled = config.members.includes(engine);
      const role = studioRoleForEngine(config, engine);
      const selected = focused && index === selectedIndex;
      const sessionItem = sessionState.items.find((item) => item.name === engine);
      const telemetry = sessionItem ? formatTelemetrySuffix(sessionItem) : '';
      const detail = `${role}  team:${config.teams[engine] ?? config.teamWork}  auth:${config.auths[engine]}${telemetry ? `  ${telemetry}` : ''}`;

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

function StudioLinearPane({ config, status, result, events = [], busy, focused }) {
  const linear = config.linear || {};
  const mode = studioLinearMode(linear);
  const statusLines = status
    ? [
        `auth:${status.configured ? 'configured' : 'missing'} (${status.authMethod})`,
        status.viewer
          ? `viewer:${status.viewer.name || status.viewer.email || status.viewer.id}`
          : status.authError
            ? `viewer:error`
            : `env:${status.authMethod === 'oauth' ? status.oauthTokenEnv : status.apiKeyEnv}`,
        `state:${formatStudioLinearCounts(status.counts)}`,
        `workspace:${shortenStudioPath(status.workspaceRoot)}`
      ]
    : [
        `auth:${linear.authMethod}`,
        'status:not checked'
      ];
  const filterLines = [
    `mode:${busy ? 'busy' : mode}`,
    `issue:${linear.issueIds?.join(',') || 'none'}`,
    `query:${linear.query || 'none'}`,
    `team:${linear.team || 'any'}  state:${linear.state || 'any'}`,
    `limit:${linear.limit}  concurrency:${linear.maxConcurrency}  attempts:${linear.maxAttempts}`,
    `workspace:${linear.workspaceStrategy}`
  ];
  const media = linear.attachMedia?.length
    ? `media:${linear.attachMedia.length}`
    : 'media:none';
  const deliveryLines = result
    ? [
        `last:${result.success ? 'ok' : 'needs attention'} issues:${result.issueCount} polls:${result.pollCount}`,
        `log:${shortenStudioPath(result.observabilityLog)}`
      ]
    : [];

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: focused ? 'cyan' : 'gray' }, '  setup'),
    ...statusLines.map((line) => h(Text, { key: `status:${line}` }, `  ${line}`)),
    h(Text, { color: focused ? 'cyan' : 'gray' }, '  delivery'),
    ...filterLines.map((line) => h(Text, { key: `filter:${line}` }, `  ${line}`)),
    h(Text, null, `  ${media}`),
    ...deliveryLines.map((line) => h(Text, { key: `delivery:${line}` }, `  ${line}`)),
    events.length > 0 ? h(Text, { color: focused ? 'cyan' : 'gray' }, '  recent') : null,
    ...events.slice(0, 4).map((line, index) =>
      h(Text, { key: `event:${index}:${line}`, color: 'gray' }, `  ${line}`)
    )
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

  const telemetryLines = buildStudioTelemetryLines(sessionState);

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
      : null,
    h(Text, { color: focused ? 'cyan' : 'gray' }, '  Telemetry'),
    ...telemetryLines.map((line) =>
      h(Text, { key: `telemetry:${line}`, color: line.includes('waiting') ? 'gray' : undefined }, `  ${line}`)
    )
  );
}

export function buildStudioTelemetryLines(sessionState: any = {}) {
  const entries = [
    ...(sessionState.items || []).map((item) => ({
      label: item.name,
      item
    })),
    {
      label: sessionState.summaryItem?.summarizerName
        ? `synthesis/${sessionState.summaryItem.summarizerName}`
        : 'synthesis',
      item: sessionState.summaryItem
    }
  ].filter((entry) => entry.item);

  const lines = entries
    .map(({ label, item }) => {
      const tokenUsage = item.tokenUsage || item.result?.tokenUsage;
      const toolUsage = item.toolUsage || item.result?.toolUsage || [];
      const parts = [];

      if (tokenUsage) {
        parts.push(`tokens ${formatStudioTokenUsage(tokenUsage)}`);
      }

      if (toolUsage.length > 0) {
        parts.push(`tools ${formatStudioToolUsage(toolUsage)}`);
      }

      if (item.progressDetail && item.status === 'running') {
        parts.push(`now ${item.progressDetail}`);
      }

      return parts.length > 0 ? `${label}: ${parts.join(' | ')}` : null;
    })
    .filter(Boolean);

  return lines.length > 0
    ? lines
    : ['waiting for provider token/tool usage'];
}

function formatStudioTokenUsage(tokenUsage: any = {}) {
  const estimated = tokenUsage.estimated ? '~' : '';
  return `${estimated}${formatStudioNumber(tokenUsage.total || 0)} total (${formatStudioNumber(tokenUsage.input || 0)} in/${formatStudioNumber(tokenUsage.output || 0)} out)`;
}

function formatStudioToolUsage(toolUsage: any[] = []) {
  const total = toolUsage.reduce((sum, tool) => sum + (tool.count || 1), 0);
  const names = toolUsage
    .slice(0, 3)
    .map((tool) => tool.name)
    .filter(Boolean)
    .join(',');
  return `${total}${names ? ` ${names}` : ''}`;
}

function formatStudioNumber(value) {
  const numeric = Number(value) || 0;
  if (numeric >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(1)}m`;
  }
  if (numeric >= 1_000) {
    return `${(numeric / 1_000).toFixed(1)}k`;
  }
  return String(numeric);
}

function shortenStudioPath(value) {
  const text = String(value || '');
  if (!text) {
    return 'default';
  }
  const parts = text.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : text;
}

function StudioPromptPanel({ focused, editing, promptValue, cursorOffset, promptContext, actionStatus }) {
  const renderedPrompt = editing
    ? renderPromptWithCursor(promptValue, cursorOffset)
    : promptValue || '(empty)';
  const contextStatus = formatPromptContextStatus(promptContext);
  const contextLines = [
    ...(promptContext.files || []).slice(-3).map((file) => `file ${file.status}: ${file.displayPath}`),
    ...(promptContext.commands || []).slice(-3).map((command) => `cmd ${command.status}: ${command.command}`)
  ];

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
    h(Text, null, renderedPrompt),
    contextStatus ? h(Text, { color: 'gray' }, `context ${contextStatus}`) : null,
    ...contextLines.map((line) => h(Text, { key: line, color: 'gray' }, `  ${line}`)),
    actionStatus ? h(Text, { color: 'yellow' }, actionStatus) : null
  );
}

function StudioActionInputPanel({ promptAction }) {
  const label = promptAction.kind === 'file'
    ? 'Tag file'
    : promptAction.kind === 'linearField'
      ? promptAction.label || 'Linear'
      : 'Run command';
  const value = renderPromptWithCursor(promptAction.value, promptAction.cursorOffset);

  return h(
    Box,
    {
      borderStyle: 'single',
      borderColor: 'yellow',
      marginTop: 1,
      paddingX: 1,
      flexDirection: 'column'
    },
    h(Text, { color: 'yellow', bold: true }, label),
    h(Text, null, value)
  );
}

function StudioHelpPanel() {
  const lines = [
    'Tab / Shift-Tab: move focus between panes',
    'Arrow keys: move selection; left/right changes selected setting',
    'Enter: activate selected menu item, toggle provider, expand selected result, or start prompt editing',
    'Agents pane: l lead, p planner, +/- provider team size',
    'Settings pane: choose handoff, lead/planner, synthesis, auth methods, permissions, efforts, iterations, Linear mode/auth/workspace',
    'Social login: opens each selected provider auth flow in browser tabs; paste returned codes here if prompted',
    'Linear pane: Enter checks setup/status; Command Palette can deliver issues or edit issue/query/media fields',
    'Command Palette: tag local files or run shell commands into prompt context',
    'Canvas pane: provider rows show token/tool suffixes; Telemetry section lists current token/tool usage',
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

function StudioFooter({ phase, focusPane, editingPrompt, exitArmedUntil = 0, linearBusy = false }) {
  const detail = editingPrompt
    ? 'typing prompt | Enter run | Esc keep'
    : 'Tab focus | arrows select/change | Enter action | social login/Linear/tag files/run commands from menu | [ ] move pane | r run | e edit | ? help | q quit';
  const exitHint = Date.now() < exitArmedUntil
    ? 'Ctrl-C again to close'
    : 'Ctrl-C twice to close';
  const phaseText = linearBusy ? `${phase}+linear` : phase;

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { color: 'gray' }, `${phaseText} | focus:${focusPane}`),
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
  const delivery = (options as any).delivery || {};

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
    },
    linear: createStudioLinearConfig(delivery)
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
    { id: 'geminiEffort', label: 'Gemini effort', value: config.efforts.gemini || 'default' },
    { id: 'linearMode', label: 'Linear mode', value: studioLinearMode(config.linear) },
    { id: 'linearAuth', label: 'Linear auth', value: config.linear.authMethod },
    { id: 'linearWorkspace', label: 'Linear workspace', value: config.linear.workspaceStrategy },
    { id: 'linearLimit', label: 'Linear limit', value: String(config.linear.limit) },
    { id: 'linearConcurrency', label: 'Linear concurrency', value: String(config.linear.maxConcurrency) },
    { id: 'linearAttempts', label: 'Linear attempts', value: String(config.linear.maxAttempts) },
    { id: 'linearFilter', label: 'Linear filter', value: formatStudioLinearFilter(config.linear) }
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
  } else if (settingId === 'linearMode') {
    const mode = cycleValue(studioLinearMode(next.linear), STUDIO_LINEAR_MODES, direction);
    next.linear.enabled = mode !== 'off';
    next.linear.watch = mode === 'watch';
  } else if (settingId === 'linearAuth') {
    next.linear.authMethod = cycleValue(next.linear.authMethod, STUDIO_LINEAR_AUTH_METHODS, direction);
  } else if (settingId === 'linearWorkspace') {
    next.linear.workspaceStrategy = cycleValue(next.linear.workspaceStrategy, STUDIO_LINEAR_WORKSPACE_STRATEGIES, direction);
  } else if (settingId === 'linearLimit') {
    next.linear.limit = Math.max(1, next.linear.limit + direction);
  } else if (settingId === 'linearConcurrency') {
    next.linear.maxConcurrency = Math.max(1, next.linear.maxConcurrency + direction);
  } else if (settingId === 'linearAttempts') {
    next.linear.maxAttempts = Math.max(1, next.linear.maxAttempts + direction);
  } else if (settingId === 'linearFilter') {
    next.linear.filterSlot = cycleValue(next.linear.filterSlot || 'issue', ['issue', 'query', 'team', 'state', 'media'], direction);
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
  next.linear = sanitizeStudioLinearConfig(next.linear || {});

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
    auths: { ...(config.auths || {}) },
    linear: cloneStudioLinearConfig(config.linear || {})
  };
}

function createStudioLinearConfig(delivery: any = {}) {
  return sanitizeStudioLinearConfig({
    enabled: Boolean(delivery.enabled),
    watch: Boolean(delivery.watch),
    issueIds: [...(delivery.issueIds || [])],
    query: delivery.query || '',
    team: delivery.team || '',
    state: delivery.state || '',
    assignee: delivery.assignee || '',
    limit: delivery.limit ?? 3,
    endpoint: delivery.endpoint || '',
    authMethod: delivery.authMethod || 'api-key',
    apiKeyEnv: delivery.apiKeyEnv || 'LINEAR_API_KEY',
    oauthTokenEnv: delivery.oauthTokenEnv || 'LINEAR_OAUTH_TOKEN',
    pollIntervalMs: delivery.pollIntervalMs ?? 60_000,
    maxPolls: delivery.maxPolls ?? null,
    maxConcurrency: delivery.maxConcurrency ?? 1,
    maxAttempts: delivery.maxAttempts ?? 3,
    retryBaseMs: delivery.retryBaseMs ?? 60_000,
    stateFile: delivery.stateFile || '',
    workspaceRoot: delivery.workspaceRoot || '',
    observabilityDir: delivery.observabilityDir || '',
    workspaceStrategy: delivery.workspaceStrategy || 'worktree',
    workflowFile: delivery.workflowFile || '',
    attachMedia: [...(delivery.attachMedia || [])],
    attachmentTitle: delivery.attachmentTitle || '',
    phases: delivery.phases?.length > 0
      ? [...delivery.phases]
      : [...DEFAULT_STUDIO_LINEAR_PHASES],
    filterSlot: 'issue'
  });
}

function sanitizeStudioLinearConfig(linear: any = {}) {
  const next = cloneStudioLinearConfig(linear);
  next.enabled = Boolean(next.enabled);
  next.watch = Boolean(next.watch);
  next.issueIds = normalizeStudioList(next.issueIds);
  next.query = String(next.query || '').trim();
  next.team = String(next.team || '').trim();
  next.state = String(next.state || '').trim();
  next.assignee = String(next.assignee || '').trim();
  next.limit = Math.max(1, Number(next.limit) || 3);
  next.endpoint = String(next.endpoint || '').trim();
  next.authMethod = STUDIO_LINEAR_AUTH_METHODS.includes(next.authMethod)
    ? next.authMethod
    : 'api-key';
  next.apiKeyEnv = String(next.apiKeyEnv || 'LINEAR_API_KEY').trim() || 'LINEAR_API_KEY';
  next.oauthTokenEnv = String(next.oauthTokenEnv || 'LINEAR_OAUTH_TOKEN').trim() || 'LINEAR_OAUTH_TOKEN';
  next.pollIntervalMs = Math.max(1_000, Number(next.pollIntervalMs) || 60_000);
  next.maxPolls = next.maxPolls === null || next.maxPolls === undefined || next.maxPolls === ''
    ? null
    : Math.max(1, Number(next.maxPolls) || 1);
  next.maxConcurrency = Math.max(1, Number(next.maxConcurrency) || 1);
  next.maxAttempts = Math.max(1, Number(next.maxAttempts) || 3);
  next.retryBaseMs = Math.max(1_000, Number(next.retryBaseMs) || 60_000);
  next.stateFile = String(next.stateFile || '').trim();
  next.workspaceRoot = String(next.workspaceRoot || '').trim();
  next.observabilityDir = String(next.observabilityDir || '').trim();
  next.workspaceStrategy = STUDIO_LINEAR_WORKSPACE_STRATEGIES.includes(next.workspaceStrategy)
    ? next.workspaceStrategy
    : 'worktree';
  next.workflowFile = String(next.workflowFile || '').trim();
  next.attachMedia = normalizeStudioList(next.attachMedia);
  next.attachmentTitle = String(next.attachmentTitle || '').trim();
  next.phases = normalizeStudioList(next.phases).length > 0
    ? normalizeStudioList(next.phases)
    : [...DEFAULT_STUDIO_LINEAR_PHASES];
  next.filterSlot = ['issue', 'query', 'team', 'state', 'media'].includes(next.filterSlot)
    ? next.filterSlot
    : 'issue';
  return next;
}

function cloneStudioLinearConfig(linear: any = {}) {
  return {
    ...linear,
    issueIds: [...(linear.issueIds || [])],
    attachMedia: [...(linear.attachMedia || [])],
    phases: [...(linear.phases || DEFAULT_STUDIO_LINEAR_PHASES)]
  };
}

function setStudioLinearField(config, field, value) {
  const next = cloneStudioConfig(config);
  if (field === 'issueIds' || field === 'attachMedia') {
    next.linear[field] = normalizeStudioList(value);
  } else {
    next.linear[field] = String(value || '').trim();
  }
  next.linear.enabled = true;
  return sanitizeStudioConfig(next);
}

export function buildStudioLinearDelivery(config, overrides: any = {}) {
  const linear = sanitizeStudioLinearConfig({
    ...(config.linear || {}),
    ...overrides
  });
  return {
    enabled: Boolean(linear.enabled || overrides.enabled),
    setup: false,
    status: false,
    watch: Boolean(linear.watch),
    issueIds: [...linear.issueIds],
    query: linear.query || null,
    team: linear.team || null,
    state: linear.state || null,
    assignee: linear.assignee || null,
    limit: linear.limit,
    endpoint: linear.endpoint || null,
    authMethod: linear.authMethod,
    apiKeyEnv: linear.apiKeyEnv,
    oauthTokenEnv: linear.oauthTokenEnv,
    phases: [...linear.phases],
    pollIntervalMs: linear.pollIntervalMs,
    maxPolls: linear.maxPolls,
    maxConcurrency: linear.maxConcurrency,
    maxAttempts: linear.maxAttempts,
    retryBaseMs: linear.retryBaseMs,
    stateFile: linear.stateFile || null,
    workspaceRoot: linear.workspaceRoot || null,
    observabilityDir: linear.observabilityDir || null,
    workspaceStrategy: linear.workspaceStrategy,
    workflowFile: linear.workflowFile || null,
    attachMedia: [...linear.attachMedia],
    attachmentTitle: linear.attachmentTitle || null
  };
}

function createInitialStudioLinearStatus(linear, cwd, env: any = {}) {
  const method = linear.authMethod || 'api-key';
  const apiKeyEnv = linear.apiKeyEnv || 'LINEAR_API_KEY';
  const oauthTokenEnv = linear.oauthTokenEnv || 'LINEAR_OAUTH_TOKEN';
  const envName = method === 'oauth' ? oauthTokenEnv : apiKeyEnv;
  const workspaceRoot = linear.workspaceRoot || '.council/linear-workspaces';
  const observabilityDir = linear.observabilityDir || '.council/linear-observability';

  return {
    provider: 'linear',
    configured: Boolean(String(env?.[envName] || '').trim()),
    authMethod: method,
    endpoint: linear.endpoint || 'https://api.linear.app/graphql',
    apiKeyEnv,
    oauthTokenEnv,
    viewer: null,
    authError: null,
    stateFile: linear.stateFile || '.council/linear-delivery-state.json',
    workspaceRoot,
    observabilityLog: `${observabilityDir}/events.jsonl`,
    state: null,
    counts: {
      total: 0,
      delivered: 0,
      running: 0,
      retry_wait: 0,
      failed: 0,
      ineligible: 0
    },
    cwd
  };
}

function studioLinearMode(linear: any = {}) {
  if (!linear.enabled) {
    return 'off';
  }
  return linear.watch ? 'watch' : 'deliver';
}

function formatStudioLinearFilter(linear: any = {}) {
  const slot = linear.filterSlot || 'issue';
  if (slot === 'issue') {
    return `issue:${linear.issueIds?.join(',') || 'none'}`;
  }
  if (slot === 'query') {
    return `query:${linear.query || 'none'}`;
  }
  if (slot === 'team') {
    return `team:${linear.team || 'any'}`;
  }
  if (slot === 'state') {
    return `state:${linear.state || 'any'}`;
  }
  return `media:${linear.attachMedia?.length || 0}`;
}

function formatStudioLinearCounts(counts: any = {}) {
  return [
    `total:${counts.total || 0}`,
    `done:${counts.delivered || 0}`,
    `run:${counts.running || 0}`,
    `retry:${counts.retry_wait || 0}`,
    `fail:${counts.failed || 0}`
  ].join(',');
}

function formatStudioLinearEvent(event: any = {}) {
  if (!event.type) {
    return '';
  }
  if (event.issue?.key || event.issueId) {
    return `${event.type}:${event.issue?.key || event.issueId}`;
  }
  if (event.phase) {
    return `${event.type}:${event.phase}`;
  }
  if (event.poll) {
    return `${event.type}:poll ${event.poll}`;
  }
  return event.type;
}

function normalizeStudioList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry || '').split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
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
      linear: width,
      results: width
    };
  }

  const available = Math.max(90, columns - 3);
  const menu = Math.max(18, Math.min(25, Math.floor(available * 0.16)));
  const settings = Math.max(28, Math.min(36, Math.floor(available * 0.23)));
  const agents = Math.max(26, Math.min(32, Math.floor(available * 0.19)));
  const linear = Math.max(28, Math.min(36, Math.floor(available * 0.20)));
  const results = Math.max(30, available - menu - settings - agents - linear);
  return { menu, settings, agents, linear, results };
}

function renderPromptWithCursor(value, cursorOffset) {
  const cursor = '|';
  if (!value) {
    return cursor;
  }

  return `${value.slice(0, cursorOffset)}${cursor}${value.slice(cursorOffset)}`;
}
