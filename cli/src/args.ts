import { parseArgs as parseNodeArgs } from 'node:util';
import {
  ALL_ENGINES,
  AUTO_SUMMARIZER,
  CLAUDE_PERMISSION_MODES,
  CODEX_SANDBOX_MODES,
  DEFAULT_ITERATIONS,
  DEFAULT_MAX_MEMBER_CHARS,
  DEFAULT_TEAM_SIZE,
  DEFAULT_TIMEOUT_MS,
  EFFORT_LEVELS,
  PROVIDER_AUTH_METHODS,
  PROVIDER_EFFORT_LEVELS
} from './engines.js';
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  'json-stream': { type: 'boolean' },
  ndjson: { type: 'boolean' },
  headless: { type: 'boolean' },
  studio: { type: 'boolean' },
  plain: { type: 'boolean' },
  banner: { type: 'boolean', default: true },
  'summary-only': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'd' },
  all: { type: 'boolean' },
  codex: { type: 'boolean', default: true },
  claude: { type: 'boolean', default: true },
  gemini: { type: 'boolean', default: true },
  members: { type: 'string' },
  summarizer: { type: 'string' },
  effort: { type: 'string' },
  'codex-model': { type: 'string' },
  'claude-model': { type: 'string' },
  'gemini-model': { type: 'string' },
  'codex-effort': { type: 'string' },
  'claude-effort': { type: 'string' },
  'gemini-effort': { type: 'string' },
  'codex-sandbox': { type: 'string' },
  'claude-permission-mode': { type: 'string' },
  'codex-auth': { type: 'string' },
  'claude-auth': { type: 'string' },
  'gemini-auth': { type: 'string' },
  handoff: { type: 'boolean' },
  lead: { type: 'string' },
  planner: { type: 'string' },
  iterations: { type: 'string' },
  'team-work': { type: 'string' },
  teamwork: { type: 'string' },
  'sub-agents': { type: 'string' },
  'codex-sub-agents': { type: 'string' },
  'claude-sub-agents': { type: 'string' },
  'gemini-sub-agents': { type: 'string' },
  linear: { type: 'boolean' },
  'deliver-linear': { type: 'boolean' },
  'linear-issue': { type: 'string' },
  'linear-query': { type: 'string' },
  'linear-team': { type: 'string' },
  'linear-state': { type: 'string' },
  'linear-assignee': { type: 'string' },
  'linear-limit': { type: 'string' },
  'linear-endpoint': { type: 'string' },
  'linear-api-key-env': { type: 'string' },
  'delivery-phases': { type: 'string' },
  timeout: { type: 'string' },
  'max-member-chars': { type: 'string' },
  cwd: { type: 'string' },
  color: { type: 'string' },
  'no-color': { type: 'boolean' }
} as any;

export function usageText(version) {
  const defaultTimeoutSeconds = DEFAULT_TIMEOUT_MS / 1_000;

  return [
    `council v${version}`,
    '',
    'Ask multiple AI CLIs the same question, then synthesize their answers.',
    '',
    'Usage:',
    '  council [options] <query>',
    '  echo "query" | council [options]',
    '  council help',
    '',
    'Examples:',
    '  council "How should I structure this migration?"',
    '  council --no-gemini --summarizer claude "Review this plan"',
    '  council --headless --json "Summarize the implementation options"',
    '  council --json-stream --codex --claude "Compare these designs"',
    '  council --studio "Open a configurable terminal workbench"',
    '  council --effort high "Analyze the tradeoffs for this architecture"',
    '  council --planner codex --lead claude --handoff --iterations 2 "Plan and execute this change"',
    '  council --deliver-linear --linear-issue ABC-123 --lead codex',
    '',
    'Selection:',
    '  --members <list>          Ordered subset of codex,claude,gemini',
    '  --codex / --no-codex      Enable or disable Codex',
    '  --claude / --no-claude    Enable or disable Claude',
    '  --gemini / --no-gemini    Enable or disable Gemini',
    '  --all                     Re-enable all members',
    '  --summarizer <name>       auto, codex, claude, or gemini',
    '',
    'Output:',
    '  --summary-only            Print only the final synthesis',
    '  -q, --quiet               Alias for --summary-only',
    '  -d, --verbose             Show all member responses, even if they fail',
    '  --json                    Print structured JSON',
    '  --json-stream             Stream JSONL lifecycle events',
    '  --headless                Automation mode: no banner, no progress, summary-only text by default',
    '  --studio                  Open the interactive workbench with focusable panes and editable settings',
    '  --plain                   Disable decorative UI and color',
    '  --no-banner               Suppress the startup banner',
    '  --color <auto|always|never>',
    '',
    'Execution:',
    `  --timeout <seconds>       Per-CLI timeout in seconds (default: ${defaultTimeoutSeconds} / 10 minutes)`,
    `  --max-member-chars <n>    Cap each member response before summarization (default: ${DEFAULT_MAX_MEMBER_CHARS})`,
    '  --cwd <path>              Working directory for all upstream CLIs',
    `  --effort <level>          Reasoning effort applied to every member: ${EFFORT_LEVELS.join(', ')}`,
    '  --codex-model <model>     Model passed to Codex via --model',
    '  --claude-model <model>    Model passed to Claude via --model',
    '  --gemini-model <model>    Model passed to Gemini via --model',
    `  --codex-effort <level>    Codex effort: ${PROVIDER_EFFORT_LEVELS.codex.join(', ')}`,
    `  --claude-effort <level>   Claude effort: ${PROVIDER_EFFORT_LEVELS.claude.join(', ')}`,
    `  --gemini-effort <level>   Gemini effort: ${PROVIDER_EFFORT_LEVELS.gemini.join(', ')}`,
    `  --codex-sandbox <mode>    Codex sandbox: ${CODEX_SANDBOX_MODES.join(', ')}`,
    `  --claude-permission-mode <mode>`,
    `                            Claude permission mode: ${CLAUDE_PERMISSION_MODES.join(', ')}`,
    `  --codex-auth <method>     Codex auth preference: ${PROVIDER_AUTH_METHODS.codex.join(', ')}`,
    `  --claude-auth <method>    Claude auth preference: ${PROVIDER_AUTH_METHODS.claude.join(', ')}`,
    `  --gemini-auth <method>    Gemini auth preference: ${PROVIDER_AUTH_METHODS.gemini.join(', ')}`,
    '  --handoff                 Run members in order and pass each response to the next member',
    '  --lead <name>             Lead model for final synthesis preference: codex, claude, or gemini',
    '  --planner <name>          Planner model that runs before executor members',
    `  --iterations <n>          Consultation rounds per prompt (default: ${DEFAULT_ITERATIONS})`,
    `  --team-work <n>           Let each provider coordinate up to n internal sub-agents (default: ${DEFAULT_TEAM_SIZE})`,
    '  --codex-sub-agents <n>    Codex-specific team size override',
    '  --claude-sub-agents <n>   Claude-specific team size override',
    '  --gemini-sub-agents <n>   Gemini-specific team size override',
    '  --deliver-linear          Fetch Linear tasks and run delivery phases for each task',
    '  --linear-issue <ids>      Comma-separated Linear issue IDs/keys to deliver',
    '  --linear-query <text>     Fetch matching Linear issues when explicit IDs are not provided',
    '  --linear-team <key>       Restrict Linear fetches to a team key',
    '  --linear-state <name>     Restrict Linear fetches to a state name',
    '  --linear-assignee <text>  Restrict Linear fetches to an assignee name/email',
    '  --linear-limit <n>        Max Linear issues to fetch (default: 3)',
    '  --delivery-phases <list>  Comma-separated plan,implement,verify,ship',
    '',
    'Other:',
    '  -h, --help                Show help',
    '  -v, --version             Show version',
    '',
    'Environment:',
    '  COUNCIL_CODEX_BIN         Override the codex executable path',
    '  COUNCIL_CLAUDE_BIN        Override the claude executable path',
    '  COUNCIL_GEMINI_BIN        Override the gemini executable path',
    '  LINEAR_API_KEY            Linear API key used by --deliver-linear',
    '  CLAUDE_CODE_OAUTH_TOKEN   Use Claude OAuth-token auth (omits Claude --bare mode)',
    '  ANTHROPIC_API_KEY         Use Claude API-key auth (keeps Claude --bare mode)',
    '  CLAUDE_CODE_EFFORT_LEVEL  Claude effort fallback when no Claude effort flag is set'
  ].join('\n');
}

export function parseArgs(argv) {
  const parsed = parseNodeArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    tokens: true
  });

  const values = parsed.values as any;
  const result = {
    help: Boolean(values.help),
    version: Boolean(values.version),
    json: Boolean(values.json),
    jsonStream: Boolean(values['json-stream'] || values.ndjson),
    headless: Boolean(values.headless),
    studio: Boolean(values.studio),
    plain: Boolean(values.plain),
    banner: Boolean(values.banner),
    summaryOnly: Boolean(values['summary-only']),
    quiet: Boolean(values.quiet),
    verbose: Boolean(values.verbose),
    noBanner: values.banner === false,
    color: values['no-color'] ? 'never' : parseColor(values.color ?? 'auto'),
    summarizer: parseSummarizer(values.summarizer ?? AUTO_SUMMARIZER),
    effort: parseEffort(values.effort),
    models: parseProviderModels(values),
    efforts: parseProviderEfforts(values),
    permissions: parseProviderPermissions(values),
    auths: parseProviderAuths(values),
    handoff: Boolean(values.handoff),
    lead: parseOptionalEngine(values.lead, '--lead'),
    planner: parseOptionalEngine(values.planner, '--planner'),
    iterations: values.iterations
      ? parsePositiveInteger(values.iterations, '--iterations')
      : DEFAULT_ITERATIONS,
    teamWork: parseTeamWork(values),
    teams: parseProviderTeams(values),
    delivery: parseDeliveryOptions(values),
    timeoutMs: values.timeout
      ? parseTimeoutMs(values.timeout)
      : DEFAULT_TIMEOUT_MS,
    maxMemberChars: values['max-member-chars']
      ? parsePositiveInteger(values['max-member-chars'], '--max-member-chars')
      : DEFAULT_MAX_MEMBER_CHARS,
    cwd: values.cwd ?? process.cwd(),
    promptParts: [...parsed.positionals]
  } as any;

  const enabledEngines = {
    codex: true,
    claude: true,
    gemini: true
  };
  let memberOrder = [...ALL_ENGINES];

  for (const token of parsed.tokens) {
    if (token.kind !== 'option') {
      continue;
    }

    if (token.name === 'all') {
      for (const engine of ALL_ENGINES) {
        enabledEngines[engine] = true;
      }
      continue;
    }

    if (token.name === 'members') {
      const members = parseEngineList(token.value, '--members');
      applyEngineList(enabledEngines, members);
      memberOrder = buildMemberOrder(members);
      continue;
    }

    if (ALL_ENGINES.includes(token.name)) {
      enabledEngines[token.name] = !token.rawName.startsWith('--no-');
    }
  }

  if (result.help || isStandaloneSubcommand(argv, 'help')) {
    result.help = true;
    result.members = [...ALL_ENGINES];
    return result;
  }

  if (result.version || isStandaloneSubcommand(argv, 'version')) {
    result.version = true;
    result.members = [...ALL_ENGINES];
    return result;
  }

  result.members = memberOrder.filter((engine) => enabledEngines[engine]);

  if (result.members.length === 0) {
    throw new Error('At least one engine must be enabled.');
  }

  validateSelectedRole(result.lead, '--lead', result.members);
  validateSelectedRole(result.planner, '--planner', result.members);

  return result;
}

function parseEngineList(value, flagName) {
  const members = value
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean);

  if (members.length === 0) {
    throw new Error(`${flagName} requires at least one engine.`);
  }

  const invalid = members.filter((member) => !ALL_ENGINES.includes(member));
  if (invalid.length > 0) {
    throw new Error(`Unsupported engine in ${flagName}: ${invalid.join(', ')}`);
  }

  return [...new Set(members)];
}

function applyEngineList(enabledEngines, members) {
  for (const engine of ALL_ENGINES) {
    enabledEngines[engine] = false;
  }

  for (const member of members) {
    enabledEngines[member] = true;
  }
}

function buildMemberOrder(members) {
  return [
    ...members,
    ...ALL_ENGINES.filter((engine) => !members.includes(engine))
  ];
}

function parseSummarizer(value) {
  if (value === AUTO_SUMMARIZER || ALL_ENGINES.includes(value)) {
    return value;
  }

  throw new Error(`Unsupported summarizer: ${value}`);
}

function parseEffort(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (EFFORT_LEVELS.includes(value)) {
    return value;
  }

  throw new Error(
    `Unsupported --effort value: ${value} (expected ${EFFORT_LEVELS.join(', ')})`
  );
}

function parseProviderModels(values) {
  return {
    codex: parseOptionalString(values['codex-model'], '--codex-model'),
    claude: parseOptionalString(values['claude-model'], '--claude-model'),
    gemini: parseOptionalString(values['gemini-model'], '--gemini-model')
  };
}

function parseProviderEfforts(values) {
  return {
    codex: parseProviderEffort(values['codex-effort'], 'codex'),
    claude: parseProviderEffort(values['claude-effort'], 'claude'),
    gemini: parseProviderEffort(values['gemini-effort'], 'gemini')
  };
}

function parseProviderPermissions(values) {
  return {
    codex: parseEnumValue(values['codex-sandbox'], '--codex-sandbox', CODEX_SANDBOX_MODES),
    claude: parseEnumValue(
      values['claude-permission-mode'],
      '--claude-permission-mode',
      CLAUDE_PERMISSION_MODES
    ),
    gemini: null
  };
}

function parseProviderAuths(values) {
  return {
    codex: parseEnumValue(values['codex-auth'], '--codex-auth', PROVIDER_AUTH_METHODS.codex),
    claude: parseEnumValue(values['claude-auth'], '--claude-auth', PROVIDER_AUTH_METHODS.claude),
    gemini: parseEnumValue(values['gemini-auth'], '--gemini-auth', PROVIDER_AUTH_METHODS.gemini)
  };
}

function parseDeliveryOptions(values) {
  const enabled = Boolean(values['deliver-linear'] || values.linear);
  return {
    enabled,
    provider: enabled ? 'linear' : null,
    issueIds: parseOptionalList(values['linear-issue']),
    query: parseOptionalString(values['linear-query'], '--linear-query'),
    team: parseOptionalString(values['linear-team'], '--linear-team'),
    state: parseOptionalString(values['linear-state'], '--linear-state'),
    assignee: parseOptionalString(values['linear-assignee'], '--linear-assignee'),
    limit: values['linear-limit']
      ? parsePositiveInteger(values['linear-limit'], '--linear-limit')
      : 3,
    endpoint: parseOptionalString(values['linear-endpoint'], '--linear-endpoint'),
    apiKeyEnv: parseOptionalString(values['linear-api-key-env'], '--linear-api-key-env') || 'LINEAR_API_KEY',
    phases: parseDeliveryPhases(values['delivery-phases'])
  };
}

function parseOptionalList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDeliveryPhases(value) {
  const phases = parseOptionalList(value || 'plan,implement,verify,ship');
  const allowed = ['plan', 'implement', 'verify', 'ship'];
  const invalid = phases.filter((phase) => !allowed.includes(phase));

  if (invalid.length > 0) {
    throw new Error(`Unsupported --delivery-phases value: ${invalid.join(', ')} (expected ${allowed.join(', ')})`);
  }

  return phases;
}

function parseTeamWork(values) {
  const value = values['team-work'] ?? values.teamwork ?? values['sub-agents'];
  return value === undefined || value === null || value === ''
    ? DEFAULT_TEAM_SIZE
    : parseNonNegativeInteger(value, '--team-work');
}

function parseProviderTeams(values) {
  return {
    codex: parseOptionalNonNegativeInteger(values['codex-sub-agents'], '--codex-sub-agents'),
    claude: parseOptionalNonNegativeInteger(values['claude-sub-agents'], '--claude-sub-agents'),
    gemini: parseOptionalNonNegativeInteger(values['gemini-sub-agents'], '--gemini-sub-agents')
  };
}

function parseProviderEffort(value, engine) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const allowed = PROVIDER_EFFORT_LEVELS[engine];
  if (allowed.includes(value)) {
    return value;
  }

  throw new Error(
    `Unsupported --${engine}-effort value: ${value} (expected ${allowed.join(', ')})`
  );
}

function parseEnumValue(value, flagName, allowed) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (allowed.includes(value)) {
    return value;
  }

  throw new Error(
    `Unsupported ${flagName} value: ${value} (expected ${allowed.join(', ')})`
  );
}

function parseOptionalString(value, flagName) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = String(value).trim();
  if (parsed) {
    return parsed;
  }

  throw new Error(`${flagName} requires a non-empty value.`);
}

function parseOptionalEngine(value, flagName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = String(value).trim();
  if (ALL_ENGINES.includes(parsed)) {
    return parsed;
  }

  throw new Error(`Unsupported ${flagName} value: ${parsed} (expected ${ALL_ENGINES.join(', ')})`);
}

function validateSelectedRole(value, flagName, members) {
  if (!value || members.includes(value)) {
    return;
  }

  throw new Error(`${flagName} must be one of the enabled members: ${members.join(', ')}`);
}

function parseTimeoutMs(value) {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid timeout value: ${value}`);
  }

  return Math.round(seconds * 1000);
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer.`);
  }

  return parsed;
}

function parseOptionalNonNegativeInteger(value, flagName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return parseNonNegativeInteger(value, flagName);
}

function parseNonNegativeInteger(value, flagName) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} requires a non-negative integer.`);
  }

  return parsed;
}

function parseColor(value) {
  if (['auto', 'always', 'never'].includes(value)) {
    return value;
  }

  throw new Error(`Unsupported color mode: ${value}`);
}

function isStandaloneSubcommand(argv, target) {
  const positionalTokens = [];

  for (const token of argv) {
    if (token === '--') {
      return false;
    }

    if (!token.startsWith('-')) {
      positionalTokens.push(token);
    }
  }

  return positionalTokens.length === 1 && positionalTokens[0] === target;
}
